import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import {
	baseNames,
	type CellContext,
	describeCell,
	downloadedBytes,
	FIXTURE,
	graphqlWsCounters,
	newRun,
	openProbePage,
	pageUrl,
	pollingCounters,
	sseCounters,
	status,
	waitForEvents,
	waitForMode,
} from "../package/consumers/browser.ts";
import { PORTS, STATIC_CSP } from "../package/consumers/catalogue.ts";
import { appsDir } from "../package/consumers/matrix.ts";
import { reportsDir, templatesDir } from "../package/consumers/paths.ts";
import { DEFINITIONS, median, p95 } from "../package/consumers/stats.ts";

/**
 * Representative applications: a GraphQL app
 * and an HTTP (SSE + polling) app built from the packed artefact. Each writes
 * a fixture report: integration effort against its committed no-Spinetab
 * baseline, upstream connections with and without sharing, fallback reasons,
 * recovery latency and continuity against the fixture's cursors, bundle cost
 * and retained memory. Enabled with SPINETAB_CONSUMERS_FULL=1. Reports are per engine,
 * `app-<name>-<browser>.json`; an existing file is moved to `archive/` first.
 */
const TABS = 4;
const RECOVERIES = 10;
/** Events per SSE response under `recover=1` (app-http `src/config.js`). */
const SSE_RESET_AFTER = 55;
/**
 * Bound for app-http's ten recoveries: 55 events at 200 ms (11 s) per
 * response plus a first-retry delay below 1 s, eleven responses ≈ 130 s.
 */
const HTTP_RECOVERY_WAIT_MS = 240_000;
const SOAK_MS = Number(process.env.SPINETAB_APP_SOAK_MS ?? 300_000);
const enabled = !process.env.CI || process.env.SPINETAB_CONSUMERS_FULL === "1";

interface TimedEvent {
	n: number;
	at: number;
	id?: string | null;
}

interface ContinuityEntry {
	state: string;
	reason: string | null;
	at: number;
}

/** Longest common subsequence length of two line lists. */
function commonLines(a: readonly string[], b: readonly string[]): number {
	let previous = new Array<number>(b.length + 1).fill(0);
	for (const line of a) {
		const current = new Array<number>(b.length + 1).fill(0);
		for (let index = 1; index <= b.length; index += 1) {
			current[index] =
				line === b[index - 1]
					? (previous[index - 1] ?? 0) + 1
					: Math.max(previous[index] ?? 0, current[index - 1] ?? 0);
		}
		previous = current;
	}
	return previous[b.length] ?? 0;
}

function listFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	const files: string[] = [];
	const walk = (current: string) => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const path = join(current, entry.name);
			if (entry.isDirectory()) walk(path);
			else files.push(relative(dir, path));
		}
	};
	walk(dir);
	return files.sort();
}

/** Lines and files changed from the committed baseline (integration effort). */
function integrationEffort(name: string) {
	const app = join(templatesDir, name);
	const baseline = join(app, "baseline");
	const read = (path: string) =>
		existsSync(path) ? readFileSync(path, "utf8").split("\n") : [];
	const files = [
		...new Set([
			...listFiles(join(app, "src")),
			...listFiles(join(baseline, "src")),
		]),
	];
	const changes = files.map((file) => {
		const before = read(join(baseline, "src", file));
		const after = read(join(app, "src", file));
		const common = commonLines(before, after);
		return {
			file: `src/${file}`,
			added: after.length - common,
			removed: before.length - common,
		};
	});
	const configBefore = read(join(baseline, "vite.config.mjs"));
	const configAfter = read(join(app, "vite.config.mjs"));
	const configCommon = commonLines(configBefore, configAfter);
	const manifest = (path: string) =>
		JSON.parse(readFileSync(path, "utf8")) as {
			dependencies?: Record<string, string>;
		};
	const depsBefore = Object.keys(
		manifest(join(baseline, "package.json")).dependencies ?? {},
	);
	const depsAfter = Object.keys(
		manifest(join(app, "package.json")).dependencies ?? {},
	);
	const touched = changes.filter((change) => change.added + change.removed > 0);
	return {
		filesChanged: touched.length,
		linesAdded: touched.reduce((sum, change) => sum + change.added, 0),
		linesRemoved: touched.reduce((sum, change) => sum + change.removed, 0),
		files: touched,
		configLinesTouched:
			configAfter.length - configCommon + (configBefore.length - configCommon),
		dependenciesAdded: depsAfter.filter((dep) => !depsBefore.includes(dep)),
		dependenciesRemoved: depsBefore.filter((dep) => !depsAfter.includes(dep)),
	};
}

async function openTabs(
	context: BrowserContext,
	url: string,
	count: number,
): Promise<Page[]> {
	const pages: Page[] = [];
	for (let index = 0; index < count; index += 1) {
		pages.push((await openProbePage(context, url)).page);
	}
	return pages;
}

async function events(page: Page): Promise<TimedEvent[]> {
	return page.evaluate(() => (window.__consumer?.events ?? []) as TimedEvent[]);
}

async function continuity(page: Page): Promise<ContinuityEntry[]> {
	return page.evaluate(
		() => (window.__consumer?.extra?.continuity ?? []) as ContinuityEntry[],
	);
}

async function heapUsed(
	context: BrowserContext,
	page: Page,
): Promise<number | null> {
	if (context.browser()?.browserType().name() !== "chromium") return null;
	const session = await context.newCDPSession(page);
	await session.send("Performance.enable");
	const { metrics } = await session.send("Performance.getMetrics");
	await session.detach();
	return (
		metrics.find((metric) => metric.name === "JSHeapUsedSize")?.value ?? null
	);
}

/**
 * `app-<name>-<browser>.json` in the consumer's reports and the shared apps
 * directory. Engines never share a file; an earlier report of the same engine
 * is moved to `archive/` (named by its modification time), never overwritten.
 */
function writeAppReport(
	name: string,
	browserName: string,
	report: unknown,
): void {
	const json = `${JSON.stringify(report, null, "\t")}\n`;
	const file = `app-${name}-${browserName}.json`;
	for (const dir of [reportsDir(name), appsDir()]) {
		mkdirSync(join(dir, "archive"), { recursive: true });
		const target = join(dir, file);
		if (existsSync(target)) {
			const stamp = statSync(target).mtime.toISOString().replace(/[:.]/g, "-");
			renameSync(
				target,
				join(dir, "archive", file.replace(/\.json$/, `-${stamp}.json`)),
			);
		}
		writeFileSync(target, json);
	}
}

async function lastEventNumber(page: Page): Promise<number> {
	return page.evaluate(() => {
		const all = (window.__consumer?.events ?? []) as Array<{ n?: number }>;
		return all[all.length - 1]?.n ?? 0;
	});
}

async function fallbackReason(
	context: CellContext,
	browserContext: BrowserContext,
) {
	const cell = context.cell();
	const workers = baseNames(context.report()?.worker ?? []);
	cell.front.drop(workers);
	try {
		const { page } = await openProbePage(
			browserContext,
			pageUrl(cell.origin, "/", newRun()),
		);
		return (await waitForMode(page, "local", 30_000)).reason ?? null;
	} finally {
		cell.front.drop(workers, true);
	}
}

for (const name of ["app-graphql", "app-http"] as const) {
	describeCell(
		{
			id: `${name}-vite-prod`,
			consumer: name,
			bundler: "vite",
			mode: "prod",
			variant: "prod",
			frontPort: PORTS.vite.prod,
			out: "out/vite-prod",
			front: { csp: STATIC_CSP },
			report: { bundler: "vite", variant: "prod" },
		},
		(context) => {
			test.skip(
				!enabled,
				"representative app reports run with SPINETAB_CONSUMERS_FULL=1",
			);
			test("writes the representative application report", async ({
				browser,
				browserName,
			}, testInfo) => {
				testInfo.setTimeout(SOAK_MS + 300_000);
				const cell = context.cell();

				// Connections for four tabs, shared and per tab.
				const sharedRun = newRun();
				const offRun = newRun();
				const sharedContext = await browser.newContext();
				const offContext = await browser.newContext();
				cell.front.reset();
				const sharedTabs = await openTabs(
					sharedContext,
					pageUrl(cell.origin, "/", sharedRun),
					TABS,
				);
				for (const page of sharedTabs) await waitForMode(page, "shared");
				for (const page of sharedTabs) await waitForEvents(page, 2);
				const downloadedShared = downloadedBytes(cell.log());
				cell.front.reset();
				const offTabs = await openTabs(
					offContext,
					pageUrl(cell.origin, "/", offRun, { sharing: "off" }),
					TABS,
				);
				for (const page of offTabs) await waitForMode(page, "local");
				for (const page of offTabs) await waitForEvents(page, 2);
				const downloadedOff = downloadedBytes(cell.log());
				await offContext.close();
				const connections =
					name === "app-graphql"
						? {
								shared: (await graphqlWsCounters(sharedRun)).connections,
								perTab: (await graphqlWsCounters(offRun)).connections,
							}
						: {
								shared: (await sseCounters(sharedRun)).streams,
								perTab: (await sseCounters(offRun)).streams,
								pollingShared: (await pollingCounters(sharedRun)).requests,
								pollingPerTab: (await pollingCounters(offRun)).requests,
							};
				expect(connections.shared).toBe(1);
				expect(connections.perTab).toBe(TABS);

				// Recovery latency and continuity against the fixture's cursors.
				const recoveryContext = await browser.newContext();
				const latencies: number[] = [];
				const outcomes: Array<{ states: string[]; cursorRegressed: boolean }> =
					[];
				/** app-http: every reset boundary, its resumed event and the upstream count. */
				let httpRecovery:
					| {
							boundaries: Array<{
								cursor: number;
								resumed: number;
								ms: number;
							}>;
							lastEvent: number;
							streams: number;
							resumeCursors: Array<string | null>;
					  }
					| undefined;
				/** app-http assertions, run after the report is written. */
				let verifyHttpRecovery: (() => void) | undefined;
				if (name === "app-graphql") {
					const page = sharedTabs[0] as Page;
					for (let attempt = 0; attempt < RECOVERIES; attempt += 1) {
						const before = (await events(page)).length;
						const since = Date.now();
						await fetch(
							`${FIXTURE}/graphql-ws/control/terminate?tag=${sharedRun}`,
							{
								method: "POST",
							},
						);
						await expect
							.poll(
								async () =>
									(await events(page))
										.slice(before)
										.some((event) => event.at > since),
								{
									timeout: 30_000,
								},
							)
							.toBe(true);
						const after = (await events(page))
							.slice(before)
							.filter((event) => event.at > since);
						latencies.push((after[0]?.at ?? since) - since);
						const states = (await continuity(page))
							.filter((entry) => entry.at >= since)
							.map((entry) => `${entry.state}/${entry.reason ?? "-"}`);
						const previous = (await events(page))[before - 1]?.n ?? 0;
						const cursorRegressed = (after[0]?.n ?? 0) <= previous;
						outcomes.push({ states, cursorRegressed });
						// A restarted upstream subscription is never reported continuous.
						if (cursorRegressed) {
							expect(
								states.some((state) => !state.startsWith("continuous")),
							).toBe(true);
						}
					}
				} else {
					const run = newRun();
					const { page } = await openProbePage(
						recoveryContext,
						pageUrl(cell.origin, "/", run, { recover: "1" }),
					);
					await waitForMode(page, "shared");
					// The fixture destroys each response right after cursor
					// k × SSE_RESET_AFTER. Wait until the page itself has the first
					// resumed event after the tenth reset, not the fixture's response
					// count (a response can open before its first event reaches the
					// page); only then read the samples.
					const lastBoundary = RECOVERIES * SSE_RESET_AFTER;
					await expect
						.poll(() => lastEventNumber(page), {
							timeout: HTTP_RECOVERY_WAIT_MS,
						})
						.toBeGreaterThan(lastBoundary);
					const received = await events(page);
					const counters = await sseCounters(run);
					// Latency at each reset: from the boundary event to the first
					// event of the resumed response. Every sample is kept.
					const boundaries: Array<{
						cursor: number;
						resumed: number;
						ms: number;
					}> = [];
					for (let index = 1; index < received.length; index += 1) {
						const previous = received[index - 1];
						const current = received[index];
						if (previous && current && previous.n % SSE_RESET_AFTER === 0) {
							boundaries.push({
								cursor: previous.n,
								resumed: current.n,
								ms: current.at - previous.at,
							});
							latencies.push(current.at - previous.at);
						}
					}
					const numbers = received.map((event) => event.n);
					const missing = numbers.filter(
						(n, index) => index > 0 && n !== (numbers[index - 1] ?? 0) + 1,
					);
					const states = (await continuity(page)).map(
						(entry) => `${entry.state}/${entry.reason ?? "-"}`,
					);
					const resumeCursors = counters.requests.map(
						(request) =>
							request.lastEventId ?? request.lastEventIdQuery ?? null,
					);
					httpRecovery = {
						boundaries,
						lastEvent: numbers[numbers.length - 1] ?? 0,
						streams: counters.streams,
						resumeCursors,
					};
					outcomes.push({ states, cursorRegressed: missing.length > 0 });
					verifyHttpRecovery = () => {
						// Last-Event-ID replay: every reset resumes without a gap.
						expect(missing).toEqual([]);
						expect(states.some((state) => state.startsWith("resumed"))).toBe(
							true,
						);
						// Each of the ten resets has its boundary sample, resumed at the
						// next cursor.
						const expected = Array.from(
							{ length: RECOVERIES },
							(_, index) => (index + 1) * SSE_RESET_AFTER,
						);
						expect(
							boundaries.slice(0, RECOVERIES).map((sample) => sample.cursor),
						).toEqual(expected);
						for (const sample of boundaries) {
							expect(sample.resumed).toBe(sample.cursor + 1);
						}
						// Connections: one per recovered reset plus the first, and each
						// recovery request carried the boundary cursor to the fixture.
						expect(counters.streams).toBeGreaterThanOrEqual(
							boundaries.length + 1,
						);
						expect(counters.streams).toBeGreaterThanOrEqual(RECOVERIES + 1);
						expect(resumeCursors[0]).toBeNull();
						expect(resumeCursors.slice(1, RECOVERIES + 1)).toEqual(
							expected.map(String),
						);
					};
				}
				await recoveryContext.close();

				// Fallback reasons, bundle cost and retained memory.
				const reasonContext = await browser.newContext();
				const workerMissing = await fallbackReason(context, reasonContext);
				await reasonContext.close();
				const heapStart = await heapUsed(sharedContext, sharedTabs[0] as Page);
				await (sharedTabs[0] as Page).waitForTimeout(SOAK_MS);
				const heapSoak = await heapUsed(sharedContext, sharedTabs[0] as Page);
				for (const page of sharedTabs.slice(1)) await page.close();
				await (sharedTabs[0] as Page).waitForTimeout(5_000);
				const heapAfterClose = await heapUsed(
					sharedContext,
					sharedTabs[0] as Page,
				);
				expect((await status(sharedTabs[0] as Page))?.mode).toBe("shared");
				await sharedContext.close();

				const report = {
					app: name,
					project: testInfo.project.name,
					candidate: context.record().sha256,
					integrationEffort: integrationEffort(name),
					connections: {
						tabs: TABS,
						...connections,
						savings: connections.perTab - connections.shared,
					},
					fallbackReasons: { "worker-404": workerMissing },
					recoveryLatencyMs: {
						samples: latencies,
						median: median(latencies),
						p95: p95(latencies),
						definitions: DEFINITIONS,
					},
					...(httpRecovery
						? {
								recovery: {
									resets: RECOVERIES,
									resetAfterEvents: SSE_RESET_AFTER,
									waitBoundMs: HTTP_RECOVERY_WAIT_MS,
									...httpRecovery,
								},
							}
						: {}),
					continuity: outcomes,
					bundleCost: {
						emitted: context.report()?.sizes ?? {},
						downloaded: { shared: downloadedShared, perTab: downloadedOff },
					},
					retainedMemory:
						heapStart === null
							? "not measured (numeric heap gates in Chromium only)"
							: {
									startBytes: heapStart,
									afterSoakBytes: heapSoak,
									afterClosingThreeTabsBytes: heapAfterClose,
									soakMs: SOAK_MS,
								},
				};
				writeAppReport(name, browserName, report);
				verifyHttpRecovery?.();
				expect(latencies.length).toBeGreaterThanOrEqual(RECOVERIES);
				context.note({
					counters: report.connections,
					downloaded: report.bundleCost.downloaded,
					notes: [`app report: ${name}`],
				});
			});
		},
	);
}
