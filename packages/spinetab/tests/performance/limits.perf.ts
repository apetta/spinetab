import { expect, type Page, test } from "@playwright/test";
import type {
	BenchWindow,
	LatencySample,
	TopicSummary,
} from "../fixtures/harness/src/bench/types.ts";
import {
	ALL_TOPICS,
	benchState,
	calibrateRealm,
	checkCalibration,
	clearFault,
	now,
	openPage,
	recordEnvironment,
	resetFixture,
	setFault,
	sleep,
	startPage,
	VARIANTS,
	type Variant,
	waitFor,
	waitForCounts,
} from "./lib/bench.ts";
import { attachSharedWorker, settledHeap } from "./lib/cdp.ts";
import {
	continuityTotals,
	highWater,
	type RuntimeStatsLike,
	recordHighWater,
	withRecord,
} from "./lib/record.ts";
import { nearestRank } from "./lib/stats.ts";

// Limits and bounded delivery. Every limit here has a tested
// failure outcome; limits owned elsewhere stay `not-measured` in budgets.json
// with their owner and test id.

type W = BenchWindow;
const STALL_MS = 10_000;
/** `SPINETAB_PERF_STALL=hold` stalls tab B by holding acks instead of busy-looping. */
const STALL_MODE = process.env.SPINETAB_PERF_STALL === "hold" ? "hold" : "busy";

const summaryOf = (page: Page): Promise<TopicSummary> =>
	page.evaluate(() => (window as unknown as W).bench.summary());

async function stall(
	page: Page,
	ms: number,
): Promise<{ start: number; end: number }> {
	if (STALL_MODE === "busy") {
		return page.evaluate(
			(duration) => (window as unknown as W).bench.busy(duration),
			ms,
		);
	}
	const start = await now(page);
	await page.evaluate(() => (window as unknown as W).bench.holdAcks(true));
	await sleep(ms);
	await page.evaluate(() => (window as unknown as W).bench.holdAcks(false));
	return { start, end: await now(page) };
}

interface StallConfig {
	variant: Variant;
	byteBound: boolean;
}

const stallConfigs: StallConfig[] = [
	...VARIANTS.map((variant) => ({ variant, byteBound: false })),
	...VARIANTS.map((variant) => ({ variant, byteBound: true })),
];

for (const config of stallConfigs) {
	const name = `${config.byteBound ? "window-bytes" : "window"}.${config.variant}`;
	const tags =
		config.variant === "ws" && !config.byteBound
			? ["@limits", "@smoke"]
			: ["@limits"];
	test(
		`stall ${name}`,
		{ tag: tags },
		async ({ browser, browserName, request }, testInfo) => {
			test.setTimeout(180_000);
			await recordEnvironment(browser, testInfo);
			await resetFixture(request);
			const key = `limits.${name}`;
			await withRecord(
				testInfo,
				{
					scenario: "limits",
					config: `stall-${name}`,
					expected: [
						`${key}.pending-messages.hwm`,
						`${key}.pending-bytes.hwm`,
						`${key}.a-loss`,
						`${key}.b-silent-loss`,
					],
				},
				async (out, detail) => {
					detail.mode = STALL_MODE;
					if (config.byteBound) {
						await setFault(request, "size", 64 * 1024);
						await setFault(request, "rate", 20);
					}
					const context = await browser.newContext();
					try {
						const a = await openPage(context, "spinetab");
						const b = await openPage(context, "spinetab");
						for (const page of [a, b]) {
							const info = await startPage(page, {
								variant: config.variant,
								ackControl: STALL_MODE === "hold",
							});
							expect(info.mode).toBe("shared");
							await page.evaluate(
								(topics) => (window as unknown as W).bench.subscribe(topics),
								ALL_TOPICS,
							);
						}
						await waitForCounts(request, config.variant, 1, 100);
						await a.bringToFront();
						await setFault(request, "pause");
						const calibrationBefore = await calibrateRealm(a, 200);
						await clearFault(request, "pause");
						await sleep(config.byteBound ? 6_000 : 3_000);

						let worker:
							| Awaited<ReturnType<typeof attachSharedWorker>>["target"]
							| undefined;
						if (browserName === "chromium") {
							worker = (await attachSharedWorker(browser, "bench.worker"))
								.target;
						}
						const heapBefore = worker ? await settledHeap(worker) : undefined;

						// Control window on A (no stall), then the stall window.
						const controlFrom = await now(a);
						await sleep(STALL_MS);
						const controlTo = await now(a);
						const bInfo = await b.evaluate(() =>
							(window as unknown as W).bench.info(),
						);
						await a.evaluate(() =>
							(window as unknown as W).bench.sampleStats("start", 250),
						);
						const stalling = stall(b, STALL_MS);
						let heapDuring: Awaited<ReturnType<typeof settledHeap>> | undefined;
						if (worker) {
							await sleep(STALL_MS - 2_000);
							heapDuring = await settledHeap(worker);
						}
						const stallWindow = await stalling;
						const samples = await a.evaluate(() =>
							(window as unknown as W).bench.sampleStats("stop"),
						);
						await worker?.detach().catch(() => {});
						detail.stallWindow = stallWindow;

						// A's view of the worker during B's stall: B's attachment is the
						// one whose consumers are B's (both have 100); take the maximum
						// per attachment across samples.
						const stats = samples
							.map((sample) => sample.value as RuntimeStatsLike)
							.filter((value) => typeof value?.connections === "number");
						const hwm = highWater(stats);
						detail.hwm = hwm;
						detail.samples = samples.length;
						const gaps = samples
							.map((sample) => sample.at)
							.slice(1)
							.map((at, index) => at - (samples[index]?.at ?? at));
						detail.samplerMaxGapMs = Math.max(0, ...gaps);
						// The cap rows gate only on the runtime's own hwm; snapshot
						// maxima go to ${key}.sampled.* (informational).
						recordHighWater(out, hwm, [
							{
								key: "pendingMessages",
								id: `${key}.pending-messages.hwm`,
								sampledId: `${key}.sampled.pending-messages`,
							},
							{
								key: "pendingBytes",
								id: `${key}.pending-bytes.hwm`,
								sampledId: `${key}.sampled.pending-bytes`,
							},
						]);
						const firstFull = samples.find((sample) =>
							(sample.value as RuntimeStatsLike).perAttachment?.some(
								(attachment) =>
									attachment.pendingMessages >= 256 ||
									attachment.pendingBytes >= 1024 * 1024 * 0.95,
							),
						);
						out.put(
							`${key}.time-to-overflow`,
							firstFull ? firstFull.at - stallWindow.start : Number.NaN,
							"window never filled during the stall",
						);
						if (heapBefore && heapDuring) {
							detail.workerHeap = { before: heapBefore, during: heapDuring };
							out.put(
								`${key}.worker-heap-delta`,
								heapDuring.usedSize - heapBefore.usedSize,
							);
						} else {
							out.skip(
								`${key}.worker-heap-delta`,
								"no equivalent CDP automation",
							);
						}

						// A: zero loss and its latency against the no-stall control.
						await sleep(3_000);
						await setFault(request, "pause");
						const calibrationAfter = await calibrateRealm(a, 200);
						await sleep(1_000);
						const check = checkCalibration(calibrationBefore, calibrationAfter);
						detail.calibration = check;
						const latency = async (from: number, to: number) =>
							a.evaluate(
								([start, end, offset]) =>
									(window as unknown as W).bench.latency(
										start,
										end,
										offset,
										null,
									),
								[from, to, check.valid ? check.offset : null] as const,
							) as Promise<LatencySample>;
						const control = await latency(controlFrom, controlTo);
						const during = await latency(stallWindow.start, stallWindow.end);
						out.put(
							`${key}.a-latency-p95-control`,
							nearestRank(control.cross, 95),
						);
						out.put(
							`${key}.a-latency-p95-stall`,
							nearestRank(during.cross, 95),
						);
						const aTotals = continuityTotals([await summaryOf(a)]);
						detail.a = aTotals;
						out.put(
							`${key}.a-loss`,
							aTotals.gapEvents + aTotals.lossReports + aTotals.errors,
						);

						// B: never silent. Overflowed consumers account for every event:
						// delivered + missed = produced (generator paused, notices settled).
						const bSummary = await summaryOf(b);
						const { seqs } = await benchState(request);
						let silent = 0;
						let accountingErrors = 0;
						let overflowed = 0;
						let expired = 0;
						const perTopic: Array<Record<string, unknown>> = [];
						for (const [index, topic] of bSummary.topics.entries()) {
							const delivered = bSummary.counts[index] ?? 0;
							const first = bSummary.firstSeq[index] ?? -1;
							const produced =
								first < 0 ? 0 : (seqs[String(topic)] ?? 0) - first;
							const continuity = bSummary.continuity[index];
							const reported = (bSummary.lossReports[index] ?? 0) > 0;
							if (
								continuity?.state === "gap" &&
								continuity.reason === "overflow"
							) {
								overflowed += 1;
								if (delivered + (continuity.missed ?? 0) !== produced)
									accountingErrors += 1;
							} else if (continuity?.state === "unknown") {
								expired += 1;
							}
							if (produced > delivered && !reported) silent += 1;
							perTopic.push({ topic, delivered, produced, continuity });
						}
						detail.b = { perTopic, overflowed, expired, info: bInfo };
						out.put(`${key}.b-silent-loss`, silent);
						out.put(`${key}.b-overflowed`, overflowed);
						out.put(`${key}.b-attachment-expired`, expired > 0 ? 1 : 0);
						if (overflowed > 0)
							out.put(`${key}.b-accounting`, accountingErrors);
						else
							out.skip(
								`${key}.b-accounting`,
								expired > 0
									? "B's attachment expired (control-message bound) before per-consumer overflow accounting"
									: "no B consumer overflowed",
							);

						// Explicit reconcile gives continuous again (new epoch).
						await clearFault(request, "pause");
						await b.evaluate(() =>
							(window as unknown as W).bench.markReconciled(),
						);
						await sleep(4_000);
						const reconciled = await summaryOf(b);
						const notContinuous = reconciled.continuity.filter(
							(entry) => entry !== null && entry.state !== "continuous",
						).length;
						out.put(`${key}.b-after-reconcile`, notContinuous);

						expect(
							aTotals.gapEvents + aTotals.lossReports,
							"tab A unaffected",
						).toBe(0);
						expect(silent, "no silent loss on tab B").toBe(0);
						expect(hwm.values.pendingMessages ?? 0).toBeLessThanOrEqual(256);
						expect(hwm.values.pendingBytes ?? 0).toBeLessThanOrEqual(
							1024 * 1024,
						);
					} finally {
						await context.close();
					}
				},
			);
		},
	);
}

for (const variant of VARIANTS) {
	test(
		`single event size ${variant}`,
		{ tag: ["@limits"] },
		async ({ browser, request }, testInfo) => {
			test.setTimeout(120_000);
			await recordEnvironment(browser, testInfo);
			await resetFixture(request);
			const key = `limits.message.${variant}`;
			const target = 7;
			await withRecord(
				testInfo,
				{
					scenario: "limits",
					config: `message-${variant}`,
					expected: [
						`${key}.255k-delivered`,
						`${key}.257k-reported`,
						`${key}.others-continue`,
					],
				},
				async (out, detail) => {
					const context = await browser.newContext();
					try {
						const page = await openPage(context, "spinetab");
						await startPage(page, { variant, inspect: true });
						await page.evaluate(
							(topics) => (window as unknown as W).bench.subscribe(topics),
							ALL_TOPICS,
						);
						await waitForCounts(request, variant, 1, 100);
						await setFault(request, "sizeTopic", target);
						await setFault(request, "size", 255 * 1024);
						const intact = await waitFor(
							() =>
								page.evaluate(() => (window as unknown as W).bench.inspect()),
							(inspection) => inspection.sizes[target] === 255 * 1024,
							"a 255 KiB event delivered intact",
							10_000,
						)
							.then(() => 1)
							.catch(() => 0);
						out.put(`${key}.255k-delivered`, intact);

						const before = await summaryOf(page);
						await setFault(request, "size", 257 * 1024);
						await sleep(3_500);
						const after = await summaryOf(page);
						const index = after.topics.indexOf(target);
						const continuity = after.continuity[index];
						const reported =
							continuity?.state === "gap" &&
							continuity.reason === "message-too-large";
						out.put(`${key}.257k-reported`, reported ? 1 : 0);
						const inspection = await page.evaluate(() =>
							(window as unknown as W).bench.inspect(),
						);
						out.put(
							`${key}.257k-not-delivered`,
							(inspection.sizes[target] ?? 0) > 256 * 1024 ? 1 : 0,
						);
						let others = 0;
						let collateral = 0;
						for (const [position, topic] of after.topics.entries()) {
							if (topic === target) continue;
							if (
								(after.counts[position] ?? 0) > (before.counts[position] ?? 0)
							)
								others += 1;
							if (after.continuity[position]?.state !== "continuous")
								collateral += 1;
						}
						detail.target = { continuity, size: inspection.sizes[target] };
						detail.othersDelivering = others;
						// Native WebSocket: an oversized frame cannot be routed before
						// decoding, so every subscription on that socket is told `gap`.
						detail.collateralGaps = collateral;
						out.put(
							`${key}.others-continue`,
							others === ALL_TOPICS.length - 1 ? 1 : 0,
						);
						out.put(`${key}.collateral-gaps`, collateral);
						expect(intact).toBe(1);
						expect(reported).toBe(true);
					} finally {
						await context.close();
					}
				},
			);
		},
	);
}

test(
	"pending commands and ack timeout",
	{ tag: ["@limits", "@smoke"] },
	async ({ browser, request }, testInfo) => {
		test.setTimeout(120_000);
		await recordEnvironment(browser, testInfo);
		await resetFixture(request);
		const key = "limits.commands";
		await withRecord(
			testInfo,
			{
				scenario: "limits",
				config: "commands",
				expected: [
					`${key}.pending.held`,
					`${key}.pending.rejected`,
					`${key}.pending.reached-fixture`,
					`${key}.pending.acknowledged`,
					`${key}.ack-timeout.unknown`,
					`${key}.ack-timeout.resent`,
				],
			},
			async (out, detail) => {
				const context = await browser.newContext();
				try {
					const page = await openPage(context, "spinetab");
					await startPage(page, { variant: "ws" });
					await page.evaluate(() =>
						(window as unknown as W).bench.subscribe([0]),
					);
					await waitForCounts(request, "ws", 1, 1);

					await setFault(request, "holdAcks");
					const heldFrom = Date.now();
					await page.evaluate(() =>
						(window as unknown as W).bench.commands(65),
					);
					const held = await waitFor(
						() => benchState(request),
						(state) => state.counters.heldAcks >= 64,
						"64 commands held at the fixture",
						5_000,
					);
					await sleep(250);
					const pending = await page.evaluate(() =>
						(window as unknown as W).bench.commandResults(),
					);
					const rejected = pending.filter(
						(entry) =>
							entry?.status === "not-sent" && entry.code === "limit-exceeded",
					).length;
					out.put(
						`${key}.pending.held`,
						(await benchState(request)).counters.heldAcks,
					);
					out.put(`${key}.pending.rejected`, rejected);
					out.put(`${key}.pending.reached-fixture`, held.counters.commands);
					await setFault(request, "releaseAcks");
					detail.heldMs = Date.now() - heldFrom;
					const settled = await waitFor(
						() =>
							page.evaluate(() =>
								(window as unknown as W).bench.commandResults(),
							),
						(results) => results.every((entry) => entry !== null),
						"all 65 commands settled",
						10_000,
					);
					await clearFault(request, "holdAcks");
					await clearFault(request, "releaseAcks");
					const statuses: Record<string, number> = {};
					for (const entry of settled) {
						const label = `${entry?.status}${entry?.code ? `/${entry.code}` : ""}`;
						statuses[label] = (statuses[label] ?? 0) + 1;
					}
					detail.pendingOutcomes = statuses;
					out.put(`${key}.pending.acknowledged`, statuses.acknowledged ?? 0);
					expect(
						detail.heldMs as number,
						"hold stays below the 10 s ack timeout",
					).toBeLessThan(10_000);

					// Ack timeout: an ack later than 10 s settles `unknown`, never resent.
					const before = (await benchState(request)).counters.commands;
					await setFault(request, "ackDelayMs", 11_000);
					await page.evaluate(() => (window as unknown as W).bench.commands(1));
					const late = await waitFor(
						() =>
							page.evaluate(() =>
								(window as unknown as W).bench.commandResults(),
							),
						(results) => results[0] !== null,
						"the delayed command settled",
						15_000,
					);
					await sleep(3_000);
					const afterCount = (await benchState(request)).counters.commands;
					await clearFault(request, "ackDelayMs");
					detail.ackTimeout = late[0];
					out.put(
						`${key}.ack-timeout.unknown`,
						late[0]?.status === "unknown" ? 1 : 0,
					);
					out.put(`${key}.ack-timeout.resent`, afterCount - before - 1);
					expect(rejected).toBe(1);
					expect(statuses.acknowledged).toBe(64);
				} finally {
					await context.close();
				}
			},
		);
	},
);

test(
	"active work limits",
	{ tag: ["@limits"] },
	async ({ browser, request }, testInfo) => {
		test.setTimeout(180_000);
		await recordEnvironment(browser, testInfo);
		await resetFixture(request);
		const key = "limits.active";
		await withRecord(
			testInfo,
			{
				scenario: "limits",
				config: "active-work",
				expected: [
					`${key}.subscriptions.rejected`,
					`${key}.subscriptions.others-continue`,
					`${key}.connections.open`,
					`${key}.connections.rejected`,
					`${key}.connections.others-continue`,
				],
			},
			async (out, detail) => {
				const context = await browser.newContext();
				try {
					const page = await openPage(context, "spinetab");
					await startPage(page, { variant: "ws" });
					const thousand = Array.from({ length: 1_000 }, (_, index) => index);
					await page.evaluate(
						(topics) => (window as unknown as W).bench.subscribe(topics),
						thousand,
					);
					await waitForCounts(request, "ws", 1, 1_000, 90_000);
					await page.evaluate(() =>
						(window as unknown as W).bench.subscribe([1_000]),
					);
					await sleep(1_000);
					const before = await summaryOf(page);
					await sleep(2_500);
					const after = await summaryOf(page);
					const at = (summary: TopicSummary, topic: number) =>
						summary.topics.indexOf(topic);
					const error = after.errors[at(after, 1_000)];
					out.put(
						`${key}.subscriptions.rejected`,
						error === "limit-exceeded" ? 1 : 0,
					);
					let delivering = 0;
					for (let topic = 0; topic < 100; topic += 1) {
						if (
							(after.counts[at(after, topic)] ?? 0) >
							(before.counts[at(before, topic)] ?? 0)
						)
							delivering += 1;
					}
					out.put(
						`${key}.subscriptions.others-continue`,
						delivering >= 95 ? 1 : 0,
					);
					detail.subscriptions = { error, delivering };

					await page.evaluate(() =>
						(window as unknown as W).bench.unsubscribe(),
					);
					await waitFor(
						() => benchState(request),
						(state) => state.counters.byEndpoint.ws.activeConnections === 0,
						"idle close before the connection test",
						20_000,
					);
					// Topic i on its own connection `?c=i`: 32 connections, the 33rd refused.
					for (let topic = 0; topic < 32; topic += 1) {
						await page.evaluate(
							([value, query]) =>
								(window as unknown as W).bench.subscribe([value], query),
							[topic, `c=${topic}`] as const,
						);
					}
					const open = await waitForCounts(request, "ws", 32, 32);
					out.put(
						`${key}.connections.open`,
						open.counters.byEndpoint.ws.activeConnections,
					);
					const beforeConnections = await summaryOf(page);
					await page.evaluate(() =>
						(window as unknown as W).bench.subscribe([32], "c=32"),
					);
					await sleep(3_500);
					const afterConnections = await summaryOf(page);
					const refused = afterConnections.errors[at(afterConnections, 32)];
					out.put(
						`${key}.connections.rejected`,
						refused === "limit-exceeded" ? 1 : 0,
					);
					let still = 0;
					for (let topic = 0; topic < 32; topic += 1) {
						if (
							(afterConnections.counts[at(afterConnections, topic)] ?? 0) >
							(beforeConnections.counts[at(beforeConnections, topic)] ?? 0)
						)
							still += 1;
					}
					out.put(`${key}.connections.others-continue`, still === 32 ? 1 : 0);
					const final = await benchState(request);
					detail.connections = {
						refused,
						still,
						activeConnections: final.counters.byEndpoint.ws.activeConnections,
					};
					expect(error).toBe("limit-exceeded");
					expect(refused).toBe("limit-exceeded");
				} finally {
					await context.close();
				}
			},
		);
	},
);
