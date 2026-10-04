import { describe, expect, it, vi } from "vitest";
import { isSpinetabError, SpinetabError } from "../../../src/core/errors.ts";
import { normaliseHttpRead } from "../../../src/core/http.ts";
import type { SerialisedError } from "../../../src/core/types.ts";
import {
	createBackoff,
	NATIVE_BACKOFF,
} from "../../../src/transports/shared/backoff.ts";
import {
	classifyStatus,
	credentialHeaders,
	isEventStream,
	mergeHeaders,
	obtainCredentials,
	parseRetryAfter,
	RETRY_AFTER_CAP_MS,
} from "../../../src/transports/shared/http.ts";
import { createHttpStream } from "../../../src/transports/shared/http-stream.ts";
import { optionalHeaders } from "../../../src/transports/shared/options.ts";
import {
	exceedsUtf8,
	utf8Length,
} from "../../../src/transports/shared/utf8.ts";
import { sse } from "../../../src/transports/sse/index.ts";
import { sseAdapter } from "../../../src/transports/sse/runtime.ts";
import { stream } from "../../../src/transports/stream/index.ts";
import { streamAdapter } from "../../../src/transports/stream/runtime.ts";
import { fakeContext, flush } from "./helpers.ts";
import { harnessAdapters } from "./topic-protocol.ts";

// NT-U-01, NT-U-04, NT-U-05: option validation, the native backoff series and
// HTTP classification.

describe("native backoff", () => {
	it("uses full jitter under an exponential ceiling capped at 30 s", () => {
		const max = createBackoff({}, () => 0.999999);
		const ceilings = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
		ceilings.forEach((ceiling, index) => {
			const step = max.fail(0);
			expect(step).toEqual({
				kind: "retry",
				attempt: index + 1,
				delayMs: ceiling - 1,
			});
		});
		const min = createBackoff({}, () => 0);
		expect(min.fail(0)).toEqual({ kind: "retry", attempt: 1, delayMs: 0 });
	});

	it("exhausts after 10 attempts", () => {
		const backoff = createBackoff({}, () => 0.5);
		for (let attempt = 1; attempt <= NATIVE_BACKOFF.maxAttempts; attempt += 1) {
			expect(backoff.fail(attempt).kind).toBe("retry");
		}
		expect(backoff.fail(11)).toEqual({
			kind: "exhausted",
			reason: "attempts-exhausted",
		});
	});

	it("exhausts after 5 minutes of executable time", () => {
		const backoff = createBackoff({}, () => 0.5);
		expect(backoff.fail(0).kind).toBe("retry");
		expect(backoff.fail(300_000)).toEqual({
			kind: "exhausted",
			reason: "time-limit",
		});
	});

	it("resets only after 10 s of healthy connection", () => {
		const backoff = createBackoff({}, () => 0.999999);
		backoff.fail(0);
		backoff.fail(1);
		backoff.connected(2);
		// Flapping: failed again after 5 s, so the series continues.
		expect(backoff.fail(5_002)).toMatchObject({ attempt: 3 });
		backoff.connected(6_000);
		expect(backoff.fail(16_000)).toMatchObject({ attempt: 1, delayMs: 999 });
	});

	it("honours a minimum delay (Retry-After) and a new base (SSE retry)", () => {
		const backoff = createBackoff({}, () => 0);
		expect(backoff.fail(0, 7_000)).toMatchObject({ delayMs: 7_000 });
		const based = createBackoff({}, () => 0.999999);
		based.setBaseMs(250);
		expect(based.fail(0)).toMatchObject({ delayMs: 249 });
	});
});

describe("HTTP classification", () => {
	it("classifies statuses before parsing", () => {
		expect(classifyStatus(200)).toEqual({ kind: "ok" });
		expect(classifyStatus(204)).toEqual({ kind: "ok" });
		expect(classifyStatus(401)).toEqual({ kind: "unauthorised" });
		expect(classifyStatus(403)).toEqual({ kind: "forbidden" });
		for (const status of [400, 404, 405, 410, 422]) {
			expect(classifyStatus(status)).toEqual({ kind: "permanent" });
		}
		for (const status of [408, 429, 500, 502, 503]) {
			expect(classifyStatus(status)).toEqual({ kind: "transient" });
		}
	});

	it("honours Retry-After seconds and dates, capped at 5 minutes", () => {
		const headers = new Headers({ "retry-after": "12" });
		expect(classifyStatus(503, headers)).toEqual({
			kind: "transient",
			retryAfterMs: 12_000,
		});
		expect(parseRetryAfter("100000")).toBe(RETRY_AFTER_CAP_MS);
		const now = Date.parse("2026-09-27T00:00:00Z");
		expect(parseRetryAfter("Sun, 27 Sep 2026 00:00:30 GMT", now)).toBe(30_000);
		expect(parseRetryAfter("soon")).toBeUndefined();
	});

	it("accepts text/event-stream with parameters only", () => {
		expect(isEventStream("text/event-stream")).toBe(true);
		expect(isEventStream("Text/Event-Stream; charset=utf-8")).toBe(true);
		expect(isEventStream("text/html")).toBe(false);
		expect(isEventStream(null)).toBe(false);
	});

	it("merges headers with later sources winning, case-insensitively", () => {
		const headers = mergeHeaders(
			{ "X-A": "1", accept: "x" },
			{ "x-a": "2" },
			undefined,
			{
				Accept: "text/event-stream",
			},
		);
		expect(headers.get("x-a")).toBe("2");
		expect(headers.get("accept")).toBe("text/event-stream");
	});
});

describe("credential outcomes", () => {
	it("maps a failed provider to credentials-missing, exactly as a timeout", async () => {
		const blocked = { kind: "blocked", reason: "credentials-missing" };
		const fake = fakeContext();
		for (const code of ["credentials-failed", "credentials-timeout"] as const) {
			fake.setCredentials(() => Promise.reject(new SpinetabError(code, code)));
			expect(
				await obtainCredentials(fake.ctx, "connect", "https://api.test/"),
				code,
			).toEqual(blocked);
			expect(
				await credentialHeaders(fake.ctx, true)("connect", "https://api.test/"),
				code,
			).toEqual(blocked);
		}
		// Only a scope with no provider at all is `no-credential-source`.
		fake.setCredentials(() =>
			Promise.reject(new SpinetabError("no-credential-source", "none")),
		);
		expect(
			await obtainCredentials(fake.ctx, "connect", "https://api.test/"),
		).toEqual({
			kind: "blocked",
			reason: "no-credential-source",
		});
	});
});

describe("option validation", () => {
	const headerError = (headers: unknown) => {
		try {
			optionalHeaders({ headers }, "headers", "connection");
		} catch (error) {
			return error;
		}
		return undefined;
	};

	it("rejects credential-bearing headers with the option path, never the value", () => {
		const error = headerError({ Authorization: "Bearer secret-token" });
		expect(isSpinetabError(error, "unsupported-option")).toBe(true);
		expect((error as Error).message).not.toContain("secret-token");
		expect((error as { detail: unknown }).detail).toEqual({
			path: "connection.headers.Authorization",
		});
		expect(
			isSpinetabError(headerError({ cookie: "a=b" }), "unsupported-option"),
		).toBe(true);
		expect(
			isSpinetabError(
				headerError({ "Last-Event-ID": "1" }),
				"unsupported-option",
			),
		).toBe(true);
	});

	it("rejects non-string values, invalid names and duplicates ignoring case", () => {
		expect(headerError({ "x-a": 1 })).toBeDefined();
		expect(headerError({ "bad name": "x" })).toBeDefined();
		expect(headerError({ "X-A": "1", "x-a": "2" })).toBeDefined();
		expect(headerError(["x"])).toBeDefined();
		expect(headerError({ "x-a": "1" })).toBeUndefined();
	});
});

describe("UTF-8 sizing", () => {
	it("counts encoded bytes exactly", () => {
		for (const text of ["", "abc", "é", "✓", "🌍", "a\ud800b"]) {
			expect(utf8Length(text)).toBe(new TextEncoder().encode(text).length);
		}
		expect(exceedsUtf8("🌍🌍", 7)).toBe(true);
		expect(exceedsUtf8("🌍🌍", 8)).toBe(false);
		expect(exceedsUtf8("a".repeat(9), 8)).toBe(true);
	});
});

describe("harness adapter definitions", () => {
	it("construct against the source runtimes and accept the specs the browser suite uses", () => {
		const [websocket, sse, stream] = harnessAdapters();
		expect([websocket?.kind, sse?.kind, stream?.kind]).toEqual([
			"websocket",
			"sse",
			"stream",
		]);
		for (const protocol of ["topics", "topics-probe", "topics-auth"]) {
			expect(() =>
				websocket?.validateConnection?.({
					url: "ws://127.0.0.1:4500/ws/topics",
					protocol,
				}),
			).not.toThrow();
		}
		expect(() =>
			sse?.validateConnection?.({
				url: "http://127.0.0.1:4500/sse/ticks",
				mode: "eventsource",
				decoder: "ticks",
				resume: { url: "path" },
				replay: "last-event-id",
			}),
		).not.toThrow();
		for (const parser of ["ndjson", "ndjson-heartbeat", "lines"]) {
			expect(() =>
				stream?.validateConnection?.({
					url: "http://127.0.0.1:4500/stream/ndjson",
					parser,
				}),
			).not.toThrow();
		}
	});
});

// NT-U-41, (phase 2b): an SSE `retry:` base above the 30 s cap
// lifts the cap to the base, so the 250 ms–60 s clamp takes effect.
describe("backoff base above the cap", () => {
	it("lifts the cap to a larger base and keeps 30 s for smaller ones", () => {
		const backoff = createBackoff({}, () => 0.999999);
		backoff.setBaseMs(45_000);
		expect(backoff.fail(0)).toEqual({
			kind: "retry",
			attempt: 1,
			delayMs: 44_999,
		});
		expect(backoff.fail(1)).toMatchObject({ attempt: 2, delayMs: 44_999 });
		backoff.setBaseMs(60_000);
		expect(backoff.fail(2)).toMatchObject({ attempt: 3, delayMs: 59_999 });
		// A base under the cap restores the series and its 30 s cap.
		backoff.reset();
		backoff.setBaseMs(1_000);
		const delays = [1, 2, 3, 4, 5, 6].map(() => {
			const step = backoff.fail(0);
			return step.kind === "retry" ? step.delayMs : undefined;
		});
		expect(delays).toEqual([999, 1_999, 3_999, 7_999, 15_999, 29_999]);
	});
});

// NT-U-42, (phase 2b): a request whose init cannot be built (a
// header fetch refuses) fails the connection with a fixed, value-free
// `unsupported-option` instead of an unhandled rejection that leaves the
// connection in `connecting` for ever.
describe("request building", () => {
	it("fails with unsupported-option when init() throws, sends nothing and never rejects unhandled", async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			const fake = fakeContext();
			const terminals: SerialisedError[] = [];
			const driver = createHttpStream({
				ctx: fake.ctx,
				repeatable: true,
				authHeaders: false,
				endOfBody: "reconnect",
				request: () => ({
					url: "https://api.test/sse",
					init: () => {
						throw new TypeError(
							'Headers.set: "日本" is an invalid header value.',
						);
					},
				}),
				accept: () => "ok",
				open: () => ({ push() {}, end() {} }),
				established() {},
				lost() {},
				interrupted() {},
				terminal: (error) => terminals.push(error),
				complete() {},
			});
			driver.start();
			await flush(20);
			await new Promise((resolve) => setImmediate(resolve));
			expect(fetchSpy).not.toHaveBeenCalled();
			expect(fake.states()).toEqual(["connecting", "failed"]);
			expect(fake.last()).toEqual({
				state: "failed",
				reason: "permanent-error",
				code: "unsupported-option",
			});
			expect(terminals).toEqual([
				{
					code: "unsupported-option",
					message:
						"The request could not be built from the connection's headers; nothing was sent.",
				},
			]);
			expect(JSON.stringify(terminals)).not.toContain("日本");
			expect(unhandled).toEqual([]);
			driver.dispose();
		} finally {
			process.off("unhandledRejection", onUnhandled);
			vi.unstubAllGlobals();
		}
	});
});

// NT-U-43, (phase 2b): header values follow the fetch
// header-value grammar (code units up to 0xFF; no NUL, CR or LF), in the
// builders, the worker validators (version skew) and for provider values.
describe("header value grammar", () => {
	const refused = [
		"日本",
		"\u{1F600}",
		"Ā",
		"a\rb",
		"a\nb",
		"a\r\nb",
		"a\u0000b",
	];
	const accepted = ["", "a", "é", "ÿ", "a b", "a\tb"];
	const headerError = (headers: unknown) => {
		try {
			optionalHeaders({ headers }, "headers", "connection");
		} catch (error) {
			return error;
		}
		return undefined;
	};

	it("refuses values fetch would reject, with the path and never the value", () => {
		for (const value of refused) {
			const error = headerError({ "x-label": value });
			expect(
				isSpinetabError(error, "unsupported-option"),
				JSON.stringify(value),
			).toBe(true);
			expect((error as { detail: unknown }).detail).toEqual({
				path: "connection.headers.x-label",
			});
			expect((error as Error).message).not.toContain(value);
		}
		for (const value of accepted) {
			expect(headerError({ "x-label": value }), JSON.stringify(value)).toBe(
				undefined,
			);
		}
	});

	it("refuses them in the sse() and stream() builders and both worker validators", () => {
		const cases: Array<[string, () => unknown]> = [
			[
				"sse()",
				() => sse("https://api.test/sse", { headers: { "x-label": "日本" } }),
			],
			[
				"stream()",
				() =>
					stream("https://api.test/ndjson", { headers: { "x-label": "日本" } }),
			],
			[
				"sseAdapter",
				() =>
					sseAdapter().validateConnection?.({
						url: "https://api.test/sse",
						mode: "fetch",
						headers: { "x-label": "a\r\nb" },
					}),
			],
			[
				"streamAdapter",
				() =>
					streamAdapter().validateConnection?.({
						url: "https://api.test/ndjson",
						headers: { "x-label": "a\u0000b" },
					}),
			],
		];
		for (const [name, run] of cases) {
			let caught: unknown;
			try {
				run();
			} catch (error) {
				caught = error;
			}
			expect(isSpinetabError(caught, "unsupported-option"), name).toBe(true);
			expect((caught as SpinetabError).detail, name).toEqual({
				path: "connection.headers.x-label",
			});
		}
	});

	it("keeps polling's normaliseHttpRead and optionalHeaders in parity", () => {
		for (const value of [...refused, ...accepted, "\ud800"]) {
			const viaOptions = headerError({ "x-a": value }) === undefined;
			let viaPolling = true;
			try {
				normaliseHttpRead(
					{ url: "https://api.test/poll", headers: { "x-a": value } },
					"polling",
					"polling",
				);
			} catch {
				viaPolling = false;
			}
			expect(viaPolling, JSON.stringify(value)).toBe(viaOptions);
		}
	});

	it("blocks provider values fetch would reject, with a value-free credentials-invalid diagnostic", async () => {
		for (const value of refused) {
			const fake = fakeContext();
			fake.setCredentials(async () => ({ headers: { "x-token": value } }));
			expect(
				await credentialHeaders(fake.ctx, true)("connect", "https://api.test/"),
				JSON.stringify(value),
			).toEqual({ kind: "blocked", reason: "credentials-missing" });
			expect(fake.diagnostics.map((event) => event.type)).toEqual([
				"credentials-invalid",
			]);
			expect(JSON.stringify(fake.diagnostics)).not.toContain(
				JSON.stringify(value).slice(1, -1),
			);
		}
		const fake = fakeContext();
		fake.setCredentials(async () => ({ headers: { "x-token": "é 1\tb" } }));
		expect(
			await credentialHeaders(fake.ctx, true)("connect", "https://api.test/"),
		).toMatchObject({ kind: "ok", headers: { "x-token": "é 1\tb" } });
		expect(fake.diagnostics).toEqual([]);
	});
});
