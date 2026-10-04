import { createRequire } from "node:module";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
	describeCell,
	newRun,
	openProbePage,
	pageUrl,
	recordSharedWorkers,
	sharedWorkersOf,
	sseCounters,
	waitForEvents,
	waitForMode,
} from "../package/consumers/browser.ts";
import { PORTS } from "../package/consumers/catalogue.ts";
import { consumerDir } from "../package/consumers/paths.ts";

// The ordinary Next app includes a real CommonJS client module. Both Next
// bundlers must apply browser wiring even when the root is reached by require.
for (const bundler of ["next", "next-webpack"] as const) {
	describeCell(
		{
			id: `next-app-${bundler}-cjs`,
			consumer: "next-app",
			bundler,
			mode: "prod",
			variant: "prod",
			frontPort:
				bundler === "next" ? PORTS.next.prod : PORTS["next-webpack"].prod,
			distDir: bundler === "next" ? ".next" : ".next-webpack",
			report: { bundler, variant: "prod" },
		},
		(context) => {
			for (const mode of ["shared", "local"] as const) {
				test(`CommonJS ${mode}: inert SSR, live values, sharing and cleanup`, async ({
					browser,
				}) => {
					const require = createRequire(
						join(consumerDir("next-app"), "app/cjs/live.cjs"),
					);
					expect(require.resolve("spinetab")).toMatch(/\/dist\/index\.cjs$/);
					expect(require.resolve("spinetab/react")).toMatch(
						/\/dist\/react\.cjs$/,
					);
					const cell = context.cell();
					const run = newRun();
					const url = pageUrl(
						cell.origin,
						"/cjs",
						run,
						mode === "local" ? { mode: "local" } : {},
					);
					const html = await (await fetch(url)).text();
					expect(html).toMatch(
						/<p data-testid="status">inactive(?:<!-- -->)?\/server<\/p>/,
					);
					expect((await sseCounters(run)).active).toBe(0);
					const browserContext = await browser.newContext();
					try {
						await recordSharedWorkers(browserContext);
						const firstProbe = await openProbePage(browserContext, url);
						const secondProbe = await openProbePage(browserContext, url);
						const states = [];
						for (const probe of [firstProbe, secondProbe]) {
							states.push(await waitForMode(probe.page, mode));
							await waitForEvents(probe.page, 2);
							await expect
								.poll(async () =>
									Number(await probe.page.getByTestId("tick").textContent()),
								)
								.toBeGreaterThan(0);
							if (mode === "shared")
								expect(await sharedWorkersOf(probe.page)).toHaveLength(1);
							else expect(await sharedWorkersOf(probe.page)).toEqual([]);
						}
						if (mode === "shared")
							expect(states[0]?.runtimeId).toBe(states[1]?.runtimeId);
						else expect(states[0]?.runtimeId).not.toBe(states[1]?.runtimeId);
						await expect
							.poll(async () => (await sseCounters(run)).active)
							.toBe(mode === "shared" ? 1 : 2);
						const first = firstProbe.page;
						const second = secondProbe.page;
						await first.getByTestId("stop").click();
						await expect(first.getByTestId("tick")).toHaveText("0");
						await expect
							.poll(async () => (await sseCounters(run)).active)
							.toBe(1);
						const before = Number(
							await second.getByTestId("tick").textContent(),
						);
						await expect
							.poll(async () =>
								Number(await second.getByTestId("tick").textContent()),
							)
							.toBeGreaterThan(before);
						await second.getByTestId("stop").click();
						await expect
							.poll(async () => (await sseCounters(run)).active, {
								timeout: 15_000,
							})
							.toBe(0);
						for (const probe of [firstProbe, secondProbe]) {
							expect(probe.pageErrors).toEqual([]);
							expect(probe.consoleErrors).toEqual([]);
						}
						context.note({ counters: await sseCounters(run) });
					} finally {
						await browserContext.close();
					}
				});
			}
		},
	);
}
