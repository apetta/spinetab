import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
	baseNames,
	buildReport,
	describeCell,
	newRun,
	openProbePage,
	pageUrl,
	requestsFor,
	sseCounters,
	status,
	waitForEvents,
	waitForMode,
} from "../package/consumers/browser.ts";
import { PORTS, STATIC_CSP } from "../package/consumers/catalogue.ts";
import { consumerDir } from "../package/consumers/paths.ts";

/**
 * Deployments (Vite production). Two builds with different worker
 * hashes are served from one origin: v1 at `/`, v2 at `/v2/`. Old and new
 * pages run separate worker instances with duplicate upstreams and both stay
 * shared. When v1's worker and fallback assets are gone, a new v1 page gets a
 * startup reason and requests each missing asset at most once.
 */
const CONSUMER = "react-sse-tanstack";

describeCell(
	{
		id: `${CONSUMER}-vite-deployments`,
		consumer: CONSUMER,
		bundler: "vite",
		mode: "prod",
		variant: "deployments",
		frontPort: PORTS.vite.prod,
		out: "out/vite-prod",
		front: {
			csp: STATIC_CSP,
			overlay: join(consumerDir(CONSUMER), "out/vite-deploy-v2"),
		},
		report: { bundler: "vite", variant: "prod" },
	},
	(context) => {
		test("old and new deployments run separate workers and stay shared", async ({
			browser,
		}) => {
			const cell = context.cell();
			const v2 = buildReport(CONSUMER, "vite", "deploy-v2");
			const v1 = context.report();
			expect(baseNames(v2.worker)).not.toEqual(baseNames(v1?.worker ?? []));
			const browserContext = await browser.newContext();
			try {
				const run = newRun();
				const old = await openProbePage(
					browserContext,
					pageUrl(cell.origin, "/", run),
				);
				const next = await openProbePage(
					browserContext,
					pageUrl(cell.origin, "/v2/", run),
				);
				const first = await waitForMode(old.page, "shared");
				const second = await waitForMode(next.page, "shared");
				expect(first.runtimeId).toBeDefined();
				expect(second.runtimeId).toBeDefined();
				expect(first.runtimeId).not.toBe(second.runtimeId);
				await waitForEvents(old.page, 2);
				await waitForEvents(next.page, 2);
				await expect.poll(async () => (await sseCounters(run)).active).toBe(2);
				await old.page.waitForTimeout(10_000);
				for (const page of [old.page, next.page]) {
					expect((await status(page))?.mode).toBe("shared");
				}
				expect(
					requestsFor(cell.log(), v1?.worker ?? []).length,
				).toBeGreaterThan(0);
				expect(requestsFor(cell.log(), v2.worker).length).toBeGreaterThan(0);
				context.note({
					counters: { deployments: await sseCounters(run) },
					notes: [`runtime ids ${first.runtimeId} / ${second.runtimeId}`],
				});
			} finally {
				await browserContext.close();
			}
		});

		test("a missing old worker and fallback give a startup reason, not a restart loop", async ({
			browser,
		}) => {
			const cell = context.cell();
			const v1 = context.report();
			const missing = [...(v1?.worker ?? []), ...(v1?.fallback ?? [])];
			cell.front.drop(baseNames(missing));
			cell.front.reset();
			// A fresh context has no running v1 worker instance to reuse.
			const browserContext = await browser.newContext();
			try {
				const { page } = await openProbePage(
					browserContext,
					pageUrl(cell.origin, "/", newRun()),
				);
				const current = await waitForMode(page, "failed", 30_000);
				expect(current.reason).toBe("local-runtime-load-failed");
				await page.waitForTimeout(10_000);
				for (const file of missing) {
					expect(
						requestsFor(cell.log(), [file]).length,
						file,
					).toBeLessThanOrEqual(1);
				}
				expect((await status(page))?.mode).toBe("failed");
				context.note({ notes: [`missing v1 assets: ${current.reason}`] });
			} finally {
				cell.front.drop(baseNames(missing), true);
				await browserContext.close();
			}
		});
	},
);
