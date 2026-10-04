import type { IncomingMessage } from "node:http";
import { type WebSocket, WebSocketServer } from "ws";
import { type FixtureApp, readJson, sendJson } from "./app.ts";

/**
 * `WS /ws/topics` topic protocol fixture.
 *
 * JSON text frames: client → server `subscribe | unsubscribe | cmd | ping |
 * auth`; server → client `event | subscribed | subscribe-rejected | ack |
 * pong`. The `binary` topic emits binary frames: one byte topic length, the
 * UTF-8 topic, then `[seq & 255, 1, 2, 3]`.
 *
 * Query: `run` (counter/control namespace so parallel tests never share
 * state), `scope`, `rate` (tick interval ms, default 50), `guard=1` (first
 * message must be `{type:"auth",token}` checked with `app.authorise`),
 * `reject=401` (refuse the upgrade).
 *
 * Controls: `POST /ws/control {run, action, value}` acts immediately on that
 * run; global faults (`target: "ws"`, optional `value.run`) serve the browser
 * suite. Actions: terminate, close-code, reject-upgrade, stall,
 * drop-next-ack, close-before-ack, reject-subscribe, emit-oversized,
 * emit-undecodable, burst.
 */
interface RunCounters {
	upgrades: number;
	opens: number;
	active: number;
	byScope: Record<string, number>;
	subscribes: Record<string, number>;
	unsubscribes: Record<string, number>;
	activeTopics: Record<string, number>;
	commands: Record<string, number>;
	acks: number;
	authMessages: number;
	pings: number;
	closeCodes: number[];
	/** Wire order of subscribe/unsubscribe frames: `<socket>:<type>:<topic>`. */
	log: string[];
	/** Query strings seen on upgrade (tests assert no credentials appear). */
	urls: string[];
}

interface RunState {
	counters: RunCounters;
	sockets: Set<Connection>;
	stalled: boolean;
	dropNextAck: boolean;
	closeBeforeAck: boolean;
	rejectTopics: Set<string>;
	nextSocket: number;
}

interface Connection {
	id: number;
	ws: WebSocket;
	tickers: Map<string, { seq: number; timer: ReturnType<typeof setInterval> }>;
}

function freshCounters(): RunCounters {
	return {
		upgrades: 0,
		opens: 0,
		active: 0,
		byScope: {},
		subscribes: {},
		unsubscribes: {},
		activeTopics: {},
		commands: {},
		acks: 0,
		authMessages: 0,
		pings: 0,
		closeCodes: [],
		log: [],
		urls: [],
	};
}

const bump = (record: Record<string, number>, key: string, by = 1) => {
	record[key] = (record[key] ?? 0) + by;
};

export function register(app: FixtureApp): void {
	const wss = new WebSocketServer({
		noServer: true,
		maxPayload: 4 * 1024 * 1024,
	});
	const runs = new Map<string, RunState>();
	let totals = freshCounters();
	// Snapshot of global totals plus `runs[<run>]` for GET /__fixture/counters,
	// refreshed after every change.
	const publish = () => {
		app.counters.ws = {
			...(totals as unknown as Record<string, unknown>),
			runs: Object.fromEntries(
				[...runs].map(([run, state]) => [run, state.counters]),
			),
		};
	};
	publish();

	const runState = (run: string): RunState => {
		let state = runs.get(run);
		if (!state) {
			state = {
				counters: freshCounters(),
				sockets: new Set(),
				stalled: false,
				dropNextAck: false,
				closeBeforeAck: false,
				rejectTopics: new Set(),
				nextSocket: 0,
			};
			runs.set(run, state);
			publish();
		}
		return state;
	};

	/** Apply to the run's counters and the global totals. */
	const count = (state: RunState, apply: (counters: RunCounters) => void) => {
		apply(state.counters);
		apply(totals);
		publish();
	};

	const globalFault = (action: string, run: string) => {
		const fault = app.fault("ws", action);
		if (!fault) return undefined;
		const target = (fault.value as { run?: string } | undefined)?.run;
		return target === undefined || target === run ? fault : undefined;
	};

	const send = (connection: Connection, message: unknown) => {
		if (connection.ws.readyState === connection.ws.OPEN) {
			connection.ws.send(JSON.stringify(message));
		}
	};

	const emit = (connection: Connection, topic: string, seq: number) => {
		if (connection.ws.readyState !== connection.ws.OPEN) return;
		if (topic === "binary") {
			const name = Buffer.from(topic, "utf8");
			const frame = Buffer.concat([
				Buffer.from([name.length]),
				name,
				Buffer.from([seq & 255, 1, 2, 3]),
			]);
			connection.ws.send(frame, { binary: true });
			return;
		}
		send(connection, {
			type: "event",
			topic,
			data: { topic, seq, text: "héllo 🌍" },
		});
	};

	const stopTicker = (
		connection: Connection,
		state: RunState,
		topic: string,
	) => {
		const ticker = connection.tickers.get(topic);
		if (!ticker) return;
		clearInterval(ticker.timer);
		connection.tickers.delete(topic);
		count(state, (counters) => bump(counters.activeTopics, topic, -1));
	};

	const act = (state: RunState, action: string, value: unknown) => {
		const options = (value ?? {}) as Record<string, unknown>;
		const sockets = [...state.sockets];
		switch (action) {
			case "terminate":
				for (const connection of sockets) connection.ws.terminate();
				break;
			case "close-code":
				for (const connection of sockets) {
					connection.ws.close(
						Number(options.code ?? value ?? 1011),
						String(options.reason ?? ""),
					);
				}
				break;
			case "stall":
				state.stalled = value !== false && options.on !== false;
				break;
			case "drop-next-ack":
				state.dropNextAck = true;
				break;
			case "close-before-ack":
				state.closeBeforeAck = true;
				break;
			case "reject-subscribe":
				state.rejectTopics.add(String(options.topic ?? value));
				break;
			case "emit-oversized": {
				const topic = String(options.topic ?? "a");
				const text = "x".repeat(Number(options.bytes ?? 300_000));
				for (const connection of sockets) {
					send(connection, { type: "event", topic, data: { text } });
				}
				break;
			}
			case "emit-undecodable":
				for (const connection of sockets) connection.ws.send("{not json");
				break;
			case "burst": {
				const topic = String(options.topic ?? "a");
				for (const connection of sockets) {
					for (
						let index = 0;
						index < Number(options.count ?? 100);
						index += 1
					) {
						const ticker = connection.tickers.get(topic);
						const seq = ticker ? ++ticker.seq : index + 1;
						emit(connection, topic, seq);
					}
				}
				break;
			}
			default:
				throw new Error(`unknown ws action ${action}`);
		}
	};

	// Global one-shot faults for the browser suite (each posted fault acts once).
	const handled = new WeakSet<object>();
	const oneShot = [
		"terminate",
		"close-code",
		"emit-oversized",
		"emit-undecodable",
		"burst",
	];
	const poller = setInterval(() => {
		for (const [run, state] of runs) {
			for (const action of oneShot) {
				const fault = globalFault(action, run);
				if (fault && !handled.has(fault) && state.sockets.size > 0) {
					handled.add(fault);
					act(state, action, fault.value);
				}
			}
		}
	}, 25);
	poller.unref();

	const onConnection = (ws: WebSocket, url: URL, state: RunState) => {
		const scope = url.searchParams.get("scope") ?? "";
		const rate = Number(url.searchParams.get("rate") ?? 50);
		let authed = url.searchParams.get("guard") !== "1";
		state.nextSocket += 1;
		const connection: Connection = {
			id: state.nextSocket,
			ws,
			tickers: new Map(),
		};
		state.sockets.add(connection);
		count(state, (counters) => {
			counters.opens += 1;
			counters.active += 1;
			bump(counters.byScope, scope);
		});
		ws.on("message", (data, isBinary) => {
			const run = url.searchParams.get("run") ?? "default";
			if (state.stalled || globalFault("stall", run)) return;
			if (isBinary) {
				// Binary echo keeps the frame kind.
				ws.send(data as Buffer, { binary: true });
				return;
			}
			let message: Record<string, unknown>;
			try {
				message = JSON.parse(String(data)) as Record<string, unknown>;
			} catch {
				ws.close(4400, "malformed");
				return;
			}
			if (!authed) {
				if (message.type !== "auth") {
					ws.close(4401, "unauthorised");
					return;
				}
				count(state, (counters) => {
					counters.authMessages += 1;
				});
				const verdict = app.authorise(`Bearer ${String(message.token ?? "")}`);
				if (!verdict.ok) {
					ws.close(4403, "forbidden");
					return;
				}
				authed = true;
				return;
			}
			const topic = String(message.topic ?? "");
			switch (message.type) {
				case "auth":
					count(state, (counters) => {
						counters.authMessages += 1;
					});
					return;
				case "subscribe": {
					count(state, (counters) => {
						bump(counters.subscribes, topic);
						counters.log.push(`${connection.id}:subscribe:${topic}`);
					});
					const rejected =
						state.rejectTopics.has(topic) ||
						(
							globalFault("reject-subscribe", run)?.value as
								| { topic?: string }
								| undefined
						)?.topic === topic;
					if (rejected) {
						send(connection, {
							type: "subscribe-rejected",
							topic,
							reason: "topic not allowed",
						});
						return;
					}
					if (connection.tickers.has(topic)) return;
					const ticker = {
						seq: 0,
						timer: setInterval(() => {
							if (state.stalled || globalFault("stall", run)) return;
							ticker.seq += 1;
							emit(connection, topic, ticker.seq);
						}, rate),
					};
					connection.tickers.set(topic, ticker);
					count(state, (counters) => bump(counters.activeTopics, topic));
					send(connection, { type: "subscribed", topic });
					return;
				}
				case "unsubscribe":
					count(state, (counters) => {
						bump(counters.unsubscribes, topic);
						counters.log.push(`${connection.id}:unsubscribe:${topic}`);
					});
					stopTicker(connection, state, topic);
					return;
				case "cmd": {
					const id = String(message.id ?? "");
					count(state, (counters) => bump(counters.commands, id));
					if (state.closeBeforeAck || globalFault("close-before-ack", run)) {
						state.closeBeforeAck = false;
						ws.terminate();
						return;
					}
					if (state.dropNextAck || globalFault("drop-next-ack", run)) {
						state.dropNextAck = false;
						return;
					}
					const payload = message.payload as
						| Record<string, unknown>
						| undefined;
					count(state, (counters) => {
						counters.acks += 1;
					});
					if (payload && typeof payload === "object" && payload.reject) {
						send(connection, { type: "ack", id, error: "rejected by fixture" });
					} else {
						send(connection, {
							type: "ack",
							id,
							result: { echo: payload ?? null },
						});
					}
					return;
				}
				case "ping":
					count(state, (counters) => {
						counters.pings += 1;
					});
					send(connection, { type: "pong" });
					return;
				default:
					return;
			}
		});
		ws.on("close", (code) => {
			state.sockets.delete(connection);
			for (const topic of [...connection.tickers.keys()])
				stopTicker(connection, state, topic);
			count(state, (counters) => {
				counters.active -= 1;
				counters.closeCodes.push(code);
			});
		});
	};

	app.upgrade("/ws/topics", (req: IncomingMessage, socket, head, url) => {
		const run = url.searchParams.get("run") ?? "default";
		const state = runState(run);
		count(state, (counters) => {
			counters.upgrades += 1;
			counters.urls.push(url.search);
		});
		if (
			url.searchParams.get("reject") === "401" ||
			globalFault("reject-upgrade", run)
		) {
			socket.end(
				"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
			);
			return;
		}
		wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, url, state));
	});

	app.http("POST", "/ws/control", async (req, res) => {
		const body = (await readJson(req)) as {
			run?: string;
			action?: string;
			value?: unknown;
		};
		const state = runState(String(body?.run ?? "default"));
		act(state, String(body?.action ?? ""), body?.value);
		sendJson(res, 200, state.counters);
	});

	app.http("GET", "/ws/counters", (_req, res, url) => {
		sendJson(
			res,
			200,
			runState(url.searchParams.get("run") ?? "default").counters,
		);
	});

	// Deterministic shutdown: stop the fault poller and every
	// topic ticker, terminate live sockets, then close the server.
	app.onClose(() => {
		clearInterval(poller);
		for (const state of runs.values()) {
			for (const connection of state.sockets) {
				for (const ticker of connection.tickers.values()) {
					clearInterval(ticker.timer);
				}
				connection.tickers.clear();
			}
		}
		for (const client of wss.clients) client.terminate();
		return new Promise<void>((resolve) => wss.close(() => resolve()));
	});

	app.onReset(() => {
		totals = freshCounters();
		// Runs are unique per test; keep live ones so a concurrent reset from
		// another suite cannot erase an in-flight test's counters.
		for (const [run, state] of runs)
			if (state.sockets.size === 0) runs.delete(run);
		publish();
	});
}
