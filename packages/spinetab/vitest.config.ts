import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		name: "spinetab",
		environment: "node",
		globals: false,
		include: ["tests/**/*.test.ts"],
		clearMocks: true,
		restoreMocks: true,
	},
});
