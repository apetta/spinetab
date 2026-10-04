import { join } from "node:path";
import { build, type Rollup } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { packageRoot as pkg } from "./dist.ts";

async function bindingBundle(
	entry: string,
	mode: "production" | "development",
): Promise<string> {
	// Vitest runs with NODE_ENV=test and Vite's define follows it; a consumer's
	// `vite build` runs with production.
	vi.stubEnv("NODE_ENV", mode);
	const result = (await build({
		configFile: false,
		root: pkg,
		logLevel: "silent",
		mode,
		build: {
			write: false,
			minify: true,
			rolldownOptions: {
				input: join(pkg, entry),
				external: ["vue", "solid-js", "solid-js/web", "react", "svelte"],
				preserveEntrySignatures: "strict",
			},
		},
	})) as Rollup.RollupOutput | Rollup.RollupOutput[];
	const outputs = Array.isArray(result) ? result : [result];
	return outputs
		.flatMap((output) => output.output)
		.map((chunk) => (chunk.type === "chunk" ? chunk.code : ""))
		.join("\n");
}

afterEach(() => vi.unstubAllEnvs());

describe("published binding bundles", () => {
	for (const entry of ["dist/vue.js", "dist/solid.js"]) {
		it(`${entry}: production removes development warnings and process reads`, async () => {
			const code = await bindingBundle(entry, "production");
			expect(code.length).toBeGreaterThan(0);
			expect(code).not.toContain("call dispose() yourself");
			expect(code).not.toMatch(/\bprocess\b/);
			const development = await bindingBundle(entry, "development");
			expect(development).toContain("call dispose() yourself");
		}, 30_000);
	}
});
