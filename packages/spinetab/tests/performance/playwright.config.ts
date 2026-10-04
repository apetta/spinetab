import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { artefactDir, packageRoot, rep, runId } from "./lib/evidence.ts";
import { chromiumArgs } from "./lib/launch.ts";

// Uses fixture ports 4500/4501; do not run alongside pnpm e2e. The pinned profile gates timing and heap; smoke gates structural results only.

const baseURL = "http://127.0.0.1:4500";
const isCI = Boolean(process.env.CI);
const smoke = process.env.SPINETAB_PERF_PROFILE === "smoke";
const results = artefactDir(runId());

export default defineConfig({
	testDir: ".",
	testMatch: /.*\.perf\.ts$/,
	outputDir: join(results, `artifacts-rep${rep()}`),
	// Long scenarios set their own timeouts; this bounds the rest.
	timeout: 10 * 60_000,
	fullyParallel: false,
	workers: 1,
	forbidOnly: isCI,
	// A retried measurement is a different measurement: never retry.
	retries: 0,
	reporter: [
		["list"],
		["json", { outputFile: join(results, `report-rep${rep()}.json`) }],
	],
	use: { baseURL, trace: "off", screenshot: "off", video: "off" },
	projects: [
		{
			name: "chromium-perf",
			use: {
				...devices["Desktop Chrome"],
				launchOptions: { args: chromiumArgs() },
			},
		},
		{
			// Counts, outcomes and informational timings; heap/CPU "not measured".
			name: "firefox-functional",
			use: { ...devices["Desktop Firefox"] },
			grepInvert: /@attribution|@probe|@background/,
		},
		{
			name: "webkit-functional",
			use: { ...devices["Desktop Safari"] },
			grepInvert: /@attribution|@probe|@background/,
		},
	],
	webServer: {
		command: "node tests/fixtures/servers/start.ts",
		cwd: packageRoot,
		url: `${baseURL}/__fixture/counters`,
		// The pinned profile owns the fixture process so its CPU is attributable.
		reuseExistingServer: smoke ? !isCI : false,
		timeout: 60_000,
		stdout: "pipe",
		stderr: "pipe",
	},
});
