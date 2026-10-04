import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	AdapterConnection,
	ConnectionContext,
	SubscriptionSink,
} from "../../../src/core/adapter.ts";
import {
	trpcSseAdapter,
	trpcWsAdapter,
} from "../../../src/integrations/trpc/runtime.ts";
import { graphqlSseAdapter } from "../../../src/protocols/graphql-sse/runtime.ts";
import type { GraphqlSseConnection } from "../../../src/protocols/graphql-sse/spec.ts";
import { graphqlWsAdapter } from "../../../src/protocols/graphql-ws/runtime.ts";
import { socketIoAdapter } from "../../../src/protocols/socket-io/runtime.ts";
import { createTestContext } from "../../integration/protocols/helpers.ts";
import { FakeWebSocket } from "./fakes.ts";

// Re-executed operations have unknown continuity at detection. Report the early notice and the reconnect outcome so reconciliation covers events sent during the outage.

/**
 * Scripted socket.io-client: tests play Engine.IO and the server (connect,
 * disconnect reasons, Manager reconnect attempts). Only the surface the
 * adapter uses is modelled.
 */
const io = vi.hoisted(() => {
	type Listener = (...args: unknown[]) => void;
	class Emitter {
		readonly #listeners = new Map<string, Set<Listener>>();
		on(event: string, listener: Listener): this {
			const set = this.#listeners.get(event) ?? new Set();
			set.add(listener);
			this.#listeners.set(event, set);
			return this;
		}
		off(event: string, listener: Listener): this {
			this.#listeners.get(event)?.delete(listener);
			return this;
		}
		removeAllListeners(): this {
			this.#listeners.clear();
			return this;
		}
		/** Server/Engine.IO side: dispatch a reserved event. */
		fire(event: string, ...args: unknown[]): void {
			for (const listener of [...(this.#listeners.get(event) ?? [])]) {
				listener(...args);
			}
		}
	}
	class FakeSocket extends Emitter {
		connected = false;
		active = false;
		recovered = false;
		auth: unknown;
		sendBuffer: unknown[] = [];
		connect(): this {
			this.active = true;
			return this;
		}
		disconnect(): this {
			this.active = false;
			if (this.connected) this.drop("io client disconnect");
			return this;
		}
		serverConnect(recovered = false): void {
			this.connected = true;
			this.recovered = recovered;
			this.fire("connect");
		}
		drop(reason: string): void {
			this.connected = false;
			this.fire("disconnect", reason);
		}
	}
	class FakeManager extends Emitter {
		static last: FakeManager | undefined;
		readonly engine = { transport: { name: "websocket" } };
		readonly sockets: FakeSocket[] = [];
		constructor() {
			super();
			FakeManager.last = this;
		}
		socket(): FakeSocket {
			const socket = new FakeSocket();
			this.sockets.push(socket);
			return socket;
		}
		open(): this {
			return this;
		}
	}
	return { FakeManager };
});
vi.mock("socket.io-client", () => ({ Manager: io.FakeManager }));

const QUERY = "subscription { ticks { n } }";
const flush = () => vi.advanceTimersByTimeAsync(0);

let connections: AdapterConnection[] = [];

beforeEach(() => {
	vi.useFakeTimers();
	FakeWebSocket.reset();
});
afterEach(() => {
	for (const connection of connections) connection.dispose();
	connections = [];
	vi.useRealTimers();
});

/** One ordered log of connection statuses and continuity notices. */
function orderedLog() {
	const log: string[] = [];
	const test = createTestContext({
		scope: "s",
		now: () => Date.now(),
		limits: { idleCloseMs: 50 },
		credentials: (revision) => ({
			headers: { authorization: `Bearer t${revision}` },
			connectionParams: { token: `t${revision}` },
		}),
	});
	const ctx: ConnectionContext = {
		...test.ctx,
		setStatus(status) {
			log.push(`status:${status.state}`);
			test.ctx.setStatus(status);
		},
	};
	/** A sink whose entries carry `name` when several subscriptions share the log. */
	const sinkFor = (name?: string): SubscriptionSink<unknown> => {
		const prefix = name ? `${name} ` : "";
		return {
			next() {},
			error(error) {
				log.push(`${prefix}error:${error.code}`);
			},
			complete() {
				log.push(`${prefix}complete`);
			},
			continuity(reason) {
				log.push(`${prefix}continuity:${reason}`);
			},
			started() {},
		};
	};
	const sink = sinkFor();
	/** Repeated statuses collapse; every continuity notice stays visible. */
	const transitions = () =>
		log.filter(
			(entry, index) =>
				!entry.startsWith("status:") || entry !== log[index - 1],
		);
	return { log, test, ctx, sink, sinkFor, transitions };
}

const TWO_INTERRUPTIONS = [
	"status:connecting",
	"status:connected",
	"continuity:reconnected",
	"status:reconnecting",
	"continuity:reconnected",
	"status:connected",
	"continuity:reconnected",
	"status:reconnecting",
	"continuity:reconnected",
	"status:connected",
];

describe("graphql-ws: continuity before status on a missed pong (APL-15)", () => {
	it("reports each interruption early, then its outcome before connected", async () => {
		const { ctx, sink, transitions } = orderedLog();
		const connection = graphqlWsAdapter({
			webSocketImpl: FakeWebSocket,
			retryWait: async () => {},
		}).connect(
			{ url: "wss://api.test/graphql", keepAliveMs: 1_000, pongTimeoutMs: 500 },
			ctx,
		);
		connections.push(connection);
		connection.subscribe({ query: QUERY }, sink, {
			key: "k",
			repeatable: true,
		});
		await flush();
		FakeWebSocket.last().accept();
		await flush();

		for (let round = 1; round <= 2; round += 1) {
			const socket = FakeWebSocket.last();
			const [id] = socket.subscribeIds();
			socket.receive({
				id,
				type: "next",
				payload: { data: { ticks: { n: round } } },
			});
			// The keepAlive ping goes unanswered: the watchdog fires 500 ms later.
			await vi.advanceTimersByTimeAsync(1_500);
			expect(socket.closedWith?.code).toBe(4499);
			await flush();
			expect(FakeWebSocket.instances).toHaveLength(round + 1);
			FakeWebSocket.last().accept();
			await flush();
		}

		expect(transitions()).toEqual(TWO_INTERRUPTIONS);
	});
});

describe("graphql-sse: continuity before status on a missed heartbeat (APL-15)", () => {
	function stream() {
		const encoder = new TextEncoder();
		let controller!: ReadableStreamDefaultController<Uint8Array>;
		const body = new ReadableStream<Uint8Array>({
			start(c) {
				controller = c;
			},
		});
		return {
			response: new Response(body, {
				status: 200,
				headers: { "content-type": "text/event-stream; charset=utf-8" },
			}),
			push: (text: string) => controller.enqueue(encoder.encode(text)),
		};
	}

	function setup(mode: GraphqlSseConnection["mode"]) {
		const context = orderedLog();
		const streams: ReturnType<typeof stream>[] = [];
		let operationId = "";
		const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
			const method = init?.method ?? "GET";
			if (method === "PUT") return new Response("token", { status: 201 });
			if (method === "POST" && mode === "single") {
				operationId = JSON.parse(String(init?.body)).extensions.operationId;
				return new Response(null, { status: 202 });
			}
			if (method === "DELETE") return new Response(null, { status: 200 });
			const created = stream();
			streams.push(created);
			return created.response;
		}) as typeof fetch;
		const connection = graphqlSseAdapter({
			fetchFn,
			retry: async () => {},
		}).connect(
			{ url: "https://api.test/graphql/stream", mode, heartbeatMs: 40 },
			context.ctx,
		);
		connections.push(connection);
		/** Deliver one result on the newest stream. */
		const deliver = (n: number) => {
			const payload = { data: { ticks: { n } } };
			streams
				.at(-1)
				?.push(
					`event: next\ndata: ${JSON.stringify(
						mode === "single" ? { id: operationId, payload } : payload,
					)}\n\n`,
				);
		};
		return { ...context, connection, streams, deliver };
	}

	for (const mode of ["distinct", "single"] as const) {
		it(`${mode} mode: reports each interruption early, then its outcome before connected`, async () => {
			const { connection, sink, streams, deliver, transitions } = setup(mode);
			connection.subscribe({ query: QUERY }, sink, {
				key: "k",
				repeatable: true,
			});
			await flush();
			expect(streams).toHaveLength(1);

			for (let round = 1; round <= 2; round += 1) {
				deliver(round);
				await flush();
				// No bytes for 2.5 × 40 ms: the watchdog fails the stream and
				// upstream reopens it at once (zero backoff).
				await vi.advanceTimersByTimeAsync(100);
				await flush();
				expect(streams).toHaveLength(round + 1);
			}

			expect(transitions()).toEqual(TWO_INTERRUPTIONS);
		});
	}

	it("distinct mode: only the stalled stream reports its loss and outcome", async () => {
		const { connection, sinkFor, streams, transitions } = setup("distinct");
		connection.subscribe({ query: QUERY }, sinkFor("a"), {
			key: "a",
			repeatable: true,
		});
		connection.subscribe(
			{ query: "subscription { other { n } }" },
			sinkFor("b"),
			{
				key: "b",
				repeatable: true,
			},
		);
		await flush();
		expect(streams).toHaveLength(2);
		const [a, b] = streams as [
			ReturnType<typeof stream>,
			ReturnType<typeof stream>,
		];
		a.push(`event: next\ndata: {"data":{"ticks":{"n":1}}}\n\n`);
		b.push(`event: next\ndata: {"data":{"other":{"n":1}}}\n\n`);
		await flush();
		// B keeps sending heartbeat comments; A is silent past 2.5 × 40 ms.
		for (let beat = 0; beat < 3; beat += 1) {
			b.push(":\n\n");
			await vi.advanceTimersByTimeAsync(40);
		}
		expect(streams).toHaveLength(3);
		const reopened = streams[2] as ReturnType<typeof stream>;
		// Now B stalls while the reopened A stream stays alive.
		for (let beat = 0; beat < 3; beat += 1) {
			reopened.push(":\n\n");
			await vi.advanceTimersByTimeAsync(40);
		}
		expect(streams).toHaveLength(4);

		expect(transitions()).toEqual([
			"status:connecting",
			"status:connected",
			"a continuity:reconnected",
			"status:reconnecting",
			"a continuity:reconnected",
			"status:connected",
			"b continuity:reconnected",
			"status:reconnecting",
			"b continuity:reconnected",
			"status:connected",
		]);
	});

	it("distinct mode: a twin told of another stream's loss still reports its own interruption", async () => {
		const { connection, sinkFor, streams, transitions } = setup("distinct");
		// Byte-identical payloads under two keys: a stalled stream's request
		// body matches both records, so each loss is reported to both (an
		// extra notice is conservative; a missing one is the defect).
		connection.subscribe({ query: QUERY }, sinkFor("a"), {
			key: "a",
			repeatable: true,
		});
		connection.subscribe({ query: QUERY }, sinkFor("b"), {
			key: "b",
			repeatable: true,
		});
		await flush();
		expect(streams).toHaveLength(2);
		const [a, b] = streams as [
			ReturnType<typeof stream>,
			ReturnType<typeof stream>,
		];
		a.push(`event: next\ndata: {"data":{"ticks":{"n":1}}}\n\n`);
		b.push(`event: next\ndata: {"data":{"ticks":{"n":1}}}\n\n`);
		await flush();
		// A is silent past 2.5 × 40 ms while B keeps beating.
		for (let beat = 0; beat < 3; beat += 1) {
			b.push(":\n\n");
			await vi.advanceTimersByTimeAsync(40);
		}
		expect(streams).toHaveLength(3);
		const reopened = streams[2] as ReturnType<typeof stream>;
		// B's own stream delivers: it is live, so the earlier notice is spent.
		b.push(`event: next\ndata: {"data":{"ticks":{"n":2}}}\n\n`);
		await flush();
		// Now B really stalls while the reopened A stream stays alive.
		for (let beat = 0; beat < 3; beat += 1) {
			reopened.push(":\n\n");
			await vi.advanceTimersByTimeAsync(40);
		}
		expect(streams).toHaveLength(4);

		expect(transitions()).toEqual([
			"status:connecting",
			"status:connected",
			"a continuity:reconnected",
			"b continuity:reconnected",
			"status:reconnecting",
			// Only the reopened stream reports an outcome; B never lost delivery.
			"a continuity:reconnected",
			"status:connected",
			"a continuity:reconnected",
			"b continuity:reconnected",
			"status:reconnecting",
			"b continuity:reconnected",
			"status:connected",
		]);
	});
});

describe("socket.io: continuity before status on a lost session (APL-15)", () => {
	function setup() {
		const context = orderedLog();
		const connection = socketIoAdapter().connect(
			{ url: "http://api.test", sharing: "shared" },
			context.ctx,
		);
		connections.push(connection);
		connection.subscribe({ event: "tick" }, context.sink, {
			key: "k",
			repeatable: true,
		});
		const manager = io.FakeManager.last;
		const socket = manager?.sockets.at(-1);
		if (!manager || !socket) throw new Error("no socket was created");
		return { ...context, manager, socket };
	}

	it("reports each interruption early, then its outcome before connected", () => {
		const { manager, socket, transitions } = setup();
		socket.serverConnect();
		// A missed Engine.IO heartbeat, then one failed attempt.
		socket.drop("ping timeout");
		manager.fire("reconnect_attempt", 1);
		socket.fire("connect_error", new Error("xhr poll error"));
		manager.fire("reconnect_attempt", 2);
		socket.serverConnect();
		// A transport close the server cannot recover.
		socket.drop("transport close");
		manager.fire("reconnect_attempt", 1);
		socket.serverConnect();

		expect(transitions()).toEqual(TWO_INTERRUPTIONS);
	});

	it("upgrades the reported loss to recovered before connected", () => {
		const { manager, socket, transitions } = setup();
		socket.serverConnect();
		socket.drop("transport close");
		manager.fire("reconnect_attempt", 1);
		// Connection-state recovery restored the session and missed packets.
		socket.serverConnect(true);

		expect(transitions()).toEqual([
			"status:connecting",
			"status:connected",
			"continuity:reconnected",
			"status:reconnecting",
			"continuity:recovered",
			"status:connected",
		]);
	});
});

describe("tRPC: continuity before status on a lost stream (APL-15)", () => {
	type Listener = (this: unknown, event: unknown) => void;

	/** Minimal EventTarget-style fake shared by the socket and the source. */
	class Scripted {
		readonly #listeners = new Map<string, Set<Listener>>();
		addEventListener(type: string, listener: Listener): void {
			const set = this.#listeners.get(type) ?? new Set();
			set.add(listener);
			this.#listeners.set(type, set);
		}
		removeEventListener(type: string, listener: Listener): void {
			this.#listeners.get(type)?.delete(listener);
		}
		dispatch(type: string, event: unknown): void {
			for (const listener of [...(this.#listeners.get(type) ?? [])]) {
				listener.call(this, event);
			}
		}
	}

	/** Scripted WebSocket for tRPC's wsClient; tests play the tRPC server. */
	class FakeTrpcSocket extends Scripted {
		static readonly CONNECTING = 0;
		static readonly OPEN = 1;
		static readonly CLOSING = 2;
		static readonly CLOSED = 3;
		static instances: FakeTrpcSocket[] = [];
		readyState = 0;
		binaryType = "blob";
		readonly sent: string[] = [];
		constructor() {
			super();
			FakeTrpcSocket.instances.push(this);
		}
		send(data: string): void {
			this.sent.push(data);
		}
		close(): void {
			if (this.readyState >= 2) return;
			this.readyState = 3;
			this.dispatch("close", { code: 1000, reason: "", wasClean: true });
		}
		open(): void {
			this.readyState = 1;
			this.dispatch("open", {});
		}
		receive(message: unknown): void {
			this.dispatch("message", { data: JSON.stringify(message) });
		}
		drop(): void {
			this.readyState = 3;
			this.dispatch("close", { code: 1006, reason: "", wasClean: false });
		}
		subscriptionIds(): unknown[] {
			return this.sent
				.filter((data) => data.startsWith("{") || data.startsWith("["))
				.flatMap((data) => JSON.parse(data) as unknown)
				.filter(
					(message): message is { id: unknown; method: string } =>
						(message as { method?: unknown }).method === "subscription",
				)
				.map((message) => message.id);
		}
	}

	/** Scripted EventSource for tRPC's httpSubscriptionLink. */
	class FakeEventSource extends Scripted {
		static instances: FakeEventSource[] = [];
		readonly CONNECTING = 0;
		readonly OPEN = 1;
		readonly CLOSED = 2;
		readyState = 0;
		constructor() {
			super();
			FakeEventSource.instances.push(this);
		}
		close(): void {
			this.readyState = 2;
		}
		connected(): void {
			this.readyState = 1;
			this.dispatch("connected", { data: "{}" });
		}
		message(data: unknown, lastEventId = ""): void {
			this.dispatch("message", { data: JSON.stringify(data), lastEventId });
		}
		/** A network error the browser's EventSource retries itself. */
		lost(): void {
			this.readyState = 0;
			this.dispatch("error", { type: "error" });
		}
	}

	beforeEach(() => {
		FakeTrpcSocket.instances = [];
		FakeEventSource.instances = [];
	});

	async function runWs(replay: boolean, rounds: number) {
		const { ctx, sink, transitions } = orderedLog();
		const connection = trpcWsAdapter({
			WebSocket: FakeTrpcSocket as unknown as typeof WebSocket,
			retryDelayMs: () => 0,
		}).connect({ url: "ws://api.test/trpc" }, ctx);
		connections.push(connection);
		connection.subscribe(
			{ path: "ticks", ...(replay ? { replay } : {}) },
			sink,
			{
				key: "k",
				repeatable: true,
			},
		);
		await flush();
		for (let round = 1; round <= rounds; round += 1) {
			const socket = FakeTrpcSocket.instances.at(-1) as FakeTrpcSocket;
			socket.open();
			await flush();
			const [id] = socket.subscriptionIds();
			socket.receive({ id, result: { type: "started" } });
			socket.receive({
				id,
				result: { type: "data", id: String(round), data: { n: round } },
			});
			await flush();
			if (round === rounds) break;
			socket.drop();
			await flush();
			expect(FakeTrpcSocket.instances).toHaveLength(round + 1);
		}
		return transitions();
	}

	it("WebSocket: reports each interruption early, then its outcome before connected", async () => {
		expect(await runWs(false, 3)).toEqual(TWO_INTERRUPTIONS);
	});

	it("WebSocket with declared replay: the resumed outcome is decided at reconnect, before connected", async () => {
		expect(await runWs(true, 3)).toEqual([
			"status:connecting",
			"status:connected",
			"continuity:reconnected",
			"status:reconnecting",
			"continuity:resumed-with-cursor",
			"status:connected",
			"continuity:reconnected",
			"status:reconnecting",
			"continuity:resumed-with-cursor",
			"status:connected",
		]);
	});

	it("SSE: reports each interruption early, then its outcome before connected", async () => {
		const { ctx, sink, transitions } = orderedLog();
		const connection = trpcSseAdapter({
			EventSource: FakeEventSource,
		}).connect({ url: "https://api.test/trpc", anonymous: true }, ctx);
		connections.push(connection);
		connection.subscribe({ path: "ticks" }, sink, {
			key: "k",
			repeatable: true,
		});
		await flush();
		const source = FakeEventSource.instances.at(-1) as FakeEventSource;
		for (let round = 1; round <= 3; round += 1) {
			// The browser's EventSource reopens itself; the server greets again.
			source.connected();
			await flush();
			source.message({ n: round });
			await flush();
			if (round === 3) break;
			source.lost();
			await flush();
		}
		expect(FakeEventSource.instances).toHaveLength(1);

		expect(transitions()).toEqual(TWO_INTERRUPTIONS);
	});
});
