import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
	type CellContext,
	chunkRequests,
	describeCell,
	downloadedBytes,
	newRun,
	openProbePage,
	pageUrl,
	provePair,
	requestsFor,
	streamCounters,
	waitForEvents,
	waitForMode,
} from "../package/consumers/browser.ts";
import {
	consumer,
	localModule,
	PORTS,
	STATIC_CSP,
} from "../package/consumers/catalogue.ts";
import { consumerDir } from "../package/consumers/paths.ts";

/**
 * Recipe matrix: the React recipe app on Vite, webpack and Rspack,
 * production and development, from the packed tarball. Two pages share one
 * SSE stream and one NDJSON stream in the worker, under a strict
 * same-origin CSP in production; React Strict Mode settles at one
 * upstream per identity in development; the lazy fallback chunk
 * is fetched only in local mode, exactly once.
 */
const CONSUMER = "react-sse-tanstack";
const BUNDLERS = ["vite", "webpack", "rspack"] as const;

const workerRequests = (context: CellContext) =>
	chunkRequests(context.cell().log(), context.report()?.worker ?? []);

for (const bundler of BUNDLERS) {
	describeCell(
		{
			id: `${CONSUMER}-${bundler}-prod`,
			consumer: CONSUMER,
			bundler,
			mode: "prod",
			variant: "prod",
			frontPort: PORTS[bundler].prod,
			out: `out/${bundler}-prod`,
			front: { csp: STATIC_CSP },
		},
		(context) => {
			test("two pages share one SSE and one stream request under a strict CSP", async ({
				browser,
			}) => {
				const browserContext = await browser.newContext();
				try {
					const run = newRun();
					const result = await provePair({
						context: browserContext,
						cell: context.cell(),
						path: "/",
						run,
						proof: "sse",
						mode: "prod",
						fallback: context.report()?.fallback ?? [],
						recordWorkers: true,
					});
					expect(result.sharedWorkers).toHaveLength(2);
					// An omitted constructor type uses the browser's classic default.
					expect(
						result.sharedWorkers.map((worker) => worker.type ?? "classic"),
					).toEqual(
						bundler === "vite" ? ["module", "module"] : ["classic", "classic"],
					);
					if (bundler !== "vite") {
						for (const file of context.report()?.worker ?? []) {
							expect(
								readFileSync(
									join(consumerDir(CONSUMER), `out/${bundler}-prod`, file),
									"utf8",
								),
							).toMatch(/\bimportScripts\s*\(/);
						}
					}
					// The policy is on the actual document and worker responses.
					const documentRequest = result.log.requests.find((request) =>
						request.path.startsWith("/?run="),
					);
					expect(documentRequest?.csp).toBe(STATIC_CSP);
					const workers = workerRequests(context);
					expect(workers.length).toBeGreaterThan(0);
					for (const worker of workers) expect(worker.csp).toBe(STATIC_CSP);
					// Two adapters in one worker graph: one NDJSON read.
					for (const page of result.pages) {
						await expect
							.poll(() =>
								page.evaluate(
									() => (window.__consumer?.extra?.lines as unknown[]).length,
								),
							)
							.toBeGreaterThan(0);
					}
					const stream = await streamCounters(run);
					expect(stream.requests.GET, "one shared NDJSON request").toBe(1);
					expect(result.pageErrors).toEqual([]);
					context.note({
						counters: { sse: result.counters, stream: stream.requests },
						downloaded: { shared: result.downloaded },
					});
				} finally {
					await browserContext.close();
				}
			});

			test("local mode loads the fallback chunk exactly once and never in shared mode", async ({
				browser,
			}) => {
				const browserContext = await browser.newContext();
				try {
					const cell = context.cell();
					const fallback = context.report()?.fallback ?? [];
					expect(fallback.length).toBeGreaterThan(0);
					cell.front.reset();
					const { page } = await openProbePage(
						browserContext,
						pageUrl(cell.origin, "/", newRun(), { mode: "local" }),
					);
					const status = await waitForMode(page, "local");
					expect(status.reason).toBe("sharing-off");
					await waitForEvents(page, 2);
					await page.waitForTimeout(2_000);
					const log = cell.log();
					expect(requestsFor(log, fallback, "page")).toHaveLength(
						fallback.length,
					);
					expect(requestsFor(log, context.report()?.worker ?? [])).toEqual([]);
					context.note({ downloaded: { local: downloadedBytes(log) } });
				} finally {
					await browserContext.close();
				}
			});
		},
	);

	describeCell(
		{
			id: `${CONSUMER}-${bundler}-dev`,
			consumer: CONSUMER,
			bundler,
			mode: "dev",
			variant: "dev",
			frontPort: PORTS[bundler].dev,
			report: bundler === "vite" ? null : { bundler, variant: "dev" },
		},
		(context) => {
			test("the dev server shares one upstream per identity under Strict Mode", async ({
				browser,
			}) => {
				const browserContext = await browser.newContext();
				try {
					const result = await provePair({
						context: browserContext,
						cell: context.cell(),
						path: "/",
						run: newRun(),
						proof: "sse",
						mode: "dev",
						fallback:
							bundler === "vite"
								? [localModule(consumer(CONSUMER))]
								: (context.report()?.fallback ?? []),
					});
					expect(result.pageErrors).toEqual([]);
					context.note({
						counters: result.counters,
						downloaded: { shared: result.downloaded },
					});
				} finally {
					await browserContext.close();
				}
			});
		},
	);
}
