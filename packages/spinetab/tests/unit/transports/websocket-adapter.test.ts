import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { websocket } from "../../../src/transports/websocket/index.ts";
import {
	CLOSE_LIVENESS,
	CLOSE_OVERSIZE,
	type WebSocketConnectionSpec,
	type WebSocketProtocol,
	websocketAdapter,
} from "../../../src/transports/websocket/runtime.ts";
import { FakeWebSocket, fakeContext, flush, recordingSink } from "./helpers.ts";
import { createTopicProtocol } from "./topic-protocol.ts";

// NT-U-03, NT-U-14…17: WebSocket adapter through the adapter contract with a
// socket double. Wire behaviour against a real
// server is covered by NT-I-01…07.

const URL_BASE = "wss://api.test/ws";

function setup(
	protocol: WebSocketProtocol | null = createTopicProtocol(),
	spec: Partial<WebSocketConnectionSpec> = {},
	limits: Parameters<typeof fakeContext>[0] = {},
) {
	const adapter = websocketAdapter({
		protocols: protocol ? { topics: protocol } : {},
	});
	const connection: WebSocketConnectionSpec = {
		url: URL_BASE,
		...(protocol ? { protocol: "topics" } : {}),
		...spec,
	};
	adapter.validateConnection?.(connection);
	const fake = fakeContext(limits);
	const conn = adapter.connect(connection, fake.ctx);
	return { adapter, conn, fake };
}

type Conn = ReturnType<typeof setup>["conn"];

function subscribe(conn: Conn, topic?: string, repeatable = true) {
	const record = recordingSink();
	const sub = conn.subscribe(
		topic === undefined ? {} : { topic },
		record.sink,
		{
			key: topic ?? "feed",
			repeatable,
		},
	);
	return { record, sub };
}

const commandOptions = (
	overrides: Partial<{ signal: AbortSignal; timeoutMs: number }> = {},
) => ({
	id: "page-cmd",
	signal: new AbortController().signal,
	timeoutMs: 30_000,
	...overrides,
});

function frames(socket: FakeWebSocket) {
	return socket.json() as Array<Record<string, unknown>>;
}

beforeEach(() => {
	FakeWebSocket.reset();
	vi.stubGlobal("WebSocket", FakeWebSocket);
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	vi.spyOn(Math, "random").mockReturnValue(0.5);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("configuration", () => {
	it("page builder produces plain requests and validates synchronously", () => {
		const feed = websocket<string>({
			url: "/ws",
			protocol: "topics",
			subprotocols: ["v1"],
		});
		expect(feed.subscription<number>("prices")).toEqual({
			adapter: "websocket",
			connection: { url: "/ws", protocol: "topics", subprotocols: ["v1"] },
			subscription: { topic: "prices" },
		});
		expect(feed.subscription().subscription).toEqual({});
		expect(feed.command({ op: "buy" }, { expectsAck: false }).payload).toEqual({
			data: { op: "buy" },
			expectsAck: false,
		});
		const pathOf = (action: () => unknown) => {
			try {
				action();
			} catch (error) {
				return (error as { detail?: { path?: string } }).detail?.path;
			}
			return undefined;
		};
		expect(
			pathOf(() =>
				websocket({ url: "/ws", protocol: "t", binaryType: "blob" }),
			),
		).toBe("connection.binaryType");
		expect(
			pathOf(() => websocket({ url: "/ws", subprotocols: ["a", "a"] })),
		).toBe("connection.subprotocols[1]");
		expect(pathOf(() => websocket({ url: "/ws", headers: {} } as never))).toBe(
			"connection.headers",
		);
		expect(() => websocket({ url: "wss://user:pw@api.test/ws" })).toThrowError(
			expect.objectContaining({ code: "invalid-endpoint" }),
		);
	});

	it("runtime rejects unregistered protocols, relative URLs and malformed hooks", () => {
		const adapter = websocketAdapter({
			protocols: { topics: createTopicProtocol() },
		});
		expect(() =>
			adapter.validateConnection?.({ url: URL_BASE, protocol: "nope" }),
		).toThrowError(
			expect.objectContaining({ detail: { path: "connection.protocol" } }),
		);
		expect(() => adapter.validateConnection?.({ url: "/ws" })).toThrowError(
			expect.objectContaining({ code: "invalid-endpoint" }),
		);
		expect(() =>
			websocketAdapter({
				protocols: {
					bad: { decode: () => ({ kind: "ignore" }), route: () => [] } as never,
				},
			}),
		).toThrowError(
			expect.objectContaining({
				detail: { path: "websocketAdapter.protocols.bad.route" },
			}),
		);
		expect(() =>
			websocketAdapter({
				protocols: {
					bad: {
						decode: () => ({ kind: "ignore" }),
						heartbeat: { intervalMs: 1 },
					} as never,
				},
			}),
		).toThrowError(expect.objectContaining({ code: "unsupported-option" }));
	});

	it("opens one socket with arraybuffer binary frames and the declared subprotocols", async () => {
		const { conn } = setup(createTopicProtocol(), {
			subprotocols: ["v2", "v1"],
		});
		subscribe(conn, "a");
		subscribe(conn, "b");
		subscribe(conn);
		await flush();
		expect(FakeWebSocket.instances).toHaveLength(1);
		const socket = FakeWebSocket.last();
		expect(socket.binaryType).toBe("arraybuffer");
		expect(socket.protocols).toEqual(["v2", "v1"]);
	});
});

describe("subscription intent", () => {
	it("waits for open, then sends exactly one subscribe per topic", async () => {
		const { conn } = setup();
		subscribe(conn, "a");
		subscribe(conn, "a");
		subscribe(conn, "b");
		await flush();
		const socket = FakeWebSocket.last();
		expect(socket.sent).toEqual([]);
		socket.serverOpen();
		expect(frames(socket)).toEqual([
			{ type: "subscribe", topic: "a" },
			{ type: "subscribe", topic: "b" },
		]);
		subscribe(conn, "a");
		await flush();
		expect(frames(socket)).toHaveLength(2);
	});

	it("an unsubscribe before the subscribe is sent puts nothing on the wire", async () => {
		const { conn } = setup();
		const one = subscribe(conn, "a");
		await flush();
		one.sub.unsubscribe();
		await flush();
		FakeWebSocket.last().serverOpen();
		expect(FakeWebSocket.last().sent).toEqual([]);
	});

	it("leave-then-rejoin before an unsubscribe is sent nets to no message", async () => {
		const { conn } = setup();
		subscribe(conn, "a");
		await flush();
		const socket = FakeWebSocket.last();
		socket.serverOpen();
		const second = subscribe(conn, "b");
		await flush();
		second.sub.unsubscribe();
		subscribe(conn, "b");
		await flush();
		expect(frames(socket)).toEqual([
			{ type: "subscribe", topic: "a" },
			{ type: "subscribe", topic: "b" },
		]);
	});

	it("sends one unsubscribe on the last leave, and a new subscribe after it on rejoin", async () => {
		const { conn } = setup();
		const one = subscribe(conn, "a");
		const two = subscribe(conn, "a");
		await flush();
		const socket = FakeWebSocket.last();
		socket.serverOpen();
		one.sub.unsubscribe();
		await flush();
		expect(frames(socket)).toHaveLength(1);
		two.sub.unsubscribe();
		two.sub.unsubscribe();
		await flush();
		subscribe(conn, "a");
		await flush();
		expect(frames(socket)).toEqual([
			{ type: "subscribe", topic: "a" },
			{ type: "unsubscribe", topic: "a" },
			{ type: "subscribe", topic: "a" },
		]);
	});

	it("fails only the rejected subscription and never retries it", async () => {
		const { conn } = setup();
		const a = subscribe(conn, "a");
		const b = subscribe(conn, "b");
		await flush();
		const socket = FakeWebSocket.last();
		socket.serverOpen();
		socket.serverMessage(
			JSON.stringify({
				type: "subscribe-rejected",
				topic: "a",
				reason: "forbidden topic",
			}),
		);
		expect(a.record.errors).toEqual([
			{ code: "subscribe-rejected", message: "forbidden topic" },
		]);
		expect(b.record.errors).toEqual([]);
		socket.serverClose(1006);
		vi.advanceTimersByTime(1_000);
		await flush();
		const next = FakeWebSocket.last();
		next.serverOpen();
		expect(frames(next)).toEqual([{ type: "subscribe", topic: "b" }]);
	});
});

describe("routing and inbound bounds", () => {
	it("routes events only to the routed topic; the connection feed sees every event", async () => {
		const { conn, fake } = setup();
		const a = subscribe(conn, "a");
		const b = subscribe(conn, "b");
		const all = subscribe(conn);
		await flush();
		const socket = FakeWebSocket.last();
		socket.serverOpen();
		socket.serverMessage(
			JSON.stringify({ type: "event", topic: "a", data: 1 }),
		);
		socket.serverMessage(
			JSON.stringify({ type: "event", topic: "b", data: 2 }),
		);
		socket.serverMessage(
			JSON.stringify({ type: "event", topic: "z", data: 3 }),
		);
		expect(a.record.events).toEqual([1]);
		expect(b.record.events).toEqual([2]);
		expect(all.record.events).toEqual([1, 2, 3]);
		all.sub.unsubscribe();
		socket.serverMessage(
			JSON.stringify({ type: "event", topic: "z", data: 4 }),
		);
		expect(
			fake.diagnostics.filter((event) => event.type === "unrouted"),
		).toHaveLength(1);
	});

	it("passes raw frames through without a protocol and preserves the frame kind", async () => {
		const { conn } = setup(null);
		const all = subscribe(conn);
		const topical = subscribe(conn, "a");
		expect(topical.record.errors[0]?.code).toBe("unsupported-option");
		await flush();
		const socket = FakeWebSocket.last();
		socket.serverOpen();
		const binary = Uint8Array.of(1, 2, 3).buffer;
		socket.serverMessage("text");
		socket.serverMessage(binary);
		expect(all.record.events).toEqual(["text", binary]);
		expect(typeof all.record.events[0]).toBe("string");
		expect(all.record.events[1]).toBeInstanceOf(ArrayBuffer);
	});

	it("delivers Blob frames unchanged when binaryType is blob (raw mode only)", async () => {
		const { conn } = setup(
			null,
			{ binaryType: "blob" },
			{
				limits: { maxMessageBytes: 8, maxPendingBytesPerConsumer: 8 },
			},
		);
		const all = subscribe(conn);
		await flush();
		const socket = FakeWebSocket.last();
		expect(socket.binaryType).toBe("blob");
		socket.serverOpen();
		const small = new Blob([Uint8Array.of(1, 2)]);
		socket.serverMessage(small as unknown as ArrayBuffer);
		socket.serverMessage(
			new Blob([new Uint8Array(9)]) as unknown as ArrayBuffer,
		);
		expect(all.record.events).toEqual([small]);
		expect(all.record.continuity).toEqual([{ reason: "message-too-large" }]);
	});

	it("drops oversized frames with a gap and keeps the socket open", async () => {
		const { conn, fake } = setup(
			createTopicProtocol(),
			{},
			{ limits: { maxMessageBytes: 64, maxPendingBytesPerConsumer: 64 } },
		);
		const a = subscribe(conn, "a");
		await flush();
		const socket = FakeWebSocket.last();
		socket.serverOpen();
		socket.serverMessage(
			JSON.stringify({ type: "event", topic: "a", data: "é".repeat(40) }),
		);
		socket.serverMessage(new Uint8Array(65).buffer);
		socket.serverMessage(
			JSON.stringify({ type: "event", topic: "a", data: 1 }),
		);
		expect(a.record.events).toEqual([1]);
		expect(a.record.continuity).toEqual([
			{ reason: "message-too-large" },
			{ reason: "message-too-large" },
		]);
		expect(socket.closedWith).toBeUndefined();
		expect(
			fake.diagnostics.filter((event) => event.type === "oversized-frame"),
		).toHaveLength(2);
	});

	it("closes with 4001 under the close oversize policy and reconnects", async () => {
		const { conn } = setup(
			createTopicProtocol({ onOversize: "close" }),
			{},
			{
				limits: { maxMessageBytes: 64, maxPendingBytesPerConsumer: 64 },
			},
		);
		subscribe(conn, "a");
		await flush();
		const socket = FakeWebSocket.last();
		socket.serverOpen();
		socket.serverMessage("x".repeat(100));
		expect(socket.closedWith?.code).toBe(CLOSE_OVERSIZE);
		vi.advanceTimersByTime(500);
		await flush();
		expect(FakeWebSocket.instances).toHaveLength(2);
	});

	it("reports a decode failure as a gap without closing the socket", async () => {
		const { conn, fake } = setup();
		const a = subscribe(conn, "a");
		await flush();
		const socket = FakeWebSocket.last();
		socket.serverOpen();
		socket.serverMessage("{not json");
		socket.serverMessage(
			JSON.stringify({ type: "event", topic: "a", data: 2 }),
		);
		expect(a.record.continuity).toEqual([{ reason: "decode-error" }]);
		expect(a.record.events).toEqual([2]);
		expect(socket.closedWith).toBeUndefined();
		expect(fake.diagnostics).toContainEqual({ type: "decode-error" });
	});
});

describe("reconnection and close classification", () => {
	it("reconnects with backoff, resubscribes exactly once and reports reconnected", async () => {
		const { conn, fake } = setup();
		const a = subscribe(conn, "a");
		subscribe(conn, "b");
		await flush();
		const first = FakeWebSocket.last();
		first.serverOpen();
		first.serverClose(1006);
		expect(fake.last()).toMatchObject({
			state: "reconnecting",
			reason: "network",
			code: 1006,
			attempt: 1,
		});
		vi.advanceTimersByTime(499);
		expect(FakeWebSocket.instances).toHaveLength(1);
		vi.advanceTimersByTime(1);
		await flush();
		const second = FakeWebSocket.last();
		expect(second).not.toBe(first);
		second.serverOpen();
		expect(frames(second)).toEqual([
			{ type: "subscribe", topic: "a" },
			{ type: "subscribe", topic: "b" },
		]);
		expect(a.record.continuity).toEqual([
			// The early notice at detection, then the outcome.
			{ reason: "reconnected" },
			{ reason: "reconnected" },
		]);
		// Late frames from the superseded socket are fenced.
		first.serverMessage(
			JSON.stringify({ type: "event", topic: "a", data: "stale" }),
		);
		expect(a.record.events).toEqual([]);
	});

	it("treats a close with nothing subscribed as idle, without reconnecting", async () => {
		const { conn, fake } = setup();
		const a = subscribe(conn, "a");
		await flush();
		const socket = FakeWebSocket.last();
		socket.serverOpen();
		a.sub.unsubscribe();
		await flush();
		socket.serverClose(1000, "", true);
		expect(fake.last()).toMatchObject({ state: "inactive", reason: "idle" });
		vi.advanceTimersByTime(60_000);
		expect(FakeWebSocket.instances).toHaveLength(1);
	});

	it("exhausts after the bounded attempts and treats upgrade failures as transient", async () => {
		const { conn, fake } = setup();
		subscribe(conn, "a");
		await flush();
		for (let attempt = 0; attempt < 11; attempt += 1) {
			FakeWebSocket.last().serverClose(1006);
			vi.advanceTimersByTime(30_000);
			await flush();
		}
		expect(FakeWebSocket.instances).toHaveLength(11);
		expect(fake.last()).toMatchObject({
			state: "retry-exhausted",
			reason: "attempts-exhausted",
		});
		expect(fake.states()).not.toContain("auth-blocked");
		conn.probe?.();
		await flush();
		expect(FakeWebSocket.instances).toHaveLength(12);
	});

	it("blocks on an auth-classified close, rejects the revision and waits for rotation", async () => {
		const { conn, fake } = setup(createTopicProtocol({ authenticate: true }));
		fake.setCredentials(async () => ({
			connectionParams: { token: "valid-a-1" },
		}));
		subscribe(conn, "a");
		await flush();
		const socket = FakeWebSocket.last();
		expect(socket.url).toBe(URL_BASE);
		socket.serverOpen();
		expect(frames(socket)[0]).toEqual({ type: "auth", token: "valid-a-1" });
		expect(frames(socket)[1]).toEqual({ type: "subscribe", topic: "a" });
		socket.serverClose(4401, "unauthorised", true);
		expect(fake.last()).toEqual({
			state: "auth-blocked",
			reason: "credentials-rejected",
			code: "close:4401",
		});
		expect(fake.rejections()).toBe(1);
		vi.advanceTimersByTime(300_000);
		expect(FakeWebSocket.instances).toHaveLength(1);
		conn.rotate?.();
		await flush();
		expect(FakeWebSocket.instances).toHaveLength(2);
		expect(fake.credentialCalls).toEqual(["connect", "rotated"]);
	});

	it("a forbidden close (4403 in the harness protocol) fails permanently and rejects nothing", async () => {
		const { conn, fake } = setup(createTopicProtocol({ authenticate: true }));
		fake.setCredentials(async () => ({
			connectionParams: { token: "valid-a-1" },
		}));
		subscribe(conn, "a");
		await flush();
		FakeWebSocket.last().serverOpen();
		FakeWebSocket.last().serverClose(4403, "forbidden", true);
		expect(fake.last()).toEqual({
			state: "failed",
			reason: "permanent-error",
			code: 4403,
		});
		expect(fake.rejections()).toBe(0);
		vi.advanceTimersByTime(300_000);
		expect(FakeWebSocket.instances).toHaveLength(1);
	});

	it("fails on a permanent close without retrying; retry() starts afresh", async () => {
		const { conn, fake } = setup();
		subscribe(conn, "a");
		await flush();
		FakeWebSocket.last().serverOpen();
		FakeWebSocket.last().serverClose(4400, "bad", true);
		expect(fake.last()).toEqual({
			state: "failed",
			reason: "permanent-error",
			code: 4400,
		});
		vi.advanceTimersByTime(300_000);
		expect(FakeWebSocket.instances).toHaveLength(1);
		conn.retry?.();
		await flush();
		expect(FakeWebSocket.instances).toHaveLength(2);
	});

	it("reports auth-blocked without opening a socket when no credential source exists", async () => {
		const { conn, fake } = setup(createTopicProtocol({ authenticate: true }));
		subscribe(conn, "a");
		await flush();
		expect(FakeWebSocket.instances).toHaveLength(0);
		expect(fake.last()).toEqual({
			state: "auth-blocked",
			reason: "no-credential-source",
		});
	});

	it("blocks on a failed provider exactly as on a timeout and never opens an unauthenticated socket", async () => {
		for (const code of ["credentials-failed", "credentials-timeout"]) {
			FakeWebSocket.reset();
			const { conn, fake } = setup(createTopicProtocol({ authenticate: true }));
			fake.setCredentials(() =>
				Promise.reject(
					Object.assign(new Error(code), { name: "SpinetabError", code }),
				),
			);
			subscribe(conn, "a");
			await flush();
			expect(FakeWebSocket.instances, code).toHaveLength(0);
			expect(fake.last(), code).toEqual({
				state: "auth-blocked",
				reason: "credentials-missing",
			});
			vi.advanceTimersByTime(300_000);
			await flush();
			expect(FakeWebSocket.instances, code).toHaveLength(0);
			conn.dispose();
		}
	});
});

describe("commands", () => {
	async function openConnection(
		protocol = createTopicProtocol(),
		limits: Parameters<typeof fakeContext>[0] = {},
	) {
		const context = setup(protocol, {}, limits);
		subscribe(context.conn, "a");
		await flush();
		const socket = FakeWebSocket.last();
		socket.serverOpen();
		return { ...context, socket };
	}

	it("settles not-sent without writing while the socket is not open", async () => {
		const { conn } = setup();
		subscribe(conn, "a");
		await flush();
		const outcome = await conn.command?.({ data: { op: 1 } }, commandOptions());
		expect(outcome).toMatchObject({
			status: "not-sent",
			error: { detail: { reason: "not-connected" } },
		});
		expect(FakeWebSocket.last().sent).toEqual([]);
	});

	it("acknowledges and rejects correlated replies; each call is one wire command", async () => {
		const { conn, socket } = await openConnection();
		const first = conn.command?.({ data: { op: "same" } }, commandOptions());
		const second = conn.command?.({ data: { op: "same" } }, commandOptions());
		const commands = frames(socket).filter((frame) => frame.type === "cmd");
		expect(commands).toHaveLength(2);
		expect(commands[0]?.id).not.toBe(commands[1]?.id);
		socket.serverMessage(
			JSON.stringify({ type: "ack", id: commands[1]?.id, error: "nope" }),
		);
		socket.serverMessage(
			JSON.stringify({
				type: "ack",
				id: commands[0]?.id,
				result: { ok: true },
			}),
		);
		expect(await first).toEqual({
			status: "acknowledged",
			value: { ok: true },
		});
		expect(await second).toEqual({
			status: "rejected",
			error: { code: "command-rejected", message: "nope" },
		});
	});

	it("reports sent for fire-and-forget commands", async () => {
		const { conn } = await openConnection();
		expect(
			await conn.command?.({ data: 1, expectsAck: false }, commandOptions()),
		).toEqual({ status: "sent" });
	});

	it("settles unknown after the 10 s acknowledgement timeout and ignores the late reply", async () => {
		const { conn, socket, fake } = await openConnection();
		const pending = conn.command?.({ data: 1 }, commandOptions());
		vi.advanceTimersByTime(10_000);
		expect(await pending).toMatchObject({
			status: "unknown",
			error: { detail: { reason: "timeout" } },
		});
		const id = frames(socket).find((frame) => frame.type === "cmd")?.id;
		socket.serverMessage(JSON.stringify({ type: "ack", id, result: 1 }));
		expect(fake.diagnostics).toContainEqual({ type: "late-reply" });
	});

	it("settles unknown when the socket closes before the reply and never replays it", async () => {
		const { conn, socket } = await openConnection();
		const pending = conn.command?.({ data: 1 }, commandOptions());
		socket.serverClose(1006);
		expect(await pending).toMatchObject({
			status: "unknown",
			error: { detail: { reason: "disconnected" } },
		});
		vi.advanceTimersByTime(1_000);
		await flush();
		const next = FakeWebSocket.last();
		next.serverOpen();
		expect(frames(next).some((frame) => frame.type === "cmd")).toBe(false);
	});

	it("never accepts a reply for a previous socket's command", async () => {
		const { conn, socket, fake } = await openConnection();
		const pending = conn.command?.({ data: 1 }, commandOptions());
		const oldId = frames(socket).find((frame) => frame.type === "cmd")?.id;
		socket.serverClose(1006);
		expect(await pending).toMatchObject({ status: "unknown" });
		vi.advanceTimersByTime(1_000);
		await flush();
		const next = FakeWebSocket.last();
		next.serverOpen();
		const fresh = conn.command?.({ data: 2 }, commandOptions());
		const newId = frames(next).find((frame) => frame.type === "cmd")?.id;
		expect(newId).not.toBe(oldId);
		next.serverMessage(
			JSON.stringify({ type: "ack", id: oldId, result: "stale" }),
		);
		expect(fake.diagnostics).toContainEqual({ type: "late-reply" });
		next.serverMessage(
			JSON.stringify({ type: "ack", id: newId, result: "fresh" }),
		);
		expect(await fresh).toEqual({ status: "acknowledged", value: "fresh" });
	});

	it("distinguishes cancellation before and after writing", async () => {
		const { conn } = await openConnection();
		const before = new AbortController();
		before.abort();
		expect(
			await conn.command?.(
				{ data: 1 },
				commandOptions({ signal: before.signal }),
			),
		).toMatchObject({
			status: "not-sent",
			error: { detail: { reason: "aborted" } },
		});
		const after = new AbortController();
		const pending = conn.command?.(
			{ data: 1 },
			commandOptions({ signal: after.signal }),
		);
		after.abort();
		expect(await pending).toMatchObject({
			status: "unknown",
			error: { detail: { reason: "aborted" } },
		});
	});

	it("bounds pending commands and outbound buffering", async () => {
		const { conn, socket } = await openConnection(createTopicProtocol(), {
			limits: { maxPendingCommands: 2 },
		});
		void conn.command?.({ data: 1 }, commandOptions());
		void conn.command?.({ data: 2 }, commandOptions());
		expect(await conn.command?.({ data: 3 }, commandOptions())).toMatchObject({
			status: "not-sent",
			error: { detail: { reason: "limit-exceeded" } },
		});
		const before = socket.sent.length;
		socket.bufferedAmount = 2 * 1024 * 1024;
		const { conn: other, socket: otherSocket } = await openConnection();
		otherSocket.bufferedAmount = 1024 * 1024 + 1;
		expect(await other.command?.({ data: 1 }, commandOptions())).toMatchObject({
			status: "not-sent",
			error: { detail: { reason: "backpressure" } },
		});
		expect(socket.sent.length).toBe(before);
	});

	it("settles pending commands unknown on dispose and closes with 1000", async () => {
		const { conn, socket } = await openConnection();
		const pending = conn.command?.({ data: 1 }, commandOptions());
		conn.dispose();
		expect(await pending).toMatchObject({ status: "unknown" });
		expect(socket.closedWith).toEqual({ code: 1000, reason: "disposed" });
	});
});

describe("liveness", () => {
	it("closes with 4000 when the application probe gets no reply, then reconnects once", async () => {
		const protocol = createTopicProtocol({
			heartbeat: {
				intervalMs: 1_000,
				timeoutMs: 500,
				frame: () => JSON.stringify({ type: "ping" }),
			},
		});
		const { conn, fake } = setup(protocol);
		const a = subscribe(conn, "a");
		await flush();
		const socket = FakeWebSocket.last();
		socket.serverOpen();
		vi.advanceTimersByTime(1_000);
		expect(frames(socket).at(-1)).toEqual({ type: "ping" });
		socket.serverMessage(JSON.stringify({ type: "pong" }));
		vi.advanceTimersByTime(1_000);
		vi.advanceTimersByTime(499);
		expect(socket.closedWith).toBeUndefined();
		vi.advanceTimersByTime(1);
		expect(socket.closedWith).toEqual({
			code: CLOSE_LIVENESS,
			reason: "liveness",
		});
		expect(fake.last()).toMatchObject({
			state: "reconnecting",
			reason: "heartbeat-timeout",
		});
		vi.advanceTimersByTime(500);
		await flush();
		expect(FakeWebSocket.instances).toHaveLength(2);
		FakeWebSocket.last().serverOpen();
		expect(a.record.continuity).toEqual([
			// The early notice at detection, then the outcome.
			{ reason: "reconnected" },
			{ reason: "reconnected" },
		]);
		// Probes and replies are never delivered.
		expect(a.record.events).toEqual([]);
	});

	it("closes with 4000 when no inbound message arrives within the expectation", async () => {
		const { conn } = setup(
			createTopicProtocol({ heartbeat: { expectInboundWithinMs: 5_000 } }),
		);
		subscribe(conn, "a");
		await flush();
		const socket = FakeWebSocket.last();
		socket.serverOpen();
		vi.advanceTimersByTime(4_000);
		socket.serverMessage(
			JSON.stringify({ type: "event", topic: "a", data: 1 }),
		);
		vi.advanceTimersByTime(4_999);
		expect(socket.closedWith).toBeUndefined();
		vi.advanceTimersByTime(1);
		expect(socket.closedWith?.code).toBe(CLOSE_LIVENESS);
	});

	it("never closes a quiet socket without a declared mechanism", async () => {
		const { conn } = setup();
		subscribe(conn, "a");
		await flush();
		const socket = FakeWebSocket.last();
		socket.serverOpen();
		vi.advanceTimersByTime(3_600_000);
		expect(socket.closedWith).toBeUndefined();
	});

	it("reopens on a coordinated return check only when every subscription is repeatable", async () => {
		const { conn } = setup();
		const a = subscribe(conn, "a");
		await flush();
		const first = FakeWebSocket.last();
		first.serverOpen();
		const pending = conn.command?.({ data: 1 }, commandOptions());
		conn.probe?.();
		expect(first.closedWith?.code).toBe(1000);
		expect(await pending).toMatchObject({ status: "unknown" });
		await flush();
		const second = FakeWebSocket.last();
		expect(second).not.toBe(first);
		second.serverOpen();
		expect(a.record.continuity).toEqual([{ reason: "reopened" }]);

		const other = setup();
		subscribe(other.conn, "a", false);
		await flush();
		const socket = FakeWebSocket.last();
		socket.serverOpen();
		other.conn.probe?.();
		expect(socket.closedWith).toBeUndefined();
	});

	it("sends the early notice before auth-blocked or failed when a deliberate reopen ends there", async () => {
		/** Record statuses into the sink's log, so notices and statuses share one order. */
		const interleave = (
			fake: ReturnType<typeof setup>["fake"],
			log: string[],
		) => {
			const setStatus = fake.ctx.setStatus;
			fake.ctx.setStatus = (status) => {
				log.push(`status:${status.state}`);
				setStatus(status);
			};
			log.length = 0;
		};

		// Credentials cannot be obtained for the reopened socket.
		const { conn, fake } = setup(createTopicProtocol({ authenticate: true }));
		fake.setCredentials(async () => ({
			connectionParams: { token: "valid-a-1" },
		}));
		const a = subscribe(conn, "a");
		await flush();
		FakeWebSocket.last().serverOpen();
		interleave(fake, a.record.log);
		fake.setCredentials(() => Promise.reject(new Error("offline")));
		conn.probe?.();
		await flush();
		expect(fake.last()).toEqual({
			state: "auth-blocked",
			reason: "credentials-missing",
		});
		expect(a.record.log).toEqual([
			"status:connecting",
			"continuity:reopened",
			"status:auth-blocked",
		]);
		// Told once; the outcome still precedes the next connected.
		fake.setCredentials(async () => ({
			connectionParams: { token: "valid-a-2" },
		}));
		conn.rotate?.();
		await flush();
		FakeWebSocket.last().serverOpen();
		expect(a.record.log.slice(3)).toEqual([
			"status:connecting",
			"continuity:reopened",
			"status:connected",
		]);

		// The reopened socket cannot be constructed.
		const other = setup();
		const b = subscribe(other.conn, "b");
		await flush();
		FakeWebSocket.last().serverOpen();
		interleave(other.fake, b.record.log);
		vi.stubGlobal("WebSocket", undefined);
		other.conn.probe?.();
		await flush();
		expect(other.fake.last()).toMatchObject({
			state: "failed",
			code: "websocket-unavailable",
		});
		expect(b.record.log).toEqual([
			"status:connecting",
			"continuity:reopened",
			"status:failed",
		]);
	});
});

// NT-U-46, (phase 2b): protocol hooks that throw are
// isolated. A throwing subscribe hook ends that topic only with
// `subscribe-rejected`; a throwing unsubscribe hook is a diagnostic only; a
// throwing classifyClose is transient; a throwing heartbeat.frame() is a
// liveness failure. Each emits a value-free `protocol-hook-error` diagnostic,
// and liveness is armed before the wire is reconciled.
describe("throwing protocol hooks", () => {
	const decode: WebSocketProtocol["decode"] = (raw) => {
		const message = JSON.parse(String(raw)) as {
			type?: string;
			topic?: string;
		};
		return message.type === "pong"
			? { kind: "heartbeat" }
			: { kind: "event", topics: [String(message.topic)], event: message };
	};
	const hookErrors = (fake: ReturnType<typeof setup>["fake"]) =>
		fake.diagnostics.filter((event) => event.type === "protocol-hook-error");

	it("ends only the topic whose subscribe hook throws; the others subscribe and liveness stays armed", async () => {
		const { conn, fake } = setup({
			decode,
			subscribe: (topic) => {
				if (topic === "bad") throw new Error("cannot encode secret-topic");
				return [JSON.stringify({ op: "sub", topic })];
			},
			heartbeat: { expectInboundWithinMs: 1_000 },
		});
		const bad = subscribe(conn, "bad");
		const good = subscribe(conn, "good");
		await flush();
		const socket = FakeWebSocket.last();
		socket.serverOpen();
		expect(socket.sent).toEqual([JSON.stringify({ op: "sub", topic: "good" })]);
		expect(bad.record.errors).toEqual([
			{
				code: "subscribe-rejected",
				message: "The protocol could not encode the subscription.",
			},
		]);
		expect(good.record.errors).toEqual([]);
		expect(hookErrors(fake)).toEqual([
			{ type: "protocol-hook-error", detail: { hook: "subscribe" } },
		]);
		expect(JSON.stringify(fake.diagnostics)).not.toContain("secret-topic");
		// Silence past the inbound expectation: liveness was armed.
		await vi.advanceTimersByTimeAsync(1_000);
		expect(
			fake.diagnostics.filter((event) => event.type === "heartbeat-missed"),
		).toHaveLength(1);
		expect(socket.closedWith?.code).toBe(CLOSE_LIVENESS);
		// The rejected topic is never retried on the next socket.
		await vi.advanceTimersByTimeAsync(500);
		const next = FakeWebSocket.last();
		expect(next).not.toBe(socket);
		next.serverOpen();
		expect(next.sent).toEqual([JSON.stringify({ op: "sub", topic: "good" })]);
	});

	it("reports a throwing unsubscribe hook and still unsubscribes the other topics", async () => {
		const { conn, fake } = setup({
			decode,
			subscribe: (topic) => [JSON.stringify({ op: "sub", topic })],
			unsubscribe: (topic) => {
				if (topic === "a") throw new Error("cannot encode");
				return [JSON.stringify({ op: "unsub", topic })];
			},
		});
		const a = subscribe(conn, "a");
		const b = subscribe(conn, "b");
		await flush();
		const socket = FakeWebSocket.last();
		socket.serverOpen();
		a.sub.unsubscribe();
		b.sub.unsubscribe();
		await flush();
		expect(socket.json()).toEqual([
			{ op: "sub", topic: "a" },
			{ op: "sub", topic: "b" },
			{ op: "unsub", topic: "b" },
		]);
		expect(hookErrors(fake)).toEqual([
			{ type: "protocol-hook-error", detail: { hook: "unsubscribe" } },
		]);
		subscribe(conn, "c");
		await flush();
		expect(socket.json().at(-1)).toEqual({ op: "sub", topic: "c" });
	});

	it("treats a throwing classifyClose as transient: early notice, reconnecting, then a new socket", async () => {
		const { conn, fake } = setup({
			decode,
			classifyClose: (code) => {
				if (code === 4999) throw new Error("unexpected code");
				return "transient";
			},
		});
		const one = subscribe(conn);
		await flush();
		const socket = FakeWebSocket.last();
		socket.serverOpen();
		socket.serverClose(4999, "", true);
		expect(hookErrors(fake)).toEqual([
			{ type: "protocol-hook-error", detail: { hook: "classifyClose" } },
		]);
		expect(fake.last()).toMatchObject({
			state: "reconnecting",
			reason: "server-closed",
			code: 4999,
		});
		expect(one.record.continuity).toEqual([{ reason: "reconnected" }]);
		await vi.advanceTimersByTimeAsync(500);
		expect(FakeWebSocket.instances).toHaveLength(2);
	});

	it("counts a throwing heartbeat.frame() as a liveness failure: close 4000 and one reconnect", async () => {
		const { conn, fake } = setup({
			decode,
			heartbeat: {
				intervalMs: 1_000,
				timeoutMs: 500,
				frame: () => {
					throw new Error("cannot encode ping");
				},
			},
		});
		subscribe(conn);
		await flush();
		const socket = FakeWebSocket.last();
		socket.serverOpen();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(hookErrors(fake)).toEqual([
			{ type: "protocol-hook-error", detail: { hook: "heartbeat.frame" } },
		]);
		expect(
			fake.diagnostics.filter((event) => event.type === "heartbeat-missed"),
		).toEqual([{ type: "heartbeat-missed", detail: { within: 500 } }]);
		expect(socket.closedWith?.code).toBe(CLOSE_LIVENESS);
		expect(fake.last()).toMatchObject({
			state: "reconnecting",
			reason: "heartbeat-timeout",
		});
		// Only the reconnect timer is left: the probe loop stopped with the socket.
		expect(vi.getTimerCount()).toBe(1);
		await vi.advanceTimersByTimeAsync(500);
		expect(FakeWebSocket.instances).toHaveLength(2);
	});
});

// NT-U-49, (the C1-F4 class): heartbeat timing options arm host
// timers, and a delay above 2^31 - 1 runs at once, so each is capped at
// MAX_TIMER_MS with the page options' sentence and the option's path.
describe("heartbeat timing options stay within MAX_TIMER_MS", () => {
	const MAX = 2_147_483_647;
	const frame = () => "ping";
	const define = (heartbeat: Record<string, unknown>) => () =>
		websocketAdapter({
			protocols: {
				p: { decode: () => ({ kind: "ignore" }), heartbeat } as never,
			},
		});

	it.each([
		["intervalMs", { intervalMs: 2 ** 31, timeoutMs: 1_000, frame }],
		["timeoutMs", { intervalMs: 1_000, timeoutMs: 2 ** 31, frame }],
		["expectInboundWithinMs", { expectInboundWithinMs: 2 ** 31 }],
	] as const)("refuses heartbeat.%s of 2^31 with the path and the fixed sentence", (key, heartbeat) => {
		const path = `websocketAdapter.protocols.p.heartbeat.${key}`;
		expect(define(heartbeat)).toThrowError(
			expect.objectContaining({
				code: "unsupported-option",
				message: `${path} must be an integer between 1 and ${MAX}.`,
				detail: { path },
			}),
		);
	});

	it("accepts 2^31 - 1 for every heartbeat timing option (guard)", () => {
		expect(define({ intervalMs: MAX, timeoutMs: MAX, frame })).not.toThrow();
		expect(define({ expectInboundWithinMs: MAX })).not.toThrow();
	});
});

// NT-U-50, (RES-HB): the heartbeat shape is chosen by defined values,
// never by key presence. A defined `intervalMs` is the probe; otherwise a
// defined `expectInboundWithinMs` is the inbound expectation; otherwise the
// heartbeat is refused at its path. The runtime reads only that shape.
describe("heartbeat shape by defined values, never key presence", () => {
	const path = "websocketAdapter.protocols.p.heartbeat";
	const sentence =
		"must be { intervalMs, timeoutMs, frame() } or { expectInboundWithinMs }.";
	const frame = () => JSON.stringify({ type: "ping" });
	const define = (heartbeat: unknown) => () =>
		websocketAdapter({
			protocols: {
				p: { decode: () => ({ kind: "ignore" }), heartbeat } as never,
			},
		});

	it("runs inbound liveness for { expectInboundWithinMs, intervalMs: undefined }, with no probe and no close-4000 loop (RES-HB)", async () => {
		// TypeScript accepts this form: `intervalMs` is a key of the union.
		const { conn, fake } = setup(
			createTopicProtocol({
				heartbeat: { expectInboundWithinMs: 5_000, intervalMs: undefined },
			}),
		);
		subscribe(conn, "a");
		await flush();
		const socket = FakeWebSocket.last();
		socket.serverOpen();
		const sent = socket.sent.length;
		vi.advanceTimersByTime(4_000);
		socket.serverMessage(
			JSON.stringify({ type: "event", topic: "a", data: 1 }),
		);
		vi.advanceTimersByTime(4_999);
		expect(socket.closedWith).toBeUndefined();
		expect(socket.sent).toHaveLength(sent);
		vi.advanceTimersByTime(1);
		expect(socket.closedWith).toEqual({
			code: CLOSE_LIVENESS,
			reason: "liveness",
		});
		const types = fake.diagnostics.map((event) => event.type);
		expect(types).not.toContain("protocol-hook-error");
		expect(
			fake.diagnostics.filter((event) => event.type === "heartbeat-missed"),
		).toEqual([{ type: "heartbeat-missed", detail: { within: 5_000 } }]);
		vi.advanceTimersByTime(500);
		await flush();
		expect(FakeWebSocket.instances).toHaveLength(2);
		const second = FakeWebSocket.last();
		second.serverOpen();
		vi.advanceTimersByTime(4_999);
		expect(second.closedWith).toBeUndefined();
		expect(FakeWebSocket.instances).toHaveLength(2);
	});

	it("probes for a valid probe shape beside expectInboundWithinMs: undefined (guard)", async () => {
		const { conn } = setup(
			createTopicProtocol({
				heartbeat: {
					intervalMs: 1_000,
					timeoutMs: 500,
					frame,
					expectInboundWithinMs: undefined,
				},
			}),
		);
		subscribe(conn, "a");
		await flush();
		const socket = FakeWebSocket.last();
		socket.serverOpen();
		vi.advanceTimersByTime(1_000);
		expect(frames(socket).at(-1)).toEqual({ type: "ping" });
	});

	it.each([
		["an empty object", {}],
		[
			"both timings undefined",
			{ intervalMs: undefined, expectInboundWithinMs: undefined },
		],
		[
			"probe keys without intervalMs",
			{ intervalMs: undefined, timeoutMs: 500, frame },
		],
		["null", null],
	] as const)("refuses a heartbeat with neither timing defined at its path: %s", (_, heartbeat) => {
		expect(define(heartbeat)).toThrowError(
			expect.objectContaining({
				code: "unsupported-option",
				message: `${path}: ${sentence}`,
				detail: { path },
			}),
		);
	});

	it.each([
		["intervalMs without timeoutMs and frame()", { intervalMs: 1_000 }],
		["intervalMs: null", { intervalMs: null }],
	] as const)("treats a defined intervalMs as the probe shape: %s beside a valid expectation is refused", (_, probe) => {
		expect(define({ ...probe, expectInboundWithinMs: 5_000 })).toThrowError(
			expect.objectContaining({
				code: "unsupported-option",
				message: `${path}: ${sentence}`,
				detail: { path },
			}),
		);
	});

	// VF3-1: the `probe()` read site. After a suspension (the clock
	// jumped past the expectation before any timer ran), a coordinated return
	// check fails a lapsed inbound expectation at once, for the RES-HB form
	// exactly as for the plain form.
	it.each([
		["the plain inbound form (guard)", { expectInboundWithinMs: 5_000 }],
		["RES-HB", { expectInboundWithinMs: 5_000, intervalMs: undefined }],
	] as const)("probe() after a suspension fails a lapsed inbound expectation at once: %s", async (_, heartbeat) => {
		const { conn, fake } = setup(createTopicProtocol({ heartbeat }));
		subscribe(conn, "a");
		await flush();
		const socket = FakeWebSocket.last();
		socket.serverOpen();
		const sent = socket.sent.length;
		vi.setSystemTime(Date.now() + 6_000);
		conn.probe?.();
		expect(socket.closedWith).toEqual({
			code: CLOSE_LIVENESS,
			reason: "liveness",
		});
		expect(socket.sent).toHaveLength(sent);
		expect(
			fake.diagnostics.filter((event) => event.type === "heartbeat-missed"),
		).toEqual([{ type: "heartbeat-missed", detail: { within: 5_000 } }]);
		expect(fake.diagnostics.map((event) => event.type)).not.toContain(
			"protocol-hook-error",
		);
	});

	// VF3-1: the frame() clause of the probe completeness check. Valid
	// probe timings without a frame() function are refused beside a valid
	// expectation; they never fall back to the inbound shape.
	it.each([
		[
			"without frame()",
			{ intervalMs: 1_000, timeoutMs: 500, expectInboundWithinMs: 5_000 },
		],
		[
			'with frame: "ping"',
			{
				intervalMs: 1_000,
				timeoutMs: 500,
				frame: "ping",
				expectInboundWithinMs: 5_000,
			},
		],
	] as const)("refuses probe timings beside a valid expectation when frame is not a function: %s", (_, heartbeat) => {
		expect(define(heartbeat)).toThrowError(
			expect.objectContaining({
				code: "unsupported-option",
				message: `${path}: ${sentence}`,
				detail: { path },
			}),
		);
	});
});
