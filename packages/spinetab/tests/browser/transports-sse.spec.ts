import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import type {
	HarnessRequest,
	HarnessWindow,
} from "../fixtures/harness/src/browser-helpers";

// Native EventSource cursor behaviour in Chromium, Firefox and
// WebKit through the harness, plus one shared stream for
// two pages selecting different event names.
// Assumes the core harness exposes `window.harness` with create(options),
// subscribe(name, request), events(name) → [{ data, seq, eventId?, at }],
// statuses(name) → SubscriptionStatus[] and unsubscribe(name), and registers
// `sseAdapter(sseRuntime)` from tests/fixtures/harness/src/adapters/sse.ts.

interface RequestRecord {
	method: string;
	lastEventId: string | null;
	lastEventIdQuery: string | null;
}

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

async function eventCount(page: Page, name: string) {
	return page.evaluate(
		(n) => (window as unknown as HarnessWindow).harness.events(n).length,
		name,
	);
}

/** Every continuity the subscription reported, in order (status history). */
async function continuity(page: Page, name: string) {
	return page.evaluate(
		(n) =>
			(window as unknown as HarnessWindow).harness
				.statuses(n)
				.map((status) => status.continuity),
		name,
	);
}

async function requests(page: Page, run: string): Promise<RequestRecord[]> {
	const response = await page.request.get(`/sse/counters?run=${run}`);
	return ((await response.json()) as { requests: RequestRecord[] }).requests;
}

function eventSourceRequest(
	run: string,
	query: string,
	extra: Record<string, unknown> = {},
) {
	return {
		adapter: "sse",
		connection: {
			url: `/sse/ticks?run=${run}&${query}`,
			mode: "eventsource",
			replay: "last-event-id",
			...extra,
		},
		subscription: { event: "tick" },
		repeatable: true,
	};
}

test.describe("native EventSource cursor handling", () => {
	test("the engine's own reconnect sends Last-Event-ID and is reported resumed", async ({
		page,
	}) => {
		const run = randomUUID();
		await openHarness(page);
		await subscribe(
			page,
			"ticks",
			eventSourceRequest(run, "rate=20&resetAfter=3&resetOnce=1&retry=100"),
		);
		await expect
			.poll(async () => (await requests(page, run)).length, { timeout: 15_000 })
			.toBeGreaterThanOrEqual(2);
		expect((await requests(page, run))[1]).toMatchObject({
			lastEventId: "3",
			lastEventIdQuery: null,
		});
		await expect
			.poll(async () =>
				(await continuity(page, "ticks")).some(
					(entry) => entry.state === "resumed",
				),
			)
			.toBe(true);
	});

	test("a recreated EventSource carries the cursor only through the declared query", async ({
		page,
	}) => {
		const run = randomUUID();
		await openHarness(page);
		await subscribe(
			page,
			"ticks",
			eventSourceRequest(
				run,
				"rate=20&resetAfter=3&resetOnce=1&retry=100&failAt=1",
				{
					resume: { query: "lastEventId" },
				},
			),
		);
		await expect
			.poll(async () => (await requests(page, run)).length, { timeout: 20_000 })
			.toBeGreaterThanOrEqual(3);
		const seen = await requests(page, run);
		// Request 1 is the engine's reconnect (500 → CLOSED); request 2 is the
		// adapter's recreation, whose new EventSource has no implicit cursor.
		expect(seen[1]?.lastEventId).toBe("3");
		expect(seen[2]).toMatchObject({ lastEventId: null, lastEventIdQuery: "3" });
		await expect
			.poll(async () =>
				(await continuity(page, "ticks")).some(
					(entry) => entry.state === "resumed",
				),
			)
			.toBe(true);
	});

	test("recreation without a cursor path never claims replay", async ({
		page,
	}) => {
		const run = randomUUID();
		await openHarness(page);
		await subscribe(
			page,
			"ticks",
			eventSourceRequest(
				run,
				"rate=20&resetAfter=3&resetOnce=1&retry=100&failAt=1",
			),
		);
		await expect
			.poll(async () => (await requests(page, run)).length, { timeout: 20_000 })
			.toBeGreaterThanOrEqual(3);
		expect((await requests(page, run))[2]).toMatchObject({
			lastEventId: null,
			lastEventIdQuery: null,
		});
		await expect
			.poll(async () => (await continuity(page, "ticks")).length)
			.toBeGreaterThan(0);
		expect(
			(await continuity(page, "ticks")).some(
				(entry) => entry.state === "resumed",
			),
		).toBe(false);
	});
});

test("two pages selecting different event names share one upstream stream", async ({
	context,
}) => {
	const run = randomUUID();
	const first = await context.newPage();
	const second = await context.newPage();
	await openHarness(first);
	await openHarness(second);
	const connection = {
		url: `/sse/ticks?run=${run}&rate=20&alertEvery=2`,
		mode: "eventsource",
	};
	await subscribe(first, "ticks", {
		adapter: "sse",
		connection,
		subscription: { event: "tick" },
		repeatable: true,
	});
	await subscribe(second, "alerts", {
		adapter: "sse",
		connection,
		subscription: { event: "alert" },
		repeatable: true,
	});
	await expect.poll(() => eventCount(first, "ticks")).toBeGreaterThanOrEqual(3);
	await expect
		.poll(() => eventCount(second, "alerts"))
		.toBeGreaterThanOrEqual(3);
	const counters = (await (
		await first.request.get(`/sse/counters?run=${run}`)
	).json()) as { streams: number };
	expect(counters.streams).toBe(1);
});
