import type { IncomingMessage } from "node:http";
import {
	GraphQLBoolean,
	GraphQLInt,
	GraphQLNonNull,
	GraphQLObjectType,
	GraphQLSchema,
	GraphQLString,
} from "graphql";
import { useServer as serveGraphqlWs } from "graphql-ws/use/ws";
import { WebSocket, WebSocketServer } from "ws";
import { type FixtureApp, sendJson, sleep } from "./app.ts";

/**
 * Real graphql-ws 6.3.0 server (`graphql-ws/use/ws`) on `WS /graphql-ws`.
 *
 * Isolation: every connection belongs to the `?tag=` in its URL (tests use a
 * unique tag). Counters live under `app.counters["graphql-ws"].tags[tag]`;
 * faults apply to one tag with `target: "graphql-ws@<tag>"` or to all with
 * `target: "graphql-ws"`:
 *
 * - `suppress-pong`: protocol pings are counted but never answered
 * - `suppress-pong-once`: the next ping is counted and its pong held until
 * that socket closes; that ping consumes the fault, so every later ping is
 * answered
 * - `delay-pong-once` (value: delay in ms, default 4000): the next ping's pong
 * is sent only after the delay (a slow but healthy server); that ping
 * consumes the fault. Each pong sent late adds to `delayedPongs` and its
 * measured delay to `pongDelays`; a delay cut short by the socket closing
 * sends nothing and adds to `delayedPongsCancelled`. Reset settles any
 * pending delay, so no timer outlives a close or a reset
 * - `reject-auth` (value: close code, default 4401): refuse ConnectionInit
 * - `close-code` (value: close code): close every attempt at ConnectionInit
 * - `withhold-ack`: never acknowledge ConnectionInit
 *
 * Auth: `connectionParams.token` must pass `app.authorise` unless the URL has
 * `anonymous=1`; a failure closes with 4401. `POST /graphql-ws/control/terminate?tag=`
 * hard-terminates that tag's sockets (a dropped TCP connection).
 */

export interface GraphqlWsTagCounters {
	connections: number;
	active: number;
	inits: number;
	subscriptions: number;
	activeSubscriptions: number;
	completes: number;
	pings: number;
	pongs: number;
	/** Pongs sent late under `delay-pong-once` (also counted in `pongs`). */
	delayedPongs: number;
	/** Fixture-measured ms from ping receipt to each delayed pong (last 50). */
	pongDelays: number[];
	/** `delay-pong-once` delays ended by the socket closing (no pong sent). */
	delayedPongsCancelled: number;
	authFailures: number;
	closeCodes: number[];
	tokens: string[];
	payloads: Array<{
		query: string;
		operationName?: string | null;
		variables?: unknown;
		extensions?: unknown;
	}>;
}

function emptyCounters(): GraphqlWsTagCounters {
	return {
		connections: 0,
		active: 0,
		inits: 0,
		subscriptions: 0,
		activeSubscriptions: 0,
		completes: 0,
		pings: 0,
		pongs: 0,
		delayedPongs: 0,
		pongDelays: [],
		delayedPongsCancelled: 0,
		authFailures: 0,
		closeCodes: [],
		tokens: [],
		payloads: [],
	};
}

const Tick = new GraphQLObjectType({
	name: "Tick",
	fields: {
		n: { type: new GraphQLNonNull(GraphQLInt) },
		tag: { type: GraphQLString },
		label: { type: GraphQLString },
		flaky: {
			type: GraphQLString,
			resolve: (tick: { n: number; partial?: boolean }) => {
				if (tick.partial && tick.n % 2 === 0) {
					throw new Error(`flaky field failed for tick ${tick.n}`);
				}
				return `ok-${tick.n}`;
			},
		},
	},
});

interface TickArgs {
	intervalMs?: number | null;
	count?: number | null;
	errorAfter?: number | null;
	partial?: boolean | null;
	label?: string | null;
}

/** Shared by the graphql-ws and graphql-sse fixtures. */
export const fixtureSchema = new GraphQLSchema({
	query: new GraphQLObjectType({
		name: "Query",
		fields: { hello: { type: GraphQLString, resolve: () => "world" } },
	}),
	mutation: new GraphQLObjectType({
		name: "Mutation",
		fields: { bump: { type: GraphQLInt, resolve: () => 1 } },
	}),
	subscription: new GraphQLObjectType({
		name: "Subscription",
		fields: {
			ticks: {
				type: new GraphQLNonNull(Tick),
				args: {
					intervalMs: { type: GraphQLInt },
					count: { type: GraphQLInt },
					errorAfter: { type: GraphQLInt },
					partial: { type: GraphQLBoolean },
					label: { type: GraphQLString },
				},
				subscribe: (
					_root: unknown,
					args: TickArgs,
					context: { tag?: string } | undefined,
				) => ticks(args, context?.tag),
				resolve: (event: unknown) => event,
			},
		},
	}),
});

async function* ticks(args: TickArgs, tag: string | undefined) {
	const interval = Math.max(5, args.intervalMs ?? 50);
	for (let n = 1; args.count == null || n <= args.count; n += 1) {
		await sleep(interval);
		if (args.errorAfter != null && n > args.errorAfter) {
			throw new Error(`ticks failed after ${args.errorAfter} events`);
		}
		yield {
			n,
			tag: tag ?? null,
			label: args.label ?? null,
			partial: args.partial ?? false,
		};
	}
}

export function tagOf(url: string | undefined): string {
	const parsed = new URL(url ?? "/", "http://fixture.invalid");
	return parsed.searchParams.get("tag") ?? "default";
}

export function register(app: FixtureApp): void {
	const totals = {
		connections: 0,
		active: 0,
		subscriptions: 0,
		activeSubscriptions: 0,
		pings: 0,
		pongs: 0,
		authFailures: 0,
		tags: {} as Record<string, GraphqlWsTagCounters>,
	};
	app.counters["graphql-ws"] = totals;
	// Settle functions for pending `delay-pong-once` delays (see delayPong).
	const pendingDelays = new Set<() => void>();
	app.onReset(() => {
		for (const settle of [...pendingDelays]) settle();
		Object.assign(totals, {
			connections: 0,
			active: 0,
			subscriptions: 0,
			activeSubscriptions: 0,
			pings: 0,
			pongs: 0,
			authFailures: 0,
			tags: {},
		});
	});
	const countersFor = (tag: string) => {
		totals.tags[tag] ??= emptyCounters();
		return totals.tags[tag];
	};
	const fault = (tag: string, action: string) =>
		app.fault(`graphql-ws@${tag}`, action) ?? app.fault("graphql-ws", action);
	const sockets = new Map<string, Set<WebSocket>>();

	/**
	 * Waits until `ms` have passed since `receivedAt` on the fixture's clock.
	 * Settles exactly once — "elapsed", "closed" (the socket closed first;
	 * shutdown terminates every socket) or "reset" — and always removes its
	 * timer, close listener and pending entry.
	 */
	const delayPong = (socket: WebSocket, ms: number, receivedAt: number) =>
		new Promise<"elapsed" | "closed" | "reset">((resolve) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const settle = (outcome: "elapsed" | "closed" | "reset") => {
				clearTimeout(timer);
				socket.off("close", onClose);
				pendingDelays.delete(onReset);
				resolve(outcome);
			};
			const onClose = () => settle("closed");
			const onReset = () => settle("reset");
			// A Node timer can fire a millisecond early against performance.now(),
			// so wait out any remainder: the recorded delay is never short.
			const check = () => {
				const remaining = ms - (performance.now() - receivedAt);
				if (remaining > 0) timer = setTimeout(check, Math.ceil(remaining));
				else settle("elapsed");
			};
			if (socket.readyState !== WebSocket.OPEN) return settle("closed");
			socket.once("close", onClose);
			pendingDelays.add(onReset);
			check();
		});

	const wss = new WebSocketServer({ noServer: true });
	wss.on("connection", (socket: WebSocket, request: IncomingMessage) => {
		const tag = tagOf(request.url);
		const counters = countersFor(tag);
		counters.connections += 1;
		counters.active += 1;
		totals.connections += 1;
		totals.active += 1;
		let set = sockets.get(tag);
		if (!set) {
			set = new Set();
			sockets.set(tag, set);
		}
		set.add(socket);
		socket.once("close", (code) => {
			counters.active -= 1;
			totals.active -= 1;
			counters.closeCodes.push(code);
			set.delete(socket);
		});
	});

	serveGraphqlWs(
		{
			schema: fixtureSchema,
			context: (ctx) => ({ tag: tagOf(ctx.extra.request.url) }),
			onConnect: async (ctx) => {
				const url = ctx.extra.request.url;
				const tag = tagOf(url);
				const counters = countersFor(tag);
				counters.inits += 1;
				const socket = ctx.extra.socket;
				const token = ctx.connectionParams?.token;
				if (typeof token === "string") counters.tokens.push(token);
				const closeCode = fault(tag, "close-code");
				if (closeCode) {
					socket.close(Number(closeCode.value ?? 4000), "Fixture close");
					return false;
				}
				if (fault(tag, "withhold-ack")) {
					// Never acknowledge; the socket closes on the client's timeout.
					await new Promise<void>((resolve) => socket.once("close", resolve));
					return false;
				}
				const rejected = fault(tag, "reject-auth");
				const anonymous =
					new URL(url ?? "/", "http://fixture.invalid").searchParams.get(
						"anonymous",
					) === "1";
				const authorised =
					!rejected &&
					(anonymous ||
						(typeof token === "string" && app.authorise(`Bearer ${token}`).ok));
				if (!authorised) {
					counters.authFailures += 1;
					totals.authFailures += 1;
					socket.close(Number(rejected?.value ?? 4401), "Unauthorized");
					return false;
				}
				return true;
			},
			onPing: async (ctx) => {
				const receivedAt = performance.now();
				const tag = tagOf(ctx.extra.request.url);
				const counters = countersFor(tag);
				counters.pings += 1;
				totals.pings += 1;
				// Consumed synchronously, before any await, so only this ping goes
				// unanswered however late the test observes the recovery.
				const once =
					app.takeFault(`graphql-ws@${tag}`, "suppress-pong-once") ??
					app.takeFault("graphql-ws", "suppress-pong-once");
				if (once || fault(tag, "suppress-pong")) {
					// Hold the pong until the socket closes (a half-open peer).
					const socket = ctx.extra.socket;
					await new Promise<void>((resolve) => socket.once("close", resolve));
					return;
				}
				// Also consumed synchronously: only this ping's pong is late.
				const delayed =
					app.takeFault(`graphql-ws@${tag}`, "delay-pong-once") ??
					app.takeFault("graphql-ws", "delay-pong-once");
				if (delayed) {
					const ms =
						typeof delayed.value === "number" && delayed.value >= 0
							? delayed.value
							: 4_000;
					// graphql-ws sends the pong only after onPing resolves.
					const outcome = await delayPong(ctx.extra.socket, ms, receivedAt);
					if (outcome === "closed") {
						// Nothing is sent: upstream's send is a no-op once closed.
						counters.delayedPongsCancelled += 1;
						return;
					}
					// A reset replaced these counters; the pong is still owed.
					if (outcome === "reset") return;
					counters.delayedPongs += 1;
					counters.pongDelays.push(performance.now() - receivedAt);
					if (counters.pongDelays.length > 50) counters.pongDelays.shift();
				}
				counters.pongs += 1;
				totals.pongs += 1;
			},
			onSubscribe: (ctx, _id, payload) => {
				const counters = countersFor(tagOf(ctx.extra.request.url));
				counters.payloads.push({
					query: payload.query,
					operationName: payload.operationName,
					variables: payload.variables,
					extensions: payload.extensions,
				});
				if (counters.payloads.length > 50) counters.payloads.shift();
			},
			onOperation: (ctx) => {
				const counters = countersFor(tagOf(ctx.extra.request.url));
				counters.subscriptions += 1;
				counters.activeSubscriptions += 1;
				totals.subscriptions += 1;
				totals.activeSubscriptions += 1;
			},
			onComplete: (ctx) => {
				const counters = countersFor(tagOf(ctx.extra.request.url));
				counters.completes += 1;
				counters.activeSubscriptions -= 1;
				totals.activeSubscriptions -= 1;
			},
		},
		wss,
	);

	// Deterministic shutdown: terminate live sockets (which also settles held
	// pongs and withheld acks), then close the server.
	app.onClose(() => {
		for (const client of wss.clients) client.terminate();
		return new Promise<void>((resolve) => wss.close(() => resolve()));
	});

	app.upgrade("/graphql-ws", (req, socket, head) => {
		wss.handleUpgrade(req, socket, head, (ws) => {
			wss.emit("connection", ws, req);
		});
	});

	app.http("POST", "/graphql-ws/control/terminate", (_req, res, url) => {
		const tag = url.searchParams.get("tag") ?? "default";
		const set = sockets.get(tag);
		let terminated = 0;
		for (const socket of set ?? []) {
			if (socket.readyState === WebSocket.OPEN) {
				socket.terminate();
				terminated += 1;
			}
		}
		sendJson(res, 200, { terminated });
	});
}
