import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterConnection } from "../../../src/core/adapter.ts";
import { SpinetabError } from "../../../src/core/errors.ts";
import { stableStringify } from "../../../src/core/identity.ts";
import { toRequest } from "../../../src/core/source.ts";
import type {
	Source,
	SpinetabClient,
	SpinetabErrorCode,
} from "../../../src/core/types.ts";
import { resolveEndpoint } from "../../../src/core/url.ts";
import { trpcSseAdapter } from "../../../src/integrations/trpc/runtime.ts";
import { graphqlSse } from "../../../src/protocols/graphql-sse/index.ts";
import { graphqlSseAdapter } from "../../../src/protocols/graphql-sse/runtime.ts";
import { graphqlWs } from "../../../src/protocols/graphql-ws/index.ts";
import { socketIo } from "../../../src/protocols/socket-io/index.ts";
import { socketIoAdapter } from "../../../src/protocols/socket-io/runtime.ts";
import {
	createRecordingSink,
	createTestContext,
	sleep,
	type TestContext,
	waitFor,
} from "../../integration/protocols/helpers.ts";

const fake = vi.hoisted(() => {
	type Listener = (...args: unknown[]) => void;

	class Emitter {
		readonly handlers = new Map<string, Set<Listener>>();
		on(event: string, listener: Listener): this {
			let set = this.handlers.get(event);
			if (!set) {
				set = new Set();
				this.handlers.set(event, set);
			}
			set.add(listener);
			return this;
		}
		off(event: string, listener: Listener): this {
			this.handlers.get(event)?.delete(listener);
			return this;
		}
		removeAllListeners(): this {
			this.handlers.clear();
			return this;
		}
		fire(event: string, ...args: unknown[]): void {
			for (const listener of [...(this.handlers.get(event) ?? [])]) {
				listener(...args);
			}
		}
		count(event: string): number {
			return this.handlers.get(event)?.size ?? 0;
		}
	}

	class FakeSocket extends Emitter {
		auth: ((callback: (data: object) => void) => void) | undefined;
		active = false;
		connected = false;
		recovered = false;
		readonly sendBuffer: unknown[] = [];
		readonly emitted: Array<{ event: string; args: unknown[] }> = [];
		constructor(readonly nsp: string) {
			super();
		}
		connect(): this {
			this.active = true;
			return this;
		}
		disconnect(): this {
			this.active = false;
			this.connected = false;
			return this;
		}
		timeout(): this {
			return this;
		}
		emit(event: string, ...args: unknown[]): this {
			this.emitted.push({ event, args });
			const ack = args.at(-1);
			if (typeof ack === "function") ack(null);
			return this;
		}
		serverConnect(): void {
			this.connected = true;
			this.fire("connect");
		}
	}

	class FakeManager extends Emitter {
		static readonly instances: FakeManager[] = [];
		readonly nsps = new Map<string, FakeSocket>();
		engine = undefined;
		constructor(
			readonly uri: string,
			readonly opts: Record<string, unknown>,
		) {
			super();
			FakeManager.instances.push(this);
		}
		socket(nsp: string): FakeSocket {
			let socket = this.nsps.get(nsp);
			if (!socket) {
				socket = new FakeSocket(nsp);
				this.nsps.set(nsp, socket);
			}
			return socket;
		}
		open(): this {
			return this;
		}
	}

	return { FakeManager };
});

vi.mock("socket.io-client", () => ({ Manager: fake.FakeManager }));

const managers = fake.FakeManager.instances;
const connections: AdapterConnection[] = [];

beforeEach(() => {
	managers.length = 0;
});
afterEach(() => {
	for (const connection of connections.splice(0)) connection.dispose();
});

const PAGE = "https://app.test/dir/page";

/** What the page client sends: the connection with its URL resolved (CR:76). */
function resolved<T extends { url: string }>(connection: T): T {
	return { ...connection, url: resolveEndpoint(connection.url, PAGE) };
}

function openSocket(
	adapter: ReturnType<typeof socketIoAdapter>,
	spec: object,
	test: TestContext = createTestContext({
		credentials: () => ({ auth: { token: "t" } }),
	}),
) {
	const connection = adapter.connect(
		{ sharing: "shared", ...spec } as never,
		test.ctx,
	);
	connections.push(connection);
	return connection;
}

// Type-level checks: compiled by `pnpm --filter spinetab typecheck`, never run.
function typeChecks(): void {
	// @ts-expect-error sharing stays required: the URL-first options are required
	socketIo("/chat");
	// @ts-expect-error sharing stays required in the URL-first options
	socketIo("/chat", {});
	// @ts-expect-error the URL goes in the first argument only
	graphqlWs("/g", { url: "/x" });
	// @ts-expect-error the URL goes in the first argument only
	graphqlSse("/g", { url: "/x" });
	const mode: "distinct" | "single" | undefined =
		graphqlSse("/g").connection.mode;
	void mode;
}

// An endpoint must be narrowed to a subscription before it is used as a source.
// Typechecking verifies each rejection through the directives below.
function endpointAsSourceTypeChecks(client: SpinetabClient): void {
	// @ts-expect-error a GraphQL endpoint's selection is not total
	const gql: Source = graphqlWs("/g");
	// @ts-expect-error a Socket.IO endpoint's selection is not total
	const sio: Source = socketIo("/chat", { sharing: "shared" });
	// @ts-expect-error a GraphQL endpoint is not a source for subscribe()
	client.subscribe(graphqlSse("/g"), () => {});
	void [gql, sio];
}

describe("verify both builder forms give one canonical connection", () => {
	it("type-level checks are compiled by the typecheck", () => {
		expect([typeChecks, endpointAsSourceTypeChecks]).toHaveLength(2);
	});

	const operation = { query: "subscription { a }", variables: { x: 1 } };

	it("graphqlWs, for every option set, including requests", () => {
		const sets = [
			undefined,
			{},
			{ keepAliveMs: 10_000 },
			{ anonymous: true, connectionParams: { tenant: "a" } },
		];
		for (const options of sets) {
			const urlFirst = graphqlWs("/graphql", options);
			const object = graphqlWs({ url: "/graphql", ...options });
			expect(urlFirst.connection).toEqual(object.connection);
			expect(stableStringify(urlFirst.connection)).toBe(
				stableStringify(object.connection),
			);
			expect(urlFirst.subscription(operation, { scope: "s" })).toEqual(
				object.subscription(operation, { scope: "s" }),
			);
		}
	});

	it("graphqlWs never mutates the caller's options and the first argument wins", () => {
		const options = { keepAliveMs: 10_000 };
		graphqlWs("/g", options);
		expect(options).toEqual({ keepAliveMs: 10_000 });
		expect(graphqlWs("/a", { url: "/b" } as never).connection.url).toBe("/a");
	});

	it("graphqlSse: omitted, undefined and explicit distinct are one canonical connection in both forms", () => {
		const forms = [
			graphqlSse("/g"),
			graphqlSse("/g", {}),
			graphqlSse("/g", { mode: undefined }),
			graphqlSse("/g", { mode: "distinct" }),
			graphqlSse({ url: "/g" }),
			graphqlSse({ url: "/g", mode: undefined }),
			graphqlSse({ url: "/g", mode: "distinct" }),
		];
		const keys = new Set(forms.map((form) => stableStringify(form.connection)));
		expect([...keys]).toEqual([
			stableStringify({ url: "/g", mode: "distinct" }),
		]);
		for (const form of forms) {
			expect(form.subscription(operation)).toEqual(
				forms[0]?.subscription(operation),
			);
		}
		expect(graphqlSse("/g", { mode: "single" }).connection).toEqual(
			graphqlSse({ url: "/g", mode: "single" }).connection,
		);
	});

	it("graphqlSse never writes the default into the caller's objects", () => {
		const connection = { url: "/g" };
		const options = {};
		graphqlSse(connection);
		graphqlSse("/g", options);
		expect(connection).toEqual({ url: "/g" });
		expect(options).toEqual({});
	});

	it("socketIo: connections, subscriptions and commands are identical in both forms", () => {
		const sets = [
			{ sharing: "shared" as const },
			{ sharing: "per-tab" as const },
			{ sharing: "shared" as const, path: "/api/socket.io", anonymous: true },
			{ sharing: "shared" as const, namespace: "/chat" },
		];
		for (const options of sets) {
			const url = options.namespace ? "/" : "/chat";
			const urlFirst = socketIo(url, options);
			const object = socketIo({ url, ...options });
			expect(urlFirst.connection).toEqual(object.connection);
			const listen = {
				event: "message",
				membership: "room-1",
				route: "byRoom",
			};
			expect(urlFirst.subscription(listen)).toEqual(
				object.subscription(listen),
			);
			// A membership without a route gets its own identity in both forms.
			expect(
				urlFirst.subscription({ event: "message", membership: "r" }),
			).toEqual(object.subscription({ event: "message", membership: "r" }));
			expect(urlFirst.command({ event: "send", args: [1] })).toEqual(
				object.command({ event: "send", args: [1] }),
			);
		}
	});

	it("socketIo(url) without options keeps the existing sharing message", () => {
		const call = () =>
			(socketIo as unknown as (url: string) => unknown)("/chat");
		expect(call).toThrowError(
			expect.objectContaining({
				code: "unsupported-option",
				message:
					'socketIo.sharing: declare "shared" (one socket for every tab) or "per-tab" (one socket per tab).',
				detail: { path: "socketIo.sharing" },
			}),
		);
	});

	it("an endpoint used as a source fails synchronously with unsupported-option and a path", () => {
		const endpoints = [
			graphqlWs("/g"),
			graphqlSse("/g"),
			socketIo("/chat", { sharing: "shared" }),
		];
		for (const endpoint of endpoints) {
			expect(() => toRequest(endpoint as never, "source")).toThrowError(
				expect.objectContaining({
					code: "unsupported-option",
					detail: expect.objectContaining({ path: "subscription" }),
				}),
			);
		}
	});
});

describe("verify graphql-sse mode identity in the runtime", () => {
	const adapter = graphqlSseAdapter();

	it("page-built and raw connections share one key for omitted, undefined and distinct", () => {
		const url = "https://api.test/graphql/stream";
		const keys = new Set(
			[
				resolved(graphqlSse(url).connection),
				resolved(graphqlSse({ url: "/graphql/stream" }).connection),
				{ url },
				{ url, mode: undefined },
				{ url, mode: "distinct" as const },
				// Structured clone keeps an `undefined` member of a raw request.
				structuredClone({ url, mode: undefined }),
			].map((spec) => {
				adapter.validateConnection?.(spec);
				return adapter.connectionKey?.(spec);
			}),
		);
		expect(keys.size).toBe(2); // api.test vs app.test origins
		expect(adapter.connectionKey?.({ url, mode: "single" })).not.toBe(
			adapter.connectionKey?.({ url }),
		);
	});

	it("a same-origin raw and page-built connection are one key", () => {
		const page = resolved(graphqlSse("/graphql/stream").connection);
		expect(adapter.connectionKey?.(page)).toBe(
			adapter.connectionKey?.({ url: "https://app.test/graphql/stream" }),
		);
	});
});

describe("verify Socket.IO namespace from the URL path", () => {
	const adapter = socketIoAdapter();
	const key = (spec: object) =>
		adapter.connectionKey?.({ sharing: "shared", ...spec } as never);

	it("path, explicit, root-slash and matching forms are one identity", () => {
		const one = new Set(
			[
				{ url: "https://h.test/chat" },
				{ url: "https://h.test", namespace: "/chat" },
				{ url: "https://h.test/", namespace: "/chat" },
				{ url: "https://h.test/chat", namespace: "/chat" },
				{ url: "https://h.test:443/chat" },
				{ url: "https://h.test/chat#fragment" },
			].map(key),
		);
		expect(one.size).toBe(1);
		expect(key({ url: "https://h.test/ops" })).not.toBe(
			key({ url: "https://h.test/chat" }),
		);
		const root = new Set(
			[
				{ url: "https://h.test" },
				{ url: "https://h.test/" },
				{ url: "https://h.test", namespace: "/" },
				{ url: "https://h.test/", namespace: undefined },
			].map(key),
		);
		expect(root.size).toBe(1);
	});

	it("a URL query stays identity-bearing and moves with the Manager URI", () => {
		expect(key({ url: "https://h.test/chat?t=a" })).toBe(
			key({ url: "https://h.test?t=a", namespace: "/chat" }),
		);
		expect(key({ url: "https://h.test/chat?t=a" })).not.toBe(
			key({ url: "https://h.test/chat?t=b" }),
		);
	});

	it("the page and runtime conflict messages are exact and name both options", () => {
		expect(() =>
			socketIo("https://h.test/chat", { namespace: "/ops", sharing: "shared" }),
		).toThrowError(
			expect.objectContaining({
				code: "unsupported-option",
				message:
					"socketIo.namespace: differs from the path of socketIo.url. Set only one; a proxy prefix goes in socketIo.path.",
				detail: { path: "socketIo.namespace" },
			}),
		);
		expect(() =>
			socketIo("/chat", { namespace: "/", sharing: "shared" }),
		).toThrow("socketIo.namespace: differs");
		expect(() =>
			adapter.validateConnection?.({
				url: "https://h.test/chat",
				namespace: "/ops",
				sharing: "shared",
			}),
		).toThrowError(
			expect.objectContaining({
				code: "unsupported-option",
				message:
					"connection.namespace: differs from the path of connection.url. Set only one; a proxy prefix goes in connection.path.",
				detail: { path: "connection.namespace" },
			}),
		);
	});

	it("a document-relative URL is checked by the runtime after the page resolves it", () => {
		const endpoint = socketIo("chat", {
			namespace: "/chat",
			sharing: "shared",
		});
		const spec = resolved(endpoint.connection);
		expect(spec.url).toBe("https://app.test/dir/chat");
		expect(() => adapter.validateConnection?.(spec)).toThrow(
			"connection.namespace: differs",
		);
	});

	it("namespaces of one origin share one Manager; a replacement handle on a surviving Manager works", async () => {
		const shared = socketIoAdapter();
		const chat = openSocket(shared, { url: "https://h.test/chat" });
		openSocket(shared, { url: "https://h.test/ops" });
		expect(managers).toHaveLength(1);
		chat.dispose();
		const replacement = openSocket(shared, { url: "https://h.test/chat" });
		expect(managers).toHaveLength(1);
		const socket = managers[0]?.socket("/chat");
		let payload: object | undefined;
		// socket.io-client asks for `auth` only while an active socket
		// handshakes (`Socket.onopen`); the answer is fenced to that.
		socket?.connect();
		socket?.auth?.((data) => {
			payload = data;
		});
		await waitFor(() => payload !== undefined, { timeout: 1_000 });
		expect(payload).toEqual({ token: "t" });
		const recording = createRecordingSink<unknown[]>();
		replacement.subscribe({ event: "tick" }, recording.sink, {
			key: "k",
			repeatable: true,
		});
		socket?.serverConnect();
		socket?.fire("tick", 1);
		expect(recording.events).toEqual([[1]]);
		expect(socket?.count("tick")).toBe(1);
	});

	it("scope, per-tab and route-less membership still get their own Manager", () => {
		const shared = socketIoAdapter();
		openSocket(shared, { url: "https://h.test/chat" });
		openSocket(
			shared,
			{ url: "https://h.test/chat" },
			createTestContext({ scope: "other", credentials: () => ({}) }),
		);
		openSocket(shared, {
			url: "https://h.test/chat",
			sharing: "per-tab",
			tab: "t1",
		});
		openSocket(shared, { url: "https://h.test/chat", membership: "r1" });
		expect(managers).toHaveLength(4);
		for (const manager of managers) {
			expect([...manager.nsps.keys()]).toEqual(["/chat"]);
		}
	});

	it("as upstream io(): a path WHATWG percent-encodes is still the namespace as written", () => {
		// socket.io-client 4.8.4 url(): io("https://h.test/ä") joins "/ä" and
		// io("https://h.test/a b") joins "/a b" (engine.io-client parse keeps
		// the raw path). The page resolves the URL first (resolveEndpoint).
		const shared = socketIoAdapter();
		openSocket(
			shared,
			resolved(socketIo("https://h.test/ä", { sharing: "shared" }).connection),
		);
		expect([...(managers[0]?.nsps.keys() ?? [])]).toEqual(["/ä"]);
	});

	it("the path form and the explicit form of a non-ASCII namespace are one identity and do not conflict", () => {
		expect(() =>
			socketIo("https://h.test/ä", { namespace: "/ä", sharing: "shared" }),
		).not.toThrow();
		const pathForm = resolved(
			socketIo("https://h.test/ä", { sharing: "shared" }).connection,
		);
		const explicit = resolved(
			socketIo("https://h.test", { namespace: "/ä", sharing: "shared" })
				.connection,
		);
		expect(key(pathForm)).toBe(key(explicit));
	});
});

describe("verify routing keys per distinct route", () => {
	type Row = { room: string; owner: string; n: number };

	function setup() {
		const calls = { byRoom: 0, byOwner: 0, broken: 0 };
		const adapter = socketIoAdapter({
			routes: {
				byRoom: (args) => {
					calls.byRoom += 1;
					return [(args[0] as Row).room];
				},
				byOwner: (args) => {
					calls.byOwner += 1;
					const row = args[0] as Row;
					return row.owner === "nobody" ? undefined : [row.owner];
				},
				broken: () => {
					calls.broken += 1;
					throw new Error("route failed");
				},
			},
		});
		const test = createTestContext({ credentials: () => ({ auth: {} }) });
		const connection = openSocket(adapter, { url: "https://h.test" }, test);
		const listen = (spec: {
			membership?: string;
			route?: string;
			join?: { event: string };
		}) => {
			const recording = createRecordingSink<unknown[]>();
			connection.subscribe({ event: "row", ...spec }, recording.sink, {
				key: JSON.stringify(spec),
				repeatable: true,
			});
			return recording;
		};
		return { calls, test, listen };
	}

	const seen = (recording: { events: unknown[][] }) =>
		recording.events.map((args) => (args[0] as Row).n);

	it("the first record's route never decides for later records (reverse order)", () => {
		const { calls, listen } = setup();
		const alice = listen({ membership: "alice", route: "byOwner" });
		const r1 = listen({ membership: "r1", route: "byRoom" });
		const r1b = listen({ membership: "r1", route: "byRoom" });
		const r2 = listen({ membership: "r2", route: "byRoom" });
		const all = listen({});
		const socket = managers[0]?.socket("/");
		socket?.serverConnect();
		const emit = (room: string, owner: string, n: number) =>
			socket?.fire("row", { room, owner, n });
		emit("r1", "bob", 1);
		emit("r2", "alice", 2);
		emit("r1", "nobody", 3);
		emit("r9", "carol", 4);
		expect(seen(alice)).toEqual([2]);
		expect(seen(r1)).toEqual([1, 3]);
		expect(seen(r1b)).toEqual([1, 3]);
		expect(seen(r2)).toEqual([2]);
		expect(seen(all)).toEqual([1, 2, 3, 4]);
		expect(calls).toEqual({ byRoom: 4, byOwner: 4, broken: 0 });
	});

	it("a failing route affects only its own records and reports once per event", () => {
		const { calls, test, listen } = setup();
		const bad = listen({ membership: "x", route: "broken" });
		const bad2 = listen({ membership: "y", route: "broken" });
		const r1 = listen({ membership: "r1", route: "byRoom" });
		const socket = managers[0]?.socket("/");
		socket?.serverConnect();
		socket?.fire("row", { room: "r1", owner: "a", n: 1 });
		expect(seen(bad)).toEqual([]);
		expect(seen(bad2)).toEqual([]);
		expect(seen(r1)).toEqual([1]);
		expect(calls.broken).toBe(1);
		expect(
			test.diagnostics.filter((d) => d.type === "socket-io.route-failed"),
		).toHaveLength(1);
	});
});

describe("verify a failed provider never reads anonymously", () => {
	const TRANSIENT: SpinetabErrorCode[] = [
		"credentials-failed",
		"credentials-timeout",
	];
	const failing = (code: SpinetabErrorCode) => () => {
		throw new SpinetabError(code, "The credentials provider failed.");
	};

	it("tRPC SSE with credential headers opens no EventSource", async () => {
		for (const code of TRANSIENT) {
			let created = 0;
			class CountingEventSource {
				readonly readyState = 0;
				constructor() {
					created += 1;
				}
				addEventListener(): void {}
				removeEventListener(): void {}
				close(): void {}
			}
			const test = createTestContext({ credentials: failing(code) });
			const connection = trpcSseAdapter({
				EventSource: CountingEventSource,
				headers: true,
			}).connect({ url: "https://api.test/trpc" }, test.ctx);
			connections.push(connection as AdapterConnection);
			connection.subscribe(
				{ path: "ticks" },
				createRecordingSink<never>().sink,
				{ key: "k", repeatable: true },
			);
			await waitFor(() => test.hasStatus("auth-blocked"), { timeout: 2_000 });
			await sleep(20);
			expect(
				{
					state: test.lastStatus()?.state,
					reason: test.lastStatus()?.reason,
					created,
					rejections: test.rejections.length,
				},
				code,
			).toEqual({
				state: "auth-blocked",
				reason: "credentials-missing",
				created: 0,
				rejections: 0,
			});
		}
	});

	it("graphql-sse single mode sends no request", async () => {
		for (const code of TRANSIENT) {
			let calls = 0;
			const test = createTestContext({ credentials: failing(code) });
			const connection = graphqlSseAdapter({
				fetchFn: (async () => {
					calls += 1;
					return new Response(null, { status: 500 });
				}) as typeof fetch,
				retry: async () => {},
			}).connect(
				{ url: "https://api.test/graphql/stream", mode: "single" },
				test.ctx,
			);
			connections.push(connection);
			connection.subscribe(
				{ query: "subscription { a }" },
				createRecordingSink<unknown>().sink,
				{ key: "k", repeatable: true },
			);
			await waitFor(() => test.hasStatus("auth-blocked"), { timeout: 2_000 });
			await sleep(20);
			expect({ reason: test.lastStatus()?.reason, calls }, code).toEqual({
				reason: "credentials-missing",
				calls: 0,
			});
		}
	});

	it("Socket.IO: retry and rotate after a failure still never send an empty auth payload", async () => {
		let fail = true;
		const test = createTestContext({
			credentials: () => {
				if (fail) {
					throw new SpinetabError(
						"credentials-failed",
						"The credentials provider failed.",
					);
				}
				return { auth: { token: "fresh" } };
			},
		});
		const connection = openSocket(
			socketIoAdapter(),
			{ url: "https://h.test/chat" },
			test,
		);
		connection.subscribe({ event: "tick" }, createRecordingSink().sink, {
			key: "k",
			repeatable: true,
		});
		const socket = managers[0]?.socket("/chat");
		const payloads: object[] = [];
		const ask = () =>
			socket?.auth?.((data) => {
				payloads.push(data);
			});
		ask();
		await waitFor(() => test.hasStatus("auth-blocked"), { timeout: 1_000 });
		connection.retry?.();
		ask();
		await sleep(20);
		connection.rotate?.();
		ask();
		await sleep(20);
		expect(payloads).toEqual([]);
		expect(test.rejections).toEqual([]);
		fail = false;
		connection.retry?.();
		ask();
		await waitFor(() => payloads.length > 0, { timeout: 1_000 });
		expect(payloads).toEqual([{ token: "fresh" }]);
	});
});
