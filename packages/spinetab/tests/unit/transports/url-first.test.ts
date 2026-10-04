import { describe, expect, expectTypeOf, it } from "vitest";
import { stableStringify } from "../../../src/core/identity.ts";
import type {
	Feed,
	SpinetabClient,
	Subscription,
	SubscriptionRequest,
} from "../../../src/core/types.ts";
import {
	type PollingConnection,
	type PollingFeed,
	type PollingOptions,
	type PollingSubscription,
	polling,
} from "../../../src/transports/polling/index.ts";
import { pollingAdapter } from "../../../src/transports/polling/runtime.ts";
import {
	type SseConnectionSpec,
	type SseFeed,
	type SseSubscriptionSpec,
	sse,
} from "../../../src/transports/sse/index.ts";
import { sseAdapter } from "../../../src/transports/sse/runtime.ts";
import {
	type StreamConnectionSpec,
	type StreamFeed,
	type StreamSubscriptionSpec,
	stream,
} from "../../../src/transports/stream/index.ts";
import {
	ndjsonParser,
	streamAdapter,
} from "../../../src/transports/stream/runtime.ts";
import {
	type RawWebSocketFeed,
	type WebSocketConnectionSpec,
	type WebSocketFeed,
	type WebSocketSubscriptionSpec,
	websocket,
} from "../../../src/transports/websocket/index.ts";

// URL-first builders. Both forms normalise to one canonical connection
// (NT:39), relative URLs stay as written for the client to resolve at
// subscribe (CR:76), and the payload type sits on the feed where the builder
// decides it.

const BASE = "https://app.test/";

/** What the client sends to the runtime: the URL resolved in the page. */
function resolved<C extends { url: string }>(connection: C): C {
	return { ...connection, url: new URL(connection.url, BASE).href };
}

function pathOf(action: () => unknown): string | undefined {
	try {
		action();
	} catch (error) {
		return (error as { detail?: { path?: string } }).detail?.path;
	}
	return undefined;
}

/** A client whose subscribe never runs its callbacks: for type assertions. */
const client = {
	subscribe: () => ({}),
} as unknown as SpinetabClient;

describe("URL-first builders give the options form's canonical connection", () => {
	it("polling", () => {
		const adapter = pollingAdapter();
		const urlFirst = polling("/api/queue", {
			method: "POST",
			body: { q: 1 },
			headers: { "X-View": "a" },
		});
		const object = polling({
			url: "/api/queue",
			method: "POST",
			body: { q: 1 },
			headers: { "X-View": "a" },
		});
		expect(urlFirst.connection).toEqual(object.connection);
		expect(urlFirst.subscription()).toEqual(object.subscription());
		expect(urlFirst.connection.url).toBe("/api/queue");
		expect(adapter.connectionKey?.(resolved(urlFirst.connection))).toBe(
			adapter.connectionKey?.(resolved(object.connection)),
		);
		expect(polling("/api/queue").subscription()).toEqual(
			polling({ url: "/api/queue" }).subscription(),
		);
	});

	it("sse", () => {
		const adapter = sseAdapter();
		const options: Omit<SseConnectionSpec, "url"> = {
			mode: "fetch",
			decoder: "json",
			events: ["tick"],
			replay: "last-event-id",
		};
		const urlFirst = sse("/api/ticks", options);
		const object = sse({ url: "/api/ticks", ...options });
		expect(urlFirst.connection).toEqual(object.connection);
		expect(urlFirst.subscription({ event: "tick" })).toEqual(
			object.subscription({ event: "tick" }),
		);
		expect(urlFirst.connection.url).toBe("/api/ticks");
		expect(adapter.connectionKey?.(resolved(urlFirst.connection))).toBe(
			adapter.connectionKey?.(resolved(object.connection)),
		);
		const eventsource = sse("/api/ticks", { mode: "eventsource" });
		expect(eventsource.subscription()).toEqual(
			sse({ url: "/api/ticks", mode: "eventsource" }).subscription(),
		);
	});

	it("stream", () => {
		const adapter = streamAdapter({
			parsers: { ndjson: ndjsonParser() },
		});
		const urlFirst = stream("/api/orders", {
			parser: "ndjson",
			repeatable: true,
			heartbeat: { expectInboundWithinMs: 5_000 },
		});
		const object = stream({
			url: "/api/orders",
			parser: "ndjson",
			repeatable: true,
			heartbeat: { expectInboundWithinMs: 5_000 },
		});
		expect(urlFirst.connection).toEqual(object.connection);
		expect(urlFirst.subscription()).toEqual(object.subscription());
		expect(urlFirst.connection.url).toBe("/api/orders");
		expect(adapter.connectionKey?.(resolved(urlFirst.connection))).toBe(
			adapter.connectionKey?.(resolved(object.connection)),
		);
		// Non-repeatable requests stay non-repeatable in either form.
		expect(
			stream("/api/generate", {
				parser: "ndjson",
				method: "POST",
				body: "{}",
			}).subscription(),
		).toEqual(
			stream({
				url: "/api/generate",
				parser: "ndjson",
				method: "POST",
				body: "{}",
			}).subscription(),
		);
	});

	it("websocket", () => {
		const urlFirst = websocket("/ws", {
			protocol: "topics",
			subprotocols: ["v1"],
		});
		const object = websocket({
			url: "/ws",
			protocol: "topics",
			subprotocols: ["v1"],
		});
		expect(urlFirst.connection).toEqual(object.connection);
		expect(urlFirst.subscription("a")).toEqual(object.subscription("a"));
		expect(urlFirst.command({ op: 1 })).toEqual(object.command({ op: 1 }));
		expect(urlFirst.connection.url).toBe("/ws");
		// No custom key: the runtime keys the canonical connection as is.
		expect(stableStringify(resolved(urlFirst.connection))).toBe(
			stableStringify(resolved(object.connection)),
		);
		expect(websocket("wss://api.test/ws").subscription()).toEqual(
			websocket({ url: "wss://api.test/ws" }).subscription(),
		);
	});
});

describe("URL-first options are validated like the options form", () => {
	it("reports option errors on the same paths", () => {
		expect(pathOf(() => polling("/x", { retries: 3 } as never))).toBe(
			"polling.retries",
		);
		expect(pathOf(() => polling("/x", { timeoutMs: 0 }))).toBe(
			"polling.timeoutMs",
		);
		expect(pathOf(() => polling(""))).toBe("polling.url");
		expect(
			pathOf(() => sse("/x", { mode: "fetch", unknown: 1 } as never)),
		).toBe("connection.unknown");
		expect(pathOf(() => sse(""))).toBe("connection.url");
		expect(pathOf(() => stream("/x", { parser: "ndjson", body: "x" }))).toBe(
			"connection.body",
		);
		expect(pathOf(() => websocket("/x", { protocol: "" }))).toBe(
			"connection.protocol",
		);
		expect(pathOf(() => sse("/x", null as never))).toBe("connection");
	});

	it("rejects a url repeated in the options instead of ignoring either", () => {
		expect(pathOf(() => polling("/x", { url: "/y" } as never))).toBe(
			"polling.url",
		);
		expect(pathOf(() => sse("/x", { mode: "fetch", url: "/y" } as never))).toBe(
			"connection.url",
		);
		expect(
			pathOf(() => stream("/x", { parser: "ndjson", url: "/y" } as never)),
		).toBe("connection.url");
		expect(pathOf(() => websocket("/x", { url: "/y" } as never))).toBe(
			"connection.url",
		);
	});

	it("fix: keeps the first argument when shared options carry url: undefined", () => {
		// `Omit<Spec, "url">` accepts a non-literal `Partial<Spec>`, so an explicit
		// `url: undefined` can reach the builder; it must not replace the URL.
		const pollingOptions: Partial<PollingOptions> = { url: undefined };
		const sseOptions: Partial<SseConnectionSpec> = { url: undefined };
		const streamOptions: Partial<StreamConnectionSpec> = { url: undefined };
		const websocketOptions: Partial<WebSocketConnectionSpec> = {
			url: undefined,
		};
		expect(polling("/q", pollingOptions).connection).toEqual(
			polling({ url: "/q" }).connection,
		);
		expect(sse("/s", sseOptions).connection).toEqual(
			sse({ url: "/s" }).connection,
		);
		expect(stream("/o", streamOptions).connection).toEqual(
			stream({ url: "/o" }).connection,
		);
		expect(websocket("/ws", websocketOptions).connection).toEqual(
			websocket({ url: "/ws" }).connection,
		);
	});

	it("fix: polling rejects non-object options at `polling`, as the options form does", () => {
		for (const value of [null, [], 5, "x"]) {
			expect(pathOf(() => polling("/q", value as never))).toBe("polling");
		}
		expect(pathOf(() => polling(null as never))).toBe("polling");
	});
});

describe("payload types sit on the feed", () => {
	type Queue = { open: number };
	type Tick = { n: number };

	it("types polling, stream and SSE feeds by the builder, and infers them through subscribe", () => {
		const queue = polling<Queue>("/api/queue");
		expectTypeOf(queue).toEqualTypeOf<PollingFeed<Queue>>();
		expectTypeOf(queue).toExtend<Feed<Queue>>();
		expectTypeOf(queue.subscription()).toEqualTypeOf<
			SubscriptionRequest<Queue, PollingConnection, PollingSubscription>
		>();
		expectTypeOf(
			client.subscribe(queue, (value) => {
				expectTypeOf(value).toEqualTypeOf<Queue>();
			}),
		).toEqualTypeOf<Subscription<Queue>>();

		const orders = stream<Tick>("/api/orders", { parser: "ndjson" });
		expectTypeOf(orders).toExtend<Feed<Tick>>();
		expectTypeOf(orders.subscription()).toEqualTypeOf<
			SubscriptionRequest<Tick, StreamConnectionSpec, StreamSubscriptionSpec>
		>();
		expectTypeOf(client.subscribe(orders, () => {})).toEqualTypeOf<
			Subscription<Tick>
		>();

		// The text decoder delivers strings; JSON (the default) the claim.
		const text = sse("/api/ticks", { mode: "fetch", decoder: "text" });
		expectTypeOf(text).toEqualTypeOf<SseFeed<string>>();
		expectTypeOf(client.subscribe(text, () => {})).toEqualTypeOf<
			Subscription<string>
		>();
		const ticks = sse<Tick>("/api/ticks", { mode: "fetch" });
		expectTypeOf(ticks).toExtend<Feed<Tick>>();
		expectTypeOf(ticks.subscription()).toEqualTypeOf<
			SubscriptionRequest<Tick, SseConnectionSpec, SseSubscriptionSpec>
		>();
		expectTypeOf(
			client.subscribe(ticks, (tick) => {
				expectTypeOf(tick).toEqualTypeOf<Tick>();
			}),
		).toEqualTypeOf<Subscription<Tick>>();
	});

	it("keeps the options forms and .subscription<T>() compiling as before", () => {
		expectTypeOf(polling({ url: "/q" })).toEqualTypeOf<PollingFeed>();
		expectTypeOf(polling({ url: "/q" }).subscription<Queue>()).toEqualTypeOf<
			SubscriptionRequest<Queue, PollingConnection, PollingSubscription>
		>();
		expectTypeOf(
			stream({ url: "/o", parser: "ndjson" }).subscription<Tick>(),
		).toEqualTypeOf<
			SubscriptionRequest<Tick, StreamConnectionSpec, StreamSubscriptionSpec>
		>();
		expectTypeOf(
			sse({ url: "/s", mode: "fetch" }).subscription<Tick>({ event: "tick" }),
		).toEqualTypeOf<
			SubscriptionRequest<Tick, SseConnectionSpec, SseSubscriptionSpec>
		>();
		// Topics and payload claims need a protocol, whose codec decides.
		expectTypeOf(
			websocket<string>("/ws", { protocol: "topics" }).subscription<Tick>("a"),
		).toEqualTypeOf<
			SubscriptionRequest<
				Tick,
				WebSocketConnectionSpec,
				WebSocketSubscriptionSpec
			>
		>();
		expectTypeOf(
			websocket<string>("/ws", { protocol: "topics" }),
		).toEqualTypeOf<WebSocketFeed<string>>();
	});

	it("a URL-first SSE feed is unknown until named; string only for the text decoder", () => {
		expectTypeOf(sse("/s")).toEqualTypeOf<SseFeed<unknown>>();
		expectTypeOf(sse("/s", { decoder: "text" })).toEqualTypeOf<
			SseFeed<string>
		>();
		expectTypeOf(sse("/s", { decoder: "json" })).toEqualTypeOf<
			SseFeed<unknown>
		>();
		expectTypeOf(sse("/s", { decoder: "msgpack" })).toEqualTypeOf<
			SseFeed<unknown>
		>();
		const shared: Omit<SseConnectionSpec, "url"> = { decoder: "json" };
		expectTypeOf(sse("/s", shared)).toEqualTypeOf<SseFeed<unknown>>();
		expectTypeOf(
			client.subscribe(sse("/s"), (data) => {
				expectTypeOf(data).toEqualTypeOf<unknown>();
			}),
		).toEqualTypeOf<Subscription<unknown>>();
		// JSON is the default, so the payload can be claimed without a decoder.
		expectTypeOf(sse<Tick>("/s")).toEqualTypeOf<SseFeed<Tick>>();
		expectTypeOf(sse<Tick>("/s", { decoder: "json" })).toEqualTypeOf<
			SseFeed<Tick>
		>();
	});

	it(".subscription() resolves on any union of transport feeds", () => {
		const three = (feed: PollingFeed | StreamFeed | WebSocketFeed) =>
			feed.subscription();
		const five = (
			feed:
				| PollingFeed
				| StreamFeed
				| SseFeed
				| WebSocketFeed
				| RawWebSocketFeed,
		) => feed.subscription();
		expect(three(websocket("/ws", { protocol: "topics" })).adapter).toBe(
			"websocket",
		);
		expect(five(websocket("/ws")).adapter).toBe("websocket");
		expect(five(sse("/s")).adapter).toBe("sse");
		expect(five(polling("/q")).adapter).toBe("polling");
		// A raw feed is typed as the runtime delivers it.
		expectTypeOf(websocket("/ws")).toExtend<Feed<string | ArrayBuffer>>();
		expectTypeOf(client.subscribe(websocket("/ws"), () => {})).toEqualTypeOf<
			Subscription<string | ArrayBuffer>
		>();
	});
});
