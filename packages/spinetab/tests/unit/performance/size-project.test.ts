import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	SCENARIOS,
	selectScenarios,
	TOOLCHAIN,
	unselectedBases,
} from "../../performance/size/catalogue.ts";
import {
	checkNextExport,
	type NEXT_TSCONFIG,
	NEXT_TYPE_PACKAGES,
	nextBuildDir,
	nextExportDir,
	nextScenarioPaths,
	prepareNextBuild,
	projectManifest,
	settleNextBuild,
	toolchainFingerprint,
	toolchainMutations,
	writeProject,
} from "../../performance/size/project.ts";

const root = new URL("../../../", import.meta.url);
const read = <T>(path: string) =>
	JSON.parse(readFileSync(new URL(path, root), "utf8")) as T;
const templates = new URL("tests/performance/size/scenarios", root).pathname;
const nextTemplates = ["next-app", "next-ai", "next-negative"];

const dirs: string[] = [];
const temp = () => {
	const dir = mkdtempSync(join(tmpdir(), "spinetab-size-unit-"));
	dirs.push(dir);
	return dir;
};
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
	delete process.env.SIZE_NEXT_EXPORT_DIR;
});

describe("Next export destination (Next 16.3.6 build/index.js l.538–542)", () => {
	const dir = "/work/next";

	it("exports to out/ with the default or an explicit .next distDir", () => {
		expect(nextExportDir(dir, { output: "export" })).toBe("/work/next/out");
		expect(nextExportDir(dir, { output: "export", distDir: ".next" })).toBe(
			"/work/next/out",
		);
		expect(nextBuildDir(dir, { output: "export" })).toBe("/work/next/.next");
	});

	it("exports to a custom distDir and keeps build state in .next", () => {
		const config = { output: "export", distDir: "outputs/core-min" };
		expect(nextExportDir(dir, config)).toBe("/work/next/outputs/core-min");
		expect(nextBuildDir(dir, config)).toBe("/work/next/.next");
		// The old harness's assumption: a custom distDir is not a build dir.
		expect(
			nextExportDir(dir, { output: "export", distDir: ".next-core-min" }),
		).not.toBe("/work/next/out");
	});

	it("treats a custom distDir as the build dir without a static export", () => {
		const config = { distDir: ".next-custom" };
		expect(nextBuildDir(dir, config)).toBe("/work/next/.next-custom");
		expect(nextExportDir(dir, config)).toBe("/work/next/out");
	});

	it("gives every scenario and mode its own export and state directory", () => {
		const keys = SCENARIOS.flatMap((scenario) =>
			(["min", "raw"] as const).map((mode) =>
				nextScenarioPaths(dir, scenario.id, mode),
			),
		);
		expect(new Set(keys.map((paths) => paths.exportDir)).size).toBe(
			keys.length,
		);
		expect(new Set(keys.map((paths) => paths.stateDir)).size).toBe(keys.length);
		const core = nextScenarioPaths(dir, "core", "min");
		expect(core).toEqual({
			key: "core-min",
			distDir: "outputs/core-min",
			exportDir: "/work/next/outputs/core-min",
			buildDir: "/work/next/.next",
			stateDir: "/work/next/build-state/core-min",
		});
		expect(
			nextExportDir(dir, { output: "export", distDir: core.distDir }),
		).toBe(core.exportDir);
	});
});

describe("per-scenario isolation of Next outputs and build state", () => {
	const touch = (path: string, text = "x") => {
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, text);
	};

	it("cleans only its own export and state and moves an unowned .next aside", () => {
		const dir = temp();
		const core = nextScenarioPaths(dir, "core", "min");
		const other = nextScenarioPaths(dir, "websocket", "min");
		touch(join(other.exportDir, "index.html"));
		touch(join(other.stateDir, "BUILD_ID"));
		touch(join(core.exportDir, "stale.js"));
		touch(join(core.stateDir, "BUILD_ID"));
		touch(join(dir, ".next", "cache", "turbopack", "blob"));

		const stale = prepareNextBuild(dir, core);

		expect(existsSync(core.exportDir)).toBe(false);
		expect(existsSync(core.stateDir)).toBe(false);
		expect(existsSync(core.buildDir)).toBe(false);
		expect(stale).toMatch(/build-state\/stale-/);
		expect(
			existsSync(join(stale as string, "cache", "turbopack", "blob")),
		).toBe(true);
		expect(readFileSync(join(other.exportDir, "index.html"), "utf8")).toBe("x");
		expect(existsSync(join(other.stateDir, "BUILD_ID"))).toBe(true);
	});

	it("keeps each build's state under build-state/<key> without its cache", () => {
		const dir = temp();
		const core = nextScenarioPaths(dir, "core", "raw");
		const other = nextScenarioPaths(dir, "baseline-empty", "raw");
		touch(join(other.stateDir, "BUILD_ID"), "baseline");
		expect(prepareNextBuild(dir, core)).toBeUndefined();
		touch(join(core.buildDir, "BUILD_ID"), "core");
		touch(join(core.buildDir, "cache", "turbopack", "blob"));

		settleNextBuild(core);

		expect(existsSync(core.buildDir)).toBe(false);
		expect(readFileSync(join(core.stateDir, "BUILD_ID"), "utf8")).toBe("core");
		expect(existsSync(join(core.stateDir, "cache"))).toBe(false);
		expect(readFileSync(join(other.stateDir, "BUILD_ID"), "utf8")).toBe(
			"baseline",
		);
		// A build that never created.next leaves nothing to settle.
		expect(() => settleNextBuild(core)).not.toThrow();
	});

	it("checks the export against Next's own export-detail.json", () => {
		const dir = temp();
		const core = nextScenarioPaths(dir, "core", "min");
		const detail = (outDirectory: string, success: boolean) =>
			touch(
				join(core.buildDir, "export-detail.json"),
				JSON.stringify({ version: 1, outDirectory, success }),
			);
		expect(checkNextExport(core.buildDir, core.exportDir)).toMatch(/^no /);
		detail(join(dir, "out"), true);
		expect(checkNextExport(core.buildDir, core.exportDir)).toMatch(
			/exported to .*\/out, expected/,
		);
		detail(core.exportDir, false);
		expect(checkNextExport(core.buildDir, core.exportDir)).toMatch(/success/);
		detail(core.exportDir, true);
		expect(checkNextExport(core.buildDir, core.exportDir)).toMatch(
			/no index\.html/,
		);
		touch(join(core.exportDir, "index.html"));
		expect(checkNextExport(core.buildDir, core.exportDir)).toBeUndefined();
	});

	it("accepts Next's resolved path for a symlinked work root", () => {
		const real = temp();
		const linked = join(temp(), "work");
		symlinkSync(real, linked);
		const viaLink = nextScenarioPaths(linked, "core", "min");
		const resolved = nextScenarioPaths(realpathSync(real), "core", "min");
		touch(join(viaLink.exportDir, "index.html"));
		touch(
			join(viaLink.buildDir, "export-detail.json"),
			JSON.stringify({ outDirectory: resolved.exportDir, success: true }),
		);
		expect(
			checkNextExport(viaLink.buildDir, viaLink.exportDir),
		).toBeUndefined();
		touch(
			join(viaLink.buildDir, "export-detail.json"),
			JSON.stringify({ outDirectory: join(real, "out"), success: true }),
		);
		expect(checkNextExport(viaLink.buildDir, viaLink.exportDir)).toMatch(
			/expected/,
		);
	});
});

describe("seeded Next project pins the consumer templates' toolchain", () => {
	it("TOOLCHAIN equals every Next consumer template and the package pins", () => {
		const own = read<{ devDependencies: Record<string, string> }>(
			"package.json",
		).devDependencies;
		for (const name of nextTemplates) {
			const manifest = read<{
				dependencies: Record<string, string>;
				devDependencies: Record<string, string>;
			}>(`tests/fixtures/consumers/${name}/package.json`);
			expect(manifest.dependencies.next, name).toBe(TOOLCHAIN.next);
			for (const pkg of NEXT_TYPE_PACKAGES) {
				expect(manifest.devDependencies[pkg], `${name} ${pkg}`).toBe(
					TOOLCHAIN[pkg],
				);
			}
		}
		for (const pkg of [...NEXT_TYPE_PACKAGES, "vite"] as const) {
			expect(own[pkg], pkg).toBe(TOOLCHAIN[pkg]);
		}
		expect(TOOLCHAIN).toMatchObject({
			next: "16.3.6",
			typescript: "6.0.3",
			"@types/node": "24.13.2",
			"@types/react": "19.3.0",
			"@types/react-dom": "19.3.0",
		});
	});

	it("seeds every type package Next 16.3.6 would install", () => {
		for (const pkg of ["typescript", "@types/react", "@types/node"]) {
			expect(NEXT_TYPE_PACKAGES).toContain(pkg);
		}
		const manifest = projectManifest("next", { react: "19.3.0" }) as {
			devDependencies: Record<string, string>;
		};
		expect(manifest.devDependencies).toEqual({
			next: "16.3.6",
			typescript: "6.0.3",
			"@types/node": "24.13.2",
			"@types/react": "19.3.0",
			"@types/react-dom": "19.3.0",
		});
	});

	it("writes the pinned manifest, a stable tsconfig and an export-dir config", async () => {
		const dir = temp();
		const scenarios = selectScenarios("baseline-empty,core");
		writeProject(dir, "next", scenarios, { react: "19.3.0" }, templates);

		const manifest = JSON.parse(
			readFileSync(join(dir, "package.json"), "utf8"),
		) as { devDependencies: Record<string, string> };
		expect(manifest.devDependencies["@types/node"]).toBe("24.13.2");
		const tsconfig = JSON.parse(
			readFileSync(join(dir, "tsconfig.json"), "utf8"),
		) as typeof NEXT_TSCONFIG;
		const template = read<typeof NEXT_TSCONFIG>(
			"tests/fixtures/consumers/next-app/tsconfig.json",
		);
		expect(tsconfig.compilerOptions).toEqual(template.compilerOptions);
		// writeConfigurationDefaults adds these when absent (l.286–316).
		expect(tsconfig.include).toEqual(
			expect.arrayContaining([
				".next/types/**/*.ts",
				".next/dev/types/**/*.ts",
			]),
		);
		expect(tsconfig.exclude).toEqual([
			"node_modules",
			"outputs",
			"build-state",
		]);
		expect(readdirSync(join(dir, "src/scenarios")).sort()).toEqual([
			"baseline-empty",
			"core",
		]);

		const config = pathToFileURL(join(dir, "next.config.mjs")).href;
		await expect(import(`${config}?unset`)).rejects.toThrow(
			/SIZE_NEXT_EXPORT_DIR/,
		);
		const paths = nextScenarioPaths(dir, "core", "min");
		process.env.SIZE_NEXT_EXPORT_DIR = paths.distDir;
		const loaded = (await import(`${config}?set`)) as {
			default: { output: string; distDir: string };
		};
		expect(loaded.default.output).toBe("export");
		expect(nextExportDir(dir, loaded.default)).toBe(paths.exportDir);
		expect(nextBuildDir(dir, loaded.default)).toBe(paths.buildDir);
	});

	it("detects a build that installs types or rewrites the toolchain", () => {
		const dir = temp();
		writeFileSync(join(dir, "package.json"), "{}\n");
		const before = toolchainFingerprint(dir);
		expect(before["tsconfig.json"]).toBeNull();
		writeFileSync(join(dir, "package.json"), '{"devDependencies":{}}\n');
		expect(toolchainFingerprint(dir)["package.json"]).not.toBe(
			before["package.json"],
		);

		// Representative Next.js static-export output.
		const installing = [
			"  Skipping validation of types",
			"It looks like you're trying to use TypeScript but do not have the required package(s) installed.",
			"Installing devDependencies (pnpm):",
			"- @types/node",
			"  We detected TypeScript in your project and created a tsconfig.json file for you.",
		].join("\n");
		expect(toolchainMutations(installing)).toHaveLength(3);
		const clean = [
			"  Skipping validation of types",
			"  Finished TypeScript config validation in 12ms ...",
			"✓ Generating static pages using 4 workers (3/3) in 248ms",
		].join("\n");
		expect(toolchainMutations(clean)).toEqual([]);
	});
});

describe("--only selection", () => {
	it("selects baseline-empty with core and websocket in catalogue order", () => {
		const selection = selectScenarios("websocket, core,baseline-empty");
		expect(selection.map((scenario) => scenario.id)).toEqual([
			"baseline-empty",
			"core",
			"websocket",
		]);
		expect(unselectedBases(selection)).toEqual({});
	});

	it("names the missing base of the root preflight's core,websocket selection", () => {
		expect(unselectedBases(selectScenarios("core,websocket"))).toEqual({
			core: "baseline-empty",
		});
		expect(unselectedBases(selectScenarios("websocket"))).toEqual({
			websocket: "core",
		});
	});

	it("rejects unknown or empty ids and selects all when omitted", () => {
		expect(() => selectScenarios("core,baseline_empty")).toThrow(
			/baseline_empty/,
		);
		expect(() => selectScenarios(",")).toThrow(/empty/);
		expect(selectScenarios()).toHaveLength(SCENARIOS.length);
		expect(SCENARIOS).toHaveLength(20);
		expect(SCENARIOS.find((scenario) => scenario.id === "core")?.base).toBe(
			"baseline-empty",
		);
	});
});
