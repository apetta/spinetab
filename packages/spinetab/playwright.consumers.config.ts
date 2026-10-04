import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

// Packed-consumer cells (Vite, Next App Router on Turbopack and `--webpack`,
// webpack, Rspack and Astro, in development and production). Each cell starts its own front/upstream servers from the spec (ports
// in `catalogue.ts`: next-webpack 4650–4652, astro 4660–4662); the fixture
// servers on 4500/4501 are shared. The plugin and control cells live in
// `consumers-plugin.spec.ts`, matched by the pattern below. Requires
// `pnpm consumers:prepare` and `pnpm test:consumers` to have built the cells.
const baseURL = "http://127.0.0.1:4500";
const isCI = Boolean(process.env.CI);
// Every invocation gets fresh evidence, including repeats of the same archive.
const runId = process.env.SPINETAB_CONSUMERS_RUN_ID ?? randomUUID();
process.env.SPINETAB_CONSUMERS_RUN_ID = runId;
const runDir = join("test-results/consumers", runId);

export default defineConfig({
	testDir: "./tests/browser",
	testMatch: /consumers-.*\.spec\.ts$/,
	outputDir: join(runDir, "playwright"),
	timeout: 120_000,
	fullyParallel: false,
	workers: 1,
	forbidOnly: isCI,
	retries: 0,
	reporter: [
		["list"],
		["html", { open: "never", outputFolder: join(runDir, "report") }],
		["./tests/package/consumers/matrix-reporter.ts"],
	],
	use: { baseURL, trace: "retain-on-failure", screenshot: "only-on-failure" },
	projects: [
		{ name: "chromium", use: { ...devices["Desktop Chrome"] } },
		{ name: "firefox", use: { ...devices["Desktop Firefox"] } },
		{ name: "webkit", use: { ...devices["Desktop Safari"] } },
	],
	webServer: {
		command: "node tests/fixtures/servers/start.ts",
		url: `${baseURL}/__fixture/counters`,
		reuseExistingServer: !isCI,
		timeout: 60_000,
		stdout: "pipe",
		stderr: "pipe",
	},
});
