import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { validateOptions } from "../../../src/build/options.ts";
import {
	findConventionalWorkerFiles,
	resolveAdapterSet,
	resolvePlan,
} from "../../../src/build/plan.ts";
import { inferAdapters, scanRootsFor } from "../../../src/build/scan.ts";
import { spinetabClosure } from "../../performance/size/attribute.ts";
import {
	PLUGIN_ALIASES,
	PLUGIN_BUNDLERS_NOT_MEASURED,
	PLUGIN_SCENARIOS,
	type PluginScenario,
	SCENARIOS,
	selectRun,
} from "../../performance/size/catalogue.ts";
import {
	type Bundler,
	NEXT_TSCONFIG,
	nextScenarioPaths,
	PLUGIN_NEXT_LAYOUT,
	PLUGIN_NEXT_TSCONFIG,
	pluginRoot,
	prepareNextBuild,
	writePluginProject,
	writeProject,
} from "../../performance/size/project.ts";

// Give each inferred plugin scenario its own root so scanning cannot select adapters from neighbouring scenarios.

const pkg = fileURLToPath(new URL("../../../", import.meta.url));
const templates = join(pkg, "tests/performance/size/scenarios");
const BUNDLERS: readonly Bundler[] = ["vite", "next"];

const dirs: string[] = [];
const temp = () => {
	const dir = mkdtempSync(join(tmpdir(), "spinetab-size-plugin-"));
	dirs.push(dir);
	return dir;
};
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

const byId = (id: string): PluginScenario => {
	const scenario = PLUGIN_SCENARIOS.find((candidate) => candidate.id === id);
	if (!scenario) throw new Error(`no plugin scenario ${id}`);
	return scenario;
};

/** Every file under `dir`, POSIX-relative, sorted. */
function files(dir: string): string[] {
	const found: string[] = [];
	const walk = (current: string) => {
		for (const entry of readdirSync(current)) {
			const path = join(current, entry);
			if (statSync(path).isDirectory()) walk(path);
			else found.push(relative(dir, path).replaceAll("\\", "/"));
		}
	};
	walk(dir);
	return found.sort();
}

const touch = (path: string, text: string) => {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
};

/** A bundler project as measure.ts writes it: L1 layout plus every plugin root. */
function project(bundler: Bundler): string {
	const dir = temp();
	// Peers resolve (the pinned install has them all), so a wrongly inferred
	// peer-backed adapter would be generated rather than dropped as missing.
	for (const peer of ["graphql-ws", "socket.io-client", "@trpc/client"]) {
		touch(join(dir, "node_modules", peer, "package.json"), "{}");
	}
	writeProject(dir, bundler, SCENARIOS, {}, templates);
	for (const scenario of PLUGIN_SCENARIOS) {
		writePluginProject(dir, bundler, scenario, templates);
	}
	return dir;
}

describe("repro: one shared project root infers every scenario's adapters", () => {
	it("an L3 scan of the L1 size project's root selects the adapters of all scenarios", () => {
		const dir = temp();
		writeProject(dir, "vite", SCENARIOS, {}, templates);
		const inferred = inferAdapters(scanRootsFor(dir));
		expect(inferred.kinds).toEqual(
			expect.arrayContaining(["ai-sdk", "polling", "sse", "stream"]),
		);
		expect(inferred.kinds.length).toBeGreaterThan(1);
	});
});

describe("plugin catalogue", () => {
	it("adds the L2 and L3 scenarios beside an unchanged L1 catalogue", () => {
		expect(PLUGIN_SCENARIOS.map((scenario) => scenario.id)).toEqual([
			"core-l2",
			"polling-l3",
			"polling-l3-explicit",
			"polling-l3-control",
			"graphql-ws-l3",
		]);
		expect(SCENARIOS.map((scenario) => scenario.id)).toEqual([
			"baseline-empty",
			"baseline-graphql-ws",
			"baseline-ws",
			"core",
			"websocket",
			"sse",
			"stream",
			"polling",
			"graphql-ws",
			"graphql-sse",
			"socket-io",
			"trpc",
			"ai-sdk",
			"apollo",
			"tanstack-query",
			"swr",
			"react",
			"vue",
			"svelte",
			"solid",
		]);
		for (const scenario of SCENARIOS) {
			expect(scenario.kind, scenario.id).not.toBe("plugin");
		}
	});

	it("each plugin scenario is a Spinetab scenario with an L1 counterpart and no L1 target", () => {
		const l1 = new Map(SCENARIOS.map((scenario) => [scenario.id, scenario]));
		for (const scenario of PLUGIN_SCENARIOS) {
			expect(scenario.kind, scenario.id).toBe("plugin");
			expect(scenario.spinetab, scenario.id).toBe(true);
			expect(scenario.target, scenario.id).toBeUndefined();
			expect(scenario.base, scenario.id).toBeUndefined();
			const counterpart = l1.get(scenario.counterpart);
			expect(counterpart?.spinetab, scenario.id).toBe(true);
			// Same peers as the counterpart: peer bytes compare like for like.
			expect(scenario.peers, scenario.id).toEqual(counterpart?.peers);
			expect(l1.has(scenario.id), scenario.id).toBe(false);
		}
		expect(byId("core-l2")).toMatchObject({
			level: "L2",
			counterpart: "core",
		});
		expect(byId("core-l2").expectedAdapters).toBeUndefined();
		expect(byId("polling-l3")).toMatchObject({
			level: "L3",
			counterpart: "polling",
			expectedAdapters: ["polling"],
			inferenceBase: "polling-l3-explicit",
		});
		expect(byId("polling-l3").options).toBeUndefined();
		expect(byId("polling-l3-explicit")).toMatchObject({
			level: "L3",
			counterpart: "polling",
			template: "polling-l3",
			options: { adapters: ["polling"] },
			expectedAdapters: ["polling"],
		});
		expect(byId("polling-l3-control")).toMatchObject({
			level: "L3",
			counterpart: "polling",
			expectedAdapters: ["polling"],
		});
		expect(byId("graphql-ws-l3")).toMatchObject({
			level: "L3",
			counterpart: "graphql-ws",
			peers: ["graphql-ws", "graphql"],
			expectedAdapters: ["graphql-ws"],
		});
	});

	it("names webpack, Rspack and Astro as plugin bundlers not measured", () => {
		expect(Object.keys(PLUGIN_BUNDLERS_NOT_MEASURED).sort()).toEqual([
			"astro",
			"rspack",
			"webpack",
		]);
		for (const reason of Object.values(PLUGIN_BUNDLERS_NOT_MEASURED)) {
			expect(reason).toMatch(/not measured/);
		}
	});

	it("core-l2's worker file uses the same clock adapter as L1 core", () => {
		const read = (path: string) => readFileSync(join(templates, path), "utf8");
		expect(read("core-l2/adapters.ts")).toBe(read("core/adapters.ts"));
		const worker = read("core-l2/spinetab.worker.ts");
		expect(worker).toMatch(
			/import \{ defineWorker \} from "spinetab\/worker";/,
		);
		expect(worker).toMatch(
			/export default defineWorker\(\(\) => adapters\(\)\);/,
		);
	});

	it("plugin pages take the plugin's wiring and signal the settled mode as L1 pages do", () => {
		for (const scenario of PLUGIN_SCENARIOS) {
			const page = readFileSync(
				join(templates, scenario.template ?? scenario.id, "page.ts"),
				"utf8",
			);
			expect(page, scenario.id).toMatch(/createSpinetab\(\{ sharing \}\)/);
			expect(page, scenario.id).not.toMatch(/SharedWorker|\bworker:|\blocal:/);
			expect(
				[...page.matchAll(/__sizeReady = ([^;]+);/g)].map((m) => m[1]),
				scenario.id,
			).toEqual(["status.mode"]);
			expect(page, scenario.id).toMatch(
				/status\.mode !== "inactive" && status\.mode !== "starting"/,
			);
			expect(page, scenario.id).toMatch(/get\("sharing"\) === "off"/);
		}
		// The control carries socket.io import text only in a comment and a string.
		const control = readFileSync(
			join(templates, "polling-l3-control/page.ts"),
			"utf8",
		);
		expect(control).toMatch(
			/^\/\/ import \{ socketIo \} from "spinetab\/socket-io";$/m,
		);
		expect(control).toMatch(
			/"import \{ socketIo \} from 'spinetab\/socket-io'"/,
		);
	});

	it("only the L2 template holds a conventional worker file", () => {
		for (const scenario of PLUGIN_SCENARIOS) {
			const template = join(templates, scenario.template ?? scenario.id);
			const workers = files(template).filter((file) =>
				/^spinetab\.worker\./.test(file),
			);
			expect(workers, scenario.id).toEqual(
				scenario.level === "L2" ? ["spinetab.worker.ts"] : [],
			);
		}
	});

	it("selects every scenario by default and mixes L1 and plugin ids with --only", () => {
		const all = selectRun();
		expect(all.scenarios).toEqual(SCENARIOS);
		expect(all.plugin).toEqual(PLUGIN_SCENARIOS);
		const mixed = selectRun("polling-l3, polling,core-l2");
		expect(mixed.scenarios.map((scenario) => scenario.id)).toEqual(["polling"]);
		expect(mixed.plugin.map((scenario) => scenario.id)).toEqual([
			"core-l2",
			"polling-l3",
		]);
		expect(selectRun("core").plugin).toEqual([]);
		expect(selectRun("graphql-ws-l3").scenarios).toEqual([]);
		expect(() => selectRun("polling-l4")).toThrow(/polling-l4/);
		expect(() => selectRun(",")).toThrow(/empty/);
	});
});

describe("isolated plugin roots: the scan reads only the scenario's own sources", () => {
	for (const bundler of BUNDLERS) {
		it(`${bundler}: every root plans at its level and infers exactly its expected adapters`, () => {
			const dir = project(bundler);
			for (const scenario of PLUGIN_SCENARIOS) {
				const root = pluginRoot(dir, scenario.id);
				expect(root).toBe(join(dir, "l3", scenario.id));
				expect(scanRootsFor(root), scenario.id).toEqual([root]);
				const plan = resolvePlan(root, validateOptions(scenario.options));
				expect(plan.level, scenario.id).toBe(scenario.level);
				if (plan.level === "L2") {
					expect(plan.workerFile).toBe(join(root, "src/spinetab.worker.ts"));
					continue;
				}
				const set = resolveAdapterSet(plan, { dev: false, excludes: [] });
				expect(set.kinds, scenario.id).toEqual(scenario.expectedAdapters);
				expect(set.explicit, scenario.id).toBe(scenario.options !== undefined);
				expect(set.warnings, scenario.id).toEqual([]);
				expect(findConventionalWorkerFiles(root), scenario.id).toEqual([]);
			}
		});
	}

	it("a Vite root holds its template, an entry and a config that builds from it with the plugin", () => {
		const dir = project("vite");
		const root = pluginRoot(dir, "polling-l3-explicit");
		expect(files(root)).toEqual([
			"index.html",
			"src/main.ts",
			"src/page.ts",
			"vite.config.mjs",
		]);
		expect(files(pluginRoot(dir, "core-l2"))).toEqual([
			"index.html",
			"src/adapters.ts",
			"src/main.ts",
			"src/page.ts",
			"src/spinetab.worker.ts",
			"vite.config.mjs",
		]);
		expect(readFileSync(join(root, "index.html"), "utf8")).toMatch(
			/<script type="module" src="\/src\/main\.ts"><\/script>/,
		);
		const config = readFileSync(join(root, "vite.config.mjs"), "utf8");
		expect(config).toMatch(/import \{ spinetab \} from "spinetab\/vite";/);
		expect(config).toContain(`root: ${JSON.stringify(root)},`);
		expect(config).toContain('plugins: [spinetab({"adapters":["polling"]})],');
		expect(config).toContain(
			JSON.stringify(join(dir, "dist", "polling-l3-explicit-raw")),
		);
		expect(config).toContain(
			JSON.stringify(join(dir, "dist", "polling-l3-explicit-min")),
		);
		expect(config).toMatch(/sourcemap: true/);
		expect(config).toMatch(/worker: \{ format: "es" \}/);
		const inferred = readFileSync(
			join(pluginRoot(dir, "polling-l3"), "vite.config.mjs"),
			"utf8",
		);
		expect(inferred).toContain("plugins: [spinetab()],");
	});

	it("a Next root holds its template, the app shell, a tsconfig and a withSpinetab config", () => {
		const dir = project("next");
		const root = pluginRoot(dir, "polling-l3-explicit");
		expect(files(root)).toEqual([
			"app/layout.tsx",
			"app/page.tsx",
			"next.config.mjs",
			"src/page.ts",
			"tsconfig.json",
		]);
		expect(readFileSync(join(root, "app/page.tsx"), "utf8")).toMatch(
			/"use client";[\s\S]*import \{ start \} from "\.\.\/src\/page";/,
		);
		const config = readFileSync(join(root, "next.config.mjs"), "utf8");
		expect(config).toMatch(/import \{ withSpinetab \} from "spinetab\/next";/);
		expect(config).toMatch(/SIZE_NEXT_EXPORT_DIR/);
		expect(config).toMatch(/productionBrowserSourceMaps: true/);
		expect(config).toContain('{"adapters":["polling"]}');
		const inferred = readFileSync(
			join(pluginRoot(dir, "polling-l3"), "next.config.mjs"),
			"utf8",
		);
		expect(inferred).not.toContain('"adapters"');
		expect(
			JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8")),
		).toEqual(PLUGIN_NEXT_TSCONFIG);
		expect(PLUGIN_NEXT_TSCONFIG.compilerOptions).toEqual(
			NEXT_TSCONFIG.compilerOptions,
		);
		expect(PLUGIN_NEXT_TSCONFIG.exclude).toEqual([
			"node_modules",
			"out",
			"build",
		]);
	});

	it("Next plugin builds export under out/ and keep state under build/, which the scan skips", () => {
		const dir = project("next");
		const scenario = byId("polling-l3");
		const root = pluginRoot(dir, scenario.id);
		const min = nextScenarioPaths(root, scenario.id, "min", PLUGIN_NEXT_LAYOUT);
		expect(min).toEqual({
			key: "polling-l3-min",
			distDir: "out/polling-l3-min",
			exportDir: join(root, "out/polling-l3-min"),
			buildDir: join(root, ".next"),
			stateDir: join(root, "build/polling-l3-min"),
		});
		// An earlier build's output and state must never widen a later scan.
		const leak = 'import { socketIo } from "spinetab/socket-io";\n';
		touch(join(min.exportDir, "_next/static/chunks/page.js"), leak);
		touch(join(min.stateDir, "server/app/page.js"), leak);
		touch(join(root, ".next/server/app/page.js"), leak);
		expect(inferAdapters(scanRootsFor(root)).kinds).toEqual(["polling"]);
		// Control: the same file in the scenario's sources is read.
		touch(join(root, "src/leak.ts"), leak);
		expect(inferAdapters(scanRootsFor(root)).kinds).toEqual([
			"polling",
			"socket-io",
		]);
	});

	it("moves a stale .next aside under the layout's state directory", () => {
		const dir = project("next");
		const root = pluginRoot(dir, "core-l2");
		const paths = nextScenarioPaths(root, "core-l2", "raw", PLUGIN_NEXT_LAYOUT);
		touch(join(root, ".next", "BUILD_ID"), "x");
		const stale = prepareNextBuild(root, paths);
		expect(stale).toMatch(/\/l3\/core-l2\/build\/stale-/);
		expect(existsSync(join(stale as string, "BUILD_ID"))).toBe(true);
		// The L1 layout keeps its own place.
		const l1 = nextScenarioPaths(dir, "core", "min");
		touch(join(dir, ".next", "BUILD_ID"), "x");
		expect(prepareNextBuild(dir, l1)).toMatch(/\/build-state\/stale-/);
	});

	it("rewriting a root removes files a previous template left behind", () => {
		const dir = project("vite");
		const scenario = byId("polling-l3");
		const root = pluginRoot(dir, scenario.id);
		touch(join(root, "src/spinetab.worker.ts"), "export default 1;\n");
		expect(resolvePlan(root, validateOptions(undefined)).level).toBe("L2");
		writePluginProject(dir, "vite", scenario, templates);
		expect(existsSync(join(root, "src/spinetab.worker.ts"))).toBe(false);
		expect(resolvePlan(root, validateOptions(undefined)).level).toBe("L3");
	});
});

describe("allowed Spinetab sources under the plugin's aliases (candidate dist)", () => {
	const POLLING_L3 = [".", "polling", "polling/runtime", "worker"];

	it("repro: without the aliases an L3 page's auto/wiring is outside the closure and the L1 stub inside", () => {
		const allowed = spinetabClosure(pkg, POLLING_L3);
		expect(allowed.has("dist/wiring.js")).toBe(true);
		expect(allowed.has("dist/auto/wiring.js")).toBe(false);
		expect(allowed.has("dist/auto/worker.js")).toBe(false);
	});

	it("with the aliases: auto/wiring and auto/worker are allowed; both stubs are not", () => {
		expect(PLUGIN_ALIASES).toEqual({
			wiring: "auto/wiring",
			"worker-config": null,
		});
		const allowed = spinetabClosure(pkg, POLLING_L3, PLUGIN_ALIASES);
		for (const file of [
			"dist/auto/wiring.js",
			"src/auto/wiring.ts",
			"dist/auto/worker.js",
			"src/auto/worker.ts",
			"dist/polling/runtime.js",
			"dist/worker.js",
		]) {
			expect(allowed.has(file), file).toBe(true);
		}
		for (const file of [
			"dist/wiring.js",
			"src/wiring.ts",
			"dist/worker-config.js",
			"src/worker-config.ts",
		]) {
			expect(allowed.has(file), file).toBe(false);
		}
		// Every plugin scenario's closure resolves on the packed manifest.
		for (const scenario of PLUGIN_SCENARIOS) {
			expect(
				spinetabClosure(pkg, scenario.subpaths, PLUGIN_ALIASES).has(
					"dist/auto/wiring.js",
				),
				scenario.id,
			).toBe(true);
		}
	});

	it("an alias to an export the manifest lacks still fails the closure", () => {
		expect(() =>
			spinetabClosure(pkg, ["."], { wiring: "auto/missing" }),
		).toThrow(/auto\/missing.*not found in the packed manifest/);
	});
});
