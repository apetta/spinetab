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
	calibrateServer,
	checkCalibration,
	clearFault,
	now,
	openPage,
	type PageKind,
	recordEnvironment,
	resetFixture,
	setFault,
	settings,
	sleep,
	startPage,
	VARIANTS,
	type Variant,
	waitFor,
	waitForCounts,
} from "./lib/bench.ts";
import {
	attachSharedWorker,
	type CdpTarget,
	cpuDelta,
	enableMetrics,
	isolateHeaps,
	metricDelta,
	metrics,
	pageTarget,
	processCpu,
	startProfile,
	stopProfile,
} from "./lib/cdp.ts";
import type { Calibration } from "./lib/clock.ts";
import {
	continuityTotals,
	headroomRows,
	highWater,
	type RuntimeStatsLike,
	recordControlFlow,
	recordHighWater,
	withRecord,
} from "./lib/record.ts";
import { histogram, nearestRank, summarise } from "./lib/stats.ts";

// Tab scaling 1 / 5 / 20.
// {spinetab, independent} × {graphql-ws, ws} × N, plus the empty-tab and
// no-op SharedWorker baselines and the Chromium @attribution runs (profiler).
// Hard assertions: shared = 1 connection / 100 subscriptions for every N,
// independent = N / 100·N; zero loss and continuity reports.

type W = BenchWindow;
const S = settings();
const NOT_CDP = "no equivalent CDP automation in this engine";

interface Config {
	kind: PageKind;
	variant?: Variant;
	n: number;
	attribution?: boolean;
}

const configs: Config[] = [];
for (const variant of VARIANTS) {
	for (const kind of ["spinetab", "independent"] as const) {
		for (const n of S.tabs) configs.push({ kind, variant, n });
	}
}
for (const kind of ["empty", "noop"] as const) {
	for (const n of S.tabs) configs.push({ kind, n });
}
for (const variant of VARIANTS) {
	for (const n of S.tabs) {
		configs.push({ kind: "spinetab", variant, n, attribution: true });
	}
}

const label = (config: Config) =>
	`${config.kind}${config.variant ? `-${config.variant}` : ""}-n${config.n}${config.attribution ? "-attribution" : ""}`;

const prefix = (config: Config) =>
	config.variant
		? `${config.variant}.${config.kind}.n${config.n}`
		: `baseline.${config.kind}.n${config.n}`;

for (const config of configs) {
	const tags = config.attribution
		? ["@attribution"]
		: config.n <= 5
			? ["@pinned", "@smoke"]
			: ["@pinned"];
	test(
		`tabs ${label(config)}`,
		{ tag: tags },
		async ({ browser, browserName, request }, testInfo) => {
			const chromium = browserName === "chromium";
			const subscribed =
				config.kind === "spinetab" || config.kind === "independent";
			test.skip(
				!chromium && (!subscribed || !S.functionalTabs.includes(config.n)),
				"baselines and N=20 are Chromium measurements; other engines run N ∈ {1, 5} for counts",
			);
			test.setTimeout(
				120_000 + config.n * 15_000 + S.warmupMs + S.windowMs * 2,
			);
			await recordEnvironment(browser, testInfo);
			await resetFixture(request);

			const key = prefix(config);
			const expected = subscribed
				? [
						`tabs.${key}.connections`,
						`tabs.${key}.subscriptions`,
						`tabs.${key}.lost`,
						`tabs.${key}.continuity-reports`,
					]
				: [];
			if (chromium && !config.attribution) expected.push(`heap.${key}.total`);
			if (chromium && config.kind === "spinetab" && !config.attribution) {
				expected.push(`latency.${config.variant}.n${config.n}.cross.p95`);
			}
			await withRecord(
				testInfo,
				{ scenario: "tabs", config: label(config), expected },
				async (out, detail) => {
					detail.config = config;
					const context = await browser.newContext();
					const pages: Page[] = [];
					const cdpTargets: CdpTarget[] = [];
					let worker: CdpTarget | undefined;
					try {
						for (let index = 0; index < config.n; index += 1) {
							pages.push(await openPage(context, config.kind));
						}
						const first = pages[0] as Page;

						if (subscribed) {
							const variant = config.variant as Variant;
							const infos = [];
							for (const page of pages)
								infos.push(await startPage(page, { variant }));
							detail.pages = infos;
							if (config.kind === "spinetab") {
								for (const info of infos) {
									expect(info.mode, "bench tabs must run shared").toBe(
										"shared",
									);
								}
								expect(
									new Set(infos.map((info) => info.runtimeId)).size,
									"every tab reports the same runtime id",
								).toBe(1);
							}
							for (const page of pages) {
								await page.evaluate(
									(topics) => (window as unknown as W).bench.subscribe(topics),
									ALL_TOPICS,
								);
							}
							const expected =
								config.kind === "spinetab"
									? { connections: 1, subscriptions: 100 }
									: { connections: config.n, subscriptions: 100 * config.n };
							const state = await waitForCounts(
								request,
								variant,
								expected.connections,
								expected.subscriptions,
								60_000 + config.n * 5_000,
							);
							const endpoint = state.counters.byEndpoint[variant];
							out.put(`tabs.${key}.connections`, endpoint.activeConnections);
							out.put(
								`tabs.${key}.subscriptions`,
								endpoint.activeSubscriptions,
							);
						} else if (config.kind === "noop") {
							for (const page of pages) {
								const rtt = await page.evaluate(() =>
									(
										window as unknown as { bench: { ping(): Promise<number> } }
									).bench.ping(),
								);
								expect(Number.isFinite(rtt), "no-op worker answers").toBe(true);
							}
						}
						await first.bringToFront();
						const bringAt = Date.now();

						const calibration: Record<string, unknown> = {};
						let realmBefore: Calibration | undefined;
						let serverBefore: Calibration | undefined;
						if (subscribed) {
							await setFault(request, "pause");
							if (config.kind === "spinetab") {
								realmBefore = await calibrateRealm(first, S.calibrationSamples);
							}
							serverBefore = await calibrateServer(first);
							await clearFault(request, "pause");
							calibration.realmBefore = realmBefore;
							calibration.serverBefore = serverBefore;
						}

						if (config.kind === "spinetab") {
							await first.evaluate(() =>
								(window as unknown as W).bench.sampleStats("start", 250),
							);
						}
						await sleep(
							Math.max(S.warmupMs, S.discardMs - (Date.now() - bringAt)),
						);
						let statsSamples: RuntimeStatsLike[] = [];
						if (config.kind === "spinetab") {
							const samples = await first.evaluate(() =>
								(window as unknown as W).bench.sampleStats("stop"),
							);
							statsSamples = samples
								.map((sample) => sample.value as RuntimeStatsLike)
								.filter((value) => typeof value?.connections === "number");
						}

						let browserSession:
							| Awaited<ReturnType<typeof attachSharedWorker>>["browserSession"]
							| undefined;
						if (chromium) {
							for (const [index, page] of pages.entries()) {
								const target = await pageTarget(page, `page-${index}`);
								cdpTargets.push(target);
								await enableMetrics(target);
							}
							const workerUrl =
								config.kind === "spinetab"
									? "bench.worker"
									: config.kind === "noop"
										? "noop.worker"
										: undefined;
							if (workerUrl) {
								const attached = await attachSharedWorker(browser, workerUrl);
								browserSession = attached.browserSession;
								worker = attached.target;
								detail.workerAttach = {
									route: worker?.route,
									errors: attached.errors,
								};
								expect(worker, `CDP reach to ${workerUrl}`).toBeDefined();
							} else {
								browserSession = await browser.newBrowserCDPSession();
							}
							if (config.attribution && worker) {
								await startProfile(worker);
								await startProfile(cdpTargets[0] as CdpTarget);
							}
						}

						const metricsBefore = chromium
							? await Promise.all(cdpTargets.map((target) => metrics(target)))
							: [];
						let workerMetricsBefore: Record<string, number> | undefined;
						if (worker) {
							workerMetricsBefore = await enableMetrics(worker)
								.then(() => metrics(worker as CdpTarget))
								.catch(() => undefined);
						}
						const cpuBefore = browserSession
							? await processCpu(browserSession)
							: undefined;
						const stateBefore = await benchState(request);
						const from = await now(first);
						const startedAt = Date.now();
						await sleep(S.windowMs);
						const to = await now(first);
						const seconds = (Date.now() - startedAt) / 1_000;
						const stateAfter = await benchState(request);
						const cpuAfter = browserSession
							? await processCpu(browserSession)
							: undefined;
						const metricsAfter = chromium
							? await Promise.all(cdpTargets.map((target) => metrics(target)))
							: [];
						const workerMetricsAfter =
							worker && workerMetricsBefore
								? await metrics(worker).catch(() => undefined)
								: undefined;

						const fixtureCpu =
							(stateAfter.counters.cpuUsage.user +
								stateAfter.counters.cpuUsage.system -
								stateBefore.counters.cpuUsage.user -
								stateBefore.counters.cpuUsage.system) /
							1_000;
						out.put(`cpu.${key}.fixture-ms-per-s`, fixtureCpu / seconds);
						out.put(
							`tabs.${key}.wire-per-s`,
							(stateAfter.counters.wireMessages -
								stateBefore.counters.wireMessages) /
								seconds,
						);
						if (cpuBefore && cpuAfter) {
							const spent = cpuDelta(cpuBefore, cpuAfter);
							detail.cpuByType = spent.byType;
							out.put(
								`cpu.${key}.browser-ms-per-s`,
								(spent.total * 1_000) / seconds,
							);
							let pageTask = 0;
							for (const [index, before] of metricsBefore.entries()) {
								const delta = metricDelta(before, metricsAfter[index] ?? {});
								pageTask += delta.TaskDuration ?? Number.NaN;
							}
							out.put(
								`cpu.${key}.pages-task-ms-per-s`,
								(pageTask * 1_000) / seconds,
								"Performance.getMetrics TaskDuration unavailable",
							);
							if (workerMetricsBefore && workerMetricsAfter) {
								const delta = metricDelta(
									workerMetricsBefore,
									workerMetricsAfter,
								);
								out.put(
									`cpu.${key}.worker-task-ms-per-s`,
									((delta.TaskDuration ?? Number.NaN) * 1_000) / seconds,
									"worker TaskDuration unavailable",
								);
							} else if (worker) {
								out.skip(
									`cpu.${key}.worker-task-ms-per-s`,
									"Performance domain unavailable on the SharedWorker target; see @attribution",
								);
							}
							if (config.attribution && worker) {
								const workerProfile = await stopProfile(worker);
								const pageProfile = await stopProfile(
									cdpTargets[0] as CdpTarget,
								);
								detail.profiles = { worker: workerProfile, page0: pageProfile };
								out.put(
									`cpu.${key}.worker-active-ms-per-s`,
									workerProfile.activeMs / seconds,
								);
								out.put(
									`cpu.${key}.page0-active-ms-per-s`,
									pageProfile.activeMs / seconds,
								);
							}
						} else {
							out.skip(`cpu.${key}.browser-ms-per-s`, NOT_CDP);
						}

						if (subscribed && serverBefore) {
							await setFault(request, "pause");
							const realmAfter =
								config.kind === "spinetab"
									? await calibrateRealm(first, S.calibrationSamples)
									: undefined;
							const serverAfter = await calibrateServer(first);
							await clearFault(request, "pause");
							calibration.realmAfter = realmAfter;
							calibration.serverAfter = serverAfter;
							// HTTP round trips are slower than the channel: e2e is informational
							// and uses a 1 ms bound; the cross-realm gate keeps 0.5 ms.
							const serverCheck = checkCalibration(serverBefore, serverAfter, {
								maxUncertainty: 1,
								maxDrift: 1,
							});
							const realmCheck =
								realmBefore && realmAfter
									? checkCalibration(realmBefore, realmAfter)
									: undefined;
							calibration.realmCheck = realmCheck;
							calibration.serverCheck = serverCheck;
							const sample: LatencySample = await first.evaluate(
								([start, end, cross, server]) =>
									(window as unknown as W).bench.latency(
										start,
										end,
										cross,
										server,
									),
								[
									from,
									to,
									realmCheck?.valid ? realmCheck.offset : null,
									serverCheck.valid ? serverCheck.offset : null,
								] as const,
							);
							detail.latency = {
								cross: summarise(sample.cross),
								crossHistogram: histogram(sample.cross),
								e2e: summarise(sample.e2e),
								e2eHistogram: histogram(sample.e2e),
								paired: sample.paired,
								unpaired: sample.unpaired,
								hidden: sample.hidden,
							};
							if (config.kind === "spinetab" && !config.attribution) {
								const reason = realmCheck?.valid
									? "no paired samples"
									: `calibration invalid: ${realmCheck?.reasons.join("; ")}`;
								const latencyKey = `latency.${config.variant}.n${config.n}`;
								out.put(
									`${latencyKey}.cross.p50`,
									nearestRank(sample.cross, 50),
									reason,
								);
								out.put(
									`${latencyKey}.cross.p95`,
									nearestRank(sample.cross, 95),
									reason,
								);
								out.put(
									`${latencyKey}.cross.max`,
									Math.max(...sample.cross),
									reason,
								);
								out.put(
									`${latencyKey}.calibration.uncertainty`,
									realmCheck?.uncertainty ?? Number.NaN,
								);
								out.put(
									`${latencyKey}.calibration.drift`,
									Math.abs(realmCheck?.drift ?? Number.NaN),
								);
							}
							if (!config.attribution) {
								const reason = serverCheck.valid
									? "no samples"
									: `server calibration invalid: ${serverCheck.reasons.join("; ")}`;
								out.put(
									`latency.${key}.e2e.p50`,
									nearestRank(sample.e2e, 50),
									reason,
								);
								out.put(
									`latency.${key}.e2e.p95`,
									nearestRank(sample.e2e, 95),
									reason,
								);
							}
							const resolutions = (
								detail.pages as Array<{ resolution: number }>
							).map((info) => info.resolution);
							detail.timerResolution = {
								page: resolutions,
								...(config.kind === "spinetab"
									? {
											worker: (
												await first.evaluate(() =>
													(window as unknown as W).bench.realm<number>(
														"resolution",
													),
												)
											).value,
										}
									: {}),
							};
						}
						detail.calibration = calibration;
						detail.visibility = await Promise.all(
							pages.map((page) =>
								page.evaluate(() => document.visibilityState),
							),
						);

						if (subscribed) {
							const summaries: TopicSummary[] = [];
							for (const page of pages) {
								summaries.push(
									await page.evaluate(() =>
										(window as unknown as W).bench.summary(),
									),
								);
							}
							const totals = continuityTotals(summaries);
							detail.continuity = totals;
							out.put(`tabs.${key}.lost`, totals.gapEvents);
							out.put(
								`tabs.${key}.continuity-reports`,
								totals.lossReports + totals.errors,
							);
							expect(
								totals.gapEvents,
								"no message lost (per-tab seq continuity)",
							).toBe(0);
							expect(
								totals.lossReports + totals.errors,
								"no continuity loss",
							).toBe(0);
							expect(totals.topicsWithoutEvents, "every topic delivered").toBe(
								0,
							);
						}

						if (chromium) {
							const heapTargets = worker ? [...cdpTargets, worker] : cdpTargets;
							const heap = await isolateHeaps(heapTargets);
							detail.heap = heap;
							out.put(`heap.${key}.total`, heap.total);
							out.put(`heap.${key}.isolates`, heap.isolates.length);
						} else {
							out.skip(`heap.${key}.total`, NOT_CDP);
						}
						if (subscribed) {
							detail.pageHandles = await first.evaluate(() =>
								(window as unknown as W).bench.handles(),
							);
						}
						if (config.kind === "spinetab") {
							const reply = await first.evaluate(() =>
								(window as unknown as W).bench.realm<RuntimeStatsLike>("stats"),
							);
							statsSamples.push(reply.value);
							detail.workerHandles = (
								await first.evaluate(() =>
									(window as unknown as W).bench.realm("handles"),
								)
							).value;
							const hwm = highWater(statsSamples);
							detail.hwm = hwm;
							if (!config.attribution) {
								// Headroom gates only on the runtime's own hwm; a sampled
								// maximum goes to headroom.sampled.* (informational).
								const at = `${config.variant}.n${config.n}`;
								recordHighWater(out, hwm, headroomRows(at));
								// posted-window occupancy, expiries and
								// control still queued, from the final stats() above.
								detail.controlFlow = recordControlFlow(
									out,
									hwm,
									reply.value,
									at,
								);
							}
						}
					} finally {
						for (const target of cdpTargets)
							await target.detach().catch(() => {});
						await worker?.detach().catch(() => {});
						await context.close();
					}

					if (subscribed) {
						const variant = config.variant as Variant;
						await waitFor(
							() => benchState(request),
							(state) =>
								state.counters.byEndpoint[variant].activeConnections === 0,
							`${variant} connections closed after the context closed`,
							30_000,
						);
					}
				},
			);
		},
	);
}
