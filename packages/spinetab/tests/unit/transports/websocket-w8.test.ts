import {
	afterEach,
	beforeEach,
	describe,
	expect,
	expectTypeOf,
	it,
	vi,
} from "vitest";
import type {
	Feed,
	SpinetabClient,
	Subscription,
} from "../../../src/core/types.ts";
import {
	type RawWebSocketFeed,
	type WebSocketFeed,
	websocket,
} from "../../../src/transports/websocket/index.ts";
import {
	type WebSocketConnectionSpec,
	websocketAdapter,
} from "../../../src/transports/websocket/runtime.ts";
import {
	FakeWebSocket,
	fakeContext,
	flush,
	recordingSink,
	SUBSCRIBE_OPTIONS,
} from "./helpers.ts";

// a raw WebSocket (no protocol) is typed `string | ArrayBuffer`;
// `decoder: "json"` parses frames and lets the payload generic claim a shape;
// with a protocol, the codec decides as before.

const URL_BASE = "wss://api.test/ws";

function openRaw(spec: Partial<WebSocketConnectionSpec> = {}) {
	const adapter = websocketAdapter();
	const connection = { url: URL_BASE, ...spec } as WebSocketConnectionSpec;
	adapter.validateConnection?.(connection);
	const fake = fakeContext();
	const conn = adapter.connect(connection, fake.ctx);
	const record = recordingSink<unknown>();
	conn.subscribe({}, record.sink, SUBSCRIBE_OPTIONS);
	return { adapter, conn, fake, record };
}

beforeEach(() => {
	FakeWebSocket.reset();
	vi.stubGlobal("WebSocket", FakeWebSocket);
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("raw WebSocket payloads", () => {
	it("without a decoder, text and binary frames pass through unchanged", async () => {
		const { record } = openRaw();
		await flush();
		const socket = FakeWebSocket.last();
		socket.serverOpen();
		const bytes = new Uint8Array([1, 2]).buffer;
		socket.serverMessage('{"a":1}');
		socket.serverMessage(bytes);
		expect(record.events).toEqual(['{"a":1}', bytes]);
	});

	it('decoder "json" parses text and UTF-8 binary frames', async () => {
		const { record } = openRaw({ decoder: "json" });
		await flush();
		const socket = FakeWebSocket.last();
		socket.serverOpen();
		socket.serverMessage('{"a":1}');
		socket.serverMessage(new TextEncoder().encode('{"b":"é"}').buffer);
		expect(record.events).toEqual([{ a: 1 }, { b: "é" }]);
	});

	it('decoder "json": a bad frame is a decode-error plus a gap; the socket stays open', async () => {
		const { record, fake } = openRaw({ decoder: "json" });
		await flush();
		const socket = FakeWebSocket.last();
		socket.serverOpen();
		socket.serverMessage("not json");
		socket.serverMessage("[1]");
		expect(record.continuity).toEqual([{ reason: "decode-error" }]);
		expect(fake.diagnostics.map((event) => event.type)).toContain(
			"decode-error",
		);
		expect(record.events).toEqual([[1]]);
		expect(socket.closedWith).toBeUndefined();
	});

	it('decoder "json" is refused with a protocol or with binaryType "blob"', () => {
		const adapter = websocketAdapter({
			protocols: { p: { decode: () => ({ kind: "ignore" }) } },
		});
		const refused = (spec: Record<string, unknown>) => {
			try {
				websocket({ url: URL_BASE, ...spec } as WebSocketConnectionSpec);
			} catch (error) {
				return (error as { detail?: { path?: string } }).detail?.path;
			}
			return undefined;
		};
		expect(refused({ protocol: "p", decoder: "json" })).toBe(
			"connection.decoder",
		);
		expect(refused({ binaryType: "blob", decoder: "json" })).toBe(
			"connection.decoder",
		);
		expect(refused({ decoder: "text" })).toBe("connection.decoder");
		expect(() =>
			adapter.validateConnection?.({
				url: URL_BASE,
				protocol: "p",
				decoder: "json",
			}),
		).toThrow(/decoder/);
	});

	it("the decoder is part of identity", () => {
		const raw = websocket(URL_BASE).subscription();
		const json = websocket(URL_BASE, { decoder: "json" }).subscription();
		expect(raw.connection).not.toEqual(json.connection);
		expect(json.connection).toEqual({ url: URL_BASE, decoder: "json" });
	});

	it("types follow what the runtime delivers", () => {
		interface Tick {
			n: number;
		}
		const client = {} as SpinetabClient;
		const raw = websocket(URL_BASE);
		expectTypeOf(raw).toEqualTypeOf<RawWebSocketFeed<string | ArrayBuffer>>();
		expectTypeOf(raw).toExtend<Feed<string | ArrayBuffer>>();
		expectTypeOf(websocket(URL_BASE, { binaryType: "blob" })).toEqualTypeOf<
			RawWebSocketFeed<string | Blob>
		>();
		const ticks = websocket<Tick>(URL_BASE, { decoder: "json" });
		expectTypeOf(ticks).toEqualTypeOf<RawWebSocketFeed<Tick>>();
		if (Math.random() > 2) {
			expectTypeOf(client.subscribe(ticks, () => {})).toEqualTypeOf<
				Subscription<Tick>
			>();
			// @ts-expect-error: a raw feed without a decoder cannot claim a shape
			websocket<Tick>(URL_BASE);
			// @ts-expect-error: a raw feed has no topics
			raw.subscription("topic");
		}
		const topics = websocket<string>(URL_BASE, { protocol: "topics" });
		expectTypeOf(topics).toEqualTypeOf<WebSocketFeed<string>>();
		expectTypeOf(topics.subscription<Tick>("a")).toExtend<{
			adapter: string;
		}>();
		expectTypeOf(
			websocket<string>({ url: URL_BASE, protocol: "topics" }),
		).toEqualTypeOf<WebSocketFeed<string>>();
	});
});
