import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
	describeCell,
	downloadedBytes,
	newRun,
	openProbePage,
	pageUrl,
	provePair,
	requestsFor,
	sseCounters,
	waitForEvents,
	waitForMode,
	workerNameProblems,
	wsCounters,
} from "../package/consumers/browser.ts";
import { consumer, PORTS } from "../package/consumers/catalogue.ts";
import {
	failures,
	inspectOutput,
	NEXT_DEV_INSPECTION,
} from "../package/consumers/inspect.ts";
import { consumerDir } from "../package/consumers/paths.ts";
import { nextRouteFallbacks } from "../package/consumers/route-chunks.ts";

/**
 * Next.js App Router cells: the prerendered page hydrates without errors and shares one socket,
 * server and first client render agree, navigation releases and resubscribes
 * exactly once, prop changes never duplicate clients, and `next dev` settles
 * Strict Mode at one upstream per identity with inspectable dev output.
 */
const IDLE_CLOSE_MS = 5_000;
const HYDRATION = /hydrat|did not match/i;

const statusText = (page: import("@playwright/test").Page) =>
	page.getByTestId("status").textContent();

interface ActivityCommit {
	label: string;
	mount: number;
	data: number | undefined;
	handle: number | null;
	path: string;
}
interface ActivityLog {
	commits: ActivityCommit[];
	marks: { name: string; at: number }[];
}
type Page = import("@playwright/test").Page;

const activityLog = (page: Page): Promise<ActivityLog> =>
	page.evaluate(
		() =>
			(window as unknown as { __activity?: ActivityLog }).__activity ?? {
				commits: [],
				marks: [],
			},
	);
const countOf = async (page: Page, label: string): Promise<number> =>
	Number(await page.getByTestId(`count-${label}`).textContent());
/** The latest commit of `label` that exposed a handle. */
async function lastAttached(
	page: Page,
	label: string,
): Promise<ActivityCommit> {
	const commits = (await activityLog(page)).commits.filter(
		(commit) => commit.label === label && commit.handle !== null,
	);
	const last = commits.at(-1);
	if (!last) throw new Error(`no attached ${label} commit`);
	return last;
}
/** Records a mark at the current end of the commit log; returns its index. */
const markLog = (page: Page, name: string): Promise<number> =>
	page.evaluate((mark) => {
		const log = (window as unknown as { __activity: ActivityLog }).__activity;
		log.marks.push({ name: mark, at: log.commits.length });
		return log.commits.length;
	}, name);

/** The fixture's SSE tick interval (`rate=250`). */
const TICK_MS = 250;

/**
 * After a reveal at log index `from` (at `revealedAt`, test clock): the tree
 * was hidden, not remounted (same mount); its first commit shows `initial`
 * (0), not the held value; the released handle is never exposed again; and
 * the count then holds only events since the reveal, never a hidden-period
 * fold: no more ticks than the time since the reveal allows, nor more than
 * a still-visible witness received since then (slack 2 for delivery order).
 */
async function expectRevealRestarts(
	page: Page,
	label: string,
	before: ActivityCommit,
	from: number,
	revealedAt: number,
	witness?: { label: string; atReveal: number },
): Promise<void> {
	await expect
		.poll(async () =>
			(await activityLog(page)).commits
				.slice(from)
				.some((commit) => commit.label === label && commit.handle !== null),
		)
		.toBe(true);
	await expect.poll(() => countOf(page, label)).toBeGreaterThanOrEqual(2);
	const count = await countOf(page, label);
	const elapsed = Date.now() - revealedAt;
	const after = (await activityLog(page)).commits
		.slice(from)
		.filter((commit) => commit.label === label);
	expect(after[0]?.mount, `${label}: revealed, not remounted`).toBe(
		before.mount,
	);
	expect(after[0]?.data, `${label}: the first revealed commit`).toBe(0);
	expect(
		after.filter((commit) => commit.handle === before.handle),
		`${label}: the released handle is never exposed`,
	).toEqual([]);
	expect(count, `${label}: no hidden-period delta`).toBeLessThanOrEqual(
		Math.ceil(elapsed / TICK_MS) + 2,
	);
	if (witness) {
		const since = (await countOf(page, witness.label)) - witness.atReveal;
		expect(
			count,
			`${label}: no more than the witness since the reveal`,
		).toBeLessThanOrEqual(since + 2);
	}
}

/** manual <Activity>: hide `target` while events arrive, then reveal. */
async function activityToggle(page: Page): Promise<void> {
	await expect.poll(() => countOf(page, "target")).toBeGreaterThanOrEqual(2);
	const before = await lastAttached(page, "target");
	expect(before.data ?? 0).toBeGreaterThanOrEqual(2);
	await page.getByTestId("toggle").click();
	const hiddenAt = await countOf(page, "witness");
	// Events keep arriving while `target` is hidden.
	await expect
		.poll(() => countOf(page, "witness"))
		.toBeGreaterThanOrEqual(hiddenAt + 4);
	const from = await markLog(page, "before-reveal");
	const atReveal = await countOf(page, "witness");
	const revealedAt = Date.now();
	await page.getByTestId("toggle").click();
	await expectRevealRestarts(page, "target", before, from, revealedAt, {
		label: "witness",
		atReveal,
	});
}

describeCell(
	{
		id: "next-app-next-prod",
		consumer: "next-app",
		bundler: "next",
		mode: "prod",
		variant: "prod",
		frontPort: PORTS.next.prod,
		distDir: ".next",
		report: { bundler: "next", variant: "prod" },
	},
	(context) => {
		test("the prerendered page hydrates cleanly and two pages share one socket", async ({
			browser,
		}) => {
			const cell = context.cell();
			const run = newRun();
			const noScript = await browser.newContext({ javaScriptEnabled: false });
			let serverText: string | null;
			try {
				const page = await noScript.newPage();
				await page.goto(pageUrl(cell.origin, "/", run));
				serverText = await statusText(page);
			} finally {
				await noScript.close();
			}
			expect(serverText).toBe("inactive/server");

			const response = await fetch(`${cell.origin}/`);
			const policy = response.headers.get("content-security-policy") ?? "";
			await response.body?.cancel();
			expect(policy).toContain("worker-src 'self'");
			expect(policy).not.toContain("unsafe-eval");

			const browserContext = await browser.newContext();
			try {
				const result = await provePair({
					context: browserContext,
					cell,
					path: "/",
					run,
					proof: "ws",
					mode: "prod",
					scope: "alpha",
					fallback: context.report()?.fallback ?? [],
				});
				await expect.poll(async () => (await sseCounters(run)).active).toBe(1);
				expect((await sseCounters(run)).streams).toBe(1);
				for (const page of result.pages) {
					expect(
						await page.evaluate(() => window.__consumer?.firstRender ?? null),
					).toBe(serverText);
				}
				expect(result.pageErrors).toEqual([]);
				expect(
					result.consoleErrors.filter((line) => HYDRATION.test(line)),
				).toEqual([]);
				context.note({
					counters: result.counters,
					downloaded: { shared: result.downloaded },
				});
			} finally {
				await browserContext.close();
			}
		});

		test("local mode fetches the one-file module once, as the page's own chunk, and no worker chunk", async ({
			browser,
		}) => {
			const cell = context.cell();
			const fallback = context.report()?.fallback ?? [];
			const worker = context.report()?.worker ?? [];
			expect(fallback.length).toBeGreaterThan(0);
			expect(worker.length).toBeGreaterThan(0);
			const html = await (await fetch(`${cell.origin}/`)).text();
			const routeFallback = nextRouteFallbacks(
				html,
				(file) =>
					readFileSync(
						join(
							consumerDir("next-app"),
							context.report()?.out ?? ".next",
							file,
						),
						"utf8",
					),
				fallback,
			);
			expect(
				routeFallback.length,
				"this route's emitted lazy loader",
			).toBeGreaterThan(0);
			const otherRoutes = fallback.filter(
				(file) => !routeFallback.includes(file),
			);
			const browserContext = await browser.newContext();
			try {
				cell.front.reset();
				const { page, pageErrors } = await openProbePage(
					browserContext,
					pageUrl(cell.origin, "/", newRun(), { mode: "local" }),
				);
				const status = await waitForMode(page, "local");
				expect(status.reason).toBe("sharing-off");
				await waitForEvents(page, 2);
				const log = cell.log();
				for (const file of routeFallback) {
					expect(requestsFor(log, [file], "page"), file).toHaveLength(1);
				}
				expect(
					requestsFor(log, otherRoutes),
					"other routes' lazy modules remain unloaded",
				).toEqual([]);
				expect(requestsFor(log, worker)).toEqual([]);
				expect(pageErrors).toEqual([]);
				context.note({ downloaded: { local: downloadedBytes(log) } });
			} finally {
				await browserContext.close();
			}
		});

		test("navigation releases the subscription and returning resubscribes exactly once", async ({
			browser,
		}) => {
			const cell = context.cell();
			const browserContext = await browser.newContext();
			try {
				const run = newRun();
				const { page } = await openProbePage(
					browserContext,
					pageUrl(cell.origin, "/", run),
				);
				await waitForMode(page, "shared");
				await waitForEvents(page, 2);
				expect((await wsCounters(run)).opens).toBe(1);

				await page.getByTestId("to-other").click();
				await page.waitForURL(/\/other/);
				await expect
					.poll(async () => (await wsCounters(run)).active, {
						timeout: IDLE_CLOSE_MS + 2_000,
					})
					.toBe(0);

				await page.getByTestId("to-home").click();
				await page.waitForURL((url) => url.pathname === "/");
				await expect.poll(async () => (await wsCounters(run)).active).toBe(1);
				expect((await wsCounters(run)).opens).toBe(2);

				await page.goBack();
				await page.waitForURL(/\/other/);
				await page.goForward();
				await page.waitForURL((url) => url.pathname === "/");
				await expect.poll(async () => (await wsCounters(run)).active).toBe(1);
				const after = await wsCounters(run);
				expect(after.active).toBe(1);
				expect(after.opens).toBeLessThanOrEqual(3);
				expect(await page.evaluate(() => window.__consumer?.clients)).toBe(1);
				context.note({ counters: { navigation: after } });
			} finally {
				await browserContext.close();
			}
		});

		test("a useLive value inside <Activity> restarts at initial after reveal and never exposes the released handle", async ({
			browser,
		}) => {
			const browserContext = await browser.newContext();
			try {
				const { page, pageErrors } = await openProbePage(
					browserContext,
					pageUrl(context.cell().origin, "/activity", newRun()),
				);
				await activityToggle(page);
				expect(pageErrors).toEqual([]);
			} finally {
				await browserContext.close();
			}
		});

		test("scope changes resubscribe without duplicate clients or upstreams", async ({
			browser,
		}) => {
			const cell = context.cell();
			const browserContext = await browser.newContext();
			try {
				const run = newRun();
				const { page } = await openProbePage(
					browserContext,
					pageUrl(cell.origin, "/", run),
				);
				await waitForMode(page, "shared");
				await waitForEvents(page, 2);
				for (const scope of ["beta", "gamma", "delta"]) {
					await page.getByTestId("next-scope").click();
					await expect
						.poll(async () => (await wsCounters(run)).byScope[scope] ?? 0)
						.toBe(1);
					await expect
						.poll(async () => (await wsCounters(run)).active, {
							timeout: IDLE_CLOSE_MS + 2_000,
						})
						.toBe(1);
					expect(await page.evaluate(() => window.__consumer?.clients)).toBe(1);
				}
			} finally {
				await browserContext.close();
			}
		});
	},
);

describeCell(
	{
		id: "next-app-next-dev",
		consumer: "next-app",
		bundler: "next",
		mode: "dev",
		variant: "dev",
		frontPort: PORTS.next.dev,
		report: null,
	},
	(context) => {
		test("next dev settles Strict Mode at one socket and keeps unselected code out of dev chunks", async ({
			browser,
		}) => {
			const cell = context.cell();
			const response = await fetch(`${cell.origin}/`);
			const policy = response.headers.get("content-security-policy") ?? "";
			await response.body?.cancel();
			// React's development requirement, application policy.
			expect(policy).toContain("'unsafe-eval'");
			const browserContext = await browser.newContext();
			try {
				const result = await provePair({
					context: browserContext,
					cell,
					path: "/",
					run: newRun(),
					proof: "ws",
					mode: "dev",
					scope: "alpha",
					// Turbopack development chunk names are not stable build
					// outputs; fallback absence is asserted on production builds.
					fallback: [],
					recordWorkers: true,
				});
				expect(result.pageErrors).toEqual([]);
				// next-app is L2 (plugin-worker): the development wiring names
				// the worker after its file.
				expect(
					workerNameProblems(result.sharedWorkers, "dev"),
					"development SharedWorker name",
				).toEqual([]);
				expect(
					result.consoleErrors.filter((line) => HYDRATION.test(line)),
				).toEqual([]);
				const root = consumerDir("next-app");
				const report = inspectOutput({
					spec: consumer("next-app"),
					bundler: "next",
					variant: "dev",
					outDir: join(root, ".next"),
					// Only the dev output below `.next/dev`; the production
					// static/server of the same `.next` belong to the prod cells.
					dirs: [...NEXT_DEV_INSPECTION.dirs],
					serverDirs: [...NEXT_DEV_INSPECTION.serverDirs],
					installedDist: realpathSync(join(root, "node_modules/spinetab/dist")),
					// next.test.ts's positive-provenance options plus the dev
					// loader and chunk-list shapes, whose `[project]/…` module ids
					// must name files of this consumer root.
					installedFiles: [
						{
							root: realpathSync(join(root, "node_modules/next")),
							dir: "dist/build/polyfills",
						},
					],
					generatedShapes: [...NEXT_DEV_INSPECTION.generatedShapes],
					projectRoot: root,
					// Development output of a plugin cell: the development worker
					// name is allowed, and the local-path scan runs.
					development: true,
					consumerRoot: realpathSync(root),
				});
				writeFileSync(
					join(context.evidence(), "isolation-next-dev.json"),
					`${JSON.stringify(report, null, "\t")}\n`,
				);
				expect(report.chunks.length).toBeGreaterThan(0);
				expect(
					report.chunks.filter((chunk) => !chunk.chunk.startsWith("dev/")),
				).toEqual([]);
				expect(failures(report)).toEqual([]);
				expect(report.unmapped).toEqual([]);
				expect(report.serverMentions).toEqual([]);
				expect(report.plugin?.localPaths, "local paths").toEqual([]);
				expect(report.verdict).toBe("pass");
				context.note({
					counters: result.counters,
					notes: [
						`dev chunks inspected: ${report.chunks.length}`,
						...report.generated.map(
							(file) =>
								`generated ${file.chunk}: ${file.kind}${"shape" in file.provenance ? `/${file.provenance.shape}` : ""}`,
						),
					],
				});
			} finally {
				await browserContext.close();
			}
		});
	},
);

// Next 16 Cache Components preserves a route in <Activity> across a
// client navigation and reveals it on back-navigation; the same page's
// manual <Activity> toggle runs here too. Development only: the flag is a
// cell environment switch (`CONSUMER_CACHE_COMPONENTS=1`), never the
// production recipe, and its output lives in its own distDir.
describeCell(
	{
		id: "next-app-next-dev-cache-components",
		consumer: "next-app",
		bundler: "next",
		mode: "dev",
		variant: "dev-cache-components",
		frontPort: PORTS.next.dev,
		distDir: ".next-cache-components",
		env: { CONSUMER_CACHE_COMPONENTS: "1" },
		readyPath: "/activity",
		report: null,
	},
	(context) => {
		test("<Activity> hide and reveal restarts useLive at initial", async ({
			browser,
		}) => {
			const browserContext = await browser.newContext();
			try {
				const { page, pageErrors } = await openProbePage(
					browserContext,
					pageUrl(context.cell().origin, "/activity", newRun()),
				);
				await activityToggle(page);
				expect(pageErrors).toEqual([]);
			} finally {
				await browserContext.close();
			}
		});

		test("Cache Components back-navigation restarts useLive at initial and never exposes the released handle", async ({
			browser,
		}) => {
			const browserContext = await browser.newContext();
			try {
				const { page, pageErrors } = await openProbePage(
					browserContext,
					pageUrl(context.cell().origin, "/activity", newRun()),
				);
				await expect
					.poll(() => countOf(page, "target"))
					.toBeGreaterThanOrEqual(2);
				const target = await lastAttached(page, "target");
				const witness = await lastAttached(page, "witness");
				for (let bump = 0; bump < 2; bump += 1) {
					await page.getByTestId("bump").click();
				}
				await expect(page.getByTestId("bumps")).toHaveText("2");
				await page.getByTestId("to-activity-other").click();
				await page.waitForURL(/\/activity\/other/);
				// The same feed keeps arriving while /activity is hidden.
				await expect
					.poll(() => countOf(page, "other"))
					.toBeGreaterThanOrEqual(4);
				const from = await markLog(page, "before-back");
				const revealedAt = Date.now();
				await page.goBack();
				await page.waitForURL((url) => url.pathname === "/activity");
				// The route was preserved in <Activity>, not re-rendered fresh.
				await expect(page.getByTestId("bumps")).toHaveText("2");
				// hidden now, so the bound is the time since the reveal.
				for (const [label, before] of [
					["target", target],
					["witness", witness],
				] as const) {
					await expectRevealRestarts(page, label, before, from, revealedAt);
				}
				expect(pageErrors).toEqual([]);
				context.note({
					notes: [
						`back-navigation: target handle ${target.handle} released, witness handle ${witness.handle} released`,
					],
				});
			} finally {
				await browserContext.close();
			}
		});
	},
);

// The L1 escape hatch on both Next bundlers: Turbopack and `--webpack`.
for (const bundler of ["next", "next-webpack"] as const) {
	describeCell(
		{
			id: `next-ai-${bundler}-prod`,
			consumer: "next-ai",
			bundler,
			mode: "prod",
			variant: "prod",
			frontPort: PORTS[bundler].prod,
			distDir: bundler === "next" ? ".next" : ".next-webpack",
			report: { bundler, variant: "prod" },
		},
		(context) => {
			test("two tabs follow one AI generation from a real route handler", async ({
				browser,
			}) => {
				const browserContext = await browser.newContext();
				try {
					const result = await provePair({
						context: browserContext,
						cell: context.cell(),
						path: "/",
						run: newRun(),
						proof: "ai",
						mode: "prod",
						fallback: context.report()?.fallback ?? [],
					});
					expect(result.pageErrors).toEqual([]);
					context.note({
						counters: result.counters,
						downloaded: { shared: result.downloaded },
						notes: ["AI route: app/api/chat/route.ts (streamText, mock model)"],
					});
				} finally {
					await browserContext.close();
				}
			});
		},
	);
}
