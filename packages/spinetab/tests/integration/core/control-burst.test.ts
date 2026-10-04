import { afterEach, describe, expect, inject, it } from "vitest";
import { createClientWithEnv } from "../../../src/core/client.ts";
import { createRuntime, type Runtime } from "../../../src/core/runtime.ts";
import type {
	DiagnosticEvent,
	SpinetabClient,
	Subscription,
	SubscriptionStatus,
} from "../../../src/core/types.ts";
import { graphqlWs } from "../../../src/protocols/graphql-ws/index.ts";
import { graphqlWsAdapter } from "../../../src/protocols/graphql-ws/runtime.ts";
import { websocket } from "../../../src/transports/websocket/index.ts";
import {
	type WebSocketProtocol,
	websocketAdapter,
} from "../../../src/transports/websocket/runtime.ts";
import { FEED_QUERY, TOPICS } from "../../fixtures/harness/src/bench/event.ts";
import { nodeEnv, waitFor } from "./helpers.ts";

// 100 ordinary subscriptions made synchronously in
// one page turn, on a shared runtime over a real MessageChannel, against the
// real bench fixture endpoints (WS /bench/ws and WS /bench/graphql-ws). The
// page acknowledges control asynchronously, exactly as in a browser, so the
// runtime sees every `subscribe` before any `ack{k}`. No pacing, no raised
// limits and the full 100-topic workload.

const [origin] = inject("fixtureOrigins");

type Variant = "ws" | "graphql-ws";

/** The bench fixture's native frame protocol (as the harness bench page). */
const benchProtocol: WebSocketProtocol<number, unknown> = {
	topicKey: (topic) => String(topic),
	decode(raw) {
		if (typeof raw !== "string") return { kind: "ignore" };
		const message = JSON.parse(raw) as { op?: string; topic?: number };
		if (message.op === undefined) {
			return { kind: "event", topics: [String(message.topic)], event: message };
		}
		return message.op === "pong" ? { kind: "heartbeat" } : { kind: "ignore" };
	},
	subscribe: (topic) => [JSON.stringify({ op: "sub", topic })],
	unsubscribe: (topic) => [JSON.stringify({ op: "unsub", topic })],
	classifyClose: () => "transient",
};

const runtimes: Runtime[] = [];
const clients: SpinetabClient[] = [];
afterEach(() => {
	for (const client of clients.splice(0)) client.dispose();
	for (const runtime of runtimes.splice(0)) runtime.dispose();
});

function benchRuntime(): Runtime {
	const runtime = createRuntime({
		adapters: [
			websocketAdapter({ protocols: { bench: benchProtocol } }),
			graphqlWsAdapter(),
		],
	});
	runtimes.push(runtime);
	return runtime;
}

/**
 * A page client whose SharedWorker factory connects each construction to
 * `target()`, so a test can replace the runtime behind it.
 */
function page(target: () => Runtime) {
	const diagnostics: DiagnosticEvent[] = [];
	const { env } = nodeEnv(`${origin}/app/`);
	const client = createClientWithEnv(
		{
			worker: () => {
				const channel = new MessageChannel();
				target().accept(channel.port2);
				return {
					port: channel.port1,
					addEventListener() {},
					removeEventListener() {},
				} as unknown as SharedWorker;
			},
			sharing: "require",
			diagnostics: (event) => diagnostics.push(event),
		},
		env,
	);
	clients.push(client);
	return { client, diagnostics };
}

interface Topic {
	handle: Subscription<unknown>;
	events: number;
	status?: SubscriptionStatus;
	error?: string;
}

/** Subscribe every topic in one synchronous turn (the point-29 burst). */
function subscribeAll(
	client: SpinetabClient,
	variant: Variant,
	count = TOPICS,
): Topic[] {
	const topics: Topic[] = [];
	for (let topic = 0; topic < count; topic += 1) {
		const request =
			variant === "graphql-ws"
				? graphqlWs({ url: "/bench/graphql-ws", anonymous: true }).subscription(
						{ query: FEED_QUERY, variables: { topic } },
					)
				: websocket<number>({
						url: "/bench/ws",
						protocol: "bench",
					}).subscription(topic);
		const entry = {} as Topic;
		entry.events = 0;
		entry.handle = client.subscribe(request as never, {
			next: () => {
				entry.events += 1;
			},
			error: (error) => {
				entry.error = error.code;
			},
			status: (status) => {
				entry.status = status;
			},
		});
		topics.push(entry);
	}
	return topics;
}

const lost = (diagnostics: DiagnosticEvent[]) =>
	diagnostics.filter(
		(event) =>
			event.type === "runtime-lost" ||
			event.type === "runtime-unstable" ||
			event.type === "mode-failed",
	);

async function expectAllLive(
	runtime: Runtime,
	client: SpinetabClient,
	topics: Topic[],
	diagnostics: DiagnosticEvent[],
	generation = 1,
): Promise<void> {
	// Every topic's first event proves the upstream subscription is live; the
	// fixture emits each topic at 1 Hz.
	await waitFor(
		() =>
			topics.every((topic) => topic.events > 0) ||
			lost(diagnostics).length > 0 ||
			runtime.stats().expired > 0,
		15_000,
	);
	if (lost(diagnostics).length > 0 || runtime.stats().expired > 0) {
		// Failure path only: let the loss play out so the record shows its extent.
		await waitFor(() => client.status.get().mode === "failed", 3_000).catch(
			() => {},
		);
	}
	const stats = runtime.stats();
	const status = client.status.get();
	// One summary first, so a failure shows the whole signature at once.
	expect({
		lost: lost(diagnostics).map((event) => event.detail ?? event.type),
		expired: stats.expired,
		mode: status.mode,
		generation: status.generation,
		subscriptions: stats.subscriptions,
		connections: stats.connections,
		live: topics.filter((topic) => topic.events > 0).length,
		errors: topics.filter((topic) => topic.error !== undefined).length,
		controlWithinBound: stats.hwm.controlMessages <= 64,
		// Admission is bounded by the control outbox, not the smaller posted-message window.
		queuedWithinBounds:
			stats.hwm.controlQueued <= 2 * (1_000 + 64) &&
			stats.hwm.controlQueuedBytes <= 64 * 256 * 1024 &&
			stats.hwm.dataQueuedBytes <= 1024 * 1024,
	}).toEqual({
		lost: [],
		expired: 0,
		mode: "shared",
		generation,
		subscriptions: topics.length,
		connections: 1,
		live: topics.length,
		errors: 0,
		controlWithinBound: true,
		queuedWithinBounds: true,
	});
	expect(
		stats.diagnostics.filter((event) => event.type === "attachment-expired"),
	).toEqual([]);
	expect(status.health).toBe("healthy");
	for (const topic of topics) {
		expect(topic.status?.connection.state).toBe("connected");
		expect(topic.status?.continuity.state).toBe("continuous");
	}
}

describe("a 100-subscription burst on a shared runtime", () => {
	for (const variant of ["ws", "graphql-ws"] as const) {
		it(`keeps generation 1 with all 100 ${variant} subscriptions live`, async () => {
			const runtime = benchRuntime();
			const { client, diagnostics } = page(() => runtime);
			client.start();
			await waitFor(() => client.status.get().mode === "shared");
			const topics = subscribeAll(client, variant);
			await expectAllLive(runtime, client, topics, diagnostics);
			const [attachment] = runtime.stats().perAttachment;
			expect(attachment?.consumers).toBe(TOPICS);
		});
	}

	it("two tabs each subscribing 100 topics in one turn share one runtime without expiry", async () => {
		const runtime = benchRuntime();
		const tabs = [page(() => runtime), page(() => runtime)];
		for (const { client } of tabs) client.start();
		await waitFor(() =>
			tabs.every(({ client }) => client.status.get().mode === "shared"),
		);
		const topics = tabs.map(({ client }) => subscribeAll(client, "ws"));
		for (const [index, { client, diagnostics }] of tabs.entries()) {
			await expectAllLive(runtime, client, topics[index] ?? [], diagnostics);
		}
		expect(runtime.stats()).toMatchObject({
			attachments: 2,
			consumers: 2 * TOPICS,
			subscriptions: TOPICS,
			connections: 1,
			expired: 0,
		});
	});

	for (const variant of ["ws", "graphql-ws"] as const) {
		it(`survives the ${variant} reconnect fan-out to 100 subscriptions at once`, async () => {
			const runtime = benchRuntime();
			const { client, diagnostics } = page(() => runtime);
			client.start();
			await waitFor(() => client.status.get().mode === "shared");
			const topics = subscribeAll(client, variant);
			await expectAllLive(runtime, client, topics, diagnostics);
			const before = topics.map((topic) => topic.events);
			// The fixture hard-closes every socket: the adapter reconnects and
			// every subscription gets its status and continuity in one burst.
			await benchFault("terminate", true);
			try {
				await waitFor(
					() =>
						topics.every(
							(topic, index) =>
								topic.status?.continuity.state === "unknown" &&
								topic.status.connection.state === "connected" &&
								topic.events > (before[index] ?? 0),
						) ||
						lost(diagnostics).length > 0 ||
						runtime.stats().expired > 0,
					15_000,
				);
			} finally {
				await benchFault("terminate", false);
			}
			expect(lost(diagnostics)).toEqual([]);
			expect(runtime.stats()).toMatchObject({
				expired: 0,
				subscriptions: TOPICS,
				connections: 1,
			});
			expect(client.status.get()).toMatchObject({
				mode: "shared",
				generation: 1,
			});
			for (const topic of topics) {
				expect(topic.status?.continuity.state).toBe("unknown");
				expect(topic.error).toBeUndefined();
			}
		});
	}

	it("restores 100 subscriptions on a replacement runtime in one burst", async () => {
		const first = benchRuntime();
		let current = first;
		const { client, diagnostics } = page(() => current);
		client.start();
		await waitFor(() => client.status.get().mode === "shared");
		const topics = subscribeAll(client, "ws");
		await expectAllLive(first, client, topics, diagnostics);
		const before = topics.map((topic) => topic.events);

		// The worker is replaced: the old runtime detaches its pages
		// (`runtime-disposed`) and the next construction reaches a new one, so
		// the page re-registers all 100 subscriptions in one burst.
		const second = benchRuntime();
		current = second;
		first.dispose();
		await waitFor(
			() =>
				topics.every((topic, index) => topic.events > (before[index] ?? 0)) ||
				second.stats().expired > 0 ||
				lost(diagnostics).length > 1,
			15_000,
		);
		expect(
			lost(diagnostics).map((event) => event.detail ?? event.type),
		).toEqual([{ reason: "runtime-replaced" }]);
		expect(second.stats()).toMatchObject({
			attachments: 1,
			consumers: TOPICS,
			subscriptions: TOPICS,
			connections: 1,
			expired: 0,
		});
		expect(client.status.get()).toMatchObject({
			mode: "shared",
			health: "healthy",
			generation: 2,
			runtimeId: second.id,
		});
		for (const topic of topics) {
			expect(topic.error).toBeUndefined();
			expect(topic.status?.continuity).toMatchObject({
				state: "unknown",
				reason: "runtime-replaced",
			});
		}
	});
});

async function benchFault(action: string, value: boolean): Promise<void> {
	await fetch(`${origin}/__fixture/fault`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ target: "bench", action, value }),
	});
}
