import { expect, test } from "@playwright/test";
import {
	type HarnessWindow,
	openHarness,
	polling,
	setFault,
	uid,
	waitForEvents,
} from "../fixtures/harness/src/browser-helpers";

// (scope changes fence old events, replies and credentials).

type W = HarnessWindow;

test("credentials are brokered to another page in the scope when the asked page does not answer", async ({
	browser,
	request,
}) => {
	const context = await browser.newContext();
	const id = uid("broker");
	const helper = await openHarness(
		context,
		"scope=carol&credentials=valid&revision=1",
	);
	await helper.evaluate(() => (window as unknown as W).harness.create());
	const asker = await openHarness(
		context,
		"scope=carol&credentials=hang&revision=1",
	);
	await asker.evaluate(() => (window as unknown as W).harness.create());
	await asker.evaluate(
		(feed) =>
			(window as unknown as W).harness.subscribe(
				"feed",
				{ url: `/poll/value?id=${feed}&guard=required` },
				{ intervalMs: 1_000 },
			),
		id,
	);
	await waitForEvents(asker, "feed", 1, 20_000);
	const first = await asker.evaluate(
		() =>
			(window as unknown as W).harness.events("feed")[0]?.data as {
				scope: string;
			},
	);
	expect(first.scope).toBe("carol");
	const { requests } = await polling(request, id);
	expect(requests.length).toBeGreaterThanOrEqual(1);
	expect(requests.every((entry) => entry.hasAuth && entry.status === 200)).toBe(
		true,
	);
	expect(
		JSON.stringify(
			await asker.evaluate(() =>
				(window as unknown as W).harness.diagnostics(),
			),
		),
	).not.toContain("valid-carol");
	await context.close();
});

test("a rejected revision blocks without spinning and a newer revision recovers", async ({
	browser,
	request,
}) => {
	const context = await browser.newContext();
	const id = uid("revoked");
	const page = await openHarness(
		context,
		"scope=dave&credentials=revoked&revision=1",
	);
	await page.evaluate(() => (window as unknown as W).harness.create());
	await page.evaluate(
		(feed) =>
			(window as unknown as W).harness.subscribe(
				"feed",
				{ url: `/poll/value?id=${feed}&guard=required` },
				{ intervalMs: 1_000 },
			),
		id,
	);
	await expect
		.poll(
			() =>
				page.evaluate(
					() =>
						(window as unknown as W).harness.subscriptionStatus("feed")
							.connection,
				),
			{ timeout: 10_000 },
		)
		.toMatchObject({
			state: "auth-blocked",
			reason: "credentials-rejected",
			code: "http:401",
		});
	await page.waitForTimeout(3_000);
	expect((await polling(request, id)).stats.requests).toBe(1);
	await page.evaluate(() =>
		(window as unknown as W).harness.setCredentialMode("valid"),
	);
	await page.evaluate(() => (window as unknown as W).harness.setRevision(2));
	await waitForEvents(page, "feed", 1, 10_000);
	expect(
		await page.evaluate(
			() =>
				(window as unknown as W).harness.subscriptionStatus("feed").connection
					.state,
		),
	).toBe("connected");
	expect(
		await page.evaluate(() => (window as unknown as W).harness.status().mode),
	).toBe("shared");
	await context.close();
});

test("a scope change fences old-scope reads, results and credentials, including a change back", async ({
	browser,
	request,
}) => {
	const context = await browser.newContext();
	const id = uid("scope-race");
	await setFault(request, "delay-ms", { id, ms: 1_500 });
	try {
		const page = await openHarness(
			context,
			"scope=alice&credentials=valid&revision=1",
		);
		await page.evaluate(() => (window as unknown as W).harness.create());
		await page.evaluate(
			(feed) =>
				(window as unknown as W).harness.subscribe(
					"feed",
					{ url: `/poll/value?id=${feed}&guard=required` },
					{ intervalMs: 1_000 },
				),
			id,
		);
		await expect
			.poll(async () => (await polling(request, id)).stats.inFlight, {
				timeout: 10_000,
			})
			.toBe(1);
		const changedAt = await page.evaluate(() => {
			(window as unknown as W).harness.setScope("bob");
			return Date.now();
		});
		await waitForEvents(page, "feed", 1, 15_000);
		const afterBob = await page.evaluate(() =>
			(window as unknown as W).harness.events("feed").map((event) => ({
				scope: (event.data as { scope: string }).scope,
				at: event.at,
			})),
		);
		expect(
			afterBob.every((event) => event.scope === "bob" && event.at >= changedAt),
		).toBe(true);
		const { requests } = await polling(request, id);
		expect(requests[0]).toMatchObject({ scope: "alice", aborted: true });
		expect(
			await page.evaluate(() =>
				(window as unknown as W).harness.continuity("feed"),
			),
		).toMatchObject({ state: "unknown", reason: "scope-changed" });
		// A → B → A: the change back is a new attachment, so queued bob results
		// never reach the new alice session.
		await expect
			.poll(async () => (await polling(request, id)).stats.inFlight, {
				timeout: 10_000,
			})
			.toBe(1);
		const backAt = await page.evaluate(() => {
			(window as unknown as W).harness.setScope("alice");
			return Date.now();
		});
		const count = afterBob.length;
		await waitForEvents(page, "feed", count + 1, 15_000);
		const later = await page.evaluate(() =>
			(window as unknown as W).harness.events("feed").map((event) => ({
				scope: (event.data as { scope: string }).scope,
				at: event.at,
			})),
		);
		expect(
			later
				.filter((event) => event.at >= backAt)
				.every((event) => event.scope === "alice"),
		).toBe(true);
		expect(
			await page.evaluate(
				() => (window as unknown as W).harness.status().generation,
			),
		).toBe(3);
	} finally {
		await setFault(request, "delay-ms", null);
		await context.close();
	}
});
