import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdapterConnection } from "../../../src/core/adapter.ts";
import type { Credentials } from "../../../src/core/types.ts";
import {
	trpcSseAdapter,
	trpcWsAdapter,
} from "../../../src/integrations/trpc/runtime.ts";
import type { TrpcSubscriptionSpec } from "../../../src/integrations/trpc/spec.ts";
import { graphqlSseAdapter } from "../../../src/protocols/graphql-sse/runtime.ts";
import { graphqlWsAdapter } from "../../../src/protocols/graphql-ws/runtime.ts";
import { credentialFailureReason } from "../../../src/protocols/shared/runtime.ts";
import {
	createRecordingSink,
	createTestContext,
	sleep,
	type TestContext,
	waitFor,
} from "../../integration/protocols/helpers.ts";
import { FakeWebSocket } from "./fakes.ts";

// Socket.IO security cases use a separate suite because they mock socket.io-client.

const connections: AdapterConnection[] = [];
beforeEach(() => {
	FakeWebSocket.reset();
	ScriptedEventSource.instances = [];
});
afterEach(() => {
	for (const connection of connections.splice(0)) connection.dispose();
});

const QUERY = "subscription { ticks { n } }";

function graphqlWs(
	options: {
		credentials?: (revision: number) => Credentials;
		audience?: (url: string | undefined) => boolean;
		anonymous?: boolean;
	} = {},
) {
	const test = createTestContext({
		...(options.credentials ? { credentials: options.credentials } : {}),
		...(options.audience ? { audience: options.audience } : {}),
	});
	const connection = graphqlWsAdapter({
		webSocketImpl: FakeWebSocket,
		retryWait: async () => {},
	}).connect(
		{
			url: "https://api.test/graphql",
			...(options.anonymous ? { anonymous: true } : {}),
		},
		test.ctx,
	);
	connections.push(connection);
	const feed = createRecordingSink<unknown>();
	connection.subscribe({ query: QUERY }, feed.sink, {
		key: "k",
		repeatable: true,
	});
	return { test, connection, feed };
}

async function acceptedSocket(): Promise<FakeWebSocket> {
	await waitFor(() => FakeWebSocket.instances.length > 0, { timeout: 1_000 });
	const socket = FakeWebSocket.last();
	socket.accept();
	await sleep(5);
	return socket;
}

interface FetchCall {
	method: string;
	headers: Record<string, string>;
	redirect: RequestRedirect | undefined;
}

function sseStream(): Response {
	return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
		status: 200,
		headers: { "content-type": "text/event-stream; charset=utf-8" },
	});
}

function graphqlSse(
	responder: (index: number) => Response | Promise<Response>,
	options: {
		credentials?: (revision: number) => Credentials;
		audience?: (url: string | undefined) => boolean;
		anonymous?: boolean;
	} = {},
) {
	const calls: FetchCall[] = [];
	const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
		calls.push({
			method: init?.method ?? "GET",
			headers: { ...(init?.headers as Record<string, string>) },
			redirect: init?.redirect,
		});
		return responder(calls.length - 1);
	}) as typeof fetch;
	const test = createTestContext({
		...(options.credentials ? { credentials: options.credentials } : {}),
		...(options.audience ? { audience: options.audience } : {}),
	});
	const connection = graphqlSseAdapter({
		fetchFn,
		retry: async () => {},
	}).connect(
		{
			url: "https://api.test/graphql/stream",
			...(options.anonymous ? { anonymous: true } : {}),
		},
		test.ctx,
	);
	connections.push(connection);
	const subscribe = (query = QUERY) => {
		const feed = createRecordingSink<unknown>();
		connection.subscribe({ query }, feed.sink, {
			key: query,
			repeatable: true,
		});
		return feed;
	};
	return { calls, test, connection, subscribe };
}

const bearer = (revision: number): Credentials => ({
	headers: { authorization: `Bearer t${revision}` },
});

class ScriptedEventSource {
	static instances: ScriptedEventSource[] = [];
	readonly CONNECTING = 0;
	readonly OPEN = 1;
	readonly CLOSED = 2;
	readyState = 0;
	readonly url: string;
	readonly init: Record<string, unknown>;
	readonly #listeners = new Map<string, Set<(event: unknown) => void>>();

	constructor(url: string | URL, init: Record<string, unknown> = {}) {
		this.url = String(url);
		this.init = init;
		ScriptedEventSource.instances.push(this);
	}

	addEventListener(type: string, listener: (event: unknown) => void): void {
		let set = this.#listeners.get(type);
		if (!set) {
			set = new Set();
			this.#listeners.set(type, set);
		}
		set.add(listener);
	}

	removeEventListener(type: string, listener: (event: unknown) => void): void {
		this.#listeners.get(type)?.delete(listener);
	}

	close(): void {
		this.readyState = 2;
	}

	fire(type: string, event: Record<string, unknown> = {}): void {
		for (const listener of [...(this.#listeners.get(type) ?? [])]) {
			listener({ type, ...event });
		}
	}

	/** Plays the server: the stream opened and tRPC said `connected`. */
	connected(): void {
		this.readyState = 1;
		this.fire("connected", { data: "{}" });
	}

	/** Plays the server: a serialised procedure or context error. */
	trpcError(code: string, number: number, message = "denied"): void {
		this.fire("serialized-error", {
			data: JSON.stringify({
				code: number,
				message,
				data: { code, httpStatus: 400, stack: "Error: secret at /srv/app.ts" },
			}),
		});
	}

	/** Plays the browser: the connection failed with an HTTP status. */
	failWith(status: number): void {
		this.readyState = 2;
		this.fire("error", { status });
	}
}

async function lastEventSource(count = 1): Promise<ScriptedEventSource> {
	await waitFor(() => ScriptedEventSource.instances.length >= count, {
		timeout: 1_000,
	});
	return ScriptedEventSource.instances.at(-1) as ScriptedEventSource;
}

function trpcSse(
	options: {
		credentials?: (revision: number) => Credentials;
		audience?: (url: string | undefined) => boolean;
		headers?: boolean;
	} = {},
) {
	const test = createTestContext({
		...(options.credentials ? { credentials: options.credentials } : {}),
		...(options.audience ? { audience: options.audience } : {}),
	});
	const connection = trpcSseAdapter({
		EventSource: ScriptedEventSource,
		headers: options.headers ?? true,
		retryDelayMs: () => 5,
	}).connect({ url: "https://api.test/trpc", retryAttempts: 3 }, test.ctx);
	connections.push(connection as AdapterConnection);
	const subscribe = (spec: TrpcSubscriptionSpec = { path: "ticks" }) => {
		const feed = createRecordingSink<unknown>();
		connection.subscribe(spec, feed.sink as never, {
			key: JSON.stringify(spec),
			repeatable: true,
		});
		return feed;
	};
	return { test, connection, subscribe };
}

function statusOf(test: TestContext) {
	const last = test.lastStatus();
	return { state: last?.state, reason: last?.reason, code: last?.code };
}

describe("every credential request names the URL; credentials-audience blocks for good", () => {
	it("credentialFailureReason maps credentials-audience to its own reason", () => {
		expect(credentialFailureReason({ code: "credentials-audience" })).toBe(
			"credentials-audience",
		);
	});

	it("graphql-ws asks with the WebSocket URL", async () => {
		const { test } = graphqlWs({ credentials: () => ({}) });
		await acceptedSocket();
		expect(test.urls).toEqual(["wss://api.test/graphql"]);
	});

	it("graphql-sse asks with the endpoint URL", async () => {
		const { test, subscribe } = graphqlSse(() => sseStream(), {
			credentials: bearer,
		});
		subscribe();
		await waitFor(() => test.urls.length > 0, { timeout: 1_000 });
		expect(test.urls).toEqual(["https://api.test/graphql/stream"]);
	});

	it("tRPC WS and SSE ask with their endpoint URLs", async () => {
		const ws = createTestContext({ credentials: () => ({}) });
		const wsConnection = trpcWsAdapter({
			WebSocket: FakeWebSocket as never,
		}).connect({ url: "https://api.test/trpc-ws" }, ws.ctx);
		connections.push(wsConnection as AdapterConnection);
		wsConnection.subscribe({ path: "ticks" }, createRecordingSink().sink, {
			key: "k",
			repeatable: true,
		});
		await waitFor(() => ws.urls.length > 0, { timeout: 1_000 });
		expect(ws.urls).toEqual(["wss://api.test/trpc-ws"]);

		const { test, subscribe } = trpcSse({ credentials: bearer });
		subscribe();
		await lastEventSource();
		expect(test.urls).toEqual(["https://api.test/trpc"]);
	});

	it("graphql-ws: outside the audience it opens nothing, rejects nothing and ignores rotation", async () => {
		const { test, connection } = graphqlWs({
			credentials: () => ({ connectionParams: { token: "t" } }),
			audience: () => false,
		});
		await waitFor(() => test.hasStatus("auth-blocked"), { timeout: 1_000 });
		expect(statusOf(test)).toMatchObject({
			state: "auth-blocked",
			reason: "credentials-audience",
		});
		connection.rotate?.();
		await sleep(20);
		expect(test.requests).toHaveLength(1);
		expect(FakeWebSocket.instances).toHaveLength(0);
		expect(test.rejectCalls).toEqual([]);
	});

	it("graphql-sse: outside the audience it sends nothing and ignores rotation", async () => {
		const { test, connection, calls, subscribe } = graphqlSse(
			() => sseStream(),
			{ credentials: bearer, audience: () => false },
		);
		subscribe();
		await waitFor(() => test.hasStatus("auth-blocked"), { timeout: 1_000 });
		expect(statusOf(test).reason).toBe("credentials-audience");
		connection.rotate?.();
		await sleep(20);
		expect(test.requests).toHaveLength(1);
		expect(calls).toEqual([]);
		expect(test.rejectCalls).toEqual([]);
	});

	it("tRPC SSE: outside the audience it opens no EventSource and ignores rotation", async () => {
		const { test, connection, subscribe } = trpcSse({
			credentials: bearer,
			audience: () => false,
		});
		subscribe();
		await waitFor(() => test.hasStatus("auth-blocked"), { timeout: 1_000 });
		expect(statusOf(test).reason).toBe("credentials-audience");
		connection.rotate?.();
		await sleep(20);
		expect(test.requests).toHaveLength(1);
		expect(ScriptedEventSource.instances).toHaveLength(0);
		expect(test.rejectCalls).toEqual([]);
	});
});

describe("a rejection names the attached grant, and only when material was attached", () => {
	it("graphql-ws 4401 rejects the exact grant object that was sent", async () => {
		const grants: Credentials[] = [];
		const { test } = graphqlWs({
			credentials: (revision) => {
				const grant = { connectionParams: { token: `t${revision}` } };
				grants.push(grant);
				return grant;
			},
		});
		const socket = await acceptedSocket();
		socket.serverClose(4401);
		await waitFor(() => test.hasStatus("auth-blocked"), { timeout: 1_000 });
		expect(statusOf(test)).toEqual({
			state: "auth-blocked",
			reason: "credentials-rejected",
			code: "close:4401",
		});
		expect(test.rejectCalls).toHaveLength(1);
		expect(test.rejectCalls[0]).toBe(grants[0]);
		expect(test.rejections).toEqual([1]);
	});

	it("graphql-ws 4401 rejects nothing when the grant had no connectionParams", async () => {
		const { test } = graphqlWs({ credentials: bearer });
		const socket = await acceptedSocket();
		expect(socket.sent[0]).toEqual({ type: "connection_init" });
		socket.serverClose(4401);
		await waitFor(() => test.hasStatus("auth-blocked"), { timeout: 1_000 });
		expect(statusOf(test)).toMatchObject({ code: "close:4401" });
		expect(test.rejectCalls).toEqual([]);
	});

	it("graphql-ws 4401 on an anonymous endpoint rejects nothing", async () => {
		const { test } = graphqlWs({ anonymous: true });
		const socket = await acceptedSocket();
		socket.serverClose(4401);
		await waitFor(() => test.hasStatus("auth-blocked"), { timeout: 1_000 });
		expect(test.rejectCalls).toEqual([]);
		expect(test.requests).toEqual([]);
	});

	it("graphql-sse: a late 401 for an old grant rejects that grant, not the newer one", async () => {
		let answer!: (response: Response) => void;
		const late = new Promise<Response>((resolve) => {
			answer = resolve;
		});
		const grants: Credentials[] = [];
		const { test, subscribe, calls } = graphqlSse(
			(index) => (index === 0 ? late : sseStream()),
			{
				credentials: (revision) => {
					const grant = bearer(revision);
					grants.push(grant);
					return grant;
				},
			},
		);
		subscribe("subscription { a }");
		await waitFor(() => calls.length === 1, { timeout: 1_000 });
		test.setRevision(2);
		subscribe("subscription { b }");
		await waitFor(() => calls.length === 2, { timeout: 1_000 });
		expect(calls[1]?.headers.authorization).toBe("Bearer t2");
		answer(new Response(null, { status: 401 }));
		await waitFor(() => test.hasStatus("auth-blocked"), { timeout: 1_000 });
		expect(test.rejectCalls).toHaveLength(1);
		expect(test.rejectCalls[0]).toBe(grants[0]);
		expect(test.rejections).toEqual([1]);
	});

	it("graphql-sse 401 rejects nothing when no provider header was attached", async () => {
		const { test, subscribe } = graphqlSse(
			() => new Response(null, { status: 401 }),
			{ credentials: () => ({ connectionParams: { token: "ws-only" } }) },
		);
		subscribe();
		await waitFor(() => test.hasStatus("auth-blocked"), { timeout: 1_000 });
		expect(statusOf(test)).toEqual({
			state: "auth-blocked",
			reason: "credentials-rejected",
			code: "http:401",
		});
		expect(test.rejectCalls).toEqual([]);
	});

	it("tRPC SSE UNAUTHORIZED and HTTP 401 reject the attached grant", async () => {
		for (const fail of [
			(source: ScriptedEventSource) => source.trpcError("UNAUTHORIZED", -32001),
			(source: ScriptedEventSource) => source.failWith(401),
		]) {
			ScriptedEventSource.instances = [];
			const grants: Credentials[] = [];
			const { test, subscribe } = trpcSse({
				credentials: (revision) => {
					const grant = bearer(revision);
					grants.push(grant);
					return grant;
				},
			});
			subscribe();
			const source = await lastEventSource();
			fail(source);
			await waitFor(() => test.hasStatus("auth-blocked"), { timeout: 1_000 });
			expect(statusOf(test).reason).toBe("credentials-rejected");
			expect(test.rejectCalls).toHaveLength(1);
			expect(test.rejectCalls[0]).toBe(grants[0]);
		}
	});

	it("tRPC SSE without header credentials rejects nothing on UNAUTHORIZED", async () => {
		const { test, subscribe } = trpcSse({
			credentials: bearer,
			headers: false,
		});
		subscribe();
		const source = await lastEventSource();
		source.trpcError("UNAUTHORIZED", -32001);
		await waitFor(() => test.hasStatus("auth-blocked"), { timeout: 1_000 });
		expect(statusOf(test)).toMatchObject({ code: "trpc:UNAUTHORIZED" });
		expect(test.requests).toEqual([]);
		expect(test.rejectCalls).toEqual([]);
	});
});

describe("forbidden ends as permanent-error with code forbidden and rejects nothing", () => {
	const FORBIDDEN = {
		state: "failed",
		reason: "permanent-error",
		code: "forbidden",
	};

	it("graphql-ws 4403", async () => {
		const { test, feed } = graphqlWs({
			credentials: () => ({ connectionParams: { token: "t" } }),
		});
		const socket = await acceptedSocket();
		socket.serverClose(4403);
		await waitFor(() => test.hasStatus("failed"), { timeout: 1_000 });
		await sleep(20);
		expect(statusOf(test)).toEqual(FORBIDDEN);
		expect(FakeWebSocket.instances).toHaveLength(1);
		expect(test.rejectCalls).toEqual([]);
		expect(feed.errors).toEqual([]);
	});

	it("graphql-sse 403", async () => {
		const { test, subscribe, calls } = graphqlSse(
			() => new Response(null, { status: 403 }),
			{ credentials: bearer },
		);
		subscribe();
		await waitFor(() => test.hasStatus("failed"), { timeout: 1_000 });
		await sleep(20);
		expect(statusOf(test)).toEqual(FORBIDDEN);
		expect(calls).toHaveLength(1);
		expect(test.rejectCalls).toEqual([]);
	});

	it("tRPC SSE HTTP 403 ends the connection", async () => {
		ScriptedEventSource.instances = [];
		const { test, subscribe } = trpcSse({ credentials: bearer });
		subscribe();
		(await lastEventSource()).failWith(403);
		await waitFor(() => test.hasStatus("failed"), { timeout: 1_000 });
		expect(statusOf(test)).toEqual(FORBIDDEN);
		expect(test.rejectCalls).toEqual([]);
	});

	it("a tRPC procedure FORBIDDEN ends that subscription only", async () => {
		ScriptedEventSource.instances = [];
		const { test, subscribe } = trpcSse({ credentials: bearer });
		const denied = subscribe({ path: "room", input: { room: "staff" } });
		const first = await lastEventSource();
		const allowed = subscribe({ path: "room", input: { room: "lobby" } });
		const second = await lastEventSource(2);
		first.trpcError("FORBIDDEN", -32003);
		await waitFor(() => denied.errors.length === 1, { timeout: 1_000 });
		expect(denied.errors[0]).toMatchObject({
			code: "upstream-error",
			detail: { trpcCode: "FORBIDDEN" },
		});
		await sleep(20);
		expect(test.hasStatus("failed")).toBe(false);
		expect(second.readyState).not.toBe(2);
		expect(allowed.errors).toEqual([]);
		expect(test.rejectCalls).toEqual([]);
	});
});

describe("requests that carry provider headers refuse redirects", () => {
	it("graphql-sse sets redirect: manual only when provider headers are attached", async () => {
		const withHeaders = graphqlSse(() => sseStream(), { credentials: bearer });
		withHeaders.subscribe();
		await waitFor(() => withHeaders.calls.length === 1, { timeout: 1_000 });
		expect(withHeaders.calls[0]?.headers.authorization).toBe("Bearer t1");
		expect(withHeaders.calls[0]?.redirect).toBe("manual");

		const anonymous = graphqlSse(() => sseStream(), { anonymous: true });
		anonymous.subscribe();
		await waitFor(() => anonymous.calls.length === 1, { timeout: 1_000 });
		expect(anonymous.calls[0]?.redirect).toBeUndefined();

		const noHeaders = graphqlSse(() => sseStream(), {
			credentials: () => ({ connectionParams: { token: "ws-only" } }),
		});
		noHeaders.subscribe();
		await waitFor(() => noHeaders.calls.length === 1, { timeout: 1_000 });
		expect(noHeaders.calls[0]?.redirect).toBeUndefined();
	});

	it("graphql-sse ends a refused redirect as permanent-error / redirect", async () => {
		for (const status of [302, 0]) {
			const { test, subscribe, calls } = graphqlSse(
				() =>
					status === 0
						? // A browser's opaqueredirect; `new Response` cannot build status 0.
							({ status: 0, ok: false, headers: new Headers() } as Response)
						: new Response(null, { status, headers: { location: "/x" } }),
				{ credentials: bearer },
			);
			subscribe();
			await waitFor(() => test.hasStatus("failed"), { timeout: 1_000 });
			await sleep(20);
			expect(statusOf(test)).toEqual({
				state: "failed",
				reason: "permanent-error",
				code: "redirect",
			});
			expect(calls).toHaveLength(1);
			expect(test.rejectCalls).toEqual([]);
		}
	});

	it("tRPC SSE ends a refused redirect as permanent-error / redirect", async () => {
		for (const status of [302, 0]) {
			ScriptedEventSource.instances = [];
			const { test, subscribe } = trpcSse({ credentials: bearer });
			subscribe();
			(await lastEventSource()).failWith(status);
			await waitFor(() => test.hasStatus("failed"), { timeout: 1_000 });
			await sleep(20);
			expect(statusOf(test)).toEqual({
				state: "failed",
				reason: "permanent-error",
				code: "redirect",
			});
			expect(ScriptedEventSource.instances).toHaveLength(1);
			expect(test.rejectCalls).toEqual([]);
		}
	});

	it("tRPC SSE passes redirect: manual with provider headers only", async () => {
		const withHeaders = trpcSse({ credentials: bearer });
		withHeaders.subscribe();
		const source = await lastEventSource();
		expect(source.init).toMatchObject({
			headers: { authorization: "Bearer t1" },
			redirect: "manual",
		});

		ScriptedEventSource.instances = [];
		const cookies = trpcSse({ credentials: bearer, headers: false });
		cookies.subscribe();
		const plain = await lastEventSource();
		expect(plain.init.redirect).toBeUndefined();
		expect(plain.init.headers).toBeUndefined();
	});
});

describe("no upstream text in statuses, diagnostics or other subscribers", () => {
	it("graphql-sse protocol failures are a fixed diagnostic with no message", async () => {
		const { test, subscribe } = graphqlSse(
			() =>
				new Response("event: next\ndata: {secret-value\n\n", {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
			{ anonymous: true },
		);
		subscribe();
		await waitFor(
			() =>
				test.diagnostics.some((d) => d.type === "graphql-sse.protocol-error"),
			{ timeout: 1_000 },
		);
		const diagnostic = test.diagnostics.find(
			(d) => d.type === "graphql-sse.protocol-error",
		);
		expect(diagnostic).toEqual({ type: "graphql-sse.protocol-error" });
		expect(JSON.stringify(test.statuses)).not.toContain("secret");
	});

	it("a tRPC procedure error reaches only its own subscriber, bounded and without a stack", async () => {
		const { test, subscribe } = trpcSse({ credentials: bearer });
		const owner = subscribe({ path: "ticks", input: { room: "a" } });
		const first = await lastEventSource(1);
		const other = subscribe({ path: "ticks", input: { room: "b" } });
		await lastEventSource(2);
		first.trpcError("BAD_REQUEST", -32600, `bad ${"x".repeat(400)}`);
		await waitFor(() => owner.errors.length === 1, { timeout: 1_000 });
		const [error] = owner.errors;
		expect(error?.code).toBe("upstream-error");
		expect(error?.message.length).toBeLessThanOrEqual(120);
		const shape = (error?.detail as { shape?: Record<string, unknown> })
			?.shape as { message?: string; data?: Record<string, unknown> };
		expect(shape.message?.length).toBeLessThanOrEqual(120);
		expect(shape.data?.code).toBe("BAD_REQUEST");
		expect(shape.data).not.toHaveProperty("stack");
		expect(other.errors).toEqual([]);
		expect(JSON.stringify(test.statuses)).not.toContain("xxxx");
		expect(JSON.stringify(test.diagnostics)).not.toContain("xxxx");
	});

	it("every string an errorFormatter adds to a tRPC shape is bounded", async () => {
		const { subscribe } = trpcSse({ credentials: bearer });
		let count = 0;
		// Each error ends its subscription, so each case gets its own.
		const shapeOf = async (data: Record<string, unknown>) => {
			count += 1;
			const owner = subscribe({ path: "ticks", input: { n: count } });
			const source = await lastEventSource(count);
			source.fire("serialized-error", {
				data: JSON.stringify({ code: -32600, message: "bad input", data }),
			});
			await waitFor(() => owner.errors.length === 1, { timeout: 1_000 });
			return (owner.errors[0]?.detail as { shape?: unknown }).shape;
		};
		const strings: string[] = [];
		const walk = (value: unknown): void => {
			if (typeof value === "string") strings.push(value);
			else if (value && typeof value === "object")
				for (const item of Object.values(value)) walk(item);
		};
		walk(
			await shapeOf({
				code: "BAD_REQUEST",
				zodError: { formErrors: [`upstream ${"y".repeat(5_000)}`] },
			}),
		);
		expect(Math.max(...strings.map((item) => item.length))).toBeLessThanOrEqual(
			120,
		);
		// Many short strings: the shape keeps only its codes.
		const large = await shapeOf({
			code: "BAD_REQUEST",
			httpStatus: 400,
			issues: Array.from({ length: 500 }, (_, index) => `issue ${index}`),
		});
		expect(large).toEqual({
			code: -32600,
			message: "bad input",
			data: { code: "BAD_REQUEST", httpStatus: 400 },
		});
	});
});

describe("tRPC: resumed only when a cursor was conveyed for a tracked procedure", () => {
	it("an object input carries the cursor: resumed-with-cursor", async () => {
		const { subscribe } = trpcSse({ credentials: bearer });
		const feed = subscribe({
			path: "ticks",
			input: { room: "a" },
			lastEventId: "7",
			replay: true,
		});
		const source = await lastEventSource();
		expect(source.url).toContain("lastEventId");
		source.connected();
		await waitFor(() => feed.continuity.length === 1, { timeout: 1_000 });
		expect(feed.continuity).toEqual([
			{ reason: "resumed-with-cursor", cursor: "7" },
		]);
	});

	it("a non-object input cannot carry the cursor: never resumed", async () => {
		const { subscribe } = trpcSse({ credentials: bearer });
		const feed = subscribe({
			path: "ticks",
			input: "room-a",
			lastEventId: "7",
			replay: true,
		});
		const source = await lastEventSource();
		expect(source.url).not.toContain("lastEventId");
		source.connected();
		await waitFor(() => feed.started === 1, { timeout: 1_000 });
		await sleep(10);
		expect(feed.continuity).toEqual([]);
	});
});
