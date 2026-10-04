import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.WEBSITE_TEST_PORT ?? 4322);
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
		{ name: "content", testMatch: "recipes-http.spec.ts" },
		{
			name: "chromium",
			testIgnore: "recipes-http.spec.ts",
			use: { ...devices["Desktop Chrome"] },
		},
		{
			name: "firefox",
			testIgnore: "recipes-http.spec.ts",
			use: { ...devices["Desktop Firefox"] },
		},
		{
			name: "webkit",
			testIgnore: "recipes-http.spec.ts",
			use: { ...devices["Desktop Safari"] },
		},
	],
	webServer: {
		command: `pnpm start --port ${port} --ignore-lock`,
		url: baseURL,
		reuseExistingServer: false,
		timeout: 120_000,
		stdout: "pipe",
		stderr: "pipe",
	},
});
