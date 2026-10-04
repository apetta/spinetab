import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SizeScenario } from "../performance/size/catalogue.ts";
import type { Realm } from "../performance/size/realm.ts";
import {
	type AttributedChunk,
	buildForbidden,
	DEV_RESIDUE,
	pageForbidden,
	runtimeOnlyFiles,
	summarise,
} from "../performance/size/summary.ts";
import { distDir } from "./dist.ts";
import { sourcesOf, walk } from "./graph.ts";

/**
 * The size summary's packaging rules (items 2 and 4): no page realm
 * holds a runtime or worker entry, and production Vue and Solid chunks carry
 * no development-only text. Synthetic attributions only; no build.
 */

const scenario = (id: string): SizeScenario => ({
	id,
	kind: "helper",
	subpaths: [],
	peers: [],
	spinetab: true,
});

function chunk(
	path: string,
	realm: Realm,
	files: Record<string, number>,
	spinetabText = "",
): AttributedChunk {
	const bytes = Object.fromEntries(
		Object.entries(files).map(([file, size]) => [`spinetab:${file}`, size]),
	);
	return {
		path,
		realm,
		dests: { shared: [], local: [] },
		size: { bytes: 1, gzip: 1, brotli: 1 },
		sha256: "0".repeat(64),
		mapFile: null,
		mapSha256: null,
		attribution: {
			bytes,
			spinetabText,
			spinetabSpans: [],
			sources: [],
			composed: [],
			mapped: true,
			mapFile: null,
		},
	};
}

const context = (id: string, allowed: string[]) => ({
	scenario: scenario(id),
	bundler: "vite" as const,
	allowedSpinetab: new Set(allowed),
	allowedPeers: new Set<string>(),
});

describe("item 2: page-realm absence rule", () => {
	it("names the runtime and worker entries in either form", () => {
		for (const file of [
			"dist/runtime.js",
			"dist/worker.js",
			"dist/polling/runtime.js",
			"dist/graphql-ws/runtime.js",
			"runtime.js",
			"sse/runtime.js",
			"src/runtime/index.ts",
			"src/worker/index.ts",
			"src/transports/polling/runtime.ts",
			"src/protocols/socket-io/runtime.ts",
			"src/integrations/ai-sdk/runtime.ts",
			// The plugin's keep stub and its worker-config target.
			"dist/auto/worker.js",
			"dist/worker-config.js",
			"auto/worker.js",
			"src/auto/worker.ts",
			"src/worker-config.ts",
		]) {
			expect(pageForbidden(file), file).toBe(true);
		}
		for (const file of [
			"dist/index.js",
			"dist/polling.js",
			"dist/react.js",
			"src/core/client.ts",
			"src/transports/polling/index.ts",
			// The shipped literals and the plugin-absent default are page code.
			"dist/auto/wiring.js",
			"dist/wiring.js",
			"src/auto/wiring.ts",
		]) {
			expect(pageForbidden(file), file).toBe(false);
		}
	});

	it("offends when the page or a shared chunk holds them, never the worker or lazy chunk", () => {
		const allowed = ["dist/index.js", "dist/runtime.js", "dist/worker.js"];
		const clean = summarise(
			[
				chunk("/page.js", "page", { "dist/index.js": 10 }),
				chunk("/worker.js", "worker", {
					"dist/runtime.js": 10,
					"dist/worker.js": 5,
				}),
				chunk("/lazy.js", "lazy", { "dist/runtime.js": 10 }),
			],
			context("polling", allowed),
		);
		expect(clean.offending).toEqual([]);
		const leaked = summarise(
			[
				chunk("/page.js", "page", {
					"dist/index.js": 10,
					"dist/runtime.js": 10,
				}),
				chunk("/shared.js", "shared", { "dist/worker.js": 5 }),
			],
			context("polling", allowed),
		);
		expect(leaked.offending).toEqual([
			"page-realm:spinetab:dist/runtime.js",
			"page-realm:spinetab:dist/worker.js",
		]);
	});
});

describe("the engine behind the runtime entries, whatever its file name", () => {
	const packageDir = join(import.meta.dirname, "../..");
	const runtimeOnly = runtimeOnlyFiles(packageDir);
	const engines = walk(distDir)
		.filter((file) => file.endsWith(".js"))
		.filter((file) => sourcesOf(distDir, file).includes("src/core/runtime.ts"))
		.map((file) => `dist/${file}`);

	it("forbids files only the runtime, worker and adapter-runtime entries reach", () => {
		expect(engines.length).toBeGreaterThan(0);
		for (const file of [
			...engines,
			"src/core/runtime.ts",
			"src/core/broker.ts",
			"src/core/host.ts",
			"src/core/bridge-runtime.ts",
			"src/transports/shared/backoff.ts",
		]) {
			expect(runtimeOnly.has(file), file).toBe(true);
			expect(pageForbidden(file), file).toBe(true);
		}
		// Code the page entries reach too stays allowed in the page.
		for (const file of [
			"dist/index.js",
			"src/core/client.ts",
			"src/core/errors.ts",
			"src/core/validate.ts",
			"src/core/bridge.ts",
		]) {
			expect(runtimeOnly.has(file), file).toBe(false);
			expect(pageForbidden(file), file).toBe(false);
		}
	});

	it("a page chunk holding the engine offends in the installed and composed forms", () => {
		for (const engine of engines) {
			const installed = summarise(
				[chunk("/page.js", "page", { "dist/index.js": 10, [engine]: 4_000 })],
				context("polling", ["dist/index.js", engine]),
			);
			expect(installed.offending).toEqual([`page-realm:spinetab:${engine}`]);
		}
		const composed = {
			"src/core/client.ts": 10,
			"src/core/runtime.ts": 4_000,
			"src/core/broker.ts": 1_000,
		};
		const next = summarise(
			[chunk("/page.js", "shared", composed)],
			context("polling", Object.keys(composed)),
		);
		expect(next.offending).toEqual([
			"page-realm:spinetab:src/core/broker.ts",
			"page-realm:spinetab:src/core/runtime.ts",
		]);
		const lazy = summarise(
			[chunk("/lazy.js", "lazy", composed)],
			context("polling", Object.keys(composed)),
		);
		expect(lazy.offending).toEqual([]);
	});

	it("the installed package's own set wins over the repository default", () => {
		const summary = summarise(
			[chunk("/page.js", "page", { "dist/runtime-Old1.js": 4_000 })],
			{
				...context("polling", ["dist/runtime-Old1.js"]),
				pageForbidden: new Set(["dist/runtime-Old1.js"]),
			},
		);
		expect(summary.offending).toEqual([
			"page-realm:spinetab:dist/runtime-Old1.js",
		]);
	});
});

describe("item 4: production Vue and Solid chunks carry no dev text", () => {
	const allowed = ["dist/vue.js", "dist/dev-D-_tJl_4.js"];

	it("offends on either needle in the Vue or Solid scenario", () => {
		expect(DEV_RESIDUE).toEqual(["call dispose() yourself", "process.env"]);
		for (const id of ["vue", "solid"]) {
			const summary = summarise(
				[
					chunk(
						"/page.js",
						"page",
						{ "dist/vue.js": 10 },
						'try{if(process.env.NODE_ENV!=="production")console.warn(`x; call dispose() yourself.`)}catch{}',
					),
				],
				context(id, allowed),
			);
			expect(summary.offending, id).toEqual([
				"dev-residue:call dispose() yourself",
				"dev-residue:process.env",
			]);
		}
	});

	it("passes a replaced and dropped branch, and ignores other scenarios", () => {
		const replaced = summarise(
			[chunk("/page.js", "page", { "dist/vue.js": 10 }, "try{}catch{}")],
			context("vue", allowed),
		);
		expect(replaced.offending).toEqual([]);
		const other = summarise(
			[chunk("/page.js", "page", { "dist/vue.js": 10 }, "process.env.X")],
			context("react", allowed),
		);
		expect(other.offending).toEqual([]);
	});
});

describe("build sources in no browser realm", () => {
	it("names build files in the installed and composed forms", () => {
		for (const file of [
			"dist/build/vite.js",
			"build/next.cjs",
			"dist/build/shared-Ab12.js",
			"src/build/vite.ts",
			"src/build/adapters.ts",
		]) {
			expect(buildForbidden(file), file).toBe(true);
		}
		for (const file of [
			"dist/index.js",
			"dist/auto/wiring.js",
			"dist/auto/worker.js",
			"dist/worker-config.js",
			"src/core/origins.ts",
			"src/auto/wiring.ts",
		]) {
			expect(buildForbidden(file), file).toBe(false);
		}
	});

	it("offends in every realm, the worker and lazy chunks included", () => {
		const allowed = [
			"dist/index.js",
			"dist/build/vite.js",
			"src/build/next.ts",
		];
		for (const realm of [
			"page",
			"worker",
			"lazy",
			"shared",
			"unused",
		] as const) {
			const summary = summarise(
				[
					chunk(`/${realm}.js`, realm, {
						"dist/index.js": 10,
						"dist/build/vite.js": 5,
						"src/build/next.ts": 5,
					}),
				],
				context("polling", allowed),
			);
			expect(
				summary.offending.filter((key) => key.startsWith("build-realm:")),
				realm,
			).toEqual([
				"build-realm:spinetab:dist/build/vite.js",
				"build-realm:spinetab:src/build/next.ts",
			]);
		}
	});
});
