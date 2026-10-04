import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type BrowserContext, expect, test } from "@playwright/test";
import {
	baseNames,
	type CellContext,
	chunkRequests,
	describeCell,
	downloadedBytes,
	newRun,
	openProbePage,
	pageUrl,
	preloadsFor,
	requestsFor,
	sseCounters,
	waitForEvents,
	waitForMode,
} from "../package/consumers/browser.ts";
import {
	PORTS,
	STARTUP_REASONS,
	STATIC_CSP,
} from "../package/consumers/catalogue.ts";
import type { FrontOptions } from "../package/consumers/front.ts";

/**
 * CSP and asset failures on the Vite recipe build. Each failure row runs twice: the default policy falls back to
 * local mode with a documented startup reason, and `sharing: "require"` fails
 * with `sharing-unavailable` carrying the same reason, fetches no fallback
 * chunk and opens no upstream. The cross-origin worker row runs
 * with the Next CDN cell in consumers-base.spec.ts.
 *
 * The wrong-MIME row serves the worker as `text/plain` with
 * `X-Content-Type-Options: nosniff` (the front sends both for a `--mime`
 * override) and asserts the headers actually fetched and actually served to
 * the page before the mode assertions. Native controls: WebKit 26.6 runs a
 * module SharedWorker served as bare `text/plain` and rejects it with
 * `nosniff`; Chromium 153 and Firefox 155 reject it either way
 * in browser failure checks.
 */
const CONSUMER = "react-sse-tanstack";
const OUT = "out/vite-prod";
const PORT = PORTS.vite.prod;
const WORKER_BLOCKED = STATIC_CSP.replace(
	"worker-src 'self'",
	"worker-src 'none'",
);
const CONNECT_BLOCKED = STATIC_CSP.replace(
	"connect-src 'self'",
	"connect-src 'none'",
);

type Row = {
	id: string;
	front: (report: {
		worker: string[];
		fallback: string[];
	}) => Omit<FrontOptions, "port" | "static" | "upstream">;
	/** Response headers every worker script response must carry. */
	workerHeaders?: { contentType: string; contentTypeOptions: string };
};

const ROWS: Row[] = [
	{
		id: "worker-404",
		front: (report) => ({ csp: STATIC_CSP, drop: baseNames(report.worker) }),
	},
	{
		id: "worker-mime",
		front: (report) => ({
			csp: STATIC_CSP,
			mime: Object.fromEntries(
				baseNames(report.worker).map((file) => [file, "text/plain"]),
			),
		}),
		workerHeaders: { contentType: "text/plain", contentTypeOptions: "nosniff" },
	},
	{ id: "worker-csp", front: () => ({ csp: WORKER_BLOCKED }) },
];

interface WorkerResponse {
	via: "fetch" | "page";
	path: string;
	status: number;
	dest: string | null;
	contentType: string | null;
	contentTypeOptions: string | null;
}

/**
 * The worker scripts' headers, fetched over HTTP before the page opens (the
 * front log is reset afterwards, so later entries are the page's own).
 */
async function fetchedWorkerHeaders(
	context: CellContext,
	browserContext: BrowserContext,
): Promise<WorkerResponse[]> {
	const cell = context.cell();
	const workers = context.report()?.worker ?? [];
	expect(workers.length).toBeGreaterThan(0);
	const responses: WorkerResponse[] = [];
	for (const file of workers) {
		const response = await browserContext.request.get(
			`${cell.origin}/${file}?headers=${newRun()}`,
		);
		responses.push({
			via: "fetch",
			path: file,
			status: response.status(),
			dest: null,
			contentType: response.headers()["content-type"] ?? null,
			contentTypeOptions: response.headers()["x-content-type-options"] ?? null,
		});
	}
	cell.front.reset();
	return responses;
}

/** Worker script responses the front served to the page (at least one). */
async function servedWorkerHeaders(
	context: CellContext,
): Promise<WorkerResponse[]> {
	const cell = context.cell();
	const workers = context.report()?.worker ?? [];
	const served = () =>
		chunkRequests(cell.log(), workers).map(
			(request): WorkerResponse => ({
				via: "page",
				path: request.path,
				status: request.status,
				dest: request.dest,
				contentType: request.contentType,
				contentTypeOptions: request.contentTypeOptions,
			}),
		);
	await expect
		.poll(() => served().length, { timeout: 30_000 })
		.toBeGreaterThan(0);
	return served();
}

/** Evidence file and matrix note with the headers actually seen. */
function recordWorkerHeaders(
	context: CellContext,
	project: string,
	step: "prefer" | "require",
	responses: readonly WorkerResponse[],
): void {
	writeFileSync(
		join(context.evidence(), `worker-headers-${project}-${step}.json`),
		`${JSON.stringify(responses, null, "\t")}\n`,
	);
	context.note({
		counters: { [`workerHeaders-${step}`]: responses },
		notes: responses.map(
			(response) =>
				`${step} ${response.via} ${response.path}: ${response.status} content-type ${response.contentType}, x-content-type-options ${response.contentTypeOptions}`,
		),
	});
}

function expectWorkerHeaders(
	responses: readonly WorkerResponse[],
	expected: NonNullable<Row["workerHeaders"]>,
): void {
	expect(responses.length).toBeGreaterThan(0);
	for (const response of responses) {
		expect(response.status, response.path).toBe(200);
		expect(response.contentType, response.path).toBe(expected.contentType);
		expect(response.contentTypeOptions, response.path).toBe(
			expected.contentTypeOptions,
		);
	}
}

async function withContext<T>(
	browser: import("@playwright/test").Browser,
	action: (context: BrowserContext) => Promise<T>,
): Promise<T> {
	const context = await browser.newContext();
	try {
		return await action(context);
	} finally {
		await context.close();
	}
}

for (const row of ROWS) {
	describeCell(
		{
			id: `${CONSUMER}-vite-prod-${row.id}`,
			consumer: CONSUMER,
			bundler: "vite",
			mode: "prod",
			variant: row.id,
			frontPort: PORT,
			out: OUT,
			report: { bundler: "vite", variant: "prod" },
			frontFromReport: (report) => row.front(report),
		},
		(context: CellContext) => {
			test("prefer: falls back to local mode with a documented startup reason", async ({
				browser,
			}, testInfo) => {
				await withContext(browser, async (browserContext) => {
					const cell = context.cell();
					cell.front.reset();
					const fetched = row.workerHeaders
						? await fetchedWorkerHeaders(context, browserContext)
						: [];
					const run = newRun();
					const { page } = await openProbePage(
						browserContext,
						pageUrl(cell.origin, "/", run),
					);
					if (row.workerHeaders) {
						const served = await servedWorkerHeaders(context);
						recordWorkerHeaders(context, testInfo.project.name, "prefer", [
							...fetched,
							...served,
						]);
						expectWorkerHeaders(fetched, row.workerHeaders);
						expectWorkerHeaders(served, row.workerHeaders);
					}
					const current = await waitForMode(page, "local", 30_000);
					expect(STARTUP_REASONS).toContain(current.reason);
					await waitForEvents(page, 2);
					const fallback = context.report()?.fallback ?? [];
					expect(requestsFor(cell.log(), fallback, "page")).toHaveLength(
						fallback.length,
					);
					context.note({
						notes: [`${row.id} prefer: ${current.reason}`],
						downloaded: { [`${row.id}-local`]: downloadedBytes(cell.log()) },
					});
				});
			});

			test("require: fails with sharing-unavailable and the same reason, fetching no fallback", async ({
				browser,
			}, testInfo) => {
				await withContext(browser, async (browserContext) => {
					const cell = context.cell();
					cell.front.reset();
					const fetched = row.workerHeaders
						? await fetchedWorkerHeaders(context, browserContext)
						: [];
					const run = newRun();
					const { page } = await openProbePage(
						browserContext,
						pageUrl(cell.origin, "/", run, { sharing: "require" }),
					);
					if (row.workerHeaders) {
						const served = await servedWorkerHeaders(context);
						recordWorkerHeaders(context, testInfo.project.name, "require", [
							...fetched,
							...served,
						]);
						expectWorkerHeaders(fetched, row.workerHeaders);
						expectWorkerHeaders(served, row.workerHeaders);
					}
					const current = await waitForMode(page, "failed", 30_000);
					expect(STARTUP_REASONS).toContain(current.reason);
					expect(current.error?.code).toBe("sharing-unavailable");
					expect(
						(current.error?.detail as { reason?: string } | undefined)?.reason,
					).toBe(current.reason);
					await page.waitForTimeout(3_000);
					const fallback = context.report()?.fallback ?? [];
					expect(requestsFor(cell.log(), fallback, "page")).toEqual([]);
					expect(await preloadsFor(page, fallback)).toEqual([]);
					expect((await sseCounters(run)).streams).toBe(0);
					context.note({
						notes: [`${row.id} require: ${current.reason}`],
						downloaded: { [`${row.id}-require`]: downloadedBytes(cell.log()) },
					});
				});
			});
		},
	);
}

describeCell(
	{
		id: `${CONSUMER}-vite-prod-fallback-404`,
		consumer: CONSUMER,
		bundler: "vite",
		mode: "prod",
		variant: "fallback-404",
		frontPort: PORT,
		out: OUT,
		report: { bundler: "vite", variant: "prod" },
		frontFromReport: (report) => ({
			csp: STATIC_CSP,
			drop: baseNames(report.fallback),
		}),
	},
	(context) => {
		test("a missing fallback chunk fails once with its own reason and never retries in a loop", async ({
			browser,
		}) => {
			await withContext(browser, async (browserContext) => {
				const cell = context.cell();
				cell.front.reset();
				const { page } = await openProbePage(
					browserContext,
					pageUrl(cell.origin, "/", newRun(), { mode: "local" }),
				);
				const current = await waitForMode(page, "failed", 30_000);
				expect(current.reason).toBe("local-runtime-load-failed");
				await page.waitForTimeout(10_000);
				const fallback = context.report()?.fallback ?? [];
				for (const file of fallback) {
					expect(
						requestsFor(cell.log(), [file], "page").length,
					).toBeLessThanOrEqual(1);
				}
				context.note({ notes: [`fallback-404 local: ${current.reason}`] });
			});
		});

		test("require-sharing never touches the missing fallback", async ({
			browser,
		}) => {
			await withContext(browser, async (browserContext) => {
				const cell = context.cell();
				cell.front.reset();
				const { page } = await openProbePage(
					browserContext,
					pageUrl(cell.origin, "/", newRun(), { sharing: "require" }),
				);
				await waitForMode(page, "shared");
				await waitForEvents(page, 2);
				expect(
					requestsFor(cell.log(), context.report()?.fallback ?? [], "page"),
				).toEqual([]);
			});
		});
	},
);

describeCell(
	{
		id: `${CONSUMER}-vite-prod-worker-connect-csp`,
		consumer: CONSUMER,
		bundler: "vite",
		mode: "prod",
		variant: "worker-connect-csp",
		frontPort: PORT,
		out: OUT,
		report: { bundler: "vite", variant: "prod" },
		front: { csp: STATIC_CSP, workerCsp: CONNECT_BLOCKED },
	},
	(context) => {
		test("the worker follows its own response CSP; local mode follows the page's", async ({
			browser,
		}) => {
			await withContext(browser, async (browserContext) => {
				const cell = context.cell();
				cell.front.reset();
				const sharedRun = newRun();
				const shared = await openProbePage(
					browserContext,
					pageUrl(cell.origin, "/", sharedRun),
				);
				await waitForMode(shared.page, "shared");
				await shared.page.waitForTimeout(5_000);
				expect(
					await shared.page.evaluate(
						() => window.__consumer?.events.length ?? 0,
					),
				).toBe(0);
				expect((await sseCounters(sharedRun)).streams).toBe(0);
				const workerResponses = chunkRequests(
					cell.log(),
					context.report()?.worker ?? [],
				);
				expect(workerResponses.length).toBeGreaterThan(0);
				for (const response of workerResponses) {
					expect(response.csp).toBe(CONNECT_BLOCKED);
				}

				const localRun = newRun();
				const local = await openProbePage(
					browserContext,
					pageUrl(cell.origin, "/", localRun, { mode: "local" }),
				);
				await waitForMode(local.page, "local");
				await waitForEvents(local.page, 2);
				expect((await sseCounters(localRun)).streams).toBe(1);
				context.note({
					notes: [
						"worker connect-src 'none': shared blocked, local connected (mode-dependent policy)",
					],
				});
			});
		});
	},
);

describeCell(
	{
		id: `${CONSUMER}-vite-prod-fallback-once`,
		consumer: CONSUMER,
		bundler: "vite",
		mode: "prod",
		variant: "fallback-once",
		frontPort: PORT,
		out: OUT,
		report: { bundler: "vite", variant: "prod" },
		front: { csp: STATIC_CSP },
	},
	(context) => {
		test("the fallback chunk is fetched once per local page and never while shared", async ({
			browser,
		}) => {
			const cell = context.cell();
			const workers = baseNames(context.report()?.worker ?? []);
			const fallback = context.report()?.fallback ?? [];
			// A fresh context per step: an existing SharedWorker instance would be
			// reused without fetching its script, hiding a dropped asset.
			const steps: Array<{ drop: boolean; mode: string }> = [
				{ drop: false, mode: "shared" },
				{ drop: true, mode: "local" },
				{ drop: false, mode: "shared" },
				{ drop: true, mode: "local" },
			];
			for (const step of steps) {
				cell.front.drop(workers, !step.drop);
				cell.front.reset();
				await withContext(browser, async (browserContext) => {
					const { page } = await openProbePage(
						browserContext,
						pageUrl(cell.origin, "/", newRun()),
					);
					await waitForMode(page, step.mode);
					await waitForEvents(page, 2);
					await page.waitForTimeout(1_000);
					expect(requestsFor(cell.log(), fallback, "page")).toHaveLength(
						step.mode === "local" ? fallback.length : 0,
					);
					expect(await preloadsFor(page, fallback)).toEqual([]);
				});
			}
			cell.front.drop(workers, true);
		});
	},
);
