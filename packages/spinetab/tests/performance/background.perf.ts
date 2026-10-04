import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, test as base, expect } from "@playwright/test";
import type {
	BenchWindow,
	LatencySample,
} from "../fixtures/harness/src/bench/types.ts";
import {
	ALL_TOPICS,
	calibrateRealm,
	checkCalibration,
	clearFault,
	now,
	openPage,
	recordEnvironment,
	resetFixture,
	setFault,
	settings,
	sleep,
	startPage,
	VARIANTS,
	waitForCounts,
} from "./lib/bench.ts";
import { HOST_RESOLVER_RULES } from "./lib/launch.ts";
import { withRecord } from "./lib/record.ts";
import { nearestRank, summarise } from "./lib/stats.ts";

// Background latency needs native visibility, not Playwright's default focus
// emulation. A fresh owned Chromium profile is attached with noDefaults, and
// only its default context is used. No background-throttling switches are
// added. Hidden visibility and hidden callbacks are required below; invalid
// clock calibration remains unmeasured. This file is informational only.

type W = BenchWindow;
const S = settings();
const test = base.extend<{ nativeBrowser: Browser }>({
	nativeBrowser: async ({ playwright, browserName }, use) => {
		if (browserName !== "chromium")
			throw new Error("Native background measurements require Chromium");
		const profile = mkdtempSync(join(tmpdir(), "spinetab-background-"));
		const chrome = spawn(
			playwright.chromium.executablePath(),
			[
				`--user-data-dir=${profile}`,
				"--remote-debugging-port=0",
				"--no-first-run",
				"--no-default-browser-check",
				"--enable-automation",
				"--disable-background-networking",
				"--no-startup-window",
				HOST_RESOLVER_RULES,
			],
			{ stdio: "ignore" },
		);
		let browser: Browser | undefined;
		try {
			const activePort = join(profile, "DevToolsActivePort");
			const deadline = Date.now() + 30_000;
			while (!existsSync(activePort)) {
				if (Date.now() >= deadline || chrome.exitCode !== null)
					throw new Error("Owned native Chromium failed to start");
				await sleep(100);
			}
			const port = readFileSync(activePort, "utf8").split("\n")[0];
			browser = await playwright.chromium.connectOverCDP(
				`http://127.0.0.1:${port}`,
				{ noDefaults: true },
			);
			await use(browser);
		} finally {
			try {
				await browser?.close();
			} finally {
				if (chrome.exitCode === null && chrome.signalCode === null) {
					chrome.kill("SIGTERM");
					await new Promise<void>((resolve) => {
						const deadline = setTimeout(() => {
							chrome.kill("SIGKILL");
							resolve();
						}, 5_000);
						chrome.once("exit", () => {
							clearTimeout(deadline);
							resolve();
						});
					});
				}
				rmSync(profile, { recursive: true, force: true });
			}
		}
	},
});

test.use({ headless: false });

test.describe("background tab", () => {
	for (const variant of VARIANTS) {
		test(
			`background latency ${variant}`,
			{ tag: ["@background"] },
			async ({ nativeBrowser: browser, browserName, request }, testInfo) => {
				test.skip(browserName !== "chromium", "headed Chromium row only");
				test.setTimeout(180_000);
				await recordEnvironment(browser, testInfo);
				await resetFixture(request);
				await withRecord(
					testInfo,
					{
						scenario: "tabs",
						config: `background-${variant}`,
						expected: [`latency.${variant}.background.cross.p95`],
					},
					async (out, detail) => {
						const context = browser.contexts()[0];
						if (!context) throw new Error("Native default context is missing");
						try {
							const front = await openPage(context, "spinetab");
							const back = await openPage(context, "spinetab");
							for (const page of [front, back]) {
								await startPage(page, { variant });
								await page.evaluate(
									(topics) => (window as unknown as W).bench.subscribe(topics),
									ALL_TOPICS,
								);
							}
							await waitForCounts(request, variant, 1, 100);
							// Calibration uses short spaced timers: measure it while visible,
							// outside the window, without disabling native background throttling.
							await back.bringToFront();
							await expect
								.poll(() => back.evaluate(() => document.visibilityState))
								.toBe("visible");
							await setFault(request, "pause");
							const before = await calibrateRealm(back, S.calibrationSamples);
							await clearFault(request, "pause");
							await front.bringToFront();
							await expect
								.poll(() => back.evaluate(() => document.visibilityState))
								.toBe("hidden");
							await sleep(S.warmupMs);
							const from = await now(back);
							await sleep(S.windowMs);
							const to = await now(back);
							detail.visibility = await back.evaluate(
								() => document.visibilityState,
							);
							await setFault(request, "pause");
							await back.bringToFront();
							await expect
								.poll(() => back.evaluate(() => document.visibilityState))
								.toBe("visible");
							const after = await calibrateRealm(back, S.calibrationSamples);
							await clearFault(request, "pause");
							const check = checkCalibration(before, after);
							const sample: LatencySample = await back.evaluate(
								([start, end, cross]) =>
									(window as unknown as W).bench.latency(
										start,
										end,
										cross,
										null,
										true,
									),
								[from, to, check.valid ? check.offset : null] as const,
							);
							detail.calibration = { before, after, check };
							detail.latency = {
								cross: summarise(sample.cross),
								hidden: sample.hidden,
							};
							expect(
								detail.visibility,
								"measurement tab stayed hidden through the window",
							).toBe("hidden");
							expect(
								sample.hidden,
								"callbacks were recorded in the background",
							).toBeGreaterThan(0);
							if (check.valid) {
								expect(
									sample.cross.length,
									"paired background callbacks",
								).toBeGreaterThan(0);
								expect(
									sample.hidden,
									"all measured callbacks were hidden",
								).toBe(sample.paired + sample.unpaired);
							}
							out.put(
								`latency.${variant}.background.cross.p95`,
								nearestRank(sample.cross, 95),
								check.valid
									? "no paired background samples"
									: `calibration invalid: ${check.reasons.join("; ")}`,
							);
						} finally {
							await context.close();
						}
					},
				);
			},
		);
	}
});
