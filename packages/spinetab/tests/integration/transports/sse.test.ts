import { randomUUID } from "node:crypto";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	inject,
	it,
	vi,
} from "vitest";
import type { AdapterConnection } from "../../../src/core/adapter.ts";
import {
	type SseConnectionSpec,
	type SseSubscriptionSpec,
	sseAdapter,
} from "../../../src/transports/sse/runtime.ts";
import {
	fakeContext,
	recordingSink,
	waitFor,
} from "../../unit/transports/helpers.ts";

// NT-I-08…11 and the SSE half of NT-I-17: fetch-mode SSE against the real
// `sse` fixture. Native EventSource is covered by sse-eventsource.test.ts.

const [origin] = inject("fixtureOrigins");

interface SseCounters {
	streams: number;
	active: number;
	requests: Array<{
		method: string;
		lastEventId: string | null;
		lastEventIdQuery: string | null;
		hasAuth: boolean;
		scope: string | null;
	}>;
	disconnects: number;
}

async function counters(run: string): Promise<SseCounters> {
	return (await (
		await fetch(`${origin}/sse/counters?run=${run}`)
	).json()) as SseCounters;
}

type Conn = AdapterConnection<SseSubscriptionSpec, unknown>;
const open: Conn[] = [];

/**
 * `fixtureQuery` is appended after validation: the public API refuses `auth` as a URL query
 * name (the fixture switch is therefore called `guard`), and the fixture's `guard=1` switch is a test detail no application
 * option carries.
 */
function connect(
	query: string,
	spec: Partial<SseConnectionSpec> = {},
	fixtureQuery = "",
) {
	const run = randomUUID();
	const adapter = sseAdapter();
	const connection = {
		url: `${origin}/sse/ticks?run=${run}&${query}`,
		mode: "fetch",
		// Text unless a test names a decoder; unit tests cover the default.
		decoder: "text",
		...spec,
	} as SseConnectionSpec;
	adapter.validateConnection?.(connection);
	const fake = fakeContext();
	const conn = adapter.connect(
		fixtureQuery
			? { ...connection, url: `${connection.url}&${fixtureQuery}` }
			: connection,
		fake.ctx,
	) as Conn;
	open.push(conn);
	return { run, conn, fake };
}

function subscribe(conn: Conn, event?: string, repeatable = true) {
	const record = recordingSink<unknown>();
	const sub = conn.subscribe(
		event === undefined ? {} : { event },
		record.sink,
		{
			key: event ?? "message",
			repeatable,
		},
	);
	return { record, sub };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The SSE event name a sink meta carries; core's type gains it. */
const eventOf = (meta: unknown) =>
	(meta as { event?: string } | undefined)?.event;

/** The delivered data with its meta fields beside it (moved them to meta). */
function envelopes(record: ReturnType<typeof subscribe>["record"]) {
	return record.events.map((data, index) => ({
		id: record.metas[index]?.eventId ?? null,
		event: eventOf(record.metas[index]),
		data,
	}));
}

beforeEach(() => {
	vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
	for (const conn of open.splice(0)) conn.dispose();
	vi.restoreAllMocks();
});

describe("fetch-mode SSE against the sse fixture", () => {
	it("shares one stream across named events and resumes with Last-Event-ID only when declared (NT-I-08)", async () => {
		const { run, conn } = connect(
			"rate=10&alertEvery=2&resetAfter=4&resetOnce=1",
			{
				decoder: "json",
				replay: "last-event-id",
			},
		);
		const ticks = subscribe(conn, "tick");
		const alerts = subscribe(conn, "alert");
		await waitFor(
			() =>
				ticks.record.continuity.length === 2 && ticks.record.events.length >= 4,
		);
		const server = await counters(run);
		expect(server.requests[0]?.lastEventId).toBeNull();
		expect(server.requests[1]?.lastEventId).toBe("4");
		// The early notice at detection, then the replay outcome.
		expect(ticks.record.continuity).toEqual([
			{ reason: "reconnected" },
			{
				reason: "resumed-with-cursor",
				detail: { cursor: "4", duplicatesPossible: true },
			},
		]);
		const ns = [...ticks.record.events, ...alerts.record.events]
			.map((data) => (data as { n: number }).n)
			.sort((a, b) => a - b);
		// The fixture replays from the cursor, so nothing is missed or duplicated.
		expect(ns.slice(0, 6)).toEqual([1, 2, 3, 4, 5, 6]);
		expect(ticks.record.metas.every((meta) => eventOf(meta) === "tick")).toBe(
			true,
		);
		expect(alerts.record.metas.every((meta) => eventOf(meta) === "alert")).toBe(
			true,
		);
		expect(envelopes(alerts.record)[0]).toEqual({
			id: "2",
			event: "alert",
			data: { n: 2, text: "héllo 🌍" },
		});
		expect(server.streams).toBe(2);
	});

	it("reports reconnected, not resumed, without a declared replay capability", async () => {
		const { run, conn } = connect("rate=10&resetAfter=2&resetOnce=1");
		const ticks = subscribe(conn, "tick");
		await waitFor(() => ticks.record.continuity.length === 2);
		expect(ticks.record.continuity).toEqual([
			{ reason: "reconnected" },
			{ reason: "reconnected" },
		]);
		expect((await counters(run)).requests[1]?.lastEventId).toBe("2");
	});

	it("reports a gap, not a resume, when the declared reset event says the cursor is too old", async () => {
		// Retention floor 20: the reconnect with Last-Event-ID 3 is below it, so
		// the fixture sends `event: reset` and continues from the floor.
		const { run, conn } = connect(
			"rate=10&resetAfter=3&resetOnce=1&oldest=20",
			{ decoder: "json", replay: "last-event-id", resetEvent: "reset" },
		);
		const ticks = subscribe(conn, "tick");
		await waitFor(
			() =>
				ticks.record.continuity.length === 3 && ticks.record.events.length >= 5,
		);
		expect((await counters(run)).requests[1]?.lastEventId).toBe("3");
		expect(ticks.record.continuity).toEqual([
			{ reason: "reconnected" },
			{
				reason: "resumed-with-cursor",
				detail: { cursor: "3", duplicatesPossible: true },
			},
			{ reason: "replay-reset" },
		]);
		expect(ticks.record.metas.slice(0, 5).map((meta) => meta?.eventId)).toEqual(
			["1", "2", "3", "20", "21"],
		);
		expect(ticks.record.metas.some((meta) => eventOf(meta) === "reset")).toBe(
			false,
		);
	});

	it("completes on 204 and stops requesting (NT-I-09)", async () => {
		const { run, conn } = connect("fault=status&status=204");
		const one = subscribe(conn, "tick");
		await waitFor(() => one.record.completed === 1);
		await sleep(150);
		expect((await counters(run)).requests).toHaveLength(1);
	});

	it("fails on a wrong content type without parsing it (NT-I-09)", async () => {
		const { run, conn, fake } = connect("fault=wrong-content-type");
		const one = subscribe(conn);
		await waitFor(() => one.record.errors.length === 1);
		expect(one.record.errors[0]?.code).toBe("protocol-error");
		expect(one.record.events).toEqual([]);
		expect(fake.last()).toMatchObject({
			state: "failed",
			reason: "protocol-error",
		});
		await sleep(150);
		expect((await counters(run)).requests).toHaveLength(1);
	});

	it("retries 5xx in the bounded loop, then connects (NT-I-09)", async () => {
		const { run, conn, fake } = connect("rate=10&failFirst=2&failStatus=503");
		const ticks = subscribe(conn, "tick");
		await waitFor(() => ticks.record.events.length >= 1);
		expect((await counters(run)).requests.length).toBe(3);
		expect(fake.states().slice(0, 4)).toEqual([
			"connecting",
			"reconnecting",
			"reconnecting",
			"connected",
		]);
		expect(fake.statuses[1]).toMatchObject({ code: 503, attempt: 1 });
	});

	it("merges credential headers and blocks on 401 with the request counter flat (NT-I-09)", async () => {
		const good = connect("rate=10", { authHeaders: true }, "guard=1");
		good.fake.setCredentials(async () => ({
			headers: { Authorization: "Bearer valid-s2-1" },
		}));
		const ticks = subscribe(good.conn, "tick");
		await waitFor(() => ticks.record.events.length >= 1);
		const request = (await counters(good.run)).requests[0];
		expect(request).toMatchObject({ hasAuth: true, scope: "s2" });

		const bad = connect("rate=10", { authHeaders: true }, "guard=1");
		bad.fake.setCredentials(async () => ({
			headers: { Authorization: "Bearer revoked-s2-1" },
		}));
		subscribe(bad.conn, "tick");
		await waitFor(() => bad.fake.last()?.state === "auth-blocked");
		expect(bad.fake.last()).toEqual({
			state: "auth-blocked",
			reason: "credentials-rejected",
			code: "http:401",
		});
		expect(bad.fake.rejections()).toBe(1);
		await sleep(300);
		expect((await counters(bad.run)).requests).toHaveLength(1);

		const none = connect("rate=10", { authHeaders: true }, "guard=1");
		subscribe(none.conn, "tick");
		await waitFor(() => none.fake.last()?.state === "auth-blocked");
		expect(none.fake.last()).toEqual({
			state: "auth-blocked",
			reason: "no-credential-source",
		});
		expect((await counters(none.run)).requests).toHaveLength(0);
	});

	it("parses 1-byte writes, BOM, CR/LF variants and id edge cases exactly like whole writes (NT-I-10)", async () => {
		const collect = async (query: string) => {
			const { conn } = connect(query);
			const messages = subscribe(conn);
			const alerts = subscribe(conn, "alert");
			await waitFor(
				() =>
					alerts.record.events.length >= 1 &&
					messages.record.events.length >= 4,
			);
			const first = [...messages.record.log];
			messages.sub.unsubscribe();
			alerts.sub.unsubscribe();
			return {
				messages: envelopes(messages.record).slice(0, 4),
				alert: envelopes(alerts.record)[0],
				first,
			};
		};
		const split = await collect("split=1&fault=id-variants");
		const whole = await collect("fault=id-variants");
		expect(whole.messages).toEqual([
			{ id: "1", event: "message", data: "a" },
			{ id: null, event: "message", data: "b" },
			{ id: "2", event: "message", data: "c" },
			{ id: "2", event: "message", data: "d" },
		]);
		expect(whole.alert).toEqual({ id: "2", event: "alert", data: "e" });
		expect(split.messages).toEqual(whole.messages);
		expect(split.alert).toEqual(whole.alert);
	});

	it("sends a declared POST once; a non-repeatable interruption settles interrupted (NT-I-11)", async () => {
		const { run, conn } = connect("rate=10&resetAfter=2", {
			method: "POST",
			body: '{"q":"x"}',
			headers: { "Content-Type": "application/json" },
		});
		const one = subscribe(conn, "tick", false);
		await waitFor(() => one.record.errors.length === 1);
		expect(one.record.errors[0]?.code).toBe("interrupted");
		expect(one.record.events).toHaveLength(2);
		await sleep(200);
		const server = await counters(run);
		expect(server.requests.map((request) => request.method)).toEqual(["POST"]);
	});

	it("reconnects a stalled stream on the declared inbound expectation (NT-I-17)", async () => {
		const { run, conn, fake } = connect("fault=stall", {
			heartbeat: { expectInboundWithinMs: 200 },
		});
		subscribe(conn, "tick");
		await waitFor(
			async () => (await counters(run)).requests.length >= 2,
			3_000,
		);
		expect(fake.statuses).toContainEqual(
			expect.objectContaining({
				state: "reconnecting",
				reason: "heartbeat-timeout",
			}),
		);
		await waitFor(async () => (await counters(run)).disconnects >= 1);
	});

	it("aborts the upstream request when the last subscription leaves", async () => {
		const { run, conn } = connect("rate=10");
		const ticks = subscribe(conn, "tick");
		await waitFor(() => ticks.record.events.length >= 1);
		ticks.sub.unsubscribe();
		await waitFor(async () => (await counters(run)).active === 0);
		expect((await counters(run)).disconnects).toBe(1);
	});
});
