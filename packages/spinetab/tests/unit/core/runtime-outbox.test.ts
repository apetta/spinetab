import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeMessage } from "../../../src/core/bridge.ts";
import { estimateBytes } from "../../../src/core/estimate.ts";
import { DEFAULT_LIMITS } from "../../../src/core/limits.ts";
import { createRuntime, type Runtime } from "../../../src/core/runtime.ts";
import type {
	CommandOutcome,
	RuntimeHandle,
	SubscriptionStatus,
} from "../../../src/core/types.ts";
import { disposeAll, feed, makeClient, observe } from "./helpers/client.ts";
import { ManualClock, settle } from "./helpers/clock.ts";
import { RawPage } from "./helpers/page.ts";
import {
	createTestAdapter,
	type TestAdapterOptions,
	type TestSubscription,
} from "./helpers/test-adapter.ts";

// Use real MessageChannels so clone snapshots and acknowledgement debt are exercised across the bridge.

const TOPICS = 100;
const WINDOW = DEFAULT_LIMITS.maxControlMessages;

const runtimes: Runtime[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const runtime of runtimes.splice(0)) runtime.dispose();
	disposeAll();
});

function setup(adapter: TestAdapterOptions = {}) {
	const clock = new ManualClock();
	const test = createTestAdapter(adapter);
	const runtime = createRuntime({ adapters: [test.adapter], clock });
	runtimes.push(runtime);
	return { clock, test, runtime };
}

/**
 * A raw page whose runtime-side port throws a DataCloneError for posts that
 * match `fail` while `armed` (a failure no estimate can predict, injected at
 * the port so the pump-time path is reachable although snapshots clone).
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

async function page(
	runtime: RuntimeHandle,
	clock: ManualClock,
	fields: Record<string, unknown> = {},
) {
	const raw = new RawPage(runtime);
	raw.hello(fields);
	await settle(clock);
	return raw;
}

/** Subscribe `count` topics in one turn, leaving the page unacknowledged. */
async function queueBehindControl(
	raw: RawPage,
	clock: ManualClock,
	runtime: Runtime,
	count = TOPICS,
) {
	for (let topic = 0; topic < count; topic += 1) {
		raw.subscribe(String(topic), { subscription: { topic } });
	}
	await settle(clock);
	expect(statsOf(runtime, raw)).toMatchObject({
		pendingControl: WINDOW,
		queuedControl: count - WINDOW,
	});
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

/** Data and terminal events for `c` as `kind:seq`, in arrival order. */
const outcomes = (raw: RawPage, c: string) =>
	raw.events(c).map((message) => `${message.kind}:${message.seq}`);

const ks = (raw: RawPage) =>
	raw.received.flatMap((message) =>
		"k" in message && typeof message.k === "number" ? [message.k] : [],
	);

const commandResults = (raw: RawPage, id: string) =>
	raw
		.ofType("commandResult")
		.filter(
			(message: Extract<RuntimeMessage, { t: "commandResult" }>) =>
				message.id === id,
		);

function command(raw: RawPage, id: string) {
	raw.send({
		t: "command",
		id,
		timeoutMs: 10_000,
		request: {
			adapter: "test",
			connection: { url: "https://example.test/feed" },
			payload: { id },
		},
	});
}

describe("outbox snapshots", () => {
	it("a queued event is a snapshot: mutation after next() changes neither delivery nor charge, and direct posts are not cloned", async () => {
		const { runtime, clock, test } = setup();
		const raw = await page(runtime, clock);
		raw.subscribe("a", { subscription: { topic: "shared" } });
		raw.subscribe("b", { subscription: { topic: "shared" } });
		await settle(clock);
		await drain(raw, clock);
		const shared = upstream(test, "shared");
		const clones = vi.spyOn(globalThis, "structuredClone");
		// Direct path (empty outbox): postMessage takes the snapshot; no clone.
		shared.emit({ n: 0 });
		await settle(clock);
		expect(clones).not.toHaveBeenCalled();
		expect(raw.data("a")).toEqual([{ n: 0 }]);
		raw.ackAll("a");
		raw.ackAll("b");
		await settle(clock);
		await queueBehindControl(raw, clock, runtime);
		clones.mockClear();
		const payload = {
			value: 1,
			bytes: new Uint8Array([1, 2, 3]),
			text: "small",
		};
		const charge = estimateBytes(payload) as number;
		shared.emit(payload);
		// One snapshot per event, shared by both queued consumers.
		expect(clones).toHaveBeenCalledTimes(1);
		expect(statsOf(runtime, raw)).toMatchObject({
			pendingMessages: 2,
			pendingBytes: 2 * charge,
			queuedData: 2,
			queuedDataBytes: 2 * charge,
		});
		payload.value = 2;
		payload.bytes[0] = 9;
		payload.text = "x".repeat(1024 * 1024);
		await drain(raw, clock);
		const original = {
			value: 1,
			bytes: new Uint8Array([1, 2, 3]),
			text: "small",
		};
		expect(raw.data("a")).toEqual([{ n: 0 }, original]);
		expect(raw.data("b")).toEqual([{ n: 0 }, original]);
		// Copied, never transferred: the producer still owns its buffer.
		expect(payload.bytes.byteLength).toBe(3);
		expect(Array.from(payload.bytes)).toEqual([9, 2, 3]);
		expect(statsOf(runtime, raw)).toMatchObject({
			queuedData: 0,
			queuedDataBytes: 0,
			pendingBytes: 2 * charge,
		});
		expect(runtime.stats().hwm).toMatchObject({
			dataQueued: 2,
			dataQueuedBytes: 2 * charge,
		});
		expect(runtime.stats().dataCloneErrors).toBe(0);
	});

	it("a next queued before its terminal, then made uncloneable by its producer, still arrives before the terminal", async () => {
		const { runtime, clock, test } = setup();
		const raw = await page(runtime, clock);
		await queueBehindControl(raw, clock, runtime);
		const payload: Record<string, unknown> = { value: 1 };
		const sub = upstream(test, 99);
		sub.sink.next(payload);
		sub.sink.complete();
		payload.uncloneable = () => {};
		await drain(raw, clock);
		expect(outcomes(raw, "99")).toEqual(["next:1", "complete:2"]);
		expect(raw.data("99")).toEqual([{ value: 1 }]);
		expect(runtime.stats().dataCloneErrors).toBe(0);
	});

	it("a queued event that cannot be snapshotted is event-not-serialisable at once and never charged", async () => {
		const { runtime, clock, test } = setup();
		const raw = await page(runtime, clock);
		await queueBehindControl(raw, clock, runtime);
		const sub = upstream(test, 99);
		// Passes estimation, fails structured clone.
		sub.emit({ value: new Proxy({ a: 1 }, {}) });
		expect(runtime.stats()).toMatchObject({
			pendingMessages: 0,
			dataCloneErrors: 1,
		});
		expect(statsOf(runtime, raw)).toMatchObject({ queuedData: 0 });
		sub.emit({ later: true });
		await drain(raw, clock);
		expect(outcomes(raw, "99")).toEqual([]);
		expect(raw.continuity("99").at(-1)).toMatchObject({
			continuity: { state: "gap", reason: "event-not-serialisable" },
		});
		const notice = raw.continuity("99").at(-1);
		const missed =
			typeof notice?.c === "string"
				? notice.continuity.missed
				: notice?.missed?.[notice.c.indexOf("99")];
		expect(missed).toBe(2);
	});

	it("a queued command result is a snapshot of the acknowledged outcome", async () => {
		const value = { n: 1, text: "small", bytes: new Uint8Array([1, 2, 3]) };
		const { runtime, clock } = setup({
			command: async (): Promise<CommandOutcome> => ({
				status: "acknowledged",
				value,
			}),
		});
		const raw = await page(runtime, clock);
		await queueBehindControl(raw, clock, runtime);
		command(raw, "cmd");
		await settle(clock);
		expect(statsOf(runtime, raw)).toMatchObject({
			queuedControl: TOPICS - WINDOW + 1,
		});
		value.n = 2;
		value.text = "x".repeat(1024 * 1024);
		value.bytes[0] = 9;
		await drain(raw, clock);
		const [result] = commandResults(raw, "cmd");
		expect(result?.outcome).toEqual({
			status: "acknowledged",
			value: { n: 1, text: "small", bytes: new Uint8Array([1, 2, 3]) },
		});
	});

	it("a queued command result that cannot be snapshotted becomes unknown/not-serialisable", async () => {
		const { runtime, clock } = setup({
			command: async (): Promise<CommandOutcome> => ({
				status: "acknowledged",
				value: { p: new Proxy({ a: 1 }, {}) } as never,
			}),
		});
		const raw = await page(runtime, clock);
		await queueBehindControl(raw, clock, runtime);
		command(raw, "cmd");
		await settle(clock);
		await drain(raw, clock);
		const results = commandResults(raw, "cmd");
		expect(results).toHaveLength(1);
		expect(results[0]?.outcome).toMatchObject({
			status: "unknown",
			error: {
				code: "command-unknown",
				detail: { reason: "not-serialisable" },
			},
		});
		expect(runtime.stats().dataCloneErrors).toBe(1);
		// No control sequence was spent on the failed snapshot.
		expect(ks(raw)).toEqual(
			Array.from({ length: ks(raw).length }, (_, index) => index + 1),
		);
	});
});

describe("pump-time clone failures", () => {
	it("a queued event failing when pumped is uncharged and its live consumer gets a gap notice", async () => {
		const { runtime, clock, test } = setup();
		const { handle, state } = failingPort(runtime, (message) => {
			const m = message as { t?: string; kind?: string; c?: string };
			return m.t === "event" && m.kind === "next" && m.c === "99";
		});
		const raw = await page(handle, clock);
		await queueBehindControl(raw, clock, runtime);
		upstream(test, 99).emit({ n: 1 });
		expect(runtime.stats().pendingMessages).toBe(1);
		state.armed = true;
		await drain(raw, clock);
		expect(state.thrown).toBe(1);
		expect(outcomes(raw, "99")).toEqual([]);
		expect(runtime.stats()).toMatchObject({
			pendingMessages: 0,
			pendingBytes: 0,
			dataCloneErrors: 1,
		});
		expect(raw.continuity("99").at(-1)).toMatchObject({
			continuity: {
				state: "gap",
				reason: "event-not-serialisable",
				missed: 1,
			},
		});
	});

	it("a queued next failing when pumped before its queued terminal spends its sequence, so the terminal arrives as a jump", async () => {
		const { runtime, clock, test } = setup();
		const { handle, state } = failingPort(runtime, (message) => {
			const m = message as { t?: string; kind?: string; c?: string };
			return m.t === "event" && m.kind === "next" && m.c === "99";
		});
		const raw = await page(handle, clock);
		await queueBehindControl(raw, clock, runtime);
		const sub = upstream(test, 99);
		sub.sink.next({ n: 1 });
		sub.sink.complete();
		state.armed = true;
		await drain(raw, clock);
		// Never a silent drop: the terminal keeps seq 2, which the page client
		// reports as `gap/event-not-serialisable` (next test).
		expect(outcomes(raw, "99")).toEqual(["complete:2"]);
		expect(runtime.stats()).toMatchObject({
			pendingMessages: 0,
			dataCloneErrors: 1,
		});
		expect(statsOf(runtime, raw)?.ledgers).toBe(TOPICS - 1);
	});

	it("the page client reports a sequence jump before a terminal as a gap, then completes", async () => {
		const { client, host, clock } = makeClient();
		client.start();
		await settle(clock);
		const { log, observer } = observe();
		client.subscribe(feed(), observer);
		await settle(clock);
		host.lastRelay().drop = (data, toRuntime) => {
			const m = data as { t?: string; kind?: string };
			return !toRuntime && m.t === "event" && m.kind === "next";
		};
		const sub = host.test.last();
		sub.sink.next({ n: 1 });
		sub.sink.complete();
		await settle(clock);
		const gaps = log.statuses.filter(
			(status: SubscriptionStatus) => status.continuity.state === "gap",
		);
		expect(gaps.at(-1)?.continuity).toMatchObject({
			state: "gap",
			reason: "event-not-serialisable",
			missed: 1,
		});
		expect(log.events).toEqual([]);
		expect(log.completed).toBe(1);
	});

	it("a queued command result failing when pumped is replaced by unknown/not-serialisable with the same k", async () => {
		const { runtime, clock } = setup({
			command: async (): Promise<CommandOutcome> => ({
				status: "acknowledged",
				value: { ok: true },
			}),
		});
		const { handle, state } = failingPort(runtime, (message) => {
			const m = message as { t?: string; outcome?: { status?: string } };
			return m.t === "commandResult" && m.outcome?.status === "acknowledged";
		});
		const raw = await page(handle, clock);
		await queueBehindControl(raw, clock, runtime);
		command(raw, "cmd");
		await settle(clock);
		const queuedK = TOPICS + 1;
		state.armed = true;
		await drain(raw, clock);
		expect(state.thrown).toBe(1);
		const results = commandResults(raw, "cmd");
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({
			k: queuedK,
			outcome: {
				status: "unknown",
				error: { detail: { reason: "not-serialisable" } },
			},
		});
		expect(ks(raw)).toEqual(
			Array.from({ length: queuedK }, (_, index) => index + 1),
		);
	});
});

describe("acknowledgement watermarks", () => {
	it("a data acknowledgement ahead of every posted sequence never releases queued debt", async () => {
		const { runtime, clock, test } = setup();
		const raw = await page(runtime, clock, {
			limits: { maxPendingMessages: 2, maxPendingMessagesPerConsumer: 1 },
		});
		await queueBehindControl(raw, clock, runtime);
		const sub = upstream(test, 99);
		for (let n = 1; n <= 3; n += 1) {
			sub.emit({ n });
			raw.send({ t: "ack", c: "99", seq: 9_999 });
			await settle(clock);
		}
		expect(statsOf(runtime, raw)).toMatchObject({
			pendingMessages: 1,
			queuedData: 1,
		});
		await drain(raw, clock);
		expect(raw.data("99")).toEqual([{ n: 1 }]);
		expect(raw.continuity("99").at(-1)).toMatchObject({
			continuity: { state: "gap", reason: "overflow" },
		});
		// Once posted, the same acknowledgement releases it.
		raw.send({ t: "ack", c: "99", seq: 9_999 });
		await settle(clock);
		expect(runtime.stats().pendingMessages).toBe(0);
	});

	it("an acknowledgement covering a posted and a queued sequence releases only the posted one", async () => {
		const { runtime, clock, test } = setup();
		const raw = await page(runtime, clock);
		raw.subscribe("x", { subscription: { topic: "x" } });
		await settle(clock);
		await drain(raw, clock);
		const sub = upstream(test, "x");
		sub.emit({ n: 1 });
		await queueBehindControl(raw, clock, runtime, TOPICS);
		sub.emit({ n: 2 });
		expect(statsOf(runtime, raw)).toMatchObject({
			pendingMessages: 2,
			queuedData: 1,
		});
		raw.send({ t: "ack", c: "x", seq: 2 });
		await settle(clock);
		const charge = estimateBytes({ n: 2 }) as number;
		expect(statsOf(runtime, raw)).toMatchObject({
			pendingMessages: 1,
			pendingBytes: charge,
			queuedData: 1,
			queuedDataBytes: charge,
		});
		await drain(raw, clock);
		raw.send({ t: "ack", c: "x", seq: 2 });
		await settle(clock);
		expect(runtime.stats().pendingMessages).toBe(0);
	});

	it("an ack{k} beyond the last posted k is clamped to it", async () => {
		const { runtime, clock } = setup();
		const raw = await page(runtime, clock);
		const count = 200;
		await queueBehindControl(raw, clock, runtime, count);
		raw.send({ t: "ack", k: 10_000 });
		await settle(clock);
		// Only the 64 posted were acknowledged, so exactly 64 more are posted.
		expect(statsOf(runtime, raw)).toMatchObject({
			pendingControl: WINDOW,
			queuedControl: count - 2 * WINDOW,
		});
		expect(ks(raw)).toHaveLength(2 * WINDOW);
		await drain(raw, clock);
		expect(ks(raw)).toEqual(
			Array.from({ length: count }, (_, index) => index + 1),
		);
		expect(runtime.stats().expired).toBe(0);
	});
});

describe("outbox byte stats", () => {
	it("reports queued control bytes as the estimated size of the retained snapshots", async () => {
		const { runtime, clock } = setup();
		const raw = await page(runtime, clock);
		await queueBehindControl(raw, clock, runtime);
		const queued = statsOf(runtime, raw);
		expect(queued?.queuedControlBytes).toBeGreaterThan(0);
		expect(runtime.stats().hwm.controlQueuedBytes).toBe(
			queued?.queuedControlBytes,
		);
		await drain(raw, clock);
		// The queued snapshots are exactly the statuses posted after the first
		// window; each was measured without its envelope and `k`.
		const bodyBytes = (message: RuntimeMessage) => {
			const body: Record<string, unknown> = { ...message };
			for (const key of ["v", "a", "g", "k"]) delete body[key];
			return estimateBytes(body) as number;
		};
		const expected = raw
			.ofType("status")
			.filter((message) => message.k > WINDOW)
			.reduce((total, message) => total + bodyBytes(message), 0);
		expect(queued?.queuedControlBytes).toBe(expected);
		expect(expected).toBeLessThanOrEqual(
			WINDOW * DEFAULT_LIMITS.maxMessageBytes,
		);
		expect(statsOf(runtime, raw)).toMatchObject({
			queuedControl: 0,
			queuedControlBytes: 0,
		});
		// The mark keeps the peak; a reset restarts it from the current level.
		runtime.stats({ resetHwm: true });
		expect(runtime.stats().hwm).toMatchObject({
			controlQueued: 0,
			controlQueuedBytes: 0,
			dataQueued: 0,
			dataQueuedBytes: 0,
		});
	});
});
