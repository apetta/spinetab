import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, inject, it } from "vitest";

// EventSource mode against a real EventSource implementation. Vitest
// workers have no EventSource, so each case runs the adapter source in a child
// `node --experimental-eventsource` process (undici's EventSource, which
// follows the HTML reconnection algorithm) against the `sse` fixture. The
// browser suite (tests/browser/transports-sse.spec.ts) repeats the cursor
// cases in Chromium, Firefox and WebKit.

const [origin] = inject("fixtureOrigins");
const runtimeUrl = pathToFileURL(
	fileURLToPath(
		new URL("../../../src/transports/sse/runtime.ts", import.meta.url),
	),
).href;
const limitsUrl = pathToFileURL(
	fileURLToPath(new URL("../../../src/core/limits.ts", import.meta.url)),
).href;

const CHILD = `
const { sseAdapter } = await import(process.env.RUNTIME_URL);
const { DEFAULT_LIMITS } = await import(process.env.LIMITS_URL);
Math.random = () => 0;
const out = { events: [], continuity: [], statuses: [], errors: [] };
const adapter = sseAdapter({ decoders: {} });
// Text payloads; the envelope below is rebuilt from meta.
const spec = { decoder: "text",...JSON.parse(process.env.SPEC) };
adapter.validateConnection(spec);
const ctx = {
	scope: "", key: "k", limits: DEFAULT_LIMITS, signal: new AbortController().signal,
	credentials: async () => { throw Object.assign(new Error("none"), { name: "SpinetabError", code: "no-credential-source" }); },
	rejectCredentials() {}, setStatus(status) { out.statuses.push(status); }, diagnostic() {}, now: () => Date.now(),
};
const conn = adapter.connect(spec, ctx);
conn.subscribe({ event: "tick" }, {
	next(data, meta) { out.events.push({ id: meta?.eventId ?? null, event: meta?.event, data }); }, error(error) { out.errors.push(error); }, complete() {},
	continuity(reason, detail) { out.continuity.push(detail === undefined ? { reason } : { reason, detail }); },
	started() {},
}, { key: "tick", repeatable: true });
const minEvents = Number(process.env.MIN_EVENTS);
const deadline = Date.now() + 8000;
// Two notices per interruption: the early notice and the outcome.
while (Date.now() < deadline && !(out.continuity.length >= 2 && out.events.length >= minEvents)) {
	await new Promise((resolve) => setTimeout(resolve, 20));
}
conn.dispose();
process.stdout.write(JSON.stringify(out));
process.exit(0);
`;

interface ChildResult {
	events: Array<{ id: string | null; event: string; data: string }>;
	continuity: Array<{ reason: string; detail?: unknown }>;
	statuses: Array<Record<string, unknown>>;
	errors: unknown[];
}

function runChild(
	spec: Record<string, unknown>,
	minEvents: number,
): Promise<ChildResult> {
	return new Promise((resolve, reject) => {
		execFile(
			process.execPath,
			[
				"--experimental-eventsource",
				"--no-warnings",
				"--input-type=module",
				"-e",
				CHILD,
			],
			{
				env: {
					...process.env,
					RUNTIME_URL: runtimeUrl,
					LIMITS_URL: limitsUrl,
					SPEC: JSON.stringify(spec),
					MIN_EVENTS: String(minEvents),
				},
				timeout: 15_000,
			},
			(error, stdout, stderr) => {
				if (error) reject(new Error(`${error.message}\n${stderr}`));
				else resolve(JSON.parse(stdout) as ChildResult);
			},
		);
	});
}

async function requests(run: string) {
	const response = await fetch(`${origin}/sse/counters?run=${run}`);
	const counters = (await response.json()) as {
		requests: Array<{
			lastEventId: string | null;
			lastEventIdQuery: string | null;
		}>;
	};
	return counters.requests;
}

describe("native EventSource supervision (Node's undici EventSource)", () => {
	it("lets the built-in loop reconnect with Last-Event-ID; resumed only with declared replay", async () => {
		const run = randomUUID();
		const result = await runChild(
			{
				url: `${origin}/sse/ticks?run=${run}&rate=10&resetAfter=3&resetOnce=1&retry=50`,
				mode: "eventsource",
				replay: "last-event-id",
			},
			5,
		);
		const seen = await requests(run);
		expect(seen[1]).toEqual(
			expect.objectContaining({ lastEventId: "3", lastEventIdQuery: null }),
		);
		expect(result.continuity.slice(0, 2)).toEqual([
			{ reason: "reconnected" },
			{
				reason: "resumed-with-cursor",
				detail: { cursor: "3", duplicatesPossible: true },
			},
		]);
		expect(result.events.slice(0, 5).map((event) => event.id)).toEqual([
			"1",
			"2",
			"3",
			"4",
			"5",
		]);
		expect(result.statuses.map((status) => status.state).slice(0, 4)).toEqual([
			"connecting",
			"connected",
			"reconnecting",
			"connected",
		]);
	});

	it("recreates a CLOSED EventSource and conveys the cursor only through the declared query", async () => {
		const run = randomUUID();
		const result = await runChild(
			{
				url: `${origin}/sse/ticks?run=${run}&rate=10&resetAfter=3&resetOnce=1&retry=50&failAt=1`,
				mode: "eventsource",
				resume: { query: "lastEventId" },
				replay: "last-event-id",
			},
			5,
		);
		const seen = await requests(run);
		// Request 1 is the engine's own reconnect (header); it gets a 500, so the
		// EventSource is CLOSED. Request 2 is the adapter's recreation: a new
		// EventSource has no implicit cursor, so only the query carries it.
		expect(seen[1]).toEqual(expect.objectContaining({ lastEventId: "3" }));
		expect(seen[2]).toEqual(
			expect.objectContaining({ lastEventId: null, lastEventIdQuery: "3" }),
		);
		expect(result.statuses).toContainEqual(
			expect.objectContaining({
				state: "reconnecting",
				reason: "server-closed",
				code: "eventsource-closed",
			}),
		);
		expect(result.continuity.slice(0, 2)).toEqual([
			{ reason: "reconnected" },
			{
				reason: "resumed-with-cursor",
				detail: { cursor: "3", duplicatesPossible: true },
			},
		]);
		expect(result.events.slice(0, 5).map((event) => event.id)).toEqual([
			"1",
			"2",
			"3",
			"4",
			"5",
		]);
	});

	it("never claims replay after recreation without a cursor path", async () => {
		const run = randomUUID();
		const result = await runChild(
			{
				url: `${origin}/sse/ticks?run=${run}&rate=10&resetAfter=3&resetOnce=1&retry=50&failAt=1`,
				mode: "eventsource",
				replay: "last-event-id",
			},
			4,
		);
		const seen = await requests(run);
		expect(seen[2]).toEqual(
			expect.objectContaining({ lastEventId: null, lastEventIdQuery: null }),
		);
		expect(result.continuity.slice(0, 2)).toEqual([
			{ reason: "reconnected" },
			{ reason: "reconnected" },
		]);
	});
});
