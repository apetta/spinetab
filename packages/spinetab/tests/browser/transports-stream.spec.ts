import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import type { HarnessWindow } from "../fixtures/harness/src/browser-helpers";

// NDJSON over split chunks through the harness, one request for two
// pages sharing a repeatable read, and never-merged non-repeatable POSTs.
// Assumes the core harness exposes `window.harness` with create(options),
// subscribe(name, request), events(name) → [{ data, seq, eventId?, at }] and
// statuses(name), and registers `streamAdapter(streamRuntime)` from
// tests/fixtures/harness/src/adapters/stream.ts (parser "ndjson").

interface StreamCounters {
	requests: Record<string, number>;
	starts: number;
	completed: number;
}

const expected = (count: number) =>
	Array.from({ length: count }, (_, index) => ({
		n: index + 1,
		text: "héllo 🌍 ✓",
	}));

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

async function events(page: Page, name: string): Promise<unknown[]> {
	return page.evaluate(
		(n) =>
			(window as unknown as HarnessWindow).harness
				.events(n)
				.map(({ data }) => data),
		name,
	);
}

async function counters(page: Page, run: string): Promise<StreamCounters> {
	return (await (
		await page.request.get(`/stream/counters?run=${run}`)
	).json()) as StreamCounters;
}

test("NDJSON written one byte at a time arrives as whole frames", async ({
	page,
}) => {
	const run = randomUUID();
	await openHarness(page);
	await page.evaluate(
		(r) =>
			(window as unknown as HarnessWindow).harness.subscribe("lines", {
				adapter: "stream",
				connection: {
					url: `/stream/ndjson?run=${r}&count=6&split=1`,
					parser: "ndjson",
					repeatable: true,
				},
				subscription: {},
				repeatable: true,
			}),
		run,
	);
	await expect
		.poll(async () => (await events(page, "lines")).length, { timeout: 15_000 })
		.toBe(6);
	expect(await events(page, "lines")).toEqual(expected(6));
});

test("two pages share one repeatable read; non-repeatable POSTs are never merged", async ({
	context,
}) => {
	const run = randomUUID();
	const first = await context.newPage();
	const second = await context.newPage();
	await openHarness(first);
	await openHarness(second);
	const read = {
		adapter: "stream",
		connection: {
			url: `/stream/ndjson?run=${run}&count=40&rate=50`,
			parser: "ndjson",
			repeatable: true,
		},
		subscription: {},
		repeatable: true,
	};
	for (const page of [first, second]) {
		await page.evaluate(
			(r) => (window as unknown as HarnessWindow).harness.subscribe("read", r),
			read,
		);
	}
	await expect
		.poll(async () => (await events(second, "read")).length)
		.toBeGreaterThanOrEqual(2);
	expect((await counters(first, run)).requests).toEqual({ GET: 1 });

	const postRun = randomUUID();
	const post = {
		adapter: "stream",
		connection: {
			url: `/stream/ndjson?run=${postRun}&count=3`,
			method: "POST",
			body: '{"prompt":"x"}',
			parser: "ndjson",
		},
		subscription: {},
		repeatable: false,
	};
	for (const page of [first, second]) {
		await page.evaluate(
			(r) => (window as unknown as HarnessWindow).harness.subscribe("post", r),
			post,
		);
	}
	await expect
		.poll(async () => (await counters(first, postRun)).completed)
		.toBe(2);
	expect((await counters(first, postRun)).starts).toBe(2);
	expect(await events(first, "post")).toEqual(expected(3));
});
