import { expect, test } from "@playwright/test";
import {
	eventCount,
	type HarnessWindow,
	openHarness,
	polling,
	uid,
	waitForEvents,
} from "../fixtures/harness/src/browser-helpers";

// Delivery limits and cleanup are exercised in a real browser.

type W = HarnessWindow;

test("a stalled page overflows while another continues, and resubscribing gets no fresh window", async ({
	browser,
	request,
}) => {
	const context = await browser.newContext();
	const id = uid("stall");
	const limits = JSON.stringify({
		maxPendingMessagesPerConsumer: 2,
		maxPendingMessages: 3,
	});
	const stalled = await openHarness(
		context,
		`limits=${encodeURIComponent(limits)}`,
	);
	await stalled.evaluate(() => (window as unknown as W).harness.create());
	await stalled.evaluate(() => (window as unknown as W).harness.holdAcks(true));
	const healthy = await openHarness(context);
	await healthy.evaluate(() => (window as unknown as W).harness.create());
	for (const page of [stalled, healthy]) {
		await page.evaluate(
			(feed) =>
				(window as unknown as W).harness.subscribe(
					"a",
					{ url: `/poll/value?id=${feed}` },
					{ intervalMs: 1_000 },
				),
			id,
		);
	}
	await expect
		.poll(
			() =>
				stalled.evaluate(() =>
					(window as unknown as W).harness.continuity("a"),
				),
			{ timeout: 15_000 },
		)
		.toMatchObject({ state: "gap", reason: "overflow" });
	expect(await eventCount(stalled, "a")).toBe(2);
	const healthyCount = await eventCount(healthy, "a");
	await waitForEvents(healthy, "a", healthyCount + 2);
	expect(
		await healthy.evaluate(
			() => (window as unknown as W).harness.continuity("a").state,
		),
	).toBe("continuous");
	// Later values never restore continuity without reconciliation.
	expect(
		await stalled.evaluate(
			() => (window as unknown as W).harness.continuity("a").state,
		),
	).toBe("gap");
	// Rotate consumers on the stalled page: its posted debt (2 of 3) remains.
	await stalled.evaluate(() =>
		(window as unknown as W).harness.unsubscribe("a"),
	);
	await stalled.evaluate(
		(feed) =>
			(window as unknown as W).harness.subscribe(
				"b",
				{ url: `/poll/value?id=${feed}` },
				{ intervalMs: 1_000 },
			),
		id,
	);
	await expect
		.poll(
			() =>
				stalled.evaluate(() =>
					(window as unknown as W).harness.continuity("b"),
				),
			{ timeout: 15_000 },
		)
		.toMatchObject({ state: "gap", reason: "overflow" });
	expect(await eventCount(stalled, "b")).toBeLessThanOrEqual(1);
	// Returning: acknowledgements drain the debt, reconciliation restarts delivery.
	await stalled.evaluate(() =>
		(window as unknown as W).harness.holdAcks(false),
	);
	await stalled.evaluate(() => (window as unknown as W).harness.reconcile("b"));
	const resumedFrom = await eventCount(stalled, "b");
	await waitForEvents(stalled, "b", resumedFrom + 2);
	expect(
		await stalled.evaluate(() =>
			(window as unknown as W).harness.continuity("b"),
		),
	).toMatchObject({ state: "continuous", reason: "reconciled" });
	expect((await polling(request, id)).stats.maxInFlight).toBe(1);
	await context.close();
});

const cases: Array<[string, string]> = [
	["backing-buffer", "message-too-large"],
	["undefined-key", "message-too-large"],
	["error-cause", "message-too-large"],
	["array-metadata", "message-too-large"],
	["function", "event-not-serialisable"],
	["proxy", "event-not-serialisable"],
];

test("the real bridge charges cloned size and rejects uncloneable values without breaking delivery", async ({
	page,
}) => {
	await page.goto("/harness/");
	await page.waitForFunction(() => "harness" in window);
	await page.evaluate(() => (window as unknown as W).harness.create());
	for (const [decoder] of cases) {
		await page.evaluate(
			([name, feed]) =>
				(window as unknown as W).harness.subscribe(
					name,
					{ url: `/poll/value?id=${feed}`, decoder: name },
					{ intervalMs: 1_000 },
				),
			[decoder, uid(decoder)] as const,
		);
	}
	await page.evaluate(
		(feed) =>
			(window as unknown as W).harness.subscribe(
				"small-view",
				{ url: `/poll/value?id=${feed}`, decoder: "small-view" },
				{ intervalMs: 1_000 },
			),
		uid("small"),
	);
	await page.evaluate(
		(feed) =>
			(window as unknown as W).harness.subscribe(
				"json",
				{ url: `/poll/value?id=${feed}` },
				{ intervalMs: 1_000 },
			),
		uid("json"),
	);
	for (const [decoder, reason] of cases) {
		await expect
			.poll(
				() =>
					page.evaluate(
						(name) => (window as unknown as W).harness.continuity(name),
						decoder,
					),
				{ timeout: 10_000 },
			)
			.toMatchObject({ state: "gap", reason });
		expect(await eventCount(page, decoder)).toBe(0);
	}
	await waitForEvents(page, "small-view", 2);
	const view = await page.evaluate(() => {
		const data = (window as unknown as W).harness.events("small-view")[0]
			?.data as Uint8Array;
		return { type: Object.prototype.toString.call(data), bytes: [...data] };
	});
	expect(view).toEqual({
		type: "[object Uint8Array]",
		bytes: [1, 2, 3, 4, 5, 6, 7, 8],
	});
	await waitForEvents(page, "json", 3);
	expect(
		await page.evaluate(() => (window as unknown as W).harness.status()),
	).toMatchObject({ mode: "shared", health: "healthy" });
});
