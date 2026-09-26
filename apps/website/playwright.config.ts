import { defineConfig, devices } from "@playwright/test";

const port = 4322;
const baseURL = `http://127.0.0.1:${port}`;
const isCI = Boolean(process.env.CI);

export default defineConfig({
	testDir: "./e2e",
	outputDir: "test-results/",
	timeout: 30_000,
	fullyParallel: true,
	forbidOnly: isCI,
	retries: isCI ? 2 : 0,
	workers: isCI ? 1 : undefined,
	reporter: [["list"], ["html", { open: "never" }]],
	use: { baseURL, trace: "on-first-retry", screenshot: "only-on-failure" },
	projects: [
		{ name: "chromium", use: { ...devices["Desktop Chrome"] } },
		{ name: "firefox", use: { ...devices["Desktop Firefox"] } },
		{ name: "webkit", use: { ...devices["Desktop Safari"] } },
	],
	webServer: {
		// Playwright owns this foreground process; leave other Astro previews alone.
		command: `pnpm start --port ${port} --ignore-lock`,
		url: baseURL,
		reuseExistingServer: false,
		timeout: 120_000,
		stdout: "pipe",
		stderr: "pipe",
	},
});
