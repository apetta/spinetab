import type { IncomingMessage, ServerResponse } from "node:http";
import { type FixtureApp, sendJson, sleep } from "./app.ts";

/**
 * `GET|POST /stream/ndjson` fixture.
 *
 * Emits `count` lines `{"n":i,"text":"héllo 🌍 ✓"}\n` (default 5), written in
 * `split`-byte writes (`split=1` is one byte per write; `0` or absent is one
 * coalesced write per line, or the whole body when `rate=0`).
 *
 * Query: `run`, `count`, `split`, `rate` (ms between lines, default 0),
 * `fault`, `status`, `size`, `malformedAt` (default 2), `terminateFirst=1`
 * (only the run's first request is cut mid-frame), `heartbeatMs` (heartbeat
 * lines while stalled).
 *
 * Faults (`?fault=` or global `target: "stream"` with optional `value.run`):
 * malformed, oversized (a line of `size` bytes with no newline, then
 * stall), terminate-mid-frame, stall, no-trailing-newline, status.
 * Counters: requests (by method), starts (POST), active, aborts, completed.
 */
interface RunCounters {
	requests: Record<string, number>;
	starts: number;
	active: number;
	aborts: number;
	completed: number;
}

const fresh = (): RunCounters => ({
	requests: {},
	starts: 0,
	active: 0,
	aborts: 0,
	completed: 0,
});

export function register(app: FixtureApp): void {
	const runs = new Map<string, RunCounters>();
	const live = new Map<string, number>();
	// Open NDJSON responses, destroyed on shutdown so every loop ends.
	const open = new Set<ServerResponse>();
	app.onClose(() => {
		for (const res of open) res.destroy();
		open.clear();
	});
	let totals = fresh();
	const publish = () => {
		app.counters.stream = {
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

	const faultFor = (url: URL, run: string): string | undefined => {
		const query = url.searchParams.get("fault");
		if (query) return query;
		for (const action of [
			"malformed",
			"oversized",
			"terminate-mid-frame",
			"stall",
			"no-trailing-newline",
			"status",
		]) {
			const fault = app.fault("stream", action);
			const target = (fault?.value as { run?: string } | undefined)?.run;
			if (fault && (target === undefined || target === run)) return action;
		}
		return undefined;
	};

	const handler = async (
		req: IncomingMessage,
		res: ServerResponse,
		url: URL,
	) => {
		const run = url.searchParams.get("run") ?? "default";
		const method = req.method ?? "GET";
		const requestIndex = Object.values(countersFor(run).requests).reduce(
			(sum, value) => sum + value,
			0,
		);
		count(run, (counters) => {
			counters.requests[method] = (counters.requests[method] ?? 0) + 1;
			if (method === "POST") counters.starts += 1;
		});
		req.resume();
		const fault = faultFor(url, run);
		const status = Number(url.searchParams.get("status") ?? 0);
		if (fault === "status" || status) {
			res.writeHead(status || 500, { "content-type": "text/plain" });
			res.end(status === 204 ? undefined : "fixture status");
			return;
		}
		res.writeHead(200, {
			"content-type": "application/x-ndjson",
			"cache-control": "no-store",
		});
		res.flushHeaders();
		count(run, (counters) => {
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
				if (!finished) counters.aborts += 1;
			});
			live.set(run, (live.get(run) ?? 1) - 1);
		});

		const split = Number(url.searchParams.get("split") ?? 0);
		const rate = Number(url.searchParams.get("rate") ?? 0);
		/** Resolves once the bytes are handed to the socket, so a cut never drops them. */
		const flushed = (chunk: Buffer) =>
			new Promise<void>((resolve) => {
				if (closed) return resolve();
				res.write(chunk, () => resolve());
			});
		const write = async (text: string) => {
			if (closed) return;
			const bytes = Buffer.from(text, "utf8");
			if (split > 0) {
				for (let index = 0; index < bytes.length; index += split) {
					if (closed) return;
					await flushed(bytes.subarray(index, index + split));
					await sleep(1);
				}
				return;
			}
			await flushed(bytes);
		};
		const heartbeatMs = Number(url.searchParams.get("heartbeatMs") ?? 0);
		const stall = async () => {
			while (!closed && heartbeatMs > 0) {
				await sleep(heartbeatMs);
				await write('{"type":"heartbeat"}\n');
			}
		};

		const total = Number(url.searchParams.get("count") ?? 5);
		const malformedAt = Number(url.searchParams.get("malformedAt") ?? 2);
		const line = (n: number) =>
			`${JSON.stringify({ n, text: "héllo 🌍 ✓" })}\n`;
		const cutMidFrame =
			fault === "terminate-mid-frame" ||
			(url.searchParams.get("terminateFirst") === "1" && requestIndex === 0);

		if (rate === 0 && split === 0 && !fault && !cutMidFrame) {
			let body = "";
			for (let n = 1; n <= total; n += 1) body += line(n);
			res.write(body);
		} else {
			for (let n = 1; n <= total && !closed; n += 1) {
				if (fault === "malformed" && n === malformedAt) {
					await write('{"n":2,"text":bad json}\n');
					continue;
				}
				if (cutMidFrame && n === 2) {
					const text = line(n);
					await write(text.slice(0, Math.floor(text.length / 2)));
					await sleep(10);
					res.socket?.destroy();
					return;
				}
				if (fault === "oversized" && n === 2) {
					await write(
						"x".repeat(Number(url.searchParams.get("size") ?? 300_000)),
					);
					await stall();
					return;
				}
				if (fault === "stall" && n === 2) {
					await stall();
					return;
				}
				const text = line(n);
				await write(
					fault === "no-trailing-newline" && n === total
						? text.slice(0, -1)
						: text,
				);
				if (rate > 0) await sleep(rate);
			}
		}
		if (closed) return;
		finished = true;
		count(run, (counters) => {
			counters.completed += 1;
		});
		res.end();
	};

	app.http("GET", "/stream/ndjson", handler);
	app.http("POST", "/stream/ndjson", handler);
	app.http("GET", "/stream/counters", (_req, res, url) => {
		sendJson(res, 200, countersFor(url.searchParams.get("run") ?? "default"));
	});

	app.onReset(() => {
		totals = fresh();
		for (const run of [...runs.keys()])
			if ((live.get(run) ?? 0) <= 0) runs.delete(run);
		publish();
	});
}
