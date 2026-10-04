import { expect, test } from "@playwright/test";
import {
	type HarnessWindow,
	modes,
	openHarness,
	polling,
	uid,
	waitForEvents,
} from "../fixtures/harness/src/browser-helpers";

// Fault injection is
// proved by a changed runtime id, the status history and server counters.

type W = HarnessWindow;
const fast = "heartbeat=1000&probe=1000&handshake=2000";

test("a crashed worker is replaced: intent re-registered once, continuity unknown, mode stays shared", async ({
	browser,
	request,
}) => {
	const context = await browser.newContext();
	const id = uid("crash");
	const page = await openHarness(context, fast);
	await page.evaluate(() => (window as unknown as W).harness.create());
	await page.evaluate(
		(feed) =>
			(window as unknown as W).harness.subscribe(
				"feed",
				{ url: `/poll/value?id=${feed}` },
				{ intervalMs: 1_000 },
			),
		id,
	);
	await waitForEvents(page, "feed", 2);
	const before = await page.evaluate(() =>
		(window as unknown as W).harness.status(),
	);
	await page.evaluate(() => (window as unknown as W).harness.crashWorker());
	await expect
		.poll(
			() => page.evaluate(() => (window as unknown as W).harness.status()),
			{ timeout: 15_000 },
		)
		.toMatchObject({ mode: "shared", health: "healthy" });
	await expect
		.poll(
			() =>
				page.evaluate(
					() => (window as unknown as W).harness.status().runtimeId,
				),
			{ timeout: 15_000 },
		)
		.not.toBe(before.runtimeId);
	const count = await page.evaluate(
		() => (window as unknown as W).harness.events("feed").length,
	);
	await waitForEvents(page, "feed", count + 2);
	expect(
		await page.evaluate(() =>
			(window as unknown as W).harness.continuity("feed"),
		),
	).toMatchObject({ state: "unknown", reason: "runtime-replaced" });
	const history = await page.evaluate(() =>
		(window as unknown as W).harness.statusHistory(),
	);
	expect(modes(history)).toEqual(["inactive", "starting", "shared"]);
	expect(history.some((status) => status.health === "reattaching")).toBe(true);
	expect(
		await page.evaluate(() =>
			(window as unknown as W).harness.workerConstructions(),
		),
	).toBe(2);
	// Exactly one schedule after re-registration (not duplicated).
	const start = (await polling(request, id)).stats.requests;
	await page.waitForTimeout(3_000);
	expect(
		(await polling(request, id)).stats.requests - start,
	).toBeLessThanOrEqual(4);
	await context.close();
});

test("a hung worker ends in startup-timeout: prefer falls back to local once and never oscillates", async ({
	browser,
	request,
}) => {
	const context = await browser.newContext();
	const id = uid("hang");
	const page = await openHarness(context, fast);
	await page.evaluate(() => (window as unknown as W).harness.create());
	await page.evaluate(
		(feed) =>
			(window as unknown as W).harness.subscribe(
				"feed",
				{ url: `/poll/value?id=${feed}` },
				{ intervalMs: 1_000 },
			),
		id,
	);
	await waitForEvents(page, "feed", 1);
	await page.evaluate(() =>
		(window as unknown as W).harness.hangWorker(10_000),
	);
	await expect
		.poll(
			() => page.evaluate(() => (window as unknown as W).harness.status()),
			{ timeout: 20_000 },
		)
		.toMatchObject({
			mode: "local",
			reason: "startup-timeout",
			health: "healthy",
		});
	const count = await page.evaluate(
		() => (window as unknown as W).harness.events("feed").length,
	);
	await waitForEvents(page, "feed", count + 2);
	// After the hang ends the old worker processes the queued detach; the page
	// stays local and one schedule remains.
	await page.waitForTimeout(8_000);
	const history = await page.evaluate(() =>
		(window as unknown as W).harness.statusHistory(),
	);
	expect(modes(history)).toEqual(["inactive", "starting", "shared", "local"]);
	expect(
		await page.evaluate(() =>
			(window as unknown as W).harness.workerConstructions(),
		),
	).toBe(2);
	const start = (await polling(request, id)).stats.requests;
	await page.waitForTimeout(3_000);
	expect(
		(await polling(request, id)).stats.requests - start,
	).toBeLessThanOrEqual(4);
	await context.close();
});

test("a hung worker under require-sharing fails with sharing-unavailable", async ({
	browser,
}) => {
	const context = await browser.newContext();
	const page = await openHarness(context, `${fast}&sharing=require`);
	await page.evaluate(() => (window as unknown as W).harness.create());
	await page.evaluate(
		(feed) =>
			(window as unknown as W).harness.subscribe(
				"feed",
				{ url: `/poll/value?id=${feed}` },
				{ intervalMs: 1_000 },
			),
		uid("require-hang"),
	);
	await waitForEvents(page, "feed", 1);
	await page.evaluate(() => (window as unknown as W).harness.hangWorker(8_000));
	await expect
		.poll(
			() => page.evaluate(() => (window as unknown as W).harness.status()),
			{ timeout: 20_000 },
		)
		.toMatchObject({
			mode: "failed",
			reason: "startup-timeout",
			error: { code: "sharing-unavailable" },
		});
	expect(
		await page.evaluate(() => (window as unknown as W).harness.errors("feed")),
	).toEqual([expect.objectContaining({ code: "sharing-unavailable" })]);
	await context.close();
});
