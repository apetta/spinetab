import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	AdapterSubscription,
	ConnectionContext,
	SubscriptionSink,
} from "../../../src/core/adapter.ts";
import { isSpinetabError, SpinetabError } from "../../../src/core/errors.ts";
import { DEFAULT_LIMITS } from "../../../src/core/limits.ts";
import type {
	ConnectionStatus,
	Credentials,
	Json,
} from "../../../src/core/types.ts";
import { pollEvery, polling } from "../../../src/transports/polling/index.ts";
import {
	type PollingDecoder,
	pollingAdapter,
} from "../../../src/transports/polling/runtime.ts";

// schedule logic, deterministic (fake timers, scripted
// fetch). Real HTTP behaviour is covered in tests/integration/transports.

interface Call {
	url: string;
	init: RequestInit;
	respond(
		status: number,
		body?: unknown,
		headers?: Record<string, string>,
	): void;
	fail(error: Error): void;
	/** Resolve with a prepared response (a 204 cannot carry a body). */
	respondWith(response: Response): void;
	aborted: boolean;
}

function scriptedFetch() {
	const calls: Call[] = [];
	const fetchImpl = vi.fn(
		(url: string | URL | Request, init: RequestInit = {}) => {
			return new Promise<Response>((resolve, reject) => {
				const call: Call = {
					url: String(url),
					init,
					aborted: false,
					respond: (status, body = { ok: true }, headers = {}) =>
						resolve(
							new Response(
								typeof body === "string" ? body : JSON.stringify(body),
								{
									status,
									headers: { "content-type": "application/json", ...headers },
								},
							),
						),
					fail: (error) => reject(error),
					respondWith: (response) => resolve(response),
				};
				init.signal?.addEventListener("abort", () => {
					call.aborted = true;
					reject(
						init.signal?.reason ?? new DOMException("aborted", "AbortError"),
					);
				});
				calls.push(call);
			});
		},
	) as unknown as typeof fetch;
	return {
		calls,
		fetchImpl,
		open: () => calls.filter((call) => !call.aborted && !settled.has(call)),
	};
}
const settled = new WeakSet<Call>();

function context(credentials?: () => Promise<Credentials>) {
	const statuses: Array<Omit<ConnectionStatus, "since">> = [];
	const controller = new AbortController();
	const ctx: ConnectionContext = {
		scope: "",
		key: "k",
		limits: {
			...DEFAULT_LIMITS,
			maxMessageBytes: 4_096,
			maxPendingBytesPerConsumer: 8_192,
		},
		signal: controller.signal,
		credentials: vi.fn(
			credentials ??
				(async () => {
					throw new SpinetabError("no-credential-source", "none");
				}),
		),
		rejectCredentials: vi.fn(),
		setStatus: (status) => statuses.push(status),
		diagnostic: vi.fn(),
		now: () => Date.now(),
	};
	return { ctx, statuses, controller };
}

function setup(
	options: {
		credentials?: () => Promise<Credentials>;
		spec?: Record<string, unknown>;
		decoders?: Record<string, PollingDecoder>;
	} = {},
) {
	const script = scriptedFetch();
	const adapter = pollingAdapter({
		fetch: script.fetchImpl,
		...(options.decoders ? { decoders: options.decoders } : {}),
	});
	const { ctx, statuses, controller } = context(options.credentials);
	const spec = polling({
		url: "https://api.test/poll/value?id=u",
		...options.spec,
	}).connection;
	const connection = adapter.connect(spec, ctx);
	const delivered: Array<{ value: unknown; consumers?: string[] }> = [];
	const continuity: string[] = [];
	const sink: SubscriptionSink<unknown> = {
		next: (value, meta) =>
			delivered.push({
				value,
				...(meta?.consumers ? { consumers: [...meta.consumers] } : {}),
			}),
		error: vi.fn(),
		complete: vi.fn(),
		continuity: (reason) => continuity.push(reason),
		started: vi.fn(),
	};
	const handle = connection.subscribe({}, sink, {
		key: "poll",
		repeatable: true,
	}) as Required<AdapterSubscription<Json>>;
	const join = (
		id: string,
		intervalMs: number,
		extra: Record<string, unknown> = {},
		visible = true,
	) => handle.consumerAdded(id, { intervalMs, ...extra } as Json, { visible });
	return {
		...script,
		adapter,
		ctx,
		statuses,
		controller,
		connection,
		handle,
		delivered,
		continuity,
		join,
	};
}

async function respond(
	call: Call | undefined,
	status = 200,
	body: unknown = { n: 1 },
	headers: Record<string, string> = {},
) {
	if (!call) throw new Error("no fetch call");
	settled.add(call);
	call.respond(status, body, headers);
	await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	// The polled URL is on the worker's origin, so auto mode merges.
	vi.stubGlobal("location", { origin: "https://api.test" });
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("schedule", () => {
	it("reads immediately for the first consumer and every interval after completion (fixed delay)", async () => {
		const { calls, join, delivered } = setup();
		join("a", 2_000);
		await vi.advanceTimersByTimeAsync(0);
		expect(calls).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(500);
		await respond(calls[0], 200, { n: 1 });
		expect(delivered).toEqual([{ value: { n: 1 }, consumers: ["a"] }]);
		await vi.advanceTimersByTimeAsync(1_999);
		expect(calls).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(calls).toHaveLength(2);
	});

	it("never overlaps reads: a slow response delays the next read to completion + interval", async () => {
		const { calls, join } = setup();
		join("a", 1_000);
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(calls).toHaveLength(1);
		await respond(calls[0]);
		await vi.advanceTimersByTimeAsync(999);
		expect(calls).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(calls).toHaveLength(2);
	});

	it("uses the shortest eligible interval and recomputes on leave, hide and update", async () => {
		const { calls, join, handle } = setup();
		join("slow", 5_000);
		join("fast", 2_000);
		join("hidden", 1_000, {}, false);
		join("gated", 1_000, { eligible: false });
		await vi.advanceTimersByTimeAsync(0);
		await respond(calls[0]);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(calls).toHaveLength(2);
		await respond(calls[1]);
		handle.consumerRemoved("fast");
		await vi.advanceTimersByTimeAsync(4_999);
		expect(calls).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(1);
		expect(calls).toHaveLength(3);
		await respond(calls[2]);
		handle.consumerUpdated("slow", { intervalMs: 1_500 });
		await vi.advanceTimersByTimeAsync(1_500);
		expect(calls).toHaveLength(4);
	});

	it("delivers each result to every consumer eligible at completion, including longer intervals", async () => {
		const { calls, join, handle, delivered } = setup();
		join("a", 1_000);
		join("b", 60_000);
		join("c", 1_000);
		await vi.advanceTimersByTimeAsync(0);
		handle.consumerVisibility("c", false);
		await respond(calls[0], 200, { n: 7 });
		expect(delivered).toEqual([{ value: { n: 7 }, consumers: ["a", "b"] }]);
	});

	it("pauses with nobody eligible, aborting the in-flight read and making zero requests", async () => {
		const { calls, join, handle, delivered } = setup();
		join("a", 1_000);
		await vi.advanceTimersByTimeAsync(0);
		handle.consumerVisibility("a", false);
		expect(calls[0]?.aborted).toBe(true);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(calls).toHaveLength(1);
		expect(delivered).toEqual([]);
	});

	it("makes exactly one catch-up read on return and reports skipped intervals", async () => {
		const { calls, join, handle, statuses } = setup();
		join("a", 1_000);
		await vi.advanceTimersByTimeAsync(0);
		await respond(calls[0]);
		handle.consumerVisibility("a", false);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(calls).toHaveLength(1);
		handle.consumerVisibility("a", true);
		await vi.advanceTimersByTimeAsync(0);
		expect(calls).toHaveLength(2);
		await respond(calls[1]);
		expect(statuses.at(-1)).toMatchObject({
			state: "connected",
			skippedIntervals: 9,
		});
		await vi.advanceTimersByTimeAsync(999);
		expect(calls).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(1);
		expect(calls).toHaveLength(3);
	});

	it("keeps polling a hidden consumer that opted in with whileHidden", async () => {
		const { calls, join } = setup();
		join("a", 1_000, { whileHidden: true }, false);
		await vi.advanceTimersByTimeAsync(0);
		expect(calls).toHaveLength(1);
	});

	it("reads every 5 000 ms for a consumer without options and keeps the hidden-tab pause", async () => {
		const { calls, handle } = setup();
		handle.consumerAdded("a", undefined, { visible: true });
		await vi.advanceTimersByTimeAsync(0);
		expect(calls).toHaveLength(1);
		await respond(calls[0]);
		await vi.advanceTimersByTimeAsync(4_999);
		expect(calls).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(calls).toHaveLength(2);
		await respond(calls[1]);
		// Hidden and not opted in: paused, no reads that nobody sees.
		handle.consumerVisibility("a", false);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(calls).toHaveLength(2);
		// An explicit interval still wins; so does a shorter one from pollEvery.
		handle.consumerUpdated("a", pollEvery(2_000).consumer as Json);
		handle.consumerVisibility("a", true);
		await vi.advanceTimersByTimeAsync(0);
		expect(calls).toHaveLength(3);
		await respond(calls[2]);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(calls).toHaveLength(4);
	});

	it("defaults the interval of consumer options that name no interval", async () => {
		const { calls, handle } = setup();
		handle.consumerAdded("a", { whileHidden: true }, { visible: false });
		await vi.advanceTimersByTimeAsync(0);
		expect(calls).toHaveLength(1);
		await respond(calls[0]);
		await vi.advanceTimersByTimeAsync(4_999);
		expect(calls).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(calls).toHaveLength(2);
	});

	it("coalesces simultaneous joins into one read and serves joiners from an in-flight read", async () => {
		const { calls, join, delivered } = setup();
		for (let index = 0; index < 20; index += 1) join(`c${index}`, 5_000);
		await vi.advanceTimersByTimeAsync(0);
		expect(calls).toHaveLength(1);
		join("late", 5_000);
		await vi.advanceTimersByTimeAsync(0);
		expect(calls).toHaveLength(1);
		await respond(calls[0]);
		expect(delivered[0]?.consumers).toHaveLength(21);
	});

	it("gives a joiner on an idle schedule one coalesced fresh read spaced from the last start", async () => {
		const { calls, join } = setup();
		join("a", 10_000);
		await vi.advanceTimersByTimeAsync(0);
		await respond(calls[0]);
		await vi.advanceTimersByTimeAsync(300);
		join("b", 10_000);
		join("c", 10_000);
		await vi.advanceTimersByTimeAsync(699);
		expect(calls).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(calls).toHaveLength(2);
		join("d", 10_000, { onJoin: "await" });
		await respond(calls[1]);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(calls).toHaveLength(2);
	});

	it("never aborts an in-flight read on an interval change; a shorter interval applies after it", async () => {
		const { calls, join, handle } = setup();
		join("a", 10_000);
		await vi.advanceTimersByTimeAsync(0);
		handle.consumerUpdated("a", { intervalMs: 1_000 });
		expect(calls[0]?.aborted).toBe(false);
		await respond(calls[0]);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(calls).toHaveLength(2);
	});

	it("aborts on last removal and discards the late result", async () => {
		const { calls, join, handle, delivered } = setup();
		join("a", 1_000);
		await vi.advanceTimersByTimeAsync(0);
		handle.consumerRemoved("a");
		expect(calls[0]?.aborted).toBe(true);
		handle.unsubscribe();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(delivered).toEqual([]);
		expect(calls).toHaveLength(1);
	});

	it("aborts a pre-suspension read on the coordinated return check, then reads once", async () => {
		const { calls, join, connection } = setup({ spec: { timeoutMs: 5_000 } });
		join("a", 1_000);
		await vi.advanceTimersByTimeAsync(0);
		vi.setSystemTime(Date.now() + 60_000);
		connection.probe?.();
		await vi.advanceTimersByTimeAsync(0);
		expect(calls[0]?.aborted).toBe(true);
		expect(calls).toHaveLength(2);
		expect(calls[1]?.aborted).toBe(false);
	});
});

describe("failures, retry and credentials", () => {
	it("blocks on 401 without spinning, marks the revision rejected, and resumes on rotation", async () => {
		const { calls, join, statuses, ctx, connection } = setup({
			credentials: async () => ({ headers: { authorization: "Bearer t" } }),
		});
		join("a", 1_000);
		await vi.advanceTimersByTimeAsync(0);
		expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe(
			"Bearer t",
		);
		await respond(calls[0], 401);
		expect(ctx.rejectCredentials).toHaveBeenCalledTimes(1);
		expect(statuses.at(-1)).toMatchObject({
			state: "auth-blocked",
			reason: "credentials-rejected",
			code: "http:401",
		});
		await vi.advanceTimersByTimeAsync(60_000);
		expect(calls).toHaveLength(1);
		connection.rotate?.();
		await vi.advanceTimersByTimeAsync(0);
		expect(calls).toHaveLength(2);
		expect(vi.mocked(ctx.credentials).mock.calls.at(-1)?.[0]).toBe("rotated");
	});

	it("fails permanently on other 4xx and only an explicit retry reads again", async () => {
		const { calls, join, statuses, connection } = setup();
		join("a", 1_000);
		await vi.advanceTimersByTimeAsync(0);
		await respond(calls[0], 404);
		expect(statuses.at(-1)).toMatchObject({
			state: "failed",
			reason: "permanent-error",
			code: 404,
		});
		await vi.advanceTimersByTimeAsync(60_000);
		expect(calls).toHaveLength(1);
		connection.probe?.();
		await vi.advanceTimersByTimeAsync(0);
		expect(calls).toHaveLength(1);
		connection.retry?.();
		await vi.advanceTimersByTimeAsync(0);
		expect(calls).toHaveLength(2);
	});

	it("backs off on 5xx/429/network errors with jitter, honours Retry-After and exhausts after 10 attempts", async () => {
		const { calls, join, statuses } = setup();
		join("a", 1_000);
		await vi.advanceTimersByTimeAsync(0);
		await respond(calls[0], 429, { error: 1 }, { "retry-after": "20" });
		expect(statuses.at(-1)).toMatchObject({
			state: "reconnecting",
			code: 429,
			attempt: 1,
		});
		await vi.advanceTimersByTimeAsync(19_999);
		expect(calls).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(calls).toHaveLength(2);
		for (let attempt = 2; attempt <= 11; attempt += 1) {
			const call = calls[attempt - 1];
			if (attempt % 2 === 0) await respond(call, 500);
			else {
				settled.add(call as Call);
				call?.fail(new TypeError("fetch failed"));
				await vi.advanceTimersByTimeAsync(0);
			}
			await vi.advanceTimersByTimeAsync(31_000);
		}
		expect(statuses.at(-1)).toMatchObject({
			state: "retry-exhausted",
			reason: "attempts-exhausted",
			attempt: 10,
		});
		const count = calls.length;
		await vi.advanceTimersByTimeAsync(120_000);
		expect(calls).toHaveLength(count);
	});

	it("reads anonymously without a credential source and blocks when a provider times out", async () => {
		const anonymous = setup();
		anonymous.join("a", 1_000);
		await vi.advanceTimersByTimeAsync(0);
		expect(
			new Headers(anonymous.calls[0]?.init.headers).has("authorization"),
		).toBe(false);
		const timing = setup({
			credentials: async () => {
				throw new SpinetabError("credentials-timeout", "slow");
			},
		});
		timing.join("a", 1_000);
		await vi.advanceTimersByTimeAsync(0);
		expect(timing.calls).toHaveLength(0);
		expect(timing.statuses.at(-1)).toMatchObject({
			state: "auth-blocked",
			reason: "credentials-missing",
		});
	});

	it("blocks on a failed provider exactly as on a timeout and never reads anonymously", async () => {
		let failing = true;
		const { calls, join, connection, statuses } = setup({
			credentials: async () => {
				if (failing) {
					throw new SpinetabError("credentials-failed", "provider threw");
				}
				return { headers: { authorization: "Bearer t" } };
			},
		});
		join("a", 1_000);
		await vi.advanceTimersByTimeAsync(0);
		expect(calls).toHaveLength(0);
		expect(statuses.at(-1)).toEqual({
			state: "auth-blocked",
			reason: "credentials-missing",
		});
		// Blocked, not retried on a timer: no anonymous read ever goes out.
		await vi.advanceTimersByTimeAsync(60_000);
		expect(calls).toHaveLength(0);
		failing = false;
		connection.rotate?.();
		await vi.advanceTimersByTimeAsync(0);
		expect(calls).toHaveLength(1);
		expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe(
			"Bearer t",
		);
	});

	it("ignores a superseded read's late credential failure so the replacing read keeps the schedule", async () => {
		const pending: Array<{
			resolve: (credentials: Credentials) => void;
			reject: (error: unknown) => void;
		}> = [];
		const { calls, join, connection, statuses, delivered } = setup({
			spec: { timeoutMs: 5_000 },
			credentials: () =>
				new Promise<Credentials>((resolve, reject) =>
					pending.push({ resolve, reject }),
				),
		});
		join("a", 1_000);
		await vi.advanceTimersByTimeAsync(0);
		expect(pending).toHaveLength(1);
		// Read A is still waiting for credentials when a suspension return
		// supersedes it with read B.
		vi.setSystemTime(Date.now() + 60_000);
		connection.probe?.();
		await vi.advanceTimersByTimeAsync(0);
		expect(pending).toHaveLength(2);
		pending[1]?.resolve({ headers: { authorization: "Bearer t" } });
		await vi.advanceTimersByTimeAsync(0);
		expect(calls).toHaveLength(1);
		pending[0]?.reject(new SpinetabError("credentials-timeout", "late"));
		await vi.advanceTimersByTimeAsync(0);
		await respond(calls[0], 200, { n: 1 });
		expect(delivered).toEqual([{ value: { n: 1 }, consumers: ["a"] }]);
		expect(statuses.map((status) => status.state)).not.toContain(
			"auth-blocked",
		);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(pending).toHaveLength(3);
	});

	it("rejects an oversized body without delivering or truncating it", async () => {
		const { calls, join, delivered, statuses, continuity } = setup();
		join("a", 1_000);
		await vi.advanceTimersByTimeAsync(0);
		await respond(calls[0], 200, { pad: "x".repeat(10_000) });
		await vi.advanceTimersByTimeAsync(0);
		expect(delivered).toEqual([]);
		expect(continuity).toEqual(["message-too-large"]);
		expect(statuses.at(-1)).toMatchObject({
			state: "failed",
			code: "frame-too-large",
		});
	});

	it("treats an undecodable body and a read timeout as transient", async () => {
		const { calls, join, statuses } = setup({ spec: { timeoutMs: 2_000 } });
		join("a", 1_000);
		await vi.advanceTimersByTimeAsync(0);
		await respond(calls[0], 200, "not json");
		expect(statuses.at(-1)).toMatchObject({
			state: "reconnecting",
			reason: "protocol-error",
			code: "decode-error",
		});
		await vi.advanceTimersByTimeAsync(2_000);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(calls[1]?.aborted).toBe(true);
		expect(statuses.at(-1)).toMatchObject({
			state: "reconnecting",
			code: "timeout",
		});
	});
});

describe("options and identity", () => {
	it("normalises the page builder output so equivalent requests share identity", () => {
		const adapter = pollingAdapter();
		const a = polling({
			url: "https://api.test/x",
			method: "GET",
			decoder: "json",
			timeoutMs: 30_000,
			headers: { Accept: "application/json" },
		});
		const b = polling({
			url: "https://api.test/x",
			headers: { accept: "application/json" },
		});
		expect(a.connection).toEqual(b.connection);
		expect(adapter.connectionKey?.(a.connection)).toBe(
			adapter.connectionKey?.(b.connection),
		);
		expect(
			adapter.connectionKey?.(
				polling({ url: "https://api.test/x", timeoutMs: 5_000 }).connection,
			),
		).not.toBe(adapter.connectionKey?.(a.connection));
		expect(a.subscription()).toEqual({
			adapter: "polling",
			connection: a.connection,
			subscription: {},
		});
		expect(structuredClone(a.subscription())).toEqual(a.subscription());
		expect(pollEvery(2_000, { whileHidden: true })).toEqual({
			consumer: { whileHidden: true, intervalMs: 2_000 },
		});
	});

	it("rejects unsupported options with a path in both realms", () => {
		const adapter = pollingAdapter({ decoders: { csv: () => [] } });
		const bad: Array<[() => unknown, string]> = [
			[
				() => polling({ url: "https://x", retries: 3 } as never),
				"polling.retries",
			],
			[() => polling({ url: "https://x", body: "{}" }), "polling.body"],
			[
				() => polling({ url: "https://x", method: "TRACE" as never }),
				"polling.method",
			],
			[
				() =>
					polling({ url: "https://x", headers: { Authorization: "Bearer x" } }),
				"polling.headers.Authorization",
			],
			[() => polling({ url: "https://x", timeoutMs: 0 }), "polling.timeoutMs"],
			[
				() =>
					adapter.validateConnection?.({
						url: "https://x",
						method: "GET",
						decoder: "xml",
						timeoutMs: 1_000,
					}),
				"connection.decoder",
			],
			[
				() => adapter.validateConsumer?.({ intervalMs: 500 }),
				"consumer.intervalMs",
			],
			[() => adapter.validateConsumer?.(null), "consumer"],
			[
				() => adapter.validateConsumer?.({ intervalMs: 1_000, every: 2 }),
				"consumer.every",
			],
			[() => adapter.validateSubscription?.({ topic: 1 }), "subscription"],
			[() => pollingAdapter({ decoders: { bad: 1 as never } }), "decoders.bad"],
		];
		for (const [run, path] of bad) {
			let caught: unknown;
			try {
				run();
			} catch (error) {
				caught = error;
			}
			expect(isSpinetabError(caught, "unsupported-option"), path).toBe(true);
			expect((caught as SpinetabError).detail).toMatchObject({ path });
		}
		expect(() =>
			polling({ url: "https://x", method: "POST", body: { q: 1 } }),
		).not.toThrow();
		expect(() =>
			adapter.validateConnection?.(
				polling({ url: "https://x", decoder: "csv" }).connection,
			),
		).not.toThrow();
		// No consumer options, or none naming an interval, default to
		// 5 000 ms in the runtime instead of failing.
		expect(() => adapter.validateConsumer?.(undefined)).not.toThrow();
		expect(() =>
			adapter.validateConsumer?.({ whileHidden: true }),
		).not.toThrow();
	});
});

// U-PL-4, (phase 2b): a read timeout that fires while the
// credentials are awaited, or just after fetch resolves, is transient
// `network`/`timeout`; only an AbortError stays silent.
describe("read timeouts around the credential wait", () => {
	it("reports a timeout during the credential wait as transient network/timeout", async () => {
		const { calls, join, statuses, ctx } = setup({
			credentials: () =>
				new Promise((resolve) =>
					setTimeout(
						() => resolve({ headers: { authorization: "Bearer t" } }),
						3_000,
					),
				),
			spec: { timeoutMs: 2_000 },
		});
		join("a", 1_000);
		await vi.advanceTimersByTimeAsync(0);
		expect(ctx.credentials).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(3_000);
		expect(calls).toHaveLength(0);
		expect(statuses.at(-1)).toMatchObject({
			state: "reconnecting",
			reason: "network",
			code: "timeout",
			attempt: 1,
		});
		// The schedule goes on: after the backoff, the next read asks again.
		await vi.advanceTimersByTimeAsync(2_000);
		expect(ctx.credentials).toHaveBeenCalledTimes(2);
	});

	it("reports a timeout that fires just after fetch resolves as transient network/timeout", async () => {
		const { calls, join, statuses, delivered } = setup({
			spec: { timeoutMs: 2_000 },
		});
		join("a", 1_000);
		await vi.advanceTimersByTimeAsync(0);
		const call = calls[0];
		if (!call) throw new Error("no fetch call");
		settled.add(call);
		call.respond(200, { n: 1 });
		// The timeout fires before the read continues past fetch.
		vi.advanceTimersByTime(2_000);
		await vi.advanceTimersByTimeAsync(0);
		expect(delivered).toEqual([]);
		expect(statuses.at(-1)).toMatchObject({
			state: "reconnecting",
			reason: "network",
			code: "timeout",
		});
	});
});

describe("read timeouts after the body was read", () => {
	it("reports a timeout that fires after the last body chunk as transient network/timeout", async () => {
		const { calls, join, statuses, delivered } = setup({
			spec: { timeoutMs: 2_000 },
		});
		join("a", 1_000);
		await vi.advanceTimersByTimeAsync(0);
		const call = calls[0];
		if (!call) throw new Error("no fetch call");
		settled.add(call);
		let body!: ReadableStreamDefaultController<Uint8Array>;
		call.respondWith(
			new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						body = controller;
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);
		body.enqueue(new TextEncoder().encode('{"n":1}'));
		await vi.advanceTimersByTimeAsync(0);
		body.close();
		// The timeout fires after the final read, before the read continues.
		vi.advanceTimersByTime(2_000);
		await vi.advanceTimersByTimeAsync(0);
		expect(delivered).toEqual([]);
		expect(statuses.at(-1)).toMatchObject({
			state: "reconnecting",
			reason: "network",
			code: "timeout",
		});
	});
});

// Credential failure wins over the read deadline: send no request and do not ask the provider again until retry or rotation.
describe("a credential failure after the read timed out", () => {
	it.each([
		["credentials-timeout", "slow"],
		["credentials-failed", "provider threw"],
	] as const)("reports auth-blocked when the provider fails with %s after the read timeout", async (code, message) => {
		let failing = true;
		const { calls, join, statuses, ctx, connection } = setup({
			credentials: () =>
				failing
					? new Promise((_resolve, reject) =>
							setTimeout(() => reject(new SpinetabError(code, message)), 3_000),
						)
					: Promise.resolve({ headers: { authorization: "Bearer t" } }),
			spec: { timeoutMs: 1_000 },
		});
		join("a", 1_000);
		await vi.advanceTimersByTimeAsync(0);
		expect(ctx.credentials).toHaveBeenCalledTimes(1);
		// The read timeout fires at 1 s; nothing is reported before the
		// credential wait ends.
		await vi.advanceTimersByTimeAsync(1_000);
		expect(statuses).toEqual([]);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(calls).toHaveLength(0);
		expect(statuses).toEqual([
			{ state: "auth-blocked", reason: "credentials-missing" },
		]);
		// Blocked, not retried on a timer: the provider is not asked again.
		await vi.advanceTimersByTimeAsync(120_000);
		expect(ctx.credentials).toHaveBeenCalledTimes(1);
		expect(calls).toHaveLength(0);
		expect(statuses).toHaveLength(1);
		// A rotation reads again, as for any blocked read.
		failing = false;
		connection.rotate?.();
		await vi.advanceTimersByTimeAsync(0);
		expect(calls).toHaveLength(1);
		expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe(
			"Bearer t",
		);
	});

	it("stays silent when the read was paused during the wait and the provider then fails (guard)", async () => {
		const { calls, join, handle, statuses, ctx } = setup({
			credentials: () =>
				new Promise((_resolve, reject) =>
					setTimeout(
						() => reject(new SpinetabError("credentials-timeout", "slow")),
						3_000,
					),
				),
			spec: { timeoutMs: 1_000 },
		});
		join("a", 1_000);
		await vi.advanceTimersByTimeAsync(0);
		// Nobody eligible: the pause aborts the read.
		handle.consumerRemoved("a");
		await vi.advanceTimersByTimeAsync(3_000);
		expect(statuses).toEqual([]);
		expect(calls).toHaveLength(0);
		expect(ctx.credentials).toHaveBeenCalledTimes(1);
	});
});

// U-PL-5, narrowed by a 204 is no new result for every
// decoder; an empty 2xx body is no new result only for the built-in JSON
// decoder (which could not decode it). The read succeeds, stays connected and
// delivers nothing. The `text` and custom decoders receive an empty body.
describe("no-content reads", () => {
	it("treats 204 and an empty 200 as no new result, never as a decode failure", async () => {
		const { calls, join, statuses, delivered } = setup();
		join("a", 1_000);
		await vi.advanceTimersByTimeAsync(0);
		const first = calls[0];
		if (!first) throw new Error("no fetch call");
		settled.add(first);
		first.respondWith(new Response(null, { status: 204 }));
		await vi.advanceTimersByTimeAsync(0);
		expect(delivered).toEqual([]);
		expect(statuses.at(-1)).toEqual({ state: "connected" });
		// A transient failure, then an empty 200 ends the series.
		await vi.advanceTimersByTimeAsync(1_000);
		await respond(calls[1], 503);
		expect(statuses.at(-1)).toMatchObject({ state: "reconnecting" });
		await vi.advanceTimersByTimeAsync(2_000);
		await respond(calls[2], 200, "");
		expect(delivered).toEqual([]);
		expect(statuses.at(-1)).toMatchObject({ state: "connected" });
		// The next read with a body delivers as before.
		await vi.advanceTimersByTimeAsync(1_000);
		await respond(calls[3], 200, { n: 4 });
		expect(delivered).toEqual([{ value: { n: 4 }, consumers: ["a"] }]);
	});

	it("hands an empty 2xx body to the text decoder, which delivers an empty string", async () => {
		const { calls, join, statuses, delivered } = setup({
			spec: { decoder: "text" },
		});
		join("a", 1_000);
		await vi.advanceTimersByTimeAsync(0);
		await respond(calls[0], 200, "");
		expect(delivered).toEqual([{ value: "", consumers: ["a"] }]);
		expect(statuses.at(-1)).toEqual({ state: "connected" });
		await vi.advanceTimersByTimeAsync(1_000);
		await respond(calls[1], 200, "tick");
		expect(delivered).toEqual([
			{ value: "", consumers: ["a"] },
			{ value: "tick", consumers: ["a"] },
		]);
	});

	it("hands an empty 2xx body to a custom decoder and delivers its result", async () => {
		const csv = vi.fn<PollingDecoder>((body) =>
			new TextDecoder().decode(body).split(",").filter(Boolean),
		);
		const { calls, join, statuses, delivered } = setup({
			decoders: { csv },
			spec: { decoder: "csv" },
		});
		join("a", 1_000);
		await vi.advanceTimersByTimeAsync(0);
		await respond(calls[0], 200, "", { "content-type": "text/csv" });
		expect(csv).toHaveBeenCalledTimes(1);
		expect(csv.mock.calls[0]?.[0].byteLength).toBe(0);
		expect(csv.mock.calls[0]?.[1]).toEqual({
			status: 200,
			contentType: "text/csv",
		});
		expect(delivered).toEqual([{ value: [], consumers: ["a"] }]);
		expect(statuses.at(-1)).toEqual({ state: "connected" });
	});

	it("treats a decoder registered under the name json as custom: it receives the empty body", async () => {
		const json = vi.fn(() => ({ empty: true }));
		const { calls, join, delivered } = setup({ decoders: { json } });
		join("a", 1_000);
		await vi.advanceTimersByTimeAsync(0);
		await respond(calls[0], 200, "");
		expect(json).toHaveBeenCalledTimes(1);
		expect(delivered).toEqual([{ value: { empty: true }, consumers: ["a"] }]);
	});

	it("treats a 204 as no new result for the text and custom decoders too (guard)", async () => {
		const csv = vi.fn(() => ["never"]);
		for (const options of [
			{ spec: { decoder: "text" } },
			{ decoders: { csv }, spec: { decoder: "csv" } },
		]) {
			const { calls, join, statuses, delivered } = setup(options);
			join("a", 1_000);
			await vi.advanceTimersByTimeAsync(0);
			const call = calls[0];
			if (!call) throw new Error("no fetch call");
			settled.add(call);
			call.respondWith(new Response(null, { status: 204 }));
			await vi.advanceTimersByTimeAsync(0);
			expect(delivered, options.spec.decoder).toEqual([]);
			expect(statuses.at(-1), options.spec.decoder).toEqual({
				state: "connected",
			});
		}
		expect(csv).not.toHaveBeenCalled();
	});
});

// U-PL-6, (phase 2b): polling header values follow the fetch
// header-value grammar and names the token grammar, in the builder and the
// worker validator (version skew); errors carry the path, never the value.
describe("header grammar", () => {
	it("refuses values fetch would reject and names that are not tokens, in both realms", () => {
		const adapter = pollingAdapter();
		const runtime = (headers: Record<string, string>) => () =>
			adapter.validateConnection?.({
				url: "https://api.test/poll",
				method: "GET",
				decoder: "json",
				timeoutMs: 1_000,
				headers,
			});
		const page = (headers: Record<string, string>) => () =>
			polling("https://api.test/poll", { headers });
		const cases: Array<[() => unknown, string, string]> = [
			[page({ "x-label": "日本" }), "polling.headers.x-label", "日本"],
			[page({ "x-a": "a\r\nb" }), "polling.headers.x-a", "a\r\nb"],
			[page({ "x-a": "a\nb" }), "polling.headers.x-a", "a\nb"],
			[page({ "x-a": "a\u0000b" }), "polling.headers.x-a", "a\u0000b"],
			[page({ "x-a": "\u{1F600}" }), "polling.headers.x-a", "\u{1F600}"],
			[page({ "bad name": "x" }), "polling.headers.bad name", "x"],
			[page({ "x-é": "x" }), "polling.headers.x-é", "x"],
			[runtime({ "x-label": "日本" }), "connection.headers.x-label", "日本"],
			[runtime({ "bad name": "x" }), "connection.headers.bad name", "x"],
		];
		for (const [run, path, value] of cases) {
			let caught: unknown;
			try {
				run();
			} catch (error) {
				caught = error;
			}
			expect(isSpinetabError(caught, "unsupported-option"), path).toBe(true);
			expect((caught as SpinetabError).detail, path).toMatchObject({ path });
			if (value !== "x") {
				expect((caught as Error).message, path).not.toContain(value);
			}
		}
		expect(() =>
			polling("https://api.test/poll", {
				headers: { "x-latin": "é", "x-a": "a b\tc", "x-empty": "" },
			}),
		).not.toThrow();
	});
});
