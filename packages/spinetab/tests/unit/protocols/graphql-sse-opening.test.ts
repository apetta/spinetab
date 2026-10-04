import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterConnection } from "../../../src/core/adapter.ts";
import type { Credentials } from "../../../src/core/types.ts";
import { graphqlSseAdapter } from "../../../src/protocols/graphql-sse/runtime.ts";
import {
	createRecordingSink,
	createTestContext,
} from "../../integration/protocols/helpers.ts";

const connections: AdapterConnection[] = [];
const heartbeat = 1_000;
const deadline = 2_500;
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
async function flush() {
	for (let n = 0; n < 40; n += 1) await Promise.resolve();
}
beforeEach(() =>
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }),
);
afterEach(async () => {
	for (const connection of connections.splice(0)) connection.dispose();
	await flush();
	vi.useRealTimers();
});

function setup(
	mode: "distinct" | "single",
	options: {
		declared?: boolean;
		repeatable?: boolean;
		lazyCloseTimeoutMs?: number;
		credentials?: () => Promise<Credentials>;
	} = {},
) {
	const pending = deferred<Response>();
	const requests: RequestInit[] = [];
	const context = createTestContext({ now: () => Date.now() });
	if (options.credentials) context.ctx.credentials = options.credentials;
	const response = () =>
		new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(": open\n\n"));
				},
			}),
			{ headers: { "content-type": "text/event-stream" } },
		);
	const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
		if (init?.method === "PUT") return new Response("token", { status: 201 });
		if (init?.method === "DELETE") return new Response(null, { status: 200 });
		if (mode === "single" && init?.method === "POST")
			return new Response(null, { status: 202 });
		requests.push(init ?? {});
		// Deliberately ignore abort: timeout/cancellation must also fence a late fetch implementation.
		return requests.length === 1 ? pending.promise : response();
	}) as typeof fetch;
	const connection = graphqlSseAdapter({
		fetchFn,
		retry: async () => {},
	}).connect(
		{
			url: "https://api.test/stream",
			mode,
			anonymous: !options.credentials,
			...(mode === "single"
				? { lazyCloseTimeoutMs: options.lazyCloseTimeoutMs ?? 0 }
				: {}),
			...(options.declared === false ? {} : { heartbeatMs: heartbeat }),
		},
		context.ctx,
	);
	connections.push(connection);
	const recording = createRecordingSink();
	const subscription = connection.subscribe(
		{ query: "subscription { ticks { n } }" },
		recording.sink,
		{ key: "ticks", repeatable: options.repeatable ?? true },
	);
	return {
		connection,
		context,
		recording,
		subscription,
		pending,
		requests,
		response,
	};
}

describe("graphql-sse pending response liveness", () => {
	for (const mode of ["distinct", "single"] as const) {
		it(`${mode}: cancellation releases the heartbeat reader even when fetch does not propagate abort`, async () => {
			const h = setup(mode);
			await flush();
			const cancel = vi.fn();
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(": open\n\n"));
				},
				cancel,
			});
			h.pending.resolve(
				new Response(body, {
					headers: { "content-type": "text/event-stream" },
				}),
			);
			await flush();
			h.subscription.unsubscribe();
			await flush();
			expect(cancel).toHaveBeenCalledOnce();
			expect(body.locked).toBe(false);
			await vi.advanceTimersByTimeAsync(0); // Reservation bookkeeping runs in the next task.
			expect(vi.getTimerCount()).toBe(0);
			await vi.advanceTimersByTimeAsync(deadline);
			expect(h.context.diagnostics).toEqual([]);
			expect(h.requests).toHaveLength(1);
		});
		it(`${mode}: bounds a response that never resolves, even when fetch ignores abort`, async () => {
			const h = setup(mode);
			await flush();
			expect(h.requests).toHaveLength(1);
			await vi.advanceTimersByTimeAsync(deadline - 1);
			expect(h.requests[0]?.signal?.aborted).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			await flush();
			expect(h.requests[0]?.signal?.aborted).toBe(true);
			expect(h.requests).toHaveLength(2);
			expect(
				h.context.hasStatus("reconnecting", { reason: "heartbeat-timeout" }),
			).toBe(true);
			expect(h.context.lastStatus()?.state).toBe("connected");
			expect(h.recording.continuity).toEqual([]);
		});
		for (const action of ["unsubscribe", "rotate", "dispose"] as const) {
			it(`${mode}: ${action} aborts a response body after the opening promise resolved`, async () => {
				const h = setup(mode);
				await flush();
				h.pending.resolve(h.response());
				await flush();
				expect(h.requests[0]?.signal?.aborted).toBe(false);
				if (action === "unsubscribe") h.subscription.unsubscribe();
				else if (action === "rotate") h.connection.rotate?.();
				else h.connection.dispose();
				await flush();
				expect(h.requests[0]?.signal?.aborted).toBe(true);
				if (action === "rotate") {
					expect(h.requests).toHaveLength(2);
					expect(h.requests[1]?.signal?.aborted).toBe(false);
					h.connection.dispose();
					await flush();
					expect(h.requests[1]?.signal?.aborted).toBe(true);
				}
			});
		}
		it(`${mode}: coalesces overdue checks after executable return`, async () => {
			const h = setup(mode);
			await flush();
			vi.setSystemTime(Date.now() + deadline + 1);
			h.connection.probe?.();
			h.connection.probe?.();
			h.connection.probe?.();
			await flush();
			expect(h.requests[0]?.signal?.aborted).toBe(true);
			expect(h.requests).toHaveLength(2);
			expect(
				h.context.diagnostics.filter(
					(notice) => notice.type === "graphql-sse.heartbeat-timeout",
				),
			).toHaveLength(1);
		});
		it(`${mode}: does not invent a deadline without a declared heartbeat`, async () => {
			const h = setup(mode, { declared: false });
			await flush();
			await vi.advanceTimersByTimeAsync(60_000);
			expect(h.requests).toHaveLength(1);
			expect(h.requests[0]?.signal?.aborted).toBe(false);
			expect(vi.getTimerCount()).toBe(0);
		});
		it(`${mode}: does not charge an unresolved credential provider against the network deadline`, async () => {
			const grant = deferred<Credentials>();
			const h = setup(mode, { credentials: () => grant.promise });
			await flush();
			await vi.advanceTimersByTimeAsync(60_000);
			expect(h.requests).toHaveLength(0);
			expect(vi.getTimerCount()).toBe(0);
			grant.resolve({});
			await flush();
			expect(h.requests).toHaveLength(1);
			await vi.advanceTimersByTimeAsync(deadline - 1);
			expect(h.requests[0]?.signal?.aborted).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			await flush();
			expect(h.requests).toHaveLength(2);
		});
		it(`${mode}: closes and fences a late response after the last unsubscribe`, async () => {
			const h = setup(mode);
			await flush();
			h.subscription.unsubscribe();
			h.connection.dispose();
			await flush();
			expect(h.requests[0]?.signal?.aborted).toBe(true);
			expect(vi.getTimerCount()).toBe(0);
			let cancelled = false;
			h.pending.resolve(
				new Response(
					new ReadableStream({
						cancel() {
							cancelled = true;
						},
					}),
					{ headers: { "content-type": "text/event-stream" } },
				),
			);
			await flush();
			expect(cancelled).toBe(true);
			await vi.advanceTimersByTimeAsync(60_000);
			expect(h.requests).toHaveLength(1);
			expect(h.recording.events).toEqual([]);
		});
		it(`${mode}: replaces the opening deadline with a full body-byte interval after a delayed response`, async () => {
			const h = setup(mode);
			await flush();
			await vi.advanceTimersByTimeAsync(deadline - 1);
			h.pending.resolve(h.response());
			await flush();
			expect(h.context.lastStatus()?.state).toBe("connected");
			await vi.advanceTimersByTimeAsync(deadline - 1);
			expect(h.requests).toHaveLength(1);
			await vi.advanceTimersByTimeAsync(1);
			await flush();
			expect(h.requests).toHaveLength(2);
		});
	}
	it("distinct: a timed-out unacknowledged non-repeatable POST ends interrupted and is never resent", async () => {
		const h = setup("distinct", { repeatable: false });
		await flush();
		await vi.advanceTimersByTimeAsync(deadline);
		await flush();
		expect(h.requests).toHaveLength(1);
		expect(h.requests[0]?.signal?.aborted).toBe(true);
		expect(h.recording.errors).toMatchObject([{ code: "interrupted" }]);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(h.requests).toHaveLength(1);
	});

	it("single: explicit upstream idle close remains finite after disposal", async () => {
		const h = setup("single", { lazyCloseTimeoutMs: 5_000 });
		await flush();
		h.subscription.unsubscribe();
		h.connection.dispose();
		await flush();
		expect(h.requests[0]?.signal?.aborted).toBe(true);
		expect(vi.getTimerCount()).toBe(1);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(vi.getTimerCount()).toBe(0);
		expect(h.requests).toHaveLength(1);
	});
});

describe("single-mode rejection response lifetime", () => {
	for (const end of ["timeout", "unsubscribe", "rotate", "dispose"] as const) {
		it(`${end}: bounds and releases an unfinished error body without replaying the operation`, async () => {
			const context = createTestContext({
				now: () => Date.now(),
				limits: { commandTimeoutMs: 100 },
			});
			const recording = createRecordingSink();
			const cancel = vi.fn();
			const body = new ReadableStream<Uint8Array>({ cancel });
			let posts = 0;
			const connection = graphqlSseAdapter({
				fetchFn: (async (_input, init) => {
					if (init?.method === "PUT")
						return new Response("token", { status: 201 });
					if (init?.method === "GET")
						return new Response(new ReadableStream<Uint8Array>(), {
							headers: { "content-type": "text/event-stream" },
						});
					if (init?.method === "POST") {
						posts += 1;
						if (posts > 1) return new Response(null, { status: 202 });
						return new Response(body, {
							status: 400,
							headers: { "content-type": "application/json" },
						});
					}
					return new Response(null, { status: 200 });
				}) as typeof fetch,
			}).connect(
				{
					url: "https://api.test/stream",
					mode: "single",
					anonymous: true,
					lazyCloseTimeoutMs: 0,
				},
				context.ctx,
			);
			connections.push(connection);
			const subscription = connection.subscribe(
				{ query: "subscription { ticks { n } }" },
				recording.sink,
				{ key: "k", repeatable: true },
			);
			await flush();
			expect(posts).toBe(1);
			if (end === "timeout") await vi.advanceTimersByTimeAsync(100);
			else if (end === "unsubscribe") subscription.unsubscribe();
			else if (end === "rotate") connection.rotate?.();
			else connection.dispose();
			await flush();
			expect(cancel).toHaveBeenCalledOnce();
			expect(body.locked).toBe(false);
			expect(recording.errors).toEqual([]);
			if (end === "timeout")
				expect(context.lastStatus()).toMatchObject({
					state: "failed",
					code: "http:400",
				});
			else expect(context.hasStatus("failed")).toBe(false);
			await vi.advanceTimersByTimeAsync(100);
			expect(posts).toBe(end === "rotate" ? 2 : 1);
		});
	}
});
