import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import type { HarnessWindow } from "../fixtures/harness/src/browser-helpers";

// WebSocket text and binary fan-out to two pages over one shared
// socket, with command replies only at the issuer.
// Assumes the core harness exposes `window.harness` with create(options),
// subscribe(name, request), events(name) → [{ data, seq, eventId?, at }],
// command(request) → CommandOutcome and unsubscribe(name), and registers
// `websocketAdapter(websocketRuntime)` from
// tests/fixtures/harness/src/adapters/websocket.ts (protocol "topics").

interface WsCounters {
	opens: number;
	active: number;
	subscribes: Record<string, number>;
	unsubscribes: Record<string, number>;
	commands: Record<string, number>;
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

/** Events as JSON-safe values: binary frames become byte arrays in the page. */
async function events(page: Page, name: string): Promise<unknown[]> {
	return page.evaluate((n) => {
		return (window as unknown as HarnessWindow).harness
			.events(n)
			.map(({ data }) =>
				data instanceof ArrayBuffer
					? { bytes: Array.from(new Uint8Array(data)) }
					: data,
			);
	}, name);
}

async function counters(page: Page, run: string): Promise<WsCounters> {
	return (await (
		await page.request.get(`/ws/counters?run=${run}`)
	).json()) as WsCounters;
}

test("text and binary events fan out to two pages over one socket", async ({
	context,
}) => {
	const run = randomUUID();
	const connection = {
		url: `/ws/topics?run=${run}&rate=30`,
		protocol: "topics",
	};
	const request = (topic: string) => ({
		adapter: "websocket",
		connection,
		subscription: { topic },
	});
	const first = await context.newPage();
	const second = await context.newPage();
	await openHarness(first);
	await openHarness(second);
	for (const page of [first, second]) {
		await page.evaluate(
			(r) => (window as unknown as HarnessWindow).harness.subscribe("text", r),
			request("a"),
		);
		await page.evaluate(
			(r) =>
				(window as unknown as HarnessWindow).harness.subscribe("binary", r),
			request("binary"),
		);
	}
	await expect
		.poll(async () => (await events(first, "binary")).length)
		.toBeGreaterThanOrEqual(3);
	await expect
		.poll(async () => (await events(second, "binary")).length)
		.toBeGreaterThanOrEqual(3);
	await expect
		.poll(async () => (await events(second, "text")).length)
		.toBeGreaterThanOrEqual(3);

	const server = await counters(first, run);
	expect(server.opens).toBe(1);
	expect(server.subscribes).toEqual({ a: 1, binary: 1 });

	const firstBinary = (await events(first, "binary")) as Array<{
		bytes: number[];
	}>;
	const secondBinary = (await events(second, "binary")) as Array<{
		bytes: number[];
	}>;
	expect(firstBinary[0]?.bytes.slice(1)).toEqual([1, 2, 3]);
	// Byte-identical at each consumer: compare frames by sequence byte.
	const bySeq = new Map(
		firstBinary.map((frame) => [frame.bytes[0], frame.bytes.join()]),
	);
	for (const frame of secondBinary) {
		const match = bySeq.get(frame.bytes[0]);
		if (match) expect(frame.bytes.join()).toBe(match);
	}
	const text = (await events(first, "text")) as Array<{
		seq: number;
		text: string;
	}>;
	expect(text[0]?.text).toBe("héllo 🌍");

	const outcome = await first.evaluate(
		(c) =>
			(window as unknown as HarnessWindow).harness.command({
				adapter: "websocket",
				connection: c,
				payload: { data: { op: "x" } },
			}),
		connection,
	);
	expect(outcome).toMatchObject({
		status: "acknowledged",
		value: { echo: { op: "x" } },
	});
	expect(Object.values((await counters(first, run)).commands)).toEqual([1]);

	await first.evaluate(() =>
		(window as unknown as HarnessWindow).harness.unsubscribe("text"),
	);
	await second.evaluate(() =>
		(window as unknown as HarnessWindow).harness.unsubscribe("text"),
	);
	await expect
		.poll(async () => (await counters(first, run)).unsubscribes.a ?? 0)
		.toBe(1);
});
