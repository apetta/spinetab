import { defineConfig } from "@playwright/test";
import packageConfig from "./playwright.config.ts";

// Browser engine observations are opt-in and do not establish package acceptance.
export default defineConfig({
	...packageConfig,
	testDir: "./tests/diagnostics",
	outputDir: "test-results/diagnostics/",
	retries: 0,
});
