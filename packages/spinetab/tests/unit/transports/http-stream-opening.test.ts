import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Credentials } from "../../../src/core/types.ts";
import { sseAdapter } from "../../../src/transports/sse/runtime.ts";
import {
	ndjsonParser,
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

// Regression: Firefox may leave fetch pending after response headers arrive,
// until body bytes arrive. Declared liveness must also supervise that phase.
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	vi.spyOn(Math, "random").mockReturnValue(0.5);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe.each(["sse", "stream"] as const)("%s opening liveness", (kind) => {
	function response(body: ScriptedBody, request?: ScriptedRequest) {
		return eventStream(
			body,
			kind === "stream"
				? { headers: { "content-type": "application/x-ndjson" } }
				: {},
			request?.init.signal ?? undefined,
		);
	}

	function write(body: ScriptedBody, n: number) {
		body.write(
			kind === "sse" ? `id: ${n}\ndata: ${n}\n\n` : `${JSON.stringify(n)}\n`,
		);
	}

	function setup(
		responders: Parameters<typeof scriptedFetch>[0],
		options: {
			within?: number;
			repeatable?: boolean;
			credentials?: () => Promise<Credentials>;
		} = {},
	) {
		const scripted = scriptedFetch(responders);
		vi.stubGlobal("fetch", scripted.fetch);
		const fake = fakeContext();
		if (options.credentials) fake.setCredentials(options.credentials);
		const repeatable = options.repeatable ?? true;
		const spec = {
			url: "https://api.test/live",
			repeatable,
			...(repeatable ? {} : { method: "POST" as const, body: "{}" }),
			...(options.credentials ? { authHeaders: true } : {}),
			...(options.within === undefined
				? {}
				: { heartbeat: { expectInboundWithinMs: options.within } }),
		};
		const conn =
			kind === "sse"
				? sseAdapter().connect({ ...spec, mode: "fetch" }, fake.ctx)
				: streamAdapter({ parsers: { ndjson: ndjsonParser() } }).connect(
						{ ...spec, parser: "ndjson" },
						fake.ctx,
					);
		const record = recordingSink();
		const sub = conn.subscribe({}, record.sink, { key: "live", repeatable });
		return { conn, sub, record, fake, requests: scripted.requests };
	}

	it("aborts a pending initial fetch at the declared deadline and retries once", async () => {
		const pending = deferred<Response>();
		const body = scriptedBody();
		const { conn, fake, requests, record } = setup(
			[() => pending.promise, (request) => response(body, request)],
			{ within: 2_000 },
		);
		await flush(20);
		await vi.advanceTimersByTimeAsync(1_999);
		expect(requests[0]?.aborted()).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(requests[0]?.aborted()).toBe(true);
		expect(fake.last()).toMatchObject({
			state: "reconnecting",
			reason: "heartbeat-timeout",
			attempt: 1,
		});
		expect(vi.getTimerCount()).toBe(1);
		await vi.advanceTimersByTimeAsync(500);
		expect(requests).toHaveLength(2);
		write(body, 1);
		await flush(20);
		expect(record.events).toEqual([1]);
		expect(record.continuity).toEqual([]);
		conn.dispose();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("recovers from a stalled replacement, fences its late response and retains the SSE cursor", async () => {
		const first = scriptedBody();
		const stale = scriptedBody();
		const last = scriptedBody();
		const pending = deferred<Response>();
		const { conn, requests, record } = setup(
			[
				(request) => response(first, request),
				() => pending.promise,
				(request) => response(last, request),
			],
			{ within: 2_000 },
		);
		await flush(20);
		write(first, 4);
		await flush(20);
		first.fail();
		await flush(20);
		await vi.advanceTimersByTimeAsync(500);
		expect(requests).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(requests[1]?.aborted()).toBe(true);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(requests).toHaveLength(3);
		if (kind === "sse") {
			expect(requests[1]?.headers.get("last-event-id")).toBe("4");
			expect(requests[2]?.headers.get("last-event-id")).toBe("4");
		}
		write(stale, 99);
		pending.resolve(response(stale));
		await flush(20);
		expect(stale.cancelled).toBe(true);
		write(last, 5);
		await flush(20);
		expect(record.events).toEqual([4, 5]);
		expect(record.continuity.map((event) => event.reason)).toEqual([
			"reconnected",
			"reconnected",
		]);
		conn.dispose();
	});

	it("resets the one deadline when a delayed response opens", async () => {
		const pending = deferred<Response>();
		const body = scriptedBody();
		const { conn, fake, requests } = setup([() => pending.promise], {
			within: 2_000,
		});
		await flush(20);
		await vi.advanceTimersByTimeAsync(1_900);
		pending.resolve(response(body, requests[0]));
		await flush(20);
		expect(fake.last()).toEqual({ state: "connected" });
		expect(vi.getTimerCount()).toBe(1);
		await vi.advanceTimersByTimeAsync(1_999);
		expect(requests[0]?.aborted()).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(requests[0]?.aborted()).toBe(true);
		expect(
			fake.diagnostics.filter((e) => e.type === "heartbeat-missed"),
		).toHaveLength(1);
		conn.dispose();
	});

	it("does not charge a credential wait against the upstream deadline or restart it on a probe", async () => {
		const grant = deferred<Credentials>();
		const pending = deferred<Response>();
		const { conn, fake, requests } = setup([() => pending.promise], {
			within: 2_000,
			credentials: () => grant.promise,
		});
		await flush(20);
		await vi.advanceTimersByTimeAsync(60_000);
		conn.probe?.();
		await flush(20);
		expect(fake.credentialCalls).toEqual(["connect"]);
		expect(requests).toHaveLength(0);
		expect(vi.getTimerCount()).toBe(0);
		grant.resolve({ headers: { authorization: "Bearer local-test" } });
		await flush(20);
		expect(requests).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1_999);
		expect(requests[0]?.aborted()).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(requests[0]?.aborted()).toBe(true);
		conn.dispose();
	});

	it("checks a pending fetch on return without creating duplicate timers or requests", async () => {
		const pending = deferred<Response>();
		const body = scriptedBody();
		const { conn, requests, fake } = setup(
			[() => pending.promise, (request) => response(body, request)],
			{ within: 2_000 },
		);
		await flush(20);
		await vi.advanceTimersByTimeAsync(1_000);
		conn.probe?.();
		expect(requests).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(1);
		vi.setSystemTime(Date.now() + 1_001);
		conn.probe?.();
		expect(requests[0]?.aborted()).toBe(true);
		expect(fake.last()).toMatchObject({ reason: "heartbeat-timeout" });
		expect(vi.getTimerCount()).toBe(1);
		conn.dispose();
	});

	it("keeps an undeclared quiet opening request until a coordinated return check", async () => {
		const pending = deferred<Response>();
		const body = scriptedBody();
		const { conn, requests, record } = setup([
			() => pending.promise,
			(request) => response(body, request),
		]);
		await flush(20);
		await vi.advanceTimersByTimeAsync(3_600_000);
		expect(requests).toHaveLength(1);
		expect(requests[0]?.aborted()).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
		conn.probe?.();
		await flush(20);
		expect(requests).toHaveLength(2);
		expect(requests[0]?.aborted()).toBe(true);
		write(body, 1);
		await flush(20);
		expect(record.events).toEqual([1]);
		expect(record.continuity).toEqual([]);
		conn.dispose();
	});

	it("bounds repeated opening failures with the existing retry limit", async () => {
		const pending = deferred<Response>();
		const { conn, requests, fake } = setup(
			Array.from({ length: 11 }, () => () => pending.promise),
			{ within: 2_000 },
		);
		await vi.advanceTimersByTimeAsync(300_000);
		expect(requests).toHaveLength(11);
		expect(requests.every((request) => request.aborted())).toBe(true);
		expect(fake.last()).toEqual({
			state: "retry-exhausted",
			reason: "attempts-exhausted",
		});
		expect(vi.getTimerCount()).toBe(0);
		conn.dispose();
	});

	it("re-arms an opening deadline when suspended time has not advanced the executable clock", async () => {
		const pending = deferred<Response>();
		const { conn, requests, fake } = setup([() => pending.promise], {
			within: 2_000,
		});
		let executable = 0;
		fake.ctx.now = () => executable;
		await flush(20);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(requests[0]?.aborted()).toBe(false);
		expect(fake.diagnostics).toEqual([]);
		expect(vi.getTimerCount()).toBe(1);
		executable = 2_000;
		conn.probe?.();
		expect(requests[0]?.aborted()).toBe(true);
		expect(fake.last()).toMatchObject({ reason: "heartbeat-timeout" });
		conn.dispose();
	});

	it.each([
		"unsubscribe",
		"dispose",
	] as const)("%s aborts a pending fetch, releases timers and rejects late delivery", async (action) => {
		const pending = deferred<Response>();
		const body = scriptedBody();
		const { conn, sub, requests, record } = setup([() => pending.promise], {
			within: 2_000,
		});
		await flush(20);
		if (action === "unsubscribe") sub.unsubscribe();
		else conn.dispose();
		expect(requests[0]?.aborted()).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
		write(body, 99);
		pending.resolve(response(body));
		await flush(20);
		expect(body.cancelled).toBe(true);
		await vi.advanceTimersByTimeAsync(300_000);
		expect(requests).toHaveLength(1);
		expect(record.events).toEqual([]);
		expect(record.errors).toEqual([]);
		conn.dispose();
	});

	it("settles a non-repeatable opening timeout without sending another POST", async () => {
		const pending = deferred<Response>();
		const { conn, requests, record } = setup([() => pending.promise], {
			within: 2_000,
			repeatable: false,
		});
		await flush(20);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(requests[0]?.init.method).toBe("POST");
		expect(requests[0]?.aborted()).toBe(true);
		expect(record.errors).toMatchObject([
			{ code: "interrupted", detail: { reason: "heartbeat-timeout" } },
		]);
		conn.probe?.();
		conn.retry?.();
		await vi.advanceTimersByTimeAsync(300_000);
		expect(requests).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(0);
		conn.dispose();
	});
});
