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
		],
	},
});
