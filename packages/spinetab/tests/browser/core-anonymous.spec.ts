import { expect, type Page, test } from "@playwright/test";
import {
	type HarnessWindow,
	openHarness,
	polling,
	uid,
	waitForEvents,
} from "../fixtures/harness/src/browser-helpers";

// Credential mode participates in sharing identity even when scope and endpoint match.

type W = HarnessWindow;

async function subscribed(page: Page, feed: string) {
	await page.evaluate(() => (window as unknown as W).harness.create());
	await page.evaluate(
		(id) =>
			(window as unknown as W).harness.subscribe(
				"feed",
				{ url: `/poll/value?id=${id}` },
				{ intervalMs: 1_000 },
			),
		feed,
	);
	await waitForEvents(page, "feed", 2, 20_000);
	return page.evaluate(() =>
		(window as unknown as W).harness
			.events("feed")
			.map((event) => event.data as { n: number; scope: string | null }),
	);
}

test("an anonymous tab and a provider tab in one scope make two server connections", async ({
	browser,
	request,
}) => {
	const context = await browser.newContext();
	const id = uid("anon-vs-provider");
	const provider = await openHarness(
		context,
		"scope=erin&credentials=valid&revision=1",
	);
	const anonymous = await openHarness(context, "scope=erin&anonymous=1");
	const [withProvider, withoutProvider] = await Promise.all([
		subscribed(provider, id),
		subscribed(anonymous, id),
	]);
	// Two polling loops on one identity marker: every read increments `n`, so
	// two connections never deliver the same `n` to both tabs.
	const shared = withProvider
		.map((event) => event.n)
		.filter((n) => withoutProvider.some((event) => event.n === n));
	expect(shared).toEqual([]);
	expect(withProvider.every((event) => event.scope === "erin")).toBe(true);
	expect(withoutProvider.every((event) => event.scope !== "erin")).toBe(true);
	const { requests } = await polling(request, id);
	expect(requests.some((entry) => entry.hasAuth)).toBe(true);
	expect(requests.some((entry) => !entry.hasAuth)).toBe(true);
	// The anonymous tab was never asked for credentials.
	expect(
		JSON.stringify(
			await anonymous.evaluate(() =>
				(window as unknown as W).harness.diagnostics(),
			),
		),
	).not.toContain("valid-erin");
	await context.close();
});

test("two anonymous tabs in one scope share one server connection", async ({
	browser,
	request,
}) => {
	const context = await browser.newContext();
	const id = uid("anon-shared");
	const first = await openHarness(context, "scope=erin&anonymous=1");
	const second = await openHarness(context, "scope=erin&anonymous=1");
	const [a, b] = await Promise.all([
		subscribed(first, id),
		subscribed(second, id),
	]);
	const shared = a
		.map((event) => event.n)
		.filter((n) => b.some((event) => event.n === n));
	expect(shared.length).toBeGreaterThan(0);
	const { requests } = await polling(request, id);
	expect(requests.every((entry) => !entry.hasAuth)).toBe(true);
	await context.close();
});
