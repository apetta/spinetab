import { randomUUID } from "node:crypto";
import {
	type APIRequestContext,
	expect,
	type Page,
	test,
} from "@playwright/test";
import type {
	HarnessRequest,
	HarnessWindow,
} from "../fixtures/harness/src/browser-helpers";

// Protocol behaviour from the SharedWorker in
// Chromium, Firefox and WebKit. Requires the harness worker to register
// `graphqlWsHarnessAdapter` and `graphqlSseHarnessAdapter`
// (tests/fixtures/harness/src/adapters/graphql-{ws,sse}.ts). Endpoints are
// anonymous so no credential channel is needed.

const TICKS =
	"subscription Ticks($intervalMs: Int) { ticks(intervalMs: $intervalMs) { n } }";

async function openHarness(page: Page) {
	await page.goto("/harness/");
	await page.waitForFunction(
		() =>
			typeof (window as unknown as Partial<HarnessWindow>).harness?.create ===
			"function",
	);
	await page.evaluate(() =>
		(window as unknown as HarnessWindow).harness.create({ sharing: "require" }),
	);
}

async function subscribe(page: Page, name: string, request: HarnessRequest) {
	await page.evaluate(
		([n, r]) =>
			(window as unknown as HarnessWindow).harness.subscribe(
				n as string,
				r as HarnessRequest,
			),
		[name, request as unknown] as const,
	);
}

const eventCount = (page: Page, name: string) =>
	page.evaluate(
		(n) => (window as unknown as HarnessWindow).harness.events(n).length,
		name,
	);

async function counters<T>(
	request: APIRequestContext,
	module: string,
	tag: string,
): Promise<T> {
	const response = await request.get("/__fixture/counters");
	const all = (await response.json()) as Record<
		string,
		{ tags: Record<string, T> }
	>;
	return all[module]?.tags[tag] as T;
}

const tagFor = (prefix: string) =>
	`${prefix}${randomUUID().replace(/-/g, "").slice(0, 12)}`;

test("graphql-ws: two tabs share one worker socket and one upstream operation", async ({
	context,
	request,
}) => {
	const tag = tagFor("bgw");
	const subscription = {
		adapter: "graphql-ws",
		connection: { url: `/graphql-ws?tag=${tag}&anonymous=1`, anonymous: true },
		subscription: { query: TICKS, variables: { intervalMs: 50 } },
	};
	const first = await context.newPage();
	const second = await context.newPage();
	await openHarness(first);
	await openHarness(second);
	await subscribe(first, "feed", subscription);
	await subscribe(second, "feed", subscription);
	await expect.poll(() => eventCount(first, "feed")).toBeGreaterThan(2);
	await expect.poll(() => eventCount(second, "feed")).toBeGreaterThan(2);
	const stats = await counters<{ connections: number; subscriptions: number }>(
		request,
		"graphql-ws",
		tag,
	);
	expect(stats.connections).toBe(1);
	expect(stats.subscriptions).toBe(1);

	await first.evaluate(() =>
		(window as unknown as HarnessWindow).harness.unsubscribe("feed"),
	);
	await second.evaluate(() =>
		(window as unknown as HarnessWindow).harness.unsubscribe("feed"),
	);
	await expect
		.poll(
			async () =>
				(
					await counters<{ activeSubscriptions: number }>(
						request,
						"graphql-ws",
						tag,
					)
				).activeSubscriptions,
		)
		.toBe(0);
});

interface PongCounters {
	connections: number;
	closeCodes: number[];
	pings: number;
	pongs: number;
}

// the one-shot `suppress-pong-once` fault withholds only the
// first pong, so the replacement connection is answered however late the
// runner observes the heartbeat-timeout status. Pongs are counted before they
// are sent, so `pings - pongs` is the number of withheld pongs.
async function missingPongFeed(page: Page, request: APIRequestContext) {
	const tag = tagFor("bgp");
	await request.post("/__fixture/fault", {
		data: {
			target: `graphql-ws@${tag}`,
			action: "suppress-pong-once",
			value: true,
		},
	});
	await openHarness(page);
	await subscribe(page, "feed", {
		adapter: "graphql-ws",
		connection: {
			url: `/graphql-ws?tag=${tag}&anonymous=1`,
			anonymous: true,
			keepAliveMs: 500,
			pongTimeoutMs: 500,
		},
		subscription: { query: TICKS, variables: { intervalMs: 50 } },
	});
	return tag;
}

test("graphql-ws: a missing pong recovers from the SharedWorker with unknown continuity", async ({
	page,
	request,
}) => {
	const tag = await missingPongFeed(page, request);
	await expect
		.poll(() =>
			page.evaluate(() =>
				(window as unknown as HarnessWindow).harness
					.statuses("feed")
					.some((status) => status.connection.reason === "heartbeat-timeout"),
			),
		)
		.toBe(true);
	await expect
		.poll(() =>
			page.evaluate(() =>
				(window as unknown as HarnessWindow).harness
					.statuses("feed")
					.some((status) => status.continuity.state === "unknown"),
			),
		)
		.toBe(true);
	const before = await eventCount(page, "feed");
	await expect.poll(() => eventCount(page, "feed")).toBeGreaterThan(before + 1);
	const stats = await counters<{ connections: number; closeCodes: number[] }>(
		request,
		"graphql-ws",
		tag,
	);
	expect(stats.connections).toBe(2);
	expect(stats.closeCodes).toContain(4499);

	// Control: only the first pong was missing and the replacement answers.
	await expect
		.poll(
			async () =>
				(await counters<PongCounters>(request, "graphql-ws", tag)).pongs,
			{ message: "the replacement connection's ping is answered" },
		)
		.toBeGreaterThanOrEqual(1);
	const control = await counters<PongCounters>(request, "graphql-ws", tag);
	expect(control.pings - control.pongs).toBe(1);
	expect(control.pongs).toBeGreaterThanOrEqual(1);
	expect(control.closeCodes.filter((code) => code === 4499).length).toBe(1);
});

test("graphql-ws: a slow test runner after the first missing pong still sees exactly two connections", async ({
	page,
	request,
}) => {
	const tag = await missingPongFeed(page, request);
	await expect
		.poll(() =>
			page.evaluate(() =>
				(window as unknown as HarnessWindow).harness
					.statuses("feed")
					.some((status) => status.connection.reason === "heartbeat-timeout"),
			),
		)
		.toBe(true);
	// The order that broke the indefinite fault: the replacement has already
	// pinged before the runner looks again.
	await expect
		.poll(
			async () =>
				(await counters<PongCounters>(request, "graphql-ws", tag)).pings,
		)
		.toBeGreaterThanOrEqual(2);
	await expect
		.poll(
			async () =>
				(await counters<PongCounters>(request, "graphql-ws", tag)).pongs,
			{ message: "the replacement connection's ping is answered" },
		)
		.toBeGreaterThanOrEqual(1);
	await expect
		.poll(() =>
			page.evaluate(() =>
				(window as unknown as HarnessWindow).harness
					.statuses("feed")
					.some((status) => status.continuity.state === "unknown"),
			),
		)
		.toBe(true);
	const before = await eventCount(page, "feed");
	await expect.poll(() => eventCount(page, "feed")).toBeGreaterThan(before + 1);
	const stats = await counters<PongCounters>(request, "graphql-ws", tag);
	expect(stats.connections).toBe(2);
	expect(stats.closeCodes).toContain(4499);
	expect(stats.pings - stats.pongs).toBe(1);
	expect(stats.closeCodes.filter((code) => code === 4499).length).toBe(1);
});

interface DelayedPongCounters extends PongCounters {
	active: number;
	delayedPongs: number;
	pongDelays: number[];
	delayedPongsCancelled: number;
}

// the slow-but-healthy control. The one-shot `delay-pong-once`
// fault sends the first pong four seconds late, inside the package's default
// five-second deadline (pongTimeoutMs is deliberately not set), so the shared
// socket must be retained without a timeout or reconnect.
test("graphql-ws: a delayed but timely pong at the default deadline keeps the shared socket", async ({
	page,
	request,
}) => {
	const tag = tagFor("bgd");
	const delayMs = 4_000;
	await request.post("/__fixture/fault", {
		data: {
			target: `graphql-ws@${tag}`,
			action: "delay-pong-once",
			value: delayMs,
		},
	});
	await openHarness(page);
	await subscribe(page, "feed", {
		adapter: "graphql-ws",
		connection: {
			url: `/graphql-ws?tag=${tag}&anonymous=1`,
			anonymous: true,
			keepAliveMs: 500,
		},
		subscription: { query: TICKS, variables: { intervalMs: 50 } },
	});
	const stats = () => counters<DelayedPongCounters>(request, "graphql-ws", tag);

	// The first ping has reached the fixture: the delay window is open.
	await expect
		.poll(async () => (await stats())?.pings ?? 0, {
			message: "the first ping reaches the fixture",
		})
		.toBeGreaterThanOrEqual(1);
	const early = await eventCount(page, "feed");
	await page.waitForTimeout(1_500);
	const mid = await eventCount(page, "feed");
	const inWindow = await stats();
	// Still inside the window: no pong yet and no further ping.
	expect(inWindow.pings).toBe(1);
	expect(inWindow.pongs).toBe(0);
	expect(inWindow.delayedPongs).toBe(0);
	// Delivery continues while the pong is outstanding.
	expect(mid).toBeGreaterThan(early);

	await expect
		.poll(
			async () => {
				const current = await stats();
				return current.delayedPongs + current.delayedPongsCancelled;
			},
			{ timeout: 7_000, message: "the delayed pong is sent" },
		)
		.toBeGreaterThan(0);
	const answered = await stats();
	test.info().annotations.push({
		type: "pong-delay",
		description: `fixture pong delays (ms): ${JSON.stringify(answered.pongDelays)}; cancelled: ${answered.delayedPongsCancelled}`,
	});
	expect(answered.delayedPongsCancelled).toBe(0);
	expect(answered.delayedPongs).toBe(1);
	// Genuinely delayed at the fixture, and before the 5 000 ms deadline.
	expect(answered.pongDelays[0]).toBeGreaterThanOrEqual(delayMs);
	expect(answered.pongDelays[0]).toBeLessThan(5_000);
	expect(answered.connections).toBe(1);
	expect(answered.closeCodes).not.toContain(4499);
	expect(answered.closeCodes).toEqual([]);

	// The next keepAlive ping on the same socket is answered promptly and
	// delivery keeps going.
	const after = await eventCount(page, "feed");
	await expect
		.poll(async () => (await stats()).pongs, {
			message: "the next ping is answered",
		})
		.toBeGreaterThanOrEqual(2);
	await expect.poll(() => eventCount(page, "feed")).toBeGreaterThan(after);

	const observed = await page.evaluate(() => {
		const { harness } = window as unknown as HarnessWindow;
		return {
			disruptions: harness
				.statuses("feed")
				.filter(
					(status) =>
						status.connection.reason === "heartbeat-timeout" ||
						status.connection.state === "reconnecting" ||
						status.continuity.state === "unknown",
				),
			timeouts: harness
				.diagnostics()
				.filter((event) => event.type === "graphql-ws.pong-timeout"),
		};
	});
	expect(observed.disruptions).toEqual([]);
	expect(observed.timeouts).toEqual([]);
	const final = await stats();
	expect(final.connections).toBe(1);
	expect(final.active).toBe(1);
	expect(final.closeCodes).toEqual([]);
	expect(final.delayedPongs).toBe(1);
});

for (const mode of ["distinct", "single"] as const) {
	test(`graphql-sse ${mode}: connection counts follow the declared mode`, async ({
		context,
		request,
	}) => {
		const tag = tagFor(`anon${mode[0]}`);
		const make = (label: string) => ({
			adapter: "graphql-sse",
			connection: { url: `/graphql-sse/${tag}`, mode, anonymous: true },
			subscription: {
				query:
					"subscription T($label: String) { ticks(intervalMs: 50, label: $label) { n label } }",
				variables: { label },
			},
		});
		const first = await context.newPage();
		const second = await context.newPage();
		await openHarness(first);
		await openHarness(second);
		await subscribe(first, "a", make("a"));
		await subscribe(second, "a", make("a"));
		await subscribe(second, "b", make("b"));
		await expect.poll(() => eventCount(first, "a")).toBeGreaterThan(1);
		await expect.poll(() => eventCount(second, "b")).toBeGreaterThan(1);
		const stats = await counters<{
			requests: Record<string, number>;
			streams: number;
		}>(request, "graphql-sse", tag);
		if (mode === "distinct") {
			// One stream per shared identity, not per tab.
			expect(stats.requests).toEqual({ POST: 2 });
			expect(stats.streams).toBe(2);
		} else {
			expect(stats.requests).toEqual({ PUT: 1, GET: 1, POST: 2 });
			expect(stats.streams).toBe(1);
		}
	});
}
