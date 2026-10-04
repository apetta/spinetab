import type { IncomingMessage, ServerResponse } from "node:http";
import { type FixtureApp, sendJson, sleep } from "./app.ts";

/**
 * `GET|POST /sse/ticks` fixture.
 *
 * Emits `id: <n>` ticks as `event: tick` (every `alertEvery`-th also as
 * `event: alert`) with data `{"n":n,"text":"héllo 🌍"}`. A cursor from the
 * `Last-Event-ID` header or `?lastEventId=` resumes at cursor + 1 (replay);
 * a cursor older than `oldest` receives a `reset` event first.
 *
 * Query: `run` (counter namespace), `rate` (ms, default 20), `count` (end
 * cleanly after n events), `retry` (emit `retry:`), `alertEvery`, `guard=1`
 * (bearer checked with `app.authorise`), `fault`, `status`, `size`,
 * `failFirst`/`failStatus` (first n requests of the run fail with a status),
 * `failAt` (comma-separated request indices of the run that fail),
 * `resetAfter` (destroy the connection after n events, first request only
 * when `resetOnce=1`), `split=1` (one byte per write; combinable with faults).
 *
 * Faults (`?fault=` or global `target: "sse"` with optional `value.run`):
 * end, reset, status (204/401/500 via `status`), wrong-content-type, stall,
 * byte-split, oversized, id-variants.
 */
interface RequestRecord {
	method: string;
	lastEventId: string | null;
	lastEventIdQuery: string | null;
	hasAuth: boolean;
	scope: string | null;
}

interface RunCounters {
	streams: number;
	active: number;
	requests: RequestRecord[];
	events: number;
	disconnects: number;
	completed: number;
}

const fresh = (): RunCounters => ({
	streams: 0,
	active: 0,
	requests: [],
	events: 0,
	disconnects: 0,
	completed: 0,
});

/** Exercises BOM, comments, empty/NUL/id-only ids, CRLF and lone CR. */
const ID_VARIANTS = [
	"﻿: variants\n\n",
	"id: 1\ndata: a\n\n",
	"id:\ndata: b\n\n",
	"id: 2\n\n",
	"id: x\u0000y\ndata: c\n\n",
	"data: d\r\n\r\n",
	"event: alert\rdata: e\r\r",
];

export function register(app: FixtureApp): void {
	const runs = new Map<string, RunCounters>();
	const live = new Map<string, number>();
	// Open event streams, destroyed on shutdown so every loop ends.
	const open = new Set<ServerResponse>();
	app.onClose(() => {
		for (const res of open) res.destroy();
		open.clear();
	});
	let totals = fresh();
	const publish = () => {
		app.counters.sse = {
			...(totals as unknown as Record<string, unknown>),
			runs: Object.fromEntries(runs),
		};
	};
	publish();

	const countersFor = (run: string) => {
		let counters = runs.get(run);
		if (!counters) {
			counters = fresh();
			runs.set(run, counters);
		}
		return counters;
	};
	const count = (run: string, apply: (counters: RunCounters) => void) => {
		apply(countersFor(run));
		apply(totals);
		publish();
	};

	const faultFor = (
		url: URL,
		run: string,
	): { action: string; value?: unknown } | undefined => {
		const query = url.searchParams.get("fault");
		if (query) return { action: query };
		for (const action of [
			"end",
			"reset",
			"status",
			"wrong-content-type",
			"stall",
			"byte-split",
			"oversized",
			"id-variants",
		]) {
			const fault = app.fault("sse", action);
			const target = (fault?.value as { run?: string } | undefined)?.run;
			if (fault && (target === undefined || target === run)) return fault;
		}
		return undefined;
	};

	const handler = async (
		req: IncomingMessage,
		res: ServerResponse,
		url: URL,
	) => {
		const run = url.searchParams.get("run") ?? "default";
		const header = req.headers["last-event-id"];
		const lastEventId = typeof header === "string" ? header : null;
		const lastEventIdQuery = url.searchParams.get("lastEventId");
		const hasAuth = typeof req.headers.authorization === "string";
		const requestIndex = countersFor(run).requests.length;
		let scope: string | null = null;
		if (hasAuth) {
			const verdict = app.authorise(req.headers.authorization);
			scope = verdict.ok ? verdict.scope : null;
		}
		count(run, (counters) => {
			counters.requests.push({
				method: req.method ?? "GET",
				lastEventId,
				lastEventIdQuery,
				hasAuth,
				scope,
			});
		});
		// Drain any request body so POST streams are well-formed.
		req.resume();

		const failFirst = Number(url.searchParams.get("failFirst") ?? 0);
		const failAt = (url.searchParams.get("failAt") ?? "")
			.split(",")
			.filter(Boolean)
			.map(Number);
		if (requestIndex < failFirst || failAt.includes(requestIndex)) {
			res.writeHead(Number(url.searchParams.get("failStatus") ?? 500), {
				"content-type": "text/plain",
			});
			res.end("fixture failure");
			return;
		}
		if (
			url.searchParams.get("guard") === "1" &&
			!app.authorise(req.headers.authorization).ok
		) {
			res.writeHead(401, { "content-type": "text/plain" });
			res.end("unauthorised");
			return;
		}
		const fault = faultFor(url, run);
		if (fault?.action === "status") {
			const status = Number(
				url.searchParams.get("status") ??
					(fault.value as { status?: number })?.status ??
					500,
			);
			res.writeHead(status, { "content-type": "text/plain" });
			res.end(status === 204 ? undefined : "fixture status");
			return;
		}
		if (fault?.action === "wrong-content-type") {
			res.writeHead(200, { "content-type": "text/html" });
			res.end("data: not an event stream\n\n");
			return;
		}

		res.writeHead(200, {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-store",
			connection: "keep-alive",
		});
		res.flushHeaders();
		count(run, (counters) => {
			counters.streams += 1;
			counters.active += 1;
		});
		live.set(run, (live.get(run) ?? 0) + 1);
		let finished = false;
		let closed = false;
		open.add(res);
		res.on("close", () => {
			closed = true;
			open.delete(res);
			count(run, (counters) => {
				counters.active -= 1;
				if (!finished) counters.disconnects += 1;
			});
			live.set(run, (live.get(run) ?? 1) - 1);
		});
		const finish = () => {
			finished = true;
			count(run, (counters) => {
				counters.completed += 1;
			});
			res.end();
		};
		const byteSplit =
			fault?.action === "byte-split" || url.searchParams.get("split") === "1";
		/** Resolves once the bytes are handed to the socket, so a reset never drops them. */
		const flushed = (chunk: string | Buffer) =>
			new Promise<void>((resolve) => {
				if (closed) return resolve();
				res.write(chunk, () => resolve());
			});
		const write = async (text: string) => {
			if (closed) return;
			if (byteSplit) {
				for (const byte of Buffer.from(text, "utf8")) {
					if (closed) return;
					await flushed(Buffer.from([byte]));
					await sleep(1);
				}
				return;
			}
			await flushed(text);
		};

		if (fault?.action === "stall") return;
		if (fault?.action === "id-variants") {
			for (const part of ID_VARIANTS) await write(part);
			count(run, (counters) => {
				counters.events += 5;
			});
			finish();
			return;
		}
		const retry = url.searchParams.get("retry");
		if (retry) await write(`retry: ${retry}\n\n`);
		if (fault?.action === "oversized") {
			const size = Number(url.searchParams.get("size") ?? 300_000);
			await write(`id: 1\ndata: ${"x".repeat(size)}\n\n`);
			finish();
			return;
		}

		const cursor = lastEventId ?? lastEventIdQuery;
		let n = cursor !== null && /^\d+$/.test(cursor) ? Number(cursor) : 0;
		const oldest = Number(url.searchParams.get("oldest") ?? 0);
		if (cursor !== null && oldest > 0 && n < oldest) {
			await write("event: reset\ndata: cursor too old\n\n");
			n = oldest - 1;
		}
		const rate = Number(url.searchParams.get("rate") ?? 20);
		const limit = url.searchParams.has("count")
			? Number(url.searchParams.get("count"))
			: Number.POSITIVE_INFINITY;
		const alertEvery = Number(url.searchParams.get("alertEvery") ?? 0);
		const resetAfter = url.searchParams.has("resetAfter")
			? Number(url.searchParams.get("resetAfter"))
			: fault?.action === "reset"
				? 3
				: undefined;
		const resetOnce = url.searchParams.get("resetOnce") === "1";
		let sent = 0;
		while (!closed && sent < limit) {
			n += 1;
			const alert = alertEvery > 0 && n % alertEvery === 0;
			const payload = JSON.stringify({ n, text: "héllo 🌍" });
			await write(
				`id: ${n}\nevent: ${alert ? "alert" : "tick"}\ndata: ${payload}\n\n`,
			);
			sent += 1;
			count(run, (counters) => {
				counters.events += 1;
			});
			if (
				resetAfter !== undefined &&
				sent >= resetAfter &&
				(!resetOnce || requestIndex === 0)
			) {
				// Mid-body reset after the bytes left: no clean end.
				await sleep(5);
				res.socket?.destroy();
				return;
			}
			await sleep(rate);
		}
		if (!closed) finish();
	};

	app.http("GET", "/sse/ticks", handler);
	app.http("POST", "/sse/ticks", handler);
	app.http("GET", "/sse/counters", (_req, res, url) => {
		sendJson(res, 200, countersFor(url.searchParams.get("run") ?? "default"));
	});

	app.onReset(() => {
		totals = fresh();
		for (const run of [...runs.keys()])
			if ((live.get(run) ?? 0) <= 0) runs.delete(run);
		publish();
	});
}
