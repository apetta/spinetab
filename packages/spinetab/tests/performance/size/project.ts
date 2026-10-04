import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { writeJson } from "../lib/evidence.ts";
import {
	type PluginScenario,
	type SizeScenario,
	TOOLCHAIN,
} from "./catalogue.ts";

/**
 * Size consumer projects: the seeded manifest and
 * tsconfig, and where Next writes a static export and its build state.
 * Separate from `measure.ts` so the path rules and pins are unit-tested
 * (tests/unit/performance/size-project.test.ts). Node-runnable.
 */

export type Bundler = "vite" | "next";
export type Mode = "min" | "raw";

/** The subset of next.config that decides the export and build directories. */
export interface NextOutputConfig {
	output?: string;
	distDir?: string;
}

/**
 * Next 16.3.6 `export/utils.js` `hasCustomExportOutput`: with
 * `output: "export"`, any `distDir` other than `.next` is the export
 * destination, not the build directory.
 */
export function hasCustomExportOutput(config: NextOutputConfig): boolean {
	return (
		config.output === "export" &&
		config.distDir !== undefined &&
		config.distDir !== ".next"
	);
}

/**
 * Where `next build` writes the static export. Next 16.3.6
 * `build/index.js` l.538–542: `configOutDir` is `out` unless
 * `hasCustomExportOutput`, then it is the configured `distDir`;
 * `writeFullyStaticExport` exports to `join(dir, configOutDir)` (l.434).
 */
export function nextExportDir(
	projectDir: string,
	config: NextOutputConfig,
): string {
	return hasCustomExportOutput(config)
		? resolve(projectDir, config.distDir as string)
		: join(projectDir, "out");
}

/**
 * Where `next build` keeps manifests, traces and the Turbopack cache. With a
 * custom export destination Next resets `config.distDir` to `.next`
 * (`build/index.js` l.541), so this is `.next` for every size build.
 */
export function nextBuildDir(
	projectDir: string,
	config: NextOutputConfig,
): string {
	return hasCustomExportOutput(config)
		? join(projectDir, ".next")
		: join(projectDir, config.distDir ?? ".next");
}

export interface NextScenarioPaths {
	/** `<scenario>-<mode>`. */
	key: string;
	/** Relative `distDir` passed to next.config (`SIZE_NEXT_EXPORT_DIR`). */
	distDir: string;
	/** Static export destination (Next writes it; nothing is renamed). */
	exportDir: string;
	/** Next's build directory while this build runs (always `.next`). */
	buildDir: string;
	/** Where this build's state is kept afterwards, cache removed. */
	stateDir: string;
}

/** Where a Next project keeps each build's export and state. */
export interface NextLayout {
	outputs: string;
	state: string;
}

const L1_NEXT_LAYOUT: NextLayout = { outputs: "outputs", state: "build-state" };

/**
 * Plugin roots: exports under `out/` and state under `build/`, top-level
 * directories the plugin's scan skips, so a raw build never infers
 * adapters from the minified build's output or server bundles.
 */
export const PLUGIN_NEXT_LAYOUT: NextLayout = {
	outputs: "out",
	state: "build",
};

/** Owned paths of one Next size build. */
export function nextScenarioPaths(
	projectDir: string,
	scenarioId: string,
	mode: Mode,
	layout: NextLayout = L1_NEXT_LAYOUT,
): NextScenarioPaths {
	const key = `${scenarioId}-${mode}`;
	const distDir = posix.join(layout.outputs, key);
	const config = { output: "export", distDir };
	return {
		key,
		distDir,
		exportDir: nextExportDir(projectDir, config),
		buildDir: nextBuildDir(projectDir, config),
		stateDir: join(projectDir, layout.state, key),
	};
}

/**
 * Before a Next build: remove only this build's own export and state. A
 * `.next` left by an interrupted build belongs to no scenario, so it is
 * moved aside beside the layout's state (`build-state/stale-*`, or
 * `build/stale-*` in a plugin root), never deleted or reused: each build
 * starts without another scenario's Turbopack cache.
 */
export function prepareNextBuild(
	_projectDir: string,
	paths: NextScenarioPaths,
): string | undefined {
	rmSync(paths.exportDir, { recursive: true, force: true });
	rmSync(paths.stateDir, { recursive: true, force: true });
	if (!existsSync(paths.buildDir)) return undefined;
	const stale = join(
		dirname(paths.stateDir),
		`stale-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`,
	);
	mkdirSync(dirname(stale), { recursive: true });
	renameSync(paths.buildDir, stale);
	return stale;
}

/**
 * After a Next build (passed or failed): keep its build state under
 * `build-state/<key>` for diagnosis and drop only its Turbopack cache.
 */
export function settleNextBuild(paths: NextScenarioPaths): void {
	if (!existsSync(paths.buildDir)) return;
	mkdirSync(dirname(paths.stateDir), { recursive: true });
	renameSync(paths.buildDir, paths.stateDir);
	rmSync(join(paths.stateDir, "cache"), { recursive: true, force: true });
}

/**
 * Next's own record of the export (`export/index.js` writes
 * `<build dir>/export-detail.json` with `outDirectory`, then `success`).
 */
export function checkNextExport(
	buildDir: string,
	exportDir: string,
): string | undefined {
	const detailPath = join(buildDir, "export-detail.json");
	if (!existsSync(detailPath)) return `no ${detailPath}`;
	const detail = JSON.parse(readFileSync(detailPath, "utf8")) as {
		outDirectory?: string;
		success?: boolean;
	};
	// Next records the resolved project path (macOS: /var → /private/var).
	const real = (path: string) => (existsSync(path) ? realpathSync(path) : path);
	if (
		detail.outDirectory === undefined ||
		real(detail.outDirectory) !== real(exportDir)
	) {
		return `Next exported to ${detail.outDirectory}, expected ${exportDir}`;
	}
	if (detail.success !== true) return "Next export-detail.json success≠true";
	if (!existsSync(join(exportDir, "index.html"))) {
		return `no index.html in ${exportDir}`;
	}
	return undefined;
}

export const NEXT_TYPE_PACKAGES = [
	"typescript",
	"@types/node",
	"@types/react",
	"@types/react-dom",
] as const;

export function projectManifest(
	bundler: Bundler,
	peers: Record<string, string>,
): Record<string, unknown> {
	const devDependencies: Record<string, string> =
		bundler === "vite"
			? { vite: TOOLCHAIN.vite, typescript: TOOLCHAIN.typescript }
			: {
					next: TOOLCHAIN.next,
					...Object.fromEntries(
						NEXT_TYPE_PACKAGES.map((name) => [name, TOOLCHAIN[name]]),
					),
				};
	return {
		name: `spinetab-size-${bundler}`,
		private: true,
		type: "module",
		dependencies: { spinetab: "file:../spinetab.tgz", ...peers },
		devDependencies,
	};
}

/**
 * The consumer templates' compiler options with the `include` entries Next
 * 16.3.6 adds when absent (`lib/typescript/writeConfigurationDefaults.js`
 * l.286–316, `type-paths.js`: `<distDir>/types/**` and
 * `<distDir>/dev/types/**` for the build directory `.next`), so Next never
 * rewrites it. Outputs and kept build state are excluded.
 */
export const NEXT_TSCONFIG = {
	compilerOptions: {
		target: "ES2022",
		lib: ["dom", "dom.iterable", "esnext"],
		allowJs: false,
		skipLibCheck: true,
		strict: true,
		noEmit: true,
		esModuleInterop: true,
		module: "esnext",
		moduleResolution: "bundler",
		resolveJsonModule: true,
		isolatedModules: true,
		jsx: "react-jsx",
		incremental: false,
		plugins: [{ name: "next" }],
	},
	include: [
		"next-env.d.ts",
		".next/types/**/*.ts",
		".next/dev/types/**/*.ts",
		"**/*.ts",
		"**/*.tsx",
	],
	exclude: ["node_modules", "outputs", "build-state"],
};

/** A plugin root's tsconfig: the same options, its own output directories excluded. */
export const PLUGIN_NEXT_TSCONFIG = {
	...NEXT_TSCONFIG,
	exclude: [
		"node_modules",
		PLUGIN_NEXT_LAYOUT.outputs,
		PLUGIN_NEXT_LAYOUT.state,
	],
};

/** Files a build must never change (Next installs types or rewrites tsconfig). */
export const TOOLCHAIN_FILES = [
	"package.json",
	"pnpm-lock.yaml",
	"tsconfig.json",
] as const;

export function toolchainFingerprint(
	projectDir: string,
): Record<string, string | null> {
	return Object.fromEntries(
		TOOLCHAIN_FILES.map((file) => {
			const path = join(projectDir, file);
			return [
				file,
				existsSync(path)
					? createHash("sha256").update(readFileSync(path)).digest("hex")
					: null,
			];
		}),
	);
}

/** Lines of a build log showing Next installing or rewriting the toolchain. */
export function toolchainMutations(log: string): string[] {
	return log
		.split("\n")
		.filter((line) =>
			/Installing (dev)?[dD]ependencies|do not have the required package|created a tsconfig\.json|reconfigured your tsconfig|were added to your .*tsconfig|mandatory changes/.test(
				line,
			),
		)
		.map((line) => line.trim());
}

export function writeProject(
	dir: string,
	bundler: Bundler,
	scenarios: SizeScenario[],
	peers: Record<string, string>,
	templates: string,
): void {
	mkdirSync(dir, { recursive: true });
	writeJson(join(dir, "package.json"), projectManifest(bundler, peers));
	for (const scenario of scenarios) {
		cpSync(
			join(templates, scenario.id),
			join(dir, "src/scenarios", scenario.id),
			{ recursive: true },
		);
	}
	if (bundler === "vite") {
		writeFileSync(
			join(dir, "vite.config.mjs"),
			`// Size build: default minifier (oxc) or none, sourcemaps on.
const scenario = process.env.SIZE_SCENARIO;
const raw = process.env.SIZE_RAW === "1";
export default {
	build: {
		outDir: \`dist/\${scenario}-\${raw ? "raw" : "min"}\`,
		emptyOutDir: true,
		sourcemap: true,
		manifest: true,
		...(raw ? { minify: false } : {}),
		rolldownOptions: { input: \`html/\${scenario}.html\` },
	},
	worker: { format: "es" },
};
`,
		);
		mkdirSync(join(dir, "html"), { recursive: true });
		for (const scenario of scenarios) {
			writeFileSync(
				join(dir, "html", `${scenario.id}.html`),
				`<!doctype html>\n<html lang="en-GB"><head><meta charset="utf-8"><title>${scenario.id}</title></head><body><div id="app"></div><script type="module" src="/src/scenarios/${scenario.id}/main.ts"></script></body></html>\n`,
			);
			writeFileSync(
				join(dir, "src/scenarios", scenario.id, "main.ts"),
				`import { start } from "./page";\n\nstart(document.getElementById("app") as HTMLElement);\n`,
			);
		}
		return;
	}
	writeJson(join(dir, "tsconfig.json"), NEXT_TSCONFIG);
	writeFileSync(
		join(dir, "next.config.mjs"),
		`// Size build: default bundler, static export, browser sourcemaps.
// With output: "export", a custom distDir is the export destination and the
// build directory stays .next (Next 16.3.6 build/index.js l.538–542), so
// SIZE_NEXT_EXPORT_DIR names this scenario's own output directory.
const exportDir = process.env.SIZE_NEXT_EXPORT_DIR;
if (!exportDir) throw new Error("SIZE_NEXT_EXPORT_DIR is required");
const raw = process.env.SIZE_RAW === "1";
export default {
	output: "export",
	distDir: exportDir,
	productionBrowserSourceMaps: true,
	typescript: { ignoreBuildErrors: true },
	...(raw ? { experimental: { turbopackMinify: false } } : {}),
};
`,
	);
	mkdirSync(join(dir, "app"), { recursive: true });
	writeFileSync(
		join(dir, "app/layout.tsx"),
		`export default function RootLayout({ children }: { children: React.ReactNode }) {\n\treturn (\n\t\t<html lang="en-GB">\n\t\t\t<body>{children}</body>\n\t\t</html>\n\t);\n}\n`,
	);
}

/**
 * A plugin scenario's own project root, inside the bundler project so it
 * resolves the same pinned install (Node's lookup walks up). The root holds
 * no package.json, so the plugin scans it alone (`scanRootsFor`).
 */
export const pluginRoot = (dir: string, scenarioId: string): string =>
	join(dir, "l3", scenarioId);

const NEXT_LAYOUT_TSX = `export default function RootLayout({ children }: { children: React.ReactNode }) {\n\treturn (\n\t\t<html lang="en-GB">\n\t\t\t<body>{children}</body>\n\t\t</html>\n\t);\n}\n`;

/**
 * Write a plugin scenario's root afresh (a file an earlier template left,
 * such as a `spinetab.worker.ts`, would change the plan): the template as
 * `src/`, then the bundler's entry and a config that applies the Spinetab
 * plugin with the scenario's options. Vite builds from the root into
 * `<dir>/dist/<id>-<mode>`, outside every scan root; Next builds from the
 * root (the invocation directory) with `PLUGIN_NEXT_LAYOUT`.
 */
export function writePluginProject(
	dir: string,
	bundler: Bundler,
	scenario: PluginScenario,
	templates: string,
): string {
	const root = pluginRoot(dir, scenario.id);
	rmSync(root, { recursive: true, force: true });
	cpSync(join(templates, scenario.template ?? scenario.id), join(root, "src"), {
		recursive: true,
	});
	const options =
		scenario.options === undefined ? "" : JSON.stringify(scenario.options);
	if (bundler === "vite") {
		writeFileSync(
			join(root, "index.html"),
			`<!doctype html>\n<html lang="en-GB"><head><meta charset="utf-8"><title>${scenario.id}</title></head><body><div id="app"></div><script type="module" src="/src/main.ts"></script></body></html>\n`,
		);
		writeFileSync(
			join(root, "src/main.ts"),
			`import { start } from "./page";\n\nstart(document.getElementById("app") as HTMLElement);\n`,
		);
		const out = (mode: Mode) =>
			JSON.stringify(join(dir, "dist", `${scenario.id}-${mode}`));
		writeFileSync(
			join(root, "vite.config.mjs"),
			`// Size build: the Spinetab plugin at ${scenario.level}, built
// from this scenario's own root; default minifier (oxc) or none, sourcemaps on.
import { spinetab } from "spinetab/vite";

const raw = process.env.SIZE_RAW === "1";
export default {
	root: ${JSON.stringify(root)},
	plugins: [spinetab(${options})],
	build: {
		outDir: raw ? ${out("raw")} : ${out("min")},
		emptyOutDir: true,
		sourcemap: true,
		manifest: true,
		...(raw ? { minify: false } : {}),
	},
	worker: { format: "es" },
};
`,
		);
		return root;
	}
	writeJson(join(root, "tsconfig.json"), PLUGIN_NEXT_TSCONFIG);
	writeFileSync(
		join(root, "next.config.mjs"),
		`// Size build: the Spinetab plugin at ${scenario.level}, with
// this scenario's root as the project directory; default bundler, static
// export, browser sourcemaps. SIZE_NEXT_EXPORT_DIR names the export directory.
import { withSpinetab } from "spinetab/next";

const exportDir = process.env.SIZE_NEXT_EXPORT_DIR;
if (!exportDir) throw new Error("SIZE_NEXT_EXPORT_DIR is required");
const raw = process.env.SIZE_RAW === "1";
export default withSpinetab(
	{
		output: "export",
		distDir: exportDir,
		productionBrowserSourceMaps: true,
		typescript: { ignoreBuildErrors: true },
		...(raw ? { experimental: { turbopackMinify: false } } : {}),
	},${options === "" ? "" : `\n\t${options},`}
);
`,
	);
	mkdirSync(join(root, "app"), { recursive: true });
	writeFileSync(join(root, "app/layout.tsx"), NEXT_LAYOUT_TSX);
	writeFileSync(
		join(root, "app/page.tsx"),
		`"use client";\nimport { useEffect, useRef } from "react";\nimport { start } from "../src/page";\n\nexport default function Page() {\n\tconst root = useRef<HTMLDivElement>(null);\n\tuseEffect(() => {\n\t\tif (root.current) start(root.current);\n\t}, []);\n\treturn <div id="app" ref={root} />;\n}\n`,
	);
	return root;
}
