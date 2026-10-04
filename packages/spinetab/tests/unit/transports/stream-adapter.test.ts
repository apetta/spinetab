import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isSpinetabError, SpinetabError } from "../../../src/core/errors.ts";
import { isUniqueKey } from "../../../src/core/identity.ts";
import { stream } from "../../../src/transports/stream/index.ts";
import {
	lineFramer,
	ndjsonParser,
	type Parser,
	type StreamConnectionSpec,
	streamAdapter,
} from "../../../src/transports/stream/runtime.ts";
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

// Stream adapter lifecycle through the adapter contract.

const URL_BASE = "https://api.test/stream";

function ndjsonResponse(body: ScriptedBody, init: ResponseInit = {}) {
	return (request: ScriptedRequest) =>
		eventStream(
			body,
			{ headers: { "content-type": "application/x-ndjson" }, ...init },
			request.init.signal ?? undefined,
		);
}

function statusResponse(status: number, headers: Record<string, string> = {}) {
	return () =>
		new Response(status === 204 ? null : "error body", { status, headers });
}

function setup(
	spec: Partial<StreamConnectionSpec>,
	responders: Parameters<typeof scriptedFetch>[0],
	parsers: Record<string, Parser<unknown>> = { ndjson: ndjsonParser() },
) {
	const scripted = scriptedFetch(responders);
	vi.stubGlobal("fetch", scripted.fetch);
	const adapter = streamAdapter({ parsers });
	const connection: StreamConnectionSpec = {
		url: URL_BASE,
		parser: "ndjson",
		...spec,
	};
	adapter.validateConnection?.(connection);
	const fake = fakeContext();
	const conn = adapter.connect(connection, fake.ctx);
	const record = recordingSink();
	const repeatable = connection.repeatable === true;
	const sub = conn.subscribe({}, record.sink, { key: "s", repeatable });
	return { adapter, conn, fake, record, sub, requests: scripted.requests };
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	vi.spyOn(Math, "random").mockReturnValue(0.5);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("configuration", () => {
	it("validates options with paths in both realms", () => {
		const adapter = streamAdapter({
			parsers: { ndjson: ndjsonParser() },
		});
		const attempt = (spec: unknown) => {
			try {
				adapter.validateConnection?.(spec);
			} catch (error) {
				return error as { code: string; detail?: { path?: string } };
			}
			return undefined;
		};
		expect(attempt({ url: URL_BASE, parser: "csv" })?.detail?.path).toBe(
			"connection.parser",
		);
		expect(
			attempt({ url: URL_BASE, parser: "ndjson", retry: 3 })?.detail?.path,
		).toBe("connection.retry");
		expect(
			attempt({ url: URL_BASE, parser: "ndjson", body: "x" })?.detail?.path,
		).toBe("connection.body");
		expect(attempt({ url: "/relative", parser: "ndjson" })?.code).toBe(
			"invalid-endpoint",
		);
		expect(
			attempt({ url: "https://u:p@api.test/", parser: "ndjson" })?.code,
		).toBe("invalid-endpoint");
		expect(
			attempt({ url: URL_BASE, parser: "ndjson", heartbeat: {} })?.detail?.path,
		).toBe("connection.heartbeat.expectInboundWithinMs");
		expect(() => streamAdapter({ parsers: { x: 1 as never } })).toThrowError(
			expect.objectContaining({ code: "unsupported-option" }),
		);
	});

	it("page builder is plain data, repeatable only when declared, relative URLs kept", () => {
		const post = stream({
			url: "/generate",
			method: "POST",
			body: "{}",
			parser: "ndjson",
		});
		const request = post.subscription();
		expect(request).toEqual({
			adapter: "stream",
			connection: {
				url: "/generate",
				method: "POST",
				body: "{}",
				parser: "ndjson",
			},
			subscription: {},
			repeatable: false,
		});
		expect(structuredClone(request)).toEqual(request);
		expect(
			stream({ url: "/read", parser: "ndjson" }).subscription().repeatable,
		).toBe(false);
		expect(
			stream({
				url: "/read",
				parser: "ndjson",
				repeatable: true,
			}).subscription().repeatable,
		).toBe(true);
		expect(() =>
			stream({
				url: "/x",
				parser: "ndjson",
				headers: { Authorization: "Bearer t" },
			}),
		).toThrowError(expect.objectContaining({ code: "unsupported-option" }));
	});

	it("never shares non-repeatable work: every key is unique", () => {
		const adapter = streamAdapter({
			parsers: { ndjson: ndjsonParser() },
		});
		const post: StreamConnectionSpec = {
			url: URL_BASE,
			method: "POST",
			body: "{}",
			parser: "ndjson",
		};
		const a = adapter.connectionKey?.(post) as string;
		const b = adapter.connectionKey?.(post) as string;
		expect(isUniqueKey(a)).toBe(true);
		expect(a).not.toBe(b);
		const read: StreamConnectionSpec = {
			url: URL_BASE,
			parser: "ndjson",
			repeatable: true,
		};
		expect(adapter.connectionKey?.(read)).toBe(
			adapter.connectionKey?.({ ...read }),
		);
	});
});

describe("lifecycle", () => {
	it("creates one parser per response and calls end() once on clean completion", async () => {
		const calls: string[] = [];
		const counting: Parser<unknown> = (context) => {
			calls.push("create");
			const inner = lineFramer()(context);
			return {
				push: (chunk) => inner.push(chunk),
				end: () => {
					calls.push("end");
					return inner.end();
				},
				pendingBytes: () => inner.pendingBytes?.() ?? 0,
			};
		};
		const body = scriptedBody();
		const { record, requests, fake } = setup(
			{ parser: "lines", repeatable: true },
			[ndjsonResponse(body)],
			{ lines: counting },
		);
		await flush();
		body.write("one\ntw");
		body.write("o\nthree");
		body.end();
		await flush(20);
		expect(record.events).toEqual(["one", "two", "three"]);
		expect(record.completed).toBe(1);
		expect(calls).toEqual(["create", "end"]);
		// A clean end completes; repeatable streams do not restart.
		await vi.advanceTimersByTimeAsync(60_000);
		expect(requests).toHaveLength(1);
		expect(fake.states()).toEqual(["connecting", "connected", "inactive"]);
	});

	it("interrupted POST under the default policy settles interrupted and is never restarted", async () => {
		const discarded: string[] = [];
		const body = scriptedBody();
		const { record, requests } = setup(
			{ method: "POST", body: '{"prompt":"x"}' },
			[ndjsonResponse(body)],
			{
				ndjson: (context) => {
					const inner = ndjsonParser()(context);
					return {
						...inner,
						end: () => {
							discarded.push("end called");
							return inner.end();
						},
					};
				},
			},
		);
		await flush();
		expect(requests[0]?.init.method).toBe("POST");
		expect(requests[0]?.init.body).toBe('{"prompt":"x"}');
		body.write('{"n":1}\n{"n":');
		await flush();
		body.fail();
		await flush(20);
		expect(record.events).toEqual([{ n: 1 }]);
		expect(record.errors.map((error) => error.code)).toEqual(["interrupted"]);
		expect(discarded).toEqual([]);
		await vi.advanceTimersByTimeAsync(300_000);
		expect(requests).toHaveLength(1);
	});

	it("explicitly repeatable read restarts with backoff and reports reconnected", async () => {
		const first = scriptedBody();
		const second = scriptedBody();
		const { record, requests, fake } = setup({ repeatable: true }, [
			ndjsonResponse(first),
			ndjsonResponse(second),
		]);
		await flush();
		first.write('{"n":1}\n{"n":2');
		await flush();
		first.fail();
		await flush(20);
		expect(fake.last()).toMatchObject({
			state: "reconnecting",
			reason: "network",
			attempt: 1,
		});
		await vi.advanceTimersByTimeAsync(1_000);
		await flush(20);
		expect(requests).toHaveLength(2);
		second.write('{"n":3}\n');
		await flush(20);
		// The partial frame from the first response is never delivered.
		expect(record.events).toEqual([{ n: 1 }, { n: 3 }]);
		expect(record.continuity).toEqual([
			// The early notice at detection, then the outcome.
			{ reason: "reconnected" },
			{ reason: "reconnected" },
		]);
		expect(record.log).toEqual([
			"next",
			"continuity:reconnected",
			"continuity:reconnected",
			"next",
		]);
	});

	it("aborts the request on the last unsubscribe and delivers nothing after it", async () => {
		const body = scriptedBody();
		const { record, requests, sub, fake } = setup({ repeatable: true }, [
			ndjsonResponse(body),
		]);
		await flush();
		body.write('{"n":1}\n');
		await flush(20);
		sub.unsubscribe();
		expect(requests[0]?.aborted()).toBe(true);
		expect(() => body.write('{"n":2}\n')).toThrow();
		await flush(20);
		expect(record.events).toEqual([{ n: 1 }]);
		expect(record.errors).toEqual([]);
		expect(fake.last()).toEqual({ state: "inactive", reason: "idle" });
		sub.unsubscribe();
	});

	it("keeps a shared repeatable stream running when one of two subscriptions leaves", async () => {
		const body = scriptedBody();
		const { conn, record, requests, sub } = setup({ repeatable: true }, [
			ndjsonResponse(body),
		]);
		const other = recordingSink();
		conn.subscribe({}, other.sink, { key: "s", repeatable: true });
		await flush();
		sub.unsubscribe();
		body.write('{"n":1}\n');
		await flush(20);
		expect(requests[0]?.aborted()).toBe(false);
		expect(other.events).toEqual([{ n: 1 }]);
		expect(record.events).toEqual([]);
	});
});

describe("bounds and malformed input", () => {
	it("aborts an oversized partial frame with frame-too-large and never retries automatically", async () => {
		const body = scriptedBody();
		const scripted = scriptedFetch([ndjsonResponse(body)]);
		vi.stubGlobal("fetch", scripted.fetch);
		const adapter = streamAdapter({
			parsers: { ndjson: ndjsonParser() },
		});
		const fake = fakeContext({ limits: { maxFrameBytes: 64 } });
		const conn = adapter.connect(
			{ url: URL_BASE, parser: "ndjson", repeatable: true },
			fake.ctx,
		);
		const record = recordingSink();
		conn.subscribe({}, record.sink, { key: "s", repeatable: true });
		await flush();
		body.write(`{"big":"${"x".repeat(100)}`);
		await flush(20);
		expect(record.errors.map((error) => error.code)).toEqual([
			"frame-too-large",
		]);
		expect(fake.last()).toMatchObject({
			state: "failed",
			code: "frame-too-large",
		});
		expect(scripted.requests[0]?.aborted()).toBe(true);
		await vi.advanceTimersByTimeAsync(300_000);
		expect(scripted.requests).toHaveLength(1);
	});

	it("bounds custom parsers without pendingBytes by bytes since the last frame", async () => {
		const body = scriptedBody();
		const scripted = scriptedFetch([ndjsonResponse(body)]);
		vi.stubGlobal("fetch", scripted.fetch);
		const hoarding: Parser<unknown> = () => ({ push: () => [], end: () => [] });
		const adapter = streamAdapter({ parsers: { hoard: hoarding } });
		const fake = fakeContext({ limits: { maxFrameBytes: 16 } });
		const conn = adapter.connect({ url: URL_BASE, parser: "hoard" }, fake.ctx);
		const record = recordingSink();
		conn.subscribe({}, record.sink, { key: "s", repeatable: false });
		await flush();
		body.write("0123456789");
		await flush(10);
		expect(record.errors).toEqual([]);
		body.write("0123456789");
		await flush(20);
		expect(record.errors.map((error) => error.code)).toEqual([
			"frame-too-large",
		]);
	});

	it("fails the response on malformed input by default", async () => {
		const body = scriptedBody();
		const { record, requests, fake } = setup({ repeatable: true }, [
			ndjsonResponse(body),
		]);
		await flush();
		body.write('{"n":1}\n{secret}\n{"n":3}\n');
		await flush(20);
		expect(record.events).toEqual([{ n: 1 }]);
		expect(record.errors).toHaveLength(1);
		expect(record.errors[0]?.code).toBe("malformed-frame");
		expect(JSON.stringify(record.errors)).not.toContain("secret");
		expect(fake.last()).toMatchObject({
			state: "failed",
			code: "malformed-frame",
		});
		await vi.advanceTimersByTimeAsync(300_000);
		expect(requests).toHaveLength(1);
	});

	it("skips malformed frames with a gap under the skip policy", async () => {
		const body = scriptedBody();
		const { record, fake } = setup({ repeatable: true, malformed: "skip" }, [
			ndjsonResponse(body),
		]);
		await flush();
		body.write('{"n":1}\n{bad}\n{"n":3}\n');
		body.end();
		await flush(20);
		expect(record.events).toEqual([{ n: 1 }, { n: 3 }]);
		expect(record.continuity).toEqual([{ reason: "decode-error" }]);
		expect(record.completed).toBe(1);
		expect(
			fake.diagnostics.some((event) => event.type === "malformed-frame"),
		).toBe(true);
	});

	it("treats a throwing custom parser as malformed", async () => {
		const body = scriptedBody();
		const { record } = setup({}, [ndjsonResponse(body)], {
			ndjson: () => ({
				push: () => {
					throw new Error("boom");
				},
				end: () => [],
			}),
		});
		await flush();
		body.write("x");
		await flush(20);
		expect(record.errors.map((error) => error.code)).toEqual([
			"malformed-frame",
		]);
	});
});

describe("HTTP outcomes and credentials", () => {
	it("backs off on 5xx, honouring Retry-After, then connects", async () => {
		const body = scriptedBody();
		const { requests, fake } = setup({ repeatable: true }, [
			statusResponse(503, { "retry-after": "7" }),
			ndjsonResponse(body),
		]);
		await flush(20);
		expect(fake.last()).toMatchObject({
			state: "reconnecting",
			code: 503,
			attempt: 1,
		});
		await vi.advanceTimersByTimeAsync(6_999);
		expect(requests).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		await flush(20);
		expect(requests).toHaveLength(2);
		expect(fake.last()).toEqual({ state: "connected" });
	});

	it("fails permanently on 404 without retrying; retry() starts a fresh attempt", async () => {
		const body = scriptedBody();
		const { conn, requests, fake } = setup({ repeatable: true }, [
			statusResponse(404),
			ndjsonResponse(body),
		]);
		await flush(20);
		expect(fake.last()).toEqual({
			state: "failed",
			reason: "permanent-error",
			code: 404,
		});
		await vi.advanceTimersByTimeAsync(300_000);
		expect(requests).toHaveLength(1);
		conn.retry?.();
		await flush(20);
		expect(requests).toHaveLength(2);
		expect(fake.last()).toEqual({ state: "connected" });
	});

	it("completes on 204 without a body", async () => {
		const { record, requests } = setup({ repeatable: true }, [
			statusResponse(204),
		]);
		await flush(20);
		expect(record.completed).toBe(1);
		expect(requests).toHaveLength(1);
	});

	it("reports auth-blocked with no request when no credential source exists", async () => {
		const { requests, fake } = setup(
			{ repeatable: true, authHeaders: true },
			[],
		);
		await flush(20);
		expect(requests).toHaveLength(0);
		expect(fake.last()).toEqual({
			state: "auth-blocked",
			reason: "no-credential-source",
		});
	});

	it("blocks on a failed provider exactly as on a timeout and sends no request", async () => {
		for (const code of ["credentials-failed", "credentials-timeout"] as const) {
			const scripted = scriptedFetch([]);
			vi.stubGlobal("fetch", scripted.fetch);
			const fake = fakeContext();
			fake.setCredentials(() => Promise.reject(new SpinetabError(code, code)));
			const conn = streamAdapter({
				parsers: { ndjson: ndjsonParser() },
			}).connect(
				{
					url: URL_BASE,
					parser: "ndjson",
					repeatable: true,
					authHeaders: true,
				},
				fake.ctx,
			);
			conn.subscribe({}, recordingSink().sink, { key: "s", repeatable: true });
			await flush(20);
			expect(scripted.requests, code).toHaveLength(0);
			expect(fake.last(), code).toEqual({
				state: "auth-blocked",
				reason: "credentials-missing",
			});
			await vi.advanceTimersByTimeAsync(300_000);
			expect(scripted.requests, code).toHaveLength(0);
			conn.dispose();
		}
	});

	it("merges credentials.headers, rejects the revision on 401 and waits for rotation", async () => {
		const body = scriptedBody();
		const scripted = scriptedFetch([statusResponse(401), ndjsonResponse(body)]);
		vi.stubGlobal("fetch", scripted.fetch);
		const adapter = streamAdapter({
			parsers: { ndjson: ndjsonParser() },
		});
		const fake = fakeContext();
		let revision = 1;
		fake.setCredentials(async () => ({
			headers: { Authorization: `Bearer valid-${revision}` },
		}));
		const conn = adapter.connect(
			{
				url: URL_BASE,
				parser: "ndjson",
				repeatable: true,
				authHeaders: true,
				headers: { "X-Feed": "a" },
			},
			fake.ctx,
		);
		conn.subscribe({}, recordingSink().sink, { key: "s", repeatable: true });
		await flush(20);
		expect(scripted.requests[0]?.headers.get("authorization")).toBe(
			"Bearer valid-1",
		);
		expect(scripted.requests[0]?.headers.get("x-feed")).toBe("a");
		expect(scripted.requests[0]?.url).toBe(URL_BASE);
		expect(fake.rejections()).toBe(1);
		expect(fake.last()).toEqual({
			state: "auth-blocked",
			reason: "credentials-rejected",
			code: "http:401",
		});
		// Never spin on rejected credentials.
		await vi.advanceTimersByTimeAsync(300_000);
		expect(scripted.requests).toHaveLength(1);
		revision = 2;
		conn.rotate?.();
		await flush(20);
		expect(scripted.requests).toHaveLength(2);
		expect(scripted.requests[1]?.headers.get("authorization")).toBe(
			"Bearer valid-2",
		);
		expect(fake.credentialCalls).toEqual(["connect", "rotated"]);
	});

	it("settles a non-repeatable request's 401 as a terminal auth-blocked error", async () => {
		const { record } = setup({ method: "POST", body: "{}" }, [
			statusResponse(401),
		]);
		await flush(20);
		expect(record.errors.map((error) => error.code)).toEqual(["auth-blocked"]);
	});

	it("settles a non-repeatable request's 403 as a terminal upstream-error (forbidden)", async () => {
		const { record, fake } = setup({ method: "POST", body: "{}" }, [
			statusResponse(403),
		]);
		await flush(20);
		expect(record.errors.map((error) => error.code)).toEqual([
			"upstream-error",
		]);
		expect(fake.last()).toMatchObject({ state: "failed", code: "forbidden" });
		expect(fake.rejections()).toBe(0);
	});
});

describe("liveness", () => {
	it("reconnects a silent repeatable stream once per detection", async () => {
		const first = scriptedBody();
		const second = scriptedBody();
		const { record, requests, fake } = setup(
			{ repeatable: true, heartbeat: { expectInboundWithinMs: 5_000 } },
			[ndjsonResponse(first), ndjsonResponse(second)],
		);
		await flush(20);
		first.write('{"n":1}\n');
		await flush(20);
		await vi.advanceTimersByTimeAsync(4_999);
		expect(requests).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(fake.last()).toMatchObject({
			state: "reconnecting",
			reason: "heartbeat-timeout",
		});
		expect(
			fake.diagnostics.some((event) => event.type === "heartbeat-missed"),
		).toBe(true);
		await vi.advanceTimersByTimeAsync(1_000);
		await flush(20);
		expect(requests).toHaveLength(2);
		expect(requests[0]?.aborted()).toBe(true);
		expect(record.continuity).toEqual([
			// The early notice at detection, then the outcome.
			{ reason: "reconnected" },
			{ reason: "reconnected" },
		]);
	});

	it("settles a silent non-repeatable stream as interrupted, never restarting it", async () => {
		const body = scriptedBody();
		const { record, requests } = setup(
			{
				method: "POST",
				body: "{}",
				heartbeat: { expectInboundWithinMs: 2_000 },
			},
			[ndjsonResponse(body)],
		);
		await flush(20);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(record.errors.map((error) => error.code)).toEqual(["interrupted"]);
		await vi.advanceTimersByTimeAsync(300_000);
		expect(requests).toHaveLength(1);
	});

	it("does not deliver heartbeat frames but counts them as inbound", async () => {
		const body = scriptedBody();
		const { record } = setup(
			{ repeatable: true, heartbeat: { expectInboundWithinMs: 3_000 } },
			[ndjsonResponse(body)],
			{
				ndjson: ndjsonParser({
					heartbeat: (value) =>
						typeof value === "object" &&
						value !== null &&
						!Array.isArray(value) &&
						value.type === "ping",
				}),
			},
		);
		await flush(20);
		for (let index = 0; index < 5; index += 1) {
			await vi.advanceTimersByTimeAsync(2_000);
			body.write('{"type":"ping"}\n');
			await flush(10);
		}
		body.write('{"n":1}\n');
		await flush(10);
		expect(record.events).toEqual([{ n: 1 }]);
		expect(record.continuity).toEqual([]);
	});

	it("reopens repeatable work on a coordinated return check; ignores non-repeatable", async () => {
		const first = scriptedBody();
		const second = scriptedBody();
		const repeatable = setup({ repeatable: true }, [
			ndjsonResponse(first),
			ndjsonResponse(second),
		]);
		await flush(20);
		repeatable.conn.probe?.();
		await flush(20);
		expect(repeatable.requests).toHaveLength(2);
		expect(repeatable.requests[0]?.aborted()).toBe(true);
		expect(repeatable.record.continuity).toEqual([{ reason: "reopened" }]);

		const body = scriptedBody();
		const once = setup({ method: "POST", body: "{}" }, [ndjsonResponse(body)]);
		await flush(20);
		once.conn.probe?.();
		await flush(20);
		expect(once.requests).toHaveLength(1);
		expect(once.record.errors).toEqual([]);
	});
});

describe("disposal", () => {
	it("dispose aborts and silences everything", async () => {
		const body = scriptedBody();
		const { conn, record, requests } = setup({ repeatable: true }, [
			ndjsonResponse(body),
		]);
		await flush(20);
		conn.dispose();
		expect(requests[0]?.aborted()).toBe(true);
		await flush(20);
		expect(record.errors).toEqual([]);
		expect(isSpinetabError(new Error(), "interrupted")).toBe(false);
	});
});

// Completed frames precede a size failure regardless of chunk boundaries; request-construction errors must also settle the connection.
describe("frames completed before frame-too-large", () => {
	function open(parsers: Record<string, Parser<unknown>>, parser: string) {
		const body = scriptedBody();
		const scripted = scriptedFetch([ndjsonResponse(body)]);
		vi.stubGlobal("fetch", scripted.fetch);
		const adapter = streamAdapter({ parsers });
		const fake = fakeContext({ limits: { maxFrameBytes: 64 } });
		const conn = adapter.connect(
			{ url: URL_BASE, parser, repeatable: true },
			fake.ctx,
		);
		const record = recordingSink();
		conn.subscribe({}, record.sink, { key: "s", repeatable: true });
		return { body, record, fake };
	}
	const tail = "x".repeat(100);

	it("delivers completed lines before failing, whole or split", async () => {
		for (const chunks of [[`a\nb\n${tail}`], ["a\nb\n", tail]]) {
			const { body, record, fake } = open({ lines: lineFramer() }, "lines");
			await flush();
			for (const chunk of chunks) body.write(chunk);
			await flush(20);
			const label = `${chunks.length} chunk(s)`;
			expect(record.log, label).toEqual([
				"next",
				"next",
				"error:frame-too-large",
			]);
			expect(record.events, label).toEqual(["a", "b"]);
			expect(fake.last(), label).toMatchObject({
				state: "failed",
				code: "frame-too-large",
			});
		}
	});

	it("delivers a custom parser's completed frames before its pendingBytes bound fails", async () => {
		// Completes a frame at each "|" and reports what it still holds.
		const piped: Parser<unknown> = () => {
			let held = "";
			return {
				push(chunk) {
					held += String(chunk);
					const parts = held.split("|");
					held = parts.pop() ?? "";
					return parts;
				},
				end: () => [],
				pendingBytes: () => held.length,
			};
		};
		for (const chunks of [[`a|b|${tail}`], ["a|b|", tail]]) {
			const { body, record } = open({ piped }, "piped");
			await flush();
			for (const chunk of chunks) body.write(chunk);
			await flush(20);
			expect(record.log, `${chunks.length} chunk(s)`).toEqual([
				"next",
				"next",
				"error:frame-too-large",
			]);
		}
	});

	it("fails a stream whose request cannot be built instead of hanging in connecting", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			const scripted = scriptedFetch([]);
			vi.stubGlobal("fetch", scripted.fetch);
			const fake = fakeContext();
			// Connected without validateConnection, which refuses this spec.
			const conn = streamAdapter().connect(
				{ url: URL_BASE, repeatable: true, headers: { "x-label": "日本" } },
				fake.ctx,
			);
			const record = recordingSink();
			conn.subscribe({}, record.sink, { key: "s", repeatable: true });
			await flush(20);
			await new Promise((resolve) => setImmediate(resolve));
			expect(scripted.requests).toHaveLength(0);
			expect(fake.states()).toEqual(["connecting", "failed"]);
			expect(record.errors.map((error) => error.code)).toEqual([
				"unsupported-option",
			]);
			expect(JSON.stringify(record.errors)).not.toContain("日本");
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
});
