import { afterEach, describe, expect, it } from "vitest";
import type { AdapterConnection } from "../../../src/core/adapter.ts";
import { graphqlSseAdapter } from "../../../src/protocols/graphql-sse/runtime.ts";
import type { GraphqlSseConnection } from "../../../src/protocols/graphql-sse/spec.ts";
import {
	createRecordingSink,
	createTestContext,
	sleep,
	waitFor,
} from "../../integration/protocols/helpers.ts";

// The real graphql-sse 2.6.1 client over a scripted fetch.
interface Call {
	url: string;
	method: string;
	headers: Record<string, string>;
	body?: string;
	signal?: AbortSignal;
}

type Responder = (call: Call, index: number) => Response | Promise<Response>;

function stream(
	chunks: string[] = [],
	signal?: AbortSignal,
): {
	response: Response;
	push(text: string): void;
	close(): void;
} {
	const encoder = new TextEncoder();
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const body = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
			for (const chunk of chunks) c.enqueue(encoder.encode(chunk));
			// A real fetch rejects the pending read once its signal aborts.
			signal?.addEventListener("abort", () => {
				try {
					c.error(new DOMException("The operation was aborted.", "AbortError"));
				} catch {}
			});
		},
	});
	return {
		response: new Response(body, {
			status: 200,
			headers: { "content-type": "text/event-stream; charset=utf-8" },
		}),
		push: (text) => controller.enqueue(encoder.encode(text)),
		close: () => controller.close(),
	};
}

const next = (payload: unknown) =>
	`event: next\ndata: ${JSON.stringify(payload)}\n\n`;
const status = (code: number) =>
	new Response(null, { status: code, statusText: "x" });

const connections: AdapterConnection[] = [];
afterEach(() => {
	for (const connection of connections.splice(0)) connection.dispose();
});

function setup(
	responder: Responder,
	spec: Partial<GraphqlSseConnection> = {},
	options: { credentials?: false } = {},
) {
	const calls: Call[] = [];
	const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const call: Call = {
			url: String(input),
			method: init?.method ?? "GET",
			headers: { ...(init?.headers as Record<string, string>) },
			...(typeof init?.body === "string" ? { body: init.body } : {}),
			...(init?.signal ? { signal: init.signal } : {}),
		};
		calls.push(call);
		return responder(call, calls.length - 1);
	}) as typeof fetch;
	const adapter = graphqlSseAdapter({ fetchFn, retry: async () => {} });
	const test = createTestContext({
		scope: "s",
		limits: { idleCloseMs: 20 },
		...(options.credentials === false
			? {}
			: {
					credentials: (revision) => ({
						headers: { authorization: `Bearer t${revision}` },
					}),
				}),
	});
	const connection = adapter.connect(
		{ url: "https://api.test/graphql/stream", mode: "distinct", ...spec },
		test.ctx,
	);
	connections.push(connection);
	const subscribe = (repeatable = true) => {
		const recording = createRecordingSink<unknown>();
		const subscription = connection.subscribe(
			{ query: "subscription { ticks { n } }" },
			recording.sink,
			{ key: "k", repeatable },
		);
		return { recording, subscription };
	};
	return { calls, test, connection, subscribe };
}

describe("graphql-sse HTTP classification", () => {
	it("401 blocks after exactly one request and rejects the revision", async () => {
		const { calls, test, subscribe } = setup(() => status(401));
		const feed = subscribe();
		await waitFor(() => test.hasStatus("auth-blocked"));
		await sleep(30);
		expect(calls).toHaveLength(1);
		expect(test.lastStatus()).toMatchObject({
			reason: "credentials-rejected",
			code: "http:401",
		});
		expect(test.rejections).toEqual([1]);
		expect(feed.recording.errors).toEqual([]);
		expect(feed.recording.completions).toBe(0);
	});

	it("other permanent 4xx fail without retry", async () => {
		const { calls, test, subscribe } = setup(() => status(422));
		subscribe();
		await waitFor(() => test.hasStatus("failed"));
		await sleep(30);
		expect(calls).toHaveLength(1);
		expect(test.lastStatus()).toMatchObject({
			reason: "permanent-error",
			code: "http:422",
		});
	});

	it("a refused single-mode reservation is unsupported-mode, never a silent fallback", async () => {
		const { calls, test, subscribe } = setup(() => status(405), {
			mode: "single",
		});
		subscribe();
		await waitFor(() => test.hasStatus("failed"));
		expect(calls.map((call) => call.method)).toEqual(["PUT"]);
		expect(test.lastStatus()).toMatchObject({ code: "unsupported-mode:405" });
	});

	it("5xx is left to the upstream NetworkError loop, then exhausted", async () => {
		const { calls, test, subscribe, connection } = setup(() => status(503), {
			retryAttempts: 2,
		});
		const feed = subscribe();
		await waitFor(() => test.hasStatus("retry-exhausted"));
		expect(calls).toHaveLength(3);
		expect(test.lastStatus()).toMatchObject({ code: "http:503" });
		expect(feed.recording.errors).toEqual([]);
		connection.retry?.();
		// A fresh client with a fresh budget: one more series of attempts.
		await waitFor(
			() =>
				test.statuses.filter((s) => s.state === "retry-exhausted").length === 2,
		);
		expect(calls).toHaveLength(6);
		expect(test.requests[3]).toBe("retry");
	});
});

describe("graphql-sse credentials and modes", () => {
	it("sends credentials only in headers, merged over non-credential identity headers", async () => {
		const live = stream([next({ data: { ticks: { n: 1 } } })]);
		const { calls, subscribe } = setup(() => live.response, {
			headers: { "x-client": "web" },
		});
		const feed = subscribe();
		await waitFor(() => feed.recording.events.length === 1);
		expect(calls[0]?.headers).toMatchObject({
			authorization: "Bearer t1",
			"x-client": "web",
			accept: "text/event-stream",
		});
		expect(calls[0]?.url).toBe("https://api.test/graphql/stream");
		expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
			query: "subscription {\n  ticks {\n    n\n  }\n}",
		});
	});

	it("without a credential source no request is sent", async () => {
		const { calls, test, subscribe } = setup(
			() => status(200),
			{},
			{ credentials: false },
		);
		subscribe();
		await waitFor(() => test.hasStatus("auth-blocked"));
		await sleep(20);
		expect(calls).toHaveLength(0);
		expect(test.lastStatus()).toMatchObject({ reason: "no-credential-source" });
	});

	it("single mode: PUT reservation, GET stream, POST per operation, one DELETE on stop", async () => {
		const reservation = stream([":\n\n"]);
		const { calls, subscribe } = setup(
			(call) => {
				if (call.method === "PUT")
					return new Response("token-1", { status: 201 });
				if (call.method === "GET") return reservation.response;
				if (call.method === "POST") return new Response(null, { status: 202 });
				return new Response(null, { status: 200 });
			},
			{ mode: "single" },
		);
		const feed = subscribe();
		await waitFor(() => calls.some((call) => call.method === "POST"));
		const post = calls.find((call) => call.method === "POST");
		const operationId = JSON.parse(post?.body ?? "{}").extensions
			.operationId as string;
		expect(post?.headers["x-graphql-event-stream-token"]).toBe("token-1");
		reservation.push(
			next({ id: operationId, payload: { data: { ticks: { n: 1 } } } }),
		);
		await waitFor(() => feed.recording.events.length === 1);
		feed.subscription.unsubscribe();
		await waitFor(() => calls.some((call) => call.method === "DELETE"));
		expect(calls.map((call) => call.method)).toEqual([
			"PUT",
			"GET",
			"POST",
			"DELETE",
		]);
		expect(calls.at(-1)?.url).toBe(
			`https://api.test/graphql/stream?operationId=${operationId}`,
		);
		expect(feed.recording.completions).toBe(0);
	});

	it("a failed DELETE is a diagnostic only", async () => {
		const reservation = stream([":\n\n"]);
		const { calls, test, subscribe } = setup(
			(call) => {
				if (call.method === "PUT") return new Response("t", { status: 201 });
				if (call.method === "GET") return reservation.response;
				if (call.method === "POST") return new Response(null, { status: 202 });
				return status(500);
			},
			{ mode: "single" },
		);
		const feed = subscribe();
		await waitFor(() => calls.some((call) => call.method === "POST"));
		feed.subscription.unsubscribe();
		await waitFor(() =>
			test.diagnostics.some((d) => d.type === "graphql-sse.complete-failed"),
		);
		expect(test.hasStatus("failed")).toBe(false);
		expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
	});
});

describe("declared heartbeat byte watchdog", () => {
	it("comment bytes keep a quiet stream open; silence fails it with NetworkError and upstream reconnects", async () => {
		const streams: ReturnType<typeof stream>[] = [];
		const { calls, test, subscribe } = setup(
			() => {
				const created = stream();
				streams.push(created);
				return created.response;
			},
			{ heartbeatMs: 40 },
		);
		const feed = subscribe();
		await waitFor(() => streams.length === 1);
		const first = streams[0] as ReturnType<typeof stream>;
		first.push(next({ data: { ticks: { n: 1 } } }));
		for (let beat = 0; beat < 6; beat += 1) {
			await sleep(40);
			first.push(":\n\n");
		}
		expect(calls).toHaveLength(1);
		expect(test.hasStatus("reconnecting")).toBe(false);
		// Stop all bytes: 2.5 × 40 ms later the stream is failed and retried.
		await waitFor(() => calls.length === 2, { timeout: 2_000 });
		expect(
			test.hasStatus("reconnecting", { reason: "heartbeat-timeout" }),
		).toBe(true);
		(streams[1] as ReturnType<typeof stream>).push(
			next({ data: { ticks: { n: 2 } } }),
		);
		// Once at detection, then the reconnect outcome.
		await waitFor(() => feed.recording.continuity.length === 2);
		expect(feed.recording.continuity).toEqual([
			{ reason: "reconnected" },
			{ reason: "reconnected" },
		]);
	});
});

// Completion from a disposed GraphQL-SSE client must not end a stream started under the new generation.
describe("credential rotation restarts streams without ending them", () => {
	it("distinct mode: rotate() reopens with the new revision; no complete, no error", async () => {
		const { calls, test, connection, subscribe } = setup(
			(call, index) =>
				stream([next({ data: { ticks: { n: index + 1 } } })], call.signal)
					.response,
		);
		const feed = subscribe();
		await waitFor(() => feed.recording.events.length === 1);
		expect(calls[0]?.headers.authorization).toBe("Bearer t1");

		test.setRevision(2);
		expect(connection.rotate).toBeDefined();
		connection.rotate?.();
		await waitFor(() => calls.length === 2);
		expect(calls[1]?.headers.authorization).toBe("Bearer t2");
		await sleep(100);
		expect(feed.recording.log).not.toContain("complete");
		expect(feed.recording.errors).toEqual([]);
		await waitFor(() => feed.recording.events.length === 2);
		expect(feed.recording.completions).toBe(0);
		expect(test.hasStatus("retry-exhausted")).toBe(false);
		expect(test.hasStatus("failed")).toBe(false);
	});

	it("single mode: rotate() re-reserves with the new revision and re-sends the operation", async () => {
		const reservations: ReturnType<typeof stream>[] = [];
		const { calls, test, connection, subscribe } = setup(
			(call) => {
				if (call.method === "PUT")
					return new Response(`token-${reservations.length + 1}`, {
						status: 201,
					});
				if (call.method === "GET") {
					const reservation = stream([":\n\n"], call.signal);
					reservations.push(reservation);
					return reservation.response;
				}
				if (call.method === "POST") return new Response(null, { status: 202 });
				return new Response(null, { status: 200 });
			},
			{ mode: "single" },
		);
		const feed = subscribe();
		const posts = () => calls.filter((call) => call.method === "POST");
		const puts = () => calls.filter((call) => call.method === "PUT");
		await waitFor(() => posts().length === 1);
		const first = JSON.parse(posts()[0]?.body ?? "{}").extensions
			.operationId as string;
		reservations[0]?.push(
			next({ id: first, payload: { data: { ticks: { n: 1 } } } }),
		);
		await waitFor(() => feed.recording.events.length === 1);
		expect(puts()[0]?.headers.authorization).toBe("Bearer t1");

		test.setRevision(2);
		expect(connection.rotate).toBeDefined();
		connection.rotate?.();
		await waitFor(() => puts().length === 2);
		expect(puts()[1]?.headers.authorization).toBe("Bearer t2");
		await waitFor(() => posts().length === 2);
		const second = JSON.parse(posts()[1]?.body ?? "{}").extensions
			.operationId as string;
		reservations[1]?.push(
			next({ id: second, payload: { data: { ticks: { n: 2 } } } }),
		);
		await sleep(100);
		expect(feed.recording.log).not.toContain("complete");
		expect(feed.recording.errors).toEqual([]);
		await waitFor(() => feed.recording.events.length === 2);
		expect(feed.recording.completions).toBe(0);
		expect(test.hasStatus("retry-exhausted")).toBe(false);
		expect(test.hasStatus("failed")).toBe(false);
	});
	it("single mode: a failed stale DELETE after rotate() does not exhaust the fresh connection", async () => {
		// A disposed operation's DELETE can still fail; its late error belongs to the old generation.
		const reservations: ReturnType<typeof stream>[] = [];
		const { calls, test, connection, subscribe } = setup(
			(call) => {
				if (call.method === "PUT")
					return new Response(`token-${reservations.length + 1}`, {
						status: 201,
					});
				if (call.method === "GET") {
					const reservation = stream([":\n\n"], call.signal);
					reservations.push(reservation);
					return reservation.response;
				}
				if (call.method === "POST") return new Response(null, { status: 202 });
				return status(500);
			},
			{ mode: "single" },
		);
		const feed = subscribe();
		const posts = () => calls.filter((call) => call.method === "POST");
		await waitFor(() => posts().length === 1);
		const first = JSON.parse(posts()[0]?.body ?? "{}").extensions
			.operationId as string;
		reservations[0]?.push(
			next({ id: first, payload: { data: { ticks: { n: 1 } } } }),
		);
		await waitFor(() => feed.recording.events.length === 1);

		test.setRevision(2);
		connection.rotate?.();
		await waitFor(() => posts().length === 2);
		await sleep(100);
		expect(calls.some((call) => call.method === "DELETE")).toBe(true);
		expect(test.hasStatus("retry-exhausted")).toBe(false);
		expect(feed.recording.errors).toEqual([]);
		const second = JSON.parse(posts()[1]?.body ?? "{}").extensions
			.operationId as string;
		reservations[1]?.push(
			next({ id: second, payload: { data: { ticks: { n: 2 } } } }),
		);
		await waitFor(() => feed.recording.events.length === 2);
		expect(feed.recording.completions).toBe(0);
	});
});

// a restart's credential reason (`rotated`,
// `retry`) belongs to the request that restarts the connection. It must not
// stick: `rotated` always asks a tab and bypasses the broker's cache, so every
// later subscription would otherwise re-ask for credentials it already has.
describe("the restart credential reason is used once", () => {
	it("distinct mode: a subscription opened after a rotation asks as a new connect", async () => {
		const { test, connection, subscribe } = setup(
			(call) =>
				stream([next({ data: { ticks: { n: 1 } } })], call.signal).response,
		);
		const first = subscribe();
		await waitFor(() => first.recording.events.length === 1);
		test.setRevision(2);
		connection.rotate?.();
		await waitFor(() => first.recording.events.length === 2);
		expect(test.requests).toEqual(["connect", "rotated"]);

		const later = subscribe();
		await waitFor(() => later.recording.events.length === 1);
		expect(test.requests).toEqual(["connect", "rotated", "connect"]);
	});
});

// `repeatable: false` holds across the upstream
// client's own reconnects. graphql-sse 2.6.1 re-executes an operation after
// any NetworkError (distinct: a new POST; single: a new reservation and a
// re-POST). A non-repeatable operation that the server accepted ends as
// `interrupted` after the early continuity notice and is never sent again.
describe("non-repeatable operations across upstream reconnects", () => {
	const operationIdOf = (call: Call | undefined) =>
		JSON.parse(call?.body ?? "{}").extensions?.operationId as string;

	it("distinct: a dropped stream ends a non-repeatable operation as interrupted, never re-POSTed", async () => {
		const streams: ReturnType<typeof stream>[] = [];
		const { calls, test, subscribe } = setup((call) => {
			const created = stream([], call.signal);
			streams.push(created);
			return created.response;
		});
		const once = subscribe(false);
		const repeat = subscribe(true);
		await waitFor(() => streams.length === 2);
		streams[0]?.push(next({ data: { ticks: { n: 1 } } }));
		streams[1]?.push(next({ data: { ticks: { n: 1 } } }));
		await waitFor(
			() =>
				once.recording.events.length === 1 &&
				repeat.recording.events.length === 1,
		);
		// The server ends the non-repeatable operation's stream mid-flight.
		streams[0]?.close();
		// Either outcome settles: interrupted, or upstream re-sent the operation.
		await waitFor(
			() =>
				once.recording.errors.length === 1 ||
				calls.filter((call) => call.method === "POST").length > 2,
			{ timeout: 1_000 },
		);
		await sleep(50);
		const posts = calls.filter((call) => call.method === "POST");
		expect(posts).toHaveLength(2);
		expect(once.recording.errors.map((error) => error.code)).toEqual([
			"interrupted",
		]);
		expect(once.recording.log).toEqual([
			"next",
			"continuity:reconnected",
			"error:interrupted",
		]);
		expect(once.recording.completions).toBe(0);
		expect(test.hasStatus("reconnecting", { reason: "network" })).toBe(true);
		// The repeatable twin is untouched and keeps its stream.
		expect(repeat.recording.errors).toEqual([]);
		expect(repeat.recording.continuity).toEqual([]);
		expect(posts[1]?.signal?.aborted).toBe(false);
	});

	it("single: a dropped reservation ends a non-repeatable operation as interrupted, never re-POSTed", async () => {
		const reservations: ReturnType<typeof stream>[] = [];
		const { calls, test, subscribe } = setup(
			(call) => {
				if (call.method === "PUT")
					return new Response(`tok${reservations.length}`, { status: 201 });
				if (call.method === "GET") {
					const created = stream([], call.signal);
					reservations.push(created);
					return created.response;
				}
				if (call.method === "POST") return new Response(null, { status: 202 });
				return new Response(null, { status: 200 });
			},
			{ mode: "single" },
		);
		const once = subscribe(false);
		await waitFor(() => calls.some((call) => call.method === "POST"));
		const id = operationIdOf(calls.find((call) => call.method === "POST"));
		reservations[0]?.push(next({ id, payload: { data: { ticks: { n: 1 } } } }));
		await waitFor(() => once.recording.events.length === 1);
		reservations[0]?.close();
		await waitFor(
			() =>
				once.recording.errors.length === 1 ||
				calls.filter((call) => call.method === "POST").length > 1,
			{ timeout: 1_000 },
		);
		await sleep(50);
		expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
		expect(once.recording.errors.map((error) => error.code)).toEqual([
			"interrupted",
		]);
		const log = once.recording.log;
		expect(log.indexOf("continuity:reconnected")).toBeGreaterThan(0);
		expect(log.indexOf("continuity:reconnected")).toBeLessThan(
			log.indexOf("error:interrupted"),
		);
		expect(log.at(-1)).toBe("error:interrupted");
		expect(test.hasStatus("reconnecting")).toBe(true);
	});

	it("single: of two operations on a dropped reservation only the repeatable one is re-POSTed", async () => {
		const reservations: ReturnType<typeof stream>[] = [];
		const { calls, subscribe } = setup(
			(call) => {
				if (call.method === "PUT")
					return new Response(`tok${reservations.length}`, { status: 201 });
				if (call.method === "GET") {
					const created = stream([], call.signal);
					reservations.push(created);
					return created.response;
				}
				if (call.method === "POST") return new Response(null, { status: 202 });
				return new Response(null, { status: 200 });
			},
			{ mode: "single" },
		);
		const once = subscribe(false);
		const repeat = subscribe(true);
		const posts = () => calls.filter((call) => call.method === "POST");
		await waitFor(() => posts().length === 2);
		const [onceId, repeatId] = posts().map(operationIdOf);
		reservations[0]?.push(
			next({ id: onceId, payload: { data: { ticks: { n: 1 } } } }) +
				next({ id: repeatId, payload: { data: { ticks: { n: 1 } } } }),
		);
		await waitFor(
			() =>
				once.recording.events.length === 1 &&
				repeat.recording.events.length === 1,
		);
		reservations[0]?.close();
		await waitFor(() => posts().length >= 3, { timeout: 1_000 });
		await sleep(50);
		expect(posts().map(operationIdOf)).toEqual([onceId, repeatId, repeatId]);
		expect(once.recording.errors.map((error) => error.code)).toEqual([
			"interrupted",
		]);
		expect(repeat.recording.errors).toEqual([]);
	});
});

// graphql-sse 2.6.1's single-mode catch drops its connection on
// any operation's NetworkError without aborting it, and lazy close and
// dispose abort only the newest connection. Spinetab owns every reservation
// it opened: none is left open once no operation runs on it.
describe("single-mode reservations after transient POST failures", () => {
	function single(
		post: (index: number, call: Call) => Response,
		spec: Partial<GraphqlSseConnection> = {},
	) {
		const reservations: ReturnType<typeof stream>[] = [];
		let posts = 0;
		const context = setup(
			(call) => {
				if (call.method === "PUT")
					return new Response(`tok${reservations.length}`, { status: 201 });
				if (call.method === "GET") {
					const created = stream([":\n\n"], call.signal);
					reservations.push(created);
					return created.response;
				}
				if (call.method === "POST") return post(posts++, call);
				return new Response(null, { status: 200 });
			},
			{ mode: "single", ...spec },
		);
		const gets = () => context.calls.filter((call) => call.method === "GET");
		const open = () => gets().filter((call) => !call.signal?.aborted).length;
		const tokenOf = (call: Call | undefined) =>
			call?.headers["x-graphql-event-stream-token"];
		const postsOf = () =>
			context.calls.filter((call) => call.method === "POST");
		return { ...context, reservations, gets, open, tokenOf, postsOf };
	}
	const refused = () => status(503);
	const accepted = () => new Response(null, { status: 202 });
	const operationIdOf = (call: Call | undefined) =>
		JSON.parse(call?.body ?? "{}").extensions?.operationId as string;

	it("two refused POSTs leave one reservation open; the last unsubscribe closes it", async () => {
		const context = single((index) => (index < 2 ? refused() : accepted()));
		const feed = context.subscribe();
		await waitFor(() => context.postsOf().length === 3);
		const id = operationIdOf(context.postsOf()[2]);
		context.reservations[2]?.push(
			next({ id, payload: { data: { ticks: { n: 1 } } } }),
		);
		await waitFor(() => feed.recording.events.length === 1);
		expect(context.gets()).toHaveLength(3);
		expect(context.open()).toBe(1);
		feed.subscription.unsubscribe();
		// Upstream's lazy close (idle 20 ms) ends the current reservation.
		await waitFor(() => context.open() === 0, { timeout: 1_000 });
		expect(feed.recording.errors).toEqual([]);
	});

	it("an unrelated live operation keeps its reservation; nothing else stays open", async () => {
		const context = single((index) =>
			index === 1 || index === 2 ? refused() : accepted(),
		);
		const live = context.subscribe(false);
		await waitFor(() => context.postsOf().length === 1);
		const liveId = operationIdOf(context.postsOf()[0]);
		context.reservations[0]?.push(
			next({ id: liveId, payload: { data: { ticks: { n: 1 } } } }),
		);
		await waitFor(() => live.recording.events.length === 1);

		const later = context.subscribe(true);
		await waitFor(() => context.postsOf().length === 4);
		const laterId = operationIdOf(context.postsOf()[3]);
		context.reservations[2]?.push(
			next({ id: laterId, payload: { data: { ticks: { n: 1 } } } }),
		);
		await waitFor(() => later.recording.events.length === 1);
		// The first reservation still carries the live operation.
		context.reservations[0]?.push(
			next({ id: liveId, payload: { data: { ticks: { n: 2 } } } }),
		);
		await waitFor(() => live.recording.events.length === 2);
		expect(live.recording.errors).toEqual([]);
		expect(
			context.postsOf().filter((call) => operationIdOf(call) === liveId),
		).toHaveLength(1);
		expect(context.gets()).toHaveLength(3);
		expect(context.open()).toBe(2);

		live.subscription.unsubscribe();
		await waitFor(() => context.open() === 1, { timeout: 1_000 });
		expect(context.gets()[0]?.signal?.aborted).toBe(true);
		later.subscription.unsubscribe();
		await waitFor(() => context.open() === 0, { timeout: 1_000 });
	});

	for (const end of ["dispose", "rotate"] as const) {
		it(`${end}() closes every reservation, including one an operation still holds`, async () => {
			const context = single((index) =>
				index === 1 || index === 2 ? refused() : accepted(),
			);
			const live = context.subscribe(true);
			await waitFor(() => context.postsOf().length === 1);
			const later = context.subscribe(true);
			await waitFor(() => context.postsOf().length === 4);
			expect(context.gets()).toHaveLength(3);
			// Closed at once, independent of the operations' DELETEs.
			if (end === "dispose") {
				context.connection.dispose();
				expect(context.open()).toBe(0);
				await sleep(50);
				expect(context.open()).toBe(0);
			} else {
				context.test.setRevision(2);
				context.connection.rotate?.();
				expect(context.open()).toBe(0);
				await waitFor(() => context.gets().length === 4);
				await sleep(50);
				expect(context.open()).toBe(1);
				expect(context.gets()[3]?.signal?.aborted).toBe(false);
			}
			expect(live.recording.errors).toEqual([]);
			expect(later.recording.errors).toEqual([]);
		});
	}

	// Server completion sends no DELETE; the adapter must release an older reservation whose final operation completed.
	it("an operation the server completes on a replaced reservation releases it at once", async () => {
		const context = single((index) => (index === 1 ? refused() : accepted()));
		const first = context.subscribe(true);
		await waitFor(() => context.postsOf().length === 1);
		const firstId = operationIdOf(context.postsOf()[0]);
		context.reservations[0]?.push(
			next({ id: firstId, payload: { data: { ticks: { n: 1 } } } }),
		);
		await waitFor(() => first.recording.events.length === 1);

		const later = context.subscribe(true);
		await waitFor(() => context.postsOf().length === 3);
		expect(context.tokenOf(context.postsOf()[1])).toBe("tok0"); // refused
		expect(context.tokenOf(context.postsOf()[2])).toBe("tok1");
		const laterId = operationIdOf(context.postsOf()[2]);
		context.reservations[1]?.push(
			next({ id: laterId, payload: { data: { ticks: { n: 1 } } } }),
		);
		await waitFor(() => later.recording.events.length === 1);
		expect(context.gets()).toHaveLength(2);
		expect(context.open()).toBe(2);

		context.reservations[0]?.push(
			`event: complete\ndata: ${JSON.stringify({ id: firstId })}\n\n`,
		);
		await waitFor(() => first.recording.completions === 1);
		await waitFor(() => context.open() === 1, { timeout: 500 });
		expect(context.gets()[0]?.signal?.aborted).toBe(true);
		expect(context.calls.some((call) => call.method === "DELETE")).toBe(false);

		later.subscription.unsubscribe();
		await waitFor(() => context.open() === 0, { timeout: 1_000 });
		expect(later.recording.errors).toEqual([]);
	});
});

// after a dropped reservation each operation's retry may reserve on
// its own (upstream clears its shared connection from every operation's
// catch). A replaced reservation whose stream has not answered yet is still
// awaited by the operation that opened it and must not be closed under it.
describe("single-mode reservations still being established", () => {
	it("a replaced reservation is kept until its operation has POSTed", async () => {
		const calls: Call[] = [];
		const streams = new Map<string, ReturnType<typeof stream>>();
		let puts = 0;
		const { subscribe } = setup(
			(call) => {
				calls.push(call);
				if (call.method === "PUT")
					return new Response(`tok${puts++}`, { status: 201 });
				if (call.method === "GET") {
					const token = call.headers["x-graphql-event-stream-token"] ?? "";
					const created = stream([":\n\n"], call.signal);
					streams.set(token, created);
					if (token !== "tok1") return created.response;
					// The first replacement, replaced by the second before its
					// stream answers, is still awaited by its operation.
					return new Promise<Response>((resolve, reject) =>
						setTimeout(() => {
							if (call.signal?.aborted)
								reject(new DOMException("aborted", "AbortError"));
							else resolve(created.response);
						}, 30),
					);
				}
				if (call.method === "POST") return new Response(null, { status: 202 });
				return new Response(null, { status: 200 });
			},
			{ mode: "single" },
		);
		const a = subscribe(true);
		const b = subscribe(true);
		const posts = () => calls.filter((call) => call.method === "POST");
		await waitFor(() => posts().length === 2);
		streams.get("tok0")?.close();
		await waitFor(() => posts().length === 4, { timeout: 1_000 });
		await sleep(50);
		for (const post of posts().slice(2)) {
			const id = JSON.parse(post.body ?? "{}").extensions.operationId;
			streams
				.get(post.headers["x-graphql-event-stream-token"] ?? "")
				?.push(next({ id, payload: { data: { ticks: { n: 1 } } } }));
		}
		await waitFor(
			() => a.recording.events.length === 1 && b.recording.events.length === 1,
			{ timeout: 1_000 },
		);
		const reserved = calls.filter((call) => call.method === "PUT");
		expect(reserved).toHaveLength(3);
		const replacements = calls.filter((call) => call.method === "GET").slice(1);
		expect(replacements.map((call) => call.signal?.aborted)).toEqual([
			false,
			false,
		]);
		expect(a.recording.errors).toEqual([]);
		expect(b.recording.errors).toEqual([]);
	});
});

describe("single-mode operation rejection isolation", () => {
	for (const code of [400, 422]) {
		it.each([
			"application/json",
			"application/graphql-response+json",
			"Application/JSON; Charset=UTF-8",
			"Application/GraphQL-Response+JSON",
		])(`${code} %s: rejects only the invalid operation, preserves siblings and never retries it`, async (contentType) => {
			let reservation: ReturnType<typeof stream> | undefined;
			let posts = 0;
			const errors = [{ message: "Cannot query field missingField" }];
			const h = setup(
				(call) => {
					if (call.method === "PUT")
						return new Response("token", { status: 201 });
					if (call.method === "GET") {
						reservation = stream([": open\n\n"], call.signal);
						return reservation.response;
					}
					if (call.method === "POST") {
						posts += 1;
						return posts === 2
							? Response.json(
									{ errors },
									{ status: code, headers: { "content-type": contentType } },
								)
							: new Response(null, { status: 202 });
					}
					return new Response(null, { status: 200 });
				},
				{ mode: "single" },
			);
			const healthy = h.subscribe(false);
			await waitFor(() => h.test.hasStatus("connected"));
			const id = JSON.parse(
				h.calls.find((c) => c.method === "POST")?.body ?? "{}",
			).extensions.operationId;
			reservation?.push(next({ id, payload: { data: { ticks: { n: 1 } } } }));
			await waitFor(() => healthy.recording.events.length === 1);
			const invalid = h.subscribe(false);
			await waitFor(() => invalid.recording.errors.length === 1);
			expect(invalid.recording.errors).toEqual([
				{
					code: "upstream-error",
					message: "The GraphQL operation failed.",
					detail: { errors },
				},
			]);
			expect(invalid.recording.completions).toBe(0);
			expect(h.test.lastStatus()?.state).toBe("connected");
			reservation?.push(next({ id, payload: { data: { ticks: { n: 2 } } } }));
			await waitFor(() => healthy.recording.events.length === 2);
			expect(healthy.recording.errors).toEqual([]);
			expect(healthy.recording.continuity).toEqual([]);
			const later = h.subscribe();
			await waitFor(() => posts === 3);
			expect(h.calls.filter((c) => c.method === "PUT")).toHaveLength(1);
			healthy.subscription.unsubscribe();
			later.subscription.unsubscribe();
			await waitFor(
				() => h.calls.find((c) => c.method === "GET")?.signal?.aborted === true,
			);
			expect(posts).toBe(3);
			expect(h.calls.filter((c) => c.method === "DELETE")).toHaveLength(2);
		});
	}
	for (const [name, reply] of [
		["HTML error", () => new Response("bad request", { status: 400 })],
		[
			"malformed JSON",
			() =>
				new Response("{", {
					status: 400,
					headers: { "content-type": "application/json" },
				}),
		],
		["empty errors", () => Response.json({ errors: [] }, { status: 400 })],
		[
			"invalid errors",
			() => Response.json({ errors: [{ message: 42 }] }, { status: 400 }),
		],
		[
			"unexpected data",
			() =>
				Response.json(
					{ data: {}, errors: [{ message: "bad" }] },
					{ status: 400 },
				),
		],
		[
			"oversized errors",
			() =>
				Response.json(
					{ errors: [{ message: "x".repeat(300_000) }] },
					{ status: 400 },
				),
		],
		[
			"missing endpoint",
			() =>
				Response.json({ errors: [{ message: "missing" }] }, { status: 404 }),
		],
	] as const) {
		it(`${name} retains terminal HTTP classification without retry`, async () => {
			const h = setup(
				(call) => {
					if (call.method === "PUT")
						return new Response("token", { status: 201 });
					if (call.method === "GET")
						return stream([": open\n\n"], call.signal).response;
					return reply();
				},
				{ mode: "single" },
			);
			const feed = h.subscribe();
			await waitFor(() => h.test.hasStatus("failed"));
			expect(h.test.lastStatus()?.reason).toBe("permanent-error");
			expect(feed.recording.errors).toEqual([]);
			expect(h.calls.filter((c) => c.method === "POST")).toHaveLength(1);
		});
	}
});
