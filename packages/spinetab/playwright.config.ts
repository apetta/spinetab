import { defineConfig, devices } from "@playwright/test";

// Counters are process-global; run test files serially.
const baseURL = "http://127.0.0.1:4500";
const isCI = Boolean(process.env.CI);

export default defineConfig({
	testDir: "./tests/browser",
	// Packed-consumer cells have their own config and servers.
	testIgnore: /consumers-.*\.spec\.ts$/,
	outputDir: "test-results/playwright/",
	timeout: 60_000,
	fullyParallel: false,
	workers: 1,
	forbidOnly: isCI,
	retries: isCI ? 1 : 0,
	reporter: [["list"], ["html", { open: "never" }]],
	use: { baseURL, trace: "on-first-retry", screenshot: "only-on-failure" },
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
