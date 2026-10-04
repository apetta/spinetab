import type { IncomingMessage, ServerResponse } from "node:http";
import { type FixtureApp, sendJson } from "./app.ts";

/**
 * Polling fixture.
 *
 * `GET|POST /poll/value?id=<identity marker>[&scope=<marker>][&guard=required]`
 * returns `{ n, at, scope }`, where `n` increases per `id` (a late joiner can
 * never be served an old number) and `scope` is the bearer token's scope when
 * authorised, else the `scope` query marker.
 *
 * Counters (`app.counters.polling`): `requests[]` (id, method, hasAuth,
 * scope, at, status, aborted), global `inFlight`/`maxInFlight`/`aborted`/
 * `completed`, and the same per `id` under `byId` so concurrent tests can
 * assert their own identity's concurrency high-water mark.
 *
 * Faults (`POST /__fixture/fault { target: "polling", action, value }`), each
 * optionally scoped with `value: { id,... }`:
 * - `delay-ms`: number or `{ ms }` before responding;
 * - `status`: 401 | 429 | 500 (or any code) or `{ status, retryAfter }`;
 * - `hang`: never respond until the client aborts;
 * - `oversized`: `true`, a byte count or `{ bytes }` (default 1 MiB body).
 */
interface IdStats {
	requests: number;
	inFlight: number;
	maxInFlight: number;
	aborted: number;
	completed: number;
	n: number;
}

interface RequestRecord {
	id: string;
	method: string;
	hasAuth: boolean;
	scope: string | null;
	at: number;
	status: number;
	aborted: boolean;
}

const MAX_RECORDS = 5_000;

export function register(app: FixtureApp): void {
	const counters = {
		requests: [] as RequestRecord[],
		inFlight: 0,
		maxInFlight: 0,
		aborted: 0,
		completed: 0,
		byId: {} as Record<string, IdStats>,
	};
	app.counters.polling = counters as unknown as Record<string, unknown>;
	app.onReset(() => {
		counters.requests = [];
		counters.inFlight = 0;
		counters.maxInFlight = 0;
		counters.aborted = 0;
		counters.completed = 0;
		counters.byId = {};
	});

	// In-flight reads (delayed or hung), destroyed on shutdown so their
	// waits end.
	const open = new Set<ServerResponse>();
	app.onClose(() => {
		for (const res of open) res.destroy();
		open.clear();
	});

	const faultFor = (action: string, id: string): unknown => {
		const fault = app.fault("polling", action);
		if (!fault) return undefined;
		const value = fault.value;
		if (value && typeof value === "object" && "id" in value) {
			return (value as { id: unknown }).id === id ? value : undefined;
		}
		return value ?? true;
	};

	app.http(
		"*",
		"/poll/value",
		async (req: IncomingMessage, res: ServerResponse, url: URL) => {
			const method = req.method ?? "GET";
			if (method !== "GET" && method !== "POST") {
				sendJson(res, 405, { error: "method-not-allowed" });
				return;
			}
			// Drain any request body (POST polling) without interpreting it.
			req.resume();
			const id = url.searchParams.get("id") ?? "";
			let stats = counters.byId[id];
			if (!stats) {
				stats = {
					requests: 0,
					inFlight: 0,
					maxInFlight: 0,
					aborted: 0,
					completed: 0,
					n: 0,
				};
				counters.byId[id] = stats;
			}
			const header = req.headers.authorization;
			const auth = header ? app.authorise(header) : undefined;
			const record: RequestRecord = {
				id,
				method,
				hasAuth: Boolean(header),
				scope: auth?.ok ? auth.scope : url.searchParams.get("scope"),
				at: Date.now(),
				status: 0,
				aborted: false,
			};
			counters.requests.push(record);
			if (counters.requests.length > MAX_RECORDS) counters.requests.shift();
			stats.requests += 1;
			counters.inFlight += 1;
			stats.inFlight += 1;
			counters.maxInFlight = Math.max(counters.maxInFlight, counters.inFlight);
			stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
			const current = stats;
			let finished = false;
			const finish = () => {
				if (finished) return;
				finished = true;
				counters.inFlight -= 1;
				current.inFlight -= 1;
			};
			let closed = false;
			open.add(res);
			res.on("close", () => {
				closed = true;
				open.delete(res);
				if (!res.writableFinished) {
					record.aborted = true;
					counters.aborted += 1;
					current.aborted += 1;
				}
				finish();
			});

			const delay = faultFor("delay-ms", id);
			const delayMs =
				typeof delay === "number"
					? delay
					: delay && typeof delay === "object"
						? Number((delay as { ms?: unknown }).ms ?? 0)
						: 0;
			if (delayMs > 0) await waitUnlessClosed(delayMs, () => closed);
			if (closed) return;
			if (faultFor("hang", id)) return;

			const status = faultFor("status", id);
			const code =
				typeof status === "number"
					? status
					: status && typeof status === "object"
						? Number((status as { status?: unknown }).status)
						: 0;
			if (code) {
				record.status = code;
				const retryAfter =
					status && typeof status === "object"
						? (status as { retryAfter?: unknown }).retryAfter
						: undefined;
				res.writeHead(code, {
					"content-type": "application/json",
					"cache-control": "no-store",
					...(retryAfter !== undefined
						? { "retry-after": String(retryAfter) }
						: {}),
				});
				res.end(JSON.stringify({ error: `status-${code}` }));
				return;
			}
			if (url.searchParams.get("guard") === "required" && !auth?.ok) {
				record.status = 401;
				sendJson(res, 401, { error: "unauthorised" });
				return;
			}
			const oversized = faultFor("oversized", id);
			if (oversized) {
				const bytes =
					typeof oversized === "number"
						? oversized
						: oversized &&
								typeof oversized === "object" &&
								typeof (oversized as { bytes?: unknown }).bytes === "number"
							? (oversized as { bytes: number }).bytes
							: 1024 * 1024;
				record.status = 200;
				res.writeHead(200, {
					"content-type": "application/json",
					"cache-control": "no-store",
				});
				res.end(JSON.stringify({ n: -1, pad: "x".repeat(bytes) }));
				return;
			}
			current.n += 1;
			current.completed += 1;
			counters.completed += 1;
			record.status = 200;
			sendJson(res, 200, { n: current.n, at: Date.now(), scope: record.scope });
		},
	);
}

function waitUnlessClosed(ms: number, closed: () => boolean): Promise<void> {
	return new Promise((resolve) => {
		const started = Date.now();
		const check = () => {
			if (closed() || Date.now() - started >= ms) resolve();
			else setTimeout(check, Math.min(25, ms));
		};
		check();
	});
}
