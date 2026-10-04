import { expect, type Page, test } from "@playwright/test";
import {
	type HarnessWindow,
	modes,
	openHarness,
	uid,
	waitForEvents,
} from "../fixtures/harness/src/browser-helpers";

// Shared, local and failed modes exercise the supported fallback reasons.

type W = HarnessWindow;

function localChunkRequests(page: Page): string[] {
	const seen: string[] = [];
	page.on("request", (request) => {
		if (/live\.local-[^/]+\.js$/.test(request.url())) seen.push(request.url());
	});
	return seen;
}

test("shared mode never downloads the local runtime chunk", async ({
	browser,
}) => {
	const context = await browser.newContext();
	const page = await context.newPage();
	const chunks = localChunkRequests(page);
	await page.goto("/harness/");
	await page.waitForFunction(() => "harness" in window);
	await page.evaluate(() => (window as unknown as W).harness.create());
	await page.evaluate(
		(feed) =>
			(window as unknown as W).harness.subscribe(
				"feed",
				{ url: `/poll/value?id=${feed}` },
				{ intervalMs: 1_000 },
			),
		uid("shared-only"),
	);
	await waitForEvents(page, "feed", 1);
	expect(
		await page.evaluate(() => (window as unknown as W).harness.status().mode),
	).toBe("shared");
	expect(chunks).toEqual([]);
	await context.close();
});

test("sharing off runs locally, loading the local chunk once and never constructing a worker", async ({
	browser,
}) => {
	const context = await browser.newContext();
	const page = await context.newPage();
	const chunks = localChunkRequests(page);
	await page.goto("/harness/?sharing=off");
	await page.waitForFunction(() => "harness" in window);
	await page.evaluate(() => (window as unknown as W).harness.create());
	await page.evaluate(
		(feed) =>
			(window as unknown as W).harness.subscribe(
				"feed",
				{ url: `/poll/value?id=${feed}` },
				{ intervalMs: 1_000 },
			),
		uid("off"),
	);
	await waitForEvents(page, "feed", 2);
	expect(
		await page.evaluate(() => (window as unknown as W).harness.status()),
	).toMatchObject({ mode: "local", reason: "sharing-off" });
	expect(
		await page.evaluate(() =>
			(window as unknown as W).harness.workerConstructions(),
		),
	).toBe(0);
	expect(chunks).toHaveLength(1);
	await context.close();
});

const variants: Array<[string, string[]]> = [
	["v0", ["incompatible-version"]],
	["cross-origin", ["worker-construct-failed", "worker-error"]],
	["missing", ["worker-error"]],
];

for (const [variant, reasons] of variants) {
	test(`prefer falls back once to local when the worker is ${variant}`, async ({
		browser,
	}) => {
		const context = await browser.newContext();
		const page = await openHarness(context, `worker=${variant}&handshake=3000`);
		await page.evaluate(() => (window as unknown as W).harness.create());
		await page.evaluate(
			(feed) =>
				(window as unknown as W).harness.subscribe(
					"feed",
					{ url: `/poll/value?id=${feed}` },
					{ intervalMs: 1_000 },
				),
			uid(variant),
		);
		await waitForEvents(page, "feed", 2, 20_000);
		const status = await page.evaluate(() =>
			(window as unknown as W).harness.status(),
		);
		expect(status.mode).toBe("local");
		expect(reasons).toContain(status.reason);
		await page.waitForTimeout(2_000);
		const history = await page.evaluate(() =>
			(window as unknown as W).harness.statusHistory(),
		);
		expect(modes(history)).toEqual(["inactive", "starting", "local"]);
		await context.close();
	});

	test(`require fails without loading local when the worker is ${variant}`, async ({
		browser,
	}) => {
		const context = await browser.newContext();
		const page = await context.newPage();
		const chunks = localChunkRequests(page);
		await page.goto(
			`/harness/?worker=${variant}&sharing=require&handshake=3000`,
		);
		await page.waitForFunction(() => "harness" in window);
		await page.evaluate(() => (window as unknown as W).harness.create());
		await page.evaluate(
			(feed) =>
				(window as unknown as W).harness.subscribe(
					"feed",
					{ url: `/poll/value?id=${feed}` },
					{ intervalMs: 1_000 },
				),
			uid(`${variant}-require`),
		);
		await expect
			.poll(
				() =>
					page.evaluate(() => (window as unknown as W).harness.status().mode),
				{ timeout: 20_000 },
			)
			.toBe("failed");
		const status = await page.evaluate(() =>
			(window as unknown as W).harness.status(),
		);
		expect(reasons).toContain(status.reason);
		expect(status.error).toMatchObject({ code: "sharing-unavailable" });
		expect(chunks).toEqual([]);
		await context.close();
	});
}
