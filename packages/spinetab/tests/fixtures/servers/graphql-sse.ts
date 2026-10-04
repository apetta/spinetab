import type { IncomingMessage, ServerResponse } from "node:http";
import { createHandler } from "graphql-sse/lib/use/http";
import { type FixtureApp, sendJson } from "./app.ts";
import { fixtureSchema } from "./graphql-ws.ts";

/**
 * Real graphql-sse 2.6.1 handler (`graphql-sse/lib/use/http`) serving both
 * distinct and single-connection modes at `/graphql-sse/<tag>`.
 *
 * The tag is a path segment, not a query parameter: the upstream client builds
 * single-mode DELETE URLs as `url + "?operationId=…"`. Optional segments:
 * `/graphql-sse/<tag>/heartbeat/<ms>` writes an SSE comment every `<ms>` on
 * stream responses (the reference handler's own ping is every 12 s).
 *
 * Auth: `Authorization: Bearer valid-<scope>-<n>` through `app.authorise`,
 * except tags starting with `anon`. Faults (`target: "graphql-sse@<tag>"` or
 * `"graphql-sse"`): `status` (value: HTTP status for every request, or
 * `{ status, method }`), `stall` (stream bytes, comments included, are
 * swallowed: a half-open stream). `POST /graphql-sse-control/terminate?tag=`
 * destroys that tag's open streams.
 */

export interface GraphqlSseTagCounters {
	requests: Record<string, number>;
	statuses: number[];
	active: number;
	streams: number;
	operations: number;
	completes: number;
	authorizations: string[];
	urls: string[];
}

function emptyCounters(): GraphqlSseTagCounters {
	return {
		requests: {},
		statuses: [],
		active: 0,
		streams: 0,
		operations: 0,
		completes: 0,
		authorizations: [],
		urls: [],
	};
}

interface ParsedPath {
	tag: string;
	heartbeatMs?: number;
}

function parsePath(url: string | undefined): ParsedPath {
	const pathname = new URL(url ?? "/", "http://fixture.invalid").pathname;
	const [, , tag = "default", option, value] = pathname.split("/");
	if (option === "heartbeat" && value) {
		return { tag, heartbeatMs: Number(value) };
	}
	return { tag };
}

export function register(app: FixtureApp): void {
	const totals = { tags: {} as Record<string, GraphqlSseTagCounters> };
	app.counters["graphql-sse"] = totals;
	app.onReset(() => {
		totals.tags = {};
	});
	const countersFor = (tag: string) => {
		totals.tags[tag] ??= emptyCounters();
		return totals.tags[tag];
	};
	const fault = (tag: string, action: string) =>
		app.fault(`graphql-sse@${tag}`, action) ?? app.fault("graphql-sse", action);
	const open = new Map<string, Set<ServerResponse>>();

	const handler = createHandler({
		schema: fixtureSchema,
		context: (req) => ({ tag: parsePath(req.url).tag }),
		authenticate: (req) => {
			const { tag } = parsePath(req.url);
			const header = req.headers.get("authorization") ?? undefined;
			if (header) countersFor(tag).authorizations.push(header);
			if (!tag.startsWith("anon") && !app.authorise(header).ok) {
				return [null, { status: 401, statusText: "Unauthorized" }];
			}
			// Same token rules as the default `authenticate`.
			const token = req.headers.get("x-graphql-event-stream-token");
			if (token) return token;
			const urlToken = new URL(
				req.url ?? "/",
				"http://fixture.invalid",
			).searchParams.get("token");
			return urlToken ?? globalThis.crypto.randomUUID();
		},
		onOperation: (ctx) => {
			const tag = (ctx as { tag?: string } | undefined)?.tag ?? "default";
			countersFor(tag).operations += 1;
		},
		onComplete: (ctx) => {
			const tag = (ctx as { tag?: string } | undefined)?.tag ?? "default";
			countersFor(tag).completes += 1;
		},
	});

	app.http("POST", "/graphql-sse-control/terminate", (_req, res, url) => {
		const tag = url.searchParams.get("tag") ?? "default";
		let terminated = 0;
		for (const response of open.get(tag) ?? []) {
			response.destroy();
			terminated += 1;
		}
		sendJson(res, 200, { terminated });
	});

	app.http("*", "/graphql-sse/", async (req: IncomingMessage, res, url) => {
		const { tag, heartbeatMs } = parsePath(req.url);
		const counters = countersFor(tag);
		const method = req.method ?? "GET";
		counters.requests[method] = (counters.requests[method] ?? 0) + 1;
		counters.urls.push(url.pathname + url.search);
		const forced = fault(tag, "status");
		if (forced) {
			const spec = forced.value as number | { status: number; method?: string };
			const status = typeof spec === "number" ? spec : spec.status;
			const onlyMethod = typeof spec === "number" ? undefined : spec.method;
			if (!onlyMethod || onlyMethod === method) {
				counters.statuses.push(status);
				sendJson(res, status, { error: "fixture-status" });
				return;
			}
		}
		const originalWriteHead = res.writeHead.bind(res);
		let heartbeat: ReturnType<typeof setInterval> | undefined;
		res.writeHead = ((status: number, ...rest: unknown[]) => {
			counters.statuses.push(status);
			const result = (
				originalWriteHead as (...args: unknown[]) => ServerResponse
			)(status, ...rest);
			const contentType = String(res.getHeader("content-type") ?? "");
			const headersArg = rest.find((item) => typeof item === "object") as
				| Record<string, string>
				| undefined;
			const streaming =
				contentType.includes("text/event-stream") ||
				String(headersArg?.["content-type"] ?? "").includes(
					"text/event-stream",
				);
			if (streaming && status === 200) {
				counters.streams += 1;
				counters.active += 1;
				let set = open.get(tag);
				if (!set) {
					set = new Set();
					open.set(tag, set);
				}
				set.add(res);
				res.once("close", () => {
					counters.active -= 1;
					set.delete(res);
					if (heartbeat) clearInterval(heartbeat);
				});
				if (heartbeatMs) {
					heartbeat = setInterval(() => {
						if (res.writable) res.write(":\n\n");
					}, heartbeatMs);
				}
			}
			return result;
		}) as typeof res.writeHead;
		const originalWrite = res.write.bind(res);
		res.write = ((chunk: unknown, ...rest: unknown[]) => {
			if (fault(tag, "stall")) {
				const callback = rest.find((item) => typeof item === "function") as
					| ((error?: Error | null) => void)
					| undefined;
				if (callback) queueMicrotask(() => callback());
				return true;
			}
			return (originalWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
		}) as typeof res.write;
		try {
			await handler(req, res);
		} catch {
			if (!res.headersSent) sendJson(res, 500, { error: "handler-failed" });
			else res.end();
		}
	});
}
