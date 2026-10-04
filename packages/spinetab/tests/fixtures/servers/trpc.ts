import type { IncomingMessage } from "node:http";
import { initTRPC, TRPCError, tracked } from "@trpc/server";
import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import { applyWSSHandler } from "@trpc/server/adapters/ws";
import superjson from "superjson";
import { type WebSocket, WebSocketServer } from "ws";
import { type FixtureApp, sendJson, sleep } from "./app.ts";

/**
 * Real tRPC 11.19.0 router with the superjson transformer:
 *
 * - `WS /trpc-ws?tag=` (`applyWSSHandler`, connection params required: `{ token }`)
 * - `GET /trpc/<procedure>` (`createHTTPHandler`; SSE subscriptions, `Authorization` header)
 *
 * Procedures: `ticks` (tracked subscription, input `{ tag, intervalMs?, count?,
 * lastEventId? }`, events `{ n, at: Date, tags: Map }` resumed after
 * `lastEventId`), `echo` mutation. Auth: `valid-<scope>-<n>` via `app.authorise`
 * unless the tag starts with `anon`; WS context failures send tRPC's `id: null`
 * UNAUTHORIZED error and close. Counters per tag under `app.counters.trpc.tags`
 * (`lastEventIds[]` records the cursor each subscription started from).
 * Control: `POST /trpc-control/terminate?tag=` terminates that tag's sockets.
 */

export interface TrpcTagCounters {
	wsConnections: number;
	sseRequests: number;
	subscriptions: number;
	active: number;
	lastEventIds: Array<string | null>;
	tokens: string[];
	urls: string[];
	contextFailures: number;
}

function emptyCounters(): TrpcTagCounters {
	return {
		wsConnections: 0,
		sseRequests: 0,
		subscriptions: 0,
		active: 0,
		lastEventIds: [],
		tokens: [],
		urls: [],
		contextFailures: 0,
	};
}

interface Context {
	tag: string;
}

interface TickInput {
	tag: string;
	intervalMs?: number;
	count?: number;
	lastEventId?: string | null;
}

/** The fixture router; exported so tests get a real `AppRouter` type. */
export function createFixtureRouter(
	countersFor: (tag: string) => TrpcTagCounters,
) {
	const t = initTRPC.context<Context>().create({
		transformer: superjson,
		sse: { ping: { enabled: true, intervalMs: 500 } },
	});
	return t.router({
		ticks: t.procedure
			.input((raw: unknown) => {
				const input = raw as TickInput;
				if (typeof input?.tag !== "string") throw new Error("tag is required");
				return input;
			})
			.subscription(async function* ({ input, signal }) {
				const counters = countersFor(input.tag);
				counters.subscriptions += 1;
				counters.active += 1;
				counters.lastEventIds.push(input.lastEventId ?? null);
				try {
					const start = input.lastEventId ? Number(input.lastEventId) + 1 : 1;
					const end = input.count
						? start + input.count - 1
						: Number.POSITIVE_INFINITY;
					for (let n = start; n <= end; n += 1) {
						await sleep(input.intervalMs ?? 30);
						if (signal?.aborted) return;
						yield tracked(String(n), {
							n,
							at: new Date(Date.UTC(2026, 0, 1, 0, 0, n)),
							tags: new Map([[input.tag, n]]),
						});
					}
				} finally {
					counters.active -= 1;
				}
			}),
		echo: t.procedure
			.input((raw: unknown) => raw)
			.mutation(({ input }) => input),
	});
}

export type FixtureTrpcRouter = ReturnType<typeof createFixtureRouter>;

export function register(app: FixtureApp): void {
	const totals = { tags: {} as Record<string, TrpcTagCounters> };
	app.counters.trpc = totals;
	app.onReset(() => {
		totals.tags = {};
	});
	const countersFor = (tag: string) => {
		totals.tags[tag] ??= emptyCounters();
		return totals.tags[tag];
	};

	const router = createFixtureRouter(countersFor);

	const authorise = (tag: string, token: unknown) => {
		if (tag.startsWith("anon")) return true;
		if (typeof token === "string") countersFor(tag).tokens.push(token);
		return typeof token === "string" && app.authorise(`Bearer ${token}`).ok;
	};
	const tagOf = (req: IncomingMessage) =>
		new URL(req.url ?? "/", "http://fixture.invalid").searchParams.get("tag") ??
		"default";

	const wss = new WebSocketServer({ noServer: true });
	const sockets = new Map<string, Set<WebSocket>>();
	wss.on("connection", (socket: WebSocket, req: IncomingMessage) => {
		const tag = tagOf(req);
		countersFor(tag).wsConnections += 1;
		let set = sockets.get(tag);
		if (!set) {
			set = new Set();
			sockets.set(tag, set);
		}
		set.add(socket);
		socket.once("close", () => set.delete(socket));
	});
	applyWSSHandler({
		wss,
		router,
		createContext: ({ req, info }) => {
			const tag = tagOf(req);
			if (!authorise(tag, info.connectionParams?.token)) {
				countersFor(tag).contextFailures += 1;
				throw new TRPCError({ code: "UNAUTHORIZED", message: "invalid token" });
			}
			return { tag };
		},
	});
	// Deterministic shutdown: terminate live sockets (ending their
	// subscriptions), then close the server. HTTP SSE streams end with their
	// sockets, which the launcher destroys.
	app.onClose(() => {
		for (const client of wss.clients) client.terminate();
		return new Promise<void>((resolve) => wss.close(() => resolve()));
	});
	app.upgrade("/trpc-ws", (req, socket, head) => {
		wss.handleUpgrade(req, socket, head, (ws) =>
			wss.emit("connection", ws, req),
		);
	});

	const http = createHTTPHandler({
		router,
		basePath: "/trpc/",
		createContext: ({ req }) => {
			const url = new URL(req.url ?? "/", "http://fixture.invalid");
			const input = url.searchParams.get("input");
			let tag = "default";
			try {
				const parsed = input
					? superjson.parse<{ tag?: string }>(input)
					: undefined;
				tag = parsed?.tag ?? "default";
			} catch {
				// Leave the default tag for unparsable inputs.
			}
			const counters = countersFor(tag);
			counters.sseRequests += 1;
			counters.urls.push(url.pathname + url.search);
			const header = req.headers.authorization;
			const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
			if (!authorise(tag, token)) {
				counters.contextFailures += 1;
				throw new TRPCError({ code: "UNAUTHORIZED", message: "invalid token" });
			}
			return { tag };
		},
	});
	app.http("*", "/trpc/", (req, res) => http(req, res));

	app.http("POST", "/trpc-control/terminate", (_req, res, url) => {
		const tag = url.searchParams.get("tag") ?? "default";
		let terminated = 0;
		for (const socket of sockets.get(tag) ?? []) {
			socket.terminate();
			terminated += 1;
		}
		sendJson(res, 200, { terminated });
	});
}
