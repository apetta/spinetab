import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isSpinetabError } from "../../../src/core/errors.ts";
import { setWorkerOriginForTests } from "../../../src/core/runtime.ts";
import type { DiagnosticEvent } from "../../../src/core/types.ts";
import { disposeAll, feed, makeClient, observe } from "./helpers/client.ts";
import { ManualClock, settle, tick } from "./helpers/clock.ts";
import { FakeWorkerHost } from "./helpers/worker.ts";

afterEach(disposeAll);

// The harness worker runs on the endpoints' origin, so provider credentials
// stay within the credential audience; Node has no `location`.
beforeEach(() => setWorkerOriginForTests("https://api.test"));
afterEach(() => setWorkerOriginForTests(undefined));

async function shared(options = {}, settings = {}) {
	const harness = makeClient(options, settings);
	harness.client.start();
	await settle(harness.clock);
	return harness;
}

describe("subscription handles (vanilla API)", () => {
	it("returns a handle synchronously before attachment and queues intent, not events", async () => {
		const { client, host, clock } = makeClient();
		const { log, observer } = observe();
		const handle = client.subscribe(feed(), observer);
		expect(handle.status.get()).toMatchObject({
			active: true,
			connection: { state: "connecting" },
			continuity: { state: "continuous" },
		});
		await settle(clock);
		expect(host.test.last().consumers.size).toBe(1);
		host.test.last().emit({ n: 1 }, { eventId: "e1" });
		await settle(clock);
		expect(log.events).toEqual([{ n: 1 }]);
		expect(log.metas).toEqual([{ seq: 1, eventId: "e1" }]);
	});

	it("cancels pending intent when unsubscribed before attachment", async () => {
		const { client, host, clock } = makeClient();
		const handle = client.subscribe(feed(), observe().observer);
		handle.unsubscribe();
		handle.unsubscribe();
		await settle(clock);
		expect(host.test.all()).toHaveLength(0);
		expect(handle.status.get().active).toBe(false);
	});

	it("runs no callback after unsubscribe but still acknowledges queued events", async () => {
		const { client, host, clock } = await shared();
		const { log, observer } = observe();
		const handle = client.subscribe(feed(), observer);
		await settle(clock);
		const upstream = host.test.last();
		upstream.emit(1);
		upstream.emit(2);
		handle.unsubscribe();
		await settle(clock);
		expect(log.events).toEqual([]);
		expect(host.runtime.stats()).toMatchObject({
			consumers: 0,
			pendingMessages: 0,
			ledgers: 0,
		});
	});

	it("isolates a throwing callback: others keep receiving and acks continue", async () => {
		const onCallbackError = vi.fn();
		const { client, host, clock } = await shared({
			onCallbackError,
			limits: { maxPendingMessagesPerConsumer: 2, maxPendingMessages: 4 },
		});
		const bad = client.subscribe(feed(), {
			next: () => {
				throw new Error("app bug");
			},
		});
		const { log, observer } = observe();
		client.subscribe(feed(), observer);
		await settle(clock);
		for (let n = 1; n <= 6; n += 1) {
			host.test.last().emit(n);
			await settle(clock);
		}
		expect(log.events).toEqual([1, 2, 3, 4, 5, 6]);
		expect(onCallbackError).toHaveBeenCalledTimes(6);
		expect(onCallbackError.mock.calls[0]?.[1]).toEqual({
			subscriptionId: bad.id,
		});
		expect(bad.status.get().continuity.state).toBe("continuous");
	});

	it("reports callback errors through reportError by default", async () => {
		const { client, host, clock, kit } = await shared();
		client.subscribe(feed(), {
			next: () => {
				throw new Error("oops");
			},
		});
		await settle(clock);
		host.test.last().emit(1);
		await settle(clock);
		expect(kit.reportError).toHaveBeenCalledTimes(1);
	});

	it("delivers completion and rehydrated errors after data, exactly once", async () => {
		const { client, host, clock } = await shared();
		const first = observe();
		const second = observe();
		client.subscribe(feed({ f: 1 }), first.observer);
		client.subscribe(feed({ f: 2 }), second.observer);
		await settle(clock);
		const [one, two] = host.test.all();
		one?.emit("a");
		one?.sink.complete();
		two?.sink.error({
			code: "protocol-error",
			message: "bad frame",
			detail: { code: 4400 },
		});
		await settle(clock);
		expect(first.log).toMatchObject({ events: ["a"], completed: 1 });
		expect(second.log.errors).toHaveLength(1);
		expect(isSpinetabError(second.log.errors[0], "protocol-error")).toBe(true);
	});

	it("exposes stable status snapshots that change only on real changes", async () => {
		const { client, host, clock } = await shared();
		const a = client.subscribe(feed({ f: "a" }, {}), observe().observer);
		const b = client.subscribe(
			feed({ f: "b" }, { connection: { url: "https://other.test/x" } }),
			observe().observer,
		);
		await settle(clock);
		const listener = vi.fn();
		a.status.subscribe(listener);
		const before = a.status.get();
		expect(a.status.get()).toBe(before);
		const other = host.test.connections.find(
			(connection) =>
				(connection.spec as { url: string }).url === "https://other.test/x",
		);
		other?.ctx.setStatus({ state: "failed", reason: "permanent-error" });
		await settle(clock);
		expect(a.status.get()).toBe(before);
		expect(b.status.get().connection.state).toBe("failed");
		host.test.connections[0]?.ctx.setStatus({ state: "connected" });
		await settle(clock);
		expect(listener).toHaveBeenCalledTimes(1);
		expect(a.status.get().connection.state).toBe("connected");
		expect(client.status.get()).toBe(client.status.get());
	});

	it("keeps continuity sticky after overflow until markReconciled restarts delivery", async () => {
		const { client, host, clock } = await shared({
			limits: { maxPendingMessagesPerConsumer: 2, maxPendingMessages: 2 },
		});
		const { log, observer } = observe();
		const relay = host.lastRelay();
		// Stall this page: drop its data acks on the way to the runtime.
		relay.drop = (data, toRuntime) =>
			toRuntime &&
			(data as { t?: string; c?: string }).t === "ack" &&
			"c" in (data as object);
		const handle = client.subscribe(feed(), observer);
		await settle(clock);
		for (let n = 1; n <= 5; n += 1) host.test.last().emit(n);
		await settle(clock);
		expect(log.events).toEqual([1, 2]);
		expect(handle.status.get().continuity).toMatchObject({
			state: "gap",
			reason: "overflow",
		});
		host.test.connections[0]?.ctx.setStatus({ state: "connected" });
		host.test.last().emit(6);
		await settle(clock);
		expect(handle.status.get().continuity.state).toBe("gap");
		relay.drop = undefined;
		// Delivering acks again drains the old debt (the page acks the next message it receives).
		handle.markReconciled();
		expect(handle.status.get().continuity).toMatchObject({
			state: "continuous",
			reason: "reconciled",
		});
		await settle(clock);
		host.test.last().emit(7);
		await settle(clock);
		// The window is still full of unacknowledged debt: overflow again, honestly.
		expect(handle.status.get().continuity).toMatchObject({
			state: "gap",
			reason: "overflow",
		});
		expect(log.events).toEqual([1, 2]);
	});

	it("applies a batched gap notice to each subscription with its own missed count", async () => {
		const { client, host, clock } = await shared(
			{ limits: { maxPendingMessagesPerConsumer: 1, maxPendingMessages: 2 } },
			{ hostLimits: { limits: { maxControlMessages: 8 } } },
		);
		const relay = host.lastRelay();
		const batches: Array<{ c: unknown; missed?: number[] }> = [];
		let stalled = true;
		relay.drop = (data, toRuntime) => {
			const message = data as { t?: string; c?: unknown; missed?: number[] };
			if (!toRuntime && message.t === "continuity" && Array.isArray(message.c))
				batches.push({ c: message.c, missed: message.missed });
			// A stalled page: no acknowledgement of any kind reaches the runtime.
			return stalled && toRuntime && message.t === "ack";
		};
		const a = client.subscribe(feed({ f: "a" }), observe().observer);
		const b = client.subscribe(feed({ f: "b" }), observe().observer);
		await settle(clock);
		const [feedA, feedB] = host.test.all();
		feedA?.emit("a1");
		feedB?.emit("b1");
		feedA?.emit("a2");
		feedB?.emit("b2");
		await settle(clock);
		// First notices (control window 8, gap half 4): 2 snapshots + 2 notices.
		expect(a.status.get().continuity).toMatchObject({
			state: "gap",
			missed: 1,
		});
		expect(b.status.get().continuity).toMatchObject({
			state: "gap",
			missed: 1,
		});
		feedA?.emit("a3");
		feedA?.emit("a4");
		feedB?.emit("b3");
		await settle(clock);
		expect(a.status.get().continuity.missed).toBe(1);
		stalled = false;
		// The next control message is acknowledged; withheld counts go as one batch.
		host.test.connections[0]?.ctx.setStatus({ state: "connected" });
		await settle(clock);
		expect(batches).toEqual([{ c: expect.any(Array), missed: [3, 2] }]);
		expect(a.status.get().continuity).toMatchObject({
			state: "gap",
			reason: "overflow",
			missed: 3,
		});
		expect(b.status.get().continuity).toMatchObject({
			state: "gap",
			reason: "overflow",
			missed: 2,
		});
	});

	it("restarts delivery after reconcile once the page has acknowledged its debt", async () => {
		const { client, host, clock } = await shared({
			limits: { maxPendingMessagesPerConsumer: 2, maxPendingMessages: 2 },
		});
		const { log, observer } = observe();
		const handle = client.subscribe(feed(), observer);
		await settle(clock);
		// Three events in one runtime task: the third overflows before any ack.
		for (let n = 1; n <= 3; n += 1) host.test.last().emit(n);
		await settle(clock);
		expect(handle.status.get().continuity.reason).toBe("overflow");
		expect(host.runtime.stats().pendingMessages).toBe(0);
		handle.markReconciled();
		await settle(clock);
		host.test.last().emit(4);
		await settle(clock);
		expect(log.events).toEqual([1, 2, 4]);
		expect(handle.status.get().continuity).toMatchObject({
			state: "continuous",
			reason: "reconciled",
		});
	});

	it("detects a sequence gap (message lost in transit) as continuity gap", async () => {
		const { client, host, clock } = await shared();
		const handle = client.subscribe(feed(), observe().observer);
		await settle(clock);
		const relay = host.lastRelay();
		let dropped = false;
		relay.drop = (data, toRuntime) => {
			const message = data as { t?: string; seq?: number };
			if (
				!toRuntime &&
				message.t === "event" &&
				message.seq === 2 &&
				!dropped
			) {
				dropped = true;
				return true;
			}
			return false;
		};
		for (let n = 1; n <= 3; n += 1) host.test.last().emit(n);
		await settle(clock);
		expect(handle.status.get().continuity).toMatchObject({
			state: "gap",
			reason: "event-not-serialisable",
			missed: 1,
		});
		expect(host.runtime.stats().pendingMessages).toBe(0);
	});

	it("validates requests synchronously: cloneability, endpoints and scope", async () => {
		const { client } = makeClient({ scope: "alice" });
		const expectThrow = (run: () => unknown, code: string) => {
			let caught: unknown;
			try {
				run();
			} catch (error) {
				caught = error;
			}
			expect(isSpinetabError(caught, code as never)).toBe(true);
			return caught as Error;
		};
		const error = expectThrow(
			() => client.subscribe(feed({ callback() {} }), observe().observer),
			"not-serialisable",
		);
		expect(error.message).toContain("request.subscription");
		expectThrow(
			() =>
				client.subscribe(
					feed({}, { connection: { url: "https://u:p@x.test" } }),
					observe().observer,
				),
			"invalid-endpoint",
		);
		expectThrow(
			() => client.subscribe(feed({}, { scope: "bob" }), observe().observer),
			"unsupported-option",
		);
		expectThrow(
			() =>
				client.subscribe(feed(), observe().observer, {
					consumer: { when() {} } as never,
				}),
			"not-serialisable",
		);
		expectThrow(
			() =>
				client.subscribe(
					{ adapter: "", connection: {}, subscription: {} },
					observe().observer,
				),
			"unsupported-option",
		);
	});

	it("resolves relative endpoints against the page base and fails unknown adapters fast", async () => {
		const { client, host, clock } = makeClient({
			baseUrl: "https://app.test/deep/path/",
		});
		client.subscribe(
			feed({}, { connection: { url: "api/feed?x=1" } }),
			observe().observer,
		);
		const missing = observe();
		client.subscribe(feed({}, { adapter: "missing" }), missing.observer);
		await settle(clock);
		expect(host.test.connections[0]?.spec).toEqual({
			url: "https://app.test/deep/path/api/feed?x=1",
		});
		expect(missing.log.errors[0]?.code).toBe("adapter-not-registered");
	});

	it("forwards per-consumer option updates and ends the subscription on a rejected update", async () => {
		const harness = makeClient();
		harness.client.start();
		await settle(harness.clock);
		const { log, observer } = observe();
		const handle = harness.client.subscribe(feed(), observer, {
			consumer: { weight: 1 },
		});
		await settle(harness.clock);
		handle.update({ weight: 2 });
		await settle(harness.clock);
		expect(
			[...harness.host.test.last().consumers.values()][0]?.options,
		).toEqual({ weight: 2 });
		expect(log.errors).toEqual([]);
	});

	it("honours an AbortSignal on subscribe", async () => {
		const { client, host, clock } = await shared();
		const controller = new AbortController();
		const handle = client.subscribe(feed(), observe().observer, {
			signal: controller.signal,
		});
		await settle(clock);
		controller.abort();
		await settle(clock);
		expect(handle.status.get().active).toBe(false);
		expect(host.runtime.stats().consumers).toBe(0);
	});
});

describe("commands", () => {
	it("holds commands until welcome, then posts exactly once", async () => {
		const harness = makeClient(
			{},
			{
				hostLimits: {
					test: {
						command: async () => ({ status: "acknowledged", value: 42 }),
					},
				},
			},
		);
		const outcome = harness.client.command({
			adapter: "test",
			connection: { url: "https://api.test/cmd" },
			payload: { op: 1 },
		});
		expect(harness.host.test.connections).toHaveLength(0);
		await settle(harness.clock);
		await expect(outcome).resolves.toEqual({
			status: "acknowledged",
			value: 42,
		});
		expect(
			harness.host.test.connections[0]?.commands.map(
				(command) => command.payload,
			),
		).toEqual([{ op: 1 }]);
	});

	it("settles held commands not-sent on timeout and posted ones unknown on worker loss", async () => {
		const { client, host, clock } = makeClient({
			heartbeatMs: 1_000,
			probeTimeoutMs: 500,
		});
		host.mode = "hung";
		const held = client.command(
			{
				adapter: "test",
				connection: { url: "https://api.test/c" },
				payload: 1,
			},
			{ timeoutMs: 1_000 },
		);
		await tick(clock, 1_000, 100);
		await expect(held).resolves.toMatchObject({
			status: "not-sent",
			error: { code: "timeout" },
		});
	});

	it("reports limit-exceeded, aborts and dispose outcomes honestly", async () => {
		const harness = await shared();
		const outcomes: Promise<unknown>[] = [];
		const controller = new AbortController();
		const request = {
			adapter: "test",
			connection: { url: "https://api.test/c" },
			payload: 1,
		};
		const aborted = harness.client.command(request, {
			signal: controller.signal,
		});
		controller.abort();
		// Already posted, so an abort cannot prove it was not sent.
		await expect(aborted).resolves.toMatchObject({
			status: "unknown",
			error: { detail: { reason: "aborted" } },
		});
		const pre = new AbortController();
		pre.abort();
		await expect(
			harness.client.command(request, { signal: pre.signal }),
		).resolves.toMatchObject({
			status: "not-sent",
			error: { code: "aborted" },
		});
		for (let index = 0; index < 64; index += 1)
			outcomes.push(harness.client.command(request));
		await expect(harness.client.command(request)).resolves.toMatchObject({
			status: "not-sent",
			error: { code: "limit-exceeded" },
		});
		harness.client.dispose();
		const settled = await Promise.all(outcomes);
		expect(
			settled.every((outcome) =>
				["not-sent", "unknown"].includes(
					(outcome as { status: string }).status,
				),
			),
		).toBe(true);
		await expect(harness.client.command(request)).rejects.toMatchObject({
			code: "disposed",
		});
	});
});

describe("disposal and diagnostics", () => {
	it("disposes idempotently: releases runtime consumers, listeners and timers, and rejects later calls", async () => {
		const { client, host, clock, kit } = await shared();
		const { log, observer } = observe();
		const handle = client.subscribe(feed(), observer);
		await settle(clock);
		client.dispose();
		client.dispose();
		host.test.last().emit("late");
		await settle(clock);
		expect(log.events).toEqual([]);
		expect(client.status.get()).toMatchObject({ mode: "disposed" });
		expect(handle.status.get()).toMatchObject({
			active: false,
			connection: { state: "disposed" },
		});
		handle.unsubscribe();
		expect(host.runtime.stats()).toMatchObject({
			attachments: 0,
			consumers: 0,
		});
		expect(kit.listenerCount()).toBe(0);
		expect(clock.pending()).toBe(0);
		expect(() => client.subscribe(feed(), observe().observer)).toThrowError(
			expect.objectContaining({ code: "disposed" }),
		);
		expect(() => client.retry()).toThrowError(
			expect.objectContaining({ code: "disposed" }),
		);
		expect(() => client.setScope("x")).toThrowError(
			expect.objectContaining({ code: "disposed" }),
		);
		await expect(client.checkHealth()).rejects.toMatchObject({
			code: "disposed",
		});
		client.start();
	});

	it("emits opt-in diagnostics without payloads or credentials", async () => {
		const events: DiagnosticEvent[] = [];
		// The host runtime keeps history only with a sink, so
		// the canary scan below covers retained runtime history as well as the
		// events forwarded to this page.
		const hostClock = new ManualClock();
		const { client, host, clock } = await shared(
			{
				diagnostics: (event: DiagnosticEvent) => events.push(event),
				credentials: () => ({
					headers: { authorization: "Bearer CANARY-TOKEN" },
				}),
			},
			{
				clock: hostClock,
				host: new FakeWorkerHost(hostClock, { diagnostics: () => undefined }),
			},
		);
		client.subscribe(
			feed(
				{ topic: "CANARY-TOPIC" },
				{ connection: { url: "https://api.test/x?secret=CANARY-QUERY" } },
			),
			observe().observer,
		);
		await settle(clock);
		const ctx = host.test.connections[0]?.ctx;
		const credentials = ctx?.credentials("connect");
		await settle(clock);
		await credentials;
		host.test.last().emit({ payload: "CANARY-PAYLOAD" });
		host.test.last().emit({ bad() {} });
		await settle(clock);
		const text =
			JSON.stringify(events) + JSON.stringify(host.runtime.stats().diagnostics);
		expect(events.length).toBeGreaterThan(0);
		for (const marker of [
			"CANARY-TOKEN",
			"CANARY-TOPIC",
			"CANARY-QUERY",
			"CANARY-PAYLOAD",
			"Bearer",
		]) {
			expect(text).not.toContain(marker);
		}
	});
});
