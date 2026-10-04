import { expect, test } from "@playwright/test";
import {
	type HarnessWindow,
	openHarness,
	polling,
	uid,
	waitForEvents,
} from "../fixtures/harness/src/browser-helpers";

// Loopback endpoints count as the worker's own origin; these cases cover header attachment, not cross-origin refusal.

type W = HarnessWindow;

test("a same-origin poll carries the provider's bearer header (auto)", async ({
	browser,
	request,
}) => {
	const context = await browser.newContext();
	const id = uid("w4-same");
	const page = await openHarness(
		context,
		"scope=carol&credentials=valid&revision=1",
	);
	await page.evaluate(() => (window as unknown as W).harness.create());
	await page.evaluate(
		(feed) =>
			(window as unknown as W).harness.subscribe("feed", {
				url: `/poll/value?id=${feed}`,
			}),
		id,
	);
	await waitForEvents(page, "feed", 1, 20_000);
	const { requests } = await polling(request, id);
	expect(requests.length).toBeGreaterThanOrEqual(1);
	expect(requests.every((entry) => entry.hasAuth)).toBe(true);
	await context.close();
});
