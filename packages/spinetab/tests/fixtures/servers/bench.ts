import type { IncomingMessage } from "node:http";
import {
	GraphQLFloat,
	GraphQLInt,
	GraphQLNonNull,
	GraphQLObjectType,
	GraphQLSchema,
	GraphQLString,
} from "graphql";
import { useServer as serveGraphqlWs } from "graphql-ws/use/ws";
import { type WebSocket, WebSocketServer } from "ws";
import {
	type BenchEvent,
	EVENT_BYTES,
	isMarker,
	makeEvent,
	RATE_HZ,
	TOPICS,
} from "../harness/src/bench/event.ts";
import { type Fault, type FixtureApp, sendJson } from "./app.ts";

/**
 * Reference workload generator.
 *
 * One scheduler per fixture app emits 100 topics round-robin, one topic every
 * 1000 / rate ms (default 100 events/s aggregate, 1 Hz per topic). Every
 * current subscriber of a topic receives the same event, so wire messages are
 * rate × subscribers per topic. The timer exists only while at least one
 * subscriber exists; due times come from `performance.now()` at start and
 * overdue ticks are emitted immediately with their lag recorded.
 *
 * Endpoints:
 * - `WS /bench/graphql-ws`: real graphql-ws 6.3.0 server (`graphql-ws/use/ws`,
 * keepAlive 0) with `subscription { feed(topic: Int!) { topic seq emittedAt body } }`.
 * - `WS /bench/ws`: JSON text frames. Client → server `{op:"sub"|"unsub",topic}`,
 * `{op:"ping"}`, `{op:"cmd",id,payload?}`, `{op:"auth",token}`; server →
 * client the event itself (no `op`), `{op:"pong"}`, `{op:"ack",id,result}`.
 * Any query (`?c=<n>`) is accepted so distinct URLs are distinct connections.
 * - `GET /__fixture/bench/clock`: `{ now }` = Node `performance.timeOrigin + performance.now()`.
 * - `GET /__fixture/bench/state`: applies pending faults, returns counters and per-topic seqs.
 * - `GET /__fixture/bench/requests`: every HTTP and upgrade request seen by this app (privacy).
 *
 * Faults (`POST /__fixture/fault`, target `bench`; applied on the next tick,
 * frame or `/__fixture/bench/*` request):
 * - state: `rate` (Hz), `size` (event bytes; only for topic `sizeTopic` when
 * that is set), `pause`, `holdAcks`, `ackDelayMs`, `marker` (ASCII string
 * seeded into every body)
 * - action (once per posted fault): `stall` (existing sockets drop every
 * outbound frame and ignore inbound: half-open; later connections are
 * healthy; stalled sockets stay dead), `terminate` (hard-close every socket),
 * `releaseAcks` (send held acks)
 *
 * Counters: `app.counters.bench` (computed on read).
 */

type Endpoint = "graphql-ws" | "ws";

interface Conn {
	readonly id: number;
	readonly endpoint: Endpoint;
	readonly ws: WebSocket;
	readonly url: string;
	stalled: boolean;
	/** Native subscriptions by topic. */
	readonly topics: Map<number, Subscriber>;
}

interface Subscriber {
	readonly topic: number;
	readonly conn: Conn;
	deliver(event: BenchEvent, json: () => string): void;
}

interface EndpointTotals {
	connections: number;
	subscriptions: number;
}

interface HeldAck {
	conn: Conn;
	frame: string;
}

const MAX_REQUESTS = 10_000;
const MAX_QUEUE = 10_000;
/** Catch-up bound after a blocked event loop; the rest is recorded as late. */
const MAX_CATCH_UP = 1_000;

const now = () => performance.timeOrigin + performance.now();

export function register(app: FixtureApp): void {
	const conns = new Set<Conn>();
	const byWs = new Map<WebSocket, Conn>();
	const subscribers = new Map<number, Set<Subscriber>>();
	const seqs = new Map<number, number>();
	const ackTimers = new Set<ReturnType<typeof setTimeout>>();
	let held: HeldAck[] = [];
	let nextConn = 0;
	let requests: Array<{
		method: string;
		url: string;
		dest: string | null;
		upgrade: boolean;
		at: number;
	}> = [];

	const zero = () => ({
		endpoints: {
			"graphql-ws": { connections: 0, subscriptions: 0 },
			ws: { connections: 0, subscriptions: 0 },
		} as Record<Endpoint, EndpointTotals>,
		emitted: 0,
		wireMessages: 0,
		wireBytes: 0,
		droppedFrames: 0,
		serverDrops: 0,
		maxLagMs: 0,
		lateTicks: 0,
		stalls: 0,
		terminated: 0,
		commands: 0,
		acksSent: 0,
		auths: 0,
		authTokens: [] as string[],
		requestCount: 0,
	});
	let totals = zero();

	// Action faults act once per posted fault object.
	let seenStall: Fault | undefined;
	let seenTerminate: Fault | undefined;
	let seenRelease: Fault | undefined;

	const fault = (action: string) => app.fault("bench", action);

	function numberFault(action: string, fallback: number): number {
		const value = Number(fault(action)?.value);
		return Number.isFinite(value) && value > 0 ? value : fallback;
	}

	function marker(): string {
		const value = fault("marker")?.value;
		return typeof value === "string" && isMarker(value) ? value : "";
	}

	/** Apply action faults and flush acks released by clearing `holdAcks`. */
	function sync(): void {
		const stall = fault("stall");
		if (stall && stall !== seenStall) {
			for (const conn of conns) {
				if (!conn.stalled) {
					conn.stalled = true;
					totals.stalls += 1;
				}
			}
		}
		seenStall = stall;
		const terminate = fault("terminate");
		if (terminate && terminate !== seenTerminate) {
			for (const conn of [...conns]) {
				totals.terminated += 1;
				conn.ws.terminate();
			}
		}
		seenTerminate = terminate;
		const release = fault("releaseAcks");
		if ((release && release !== seenRelease) || !fault("holdAcks")) {
			flushHeld();
		}
		seenRelease = release;
	}

	function flushHeld(): void {
		if (held.length === 0) return;
		const list = held;
		held = [];
		for (const { conn, frame } of list) {
			send(conn, frame);
			totals.acksSent += 1;
		}
	}

	function send(conn: Conn, frame: string): void {
		if (conn.stalled || conn.ws.readyState !== conn.ws.OPEN) {
			totals.droppedFrames += 1;
			return;
		}
		conn.ws.send(frame);
	}

	let timer: ReturnType<typeof setTimeout> | undefined;
	let startedAt = 0;
	let tickIndex = 0;
	let intervalMs = 1000 / RATE_HZ;

	const subscriberCount = () => {
		let count = 0;
		for (const set of subscribers.values()) count += set.size;
		return count;
	};

	function ensureScheduler(): void {
		if (timer !== undefined || subscriberCount() === 0) return;
		intervalMs = 1000 / numberFault("rate", RATE_HZ);
		startedAt = performance.now();
		tickIndex = 0;
		arm();
	}

	function stopSchedulerIfIdle(): void {
		if (timer !== undefined && subscriberCount() === 0) {
			clearTimeout(timer);
			timer = undefined;
		}
	}

	function arm(): void {
		const due = startedAt + tickIndex * intervalMs;
		timer = setTimeout(run, Math.max(0, due - performance.now()));
	}

	function run(): void {
		timer = undefined;
		sync();
		if (subscriberCount() === 0) return;
		const current = performance.now();
		const wanted = 1000 / numberFault("rate", RATE_HZ);
		if (wanted !== intervalMs) {
			intervalMs = wanted;
			startedAt = current;
			tickIndex = 0;
		}
		let due = startedAt + tickIndex * intervalMs;
		let emittedNow = 0;
		while (due <= current) {
			const lag = current - due;
			if (lag > totals.maxLagMs) totals.maxLagMs = lag;
			if (lag > intervalMs) totals.lateTicks += 1;
			if (emittedNow >= MAX_CATCH_UP) {
				// Rebase instead of bursting after a long block; the skipped
				// ticks are counted as late.
				const skipped = Math.floor((current - due) / intervalMs);
				totals.lateTicks += skipped;
				tickIndex += skipped;
				due = startedAt + tickIndex * intervalMs;
				break;
			}
			tick(tickIndex % TOPICS);
			tickIndex += 1;
			emittedNow += 1;
			due = startedAt + tickIndex * intervalMs;
		}
		arm();
	}

	function tick(topic: number): void {
		if (fault("pause")) return;
		const set = subscribers.get(topic);
		if (!set || set.size === 0) return;
		const seq = seqs.get(topic) ?? 0;
		seqs.set(topic, seq + 1);
		const sizeTopic = fault("sizeTopic");
		const sized =
			sizeTopic === undefined || Number(sizeTopic.value) === topic
				? numberFault("size", EVENT_BYTES)
				: EVENT_BYTES;
		const event = makeEvent(topic, seq, now(), sized, marker());
		totals.emitted += 1;
		let json: string | undefined;
		const serialised = () => {
			json ??= JSON.stringify(event);
			return json;
		};
		for (const subscriber of [...set]) subscriber.deliver(event, serialised);
	}

	function addSubscriber(subscriber: Subscriber): void {
		let set = subscribers.get(subscriber.topic);
		if (!set) {
			set = new Set();
			subscribers.set(subscriber.topic, set);
		}
		set.add(subscriber);
		totals.endpoints[subscriber.conn.endpoint].subscriptions += 1;
		ensureScheduler();
	}

	function removeSubscriber(subscriber: Subscriber): void {
		const set = subscribers.get(subscriber.topic);
		if (!set?.delete(subscriber)) return;
		if (set.size === 0) subscribers.delete(subscriber.topic);
		stopSchedulerIfIdle();
	}

	function track(endpoint: Endpoint, ws: WebSocket, request: IncomingMessage) {
		sync();
		const conn: Conn = {
			id: nextConn++,
			endpoint,
			ws,
			url: request.url ?? "",
			stalled: false,
			topics: new Map(),
		};
		conns.add(conn);
		byWs.set(ws, conn);
		totals.endpoints[endpoint].connections += 1;
		// Count and (when stalled) drop every outbound frame, including the
		// graphql-ws server's own. The callback still fires so the server's
		// send promise settles.
		const originalSend = ws.send.bind(ws);
		ws.send = ((data: unknown, ...rest: unknown[]) => {
			const callback = rest.find((item) => typeof item === "function") as
				| ((error?: Error) => void)
				| undefined;
			if (conn.stalled) {
				totals.droppedFrames += 1;
				callback?.();
				return;
			}
			totals.wireMessages += 1;
			totals.wireBytes +=
				typeof data === "string"
					? Buffer.byteLength(data)
					: ((data as { byteLength?: number }).byteLength ?? 0);
			(originalSend as (...args: unknown[]) => void)(data, ...rest);
		}) as WebSocket["send"];
		// A stalled socket ignores inbound frames (half-open peer).
		const originalEmit = ws.emit.bind(ws);
		ws.emit = ((event: string | symbol, ...args: unknown[]) => {
			if (event === "message") {
				sync();
				if (conn.stalled) return false;
			}
			return originalEmit(event, ...args);
		}) as WebSocket["emit"];
		ws.once("close", () => {
			conns.delete(conn);
			byWs.delete(ws);
			for (const subscriber of conn.topics.values())
				removeSubscriber(subscriber);
			conn.topics.clear();
			held = held.filter((entry) => entry.conn !== conn);
		});
		return conn;
	}

	const native = new WebSocketServer({
		noServer: true,
		maxPayload: 1024 * 1024,
	});
	native.on("connection", (ws: WebSocket, request: IncomingMessage) => {
		const conn = track("ws", ws, request);
		ws.on("message", (data, isBinary) => {
			if (isBinary) return;
			let message: {
				op?: unknown;
				topic?: unknown;
				id?: unknown;
				token?: unknown;
			};
			try {
				message = JSON.parse(String(data));
			} catch {
				return;
			}
			switch (message.op) {
				case "sub": {
					const topic = Number(message.topic);
					if (!Number.isInteger(topic) || topic < 0 || conn.topics.has(topic))
						return;
					const subscriber: Subscriber = {
						topic,
						conn,
						deliver: (_event, json) => send(conn, json()),
					};
					conn.topics.set(topic, subscriber);
					addSubscriber(subscriber);
					return;
				}
				case "unsub": {
					const topic = Number(message.topic);
					const subscriber = conn.topics.get(topic);
					if (!subscriber) return;
					conn.topics.delete(topic);
					removeSubscriber(subscriber);
					return;
				}
				case "ping":
					send(conn, '{"op":"pong"}');
					return;
				case "cmd": {
					totals.commands += 1;
					const frame = JSON.stringify({
						op: "ack",
						id: String(message.id),
						result: { n: totals.commands },
					});
					if (fault("holdAcks")) {
						held.push({ conn, frame });
						return;
					}
					const delay = numberFault("ackDelayMs", 0);
					if (delay > 0) {
						const handle = setTimeout(() => {
							ackTimers.delete(handle);
							send(conn, frame);
							totals.acksSent += 1;
						}, delay);
						ackTimers.add(handle);
						return;
					}
					send(conn, frame);
					totals.acksSent += 1;
					return;
				}
				case "auth":
					totals.auths += 1;
					totals.authTokens.push(String(message.token));
					if (totals.authTokens.length > 20) totals.authTokens.shift();
					return;
				default:
					return;
			}
		});
	});

	const BenchEventType = new GraphQLObjectType({
		name: "BenchEvent",
		fields: {
			topic: { type: new GraphQLNonNull(GraphQLInt) },
			seq: { type: new GraphQLNonNull(GraphQLInt) },
			emittedAt: { type: new GraphQLNonNull(GraphQLFloat) },
			body: { type: new GraphQLNonNull(GraphQLString) },
		},
	});

	function feed(topic: number, conn: Conn): AsyncIterableIterator<BenchEvent> {
		const queue: BenchEvent[] = [];
		let wake: (() => void) | undefined;
		let done = false;
		const subscriber: Subscriber = {
			topic,
			conn,
			deliver: (event) => {
				if (queue.length >= MAX_QUEUE) {
					queue.shift();
					totals.serverDrops += 1;
				}
				queue.push(event);
				wake?.();
			},
		};
		addSubscriber(subscriber);
		const finish = () => {
			if (done) return;
			done = true;
			removeSubscriber(subscriber);
			wake?.();
		};
		const iterator: AsyncIterableIterator<BenchEvent> = {
			[Symbol.asyncIterator]: () => iterator,
			async next() {
				while (queue.length === 0 && !done) {
					await new Promise<void>((resolve) => {
						wake = resolve;
					});
					wake = undefined;
				}
				const value = queue.shift();
				if (done || value === undefined) {
					return { done: true, value: undefined };
				}
				return { done: false, value };
			},
			async return() {
				finish();
				return { done: true, value: undefined };
			},
			async throw(error?: unknown) {
				finish();
				throw error;
			},
		};
		return iterator;
	}

	const schema = new GraphQLSchema({
		query: new GraphQLObjectType({
			name: "Query",
			fields: { now: { type: GraphQLFloat, resolve: () => now() } },
		}),
		subscription: new GraphQLObjectType({
			name: "Subscription",
			fields: {
				feed: {
					type: new GraphQLNonNull(BenchEventType),
					args: { topic: { type: new GraphQLNonNull(GraphQLInt) } },
					subscribe: (
						_root: unknown,
						args: { topic: number },
						context: { socket?: WebSocket },
					) => {
						const conn = context.socket && byWs.get(context.socket);
						if (!conn) throw new Error("unknown connection");
						return feed(args.topic, conn);
					},
					resolve: (event: unknown) => event,
				},
			},
		}),
	});

	const graphql = new WebSocketServer({ noServer: true });
	// Registered before serveGraphqlWs so outbound counting is in place first.
	graphql.on("connection", (ws: WebSocket, request: IncomingMessage) => {
		track("graphql-ws", ws, request);
	});
	const graphqlServer = serveGraphqlWs(
		{
			schema,
			onConnect: (ctx) => {
				const token = ctx.connectionParams?.token;
				if (typeof token === "string") {
					totals.authTokens.push(token);
					if (totals.authTokens.length > 20) totals.authTokens.shift();
				}
			},
			context: (ctx) => ({ socket: ctx.extra.socket }),
		},
		graphql,
		0,
	);

	app.upgrade("/bench/ws", (req, socket, head) => {
		native.handleUpgrade(req, socket, head, (ws) => {
			native.emit("connection", ws, req);
		});
	});
	app.upgrade("/bench/graphql-ws", (req, socket, head) => {
		graphql.handleUpgrade(req, socket, head, (ws) => {
			graphql.emit("connection", ws, req);
		});
	});

	const record = (req: IncomingMessage, upgrade: boolean) => {
		totals.requestCount += 1;
		const dest = req.headers["sec-fetch-dest"];
		requests.push({
			method: req.method ?? "GET",
			url: req.url ?? "",
			dest: typeof dest === "string" ? dest : null,
			upgrade,
			at: now(),
		});
		if (requests.length > MAX_REQUESTS) requests.shift();
	};
	app.server.on("request", (req: IncomingMessage) => record(req, false));
	app.server.on("upgrade", (req: IncomingMessage) => record(req, true));

	const snapshot = () => {
		const byEndpoint: Record<Endpoint, Record<string, number>> = {
			"graphql-ws": {},
			ws: {},
		};
		for (const endpoint of ["graphql-ws", "ws"] as const) {
			let activeConnections = 0;
			for (const conn of conns)
				if (conn.endpoint === endpoint) activeConnections += 1;
			let activeSubscriptions = 0;
			let activeTopics = 0;
			for (const set of subscribers.values()) {
				let here = 0;
				for (const subscriber of set)
					if (subscriber.conn.endpoint === endpoint) here += 1;
				activeSubscriptions += here;
				if (here > 0) activeTopics += 1;
			}
			byEndpoint[endpoint] = {
				connections: totals.endpoints[endpoint].connections,
				activeConnections,
				subscriptions: totals.endpoints[endpoint].subscriptions,
				activeSubscriptions,
				activeTopics,
			};
		}
		const sum = (key: string) =>
			(byEndpoint["graphql-ws"][key] ?? 0) + (byEndpoint.ws[key] ?? 0);
		return {
			connections: sum("connections"),
			activeConnections: sum("activeConnections"),
			subscriptions: sum("subscriptions"),
			activeSubscriptions: sum("activeSubscriptions"),
			activeTopics: subscribers.size,
			byEndpoint,
			emitted: totals.emitted,
			wireMessages: totals.wireMessages,
			wireBytes: totals.wireBytes,
			droppedFrames: totals.droppedFrames,
			serverDrops: totals.serverDrops,
			maxLagMs: totals.maxLagMs,
			lateTicks: totals.lateTicks,
			stalls: totals.stalls,
			terminated: totals.terminated,
			commands: totals.commands,
			acksSent: totals.acksSent,
			heldAcks: held.length,
			auths: totals.auths,
			authTokens: [...totals.authTokens],
			requests: totals.requestCount,
			cpuUsage: process.cpuUsage(),
			schedulerRunning: timer !== undefined,
		};
	};
	Object.defineProperty(app.counters, "bench", {
		enumerable: true,
		configurable: true,
		get: snapshot,
	});

	app.http("*", "/__fixture/bench/", (req, res, url) => {
		const path = url.pathname.slice("/__fixture/bench/".length);
		if (path === "clock") {
			return sendJson(res, 200, { now: now() });
		}
		sync();
		if (path === "state" && req.method === "GET") {
			const topics: Record<number, number> = {};
			for (const [topic, seq] of seqs) topics[topic] = seq;
			return sendJson(res, 200, { counters: snapshot(), seqs: topics });
		}
		if (path === "requests" && req.method === "GET") {
			return sendJson(res, 200, { requests });
		}
		sendJson(res, 404, { error: "not-found", path: url.pathname });
	});

	app.onReset(() => {
		totals = zero();
		requests = [];
		for (const handle of ackTimers) clearTimeout(handle);
		ackTimers.clear();
		held = [];
		seenStall = undefined;
		seenTerminate = undefined;
		seenRelease = undefined;
		// Keep seqs while anyone is subscribed so per-topic continuity holds.
		if (subscriberCount() === 0) seqs.clear();
	});

	app.onClose(async () => {
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
		for (const handle of ackTimers) clearTimeout(handle);
		ackTimers.clear();
		held = [];
		// Terminate first: with noServer and client tracking, ws 8.22.0 calls
		// back from close() only once every client is gone, and a graceful
		// close can wait 30 s on a half-open peer.
		for (const client of native.clients) client.terminate();
		for (const client of graphql.clients) client.terminate();
		await graphqlServer.dispose();
		await new Promise<void>((resolve) => native.close(() => resolve()));
	});
}
