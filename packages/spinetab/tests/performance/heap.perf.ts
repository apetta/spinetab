import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	type APIRequestContext,
	expect,
	type Page,
	test,
} from "@playwright/test";
import type { HandleCounts } from "../fixtures/harness/src/bench/instrument.ts";
import type { BenchWindow } from "../fixtures/harness/src/bench/types.ts";
import {
	ALL_TOPICS,
	benchState,
	clearFault,
	openPage,
	recordEnvironment,
	resetFixture,
	setFault,
	settings,
	sleep,
	spinetabClassNames,
	startPage,
	VARIANTS,
	type Variant,
	waitFor,
	waitForCounts,
} from "./lib/bench.ts";
import {
	attachSharedWorker,
	type CdpTarget,
	heapSnapshot,
	newNodeGroups,
	pageTarget,
	type SnapshotIndex,
	settledHeap,
} from "./lib/cdp.ts";
import { artefactDir, rep, writeJson, writeRaw } from "./lib/evidence.ts";
import {
	type Census,
	census,
	handlesRange,
	type Quiescence,
	quiesce,
	timerDelta,
} from "./lib/quiescence.ts";
import { Recorded, type RuntimeStatsLike, withRecord } from "./lib/record.ts";
import { slope } from "./lib/stats.ts";

// Retained heap, handles and history.
// Heap numbers are Chromium-only (CDP GC control); other engines record
// "not measured" and still check the structural facts (stats and fixture
// counts back to zero).

type W = BenchWindow;
const S = settings();
const IDLE_WAIT_MS = 5_000 + 1_000; // idleCloseMs default + 1 s
const NOT_CDP = "no equivalent CDP automation in this engine";
/** Steady state: linger + 2 page heartbeat intervals (20 s default). */
const STEADY_MS = 2 * 20_000 + 1_000;

const totalTimers = (counts: HandleCounts) =>
	counts.timeouts + counts.intervals;

async function pageHandles(page: Page): Promise<HandleCounts> {
	return page.evaluate(() => (window as unknown as W).bench.handles());
}

async function workerHandles(page: Page): Promise<HandleCounts> {
	return (
		await page.evaluate(() =>
			(window as unknown as W).bench.realm<HandleCounts>("handles"),
		)
	).value;
}

async function runtimeStats(page: Page): Promise<RuntimeStatsLike> {
	return (
		await page.evaluate(() =>
			(window as unknown as W).bench.realm<RuntimeStatsLike>("stats"),
		)
	).value;
}

/** Maximum live timers/listeners over a short window (transient timers). */
async function windowMax(
	read: () => Promise<HandleCounts>,
	samples = 10,
	spacingMs = 100,
) {
	let timers = 0;
	let listeners = 0;
	for (let index = 0; index < samples; index += 1) {
		const counts = await read();
		timers = Math.max(timers, totalTimers(counts));
		listeners = Math.max(listeners, counts.listeners);
		await sleep(spacingMs);
	}
	return { timers, listeners };
}

/**
 * Persistent handle census under quiescence (lib/quiescence.ts): pause bench
 * emission, wait for delivery and acknowledgements to drain, read both realms
 * until stable, then resume emission.
 */
function quiesceBench(page: Page, request: APIRequestContext) {
	return quiesce({
		pause: async () => {
			await setFault(request, "pause", true);
		},
		resume: async () => {
			await clearFault(request, "pause");
		},
		emitted: async () => (await benchState(request)).counters.emitted,
		delivered: () =>
			page.evaluate(() => (window as unknown as W).bench.summary().total),
		stats: () => runtimeStats(page),
		census: async () => ({
			page: census(await pageHandles(page)),
			worker: census(await workerHandles(page)),
		}),
	});
}

/** Quiescence evidence for detail.* (the census itself is in the rows). */
const quiescenceDetail = (result: Quiescence) =>
	result.ok
		? {
				ok: true,
				census: result.census,
				elapsedMs: result.elapsedMs,
				reads: result.reads,
			}
		: result;

async function batch(
	page: Page,
	request: Parameters<typeof waitForCounts>[0],
	variant: Variant,
): Promise<void> {
	await page.evaluate(
		(topics) => (window as unknown as W).bench.subscribe(topics),
		ALL_TOPICS,
	);
	await waitFor(
		() => benchState(request),
		(state) => state.counters.byEndpoint[variant].activeSubscriptions === 100,
		`${variant} activeSubscriptions=100`,
	);
	await page.evaluate(() => (window as unknown as W).bench.unsubscribe());
	await waitFor(
		() => benchState(request),
		(state) => state.counters.byEndpoint[variant].activeSubscriptions === 0,
		`${variant} activeSubscriptions=0`,
	);
}

const residual = (stats: RuntimeStatsLike) =>
	stats.connections +
	stats.consumers +
	stats.ledgers +
	stats.pendingMessages +
	stats.pendingBytes +
	stats.subscriptions +
	stats.pendingCommands +
	stats.pendingCredentialRequests;

for (const variant of VARIANTS) {
	test(
		`heap cycles ${variant}`,
		{ tag: ["@pinned", "@smoke"] },
		async ({ browser, browserName, request }, testInfo) => {
			const chromium = browserName === "chromium";
			const cycles = S.cycleBatches * 100;
			test.setTimeout(180_000 + S.cycleBatches * 2_000);
			await recordEnvironment(browser, testInfo);
			await resetFixture(request);
			const key = `heap.cycles.${variant}`;
			const expected = [`${key}.stats-residual`, `${key}.fixture-connections`];
			if (chromium) {
				expected.push(
					`${key}.page`,
					`${key}.worker`,
					`${key}.snapshot-flags`,
					`handles.cycles.${variant}.page.timers`,
					`handles.cycles.${variant}.worker.timers`,
				);
			}
			await withRecord(
				testInfo,
				{ scenario: "heap", config: `cycles-${variant}`, expected },
				async (out, detail) => {
					detail.cycles = cycles;
					let failed = true;
					const snapshotDir = join(artefactDir(), "snapshots");
					const snapshots: string[] = [];
					const context = await browser.newContext();
					let page: CdpTarget | undefined;
					let worker: CdpTarget | undefined;
					let pageBase: SnapshotIndex | undefined;
					let workerBase: SnapshotIndex | undefined;
					try {
						const tab = await openPage(context, "spinetab");
						const info = await startPage(tab, { variant });
						expect(info.mode).toBe("shared");
						if (chromium) {
							page = await pageTarget(tab, "page");
							const attached = await attachSharedWorker(
								browser,
								"bench.worker",
							);
							worker = attached.target;
							detail.workerAttach = {
								route: worker?.route,
								errors: attached.errors,
							};
							expect(worker, "CDP reach to the bench worker").toBeDefined();
						}

						for (let index = 0; index < S.warmupBatches; index += 1) {
							await batch(tab, request, variant);
						}
						await sleep(IDLE_WAIT_MS);
						await waitFor(
							() => benchState(request),
							(state) =>
								state.counters.byEndpoint[variant].activeConnections === 0,
							"idle close after warm-up",
						);

						const base: Record<string, unknown> = {
							pageHandles: await windowMax(() => pageHandles(tab)),
							workerHandles: await windowMax(() => workerHandles(tab)),
							stats: await runtimeStats(tab),
						};
						if (page && worker) {
							base.pageHeap = await settledHeap(page);
							base.workerHeap = await settledHeap(worker);
							pageBase = await heapSnapshot(
								page,
								join(
									snapshotDir,
									`${variant}-rep${rep()}-page-baseline.heapsnapshot`,
								),
							);
							workerBase = await heapSnapshot(
								worker,
								join(
									snapshotDir,
									`${variant}-rep${rep()}-worker-baseline.heapsnapshot`,
								),
							);
							snapshots.push(pageBase.path, workerBase.path);
						}
						detail.baseline = base;

						const started = Date.now();
						for (let index = 0; index < S.cycleBatches; index += 1) {
							await batch(tab, request, variant);
						}
						detail.cycleMs = Date.now() - started;
						await sleep(IDLE_WAIT_MS);
						const idle = await waitFor(
							() => benchState(request),
							(state) =>
								state.counters.byEndpoint[variant].activeConnections === 0,
							"idle close after cycles",
						);
						out.put(
							`${key}.fixture-connections`,
							idle.counters.byEndpoint[variant].activeConnections,
						);

						const after: Record<string, unknown> = {
							pageHandles: await windowMax(() => pageHandles(tab)),
							workerHandles: await windowMax(() => workerHandles(tab)),
							stats: await runtimeStats(tab),
						};
						detail.after = after;
						const afterStats = after.stats as RuntimeStatsLike;
						out.put(`${key}.stats-residual`, residual(afterStats));

						if (chromium && page && worker && pageBase && workerBase) {
							const pageHeap = await settledHeap(page);
							const workerHeap = await settledHeap(worker);
							after.pageHeap = pageHeap;
							after.workerHeap = workerHeap;
							const basePage = (base.pageHeap as { usedSize: number }).usedSize;
							const baseWorker = (base.workerHeap as { usedSize: number })
								.usedSize;
							out.put(`${key}.page`, pageHeap.usedSize - basePage);
							out.put(`${key}.worker`, workerHeap.usedSize - baseWorker);
							const handleDelta = (realm: "pageHandles" | "workerHandles") => {
								const before = base[realm] as {
									timers: number;
									listeners: number;
								};
								const now = after[realm] as {
									timers: number;
									listeners: number;
								};
								return {
									timers: now.timers - before.timers,
									listeners: now.listeners - before.listeners,
								};
							};
							const pageDelta = handleDelta("pageHandles");
							const workerDelta = handleDelta("workerHandles");
							out.put(
								`handles.cycles.${variant}.page.timers`,
								pageDelta.timers,
							);
							out.put(
								`handles.cycles.${variant}.page.listeners`,
								pageDelta.listeners,
							);
							out.put(
								`handles.cycles.${variant}.worker.timers`,
								workerDelta.timers,
							);
							out.put(
								`handles.cycles.${variant}.worker.listeners`,
								workerDelta.listeners,
							);

							// Snapshot check: Spinetab constructors that grew with the cycles.
							const classes = spinetabClassNames();
							const threshold = Math.max(10, Math.floor(cycles / 100));
							const flagged: Array<{
								realm: string;
								name: string;
								count: number;
							}> = [];
							const tops: Record<string, unknown> = {};
							for (const [realm, target, baseIndex] of [
								["page", page, pageBase],
								["worker", worker, workerBase],
							] as const) {
								const path = join(
									snapshotDir,
									`${variant}-rep${rep()}-${realm}-after.heapsnapshot`,
								);
								await heapSnapshot(target, path);
								snapshots.push(path);
								const groups = newNodeGroups(
									readFileSync(path, "utf8"),
									baseIndex.maxId,
								);
								tops[realm] = groups.slice(0, 20);
								for (const group of groups) {
									if (classes.has(group.name) && group.count >= threshold) {
										flagged.push({
											realm,
											name: group.name,
											count: group.count,
										});
									}
								}
							}
							detail.snapshotTop20 = tops;
							detail.snapshotFlags = { threshold, flagged };
							out.put(`${key}.snapshot-flags`, flagged.length);
						} else {
							for (const id of [
								`${key}.page`,
								`${key}.worker`,
								`${key}.snapshot-flags`,
								`handles.cycles.${variant}.page.timers`,
								`handles.cycles.${variant}.page.listeners`,
								`handles.cycles.${variant}.worker.timers`,
								`handles.cycles.${variant}.worker.listeners`,
							]) {
								out.skip(id, NOT_CDP);
							}
						}
						expect(residual(afterStats), "runtime work released").toBe(0);
						expect(idle.counters.byEndpoint[variant].activeConnections).toBe(0);
						failed = false;
					} finally {
						await page?.detach().catch(() => {});
						await worker?.detach().catch(() => {});
						await context.close();
						// Snapshots are kept for rep 1 (pass or fail) and for any failed run.
						if (rep() !== "01" && !failed) {
							for (const path of snapshots) rmSync(path, { force: true });
						} else {
							detail.snapshots = snapshots;
						}
					}
				},
			);
		},
	);

	test(
		`liveness O(1) ${variant}`,
		{ tag: ["@pinned"] },
		async ({ browser, request }, testInfo) => {
			test.setTimeout(4 * STEADY_MS + 60_000);
			await recordEnvironment(browser, testInfo);
			await resetFixture(request);
			await withRecord(
				testInfo,
				{
					scenario: "heap",
					config: `liveness-${variant}`,
					expected: [
						`handles.o1.${variant}.page.timers`,
						`handles.o1.${variant}.worker.timers`,
					],
				},
				async (out, detail) => {
					const context = await browser.newContext();
					// Active traffic: window maxima (diagnostic, detail.* only; they
					// include the shared transient acknowledgement and probe timers).
					// Rows: quiescent census, emission paused and acks drained.
					const state = async (tab: Page) => {
						await sleep(STEADY_MS);
						const active = {
							page: await windowMax(() => pageHandles(tab), 30, 200),
							worker: await windowMax(() => workerHandles(tab), 30, 200),
							stats: await runtimeStats(tab),
						};
						const quiescent = await quiesceBench(tab, request);
						return { active, quiescent };
					};
					try {
						const tab = await openPage(context, "spinetab");
						await startPage(tab, { variant });
						await tab.evaluate(
							(topics) => (window as unknown as W).bench.subscribe(topics),
							[0],
						);
						await waitForCounts(request, variant, 1, 1);
						const one = await state(tab);
						await tab.evaluate(
							(topics) => (window as unknown as W).bench.subscribe(topics),
							ALL_TOPICS,
						);
						await waitForCounts(request, variant, 1, 100);
						const hundred = await state(tab);
						detail.one = one.active;
						detail.hundred = hundred.active;
						detail.activeDelta = {
							page: hundred.active.page.timers - one.active.page.timers,
							worker: hundred.active.worker.timers - one.active.worker.timers,
						};
						detail.quiescent = {
							one: quiescenceDetail(one.quiescent),
							hundred: quiescenceDetail(hundred.quiescent),
						};
						out.put(
							`handles.o1.${variant}.connections`,
							hundred.active.stats.connections,
						);
						if (one.quiescent.ok && hundred.quiescent.ok) {
							const from = one.quiescent.census;
							const to = hundred.quiescent.census;
							out.put(
								`handles.o1.${variant}.page.timers`,
								timerDelta(from.page, to.page),
							);
							out.put(
								`handles.o1.${variant}.worker.timers`,
								timerDelta(from.worker, to.worker),
							);
							expect(
								to.worker.timers,
								"liveness timers are per connection",
							).toBe(from.worker.timers);
							expect(to.page.timers).toBe(from.page.timers);
						} else {
							const reason = [one, hundred]
								.map(({ quiescent }, index) =>
									quiescent.ok
										? undefined
										: `${index === 0 ? "1" : "100"} topic(s): ${quiescent.reason}`,
								)
								.filter(Boolean)
								.join("; ");
							out.skip(`handles.o1.${variant}.page.timers`, reason);
							out.skip(`handles.o1.${variant}.worker.timers`, reason);
							// Not measured is never a pass: the test fails visibly too.
							expect.soft(reason, "quiescent liveness census").toBe("");
						}
					} finally {
						await context.close();
					}
				},
			);
		},
	);

	test(
		`history flatness ${variant}`,
		{ tag: ["@pinned"] },
		async ({ browser, browserName, request }, testInfo) => {
			test.skip(browserName !== "chromium", NOT_CDP);
			test.skip(
				S.smoke || Number(rep()) > 3,
				"history flatness runs in pinned reps 1–3 only",
			);
			test.setTimeout(S.historyMs + 180_000);
			await recordEnvironment(browser, testInfo);
			await resetFixture(request);
			await withRecord(
				testInfo,
				{
					scenario: "heap",
					config: `history-${variant}`,
					expected: [
						`history.${variant}.page.slope`,
						`history.${variant}.worker.slope`,
					],
				},
				async (out, detail) => {
					const context = await browser.newContext();
					let page: CdpTarget | undefined;
					let worker: CdpTarget | undefined;
					try {
						const tab = await openPage(context, "spinetab");
						await startPage(tab, { variant });
						page = await pageTarget(tab, "page");
						const attached = await attachSharedWorker(browser, "bench.worker");
						worker = attached.target;
						expect(worker, "CDP reach to the bench worker").toBeDefined();
						await tab.evaluate(
							(topics) => (window as unknown as W).bench.subscribe(topics),
							ALL_TOPICS,
						);
						await waitForCounts(request, variant, 1, 100);
						const start = Date.now();
						const points: Array<Record<string, number>> = [];
						const quiescent: Census[][] = [[], []];
						const notQuiescent: string[] = [];
						const quiescence: unknown[] = [];
						const offsets = [30_000];
						while (
							(offsets[offsets.length - 1] as number) + 60_000 <=
							S.historyMs
						) {
							offsets.push((offsets[offsets.length - 1] as number) + 60_000);
						}
						// Include the full retention window after the minute-spaced samples.
						if ((offsets[offsets.length - 1] as number) < S.historyMs) {
							offsets.push(S.historyMs);
						}
						for (const offset of offsets) {
							await sleep(Math.max(0, start + offset - Date.now()));
							const delivered = await tab.evaluate(
								() => (window as unknown as W).bench.summary().total,
							);
							const pageHeap = await settledHeap(page);
							const workerHeap = await settledHeap(worker as CdpTarget);
							const pageCounts = await windowMax(() => pageHandles(tab));
							const workerCounts = await windowMax(() => workerHandles(tab));
							const stats = await runtimeStats(tab);
							const atMs = Date.now() - start;
							// After the heap and active samples: pause, drain, census, resume.
							const settled = await quiesceBench(tab, request);
							quiescence.push({ atMs, ...quiescenceDetail(settled) });
							if (settled.ok) {
								quiescent[0]?.push(settled.census.page);
								quiescent[1]?.push(settled.census.worker);
							} else notQuiescent.push(`at ${atMs} ms: ${settled.reason}`);
							points.push({
								atMs,
								delivered,
								pageHeap: pageHeap.usedSize,
								workerHeap: workerHeap.usedSize,
								pageTimers: pageCounts.timers,
								pageListeners: pageCounts.listeners,
								workerTimers: workerCounts.timers,
								workerListeners: workerCounts.listeners,
								consumers: stats.consumers,
								connections: stats.connections,
								ledgers: stats.ledgers,
								...(settled.ok
									? {
											quiescentPageTimers: settled.census.page.timers,
											quiescentPageListeners: settled.census.page.listeners,
											quiescentWorkerTimers: settled.census.worker.timers,
											quiescentWorkerListeners: settled.census.worker.listeners,
										}
									: {}),
							});
						}
						expect(
							points[points.length - 1]?.atMs,
							"history census covers the full retention window",
						).toBeGreaterThanOrEqual(S.historyMs);
						detail.points = points;
						detail.quiescence = quiescence;
						const column = (name: string) =>
							points.map((point) => point[name] as number);
						const delivered = column("delivered");
						const range = (values: number[]) =>
							Math.max(...values) - Math.min(...values);
						const activeRange: Record<string, number> = {};
						for (const [index, realm] of (
							["page", "worker"] as const
						).entries()) {
							const heap = column(`${realm}Heap`);
							out.put(
								`history.${variant}.${realm}.slope`,
								slope(delivered, heap),
							);
							out.put(
								`history.${variant}.${realm}.growth`,
								(heap[heap.length - 1] as number) - (heap[0] as number),
							);
							// Diagnostic: active-traffic window maxima (transient work).
							activeRange[realm] = handlesRange(
								points.map((point) => ({
									timers: point[`${realm}Timers`] as number,
									listeners: point[`${realm}Listeners`] as number,
								})),
							);
							if (notQuiescent.length === 0) {
								out.put(
									`history.${variant}.${realm}.handles-range`,
									handlesRange(quiescent[index] ?? []),
								);
							} else {
								out.skip(
									`history.${variant}.${realm}.handles-range`,
									notQuiescent.join("; "),
								);
							}
						}
						detail.activeHandlesRange = activeRange;
						// Not measured is never a pass: the test fails visibly too.
						expect
							.soft(notQuiescent.join("; "), "quiescent history census")
							.toBe("");
						out.put(
							`history.${variant}.stats-range`,
							range(column("consumers")) +
								range(column("connections")) +
								range(column("ledgers")),
						);
					} finally {
						await page?.detach().catch(() => {});
						await worker?.detach().catch(() => {});
						await context.close();
						writeJson(
							join(artefactDir(), `history-${variant}-rep${rep()}.json`),
							detail,
						);
					}
				},
			);
		},
	);
}

test(
	"heap not measured outside Chromium",
	{ tag: ["@pinned", "@smoke"] },
	async ({ browserName }, testInfo) => {
		test.skip(browserName === "chromium", "Chromium measures heap");
		const out = new Recorded();
		for (const variant of VARIANTS) {
			for (const id of [
				`heap.cycles.${variant}.page`,
				`heap.cycles.${variant}.worker`,
				`heap.five-tabs.${variant}.additional`,
			]) {
				out.skip(id, NOT_CDP);
			}
		}
		writeRaw({
			project: testInfo.project.name,
			scenario: "heap",
			config: "not-measured",
			metrics: out.metrics,
			notMeasured: out.notMeasured,
			detail: { engine: browserName },
		});
	},
);
