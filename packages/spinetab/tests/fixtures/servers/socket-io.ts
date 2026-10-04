import { type Namespace, Server, type Socket } from "socket.io";
import { type FixtureApp, sendJson } from "./app.ts";

/**
 * Real socket.io 4.8.4 servers on the fixture HTTP server:
 *
 * - `/socket.io`: connection-state recovery on (2 min, middleware skipped on
 * recovery, the upstream default)
 * - `/socket.io-nocsr`: recovery off, so every reconnect is a new session
 *
 * Namespaces `/` and `/ops`. Isolation by the handshake query `tag`.
 * Handshake query `ticks=<ms>` emits `tick` `{ n, tag }` to that socket.
 * Events: `join`/`leave` `(room, ack)` (rooms emit `room` `{ room, n }` every
 * 25 ms), `echo` `(...args, ack)` acknowledges its first argument, `reject`
 * acknowledges error-first, `count` is fire-and-forget, `please-ask` makes the
 * server emit `ask` with an acknowledgement.
 *
 * Auth middleware: `auth.token` must pass `app.authorise` unless the query has
 * `anonymous=1`; rejection is `connect_error` "unauthorized" with
 * `data.status` 401. Faults (`target: "socket-io@<tag>"` or `"socket-io"`):
 * `reject-auth`, `drop-ack` (echo/join are not acknowledged),
 * `drop-leave-ack` (a leave is applied but not acknowledged). Controls:
 * `POST /socket-io-control/{disconnect|close-transport}?tag=`. Probe:
 * `GET /socket-io-control/rooms?tag=` lists the rooms the tag's connected
 * sockets are in (their own id room left out), as the server sees them.
 */

export interface SocketIoTagCounters {
	connections: number;
	active: number;
	recovered: number;
	byNamespace: Record<string, number>;
	byTransport: Record<string, number>;
	upgrades: number;
	authFailures: number;
	joins: Record<string, number>;
	leaves: Record<string, number>;
	commands: Record<string, number>;
	acks: number;
	answers: unknown[];
	tokens: string[];
}

function emptyCounters(): SocketIoTagCounters {
	return {
		connections: 0,
		active: 0,
		recovered: 0,
		byNamespace: {},
		byTransport: {},
		upgrades: 0,
		authFailures: 0,
		joins: {},
		leaves: {},
		commands: {},
		acks: 0,
		answers: [],
		tokens: [],
	};
}

const bump = (record: Record<string, number>, key: string) => {
	record[key] = (record[key] ?? 0) + 1;
};

export function register(app: FixtureApp): void {
	const totals = { tags: {} as Record<string, SocketIoTagCounters> };
	app.counters["socket-io"] = totals;
	app.onReset(() => {
		totals.tags = {};
	});
	const countersFor = (tag: string) => {
		totals.tags[tag] ??= emptyCounters();
		return totals.tags[tag];
	};
	const fault = (tag: string, action: string) =>
		app.fault(`socket-io@${tag}`, action) ?? app.fault("socket-io", action);
	const sockets = new Map<string, Set<Socket>>();
	const tickers = new Map<string, ReturnType<typeof setInterval>>();

	const servers = [
		new Server(app.server, {
			path: "/socket.io",
			destroyUpgrade: false,
			connectionStateRecovery: { maxDisconnectionDuration: 120_000 },
		}),
		new Server(app.server, { path: "/socket.io-nocsr", destroyUpgrade: false }),
	];
	// Deterministic shutdown. `io.close()` is not used: it also closes the shared
	// HTTP server and waits for it, which only completes after the launcher
	// destroys sockets. Room tickers stop, every namespace disconnects its
	// sockets (clearing per-socket tickers) and closes its adapter (session
	// recovery state), then each engine closes its clients.
	const namespaces = servers.flatMap((io) => [io.of("/"), io.of("/ops")]);
	app.onClose(async () => {
		for (const timer of tickers.values()) clearInterval(timer);
		tickers.clear();
		await Promise.allSettled(
			namespaces.map(async (nsp) => {
				nsp.disconnectSockets(true);
				await nsp.adapter.close();
			}),
		);
		for (const io of servers) io.engine.close();
	});

	const tagOf = (socket: Socket) =>
		String(socket.handshake.query.tag ?? "default");

	const roomTicker = (nsp: Namespace, path: string, room: string) => {
		const key = `${path}|${nsp.name}|${room}`;
		if (tickers.has(key)) return;
		let n = 0;
		tickers.set(
			key,
			setInterval(() => {
				n += 1;
				nsp.to(room).emit("room", { room, n });
			}, 25),
		);
	};

	for (const [index, io] of servers.entries()) {
		const path = index === 0 ? "/socket.io" : "/socket.io-nocsr";
		for (const nsp of [io.of("/"), io.of("/ops")]) {
			nsp.use((socket, next) => {
				const tag = tagOf(socket);
				const counters = countersFor(tag);
				const token = socket.handshake.auth?.token;
				if (typeof token === "string") counters.tokens.push(token);
				const anonymous = socket.handshake.query.anonymous === "1";
				const ok =
					!fault(tag, "reject-auth") &&
					(anonymous ||
						(typeof token === "string" && app.authorise(`Bearer ${token}`).ok));
				if (ok) return next();
				counters.authFailures += 1;
				next(
					Object.assign(new Error("unauthorized"), { data: { status: 401 } }),
				);
			});
			nsp.on("connection", (socket) => {
				const tag = tagOf(socket);
				const counters = countersFor(tag);
				counters.connections += 1;
				counters.active += 1;
				if (socket.recovered) counters.recovered += 1;
				bump(counters.byNamespace, nsp.name);
				bump(counters.byTransport, socket.conn.transport.name);
				socket.conn.once("upgrade", () => {
					counters.upgrades += 1;
				});
				let set = sockets.get(tag);
				if (!set) {
					set = new Set();
					sockets.set(tag, set);
				}
				set.add(socket);
				const interval = Number(socket.handshake.query.ticks ?? 0);
				let ticker: ReturnType<typeof setInterval> | undefined;
				if (interval > 0) {
					let n = 0;
					ticker = setInterval(() => {
						n += 1;
						socket.emit("tick", { n, tag });
					}, interval);
				}
				socket.on("disconnect", () => {
					counters.active -= 1;
					set.delete(socket);
					if (ticker) clearInterval(ticker);
				});
				socket.on("join", (room: string, ack?: (value: unknown) => void) => {
					bump(counters.joins, room);
					socket.join(room);
					roomTicker(nsp, path, room);
					if (!fault(tag, "drop-ack")) ack?.({ ok: true });
				});
				socket.on("leave", (room: string, ack?: (value: unknown) => void) => {
					bump(counters.leaves, room);
					socket.leave(room);
					if (!fault(tag, "drop-leave-ack")) ack?.({ ok: true });
				});
				socket.on("echo", (...args: unknown[]) => {
					bump(counters.commands, "echo");
					const ack = args.at(-1);
					if (typeof ack !== "function") return;
					if (fault(tag, "drop-ack")) return;
					counters.acks += 1;
					(ack as (value: unknown) => void)(args[0]);
				});
				socket.on("reject", (...args: unknown[]) => {
					bump(counters.commands, "reject");
					const ack = args.at(-1);
					if (typeof ack === "function") {
						counters.acks += 1;
						(ack as (error: unknown, value: unknown) => void)(
							{ reason: "not allowed" },
							null,
						);
					}
				});
				socket.on("count", () => {
					bump(counters.commands, "count");
				});
				socket.on("please-ask", () => {
					bump(counters.commands, "please-ask");
					socket
						.timeout(2_000)
						.emit(
							"ask",
							{ question: 42 },
							(error: Error | null, answer: unknown) => {
								counters.answers.push(error ? "timeout" : answer);
							},
						);
				});
			});
		}
	}

	app.http("POST", "/socket-io-control/", (_req, res, url) => {
		const action = url.pathname.split("/").at(-1);
		const tag = url.searchParams.get("tag") ?? "default";
		let affected = 0;
		for (const socket of [...(sockets.get(tag) ?? [])]) {
			affected += 1;
			// `disconnect`: the server ends the session ("io server disconnect").
			// `close-transport`: the transport drops; recovery may apply.
			if (action === "disconnect") socket.disconnect();
			else socket.conn.close();
		}
		sendJson(res, 200, { affected });
	});

	// Read-only: which rooms the server still sends to for this tag.
	app.http("GET", "/socket-io-control/rooms", (_req, res, url) => {
		const tag = url.searchParams.get("tag") ?? "default";
		const rooms = new Set<string>();
		for (const socket of sockets.get(tag) ?? []) {
			for (const room of socket.rooms) if (room !== socket.id) rooms.add(room);
		}
		sendJson(res, 200, { rooms: [...rooms].sort() });
	});
}
