import { expect, type Page, test } from "@playwright/test";
import type { BenchWindow } from "../fixtures/harness/src/bench/types";
import { uid } from "../fixtures/harness/src/browser-helpers";

// Use package defaults and synchronous subscriptions; pacing would conceal outbox admission failures.

type W = BenchWindow;
const TOPICS = 100;
const all = Array.from({ length: TOPICS }, (_, topic) => topic);
const KIB = 1024;
/** 2 × (maxConsumersPerAttachment + maxPendingCommands) at package defaults. */
const QUEUED_CONTROL_CAP = 2 * (1_000 + 64);
/** maxControlMessages × maxMessageBytes at package defaults. */
const QUEUED_CONTROL_BYTES_CAP = 64 * 256 * KIB;
/** maxPendingBytes at package defaults: queued data is charged within it. */
const PENDING_BYTES_CAP = 1024 * KIB;

async function openBench(
	page: Page,
	variant: "ws" | "graphql-ws",
): Promise<void> {
	await page.goto("/harness/bench.html");
	await page.waitForFunction(() => (window as unknown as W).bench?.ready);
	await page.evaluate(
		(chosen) =>
			(window as unknown as W).bench.start({
				variant: chosen,
				sharing: "require",
				diagnostics: true,
			}),
		variant,
	);
}

/** Wait until every topic has delivered, then assert no loss on this page. */
async function expectLive(page: Page): Promise<void> {
	await expect
		.poll(
			() =>
				page.evaluate(
					() =>
						(window as unknown as W).bench
							.summary()
							.counts.filter((count) => count > 0).length,
				),
			{ timeout: 20_000 },
		)
		.toBe(TOPICS);
	const report = await page.evaluate(async () => {
		const { bench } = window as unknown as W;
		const summary = bench.summary();
		const stats = (
			await bench.realm<{
				expired: number;
				subscriptions: number;
				hwm: {
					controlMessages: number;
					controlQueued: number;
					controlQueuedBytes: number;
					dataQueuedBytes: number;
				};
			}>("stats")
		).value;
		return {
			info: bench.info(),
			lost: (bench.diagnostics() as Array<{ type: string }>).filter((event) =>
				["runtime-lost", "runtime-unstable", "mode-failed"].includes(
					event.type,
				),
			),
			errors: summary.errors.filter((error) => error !== null).length,
			connection: [...new Set(summary.connection)],
			continuity: [...new Set(summary.continuity.map((entry) => entry?.state))],
			expired: stats.expired,
			subscriptions: stats.subscriptions,
			controlHwm: stats.hwm.controlMessages,
			queuedHwm: {
				control: stats.hwm.controlQueued,
				controlBytes: stats.hwm.controlQueuedBytes,
				dataBytes: stats.hwm.dataQueuedBytes,
			},
		};
	});
	expect(report.lost).toEqual([]);
	expect(report.info).toMatchObject({
		mode: "shared",
		health: "healthy",
		generation: 1,
	});
	expect(report.errors).toBe(0);
	expect(report.connection).toEqual(["connected"]);
	expect(report.continuity).toEqual(["continuous"]);
	expect(report.expired).toBe(0);
	expect(report.subscriptions).toBe(TOPICS);
	expect(report.controlHwm).toBeLessThanOrEqual(64);
	expect(report.queuedHwm.control).toBeLessThanOrEqual(QUEUED_CONTROL_CAP);
	expect(report.queuedHwm.controlBytes).toBeLessThanOrEqual(
		QUEUED_CONTROL_BYTES_CAP,
	);
	expect(report.queuedHwm.dataBytes).toBeLessThanOrEqual(PENDING_BYTES_CAP);
}

for (const variant of ["ws", "graphql-ws"] as const) {
	test(`100 ${variant} subscriptions in one turn stay live at generation 1`, async ({
		browser,
	}) => {
		const context = await browser.newContext();
		const page = await context.newPage();
		await openBench(page, variant);
		const query = `c=${uid("burst")}`;
		expect(
			await page.evaluate(
				([topics, connection]) =>
					(window as unknown as W).bench.subscribe(topics, connection),
				[all, query] as const,
			),
		).toBe(TOPICS);
		await expectLive(page);
		await context.close();
	});
}

test("two tabs each subscribing 100 topics in one turn share one runtime without expiry", async ({
	browser,
}) => {
	const context = await browser.newContext();
	const query = `c=${uid("burst-tabs")}`;
	const pages = [await context.newPage(), await context.newPage()];
	for (const page of pages) await openBench(page, "ws");
	for (const page of pages) {
		await page.evaluate(
			([topics, connection]) =>
				(window as unknown as W).bench.subscribe(topics, connection),
			[all, query] as const,
		);
	}
	for (const page of pages) await expectLive(page);
	await context.close();
});
