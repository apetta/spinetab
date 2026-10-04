import { afterEach, describe, expect, it } from "vitest";
import type { AdapterConnection } from "../../../src/core/adapter.ts";
import { graphqlWs } from "../../../src/protocols/graphql-ws/index.ts";
import {
	type GraphqlWsAdapterOptions,
	graphqlWsAdapter,
} from "../../../src/protocols/graphql-ws/runtime.ts";
import type { GraphqlWsTagCounters } from "../../fixtures/servers/graphql-ws.ts";
import {
	clearFault,
	createRecordingSink,
	createTestContext,
	fastRetry,
	primaryOrigin,
	readCounters,
	setFault,
	sleep,
	uniqueTag,
	waitFor,
	wsOrigin,
} from "./helpers.ts";

// Real graphql-ws 6.3.0 client (in the adapter) against the real graphql-ws
// server fixture over Node's native WebSocket. Covers P-I-01…06 and P-I-16.

const TICKS = /* GraphQL */ `
	subscription Ticks($intervalMs: Int, $count: Int, $errorAfter: Int, $partial: Boolean, $label: String) {
		ticks(intervalMs: $intervalMs, count: $count, errorAfter: $errorAfter, partial: $partial, label: $label) { n tag label flaky }
	}
`;

async function tagCounters(tag: string): Promise<GraphqlWsTagCounters> {
	const all = await readCounters<{
		tags: Record<string, GraphqlWsTagCounters>;
	}>("graphql-ws");
	return (
		all.tags[tag] ?? {
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
		}
	);
}

const connections: AdapterConnection[] = [];
afterEach(() => {
	for (const connection of connections.splice(0)) connection.dispose();
});

function setup(
	tag: string,
	options: {
		connection?: Record<string, unknown>;
		adapter?: GraphqlWsAdapterOptions;
		token?: (revision: number) => string;
		anonymous?: boolean;
	} = {},
) {
	const adapter = graphqlWsAdapter({
		retryWait: fastRetry(),
		...options.adapter,
	});
	const spec = {
		url: `${wsOrigin()}/graphql-ws?tag=${tag}`,
		keepAliveMs: 60_000,
		...options.connection,
	};
	adapter.validateConnection?.(spec);
	const test = createTestContext({
		scope: tag,
		credentials: (revision) => ({
			connectionParams: {
				token: options.token?.(revision) ?? `valid-${tag}-${revision}`,
			},
		}),
		limits: { idleCloseMs: 100 },
	});
	const connection = adapter.connect(spec as never, test.ctx);
	connections.push(connection);
	const subscribe = (variables: Record<string, unknown> = {}, extra = {}) => {
		const request = graphqlWs({ url: spec.url }).subscription({
			query: TICKS,
			variables: { intervalMs: 20, ...variables },
			...extra,
		});
		adapter.validateSubscription?.(request.subscription);
		const key = adapter.subscriptionKey?.(request.subscription) ?? "";
		const recording = createRecordingSink<{
			data?: {
				ticks: { n: number; flaky: string | null; label: string | null };
			};
			errors?: unknown[];
		}>();
		const subscription = connection.subscribe(
			request.subscription,
			recording.sink as never,
			{ key, repeatable: true },
		);
		return { recording, subscription, key };
	};
	return { adapter, connection, test, subscribe, spec };
}

describe("graphql-ws adapter against the real server", () => {
	it("shares one lazy socket, preserves fidelity and releases operations (P-I-01)", async () => {
		const tag = uniqueTag("gwa");
		const { subscribe, test } = setup(tag);
		expect((await tagCounters(tag)).connections).toBe(0);

		const first = subscribe(
			{ label: "a" },
			{ operationName: "Ticks", extensions: { trace: "t1" } },
		);
		const second = subscribe({ label: "b" });
		expect(first.key).not.toBe(second.key);

		await waitFor(
			() =>
				first.recording.events.length >= 3 &&
				second.recording.events.length >= 3,
		);
		const counters = await tagCounters(tag);
		expect(counters.connections).toBe(1);
		expect(counters.subscriptions).toBe(2);
		expect(counters.payloads[0]).toMatchObject({
			operationName: "Ticks",
			variables: { intervalMs: 20, label: "a" },
			extensions: { trace: "t1" },
		});
		expect(counters.payloads[0]?.query).toContain("subscription Ticks");
		// Nothing is added beyond what was identified.
		expect(counters.payloads[1]?.operationName).toBeUndefined();
		expect(counters.payloads[1]?.extensions).toBeUndefined();
		expect(first.recording.events[0]?.data?.ticks.label).toBe("a");
		expect(first.recording.started).toBe(1);
		expect(test.hasStatus("connected")).toBe(true);
		expect(test.requests).toEqual(["connect"]);

		first.subscription.unsubscribe();
		second.subscription.unsubscribe();
		await waitFor(
			async () => (await tagCounters(tag)).activeSubscriptions === 0,
		);
		// Lazy close after the idle value (100 ms here) closes the socket.
		await waitFor(async () => (await tagCounters(tag)).active === 0);
		expect(first.recording.completions).toBe(0);
		expect(test.lastStatus()).toMatchObject({
			state: "inactive",
			reason: "idle",
		});
	});

	it("delivers partial data as next, then a terminal GraphQL error and genuine completion (P-I-01)", async () => {
		const tag = uniqueTag("gwb");
		const { subscribe } = setup(tag);
		const partial = subscribe({ partial: true, count: 2 });
		const failing = subscribe({ errorAfter: 1, label: "e" });
		await waitFor(() => partial.recording.completions === 1);
		expect(partial.recording.events).toHaveLength(2);
		const second = partial.recording.events[1];
		expect(second?.data?.ticks.flaky).toBeNull();
		expect(second?.errors?.[0]).toMatchObject({ path: ["ticks", "flaky"] });
		expect(partial.recording.errors).toEqual([]);

		await waitFor(() => failing.recording.errors.length === 1);
		expect(failing.recording.errors[0]).toMatchObject({
			code: "upstream-error",
			detail: { errors: [{ message: "ticks failed after 1 events" }] },
		});
		expect(failing.recording.completions).toBe(0);
		// A terminal operation error is not retried: one subscribe per identity.
		await sleep(150);
		expect((await tagCounters(tag)).subscriptions).toBe(2);
	});

	it("recovers a dropped TCP connection through the upstream loop (P-I-01)", async () => {
		const tag = uniqueTag("gwc");
		const { subscribe, test } = setup(tag);
		const feed = subscribe();
		await waitFor(() => feed.recording.events.length >= 2);
		await fetch(`${primaryOrigin()}/graphql-ws/control/terminate?tag=${tag}`, {
			method: "POST",
		});
		await waitFor(() => feed.recording.continuity.length >= 1);
		const before = feed.recording.events.length;
		await waitFor(() => feed.recording.events.length > before + 1);
		const counters = await tagCounters(tag);
		expect(counters.connections).toBe(2);
		expect(counters.subscriptions).toBe(2);
		// Once at detection, then the reconnect outcome.
		expect(feed.recording.continuity).toEqual([
			{ reason: "reconnected" },
			{ reason: "reconnected" },
		]);
		expect(test.hasStatus("reconnecting")).toBe(true);
		expect(test.lastStatus()?.state).toBe("connected");
		expect(test.requests).toEqual(["connect", "reconnect"]);
	});

	it("terminates on a missing pong (4499), reconnects and resubscribes once per identity (P-I-02)", async () => {
		const tag = uniqueTag("gwd");
		// One-shot fault: only the first pong is withheld, so
		// the replacement is answered however late this test observes the status.
		await setFault(`graphql-ws@${tag}`, "suppress-pong-once");
		const { subscribe, test } = setup(tag, {
			connection: { keepAliveMs: 150, pongTimeoutMs: 150 },
		});
		const one = subscribe({ label: "one" });
		const two = subscribe({ label: "two" });
		await waitFor(
			() => test.hasStatus("reconnecting", { reason: "heartbeat-timeout" }),
			{
				message: "heartbeat-timeout status",
			},
		);
		// Continuity is reported when the missed pong is detected,
		// before the replacement connection is acknowledged.
		await waitFor(
			() =>
				one.recording.continuity.length >= 1 &&
				two.recording.continuity.length >= 1,
			{ message: "continuity at detection" },
		);
		await waitFor(() => test.lastStatus()?.state === "connected", {
			message: "connected after reconnect",
		});
		const counters = await tagCounters(tag);
		expect(counters.connections).toBe(2);
		// Upstream re-sends each active Subscribe once; Spinetab adds none.
		expect(counters.subscriptions).toBe(4);
		expect(counters.closeCodes).toContain(4499);
		// The reconnect outcome follows the early notice.
		for (const feed of [one, two]) {
			expect(feed.recording.continuity).toEqual([
				{ reason: "reconnected" },
				{ reason: "reconnected" },
			]);
		}
		expect(one.recording.completions + two.recording.completions).toBe(0);
		// A healthy feed with answered pings stays connected.
		const pongsBefore = (await tagCounters(tag)).pongs;
		await waitFor(async () => (await tagCounters(tag)).pongs > pongsBefore + 1);
		expect((await tagCounters(tag)).connections).toBe(2);
	});

	it("keeps the socket through a delayed but timely pong at the default deadline (P-I-16)", async ({
		annotate,
	}) => {
		const tag = uniqueTag("gwj");
		const delayMs = 4_000;
		// Slow but healthy server: only the first pong is
		// sent late, still inside the package's default five-second deadline.
		await setFault(`graphql-ws@${tag}`, "delay-pong-once", delayMs);
		// A short keepAlive sends the first ping promptly; pongTimeoutMs is
		// deliberately not passed, so GRAPHQL_WS_DEFAULTS.pongTimeoutMs applies.
		const { subscribe, test } = setup(tag, {
			connection: { keepAliveMs: 300 },
		});
		const one = subscribe({ label: "one" });
		const two = subscribe({ label: "two" });
		const counts = () => [
			one.recording.events.length,
			two.recording.events.length,
		];

		// The first ping has reached the fixture: the delay window is open.
		await waitFor(async () => (await tagCounters(tag)).pings >= 1, {
			message: "first ping received",
		});
		const early = counts();
		await sleep(1_500);
		const mid = counts();
		const inWindow = await tagCounters(tag);
		// Still inside the window: the pong has not been sent yet, and upstream
		// schedules its next keepAlive ping only after a pong arrives.
		expect(inWindow.pings).toBe(1);
		expect(inWindow.pongs).toBe(0);
		expect(inWindow.delayedPongs).toBe(0);
		// Delivery continues while the pong is outstanding, on both operations.
		expect(mid[0]).toBeGreaterThan(early[0] ?? 0);
		expect(mid[1]).toBeGreaterThan(early[1] ?? 0);

		// The delayed pong is sent, or (negative control) the deadline fires.
		await waitFor(
			async () => {
				const counters = await tagCounters(tag);
				return (
					counters.delayedPongs > 0 ||
					counters.delayedPongsCancelled > 0 ||
					test.hasStatus("reconnecting")
				);
			},
			{ timeout: 7_000, interval: 50, message: "delayed pong or timeout" },
		);
		const answered = await tagCounters(tag);
		await annotate(
			`fixture pong delays (ms): ${JSON.stringify(answered.pongDelays)}; cancelled: ${answered.delayedPongsCancelled}`,
			"pong-delay",
		);
		// No watchdog timeout, reconnect or replacement socket.
		expect(
			test.statuses.filter(
				(status) =>
					status.reason === "heartbeat-timeout" ||
					status.state === "reconnecting",
			),
		).toEqual([]);
		expect(
			test.diagnostics.filter(
				(event) => event.type === "graphql-ws.pong-timeout",
			),
		).toEqual([]);
		expect(answered.delayedPongsCancelled).toBe(0);
		expect(answered.delayedPongs).toBe(1);
		// Genuinely delayed at the fixture, and before the 5 000 ms deadline.
		expect(answered.pongDelays[0]).toBeGreaterThanOrEqual(delayMs);
		expect(answered.pongDelays[0]).toBeLessThan(5_000);
		expect(answered.connections).toBe(1);
		expect(answered.closeCodes).toEqual([]);

		// The next keepAlive ping on the same socket is answered promptly.
		const after = counts();
		await waitFor(async () => (await tagCounters(tag)).pongs >= 2, {
			timeout: 3_000,
			message: "next ping answered",
		});
		await waitFor(() => {
			const now = counts();
			return (now[0] ?? 0) > (after[0] ?? 0) && (now[1] ?? 0) > (after[1] ?? 0);
		});
		const final = await tagCounters(tag);
		expect(final.connections).toBe(1);
		expect(final.active).toBe(1);
		expect(final.closeCodes).toEqual([]);
		expect(final.subscriptions).toBe(2);
		expect(final.delayedPongs).toBe(1);
		expect(test.hasStatus("reconnecting")).toBe(false);
		expect(test.lastStatus()?.state).toBe("connected");
		expect(one.recording.continuity).toEqual([]);
		expect(two.recording.continuity).toEqual([]);
		expect(one.recording.errors).toEqual([]);
		expect(two.recording.errors).toEqual([]);
	});

	it("blocks a genuine 4401 with exactly one attempt per revision, then resumes on rotation (P-I-03)", async () => {
		const tag = uniqueTag("gwe");
		const { subscribe, test, connection } = setup(tag, {
			token: (revision) =>
				revision === 1 ? `revoked-${tag}-1` : `valid-${tag}-${revision}`,
		});
		const feed = subscribe();
		await waitFor(() => test.hasStatus("auth-blocked"));
		expect(test.lastStatus()).toMatchObject({
			state: "auth-blocked",
			reason: "credentials-rejected",
			code: "close:4401",
		});
		expect(test.rejections).toEqual([1]);
		await sleep(300);
		let counters = await tagCounters(tag);
		expect(counters.inits).toBe(1);
		expect(counters.authFailures).toBe(1);

		// An explicit retry with the rejected revision makes no attempt.
		connection.retry?.();
		await sleep(150);
		expect((await tagCounters(tag)).inits).toBe(1);
		expect(test.lastStatus()?.reason).toBe("credentials-rejected");

		test.setRevision(2);
		connection.rotate?.();
		await waitFor(() => feed.recording.events.length >= 2);
		counters = await tagCounters(tag);
		expect(counters.inits).toBe(2);
		expect(counters.tokens).toEqual([`revoked-${tag}-1`, `valid-${tag}-2`]);
		expect(feed.recording.errors).toEqual([]);
	});

	it("reports 4429 as failed/protocol-error and 4403 as failed/forbidden, neither retried nor rejecting (P-I-04)", async () => {
		const tooMany = uniqueTag("gwf");
		await setFault(`graphql-ws@${tooMany}`, "close-code", 4429);
		const a = setup(tooMany);
		const feedA = a.subscribe();
		await waitFor(() => a.test.hasStatus("failed"));
		expect(a.test.lastStatus()).toMatchObject({
			state: "failed",
			reason: "protocol-error",
			code: "close:4429",
		});
		const forbidden = uniqueTag("gwg");
		await setFault(`graphql-ws@${forbidden}`, "close-code", 4403);
		const b = setup(forbidden);
		b.subscribe();
		await waitFor(() => b.test.hasStatus("failed"));
		expect(b.test.lastStatus()).toMatchObject({
			state: "failed",
			reason: "permanent-error",
			code: "forbidden",
		});
		expect(b.test.rejectCalls).toEqual([]);
		await sleep(300);
		expect((await tagCounters(tooMany)).inits).toBe(1);
		expect((await tagCounters(forbidden)).inits).toBe(1);
		expect(feedA.recording.errors).toEqual([]);
		expect(feedA.recording.completions).toBe(0);
	});

	it("exhausts the retry budget keeping intent, then an explicit retry recreates the client (P-I-05)", async () => {
		const tag = uniqueTag("gwh");
		await setFault(`graphql-ws@${tag}`, "close-code", 4000);
		const { subscribe, test, connection } = setup(tag, {
			connection: { retryAttempts: 2 },
		});
		const feed = subscribe();
		await waitFor(() => test.hasStatus("retry-exhausted"));
		expect(test.lastStatus()).toMatchObject({
			state: "retry-exhausted",
			reason: "attempts-exhausted",
			code: "close:4000",
		});
		await sleep(200);
		expect((await tagCounters(tag)).inits).toBe(3);
		expect(feed.recording.errors).toEqual([]);

		await clearFault(`graphql-ws@${tag}`, "close-code");
		connection.retry?.();
		await waitFor(() => feed.recording.events.length >= 2);
		const counters = await tagCounters(tag);
		expect(counters.inits).toBe(4);
		expect(counters.subscriptions).toBe(1);
		const tail = test.statuses.slice(-2).map((status) => status.state);
		expect(tail).toEqual(["connecting", "connected"]);
		expect(test.requests.at(-1)).toBe("retry");
	});

	it("bounds the acknowledgement wait: connecting → reconnecting close:4504 (P-I-06)", async () => {
		const tag = uniqueTag("gwi");
		await setFault(`graphql-ws@${tag}`, "withhold-ack");
		const { subscribe, test } = setup(tag, {
			connection: { connectionAckWaitTimeoutMs: 200, retryAttempts: 1 },
		});
		subscribe();
		await waitFor(() => test.hasStatus("retry-exhausted"), { timeout: 5_000 });
		expect(test.statuses.map((status) => status.state)).toEqual([
			"connecting",
			"reconnecting",
			"reconnecting",
			"retry-exhausted",
		]);
		expect(test.statuses[1]).toMatchObject({ code: "close:4504" });
		expect(test.lastStatus()).toMatchObject({ code: "close:4504" });
		expect((await tagCounters(tag)).inits).toBe(2);
	});
});
