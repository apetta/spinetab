import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	allowlistedPeers,
	areaOf,
	ENTRY_RULES,
	isBareSpecifier,
	packageName,
	SEAM_SUBPATHS,
} from "./allowlist.ts";
import {
	buildPlans,
	CONSUMERS,
	consumer,
	forbiddenPackages,
	isPluginRecipe,
	localModule,
	matchesPackage,
	nextBuildPlans,
	recipeOf,
	SPINETAB_PEERS,
	unselectedPeers,
} from "./consumers/catalogue.ts";
import { flattenConfig } from "./consumers/config-keys.ts";
import {
	type FrontLog,
	type LoggedRequest,
	parseFrontArgs,
	startFront,
} from "./consumers/front.ts";
import {
	type ChunkGraph,
	chunksByRealm,
	classifySource,
	createDistResolver,
	decodeMap,
	failures,
	inspectOutput,
	mentionedPackages,
	readChunkGraph,
	realmOf,
	spinetabImports,
	turbopackGraph,
	viteGraph,
	webpackGraph,
} from "./consumers/inspect.ts";
import {
	compareVersions,
	lowerBound,
	type MatrixRecord,
	mergeMatrix,
	readAppReports,
	reconcilePeers,
	renderTable,
} from "./consumers/matrix.ts";
import { templatesDir } from "./consumers/paths.ts";
import {
	computeDistHash,
	lockfileDiff,
	lockfilePackages,
	lockfileSpinetabIntegrity,
} from "./consumers/prepare.ts";
import { namesChunk, requestRealm, requestsFor } from "./consumers/requests.ts";
import { DEFINITIONS, median, p95 } from "./consumers/stats.ts";
import {
	scanBuildLog,
	scanConfig,
	scanSources,
	WORKER_EXPRESSION,
} from "./consumers/workarounds.ts";
import { areasOf, closureOf, importsOf, resolveRelative } from "./graph.ts";

/**
 * Pure logic of the packaging machinery. Reads only synthetic fixtures under
 * tests/package/fixtures and the consumer templates; never `dist/`.
 */
const fixtures = fileURLToPath(new URL("./fixtures/inspect/", import.meta.url));
const installed = join(fixtures, "installed");

describe("allow-list", () => {
	it("maps sources to areas", () => {
		expect(areaOf("src/index.ts")).toBe("core");
		expect(areaOf("src/core/client.ts")).toBe("core");
		expect(areaOf("src/runtime/index.ts")).toBe("core");
		expect(areaOf("src/worker/index.ts")).toBe("core");
		expect(areaOf("src/transports/sse/runtime.ts")).toBe("transports/sse");
		expect(areaOf("src/protocols/graphql/types.ts")).toBe("protocols/graphql");
		expect(areaOf("src/bindings/react/index.ts")).toBe("bindings/react");
		expect(areaOf("node_modules/x/index.js")).toBeUndefined();
	});

	it("names packages and bare specifiers", () => {
		expect(packageName("@apollo/client/link")).toBe("@apollo/client");
		expect(packageName("graphql-ws/client")).toBe("graphql-ws");
		expect(isBareSpecifier("react")).toBe(true);
		expect(isBareSpecifier("./x.js")).toBe(false);
		expect(isBareSpecifier("node:fs")).toBe(false);
	});

	it("allow-lists exactly the catalogue's peers and every entry", () => {
		expect(allowlistedPeers()).toEqual([...SPINETAB_PEERS].sort());
		// cjs-node loads every page, runtime and build entry; the
		// seams are reached only through a plugin's redirect.
		const cjs = consumer("cjs-node");
		const covered = new Set([
			...cjs.entries,
			...(cjs.buildEntries ?? []),
			...SEAM_SUBPATHS,
		]);
		expect([...covered].sort()).toEqual(Object.keys(ENTRY_RULES).sort());
	});
});

describe("catalogue", () => {
	it("forbids unselected peers and their families", () => {
		const vue = consumer("vue-graphql-ws");
		const forbidden = forbiddenPackages(vue);
		expect(matchesPackage("react", forbidden)).toBe(true);
		expect(matchesPackage("react-dom", forbidden)).toBe(true);
		expect(matchesPackage("@ai-sdk/react", forbidden)).toBe(true);
		expect(matchesPackage("@tanstack/query-core", forbidden)).toBe(true);
		expect(matchesPackage("vue", forbidden)).toBe(false);
		expect(matchesPackage("graphql", forbidden)).toBe(false);
		expect(unselectedPeers(consumer("vanilla-polling"))).toEqual([
			...SPINETAB_PEERS,
		]);
		expect(unselectedPeers(consumer("react-ai-sdk"))).not.toContain("swr");
	});

	it("plans isolation, development and base builds", () => {
		const recipe = buildPlans(consumer("react-sse-tanstack"), false);
		expect(recipe.map((plan) => `${plan.bundler}-${plan.variant}`)).toEqual([
			"vite-prod",
			"vite-no-treeshake",
			"vite-base",
			"webpack-prod",
			"webpack-no-treeshake",
			"webpack-dev",
			"rspack-prod",
			"rspack-no-treeshake",
			"rspack-dev",
		]);
		expect(
			buildPlans(consumer("react-sse-tanstack"), true).filter(
				(plan) => plan.variant === "module",
			),
		).toHaveLength(2);
		expect(
			nextBuildPlans(consumer("next-app")).map((plan) => plan.variant),
		).toEqual(["prod", "inspect", "base", "cdn", "cdn-worker"]);
	});
});

describe("consumer templates", () => {
	for (const spec of CONSUMERS) {
		const root = join(templatesDir, spec.name);
		it(`${spec.name}: pins exact versions and installs only its selected peers`, () => {
			// A workspace consumer (`next-monorepo`) declares its app's
			// dependencies in the app directory; the tarball path is relative to it.
			const appDir = spec.appDir ?? "";
			const manifest = JSON.parse(
				readFileSync(join(root, appDir, "package.json"), "utf8"),
			) as {
				private?: boolean;
				dependencies?: Record<string, string>;
				devDependencies?: Record<string, string>;
			};
			expect(manifest.private).toBe(true);
			const pack = posix.relative(posix.join(spec.name, appDir), "pack");
			expect(manifest.dependencies?.spinetab).toBe(
				`file:${pack}/spinetab-0.1.0.tgz`,
			);
			const all = { ...manifest.dependencies, ...manifest.devDependencies };
			const ranges = Object.entries(all).filter(
				([name, version]) =>
					name !== "spinetab" &&
					version !== "workspace:*" &&
					!/^\d+\.\d+\.\d+$/.test(version),
			);
			expect(ranges).toEqual([]);
			for (const peer of spec.peers) expect(all[peer], peer).toBeDefined();
			for (const peer of unselectedPeers(spec))
				expect(all[peer], peer).toBeUndefined();
			for (const peer of spec.upstreamInstalled)
				expect(all[peer], peer).toBeUndefined();
			expect(readFileSync(join(root, "pnpm-workspace.yaml"), "utf8")).toMatch(
				/^hoist: false$/m,
			);
		});

		if (spec.proof !== "none" && isPluginRecipe(recipeOf(spec))) {
			it(`${spec.name}: leaves the wiring to the plugin (${recipeOf(spec)})`, () => {
				// No hand-written factory, no `spinetab/wiring` import; L2
				// keeps exactly one `spinetab.worker` file, L3 none.
				const appRoot = join(root, spec.appDir ?? "");
				const dirs = spec.kind === "next" ? ["app"] : ["src"];
				const scan = scanSources(appRoot, dirs, recipeOf(spec));
				expect(scan.workerExpressions).toEqual([]);
				expect(scan.missingWorkerExpression).toEqual([]);
				expect(scan.violations).toEqual([]);
				expect(scan.wrappers).toEqual([]);
				if (recipeOf(spec) === "plugin-worker") {
					const worker = readFileSync(join(appRoot, localModule(spec)), "utf8");
					expect(worker).toMatch(/export default defineWorker\(/);
				}
			});
		} else if (spec.proof !== "none") {
			it(`${spec.name}: writes the worker factory verbatim, with a lazy local runtime`, () => {
				const dirs = spec.kind === "next" ? ["app"] : ["src"];
				const scan = scanSources(root, dirs, recipeOf(spec));
				expect(scan.missingWorkerExpression).toEqual([]);
				expect(scan.violations).toEqual([]);
				expect(scan.wrappers).toEqual([]);
				expect(existsSync(join(root, localModule(spec)))).toBe(true);
				// The one-file recipe has no separate local or adapter module
				// and no worker name; the others keep the three-file escape hatch.
				const dir = spec.kind === "next" ? "app" : "src";
				const ext = spec.kind === "next" ? "ts" : "js";
				const oneFile = spec.recipe === "one-file";
				expect(existsSync(join(root, dir, `live.local.${ext}`))).toBe(!oneFile);
				if (oneFile) {
					expect(existsSync(join(root, dir, `live.adapters.${ext}`))).toBe(
						false,
					);
				}
				const worker = readFileSync(
					join(root, dir, `live.worker.${ext}`),
					"utf8",
				);
				expect(/\bdefineWorker\(/.test(worker)).toBe(oneFile);
				expect(/\bserveSharedWorker\(/.test(worker)).toBe(!oneFile);
				const named = scan.workerExpressions.some((file) =>
					/name:\s*["']spinetab["']/.test(
						readFileSync(join(root, file), "utf8"),
					),
				);
				expect(named).toBe(!oneFile);
			});
		}
	}
});

describe("worker expression and scans", () => {
	it("accepts only the literal factory", () => {
		expect(
			WORKER_EXPRESSION.test(
				'new SharedWorker(new URL("./live.worker.js", import.meta.url), { type: "module", name: "spinetab" })',
			),
		).toBe(true);
		// The one-file recipe drops the name.
		expect(
			WORKER_EXPRESSION.test(
				'new SharedWorker(new URL("./live.worker.ts", import.meta.url), {\n\ttype: "module",\n})',
			),
		).toBe(true);
		expect(
			WORKER_EXPRESSION.test(
				'new SharedWorker(new URL("./live.worker.js", import.meta.url), { type: "module", name: "other" })',
			),
		).toBe(false);
		expect(
			WORKER_EXPRESSION.test(
				'const url = new URL("./live.worker.js", import.meta.url); new SharedWorker(url, { type: "module", name: "spinetab" })',
			),
		).toBe(false);
		expect(
			WORKER_EXPRESSION.test(
				'new SharedWorker(new URL("./live.worker.js", import.meta.url), { type: "module", name })',
			),
		).toBe(false);
	});

	it("flags configuration outside the allow-list or undeclared in the types", () => {
		const types =
			"interface X { base?: string; build?: B; sourcemap?: boolean }";
		expect(
			scanConfig("vite", ["base", "build", "build.sourcemap"], [], types),
		).toEqual({
			outside: [],
			undeclared: [],
			plugins: [],
		});
		const scan = scanConfig(
			"webpack",
			["mode", "resolve", "resolve.alias", "plugins"],
			["HtmlWebpackPlugin", "IgnorePlugin"],
			"mode?: string; plugins?: X",
		);
		expect(scan.outside).toEqual(["resolve", "resolve.alias"]);
		expect(scan.plugins).toEqual(["IgnorePlugin"]);
		expect(scanConfig("vite", ["base"], [], "").undeclared).toEqual(["base"]);
	});

	it("flattens plain config objects and reports plugins", () => {
		class HtmlWebpackPlugin {}
		expect(
			flattenConfig({
				mode: "production",
				output: { path: "/x", module: true },
				plugins: [new HtmlWebpackPlugin()],
				headers: async () => [],
			}),
		).toEqual({
			keys: [
				"headers",
				"mode",
				"output",
				"output.module",
				"output.path",
				"plugins",
			],
			plugins: ["HtmlWebpackPlugin"],
		});
	});

	it("reports resolution failures and Spinetab warnings in build logs", () => {
		const log = [
			"vite v8.3.1 building for production...",
			"✓ 42 modules transformed.",
			"WARNING in ./node_modules/spinetab/dist/sse.js",
			"Module not found: Error: Can't resolve 'react'",
			"(!) Some chunks are larger than 500 kB after minification.",
			"asset spinetab.js 300 KiB [emitted] [big]",
		].join("\n");
		expect(scanBuildLog(log)).toEqual([
			"WARNING in ./node_modules/spinetab/dist/sse.js",
			"Module not found: Error: Can't resolve 'react'",
		]);
	});
});

describe("isolation inspection", () => {
	it("classifies consumer sourcemap sources", () => {
		expect(
			classifySource(
				"../../node_modules/.pnpm/spinetab@file+..+pack/node_modules/spinetab/dist/sse/runtime.js",
			),
		).toEqual({ kind: "spinetab", distFile: "sse/runtime.js" });
		expect(
			classifySource(
				"webpack://consumer/./node_modules/.pnpm/@tanstack+query-core@5/node_modules/@tanstack/query-core/build/modern/index.js",
			),
		).toEqual({ kind: "package", name: "@tanstack/query-core" });
		expect(classifySource("turbopack:///[project]/app/live-view.tsx")).toEqual({
			kind: "app",
			path: "app/live-view.tsx",
		});
		expect(classifySource("webpack://consumer/./src/main.js")).toEqual({
			kind: "app",
			path: "src/main.js",
		});
		expect(classifySource("webpack/runtime/define property getters")).toEqual({
			kind: "other",
		});
	});

	it("attributes composed, relocated and pnpm virtual-store Spinetab paths", () => {
		expect(
			classifySource("node_modules/spinetab/src/integrations/ai-sdk/index.ts"),
		).toEqual({
			kind: "spinetab-source",
			source: "src/integrations/ai-sdk/index.ts",
		});
		expect(
			classifySource(
				"webpack://consumer/./node_modules/.pnpm/spinetab@file+..+pack/node_modules/spinetab/src/core/client.ts",
			),
		).toEqual({ kind: "spinetab-source", source: "src/core/client.ts" });
		// A bare relative source names nothing until resolved against its map.
		expect(
			classifySource(
				"../spinetab/src/transports/sse/index.ts",
				"/w/node_modules/spinetab/src/transports/sse/index.ts",
			),
		).toEqual({
			kind: "spinetab-source",
			source: "src/transports/sse/index.ts",
		});
		expect(classifySource("spinetab@1.0.0/dist/sse.js")).toEqual({
			kind: "spinetab",
			distFile: "sse.js",
		});
		expect(classifySource("node_modules/spinetab/package.json")).toMatchObject({
			kind: "unclassified",
		});
		expect(
			classifySource("node_modules/.pnpm/spinetab@file+..+pack/index.js"),
		).toMatchObject({ kind: "unclassified" });
		expect(
			classifySource(
				"\u0000rolldown/runtime.js",
				"/w/node_modules/.vite/deps/x",
			),
		).toEqual({ kind: "other" });
	});

	it("reads value imports of Spinetab entries and skips type-only ones", () => {
		expect(
			spinetabImports(
				[
					'import "spinetab";',
					'import { a,\n  b } from "spinetab/sse";',
					'export * from "spinetab/worker";',
					'const lazy = () => import("spinetab/sse/runtime");',
					'const cjs = require("spinetab/react");',
					'import type { T } from "spinetab/vue";',
					'import { type U, type V } from "spinetab/swr";',
					'export type { W } from "spinetab/solid";',
					'import x from "spinetab-other";',
				].join("\n"),
			),
		).toEqual([
			"spinetab",
			"spinetab/react",
			"spinetab/sse",
			"spinetab/sse/runtime",
			"spinetab/worker",
		]);
	});

	it("decodes sourceRoot and index-map sections per ECMA-426, reporting what it cannot walk", () => {
		const map = "/w/out/assets/x.js.map";
		const flat = (sources: string[], extra: object = {}) => ({
			version: 3,
			sources,
			mappings: "AAAA",
			...extra,
		});
		expect(
			decodeMap(flat(["a.ts"], { sourceRoot: "../../lib" }), map).sources,
		).toEqual([
			{ raw: "../../lib/a.ts", resolved: "/w/lib/a.ts", content: null },
		]);
		const indexed = decodeMap(
			{
				version: 3,
				sections: [
					{ offset: { line: 0, column: 0 }, map: flat(["a.ts"]) },
					{
						offset: { line: 1, column: 4 },
						map: {
							version: 3,
							sections: [
								{ offset: { line: 0, column: 0 }, map: flat(["b.ts"]) },
							],
						},
					},
				],
			},
			map,
			2,
		);
		expect(indexed.problems).toEqual([]);
		expect(indexed.sources.map((source) => source.resolved)).toEqual([
			"/w/out/assets/a.ts",
			"/w/out/assets/b.ts",
		]);
		const problems = (json: unknown, lines?: number) =>
			decodeMap(json, map, lines).problems;
		expect(problems({ ...flat(["a.ts"]), version: 2 })).toEqual([
			"map: unsupported version 2 (ECMA-426 requires 3)",
		]);
		expect(problems({ version: 3, mappings: "" })).toEqual([
			"map: neither a sources array nor sections",
		]);
		expect(problems([])).toEqual(["map: not a JSON object"]);
		expect(problems({ version: 3, sections: [] })).toEqual([
			"map: sections is not a non-empty array",
		]);
		// Turbopack writes `"sources": []` beside `sections`: an empty array
		// names nothing, so the sections are consumed (ECMA-426 §9.4, §10.1).
		const turbopack = decodeMap(
			{
				version: 3,
				sources: [],
				sections: [{ offset: { line: 0, column: 0 }, map: flat(["a.ts"]) }],
			},
			map,
			1,
		);
		expect(turbopack.problems).toEqual([]);
		expect(turbopack.sources.map((source) => source.resolved)).toEqual([
			"/w/out/assets/a.ts",
		]);
		expect(
			problems({
				version: 3,
				sources: ["x.ts"],
				sections: [{ offset: { line: 0, column: 0 }, map: flat(["a.ts"]) }],
			}),
		).toEqual(["map: index map also has non-empty sources (ECMA-426 §10)"]);
		expect(
			problems({
				version: 3,
				sources: null,
				sections: [{ offset: { line: 0, column: 0 }, map: flat(["a.ts"]) }],
			}),
		).toEqual(["map: index map also has non-empty sources (ECMA-426 §10)"]);
		expect(
			problems({
				version: 3,
				mappings: "",
				sections: [{ offset: { line: 0, column: 0 }, map: flat(["a.ts"]) }],
			}),
		).toEqual(["map: index map also has mappings (ECMA-426 §10)"]);
		expect(
			problems({
				version: 3,
				sources: [],
				mappings: "AAAA",
				sections: [{ offset: { line: 0, column: 0 }, map: flat(["a.ts"]) }],
			}),
		).toEqual(["map: index map also has mappings (ECMA-426 §10)"]);
		expect(
			problems(
				{
					version: 3,
					sections: [
						{ offset: { line: 3, column: 0 }, map: flat(["a.ts"]) },
						{ offset: { line: 1, column: 0 }, map: flat(["b.ts"]) },
						{ offset: { line: 1 }, map: flat(["c.ts"]) },
						{ offset: { line: 4, column: 0 }, url: "d.js.map" },
					],
				},
				3,
			),
		).toEqual([
			"map.sections[0]: offset line 3 is beyond the generated file (3 lines)",
			"map.sections[1]: offset 1:0 precedes the previous section (sections must be sorted)",
			"map.sections[2]: offset needs non-negative integer line/column",
			"map.sections[3]: offset line 4 is beyond the generated file (3 lines)",
			"map.sections[3]: no embedded map (url sections are not supported)",
		]);
		expect(problems(flat(["a.ts", 7] as unknown as string[]))).toEqual([
			"map.sources[1]: not a string or null",
		]);
	});

	it("derives the realm from the chunk's role, never its file names", () => {
		const worker = { worker: true, lazy: false };
		const lazy = { worker: false, lazy: true };
		const none = { worker: false, lazy: false };
		// One module in two chunks: the graph tells them apart.
		expect(realmOf(["src/live.worker.js"], worker, "shared")).toBe("worker");
		expect(realmOf(["src/live.worker.js"], lazy, "shared")).toBe("fallback");
		expect(realmOf(["app/live.local.ts"], lazy, "shared")).toBe("fallback");
		// One chunk for both (Turbopack): a page fetches it only in local mode.
		expect(
			realmOf(["app/live.worker.ts"], { worker: true, lazy: true }, "shared"),
		).toBe("fallback");
		// The worker's own bundler runtime is worker code.
		expect(realmOf([], worker, "shared")).toBe("worker");
		// Without a graph, file names never make a worker or fallback realm.
		expect(realmOf(["src/live.worker.js"], undefined, "shared")).toBe("shared");
		expect(realmOf(["app/live.local.ts"], undefined, "shared")).toBe("shared");
		expect(realmOf([], none, "dev-deps")).toBe("dev-deps");
		expect(realmOf(["src/main.js", "src/config.js"], none, "shared")).toBe(
			"page",
		);
		expect(realmOf(["app/live.ts"], undefined, "shared")).toBe("page");
		expect(realmOf([], undefined, "shared")).toBe("shared");
	});

	it("maps dist files to areas through their own maps or declaration regions", () => {
		const resolve = createDistResolver(installed);
		expect(resolve("entry.js")).toEqual(["transports/sse"]);
		expect(resolve("sse/runtime.js")).toEqual(["transports/sse"]);
		expect(resolve("chunk-A1.js")).toEqual(["core"]);
		expect(resolve("types-C3.d.ts")).toEqual(["core"]);
		expect(resolve("polling.js")).toEqual(["transports/polling"]);
		expect(resolve("ai-sdk.js")).toEqual(["integrations/ai-sdk"]);
		expect(resolve("missing.js")).toEqual(["missing:missing.js"]);
	});

	it("passes a consumer whose chunks hold only selected code", () => {
		const report = inspectOutput({
			spec: consumer("react-sse-tanstack"),
			bundler: "vite",
			variant: "prod",
			outDir: join(fixtures, "out-good"),
			installedDist: installed,
		});
		expect(report.unmapped).toEqual([]);
		expect(failures(report)).toEqual([]);
		expect(report.verdict).toBe("pass");
		expect(report.chunks.map((chunk) => [chunk.chunk, chunk.realm])).toEqual([
			["assets/live.local-3.js", "fallback"],
			["assets/live.worker-2.js", "worker"],
			["assets/main-1.js", "page"],
		]);
		expect(report.chunks.map((chunk) => chunk.exercised)).toEqual([
			["spinetab/sse/runtime"],
			["spinetab/sse/runtime", "spinetab/worker"],
			["spinetab/react", "spinetab/sse"],
		]);
		expect(Object.keys(report.sizes).sort()).toEqual([
			"fallback",
			"page",
			"worker",
		]);
	});

	it("tells the one-file worker bundle from its lazy chunk by the Vite manifest", () => {
		const report = inspectOutput({
			spec: consumer("react-sse-tanstack"),
			bundler: "vite",
			variant: "prod",
			outDir: join(fixtures, "out-one-file"),
			installedDist: installed,
		});
		expect(failures(report)).toEqual([]);
		expect(report.verdict).toBe("pass");
		expect(report.chunks.map((chunk) => [chunk.chunk, chunk.realm])).toEqual([
			["assets/live.worker-2.js", "worker"],
			["assets/live.worker-3.js", "fallback"],
			["assets/main-1.js", "page"],
		]);
		expect(chunksByRealm(report, "fallback")).toEqual([
			"assets/live.worker-3.js",
		]);
	});

	it("reports unselected Spinetab areas, unselected peers and unmapped chunks", () => {
		const report = inspectOutput({
			spec: consumer("react-sse-tanstack"),
			bundler: "webpack",
			variant: "no-treeshake",
			outDir: join(fixtures, "out-bad"),
			installedDist: installed,
		});
		expect(report.verdict).toBe("fail");
		expect(report.unmapped).toEqual(["assets/unmapped.js"]);
		const [leak] = failures(report);
		expect(leak?.unexpected).toEqual({
			spinetab: ["protocols/graphql-ws"],
			peers: ["vue"],
		});
		expect(leak?.realm).toBe("page");
	});

	it("finds package paths named in server chunks", () => {
		expect(
			mentionedPackages(
				'require("/x/node_modules/.pnpm/vue@3/node_modules/vue/index.js"); "node_modules/@ai-sdk/react/dist/x.js"',
			),
		).toEqual(["@ai-sdk/react", "vue"]);
	});
});

describe("isolation inspection: map forms fail closed", () => {
	// vanilla-polling selects core and the polling transport only; each
	// negative output under fixtures/inspect/forms smuggles in one form.
	const inspectForm = (outDir: string, graph?: ChunkGraph) =>
		inspectOutput({
			spec: consumer("vanilla-polling"),
			bundler: "controlled-map",
			variant: "forms",
			outDir,
			installedDist: installed,
			...(graph ? { graph } : {}),
		});
	const negative = (name: string) => {
		const report = inspectForm(join(fixtures, "forms", name));
		expect(report.verdict, name).toBe("fail");
		expect(report.unmapped, name).toEqual([]);
		const [chunk, ...rest] = failures(report);
		expect(rest, name).toEqual([]);
		return chunk;
	};

	it.each([
		["dist-map", ["ai-sdk.js"]],
		["composed-src", ["src/integrations/ai-sdk/index.ts"]],
		["source-root", ["src/integrations/ai-sdk/index.ts"]],
		["indexed-sections", ["ai-sdk.js", "polling.js"]],
		["pnpm-src", ["src/integrations/ai-sdk/runtime.ts"]],
	])("%s: attributes the unselected AI source and fails", (name, files) => {
		const chunk = negative(name);
		expect(chunk?.spinetabFiles).toEqual(files);
		expect(chunk?.unexpected).toEqual({
			spinetab: ["integrations/ai-sdk"],
			peers: [],
		});
		expect(chunk?.problems).toEqual([]);
	});

	it.each([
		["unsupported-version", "map: unsupported version 2 (ECMA-426 requires 3)"],
		[
			"url-section",
			"map.sections[0]: no embedded map (url sections are not supported)",
		],
		[
			"unclassified-store",
			"unclassified source ../node_modules/.pnpm/spinetab@file+..+pack+spinetab-0.0.0.tgz/package.json: pnpm store path without spinetab/dist or spinetab/src:",
		],
		[
			"empty-attribution",
			"exercised import spinetab/polling has no Spinetab attribution in any chunk (expected one of core, transports/polling, transports/shared)",
		],
		["unselected-import", "imports spinetab/ai-sdk, an unselected entry"],
		[
			"no-content",
			"cannot read src/main.js (no sourcesContent) to find its Spinetab imports",
		],
	])("%s: reports the chunk instead of certifying an empty graph", (name, reason) => {
		const chunk = negative(name);
		expect(chunk?.unexpected.spinetab).toEqual([]);
		expect(chunk?.problems).toHaveLength(1);
		expect(chunk?.problems[0]).toContain(reason);
	});

	it("passes selected code in every supported form, with each exercised import attributed", () => {
		// No real bundler wrote this output, so its roles are given.
		const report = inspectForm(join(fixtures, "forms-good"), {
			worker: new Set(["assets/live.worker.js"]),
			lazy: new Set(["assets/live.local.js"]),
		});
		expect(failures(report)).toEqual([]);
		expect(report.unmapped).toEqual([]);
		expect(report.verdict).toBe("pass");
		expect(
			report.chunks.map(
				({ chunk, realm, spinetab, spinetabFiles, exercised }) => ({
					chunk,
					realm,
					spinetab,
					spinetabFiles,
					exercised,
				}),
			),
		).toEqual([
			{
				// Inline data-URL map, webpack URLs, pnpm composed source.
				chunk: "assets/live.local.js",
				realm: "fallback",
				spinetab: ["transports/shared"],
				spinetabFiles: ["src/transports/shared/http.ts"],
				exercised: ["spinetab/polling/runtime"],
			},
			{
				// Index map: app section, composed source, sourceRoot relocation.
				chunk: "assets/live.worker.js",
				realm: "worker",
				spinetab: ["core", "transports/polling"],
				spinetabFiles: [
					"src/core/runtime.ts",
					"src/transports/polling/runtime.ts",
				],
				exercised: ["spinetab/polling/runtime", "spinetab/worker"],
			},
			{
				// pnpm virtual-store dist path; type-only imports are not exercised.
				chunk: "assets/main.js",
				realm: "page",
				spinetab: ["transports/polling"],
				spinetabFiles: ["polling.js"],
				exercised: ["spinetab", "spinetab/polling"],
			},
		]);
	});
});

describe("chunk graphs and request destinations", () => {
	// Shapes captured from the vanilla-polling and next-app builds of the
	// three-file recipe (Vite 8.3.1, webpack 5.111.1, Rspack 2.2.7, Next
	// 16.3.6), and from a one-file build of the same fixture without a name.
	const set = (graph: ChunkGraph | undefined) => ({
		worker: [...(graph?.worker ?? [])].sort(),
		lazy: [...(graph?.lazy ?? [])].sort(),
	});

	it("reads Vite's manifest: worker assets and the dynamic-import closure", () => {
		const threeFile = {
			"index.html": {
				file: "assets/index-BIPJSfM2.js",
				isEntry: true,
				dynamicImports: ["src/live.local.js"],
				assets: ["assets/live.worker-BKn2IqX0.js"],
			},
			"src/live.local.js": {
				file: "assets/live.local-CTG9Remu.js",
				isDynamicEntry: true,
				imports: ["index.html"],
			},
		};
		expect(set(viteGraph(threeFile))).toEqual({
			worker: ["assets/live.worker-BKn2IqX0.js"],
			lazy: ["assets/live.local-CTG9Remu.js"],
		});
		const oneFile = {
			"index.html": {
				file: "assets/index-CJQIUnB8.js",
				isEntry: true,
				dynamicImports: ["src/live.worker.js"],
				assets: ["assets/live.worker-BfsxfnVN.js", "assets/logo.svg"],
			},
			"src/live.worker.js": {
				file: "assets/live.worker-BoI5A0hL.js",
				isDynamicEntry: true,
				imports: ["index.html", "_shared.js"],
			},
			"_shared.js": { file: "assets/shared-1.js" },
		};
		expect(set(viteGraph(oneFile))).toEqual({
			worker: ["assets/live.worker-BfsxfnVN.js"],
			lazy: ["assets/live.worker-BoI5A0hL.js", "assets/shared-1.js"],
		});
		expect(viteGraph([])).toBeUndefined();
	});

	it("reads webpack and Rspack entries by bootstrap and the page entry by HTML", () => {
		const boot = (name: string) => `webpack://consumer/webpack/${name}`;
		const threeFile = webpackGraph(
			[
				{
					chunk: "main.js",
					text: "",
					sources: [boot("bootstrap"), "webpack://consumer/./src/main.js"],
					appFiles: ["src/main.js"],
				},
				{
					chunk: "spinetab.js",
					text: "",
					sources: [
						boot("runtime/import_scripts_chunk_loading"),
						"webpack://consumer/./src/live.worker.js",
					],
					appFiles: ["src/live.worker.js"],
				},
				{
					chunk: "918.js",
					text: "",
					sources: ["webpack://consumer/./src/live.local.js"],
					appFiles: ["src/live.local.js"],
				},
				// A split vendor chunk the worker and the fallback both load:
				// only a stats file could place it, so it is in neither set.
				{
					chunk: "737.js",
					text: "",
					sources: ["webpack://consumer/./node_modules/spinetab/dist/x.js"],
					appFiles: [],
				},
			],
			// Minified HTML without quotes (html-webpack-plugin).
			new Map([["index.html", "<head><script defer src=main.js></script>"]]),
		);
		expect(set(threeFile)).toEqual({
			worker: ["spinetab.js"],
			lazy: ["918.js"],
		});
		// One file, no name: the worker entry and the lazy chunk share a module.
		const oneFile = webpackGraph(
			[
				{
					chunk: "main.js",
					text: "",
					sources: [boot("runtime/jsonp_chunk_loading")],
					appFiles: ["src/main.js"],
				},
				{
					chunk: "932.js",
					text: "",
					sources: [
						boot("runtime/import_scripts_chunk_loading"),
						"webpack://consumer/./src/live.worker.js",
					],
					appFiles: ["src/live.worker.js"],
				},
				{
					chunk: "551.js",
					text: "",
					sources: ["webpack://consumer/./src/live.worker.js"],
					appFiles: ["src/live.worker.js"],
				},
			],
			new Map([
				["index.html", '<script defer="defer" src="/main.js"></script>'],
			]),
		);
		expect(set(oneFile)).toEqual({ worker: ["932.js"], lazy: ["551.js"] });
	});

	it("reads Turbopack's worker and async-loader chunk lists", () => {
		const graph = turbopackGraph([
			{
				chunk: "static/chunks/17lg9ln9iaic4.js",
				sources: [],
				appFiles: [],
				text: 'e.v(e.r(10914).default("static/chunks/turbopack-worker-1r2nq6-dwes2z.js",["static/chunks/1htjiskuix8l2.js","static/chunks/0ripfagmxor7z.js","static/chunks/turbopack-2_c8xmv_9jdtu.js"]))',
			},
			{
				chunk: "static/chunks/31jgunsivw70v.js",
				sources: [],
				appFiles: [],
				text: 'e.v(t=>Promise.all(["static/chunks/22vrmeh63hor-.js","static/chunks/0ripfagmxor7z.js"].map(t=>e.l(t))).then(()=>t(64639)))',
			},
		]);
		expect(set(graph)).toEqual({
			worker: [
				"static/chunks/0ripfagmxor7z.js",
				"static/chunks/1htjiskuix8l2.js",
				"static/chunks/turbopack-2_c8xmv_9jdtu.js",
			],
			lazy: [
				"static/chunks/0ripfagmxor7z.js",
				"static/chunks/22vrmeh63hor-.js",
			],
		});
		// the worker loads too (and, one-file, the worker module itself).
		expect(readChunkGraph("unknown", fixtures, [])).toBeUndefined();
		// webpack output without its HTML has no page entry: no graph.
		expect(readChunkGraph("webpack", join(fixtures, "out-bad"), [])).toBe(
			undefined,
		);
	});

	const request = (
		path: string,
		dest: string | null,
		referrer: string | null = "/",
	): LoggedRequest => ({
		method: "GET",
		path,
		dest,
		referrer,
		status: 200,
		csp: null,
		bytes: 1,
		at: 0,
		contentType: null,
		contentTypeOptions: null,
	});
	const log = (requests: LoggedRequest[]): FrontLog => ({
		requests,
		proxied: {},
		misrouted: [],
	});

	it("names chunks by their output-relative path, never the base name alone", () => {
		expect(
			namesChunk("/assets/live.worker-1.js", "assets/live.worker-1.js"),
		).toBe(true);
		expect(
			namesChunk("/app/assets/live.worker-1.js?v=1", "assets/live.worker-1.js"),
		).toBe(true);
		expect(namesChunk("/_next/static/chunks/x.js", "static/chunks/x.js")).toBe(
			true,
		);
		expect(
			namesChunk("/other/live.worker-1.js", "assets/live.worker-1.js"),
		).toBe(false);
		expect(namesChunk("/xmain.js", "main.js")).toBe(false);
		expect(
			namesChunk(
				"/src/live.worker.js?worker_file&type=module",
				"src/live.worker.js?worker_file&type=module",
			),
		).toBe(true);
		expect(
			namesChunk(
				"/src/live.worker.js",
				"src/live.worker.js?worker_file&type=module",
			),
		).toBe(false);
	});

	it("attributes requests to the page or the worker by destination and referrer", () => {
		// Vite dev, one file: the worker entry and the lazy import are one path.
		const shared = log([
			request("/?run=a", "document", null),
			request("/src/main.js", "script"),
			request("/src/live.worker.js?worker_file&type=module", "sharedworker"),
			request(
				"/node_modules/.vite/deps/spinetab_worker.js",
				"sharedworker",
				"/src/live.worker.js",
			),
		]);
		expect(requestsFor(shared, ["src/live.worker.js"])).toEqual([
			"/src/live.worker.js",
		]);
		expect(requestsFor(shared, ["src/live.worker.js"], "page")).toEqual([]);
		expect(requestsFor(shared, ["src/live.worker.js"], "worker")).toEqual([
			"/src/live.worker.js",
		]);
		const local = log([request("/src/live.worker.js", "script")]);
		expect(requestsFor(local, ["src/live.worker.js"], "page")).toEqual([
			"/src/live.worker.js",
		]);
		// Turbopack: the worker bootstrap loads its chunks with importScripts
		// (destination script, the worker as referrer), transitively.
		const turbopack = log([
			request(
				"/_next/static/chunks/turbopack-worker-1.js?params=x",
				"sharedworker",
			),
			request(
				"/_next/static/chunks/0rip.js",
				"script",
				"/_next/static/chunks/turbopack-worker-1.js",
			),
			request(
				"/_next/static/chunks/1htj.js",
				"script",
				"/_next/static/chunks/0rip.js",
			),
			request("/_next/static/chunks/page.js", "script", "/"),
		]);
		const realms = requestRealm(turbopack);
		expect(turbopack.requests.map((entry) => realms.get(entry))).toEqual([
			"worker",
			"worker",
			"worker",
			"page",
		]);
		expect(
			requestsFor(
				turbopack,
				["static/chunks/0rip.js", "static/chunks/1htj.js"],
				"page",
			),
		).toEqual([]);
	});
});

describe("import graph", () => {
	it("reads static, dynamic and re-export imports", () => {
		expect(
			importsOf(
				'import a from "./a.js"; export { b } from "./b.js"; const c = import("./c.js"); require("./d.cjs");',
			),
		).toEqual(["./a.js", "./b.js", "./c.js", "./d.cjs"]);
	});

	it("reads type imports and reference directives in declarations", () => {
		// A bundler type reached through a directive must meet the same
		// structural-types ban and typePeers check as an import.
		expect(
			importsOf(
				[
					'/// <reference types="vite/client" />',
					'/// <reference path="../x.d.ts" />',
					'/// <reference path="y.d.ts" />',
					'export declare const p: import("vite").Plugin;',
					'export type W = typeof import("webpack");',
				].join("\n"),
			),
		).toEqual(["vite", "webpack", "vite/client", "../x.d.ts", "./y.d.ts"]);
	});

	it("resolves declaration imports to their declaration files", () => {
		expect(resolveRelative(installed, "entry.d.ts", "./types-C3.js")).toBe(
			"types-C3.d.ts",
		);
		expect(resolveRelative(installed, "entry.d.cts", "./types-C3.cjs")).toBe(
			"types-C3.d.cts",
		);
		expect(resolveRelative(installed, "sse/runtime.js", "../chunk-A1.js")).toBe(
			"chunk-A1.js",
		);
	});

	it("walks an entry's closure and collects bare specifiers", () => {
		const closure = closureOf(installed, "entry.js");
		expect(closure.files).toEqual(["entry.js", "chunk-A1.js", "lazy-B2.js"]);
		expect([...closure.bare.keys()]).toEqual(["graphql"]);
		expect(closure.unresolved).toEqual([]);
		expect(areasOf(installed, "lazy-B2.js")).toEqual(["transports/shared"]);
		expect(areasOf(installed, "entry.d.ts")).toEqual(["transports/sse"]);
	});
});

describe("pack pipeline helpers", () => {
	const lock = [
		"lockfileVersion: '9.0'",
		"importers:",
		"  .:",
		"    dependencies:",
		"      spinetab:",
		"        specifier: file:../pack/spinetab-0.1.0.tgz",
		"        version: file:../pack/spinetab-0.1.0.tgz(vue@3.5.43)",
		"      vue:",
		"        specifier: 3.5.43",
		"        version: 3.5.43",
		"packages:",
		"  '@vue/shared@3.5.43':",
		"    resolution: {integrity: sha512-shared}",
		"  spinetab@file:../pack/spinetab-0.1.0.tgz:",
		"    resolution: {integrity: sha512-AbC+/=, tarball: file:../pack/spinetab-0.1.0.tgz}",
		"  vue@3.5.43:",
		"    resolution: {integrity: sha512-vue}",
		"snapshots:",
		"  vue@3.5.43: {}",
	].join("\n");

	it("reads the packed tarball's integrity and the installed packages", () => {
		expect(lockfileSpinetabIntegrity(lock)).toBe("sha512-AbC+/=");
		expect([...lockfilePackages(lock)].sort()).toEqual([
			"@vue/shared",
			"spinetab",
			"vue",
		]);
	});

	it("ignores Spinetab's own lines when diffing lockfiles", () => {
		const repacked = lock.replace("sha512-AbC+/=", "sha512-XyZ");
		expect(lockfileDiff(lock, repacked)).toEqual([]);
		const drifted = lock.replace(
			"vue@3.5.43:\n    resolution",
			"vue@3.5.44:\n    resolution",
		);
		expect(lockfileDiff(lock, drifted)).toEqual([
			"+   vue@3.5.44:",
			"-   vue@3.5.43:",
		]);
	});

	it("hashes a directory deterministically by path and content", () => {
		const first = computeDistHash(installed);
		expect(first).toMatch(/^[0-9a-f]{64}$/);
		expect(computeDistHash(installed)).toBe(first);
		expect(computeDistHash(join(fixtures, "out-good"))).not.toBe(first);
	});
});

describe("front server arguments", () => {
	it("parses static, CSP, fault and route options", () => {
		expect(
			parseFrontArgs([
				"--port",
				"4610",
				"--static",
				"dist",
				"--mount",
				"/app/",
				"--csp",
				"default-src 'self'",
				"--worker-csp",
				"connect-src 'none'",
				"--worker-file",
				"live.worker-1.js",
				"--drop",
				"a.js",
				"--drop",
				"b.js",
				"--mime",
				"live.worker-1.js=text/plain",
				"--route",
				"/api/chat=server/chat.mjs",
				"--static-overlay",
				"dist-v2",
				"--spa",
			]),
		).toEqual({
			port: 4610,
			static: "dist",
			mount: "/app/",
			csp: "default-src 'self'",
			workerCsp: "connect-src 'none'",
			workerFiles: ["live.worker-1.js"],
			drop: ["a.js", "b.js"],
			mime: { "live.worker-1.js": "text/plain" },
			routes: { "/api/chat": "server/chat.mjs" },
			overlay: "dist-v2",
			spa: true,
		});
		expect(() => parseFrontArgs(["--bogus"])).toThrow(/Unknown front option/);
		expect(() => parseFrontArgs(["--mime", "novalue"])).toThrow(/expects/);
	});

	it("sends nosniff with every MIME override and logs the headers it sent", async () => {
		const dir = mkdtempSync(join(tmpdir(), "spinetab-front-"));
		try {
			mkdirSync(join(dir, "assets"));
			writeFileSync(join(dir, "assets/live.worker-1.js"), "self.x = 1;\n");
			writeFileSync(join(dir, "assets/page-1.js"), "x();\n");
			const front = await startFront({
				port: 0,
				static: dir,
				mime: { "live.worker-1.js": "text/plain" },
			});
			try {
				const headers = async (path: string) => {
					const response = await fetch(`${front.origin}${path}`);
					await response.arrayBuffer();
					return [
						response.headers.get("content-type"),
						response.headers.get("x-content-type-options"),
					];
				};
				expect(await headers("/assets/live.worker-1.js")).toEqual([
					"text/plain",
					"nosniff",
				]);
				expect(await headers("/assets/page-1.js")).toEqual([
					"text/javascript; charset=utf-8",
					null,
				]);
				expect(
					front
						.log()
						.requests.map((request) => [
							request.path,
							request.contentType,
							request.contentTypeOptions,
						]),
				).toEqual([
					["/assets/live.worker-1.js", "text/plain", "nosniff"],
					["/assets/page-1.js", "text/javascript; charset=utf-8", null],
				]);
			} finally {
				await front.close();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("compatibility matrix", () => {
	const record = (peers: MatrixRecord["peers"], pass = true): MatrixRecord => ({
		cell: "react-sse-tanstack-vite-prod",
		project: "chromium",
		consumer: "react-sse-tanstack",
		bundler: { name: "vite", version: "8.3.1" },
		mode: "prod",
		variant: "prod",
		browser: { name: "chromium", version: "153.0.8010.12" },
		peers,
		candidate: {
			sha256: "a".repeat(64),
			distHash: "b".repeat(64),
			gitHead: "c".repeat(40),
			dirty: true,
			sourceHash: "d".repeat(64),
		},
		command: { build: ["vite", "build"], serve: [], env: {} },
		evidence: "test-results/consumers/x",
		sizes: { emitted: {}, downloaded: { shared: 1 } },
		treeShaking: "on",
		pass,
		blocked: null,
		counters: {},
		notes: [],
	});

	it("finds the lowest version a range admits", () => {
		expect(lowerBound("^19.3.0")).toBe("19.3.0");
		expect(lowerBound("^16.0.0 || ^17.0.0")).toBe("16.0.0");
		expect(lowerBound("*")).toBeNull();
		expect(compareVersions("16.10.0", "16.9.9")).toBeGreaterThan(0);
	});

	it("reconciles manifest ranges with tested versions", () => {
		const records = [record([{ name: "react", version: "19.3.0", min: true }])];
		expect(
			reconcilePeers(
				{ react: "^19.3.0", vue: "^3.5.43", graphql: "^16.0.0 || ^17.0.0" },
				records,
			),
		).toEqual([
			{
				peer: "graphql",
				range: "^16.0.0 || ^17.0.0",
				lowerBound: "16.0.0",
				tested: [],
				status: "not-in-matrix",
			},
			{
				peer: "react",
				range: "^19.3.0",
				lowerBound: "19.3.0",
				tested: ["19.3.0"],
				status: "min-tested",
			},
			{
				peer: "vue",
				range: "^3.5.43",
				lowerBound: "3.5.43",
				tested: [],
				status: "not-in-matrix",
			},
		]);
		expect(reconcilePeers({ react: "^18.0.0" }, records)[0]?.status).toBe(
			"below-tested",
		);
	});

	it("renders one row per cell with tree shaking and candidate", () => {
		const table = renderTable(
			[record([{ name: "react", version: "19.3.0", min: true }], false)],
			[],
		);
		expect(table).toContain(
			"| react-sse-tanstack-vite-prod | chromium 153.0.8010.12 | vite 8.3.1 | prod | prod | on | react 19.3.0 (min) | aaaaaaaaaaaa (dirty) | fail |",
		);
	});

	it("reads app reports per engine and adds one row per app and engine", () => {
		const dir = mkdtempSync(join(tmpdir(), "spinetab-apps-"));
		try {
			const report = (app: string, candidate: string, streams?: number) =>
				JSON.stringify({
					app,
					candidate,
					connections: { shared: 1, perTab: 4 },
					recoveryLatencyMs: {
						samples: [500, 600, 700],
						median: 600,
						p95: 700,
					},
					...(streams === undefined ? {} : { recovery: { streams } }),
					fallbackReasons: { "worker-404": "worker-error" },
				});
			const a = "a".repeat(64);
			writeFileSync(
				join(dir, "app-app-http-chromium.json"),
				report("app-http", a, 11),
			);
			writeFileSync(
				join(dir, "app-app-http-webkit.json"),
				report("app-http", a, 12),
			);
			writeFileSync(
				join(dir, "app-app-graphql-firefox.json"),
				report("app-graphql", "e".repeat(64)),
			);
			// An engine-less legacy report and archived copies are not read.
			writeFileSync(join(dir, "app-app-http.json"), report("app-http", a));
			mkdirSync(join(dir, "archive"));
			writeFileSync(
				join(dir, "archive/app-app-http-chromium-old.json"),
				report("app-http", a),
			);
			const apps = readAppReports(dir);
			expect(
				apps.map((row) => [row.app, row.browser, row.recovery.streams]),
			).toEqual([
				["app-graphql", "firefox", null],
				["app-http", "chromium", 11],
				["app-http", "webkit", 12],
			]);
			const merged = mergeMatrix(join(dir, "no-records"), apps);
			expect(merged.apps).toHaveLength(3);
			expect(merged.markdown).toContain(
				"| app-http | webkit | aaaaaaaaaaaa | 1 / 4 | 3 | 600 | 700 | 12 | worker-error |",
			);
			expect(merged.markdown).toContain(
				"| app-graphql | firefox | eeeeeeeeeeee | 1 / 4 | 3 | 600 | 700 | n/a | worker-error |",
			);
			const table = renderTable([record([])], [], apps);
			expect(table).toContain("| app-http | chromium |");
			// Against records of candidate a, the report of another candidate fails.
			mkdirSync(join(dir, "records"));
			writeFileSync(
				join(dir, "records/chromium-cell.json"),
				JSON.stringify(record([])),
			);
			expect(mergeMatrix(join(dir, "records"), apps).failures).toEqual([
				"execution inventory missing; historical or partial records cannot certify this run",
				`app-app-graphql-firefox.json: candidate eeeeeeeeeeee is not the matrix candidate`,
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("app report statistics", () => {
	it("takes the middle value, or the mean of the two middle values", () => {
		expect(median([1, 2, 3, 4])).toBe(2.5);
		expect(median([3, 1, 2])).toBe(2);
		expect(median([])).toBeNull();
		expect(median([7])).toBe(7);
		// Unsorted input; the upper-middle order statistic (6th of 10) is not the median.
		const http = [270, 717, 140, 312, 188, 424, 1009, 312, 90, 48];
		expect(median(http)).toBe(291);
		const graphql = [
			3890, 4136, 2295, 3354, 2695, 3158, 1616, 3443, 2661, 4032,
		];
		expect(median(graphql)).toBe(3256);
		expect(http).toEqual([270, 717, 140, 312, 188, 424, 1009, 312, 90, 48]);
	});

	it("takes p95 by nearest rank", () => {
		const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
		expect(p95(range(10))).toBe(10);
		expect(p95(range(20))).toBe(19);
		expect(p95(range(100))).toBe(95);
		expect(p95(range(20).reverse())).toBe(19);
		expect(p95([5, 3, 9, 1])).toBe(9);
		expect(p95([])).toBeNull();
		expect(p95([42])).toBe(42);
	});

	it("states both definitions", () => {
		expect(DEFINITIONS.p95).toBe("nearest rank");
		expect(DEFINITIONS.median).toMatch(/mean of the two middle/);
	});
});
