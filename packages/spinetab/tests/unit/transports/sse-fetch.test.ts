import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type SseAdapterOptions,
	type SseConnectionSpec,
	sseAdapter,
} from "../../../src/transports/sse/runtime.ts";
import {
	eventStream,
	fakeContext,
	flush,
	recordingSink,
	type ScriptedBody,
	type ScriptedRequest,
	scriptedBody,
	scriptedFetch,
} from "./helpers.ts";

// Fetch-mode SSE through the adapter contract.

const URL_BASE = "https://api.test/sse";

function ok(body: ScriptedBody, init: ResponseInit = {}) {
	return (request: ScriptedRequest) =>
		eventStream(body, init, request.init.signal ?? undefined);
}

function setup(
	spec: Partial<SseConnectionSpec>,
	responders: Parameters<typeof scriptedFetch>[0],
	options: SseAdapterOptions = {},
	context: Parameters<typeof fakeContext>[0] = {},
) {
	const scripted = scriptedFetch(responders);
	vi.stubGlobal("fetch", scripted.fetch);
	const adapter = sseAdapter(options);
	// Plain-text payloads: these tests route and resume; covers decoding.
	const connection = {
		url: URL_BASE,
		mode: "fetch",
		decoder: "text",
		...spec,
	} as SseConnectionSpec;
	adapter.validateConnection?.(connection);
	const fake = fakeContext(context);
	const conn = adapter.connect(connection, fake.ctx);
	return { adapter, conn, fake, requests: scripted.requests };
}

function subscribe(
	conn: ReturnType<typeof setup>["conn"],
	event?: string,
	extra: { cursor?: string; repeatable?: boolean } = {},
) {
	const record = recordingSink<unknown>();
	const sub = conn.subscribe(
		event === undefined ? {} : { event },
		record.sink,
		{
			key: event ?? "message",
			repeatable: extra.repeatable ?? true,
			...(extra.cursor === undefined ? {} : { cursor: extra.cursor }),
		} as never,
	);
	return { record, sub };
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	vi.spyOn(Math, "random").mockReturnValue(0.5);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("requests and routing", () => {
	it("sends the declared request and routes named events in stream order", async () => {
		const body = scriptedBody();
		const { conn, requests } = setup(
			{
				method: "POST",
				body: '{"q":1}',
				headers: { "X-Feed": "a" },
				credentials: "include",
				repeatable: true,
			},
			[ok(body)],
		);
		const ticks = subscribe(conn, "tick");
		const alerts = subscribe(conn, "alert");
		const messages = subscribe(conn);
		await flush(20);
		expect(requests).toHaveLength(1);
		const request = requests[0];
		expect(request?.init.method).toBe("POST");
		expect(request?.init.body).toBe('{"q":1}');
		expect(request?.init.credentials).toBe("include");
		expect(request?.init.cache).toBe("no-store");
		expect(request?.headers.get("accept")).toBe("text/event-stream");
		expect(request?.headers.get("x-feed")).toBe("a");
		expect(request?.headers.has("last-event-id")).toBe(false);
		body.write(
			"id: 1\nevent: tick\ndata: t1\n\nid: 2\nevent: alert\ndata: a1\n\n",
		);
		body.write("event: tick\ndata: t2\n\ndata: m\n\nevent: other\ndata: o\n\n");
		await flush(20);
		// Each event arrives as its data; ID and name travel in meta.
		expect(ticks.record.events).toEqual(["t1", "t2"]);
		expect(ticks.record.metas).toEqual([
			{ eventId: "1", event: "tick" },
			{ eventId: "2", event: "tick" },
		]);
		expect(alerts.record.events).toEqual(["a1"]);
		expect(alerts.record.metas).toEqual([{ eventId: "2", event: "alert" }]);
		expect(messages.record.events).toEqual(["m"]);
		expect(messages.record.metas).toEqual([{ eventId: "2", event: "message" }]);
	});

	it("uses null ids after an empty id reset", async () => {
		const body = scriptedBody();
		const { conn } = setup({}, [ok(body)]);
		const messages = subscribe(conn);
		await flush(20);
		body.write("id: 5\ndata: a\n\nid:\ndata: b\n\n");
		await flush(20);
		expect(messages.record.metas.map((meta) => meta?.eventId)).toEqual([
			"5",
			undefined,
		]);
		expect(messages.record.metas[1]).toEqual({ event: "message" });
	});

	it("decodes once per event; a decode failure is a gap, not the end of the stream", async () => {
		const body = scriptedBody();
		const { conn, fake } = setup({ decoder: "json" }, [ok(body)]);
		const one = subscribe(conn);
		await flush(20);
		body.write(
			'id: 1\ndata: {"n":1}\n\nid: 2\ndata: {secret\n\nid: 3\ndata: {"n":3}\n\n',
		);
		await flush(20);
		expect(one.record.events).toEqual([{ n: 1 }, { n: 3 }]);
		expect(one.record.continuity).toEqual([{ reason: "decode-error" }]);
		// A fixed diagnostic type without upstream text.
		expect(fake.diagnostics).toContainEqual({ type: "decode-error" });
		expect(JSON.stringify(fake.diagnostics)).not.toContain("secret");
	});

	it("does not deliver declared heartbeat events", async () => {
		const body = scriptedBody();
		const { conn } = setup({ heartbeat: { event: "ping" } }, [ok(body)]);
		const one = subscribe(conn);
		await flush(20);
		body.write("event: ping\ndata: x\n\ndata: real\n\n");
		await flush(20);
		expect(one.record.events).toEqual(["real"]);
	});
});

describe("reconnection, cursor and continuity", () => {
	it("reconnects after end of body with Last-Event-ID and reports reconnected without replay", async () => {
		const first = scriptedBody();
		const second = scriptedBody();
		const { conn, requests, fake } = setup({}, [ok(first), ok(second)]);
		const one = subscribe(conn);
		await flush(20);
		first.write("id: 7\ndata: a\n\nid: 8\ndata: partial");
		first.end();
		await flush(20);
		expect(fake.last()).toMatchObject({
			state: "reconnecting",
			reason: "server-closed",
			attempt: 1,
		});
		await vi.advanceTimersByTimeAsync(500);
		await flush(20);
		expect(requests).toHaveLength(2);
		// The incomplete final event did not commit its id.
		expect(requests[1]?.headers.get("last-event-id")).toBe("7");
		expect(one.record.continuity).toEqual([
			// The early notice at detection, then the outcome.
			{ reason: "reconnected" },
			{ reason: "reconnected" },
		]);
	});

	it("reports resumed-with-cursor only when replay is declared and a cursor was conveyed", async () => {
		const first = scriptedBody();
		const second = scriptedBody();
		const third = scriptedBody();
		const { conn, requests } = setup({ replay: "last-event-id" }, [
			ok(first),
			ok(second),
			ok(third),
		]);
		const one = subscribe(conn);
		await flush(20);
		first.write("id: 3\ndata: a\n\n");
		first.fail();
		await flush(20);
		await vi.advanceTimersByTimeAsync(500);
		await flush(20);
		expect(requests[1]?.headers.get("last-event-id")).toBe("3");
		expect(one.record.continuity).toEqual([
			// The early notice at detection, then the replay outcome.
			{ reason: "reconnected" },
			{
				reason: "resumed-with-cursor",
				detail: { cursor: "3", duplicatesPossible: true },
			},
		]);
		// An empty id resets the cursor: nothing is conveyed, so no replay claim.
		second.write("id:\ndata: b\n\n");
		second.fail();
		await flush(20);
		await vi.advanceTimersByTimeAsync(1_000);
		await flush(20);
		expect(requests).toHaveLength(3);
		expect(requests[2]?.headers.has("last-event-id")).toBe(false);
		expect(one.record.continuity.at(-1)).toEqual({ reason: "reconnected" });
	});

	it("turns a declared reset event into a gap after a resume and never delivers it", async () => {
		const first = scriptedBody();
		const second = scriptedBody();
		const { conn, requests } = setup(
			{ replay: "last-event-id", resetEvent: "reset" },
			[ok(first), ok(second)],
		);
		const one = subscribe(conn);
		const ticks = subscribe(conn, "tick");
		await flush(20);
		first.write("id: 3\ndata: a\n\n");
		first.fail();
		await flush(20);
		await vi.advanceTimersByTimeAsync(500);
		await flush(20);
		expect(requests[1]?.headers.get("last-event-id")).toBe("3");
		// The server says the cursor is too old, then continues from its floor.
		second.write(
			"event: reset\ndata: exhausted\n\nid: 50\ndata: b\n\nid: 51\nevent: tick\ndata: t\n\n",
		);
		await flush(20);
		for (const record of [one.record, ticks.record]) {
			expect(record.continuity).toEqual([
				{ reason: "reconnected" },
				{
					reason: "resumed-with-cursor",
					detail: { cursor: "3", duplicatesPossible: true },
				},
				{ reason: "replay-reset" },
			]);
		}
		expect(one.record.events).toEqual(["a", "b"]);
		expect(ticks.record.events).toEqual(["t"]);
	});

	it("conveys the cursor through a declared query parameter instead of the header", async () => {
		const first = scriptedBody();
		const second = scriptedBody();
		const { conn, requests } = setup({ resume: { query: "lastEventId" } }, [
			ok(first),
			ok(second),
		]);
		subscribe(conn);
		await flush(20);
		first.write("id: 42\ndata: a\n\n");
		first.end();
		await flush(20);
		await vi.advanceTimersByTimeAsync(500);
		await flush(20);
		expect(requests[1]?.url).toBe(`${URL_BASE}?lastEventId=42`);
		expect(requests[1]?.headers.has("last-event-id")).toBe(false);
	});

	it("clamps the retry field to 250 ms–60 s and uses it as the backoff base", async () => {
		const first = scriptedBody();
		const second = scriptedBody();
		const { conn, requests } = setup({}, [ok(first), ok(second)]);
		subscribe(conn);
		await flush(20);
		first.write("retry: 10\ndata: a\n\n");
		first.end();
		await flush(20);
		// Base clamped to 250 ms, full jitter with random() = 0.5 → 125 ms.
		await vi.advanceTimersByTimeAsync(124);
		expect(requests).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		await flush(20);
		expect(requests).toHaveLength(2);
	});

	it("opens with the first re-registered cursor after runtime replacement", async () => {
		const body = scriptedBody();
		const { conn, requests } = setup({ replay: "last-event-id" }, [ok(body)]);
		const first = subscribe(conn, "message", { cursor: "10" });
		const second = subscribe(conn, "tick", { cursor: "9" });
		await flush(20);
		expect(requests[0]?.headers.get("last-event-id")).toBe("10");
		expect(first.record.continuity).toEqual([
			{
				reason: "resumed-with-cursor",
				detail: { cursor: "10", duplicatesPossible: true },
			},
		]);
		// A divergent cursor is not resumed; the runtime reports it unknown.
		expect(second.record.continuity).toEqual([]);
	});
});

describe("response validation", () => {
	it("completes on 204 and never reconnects", async () => {
		const { conn, requests } = setup({}, [
			() => new Response(null, { status: 204 }),
		]);
		const one = subscribe(conn);
		await flush(20);
		expect(one.record.completed).toBe(1);
		await vi.advanceTimersByTimeAsync(300_000);
		expect(requests).toHaveLength(1);
	});

	it("fails with protocol-error on a wrong content type without parsing or retrying", async () => {
		const { conn, requests, fake } = setup({}, [
			() =>
				new Response("data: not an event\n\n", {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
		]);
		const one = subscribe(conn);
		await flush(20);
		expect(one.record.events).toEqual([]);
		expect(one.record.errors.map((error) => error.code)).toEqual([
			"protocol-error",
		]);
		expect(fake.last()).toMatchObject({
			state: "failed",
			reason: "protocol-error",
		});
		await vi.advanceTimersByTimeAsync(300_000);
		expect(requests).toHaveLength(1);
	});

	it("retries 500 within the bounded loop and ends in retry-exhausted", async () => {
		const responders = Array.from(
			{ length: 12 },
			() => () => new Response("x", { status: 500 }),
		);
		const { conn, requests, fake } = setup({}, responders);
		const one = subscribe(conn);
		await vi.advanceTimersByTimeAsync(300_000);
		await flush(20);
		expect(requests).toHaveLength(11);
		expect(fake.last()).toEqual({
			state: "retry-exhausted",
			reason: "attempts-exhausted",
		});
		expect(one.record.errors).toEqual([]);
	});

	it("blocks on 401 with the fixture counter flat until rotation", async () => {
		const body = scriptedBody();
		const { conn, requests, fake } = setup({ authHeaders: true }, [
			() => new Response("", { status: 401 }),
			ok(body),
		]);
		fake.setCredentials(async () => ({
			headers: { authorization: "Bearer valid-a-1" },
		}));
		subscribe(conn);
		await flush(20);
		expect(requests[0]?.headers.get("authorization")).toBe("Bearer valid-a-1");
		expect(fake.last()).toEqual({
			state: "auth-blocked",
			reason: "credentials-rejected",
			code: "http:401",
		});
		expect(fake.rejections()).toBe(1);
		await vi.advanceTimersByTimeAsync(300_000);
		expect(requests).toHaveLength(1);
		conn.rotate?.();
		await flush(20);
		expect(requests).toHaveLength(2);
	});

	it("maps a credential timeout to auth-blocked/credentials-missing without a request", async () => {
		const { conn, requests, fake } = setup({ authHeaders: true }, []);
		fake.setCredentials(() =>
			Promise.reject(
				Object.assign(new Error("timeout"), {
					name: "SpinetabError",
					code: "credentials-timeout",
				}),
			),
		);
		subscribe(conn);
		await flush(20);
		expect(requests).toHaveLength(0);
		expect(fake.last()).toEqual({
			state: "auth-blocked",
			reason: "credentials-missing",
		});
	});

	it("blocks on a failed provider exactly as on a timeout and never connects anonymously", async () => {
		const { conn, requests, fake } = setup({ authHeaders: true }, []);
		fake.setCredentials(() =>
			Promise.reject(
				Object.assign(new Error("provider threw"), {
					name: "SpinetabError",
					code: "credentials-failed",
				}),
			),
		);
		subscribe(conn);
		await flush(20);
		expect(requests).toHaveLength(0);
		expect(fake.last()).toEqual({
			state: "auth-blocked",
			reason: "credentials-missing",
		});
		await vi.advanceTimersByTimeAsync(300_000);
		expect(requests).toHaveLength(0);
	});
});

describe("non-repeatable fetch streams", () => {
	it("completes on end of body and settles interruption as interrupted", async () => {
		const ended = scriptedBody();
		const post = setup({ method: "POST", body: "{}" }, [ok(ended)]);
		const one = subscribe(post.conn, undefined, { repeatable: false });
		await flush(20);
		ended.write("data: a\n\n");
		ended.end();
		await flush(20);
		expect(one.record.completed).toBe(1);

		const cut = scriptedBody();
		const again = setup({ method: "POST", body: "{}" }, [ok(cut)]);
		const two = subscribe(again.conn, undefined, { repeatable: false });
		await flush(20);
		cut.fail();
		await flush(20);
		expect(two.record.errors.map((error) => error.code)).toEqual([
			"interrupted",
		]);
		await vi.advanceTimersByTimeAsync(300_000);
		expect(again.requests).toHaveLength(1);
	});
});

describe("liveness and release", () => {
	it("reconnects with the cursor when the declared inbound expectation is missed", async () => {
		const first = scriptedBody();
		const second = scriptedBody();
		const { conn, requests, fake } = setup(
			{ heartbeat: { expectInboundWithinMs: 10_000 } },
			[ok(first), ok(second)],
		);
		subscribe(conn);
		await flush(20);
		first.write(": comment keeps the stream alive\n");
		await flush(10);
		await vi.advanceTimersByTimeAsync(8_000);
		first.write("id: 4\ndata: a\n\n");
		await flush(10);
		await vi.advanceTimersByTimeAsync(9_999);
		expect(requests).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(fake.last()).toMatchObject({
			state: "reconnecting",
			reason: "heartbeat-timeout",
		});
		await vi.advanceTimersByTimeAsync(500);
		await flush(20);
		expect(requests).toHaveLength(2);
		expect(requests[1]?.headers.get("last-event-id")).toBe("4");
	});

	it("keeps a quiet stream without a declared heartbeat open indefinitely", async () => {
		const body = scriptedBody();
		const { conn, requests, fake } = setup({}, [ok(body)]);
		subscribe(conn);
		await flush(20);
		await vi.advanceTimersByTimeAsync(3_600_000);
		expect(requests).toHaveLength(1);
		expect(fake.last()).toEqual({ state: "connected" });
	});

	it("aborts when the last subscription leaves; one remaining selection keeps it open", async () => {
		const body = scriptedBody();
		const { conn, requests, fake } = setup({}, [ok(body)]);
		const ticks = subscribe(conn, "tick");
		const messages = subscribe(conn);
		await flush(20);
		ticks.sub.unsubscribe();
		expect(requests[0]?.aborted()).toBe(false);
		messages.sub.unsubscribe();
		expect(requests[0]?.aborted()).toBe(true);
		expect(fake.last()).toEqual({ state: "inactive", reason: "idle" });
	});
});

/** A header value's bytes as sent: fetch sends each code unit (≤ 0xFF) as one byte. */
function wireBytes(value: string | null | undefined) {
	if (value === null || value === undefined) return value;
	return Array.from(value, (unit) =>
		unit.charCodeAt(0).toString(16).padStart(2, "0"),
	).join(" ");
}

/** One real macrotask, so Node reports any unhandled rejection before it. */
const nextTask = () => new Promise((resolve) => setImmediate(resolve));

// NT-U-44, (phase 2b): Last-Event-ID carries the cursor's UTF-8
// bytes; a cursor a header cannot carry exactly is not conveyed,
// and a request that cannot be built fails instead of hanging.
describe("cursor conveyance", () => {
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => unhandled.push(reason);
	beforeEach(() => {
		unhandled.length = 0;
		process.on("unhandledRejection", onUnhandled);
	});
	afterEach(() => {
		process.off("unhandledRejection", onUnhandled);
	});

	const cases: Array<[string, string]> = [
		["42", "34 32"],
		["a b", "61 20 62"],
		["é1", "c3 a9 31"],
		["€1", "e2 82 ac 31"],
		["日本", "e6 97 a5 e6 9c ac"],
		["\u{1F600}", "f0 9f 98 80"],
	];
	for (const [id, bytes] of cases) {
		it(`reconnects with ${JSON.stringify(id)} sent as the UTF-8 bytes ${bytes}`, async () => {
			const first = scriptedBody();
			const second = scriptedBody();
			const { conn, requests, fake } = setup({ replay: "last-event-id" }, [
				ok(first),
				ok(second),
			]);
			const one = subscribe(conn);
			await flush(20);
			first.write(`id: ${id}\ndata: a\n\n`);
			first.end();
			await flush(20);
			await vi.advanceTimersByTimeAsync(500);
			await flush(20);
			await nextTask();
			expect(requests).toHaveLength(2);
			expect(wireBytes(requests[1]?.headers.get("last-event-id"))).toBe(bytes);
			expect(one.record.continuity.at(-1)).toEqual({
				reason: "resumed-with-cursor",
				detail: { cursor: id, duplicatesPossible: true },
			});
			expect(fake.last()).toEqual({ state: "connected" });
			expect(unhandled).toEqual([]);
		});
	}

	it("sends the same bytes when chunk boundaries split the multibyte id", async () => {
		const encoder = new TextEncoder();
		for (const [id, bytes] of [
			["€1", "e2 82 ac 31"],
			["\u{1F600}", "f0 9f 98 80"],
		] as const) {
			const first = scriptedBody();
			const second = scriptedBody();
			const { conn, requests } = setup({}, [ok(first), ok(second)]);
			subscribe(conn);
			await flush(20);
			for (const byte of encoder.encode(`id: ${id}\ndata: a\n\n`)) {
				first.write(Uint8Array.of(byte));
			}
			first.end();
			await flush(40);
			await vi.advanceTimersByTimeAsync(500);
			await flush(20);
			await nextTask();
			expect(requests, id).toHaveLength(2);
			expect(wireBytes(requests[1]?.headers.get("last-event-id")), id).toBe(
				bytes,
			);
		}
		expect(unhandled).toEqual([]);
	});

	it("does not convey a cursor with leading or trailing HTTP whitespace: reconnected, not resumed", async () => {
		for (const line of ["id:  5", "id: 5\t", "id: \t5", "id: 5 "]) {
			const first = scriptedBody();
			const second = scriptedBody();
			const { conn, requests } = setup({ replay: "last-event-id" }, [
				ok(first),
				ok(second),
			]);
			const one = subscribe(conn);
			await flush(20);
			first.write(`${line}\ndata: a\n\n`);
			first.end();
			await flush(20);
			await vi.advanceTimersByTimeAsync(500);
			await flush(20);
			expect(requests, line).toHaveLength(2);
			expect(requests[1]?.headers.has("last-event-id"), line).toBe(false);
			expect(one.record.continuity, line).toEqual([
				{ reason: "reconnected" },
				{ reason: "reconnected" },
			]);
		}
	});

	it("opens with a re-registered cursor outside Latin-1 as its UTF-8 bytes", async () => {
		const body = scriptedBody();
		const { conn, requests } = setup({ replay: "last-event-id" }, [ok(body)]);
		const first = subscribe(conn, "message", { cursor: "€9" });
		await flush(20);
		await nextTask();
		expect(requests).toHaveLength(1);
		expect(wireBytes(requests[0]?.headers.get("last-event-id"))).toBe(
			"e2 82 ac 39",
		);
		expect(first.record.continuity).toEqual([
			{
				reason: "resumed-with-cursor",
				detail: { cursor: "€9", duplicatesPossible: true },
			},
		]);
		expect(unhandled).toEqual([]);
	});

	it("does not convey a re-registered cursor containing NUL, CR or LF", async () => {
		for (const cursor of ["a\u0000b", "a\nb", "a\rb"]) {
			const body = scriptedBody();
			const { conn, requests, fake } = setup({ replay: "last-event-id" }, [
				ok(body),
			]);
			const first = subscribe(conn, "message", { cursor });
			await flush(20);
			await nextTask();
			const label = JSON.stringify(cursor);
			expect(requests, label).toHaveLength(1);
			expect(requests[0]?.headers.has("last-event-id"), label).toBe(false);
			expect(first.record.continuity, label).toEqual([]);
			expect(fake.last(), label).toEqual({ state: "connected" });
		}
		expect(unhandled).toEqual([]);
	});

	it("fails a connection whose request cannot be built instead of hanging in connecting", async () => {
		const scripted = scriptedFetch([]);
		vi.stubGlobal("fetch", scripted.fetch);
		const fake = fakeContext();
		// Connected without validateConnection, which refuses this spec.
		const conn = sseAdapter().connect(
			{
				url: URL_BASE,
				mode: "fetch",
				decoder: "text",
				headers: { "x-label": "日本" },
			},
			fake.ctx,
		);
		const one = subscribe(conn);
		await flush(20);
		await nextTask();
		expect(scripted.requests).toHaveLength(0);
		expect(fake.states()).toEqual(["connecting", "failed"]);
		expect(fake.last()).toEqual({
			state: "failed",
			reason: "permanent-error",
			code: "unsupported-option",
		});
		expect(one.record.errors.map((error) => error.code)).toEqual([
			"unsupported-option",
		]);
		expect(JSON.stringify(one.record.errors)).not.toContain("日本");
		expect(unhandled).toEqual([]);
	});
});

// NT-U-45, (phase 2b): events completed before `frame-too-large`
// in the same chunk are delivered in order and advance the cursor; the
// failure follows.
describe("events completed before frame-too-large", () => {
	it("delivers them, advances the cursor and then fails, however the bytes are chunked", async () => {
		const text = `id: 1\ndata: a\n\nid: 2\ndata: b\n\ndata: ${"x".repeat(100)}`;
		for (const chunks of [[text], [text.slice(0, 30), text.slice(30)]]) {
			const body = scriptedBody();
			const retried = scriptedBody();
			const { conn, requests, fake } = setup(
				{},
				[ok(body), ok(retried)],
				{},
				{ limits: { maxFrameBytes: 64 } },
			);
			const one = subscribe(conn);
			await flush(20);
			for (const chunk of chunks) body.write(chunk);
			await flush(20);
			const label = `${chunks.length} chunk(s)`;
			expect(one.record.events, label).toEqual(["a", "b"]);
			expect(one.record.log, label).toEqual([
				"next",
				"next",
				"error:frame-too-large",
			]);
			expect(fake.last(), label).toEqual({
				state: "failed",
				reason: "protocol-error",
				code: "frame-too-large",
			});
			// An explicit retry resumes after the delivered events.
			conn.retry?.();
			await flush(20);
			expect(requests, label).toHaveLength(2);
			expect(requests[1]?.headers.get("last-event-id"), label).toBe("2");
		}
	});
});

// NT-U-41 (adapter), (phase 2b): a `retry:` value between 30 s
// and 60 s takes effect; the clamp stays 250 ms–60 s.
describe("retry field above the backoff cap", () => {
	it("uses a 45 s retry value as the base, beyond the 30 s cap", async () => {
		const first = scriptedBody();
		const second = scriptedBody();
		const { conn, requests } = setup({}, [ok(first), ok(second)]);
		subscribe(conn);
		await flush(20);
		first.write("retry: 45000\ndata: a\n\n");
		first.end();
		await flush(20);
		// Full jitter with random() = 0.5 under a 45 s ceiling gives 22.5 s.
		await vi.advanceTimersByTimeAsync(22_499);
		expect(requests).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		await flush(20);
		expect(requests).toHaveLength(2);
	});
});
