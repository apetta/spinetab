import { expect, test } from "@playwright/test";
import {
	type HarnessWindow,
	openHarness,
	polling,
	uid,
	waitForEvents,
} from "../fixtures/harness/src/browser-helpers";

// Sharing is proved by server-counted requests, not UI messages.

type W = HarnessWindow;

for (const count of [1, 2, 5]) {
	test(`${count} page(s) in one context share one polling schedule`, async ({
		browser,
		request,
	}) => {
		const context = await browser.newContext();
		const id = uid(`share-${count}`);
		const pages = [];
		for (let index = 0; index < count; index += 1) {
			const page = await openHarness(context);
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
			pages.push(page);
		}
		const first = pages[0];
		if (!first) throw new Error("no page");
		await waitForEvents(first, "feed", 2);
		const before = (await polling(request, id)).stats.requests;
		await first.waitForTimeout(4_000);
		const { stats } = await polling(request, id);
		// One schedule at 1 s: about 4 reads in 4 s whatever the page count.
		expect(stats.requests - before).toBeGreaterThanOrEqual(3);
		expect(stats.requests - before).toBeLessThanOrEqual(5);
		expect(stats.maxInFlight).toBe(1);
		const statuses = await Promise.all(
			pages.map((page) =>
				page.evaluate(() => (window as unknown as W).harness.status()),
			),
		);
		expect(
			statuses.every(
				(status) => status.mode === "shared" && status.health === "healthy",
			),
		).toBe(true);
		expect(new Set(statuses.map((status) => status.runtimeId)).size).toBe(1);
		const lastValues = await Promise.all(
			pages.map((page) =>
				page.evaluate(
					() =>
						(
							(window as unknown as W).harness.events("feed").at(-1)?.data as
								| { n: number }
								| undefined
						)?.n ?? 0,
				),
			),
		);
		expect(
			Math.max(...lastValues) - Math.min(...lastValues),
		).toBeLessThanOrEqual(1);
		await context.close();
	});
}

test("independent browser contexts run independent runtimes", async ({
	browser,
	request,
}) => {
	const id = uid("contexts");
	const contexts = [await browser.newContext(), await browser.newContext()];
	const pages = [];
	for (const context of contexts) {
		const page = await openHarness(context);
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
		pages.push(page);
	}
	await waitForEvents(pages[0] as never, "feed", 2);
	await waitForEvents(pages[1] as never, "feed", 2);
	const before = (await polling(request, id)).stats.requests;
	await pages[0]?.waitForTimeout(4_000);
	const delta = (await polling(request, id)).stats.requests - before;
	expect(delta).toBeGreaterThanOrEqual(6);
	const runtimes = await Promise.all(
		pages.map((page) =>
			page.evaluate(() => (window as unknown as W).harness.status().runtimeId),
		),
	);
	expect(runtimes[0]).not.toBe(runtimes[1]);
	for (const context of contexts) await context.close();
});

// Run with the test's shortened heartbeat and with package defaults (20 s
// heartbeat, 180 s lease). WebKit (native repro BR-NT-0) re-initialises the
// SharedWorker when its first client page closes and reconnects the
// survivor's port to the new instance; the new runtime announces itself on
// that port and the survivor reattaches at once (contract decision: prompt
// recovery). At package defaults recovery must be prompt in every engine:
// the first event served by the final runtime arrives within
// RECOVERY_BOUND_MS of the closure. The shortened-heartbeat run is kept as
// evidence only (recorded, not bounded).
const RECOVERY_BOUND_MS = 2_000;
const closureTimings = [
	{
		label: "test heartbeat 2 s",
		query: "heartbeat=2000",
		waitMs: 20_000,
		bounded: false,
	},
	{ label: "package defaults", query: "", waitMs: 50_000, bounded: true },
] as const;

for (const timing of closureTimings) {
	test(`closing the tab that started the work keeps other tabs served, honestly reporting any replacement (${timing.label})`, async ({
		browser,
		request,
	}, testInfo) => {
		test.setTimeout(timing.waitMs + 40_000);
		const context = await browser.newContext();
		const id = uid("original");
		const original = await openHarness(context, timing.query);
		await original.evaluate(() => (window as unknown as W).harness.create());
		await original.evaluate(
			(feed) =>
				(window as unknown as W).harness.subscribe(
					"feed",
					{ url: `/poll/value?id=${feed}` },
					{ intervalMs: 1_000 },
				),
			id,
		);
		const other = await openHarness(context, timing.query);
		await other.evaluate(() => (window as unknown as W).harness.create());
		await other.evaluate(
			(feed) =>
				(window as unknown as W).harness.subscribe(
					"feed",
					{ url: `/poll/value?id=${feed}` },
					{ intervalMs: 1_000 },
				),
			id,
		);
		await waitForEvents(other, "feed", 1);
		const runtimeBefore = await other.evaluate(
			() => (window as unknown as W).harness.status().runtimeId,
		);
		const closedAt = await other.evaluate(() => Date.now());
		await original.close();
		const count = await other.evaluate(
			() => (window as unknown as W).harness.events("feed").length,
		);
		// Chromium and Firefox keep the worker. WebKit relaunches it when its
		// first client closes; the survivor must then learn it from the new
		// runtime's announcement, reattach and report continuity as unknown.
		await waitForEvents(other, "feed", count + 3, timing.waitMs);
		const after = await other.evaluate(() => {
			const harness = (window as unknown as W).harness;
			return {
				status: harness.status(),
				continuity: harness.continuity("feed"),
				events: harness.events("feed").map(({ at, runtimeId, generation }) => ({
					at,
					runtimeId,
					generation,
				})),
				losses: harness
					.diagnostics()
					.filter((event) => event.type === "runtime-lost")
					.map((event) => event.detail),
			};
		});
		const replaced = after.status.runtimeId !== runtimeBefore;
		// Recovery: the first event after the closure served by the runtime
		// that serves the survivor at the end.
		const recovered = after.events.find(
			(event) =>
				event.at > closedAt && event.runtimeId === after.status.runtimeId,
		);
		const recoveryMs = recovered === undefined ? null : recovered.at - closedAt;
		const firstAfter = after.events.find((event) => event.at > closedAt);
		const observation = JSON.stringify({
			engine: testInfo.project.name,
			timings: timing.label,
			runtimeReplaced: replaced,
			firstEventAfterCloseMs:
				firstAfter === undefined ? null : firstAfter.at - closedAt,
			recoveryMs,
			generation: after.status.generation,
			losses: after.losses,
			continuity: after.continuity,
		});
		console.log(`CLOSURE-OBSERVATION ${observation}`);
		testInfo.annotations.push({
			type: "closure-observation",
			description: observation,
		});
		expect(after.status).toMatchObject({ mode: "shared", health: "healthy" });
		if (replaced) {
			// Detected from the announcement, not from a later heartbeat or
			// lease: continuity says the runtime was replaced.
			expect(after.continuity).toMatchObject({
				state: "unknown",
				reason: "runtime-replaced",
			});
			expect(after.losses).toContainEqual({ reason: "runtime-announced" });
		} else {
			expect(after.continuity.state).toBe("continuous");
			expect(after.losses).toEqual([]);
		}
		if (timing.bounded) {
			expect(recoveryMs).not.toBeNull();
			expect(recoveryMs as number).toBeLessThanOrEqual(RECOVERY_BOUND_MS);
		}
		expect((await polling(request, id)).stats.maxInFlight).toBe(1);
		await context.close();
	});
}

test("an abruptly closed tab (no detach) is reclaimed within its lease", async ({
	browser,
	request,
}) => {
	const context = await browser.newContext();
	const gone = uid("abrupt");
	const kept = uid("kept");
	const query = "heartbeat=1000&lease=3000";
	const victim = await openHarness(context, query);
	await victim.evaluate(() => (window as unknown as W).harness.create());
	await victim.evaluate(() =>
		(window as unknown as W).harness.suppressDetach(true),
	);
	await victim.evaluate(
		(feed) =>
			(window as unknown as W).harness.subscribe(
				"feed",
				{ url: `/poll/value?id=${feed}` },
				{ intervalMs: 1_000 },
			),
		gone,
	);
	const survivor = await openHarness(context, query);
	await survivor.evaluate(() => (window as unknown as W).harness.create());
	await survivor.evaluate(
		(feed) =>
			(window as unknown as W).harness.subscribe(
				"feed",
				{ url: `/poll/value?id=${feed}` },
				{ intervalMs: 1_000 },
			),
		kept,
	);
	await waitForEvents(victim, "feed", 2);
	await victim.close({ runBeforeUnload: false });
	const closedAt = Date.now();
	await expect
		.poll(
			async () => {
				const first = (await polling(request, gone)).stats.requests;
				await new Promise((resolve) => setTimeout(resolve, 1_500));
				return (await polling(request, gone)).stats.requests - first;
			},
			{ timeout: 15_000 },
		)
		.toBe(0);
	// Lease 3 s + one interval + checking granularity.
	expect(Date.now() - closedAt).toBeLessThan(10_000);
	const before = (await polling(request, kept)).stats.requests;
	await survivor.waitForTimeout(2_500);
	expect(
		(await polling(request, kept)).stats.requests - before,
	).toBeGreaterThanOrEqual(2);
	await context.close();
});
