import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type SseConnectionSpec,
	sseAdapter,
} from "../../../src/transports/sse/runtime.ts";
import { FakeEventSource, fakeContext, recordingSink } from "./helpers.ts";

// Supervising the native EventSource loop. The real engine behaviour is proven by NT-I-12 (Node's
// EventSource) and NT-B-01 (three browser engines).

const URL_BASE = "https://api.test/sse";

function setup(spec: Partial<SseConnectionSpec> = {}) {
	const adapter = sseAdapter();
	const connection = {
		url: URL_BASE,
		mode: "eventsource",
		// Plain-text payloads: these tests supervise the loop; covers decoding.
		decoder: "text",
		...spec,
	} as SseConnectionSpec;
	adapter.validateConnection?.(connection);
	const fake = fakeContext();
	const conn = adapter.connect(connection, fake.ctx);
	return { conn, fake };
}

function subscribe(conn: ReturnType<typeof setup>["conn"], event?: string) {
	const record = recordingSink<unknown>();
	const sub = conn.subscribe(
		event === undefined ? {} : { event },
		record.sink,
		{
			key: event ?? "message",
			repeatable: true,
		},
	);
	return { record, sub };
}

beforeEach(() => {
	FakeEventSource.reset();
	vi.stubGlobal("EventSource", FakeEventSource);
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	vi.spyOn(Math, "random").mockReturnValue(0.5);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("EventSource mode", () => {
	it("creates one EventSource per identity with one listener per selected name", () => {
		const { conn, fake } = setup({ withCredentials: true });
		const ticks = subscribe(conn, "tick");
		const messages = subscribe(conn);
		expect(FakeEventSource.instances).toHaveLength(1);
		const source = FakeEventSource.last();
		expect(source.url).toBe(URL_BASE);
		expect(source.init).toEqual({ withCredentials: true });
		source.open();
		expect(fake.states()).toEqual(["connecting", "connected"]);
		source.emit("tick", "t1", "1");
		source.emit("message", "m1", "2");
		source.emit("alert", "ignored", "3");
		expect(ticks.record.events).toEqual(["t1"]);
		expect(ticks.record.metas).toEqual([{ eventId: "1", event: "tick" }]);
		expect(messages.record.events).toEqual(["m1"]);
		expect(messages.record.metas).toEqual([{ eventId: "2", event: "message" }]);
		// Adding a name adds a listener without reconnecting; removing it removes it.
		const alerts = subscribe(conn, "alert");
		expect(FakeEventSource.instances).toHaveLength(1);
		source.emit("alert", "a1", "4");
		expect(alerts.record.events).toHaveLength(1);
		alerts.sub.unsubscribe();
		expect(source.listened.get("alert")).toBe(0);
		// A server event named like the connection's own events is not a connection error.
		expect(ticks.record.errors).toEqual([]);
	});

	it("supervises the browser's own reconnection and reports reconnected", () => {
		const { conn, fake } = setup();
		const one = subscribe(conn);
		const source = FakeEventSource.last();
		source.open();
		source.emit("message", "a", "5");
		source.networkError();
		expect(fake.last()).toEqual({
			state: "reconnecting",
			reason: "network",
			attempt: 1,
		});
		// No competing EventSource while the browser is CONNECTING.
		vi.advanceTimersByTime(60_000);
		expect(FakeEventSource.instances).toHaveLength(1);
		source.open();
		expect(fake.last()).toEqual({ state: "connected" });
		expect(one.record.continuity).toEqual([
			// The early notice at detection, then the outcome.
			{ reason: "reconnected" },
			{ reason: "reconnected" },
		]);
	});

	it("reports resumed-with-cursor after the built-in reconnect only with declared replay", () => {
		const { conn } = setup({ replay: "last-event-id" });
		const one = subscribe(conn);
		const source = FakeEventSource.last();
		source.open();
		source.emit("message", "a", "5");
		source.networkError();
		source.open();
		expect(one.record.continuity).toEqual([
			// The early notice at detection, then the replay outcome.
			{ reason: "reconnected" },
			{
				reason: "resumed-with-cursor",
				detail: { cursor: "5", duplicatesPossible: true },
			},
		]);
	});

	it("listens for a declared reset event, turns it into a gap after a resume and never delivers it", () => {
		const { conn } = setup({ replay: "last-event-id", resetEvent: "reset" });
		const one = subscribe(conn);
		const source = FakeEventSource.last();
		expect(source.listened.get("reset")).toBe(1);
		source.open();
		source.emit("message", "a", "5");
		source.networkError();
		source.open();
		source.emit("reset", "exhausted", "5");
		source.emit("message", "b", "50");
		expect(one.record.continuity).toEqual([
			{ reason: "reconnected" },
			{
				reason: "resumed-with-cursor",
				detail: { cursor: "5", duplicatesPossible: true },
			},
			{ reason: "replay-reset" },
		]);
		expect(one.record.events).toEqual(["a", "b"]);
	});

	it("closes after the bounded attempts and reports retry-exhausted; retry() starts afresh", () => {
		const { conn, fake } = setup();
		subscribe(conn);
		const source = FakeEventSource.last();
		for (let attempt = 1; attempt <= 10; attempt += 1) source.networkError();
		expect(source.closed).toBe(false);
		source.networkError();
		expect(source.closed).toBe(true);
		expect(fake.last()).toEqual({
			state: "retry-exhausted",
			reason: "attempts-exhausted",
		});
		vi.advanceTimersByTime(600_000);
		expect(FakeEventSource.instances).toHaveLength(1);
		conn.retry?.();
		expect(FakeEventSource.instances).toHaveLength(2);
	});

	it("treats CLOSED as opaque: reconnecting/eventsource-closed and bounded recreation", () => {
		const { conn, fake } = setup();
		const one = subscribe(conn);
		FakeEventSource.last().fail();
		expect(fake.last()).toMatchObject({
			state: "reconnecting",
			reason: "server-closed",
			code: "eventsource-closed",
			attempt: 1,
		});
		expect(FakeEventSource.last().closed).toBe(true);
		for (let index = 0; index < 20; index += 1) {
			vi.advanceTimersByTime(30_000);
			FakeEventSource.last().fail();
		}
		expect(FakeEventSource.instances.length).toBeLessThanOrEqual(11);
		expect(fake.last()).toMatchObject({ state: "retry-exhausted" });
		// Never auth-blocked or completed without evidence.
		expect(fake.states()).not.toContain("auth-blocked");
		expect(one.record.completed).toBe(0);
	});

	it("carries the cursor into a recreated EventSource only through the declared query", () => {
		const { conn } = setup({
			resume: { query: "lastEventId" },
			replay: "last-event-id",
		});
		const one = subscribe(conn);
		const first = FakeEventSource.last();
		first.open();
		first.emit("message", "a", "17");
		first.fail();
		vi.advanceTimersByTime(1_000);
		const second = FakeEventSource.last();
		expect(second).not.toBe(first);
		expect(second.url).toBe(`${URL_BASE}?lastEventId=17`);
		second.open();
		expect(one.record.continuity).toEqual([
			// The early notice at detection, then the replay outcome.
			{ reason: "reconnected" },
			{
				reason: "resumed-with-cursor",
				detail: { cursor: "17", duplicatesPossible: true },
			},
		]);
	});

	it("never assumes the implicit cursor survived recreation without a query path", () => {
		const { conn } = setup({ replay: "last-event-id" });
		const one = subscribe(conn);
		const first = FakeEventSource.last();
		first.open();
		first.emit("message", "a", "17");
		first.fail();
		vi.advanceTimersByTime(1_000);
		const second = FakeEventSource.last();
		expect(second.url).toBe(URL_BASE);
		second.open();
		expect(one.record.continuity).toEqual([
			// The early notice at detection, then the outcome.
			{ reason: "reconnected" },
			{ reason: "reconnected" },
		]);
	});

	it("recreates on a missed declared heartbeat; heartbeat events reset it and are not delivered", () => {
		const { conn, fake } = setup({
			heartbeat: { event: "ping", expectInboundWithinMs: 5_000 },
		});
		const one = subscribe(conn);
		const source = FakeEventSource.last();
		source.open();
		for (let index = 0; index < 4; index += 1) {
			vi.advanceTimersByTime(4_000);
			source.emit("ping", "", "");
		}
		expect(FakeEventSource.instances).toHaveLength(1);
		expect(one.record.events).toEqual([]);
		vi.advanceTimersByTime(5_000);
		expect(source.closed).toBe(true);
		expect(fake.last()).toMatchObject({
			state: "reconnecting",
			reason: "heartbeat-timeout",
		});
		vi.advanceTimersByTime(500);
		expect(FakeEventSource.instances).toHaveLength(2);
	});

	it("reopens on a coordinated return check without a declared heartbeat", () => {
		const { conn } = setup();
		const one = subscribe(conn);
		const first = FakeEventSource.last();
		first.open();
		conn.probe?.();
		expect(first.closed).toBe(true);
		const second = FakeEventSource.last();
		expect(second).not.toBe(first);
		second.open();
		expect(one.record.continuity).toEqual([{ reason: "reopened" }]);
	});

	it("bounds initial connection establishment with declared inbound liveness", () => {
		const { conn, fake } = setup({
			heartbeat: { expectInboundWithinMs: 5_000 },
		});
		subscribe(conn);
		const first = FakeEventSource.last();
		vi.advanceTimersByTime(5_000);
		expect(first.closed).toBe(true);
		expect(fake.last()).toMatchObject({
			state: "reconnecting",
			reason: "heartbeat-timeout",
			attempt: 1,
		});
		vi.advanceTimersByTime(500);
		const second = FakeEventSource.last();
		expect(second).not.toBe(first);
		second.open();
		expect(fake.last()).toEqual({ state: "connected" });
		conn.dispose();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("recovers when a replacement EventSource never opens after a heartbeat timeout", () => {
		const { conn, fake } = setup({
			heartbeat: { expectInboundWithinMs: 5_000 },
			resume: { query: "lastEventId" },
			replay: "last-event-id",
		});
		const one = subscribe(conn);
		const first = FakeEventSource.last();
		first.open();
		first.emit("message", "before", "17");
		vi.advanceTimersByTime(5_500);
		const pending = FakeEventSource.last();
		expect(pending).not.toBe(first);
		expect(pending.readyState).toBe(0);
		vi.advanceTimersByTime(5_000);
		expect(pending.closed).toBe(true);
		expect(fake.last()).toMatchObject({
			reason: "heartbeat-timeout",
			attempt: 2,
		});
		vi.advanceTimersByTime(1_000);
		const recovered = FakeEventSource.last();
		expect(recovered).not.toBe(pending);
		expect(recovered.url).toBe(`${URL_BASE}?lastEventId=17`);
		recovered.open();
		recovered.emit("message", "after", "18");
		expect(fake.last()).toEqual({ state: "connected" });
		expect(one.record.events).toEqual(["before", "after"]);
		expect(one.record.continuity.at(-1)).toEqual({
			reason: "resumed-with-cursor",
			detail: { cursor: "17", duplicatesPossible: true },
		});
		conn.dispose();
	});

	it("supervises a browser reconnect that never reopens without extending the inbound deadline", () => {
		const { conn, fake } = setup({
			heartbeat: { expectInboundWithinMs: 5_000 },
		});
		subscribe(conn);
		const first = FakeEventSource.last();
		first.open();
		vi.advanceTimersByTime(4_000);
		first.networkError();
		vi.advanceTimersByTime(999);
		expect(first.closed).toBe(false);
		vi.advanceTimersByTime(1);
		expect(first.closed).toBe(true);
		expect(fake.last()).toMatchObject({
			reason: "heartbeat-timeout",
			attempt: 2,
		});
		vi.advanceTimersByTime(1_000);
		FakeEventSource.last().open();
		expect(fake.last()).toEqual({ state: "connected" });
		conn.dispose();
	});

	it("keeps one watchdog through healthy wake checks and releases it on unsubscribe", () => {
		const { conn } = setup({
			heartbeat: { expectInboundWithinMs: 5_000 },
		});
		const one = subscribe(conn);
		const first = FakeEventSource.last();
		first.open();
		for (let index = 0; index < 20; index += 1) {
			vi.advanceTimersByTime(200);
			first.emit("message", "live");
			conn.probe?.();
			expect(vi.getTimerCount()).toBe(1);
		}
		expect(first.closed).toBe(false);
		one.sub.unsubscribe();
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(60_000);
		expect(FakeEventSource.instances).toHaveLength(1);
	});

	it("checks a pending connection immediately on wake after its declared deadline", () => {
		const { conn, fake } = setup({
			heartbeat: { expectInboundWithinMs: 5_000 },
		});
		subscribe(conn);
		const first = FakeEventSource.last();
		vi.setSystemTime(Date.now() + 6_000);
		conn.probe?.();
		expect(first.closed).toBe(true);
		expect(fake.last()).toMatchObject({ reason: "heartbeat-timeout" });
		expect(vi.getTimerCount()).toBe(1);
		conn.dispose();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("does not guess an establishment timeout without an inbound expectation", () => {
		const { conn, fake } = setup({ heartbeat: { event: "ping" } });
		subscribe(conn);
		const first = FakeEventSource.last();
		vi.advanceTimersByTime(600_000);
		conn.probe?.();
		expect(first.closed).toBe(false);
		expect(FakeEventSource.instances).toHaveLength(1);
		expect(fake.last()).toEqual({ state: "connecting" });
		expect(vi.getTimerCount()).toBe(0);
		conn.dispose();
	});

	it("exhausts silent pending attempts within the existing retry budget and permits an explicit retry", () => {
		const { conn, fake } = setup({
			heartbeat: { expectInboundWithinMs: 5_000 },
		});
		subscribe(conn);
		vi.runAllTimers();
		expect(FakeEventSource.instances).toHaveLength(11);
		expect(FakeEventSource.instances.every((source) => source.closed)).toBe(
			true,
		);
		expect(fake.last()).toMatchObject({ state: "retry-exhausted" });
		expect(vi.getTimerCount()).toBe(0);
		conn.retry?.();
		expect(FakeEventSource.instances).toHaveLength(12);
		FakeEventSource.last().open();
		expect(fake.last()).toEqual({ state: "connected" });
		conn.dispose();
	});

	it("closes on the last unsubscribe and releases listeners", () => {
		const { conn, fake } = setup();
		const one = subscribe(conn);
		const source = FakeEventSource.last();
		source.open();
		one.sub.unsubscribe();
		expect(source.closed).toBe(true);
		expect(fake.last()).toEqual({ state: "inactive", reason: "idle" });
		source.emit("message", "late", "9");
		expect(one.record.events).toEqual([]);
	});

	it("fails clearly where EventSource does not exist", () => {
		vi.stubGlobal("EventSource", undefined);
		const { conn, fake } = setup();
		subscribe(conn);
		expect(fake.last()).toEqual({
			state: "failed",
			reason: "permanent-error",
			code: "eventsource-unavailable",
		});
	});
});
