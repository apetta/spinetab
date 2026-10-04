import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { distDir } from "./dist.ts";
import { walk } from "./graph.ts";

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

const pageSubpaths = [
	".",
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
	// The plugin-absent wiring default the root imports.
	"./wiring",
];
// The shipped literals: page realm, ESM only.
const esmPageSubpaths = ["./auto/wiring"];
const runtimeSubpaths = [
	"./runtime",
	"./worker",
	"./websocket/runtime",
	"./sse/runtime",
	"./stream/runtime",
	"./polling/runtime",
	"./graphql-ws/runtime",
	"./graphql-sse/runtime",
	"./socket-io/runtime",
	"./trpc/runtime",
	"./ai-sdk/runtime",
	// The keep stub and the worker-config stub.
	"./auto/worker",
	"./worker-config",
];
// Node-only bundler plugins and their loader, dual format.
const buildSubpaths = [
	"./vite",
	"./webpack",
	"./rspack",
	"./next",
	"./astro",
	"./nuxt",
	"./loader",
];
const USE_CLIENT = /^\s*(?:["']use strict["'];?\s*)?["']use client["'];/;

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

	it('marks only the React binding files with "use client", including every chunk', async () => {
		const chunks = walk(distDir).filter((file) => /\.c?js$/.test(file));
		expect(chunks.length).toBeGreaterThan(0);
		const marked: string[] = [];
		for (const file of chunks) {
			const output = await readFile(
				new URL(`dist/${file}`, packageRoot),
				"utf8",
			);
			if (/^\s*(?:["']use strict["'];?\s*)?["']use client["'];/.test(output)) {
				marked.push(file);
			}
		}
		expect(marked.sort()).toEqual(["react.cjs", "react.js"]);
	});

	it("exposes exactly the supported page subpaths, explicit runtime entries, the seams and the build entries", () => {
		expect(Object.keys(manifest.exports).sort()).toEqual(
			[
				...pageSubpaths,
				...esmPageSubpaths,
				...runtimeSubpaths,
				...buildSubpaths,
			].sort(),
		);
		for (const subpath of [...pageSubpaths, ...buildSubpaths]) {
			expect(manifest.exports[subpath]?.require, subpath).toBeDefined();
		}
		for (const subpath of [...esmPageSubpaths, ...runtimeSubpaths]) {
			expect(manifest.exports[subpath]?.require, subpath).toBeUndefined();
		}
		for (const subpath of buildSubpaths) {
			const name = subpath.slice(2);
			expect(manifest.exports[subpath], subpath).toEqual({
				import: {
					types: `./dist/build/${name}.d.ts`,
					default: `./dist/build/${name}.js`,
				},
				require: {
					types: `./dist/build/${name}.d.cts`,
					default: `./dist/build/${name}.cjs`,
				},
			});
		}
	});

	it("gives each build entry exactly its factory export in both formats", async () => {
		// Named factories only; the loader is a webpack-compatible default
		// export; the `SpinetabPlugin` class is never exported.
		const expected: Record<string, string[]> = {
			"./vite": ["spinetab"],
			"./webpack": ["spinetab"],
			"./rspack": ["spinetab"],
			"./next": ["withSpinetab"],
			"./astro": ["spinetab"],
			"./nuxt": ["default"],
			"./loader": ["default"],
		};
		expect(Object.keys(expected).sort()).toEqual([...buildSubpaths].sort());
		for (const subpath of buildSubpaths) {
			const conditions = manifest.exports[subpath];
			if (!conditions?.require) throw new Error(`${subpath} is not dual`);
			const esm = (await import(
				new URL(conditions.import.default, packageRoot).href
			)) as Record<string, unknown>;
			// `URL.pathname` is percent-encoded; `require` needs the raw path.
			const loaded = require(
				fileURLToPath(new URL(conditions.require.default, packageRoot)),
			) as Record<string, unknown> | ((...args: unknown[]) => unknown);
			// A default-only module compiles to `module.exports = fn` (packaging
			// P-F7); webpack's loader runner accepts that and `exports.default`.
			const cjs = typeof loaded === "function" ? { default: loaded } : loaded;
			const names = expected[subpath] ?? [];
			expect(Object.keys(esm).sort(), `${subpath} (ESM)`).toEqual(names);
			expect(
				Object.keys(cjs)
					.filter((key) => key !== "__esModule")
					.sort(),
				`${subpath} (CJS)`,
			).toEqual(names);
			for (const name of names) {
				expect(typeof esm[name], `${subpath} ${name}`).toBe("function");
				expect(typeof cjs[name], `${subpath} ${name} (CJS)`).toBe("function");
			}
			for (const declaration of [
				conditions.import.types,
				conditions.require.types,
			]) {
				const types = await readFile(new URL(declaration, packageRoot), "utf8");
				expect(
					types,
					`${declaration}: SpinetabPlugin is not exported`,
				).not.toMatch(
					/export\s+(?:declare\s+)?class\s+SpinetabPlugin|export\s*\{[^}]*\bSpinetabPlugin\b/,
				);
			}
		}
	});

	it('marks no build file "use client" (the plugins run in Node)', async () => {
		const buildFiles = walk(distDir).filter((file) =>
			/^build\/.*\.c?js$/.test(file),
		);
		expect(buildFiles.length).toBeGreaterThanOrEqual(buildSubpaths.length * 2);
		const marked: string[] = [];
		for (const file of buildFiles) {
			const output = await readFile(
				new URL(`dist/${file}`, packageRoot),
				"utf8",
			);
			if (USE_CLIENT.test(output)) marked.push(file);
		}
		expect(marked).toEqual([]);
	});

	it("exports each native adapter factory only under its <entry>Adapter name", async () => {
		const names = [
			["./polling/runtime", "createPollingAdapter", "pollingAdapter"],
			["./sse/runtime", "createSseAdapter", "sseAdapter"],
			["./stream/runtime", "createStreamAdapter", "streamAdapter"],
			["./websocket/runtime", "createWebSocketAdapter", "websocketAdapter"],
		] as const;
		for (const [subpath, removed, name] of names) {
			const target = manifest.exports[subpath]?.import;
			if (!target) throw new Error(`${subpath} is not exported`);
			const entry = (await import(
				new URL(target.default, packageRoot).href
			)) as Record<string, unknown>;
			expect(typeof entry[name], `${subpath}: ${name}`).toBe("function");
			expect(entry[removed], `${subpath}: ${removed}`).toBeUndefined();
			const types = await readFile(new URL(target.types, packageRoot), "utf8");
			expect(types, `${subpath}: ${name} declaration`).toMatch(
				new RegExp(`\\b${name}\\b`),
			);
			expect(types, `${subpath}: ${removed} declaration`).not.toMatch(
				new RegExp(`\\b${removed}\\b`),
			);
		}
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
