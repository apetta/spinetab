import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const packageRoot = new URL("../../", import.meta.url);
const manifest = JSON.parse(
	await readFile(new URL("package.json", packageRoot), "utf8"),
) as {
	exports: Record<
		string,
		{
			import: { types: string; default: string };
			require?: { types: string; default: string };
		}
	>;
};

describe("built package entry points", () => {
	it("preserves the React client boundary without marking other entries", async () => {
		for (const [subpath, conditions] of Object.entries(manifest.exports)) {
			for (const condition of Object.values(conditions)) {
				const output = await readFile(
					new URL(condition.default, packageRoot),
					"utf8",
				);
				// Directives must stay in the prologue, before imports or code.
				const hasClientDirective =
					/^\s*(?:["']use strict["'];?\s*)?["']use client["'];/.test(output);
				expect(hasClientDirective, `${subpath}: ${condition.default}`).toBe(
					subpath === "./react",
				);
			}
		}
	});

	it("exposes the PRD subpaths without obsolete server, channel or devtools entries", () => {
		expect(Object.keys(manifest.exports).sort()).toEqual(
			[
				".",
				"./worker",
				"./websocket",
				"./sse",
				"./stream",
				"./polling",
				"./graphql-ws",
				"./graphql-sse",
				"./socket-io",
				"./apollo",
				"./tanstack-query",
				"./swr",
				"./trpc",
				"./ai-sdk",
				"./react",
				"./vue",
				"./svelte",
				"./solid",
			].sort(),
		);
	});

	for (const [subpath, conditions] of Object.entries(manifest.exports)) {
		const specifier =
			subpath === "." ? "spinetab" : `spinetab/${subpath.slice(2)}`;

		it(`${specifier} resolves in its declared formats without browser globals`, async () => {
			// Use a child Node process for ESM and native require for CommonJS so
			// Vitest's transforms cannot mask broken export conditions.
			const { execFileSync } = await import("node:child_process");
			const esm = execFileSync(
				process.execPath,
				[
					"--input-type=module",
					"-e",
					`await import(${JSON.stringify(specifier)});`,
				],
				{ cwd: packageRoot, encoding: "utf8" },
			);
			expect(esm).toBe("");
			await access(new URL(conditions.import.types, packageRoot));
			if (conditions.require) {
				expect(() => require(specifier)).not.toThrow();
				await access(new URL(conditions.require.types, packageRoot));
			} else {
				expect(() => require(specifier)).toThrow(
					expect.objectContaining({ code: "ERR_PACKAGE_PATH_NOT_EXPORTED" }),
				);
			}
		});
	}
});
