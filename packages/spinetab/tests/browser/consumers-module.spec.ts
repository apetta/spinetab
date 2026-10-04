import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
	describeCell,
	newRun,
	openProbePage,
	pageUrl,
	provePair,
	requestsFor,
	waitForEvents,
	waitForMode,
} from "../package/consumers/browser.ts";
import { consumer, PORTS, STATIC_CSP } from "../package/consumers/catalogue.ts";
import { consumerDir } from "../package/consumers/paths.ts";

const spec = consumer("react-sse-tanstack");

// Module output uses native module workers and imports, rather than the
// classic worker loader used by these bundlers' default output. Exercise
// both realms with the real React/Query consumer and its packed dependency.
for (const bundler of ["webpack", "rspack"] as const) {
	describeCell(
		{
			id: `${spec.name}-${bundler}-module`,
			consumer: spec.name,
			bundler,
			mode: "prod",
			variant: "module",
			frontPort: PORTS[bundler].prod,
			out: `out/${bundler}-module`,
			front: { csp: STATIC_CSP },
		},
		(context) => {
			test.skip(
				process.env.SPINETAB_CONSUMERS_FULL !== "1",
				"module output builds are prepared by the full consumer run",
			);
			test("module workers share SSE and stream updates under a strict CSP", async ({
				browser,
			}) => {
				const browserContext = await browser.newContext();
				try {
					const result = await provePair({
						context: browserContext,
						cell: context.cell(),
						path: "/",
						run: newRun(),
						proof: spec.proof,
						mode: "prod",
						fallback: context.report()?.fallback ?? [],
						recordWorkers: true,
					});
					expect(result.pageErrors).toEqual([]);
					expect(result.consoleErrors).toEqual([]);
					expect(result.sharedWorkers).toHaveLength(2);
					expect(result.sharedWorkers.map((worker) => worker.type)).toEqual([
						"module",
						"module",
					]);
					for (const page of result.pages) {
						await expect(page.getByTestId("ticks")).toContainText(/\d/);
						await expect
							.poll(() =>
								page.evaluate(
									() =>
										(
											globalThis as {
												__consumer?: { extra: { lines: unknown[] } };
											}
										).__consumer?.extra.lines.length ?? 0,
								),
							)
							.toBeGreaterThanOrEqual(2);
					}
					for (const file of context.report()?.worker ?? []) {
						const code = readFileSync(
							join(consumerDir(spec.name), `out/${bundler}-module`, file),
							"utf8",
						);
						expect(
							code,
							"module worker does not use a classic loader",
						).not.toMatch(/\bimportScripts\s*\(/);
					}
					context.note({ counters: result.counters });
				} finally {
					await browserContext.close();
				}
			});

			test("local mode imports the fallback once and fetches no worker", async ({
				browser,
			}) => {
				const browserContext = await browser.newContext();
				try {
					const cell = context.cell();
					const fallback = context.report()?.fallback ?? [];
					expect(fallback.length).toBeGreaterThan(0);
					cell.front.reset();
					const { page, pageErrors } = await openProbePage(
						browserContext,
						pageUrl(cell.origin, "/", newRun(), { mode: "local" }),
					);
					expect((await waitForMode(page, "local")).reason).toBe("sharing-off");
					await waitForEvents(page, 2);
					expect(pageErrors).toEqual([]);
					expect(requestsFor(cell.log(), fallback, "page")).toHaveLength(
						fallback.length,
					);
					expect(
						requestsFor(cell.log(), context.report()?.worker ?? []),
					).toEqual([]);
				} finally {
					await browserContext.close();
				}
			});
		},
	);
}
