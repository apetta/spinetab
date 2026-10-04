import { defineConfig } from "vitest/config";

// Package self-imports resolve to their sources under test.
const alias = {
	"spinetab/wiring": new URL("./src/wiring.ts", import.meta.url).pathname,
	"spinetab/worker-config": new URL("./src/worker-config.ts", import.meta.url)
		.pathname,
};

const common = {
	globals: false,
	clearMocks: true,
	restoreMocks: true,
} as const;

export default defineConfig({
	test: {
		projects: [
			{
				resolve: { alias },
				test: {
					...common,
					name: "unit",
					environment: "node",
					include: ["tests/unit/**/*.test.ts"],
				},
			},
			{
				resolve: { alias },
				test: {
					...common,
					name: "integration",
					environment: "node",
					include: ["tests/integration/**/*.test.ts"],
					globalSetup: ["tests/fixtures/servers/global-setup.ts"],
					testTimeout: 20_000,
					hookTimeout: 30_000,
				},
			},
			{
				// Framework bindings: real framework runtimes on a DOM shim.
				resolve: { conditions: ["browser"], alias },
				test: {
					...common,
					name: "dom",
					environment: "happy-dom",
					include: ["tests/dom/**/*.test.{ts,tsx}"],
				},
			},
			{
				// Packed artefact, export resolution, isolation and consumer builds.
				// Expects an existing `dist/`; run through root Turbo for ordering.
				test: {
					...common,
					name: "package",
					environment: "node",
					include: ["tests/package/**/*.test.ts"],
					exclude: ["tests/package/consumers/**"],
					testTimeout: 600_000,
					hookTimeout: 600_000,
				},
			},
			{
				// Packed consumers (Vite/Next/webpack/Rspack): installs, builds,
				// isolation and declaration checks in an out-of-tree work root.
				// Run after `pnpm consumers:prepare`; never in parallel with builds.
				test: {
					...common,
					name: "consumers",
					environment: "node",
					include: ["tests/package/consumers/**/*.test.ts"],
					fileParallelism: false,
					testTimeout: 900_000,
					hookTimeout: 900_000,
				},
			},
		],
	},
});
