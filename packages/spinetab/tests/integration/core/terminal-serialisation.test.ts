import { afterEach, describe, expect, it } from "vitest";
import type {
	RuntimeAdapter,
	SubscriptionSink,
} from "../../../src/core/adapter.ts";
import { createClientWithEnv } from "../../../src/core/client.ts";
import { SpinetabError } from "../../../src/core/errors.ts";
import { createRuntime, type Runtime } from "../../../src/core/runtime.ts";
import type {
	Json,
	SerialisedError,
	SpinetabClient,
	Subscription,
} from "../../../src/core/types.ts";
import { nodeEnv, waitFor } from "./helpers.ts";

// I-CORE-3: the actual
// public client and runtime over real Node MessageChannels. An upstream
// error whose detail passes estimation but fails structured cloning (a
// Proxy) reaches the application's error callback exactly once, with its
// code and message and the `not-serialisable` marker detail, on the direct
// path and behind a full control window (page acknowledgements withheld,
// then released). A later probe crosses the same FIFO port as the barrier;
// no fixed delays. Plain-detail controls run through the same code.

const runtimes: Runtime[] = [];
const clients: SpinetabClient[] = [];
afterEach(() => {
	for (const client of clients.splice(0)) client.dispose();
	for (const runtime of runtimes.splice(0)) runtime.dispose();
});

const uncloneable = (): Json =>
	new Proxy({ reason: "controlled" }, {}) as unknown as Json;

interface Received {
	errors: SerialisedError[];
	events: unknown[];
	completed: number;
}

/**
 * A runtime whose adapter exposes every upstream sink by topic and rejects
 * `{ reject: true }` subscriptions and `{ reject: true }` consumer updates
 * with an uncloneable detail. The page's port can hold its `ack{k}`s.
 */
function harness() {
	const sinks = new Map<string, SubscriptionSink<unknown>>();
	const rejecting = (path: string) =>
		new SpinetabError("unsupported-option", `${path} is rejected`, {
			detail: uncloneable(),
		});
	const adapter: RuntimeAdapter<unknown, unknown, unknown, unknown> = {
		kind: "terminal",
		version: 1,
		validateSubscription(spec: unknown): asserts spec is unknown {
			if ((spec as { reject?: boolean }).reject)
				throw rejecting("subscription");
		},
		validateConsumer(value: unknown): asserts value is Json {
			if ((value as { reject?: boolean } | undefined)?.reject) {
				throw rejecting("consumer");
			}
		},
		connect(_spec, ctx) {
			ctx.setStatus({ state: "connected" });
			return {
				subscribe(spec, sink) {
					const topic = (spec as { topic: string }).topic;
					sinks.set(topic, sink);
					return { unsubscribe: () => sinks.delete(topic) };
				},
				dispose() {},
			};
		},
	} as RuntimeAdapter<unknown, unknown, unknown, unknown>;
	const runtime = createRuntime({ adapters: [adapter as never] });
	runtimes.push(runtime);

	const messages: Array<{ t: string; [key: string]: unknown }> = [];
	const held: unknown[] = [];
	const state = { hold: false };
	let pagePort: MessagePort | undefined;
	let hello: { a: string; g: number } | undefined;
	const { env } = nodeEnv("https://example.test/app/");
	const client = createClientWithEnv(
		{
			sharing: "require",
			worker: () => {
				const channel = new MessageChannel();
				const port = channel.port1;
				pagePort = port;
				port.addEventListener("message", (event) => messages.push(event.data));
				runtime.accept(channel.port2);
				return {
					port: {
						addEventListener: port.addEventListener.bind(port),
						removeEventListener: port.removeEventListener.bind(port),
						start: () => port.start(),
						close: () => port.close(),
						postMessage(message: { t: string; a: string; g: number }) {
							if (message.t === "hello") hello = message;
							if (state.hold && message.t === "ack") held.push(message);
							else port.postMessage(message);
						},
					},
					addEventListener() {},
					removeEventListener() {},
				} as unknown as SharedWorker;
			},
		},
		env,
	);
	clients.push(client);

	const attachment = () => runtime.stats().perAttachment[0];

	return {
		runtime,
		client,
		sinks,
		messages,
		state,
		attachment,
		subscribe(topic: string, spec: Record<string, unknown> = {}) {
			const received: Received = { errors: [], events: [], completed: 0 };
			const handle: Subscription<unknown> = client.subscribe(
				{
					adapter: "terminal",
					connection: { url: "https://example.test/live" },
					subscription: { topic, ...spec },
				} as never,
				{
					next: (event) => received.events.push(event),
					error: (error) =>
						received.errors.push({
							code: error.code,
							message: error.message,
							...(error.detail === undefined ? {} : { detail: error.detail }),
						}),
					complete: () => {
						received.completed += 1;
					},
				},
			);
			return { handle, received };
		},
		release() {
			state.hold = false;
			for (const ack of held.splice(0)) pagePort?.postMessage(ack);
		},
		/** A probe crossing the same FIFO port after everything posted so far. */
		async barrier(id: string) {
			if (!pagePort || !hello) throw new Error("not attached");
			pagePort.postMessage({ v: 1, a: hello.a, g: hello.g, t: "probe", id });
			await waitFor(() =>
				messages.some((m) => m.t === "probeResult" && m.id === id),
			);
		},
	};
}

async function started(page: ReturnType<typeof harness>): Promise<void> {
	page.client.start();
	await waitFor(() => page.client.status.get().mode === "shared");
	await waitFor(() => page.attachment()?.pendingControl === 0);
}

const MARKER = { reason: "not-serialisable" };

describe("terminal errors through the public client (terminal serialisation)", () => {
	for (const queued of [false, true]) {
		for (const proxy of [true, false]) {
			const label = `${queued ? "queued" : "direct"}, ${proxy ? "uncloneable" : "plain"} detail`;

			it(`${label}: the error callback runs once and a healthy peer keeps receiving`, async () => {
				const page = harness();
				await started(page);
				const peer = page.subscribe("peer");
				await waitFor(() => page.sinks.has("peer"));
				page.state.hold = queued;
				const count = queued ? 100 : 1;
				const topics = Array.from({ length: count }, (_, i) =>
					page.subscribe(String(i)),
				);
				await waitFor(() => page.sinks.size === count + 1);
				if (queued) {
					await waitFor(() => (page.attachment()?.queuedControl ?? 0) > 0);
				}
				const last = String(count - 1);
				const target = topics[count - 1] as (typeof topics)[number];

				page.sinks
					.get(last)
					?.error(
						new SpinetabError(
							"upstream-error",
							"Controlled upstream failure.",
							{ detail: proxy ? uncloneable() : { reason: "controlled" } },
						),
					);
				page.release();
				await waitFor(
					() =>
						page.attachment()?.queuedControl === 0 &&
						page.attachment()?.pendingControl === 0,
				);
				await page.barrier("after-terminal");
				page.sinks.get("peer")?.next({ n: 1 });
				await waitFor(() => peer.received.events.length === 1);
				await page.barrier("after-peer");

				expect(target.received.errors).toEqual([
					{
						code: "upstream-error",
						message: "Controlled upstream failure.",
						detail: proxy ? MARKER : { reason: "controlled" },
					},
				]);
				expect(target.received.completed).toBe(0);
				expect(target.handle.status.get().active).toBe(false);
				const terminals = page.messages.filter(
					(m) => m.t === "event" && m.kind === "error",
				);
				expect(terminals).toHaveLength(1);
				const at = page.messages.indexOf(terminals[0] as never);
				const barrier = page.messages.findIndex(
					(m) => m.t === "probeResult" && m.id === "after-terminal",
				);
				expect(barrier).toBeGreaterThan(at);
				expect(peer.received).toEqual({
					errors: [],
					events: [{ n: 1 }],
					completed: 0,
				});
				for (const other of topics.slice(0, -1)) {
					expect(other.received.errors).toEqual([]);
				}
				expect(page.runtime.stats()).toMatchObject({
					consumers: count,
					expired: 0,
					dataCloneErrors: proxy ? 1 : 0,
				});
				expect(page.attachment()).toMatchObject({
					pendingMessages: 0,
					queuedControl: 0,
				});
				expect(page.client.status.get()).toMatchObject({
					mode: "shared",
					health: "healthy",
					generation: 1,
				});
			});
		}
	}

	it("a subscribe rejected with an uncloneable detail reaches the error callback once", async () => {
		const page = harness();
		await started(page);
		const bad = page.subscribe("bad", { reject: true });
		await page.barrier("after-reject");
		await waitFor(() => bad.received.errors.length > 0);
		expect(bad.received.errors).toEqual([
			{
				code: "unsupported-option",
				message: "subscription is rejected",
				detail: MARKER,
			},
		]);
		expect(bad.handle.status.get().active).toBe(false);
		expect(page.runtime.stats()).toMatchObject({
			consumers: 0,
			dataCloneErrors: 1,
		});
	});

	it("an update rejected with an uncloneable detail ends the subscription once", async () => {
		const page = harness();
		await started(page);
		const sub = page.subscribe("a");
		await waitFor(() => page.sinks.has("a"));
		sub.handle.update({ reject: true });
		await waitFor(() => sub.received.errors.length > 0);
		await page.barrier("after-update");
		expect(sub.received.errors).toEqual([
			{
				code: "unsupported-option",
				message: "consumer is rejected",
				detail: MARKER,
			},
		]);
		// The page ends the registration and unsubscribes it, as for any
		// update error.
		await waitFor(() => page.runtime.stats().consumers === 0);
		expect(page.runtime.stats().dataCloneErrors).toBe(1);
	});
});
