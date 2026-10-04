import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { toRequest } from "../../../src/core/source.ts";
import { graphqlSse } from "../../../src/protocols/graphql-sse/index.ts";
import { graphqlSseAdapter } from "../../../src/protocols/graphql-sse/runtime.ts";
import { graphqlWs } from "../../../src/protocols/graphql-ws/index.ts";
import { graphqlWsAdapter } from "../../../src/protocols/graphql-ws/runtime.ts";
import { socketIo } from "../../../src/protocols/socket-io/index.ts";

// (source level), 002, 003, 017, 059 and.

const unsupported = (path: string) =>
	expect.objectContaining({
		code: "unsupported-option",
		detail: expect.objectContaining({ path }),
	});

describe("page builders produce plain, cloneable requests", () => {
	it("graphqlWs", () => {
		const request = graphqlWs({
			url: "/graphql",
			keepAliveMs: 10_000,
		}).subscription(
			{ query: "subscription { a }", variables: { x: 1, y: undefined } },
			{ scope: "team", repeatable: true },
		);
		expect(request).toEqual({
			adapter: "graphql-ws",
			connection: { url: "/graphql", keepAliveMs: 10_000 },
			subscription: { query: "subscription { a }", variables: { x: 1 } },
			scope: "team",
			repeatable: true,
		});
		expect(structuredClone(request)).toEqual(request);
	});

	it("graphqlSse defaults mode to distinct and refuses credential headers", () => {
		expect(graphqlSse({ url: "/g" }).connection).toEqual({
			url: "/g",
			mode: "distinct",
		});
		expect(graphqlSse({ url: "/g" }).connection).toEqual(
			graphqlSse({ url: "/g", mode: "distinct" }).connection,
		);
		expect(() => graphqlSse({ url: "/g", mode: "both" } as never)).toThrowError(
			unsupported("graphqlSse.mode"),
		);
		expect(() =>
			graphqlSse({
				url: "/g",
				mode: "distinct",
				headers: { Authorization: "Bearer x" },
			}),
		).toThrowError(unsupported("graphqlSse.headers.Authorization"));
		const request = graphqlSse({
			url: "/g",
			mode: "single",
			headers: { "x-tenant": "a" },
		}).subscription({
			query: "subscription { a }",
		});
		expect(request.connection).toEqual({
			url: "/g",
			mode: "single",
			headers: { "x-tenant": "a" },
		});
	});

	it("rejects unknown options with the option path and a zero ack wait", () => {
		expect(() => graphqlWs({ url: "/g", lazy: false } as never)).toThrowError(
			unsupported("graphqlWs.lazy"),
		);
		expect(() =>
			graphqlWs({ url: "/g", connectionAckWaitTimeoutMs: 0 }),
		).toThrowError(unsupported("graphqlWs.connectionAckWaitTimeoutMs"));
		expect(() =>
			graphqlWs({ url: "/g" }).subscription({
				query: "subscription { a }",
				variables: { d: new Date() },
			} as never),
		).toThrowError(unsupported("subscription.variables.d"));
	});

	it("runtime validators require absolute URLs without credentials", () => {
		const ws = graphqlWsAdapter();
		expect(() => ws.validateConnection?.({ url: "/graphql" })).toThrowError(
			expect.objectContaining({ code: "invalid-endpoint" }),
		);
		expect(() =>
			ws.validateConnection?.({ url: "wss://user:pw@api.test/g" }),
		).toThrowError(expect.objectContaining({ code: "invalid-endpoint" }));
		expect(() =>
			ws.validateConnection?.({ url: "https://api.test/g" }),
		).not.toThrow();
		const sse = graphqlSseAdapter();
		expect(() =>
			sse.validateConnection?.({ url: "wss://api.test/g", mode: "distinct" }),
		).toThrowError(expect.objectContaining({ code: "invalid-endpoint" }));
		// http and ws spellings of one endpoint are one identity.
		expect(ws.connectionKey?.({ url: "http://api.test/g" })).toBe(
			ws.connectionKey?.({ url: "ws://api.test/g" }),
		);
		// Defaults are part of identity: explicit default equals omitted.
		expect(
			ws.connectionKey?.({ url: "ws://api.test/g", keepAliveMs: 15_000 }),
		).toBe(ws.connectionKey?.({ url: "ws://api.test/g" }));
	});

	it("the graphql-sse adapter defaults mode, so omitted and distinct share one connection", () => {
		const sse = graphqlSseAdapter();
		const url = "https://api.test/graphql/stream";
		expect(() => sse.validateConnection?.({ url })).not.toThrow();
		expect(sse.connectionKey?.({ url })).toBe(
			sse.connectionKey?.({ url, mode: "distinct" }),
		);
		expect(sse.connectionKey?.({ url, mode: "single" })).not.toBe(
			sse.connectionKey?.({ url }),
		);
		expect(() => sse.validateConnection?.({ url, mode: "both" })).toThrowError(
			unsupported("connection.mode"),
		);
	});
});

describe("URL-first builders give the options form's canonical connection", () => {
	const operation = { query: "subscription { a }" };

	it("graphqlWs(url, options?)", () => {
		expect(graphqlWs("/graphql").connection).toEqual({ url: "/graphql" });
		const urlFirst = graphqlWs("/graphql", {
			keepAliveMs: 10_000,
			anonymous: true,
		});
		const object = graphqlWs({
			url: "/graphql",
			keepAliveMs: 10_000,
			anonymous: true,
		});
		expect(urlFirst.connection).toEqual(object.connection);
		expect(urlFirst.subscription(operation)).toEqual(
			object.subscription(operation),
		);
		// The first argument is the URL; a `url` key in options is a type error.
		expect(
			graphqlWs("/graphql", { url: "/other" } as never).connection,
		).toEqual({ url: "/graphql" });
		expect(() => graphqlWs("/g", { lazy: false } as never)).toThrowError(
			unsupported("graphqlWs.lazy"),
		);
		expect(() => graphqlWs("")).toThrowError(unsupported("graphqlWs.url"));
	});

	it("graphqlSse(url, options?)", () => {
		expect(graphqlSse("/graphql/stream").connection).toEqual(
			graphqlSse({ url: "/graphql/stream", mode: "distinct" }).connection,
		);
		expect(
			graphqlSse("/g", { mode: "single", headers: { "x-tenant": "a" } })
				.connection,
		).toEqual(
			graphqlSse({ url: "/g", mode: "single", headers: { "x-tenant": "a" } })
				.connection,
		);
		expect(graphqlSse("/g").subscription(operation)).toEqual(
			graphqlSse({ url: "/g" }).subscription(operation),
		);
		expect(() =>
			graphqlSse("/g", { headers: { Authorization: "Bearer x" } }),
		).toThrowError(unsupported("graphqlSse.headers.Authorization"));
	});

	it("socketIo(url, options) keeps sharing required", () => {
		const urlFirst = socketIo("/chat", {
			sharing: "shared",
			ackTimeoutMs: 5_000,
		});
		const object = socketIo({
			url: "/chat",
			sharing: "shared",
			ackTimeoutMs: 5_000,
		});
		expect(urlFirst.connection).toEqual(object.connection);
		expect(urlFirst.subscription({ event: "message" })).toEqual(
			object.subscription({ event: "message" }),
		);
		expect(urlFirst.command({ event: "send" })).toEqual(
			object.command({ event: "send" }),
		);
		expect(() => socketIo("/chat", {} as never)).toThrowError(
			unsupported("socketIo.sharing"),
		);
		// @ts-expect-error `sharing` stays required in the URL-first form.
		expect(() => socketIo("/chat")).toThrowError(
			unsupported("socketIo.sharing"),
		);
		expect(socketIo("/chat", { sharing: "per-tab" }).connection.tab).toBe(
			socketIo({ url: "/chat", sharing: "per-tab" }).connection.tab,
		);
	});
});

describe("an endpoint passed as a source says what to pass instead", () => {
	it("GraphQL endpoints name the operation", () => {
		for (const endpoint of [graphqlWs("/g"), graphqlSse("/g")]) {
			expect(() => toRequest(endpoint as never, "source")).toThrowError(
				expect.objectContaining({
					code: "unsupported-option",
					message:
						"subscription: needs an operation; pass endpoint.subscription({ query }), not the endpoint.",
					detail: { path: "subscription" },
				}),
			);
		}
	});

	it("Socket.IO endpoints name the event", () => {
		const endpoint = socketIo("/chat", { sharing: "shared" });
		expect(() => toRequest(endpoint as never, "source")).toThrowError(
			expect.objectContaining({
				code: "unsupported-option",
				message:
					"subscription: needs an event; pass endpoint.subscription({ event }), not the endpoint.",
				detail: { path: "subscription" },
			}),
		);
	});

	it("any other non-object selection keeps the plain-object message", () => {
		const endpoint = graphqlWs("/g");
		expect(() => endpoint.subscription(null as never)).toThrow(
			"subscription: must be a plain object.",
		);
		expect(() =>
			socketIo("/chat", { sharing: "shared" }).subscription("m" as never),
		).toThrow("subscription: must be a plain object.");
	});
});

describe("Socket.IO namespace from the URL path (page checks)", () => {
	it("refuses a namespace that conflicts with the URL path, naming both options", () => {
		for (const url of ["https://h.test/chat", "/chat", "//h.test/chat"]) {
			expect(
				() => socketIo(url, { namespace: "/ops", sharing: "shared" }),
				url,
			).toThrowError(
				expect.objectContaining({
					code: "unsupported-option",
					message: expect.stringContaining("socketIo.url"),
					detail: expect.objectContaining({ path: "socketIo.namespace" }),
				}),
			);
		}
		expect(() =>
			socketIo({
				url: "https://h.test/chat",
				namespace: "/",
				sharing: "shared",
			}),
		).toThrowError(unsupported("socketIo.namespace"));
	});

	it("accepts consistent spellings and leaves document-relative URLs to the runtime", () => {
		for (const [url, namespace] of [
			["https://h.test/chat", "/chat"],
			["https://h.test", "/chat"],
			["https://h.test/", "/chat"],
			["/", "/chat"],
			["/chat", "/chat"],
			// Resolved against the page's location; the runtime checks it.
			["chat", "/ops"],
		] as const) {
			expect(
				() => socketIo(url, { namespace, sharing: "shared" }),
				url,
			).not.toThrow();
		}
		// The builder keeps the URL as written; the client resolves it at subscribe.
		expect(socketIo("/chat", { sharing: "shared" }).connection).toEqual({
			url: "/chat",
			sharing: "shared",
		});
	});
});

describe("socketIo builder", () => {
	it("requires a sharing declaration", () => {
		expect(() => socketIo({ url: "/" } as never)).toThrowError(
			unsupported("socketIo.sharing"),
		);
	});

	it("refuses options that change delivery semantics or ownership", () => {
		for (const key of [
			"retries",
			"forceNew",
			"multiplex",
			"autoConnect",
			"extraHeaders",
			"reconnection",
		]) {
			expect(
				() => socketIo({ url: "/", sharing: "shared", [key]: 1 } as never),
				key,
			).toThrowError(unsupported(`socketIo.${key}`));
		}
	});

	it("per-tab sharing adds one stable tab id per page realm", () => {
		const a = socketIo({ url: "/", sharing: "per-tab" });
		const b = socketIo({ url: "/", sharing: "per-tab" });
		expect(a.connection.tab).toMatch(/^[0-9a-f-]{36}$/);
		expect(b.connection.tab).toBe(a.connection.tab);
		expect(
			socketIo({ url: "/", sharing: "shared" }).connection.tab,
		).toBeUndefined();
	});

	it("membership keys without a route get their own connection identity", () => {
		const endpoint = socketIo({ url: "/", sharing: "shared" });
		const routed = endpoint.subscription({
			event: "room",
			membership: "r1",
			route: "byRoom",
		});
		const own = endpoint.subscription({ event: "room", membership: "r1" });
		expect(routed.connection).toEqual(endpoint.connection);
		expect(own.connection).toEqual({
			...endpoint.connection,
			membership: "r1",
		});
	});

	it("validates listeners and commands", () => {
		const endpoint = socketIo({ url: "/", sharing: "shared" });
		expect(() => endpoint.subscription({ event: "connect" })).toThrowError(
			unsupported("subscription.event"),
		);
		expect(() =>
			endpoint.subscription({ event: "x", join: { event: "join" } }),
		).toThrowError(unsupported("subscription.join"));
		expect(() =>
			endpoint.command({ event: "x", volatile: true, ack: true }),
		).toThrowError(unsupported("command.volatile"));
		expect(endpoint.command({ event: "send", args: [1, "a"] })).toEqual({
			adapter: "socket-io",
			connection: endpoint.connection,
			payload: { event: "send", args: [1, "a"] },
		});
	});
});

describe("page entries never reach protocol clients or runtime code", () => {
	const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../src");
	const forbidden = /^(graphql-ws|graphql-sse|socket\.io-client|graphql)(\/|$)/;

	function closure(entry: string): { files: Set<string>; bare: Set<string> } {
		const files = new Set<string>();
		const bare = new Set<string>();
		const visit = (file: string) => {
			if (files.has(file)) return;
			files.add(file);
			const source = readFileSync(file, "utf8");
			for (const match of source.matchAll(
				/^\s*(import|export)\s+(?!type\b)[^;]*?from\s+"([^"]+)"/gm,
			)) {
				const specifier = match[2] as string;
				if (specifier.startsWith(".")) visit(resolve(dirname(file), specifier));
				else bare.add(specifier);
			}
		};
		visit(resolve(root, entry));
		return { files, bare };
	}

	for (const entry of [
		"protocols/graphql-ws/index.ts",
		"protocols/graphql-sse/index.ts",
		"protocols/socket-io/index.ts",
		"integrations/apollo/index.ts",
		"integrations/trpc/index.ts",
	]) {
		it(entry, () => {
			const { files, bare } = closure(entry);
			for (const specifier of bare)
				expect(specifier, entry).not.toMatch(forbidden);
			for (const file of files) {
				expect(file).not.toMatch(
					/runtime\.ts$|operation\.ts$|core\/runtime|shared\/runtime/,
				);
			}
		});
	}
});
