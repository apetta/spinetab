import { randomUUID } from "node:crypto";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	inject,
	it,
	vi,
} from "vitest";
import type { AdapterConnection } from "../../../src/core/adapter.ts";
import {
	CLOSE_LIVENESS,
	type WebSocketCommandPayload,
	type WebSocketSubscriptionSpec,
	websocketAdapter,
} from "../../../src/transports/websocket/runtime.ts";
import {
	fakeContext,
	recordingSink,
	waitFor,
} from "../../unit/transports/helpers.ts";
import { createTopicProtocol } from "../../unit/transports/topic-protocol.ts";

// NT-I-01…07: the WebSocket adapter against the real `ws` fixture over Node's
// native WebSocket (undici). Counters are run-scoped, so no global reset.

const [origin] = inject("fixtureOrigins");
const wsOrigin = origin.replace(/^http/, "ws");

interface WsCounters {
	upgrades: number;
	opens: number;
	active: number;
	subscribes: Record<string, number>;
	unsubscribes: Record<string, number>;
	activeTopics: Record<string, number>;
	commands: Record<string, number>;
	authMessages: number;
	closeCodes: number[];
	urls: string[];
	log: string[];
}

async function counters(run: string): Promise<WsCounters> {
	const response = await fetch(`${origin}/ws/counters?run=${run}`);
	return (await response.json()) as WsCounters;
}

async function control(run: string, action: string, value?: unknown) {
	await fetch(`${origin}/ws/control`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ run, action, value }),
	});
}

type Conn = AdapterConnection<
	WebSocketSubscriptionSpec,
	unknown,
	WebSocketCommandPayload,
	unknown
>;
const open: Conn[] = [];

/**
 * `fixtureQuery` is appended after validation: the public API refuses `auth` as a URL query
 * name (the fixture switch is therefore called `guard`), and the fixture's `guard=1` switch is a test detail no application
 * option carries.
 */
function connect(
	query: string,
	protocol = createTopicProtocol(),
	limits: Parameters<typeof fakeContext>[0] = {},
	fixtureQuery = "",
) {
	const run = randomUUID();
	const adapter = websocketAdapter({ protocols: { topics: protocol } });
	const spec = {
		url: `${wsOrigin}/ws/topics?run=${run}&${query}`,
		protocol: "topics",
	};
	adapter.validateConnection?.(spec);
	const fake = fakeContext(limits);
	const conn = adapter.connect(
		fixtureQuery ? { ...spec, url: `${spec.url}&${fixtureQuery}` } : spec,
		fake.ctx,
	);
	open.push(conn);
	return { run, conn, fake };
}

function subscribe(conn: Conn, topic?: string) {
	const record = recordingSink();
	const sub = conn.subscribe(
		topic === undefined ? {} : { topic },
		record.sink,
		{
			key: topic ?? "feed",
			repeatable: true,
		},
	);
	return { record, sub };
}

const commandOptions = (timeoutMs = 30_000) => ({
	id: "page",
	signal: new AbortController().signal,
	timeoutMs,
});

beforeEach(() => {
	// Zero jitter: reconnect immediately; jitter bounds are unit-tested.
	vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
	for (const conn of open.splice(0)) conn.dispose();
	vi.restoreAllMocks();
});

describe("websocket adapter against the ws fixture", () => {
	it("shares one socket across topics, routes text and binary, unsubscribes on the last leave (NT-I-01)", async () => {
		const { run, conn, fake } = connect("rate=20");
		const a1 = subscribe(conn, "a");
		const a2 = subscribe(conn, "a");
		const binary = subscribe(conn, "binary");
		const feed = subscribe(conn);
		await waitFor(
			() => a1.record.events.length >= 3 && binary.record.events.length >= 3,
		);
		const server = await counters(run);
		expect(server.opens).toBe(1);
		expect(server.subscribes).toEqual({ a: 1, binary: 1 });
		expect(a1.record.events.slice(0, 3)).toEqual(a2.record.events.slice(0, 3));
		const seqs = a1.record.events.map(
			(event) => (event as { seq: number }).seq,
		);
		expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
		expect((a1.record.events[0] as { text: string }).text).toBe("héllo 🌍");
		const frame = binary.record.events[0];
		expect(frame).toBeInstanceOf(ArrayBuffer);
		expect([...new Uint8Array(frame as ArrayBuffer)].slice(1)).toEqual([
			1, 2, 3,
		]);
		expect(feed.record.events.length).toBeGreaterThan(a1.record.events.length);
		expect(
			fake.diagnostics.find((event) => event.type === "websocket-open"),
		).toBeDefined();
		a1.sub.unsubscribe();
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect((await counters(run)).unsubscribes).toEqual({});
		a2.sub.unsubscribe();
		await waitFor(async () => (await counters(run)).unsubscribes.a === 1);
		const settled = await counters(run);
		expect(settled.activeTopics.a).toBe(0);
		expect(settled.log).toEqual([
			"1:subscribe:a",
			"1:subscribe:binary",
			"1:unsubscribe:a",
		]);
	});

	it("reconnects after termination, resubscribes exactly once and never replays commands (NT-I-02)", async () => {
		const { run, conn, fake } = connect("rate=20");
		const a = subscribe(conn, "a");
		await waitFor(() => a.record.events.length >= 1);
		await control(run, "drop-next-ack");
		const pending = conn.command?.({ data: { op: "once" } }, commandOptions());
		await waitFor(
			async () => Object.keys((await counters(run)).commands).length === 1,
		);
		await control(run, "terminate");
		expect(await pending).toMatchObject({
			status: "unknown",
			error: { detail: { reason: "disconnected" } },
		});
		// The early notice at detection, then the outcome.
		await waitFor(() => a.record.continuity.length === 2);
		expect(a.record.continuity).toEqual([
			{ reason: "reconnected" },
			{ reason: "reconnected" },
		]);
		const before = a.record.events.length;
		await waitFor(() => a.record.events.length > before);
		const server = await counters(run);
		expect(server.opens).toBe(2);
		expect(server.subscribes.a).toBe(2);
		expect(Object.values(server.commands)).toEqual([1]);
		expect(fake.states()).toEqual([
			"connecting",
			"connected",
			"reconnecting",
			"connected",
		]);
	});

	it("settles acknowledged, unknown(timeout) and unknown(disconnected) against a real server (NT-I-03)", async () => {
		const { run, conn } = connect("rate=1000");
		subscribe(conn, "a");
		await waitFor(async () => (await counters(run)).subscribes.a === 1);
		expect(await conn.command?.({ data: { x: 1 } }, commandOptions())).toEqual({
			status: "acknowledged",
			value: { echo: { x: 1 } },
		});
		expect(
			await conn.command?.({ data: { reject: true } }, commandOptions()),
		).toMatchObject({
			status: "rejected",
			error: { code: "command-rejected" },
		});
		expect(
			await conn.command?.({ data: 1, expectsAck: false }, commandOptions()),
		).toEqual({ status: "sent" });
		await control(run, "drop-next-ack");
		expect(
			await conn.command?.({ data: 2 }, commandOptions(300)),
		).toMatchObject({
			status: "unknown",
			error: { detail: { reason: "timeout" } },
		});
		await control(run, "close-before-ack");
		expect(await conn.command?.({ data: 3 }, commandOptions())).toMatchObject({
			status: "unknown",
			error: { detail: { reason: "disconnected" } },
		});
		const server = await counters(run);
		expect(Object.values(server.commands).every((count) => count === 1)).toBe(
			true,
		);
		expect(Object.keys(server.commands)).toHaveLength(5);
	});

	it("closes a stalled socket with 4000 through the application probe and opens exactly one new one (NT-I-04)", async () => {
		const protocol = createTopicProtocol({
			heartbeat: {
				intervalMs: 150,
				timeoutMs: 150,
				frame: () => JSON.stringify({ type: "ping" }),
			},
		});
		const { run, conn, fake } = connect("rate=1000", protocol);
		const a = subscribe(conn, "a");
		await waitFor(async () => (await counters(run)).subscribes.a === 1);
		await control(run, "stall", true);
		await waitFor(
			async () => (await counters(run)).closeCodes.includes(CLOSE_LIVENESS),
			5_000,
		);
		await control(run, "stall", false);
		await waitFor(() => a.record.continuity.length === 2);
		await new Promise((resolve) => setTimeout(resolve, 400));
		const server = await counters(run);
		expect(server.opens).toBe(2);
		expect(server.closeCodes).toEqual([CLOSE_LIVENESS]);
		expect(fake.statuses).toContainEqual(
			expect.objectContaining({
				state: "reconnecting",
				reason: "heartbeat-timeout",
			}),
		);
		expect(
			fake.diagnostics.some((event) => event.type === "heartbeat-missed"),
		).toBe(true);
	});

	it("treats a 401 on upgrade as transient: bounded attempts, then retry-exhausted (NT-I-05)", async () => {
		// Observed on Node 24.14.0: undici's WebSocket sends two upgrade requests
		// for one `new WebSocket()` answered with 401. Measure the client's
		// per-socket count so the assertion is about adapter attempts.
		const probeRun = randomUUID();
		await new Promise<void>((resolve) => {
			const socket = new WebSocket(
				`${wsOrigin}/ws/topics?run=${probeRun}&reject=401`,
			);
			socket.onclose = () => resolve();
		});
		const perSocket = (await counters(probeRun)).upgrades;
		expect(perSocket).toBeGreaterThanOrEqual(1);

		const { run, conn, fake } = connect("reject=401");
		subscribe(conn, "a");
		await waitFor(() => fake.last()?.state === "retry-exhausted", 10_000);
		const closes = fake.diagnostics.filter(
			(event) => event.type === "websocket-close",
		);
		expect(closes).toHaveLength(11);
		expect(closes[0]?.detail).toEqual({ code: 1006, wasClean: false });
		expect((await counters(run)).upgrades).toBe(11 * perSocket);
		expect(fake.states()).not.toContain("auth-blocked");
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect((await counters(run)).upgrades).toBe(11 * perSocket);
	});

	it("authenticates with the first message, never in the URL; a forbidden token fails and an unauthorised socket blocks, neither spinning (NT-I-06)", async () => {
		const good = connect(
			"rate=20",
			createTopicProtocol({ authenticate: true }),
			{},
			"guard=1",
		);
		good.fake.setCredentials(async () => ({
			connectionParams: { token: "valid-s1-1" },
		}));
		const a = subscribe(good.conn, "a");
		await waitFor(() => a.record.events.length >= 1);
		const server = await counters(good.run);
		expect(server.authMessages).toBe(1);
		expect(server.urls.join()).not.toContain("valid");

		// The fixture closes a refused token with 4403, which the harness
		// protocol classifies as forbidden: permanent, nothing rejected.
		const forbidden = connect(
			"rate=20",
			createTopicProtocol({ authenticate: true }),
			{},
			"guard=1",
		);
		forbidden.fake.setCredentials(async () => ({
			connectionParams: { token: "revoked-s1-1" },
		}));
		subscribe(forbidden.conn, "a");
		await waitFor(() => forbidden.fake.last()?.state === "failed");
		expect(forbidden.fake.last()).toEqual({
			state: "failed",
			reason: "permanent-error",
			code: 4403,
		});
		expect(forbidden.fake.rejections()).toBe(0);

		// No authentication frame: the fixture closes 4401, an auth close that
		// blocks; nothing was attached, so nothing is rejected.
		const unauthorised = connect(
			"rate=20",
			createTopicProtocol(),
			{},
			"guard=1",
		);
		subscribe(unauthorised.conn, "a");
		await waitFor(() => unauthorised.fake.last()?.state === "auth-blocked");
		expect(unauthorised.fake.last()).toEqual({
			state: "auth-blocked",
			reason: "credentials-rejected",
			code: "close:4401",
		});
		expect(unauthorised.fake.rejections()).toBe(0);

		await new Promise((resolve) => setTimeout(resolve, 300));
		expect((await counters(forbidden.run)).upgrades).toBe(1);
		expect((await counters(unauthorised.run)).upgrades).toBe(1);
	});

	it("fails only the rejected topic and never resends its subscribe (NT-I-06)", async () => {
		const { run, conn } = connect("rate=20");
		await control(run, "reject-subscribe", { topic: "x" });
		const x = subscribe(conn, "x");
		const a = subscribe(conn, "a");
		await waitFor(
			() => x.record.errors.length === 1 && a.record.events.length >= 2,
		);
		expect(x.record.errors[0]).toMatchObject({
			code: "subscribe-rejected",
			message: "topic not allowed",
		});
		expect(a.record.errors).toEqual([]);
		await control(run, "terminate");
		await waitFor(() => a.record.continuity.length === 2);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect((await counters(run)).subscribes).toEqual({ x: 1, a: 2 });
	});

	it("drops an oversized frame with a gap and keeps the socket open (NT-I-07)", async () => {
		const { run, conn, fake } = connect("rate=30");
		const a = subscribe(conn, "a");
		await waitFor(() => a.record.events.length >= 1);
		await control(run, "emit-oversized", { topic: "a", bytes: 300_000 });
		await waitFor(() => a.record.continuity.length === 1);
		expect(a.record.continuity).toEqual([{ reason: "message-too-large" }]);
		const before = a.record.events.length;
		await waitFor(() => a.record.events.length > before);
		await control(run, "emit-undecodable");
		await waitFor(() => a.record.continuity.length === 2);
		expect(a.record.continuity[1]).toEqual({ reason: "decode-error" });
		const server = await counters(run);
		expect(server.opens).toBe(1);
		expect(server.closeCodes).toEqual([]);
		expect(
			fake.diagnostics.find((event) => event.type === "oversized-frame")
				?.detail,
		).toMatchObject({
			limit: 256 * 1024,
		});
	});
});
