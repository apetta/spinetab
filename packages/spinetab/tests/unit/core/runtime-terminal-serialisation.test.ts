import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeAdapter } from "../../../src/core/adapter.ts";
import type { RuntimeMessage } from "../../../src/core/bridge.ts";
import { SpinetabError } from "../../../src/core/errors.ts";
import { DEFAULT_LIMITS } from "../../../src/core/limits.ts";
import { createRuntime, type Runtime } from "../../../src/core/runtime.ts";
import type { Json, RuntimeHandle } from "../../../src/core/types.ts";
import { ManualClock, settle } from "./helpers/clock.ts";
import { RawPage } from "./helpers/page.ts";
import {
	createTestAdapter,
	type TestSubscription,
} from "./helpers/test-adapter.ts";

// U-CF-4: an error whose
// detail passes the byte estimator but fails structured cloning (a Proxy) must
// never swallow the terminal or registration error that carries it. The
// runtime posts a bounded fallback instead, in the same position (same `k`,
// same `seq`): original code and message, detail `{ reason:
// "not-serialisable" }`, counted in dataCloneErrors and recorded as the
// `error-not-serialisable` diagnostic. The consumer is removed exactly as
// before. Real MessageChannels and default limits throughout.

const WINDOW = DEFAULT_LIMITS.maxControlMessages;
const MARKER = { reason: "not-serialisable" };

const runtimes: Runtime[] = [];
afterEach(() => {
	for (const runtime of runtimes.splice(0)) runtime.dispose();
});

/** Passes estimation (plain keys) yet throws DataCloneError when cloned. */
const uncloneable = (): Json =>
	new Proxy({ reason: "controlled" }, {}) as unknown as Json;

const failure = (detail: Json, code: "upstream-error" = "upstream-error") =>
	new SpinetabError(code, "Controlled upstream failure.", {
		detail,
		retryable: true,
	});

/**
 * The scripted test adapter, plus hooks that reject with an uncloneable
 * detail: `subscription.reject` (validateSubscription), `consumer.reject`
 * (validateConsumer) and `subscription.throwOnSubscribe` (the adapter's
 * `subscribe` throws, which the runtime reports as a terminal).
 */
function setup() {
	const clock = new ManualClock();
	const test = createTestAdapter();
	const base = test.adapter;
	const rejecting = (path: string) =>
		new SpinetabError("unsupported-option", `test: ${path} is rejected`, {
			detail: uncloneable(),
		});
	const adapter: RuntimeAdapter<unknown, unknown, unknown, unknown> = {
		...base,
		validateSubscription(spec: unknown): asserts spec is unknown {
			if ((spec as { reject?: boolean } | null)?.reject) {
				throw rejecting("subscription");
			}
		},
		validateConsumer(value: unknown): asserts value is Json {
			if ((value as { reject?: boolean } | null)?.reject) {
				throw rejecting("consumer");
			}
		},
		connect(spec, ctx) {
			const connection = base.connect(spec, ctx);
			return {
				...connection,
				subscribe(subSpec, sink, options) {
					if ((subSpec as { throwOnSubscribe?: boolean }).throwOnSubscribe) {
						throw new SpinetabError(
							"subscribe-rejected",
							"test: subscribe refused",
							{ detail: uncloneable() },
						);
					}
					return connection.subscribe(subSpec, sink, options);
				},
			};
		},
	} as RuntimeAdapter<unknown, unknown, unknown, unknown>;
	const runtime = createRuntime({
		adapters: [adapter as never],
		clock,
		// History opt-in: these tests read `stats().diagnostics`.
		diagnostics: () => undefined,
	});
	runtimes.push(runtime);
	return { clock, test, runtime };
}

/**
 * A raw page whose runtime-side port throws a DataCloneError, while armed,
 * for posts matching `fail` (reaches the defensive pump-time path, which a
 * clone snapshot cannot).
 */
function failingPort(runtime: Runtime, fail: (message: unknown) => boolean) {
	const state = { armed: false, thrown: 0 };
	const handle = {
		accept(port: MessagePort) {
			const original = port.postMessage.bind(port) as (m: unknown) => void;
			port.postMessage = ((message: unknown) => {
				if (state.armed && fail(message)) {
					state.thrown += 1;
					throw new DOMException("could not be cloned", "DataCloneError");
				}
				original(message);
			}) as MessagePort["postMessage"];
			runtime.accept(port);
		},
	} as unknown as RuntimeHandle;
	return { handle, state };
}

async function page(runtime: RuntimeHandle, clock: ManualClock) {
	const raw = new RawPage(runtime);
	raw.hello({ diagnostics: true });
	await settle(clock);
	raw.ackControl();
	await settle(clock);
	return raw;
}

function upstream(test: ReturnType<typeof createTestAdapter>, topic: unknown) {
	const found = test
		.all()
		.find(
			(entry: TestSubscription) =>
				(entry.spec as { topic?: unknown }).topic === topic,
		);
	if (!found) throw new Error(`no upstream for topic ${String(topic)}`);
	return found;
}

/** A responsive page: acknowledge control until nothing more arrives. */
async function drain(raw: RawPage, clock: ManualClock): Promise<void> {
	for (let round = 0; round < 100; round += 1) {
		const before = raw.received.length;
		raw.ackControl();
		await settle(clock);
		if (raw.received.length === before) return;
	}
	throw new Error("control did not drain");
}

const statsOf = (runtime: Runtime, raw: RawPage) =>
	runtime.stats().perAttachment.find((entry) => entry.a === raw.a);

const errorEvents = (raw: RawPage, c: string) =>
	raw.events(c).filter((message) => message.kind === "error") as Array<
		Extract<RuntimeMessage, { t: "event"; kind: "error" }>
	>;

const ks = (raw: RawPage) =>
	raw.received.flatMap((message) =>
		"k" in message && typeof message.k === "number" ? [message.k] : [],
	);

/** Control sequences are contiguous: nothing was skipped or duplicated. */
function expectContiguous(raw: RawPage): void {
	const list = ks(raw);
	expect(list).toEqual(list.map((_, index) => index + 1));
}

const notSerialisable = (runtime: Runtime) =>
	runtime
		.stats()
		.diagnostics.filter((event) => event.type === "error-not-serialisable");

describe("terminal errors with an uncloneable detail", () => {
	for (const proxy of [true, false]) {
		for (const plain of [false, true]) {
			const label = `${proxy ? "an uncloneable detail" : "a plain detail (control)"} as ${plain ? "an adapter error record" : "a SpinetabError"}`;
			const adapterFailure = () => {
				const error = failure(proxy ? uncloneable() : { reason: "controlled" });
				return plain ? error.toJSON() : error;
			};

			it(`direct: an upstream error with ${label} reaches the page once, the consumer is removed and its peer keeps receiving`, async () => {
				const { clock, test, runtime } = setup();
				const raw = await page(runtime, clock);
				raw.subscribe("a", { subscription: { topic: "a" } });
				raw.subscribe("b", { subscription: { topic: "b" } });
				await settle(clock);
				upstream(test, "a").emit({ n: 1 });
				await settle(clock);
				raw.ackAll("a");
				await settle(clock);

				upstream(test, "a").sink.error(adapterFailure());
				upstream(test, "b").emit({ n: 2 });
				await settle(clock);

				const terminals = errorEvents(raw, "a");
				expect(terminals).toHaveLength(1);
				expect(terminals[0]).toMatchObject({
					seq: 2,
					error: {
						code: "upstream-error",
						message: "Controlled upstream failure.",
						detail: proxy ? MARKER : { reason: "controlled" },
						retryable: true,
					},
				});
				expect(raw.data("b")).toEqual([{ n: 2 }]);
				expect(upstream(test, "a").unsubscribed).toBe(true);
				expectContiguous(raw);
				const stats = runtime.stats();
				expect(stats).toMatchObject({
					consumers: 1,
					subscriptions: 1,
					expired: 0,
					dataCloneErrors: proxy ? 1 : 0,
				});
				expect(statsOf(runtime, raw)).toMatchObject({
					consumers: 1,
					pendingMessages: 1,
					queuedControl: 0,
				});
				expect(notSerialisable(runtime).map((event) => event.detail)).toEqual(
					proxy ? [{ message: "terminal", code: "upstream-error" }] : [],
				);
				// The original detail never reaches the page, diagnostics included.
				if (proxy) expect(JSON.stringify(raw.raw)).not.toContain("controlled");
				// The ledger was dropped: the consumer id is immediately reusable.
				raw.subscribe("a", { subscription: { topic: "a2" } });
				await settle(clock);
				expect(raw.ofType("error")).toEqual([]);
				expect(runtime.stats().consumers).toBe(2);
			});

			it(`queued: an upstream error with ${label} behind a full control window keeps its FIFO slot and precedes a later probe`, async () => {
				const { clock, test, runtime } = setup();
				const raw = await page(runtime, clock);
				const topics = 100;
				for (let topic = 0; topic < topics; topic += 1) {
					raw.subscribe(String(topic), { subscription: { topic } });
				}
				await settle(clock);
				expect(statsOf(runtime, raw)).toMatchObject({
					pendingControl: WINDOW,
					queuedControl: topics - WINDOW,
				});

				upstream(test, 99).sink.error(adapterFailure());
				raw.send({ t: "probe", id: "after-terminal" });
				await settle(clock);
				expect(errorEvents(raw, "99")).toEqual([]);
				await drain(raw, clock);

				const terminals = errorEvents(raw, "99");
				expect(terminals).toHaveLength(1);
				expect(terminals[0]).toMatchObject({
					seq: 1,
					error: {
						code: "upstream-error",
						message: "Controlled upstream failure.",
						detail: proxy ? MARKER : { reason: "controlled" },
					},
				});
				// FIFO: the consumer's queued status, then its terminal (the very
				// next k), then the later probe's reply.
				const index = (predicate: (message: RuntimeMessage) => boolean) =>
					raw.received.findIndex(predicate);
				const status = index((m) => m.t === "status" && m.c === "99");
				const terminal = index((m) => m.t === "event" && m.c === "99");
				const probe = index(
					(m) => m.t === "probeResult" && m.id === "after-terminal",
				);
				expect(status).toBeGreaterThan(-1);
				expect(terminal).toBeGreaterThan(status);
				expect(probe).toBeGreaterThan(terminal);
				const kOf = (at: number) => (raw.received[at] as { k: number }).k;
				expect(kOf(terminal)).toBe(kOf(status) + 1);
				expect(kOf(probe)).toBe(kOf(terminal) + 1);
				expectContiguous(raw);
				expect(runtime.stats()).toMatchObject({
					consumers: topics - 1,
					expired: 0,
					dataCloneErrors: proxy ? 1 : 0,
				});
				expect(statsOf(runtime, raw)).toMatchObject({
					queuedControl: 0,
					pendingMessages: 0,
				});
				expect(notSerialisable(runtime)).toHaveLength(proxy ? 1 : 0);
			});
		}
	}

	it("pump-time (defensive): a queued terminal that fails when posted is replaced by the fallback with the same k", async () => {
		const { clock, test, runtime } = setup();
		const { handle, state } = failingPort(runtime, (message) => {
			const body = message as {
				t?: string;
				kind?: string;
				error?: { detail?: { reason?: string } };
			};
			return (
				body.t === "event" &&
				body.kind === "error" &&
				body.error?.detail?.reason !== "not-serialisable"
			);
		});
		const raw = await page(handle, clock);
		for (let topic = 0; topic < 100; topic += 1) {
			raw.subscribe(String(topic), { subscription: { topic } });
		}
		await settle(clock);
		upstream(test, 99).sink.error(failure({ reason: "controlled" }));
		await settle(clock);
		const queuedK = raw.lastControl();
		state.armed = true;
		await drain(raw, clock);

		expect(state.thrown).toBe(1);
		const terminals = errorEvents(raw, "99");
		expect(terminals).toHaveLength(1);
		expect(terminals[0]).toMatchObject({
			seq: 1,
			error: { code: "upstream-error", detail: MARKER },
		});
		expect(terminals[0]?.k).toBeGreaterThan(queuedK);
		expectContiguous(raw);
		expect(runtime.stats()).toMatchObject({
			consumers: 99,
			dataCloneErrors: 1,
		});
	});

	it("an adapter subscribe() that throws with an uncloneable detail ends the consumer with the fallback terminal", async () => {
		const { clock, runtime } = setup();
		const raw = await page(runtime, clock);
		raw.subscribe("x", { subscription: { throwOnSubscribe: true } });
		await settle(clock);
		const terminals = errorEvents(raw, "x");
		expect(terminals).toHaveLength(1);
		expect(terminals[0]).toMatchObject({
			seq: 1,
			error: {
				code: "subscribe-rejected",
				message: "test: subscribe refused",
				detail: MARKER,
			},
		});
		expectContiguous(raw);
		expect(runtime.stats()).toMatchObject({ consumers: 0, dataCloneErrors: 1 });
	});
});

describe("registration and update errors with an uncloneable detail", () => {
	for (const queued of [false, true]) {
		const path = queued ? "queued" : "direct";

		it(`${path}: a subscribe rejected by validation delivers the fallback t:"error"`, async () => {
			const { clock, runtime } = setup();
			const raw = await page(runtime, clock);
			if (queued) {
				for (let topic = 0; topic < 100; topic += 1) {
					raw.subscribe(String(topic), { subscription: { topic } });
				}
			}
			raw.subscribe("bad", { subscription: { reject: true } });
			raw.send({ t: "probe", id: "after-error" });
			await settle(clock);
			await drain(raw, clock);

			const errors = raw.ofType("error").filter((m) => m.c === "bad");
			expect(errors).toHaveLength(1);
			expect(errors[0]).toMatchObject({
				c: "bad",
				code: "unsupported-option",
				message: "test: subscription is rejected",
				detail: MARKER,
			});
			const at = raw.received.indexOf(errors[0] as RuntimeMessage);
			const probe = raw.received.findIndex(
				(m) => m.t === "probeResult" && m.id === "after-error",
			);
			expect(probe).toBeGreaterThan(at);
			expectContiguous(raw);
			expect(runtime.stats()).toMatchObject({
				consumers: queued ? 100 : 0,
				dataCloneErrors: 1,
			});
			expect(notSerialisable(runtime).map((event) => event.detail)).toEqual([
				{ message: "error", code: "unsupported-option" },
			]);
		});
	}

	it('an update rejected by validateConsumer delivers the fallback t:"error" and keeps the options', async () => {
		const { clock, test, runtime } = setup();
		const raw = await page(runtime, clock);
		raw.subscribe("a", { subscription: { topic: "a" } }, { weight: 1 });
		await settle(clock);
		raw.send({ t: "update", c: "a", consumer: { reject: true } });
		await settle(clock);
		expect(raw.ofType("error")).toEqual([
			expect.objectContaining({
				c: "a",
				code: "unsupported-option",
				message: "test: consumer is rejected",
				detail: MARKER,
			}),
		]);
		expect(upstream(test, "a").log).not.toContain(
			expect.stringMatching(/^updated:/),
		);
		expectContiguous(raw);
		expect(runtime.stats().dataCloneErrors).toBe(1);
	});
});
