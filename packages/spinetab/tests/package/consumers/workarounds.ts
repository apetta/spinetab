import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { isPluginRecipe, type Recipe } from "./catalogue.ts";

/**
 * Workaround scans. Config
 * option paths must come from a small allow-list of documented options, the
 * allow-listed names must exist in the installed bundler's own type
 * declarations, and sources must use the verbatim worker expression without
 * Next-specific escape hatches. Build logs may not contain resolution
 * failures, any warning about Spinetab or any `[spinetab]` build message.
 *
 * Recipes: L1 cells (`one-file`, `three-file`) have no Spinetab
 * plugin and no plugin keys; plugin cells (`plugin`, `plugin-worker`) have
 * exactly one Spinetab plugin plus the wrapper's own keys (`PLUGIN_KEYS`).
 */

export const CONFIG_ALLOWLIST: Record<string, readonly string[]> = {
	vite: [
		"base",
		"build",
		"build.sourcemap",
		"build.manifest",
		"build.minify",
		"build.rolldownOptions",
		"build.rolldownOptions.treeshake",
		"worker",
		"worker.rolldownOptions",
		"worker.rolldownOptions.treeshake",
		"server",
		"server.host",
		"server.port",
		"preview",
		"preview.host",
		"preview.port",
	],
	webpack: [
		"mode",
		"entry",
		"output",
		"output.path",
		"output.module",
		"output.workerPublicPath",
		"devtool",
		"optimization",
		"optimization.usedExports",
		"optimization.sideEffects",
		"optimization.minimize",
		"optimization.concatenateModules",
		"plugins",
		"devServer",
		"devServer.host",
		"devServer.port",
	],
	rspack: [
		"mode",
		"entry",
		"output",
		"output.path",
		"output.module",
		"output.workerPublicPath",
		"devtool",
		"optimization",
		"optimization.usedExports",
		"optimization.sideEffects",
		"optimization.minimize",
		"optimization.concatenateModules",
		"plugins",
		"devServer",
		"devServer.host",
		"devServer.port",
	],
	astro: [
		"server",
		"server.host",
		"server.port",
		"vite",
		"vite.build",
		"vite.build.sourcemap",
	],
	next: [
		"headers",
		"basePath",
		"distDir",
		"reactStrictMode",
		"assetPrefix",
		"productionBrowserSourceMaps",
		"experimental",
		"experimental.turbopackWorkerAssetPrefix",
		"experimental.turbopackRemoveUnusedExports",
		"experimental.turbopackRemoveUnusedImports",
		"experimental.turbopackInferModuleSideEffects",
		"experimental.turbopackMinify",
		"experimental.turbopackScopeHoisting",
	],
};

CONFIG_ALLOWLIST["next-webpack"] = CONFIG_ALLOWLIST.next as readonly string[];

/** Plugins every recipe may use (the HTML plugins of the webpack family). */
const BASE_PLUGINS: Record<string, readonly string[]> = {
	vite: [],
	webpack: ["HtmlWebpackPlugin"],
	rspack: ["HtmlRspackPlugin"],
	astro: [],
	next: [],
	"next-webpack": [],
};

/**
 * The one Spinetab plugin a plugin cell carries, as `flattenConfig` reports
 * it: a plain-object plugin or integration by its `name`, a class instance
 * by its constructor. Next has no plugin list: `withSpinetab` shows up
 * only as its keys.
 */
export const SPINETAB_PLUGIN: Record<string, string | undefined> = {
	vite: "name:spinetab",
	astro: "name:spinetab",
	webpack: "SpinetabPlugin",
	rspack: "SpinetabPlugin",
};

/** Plugins allowed for a bundler and recipe. */
export function allowedPlugins(
	bundler: string,
	recipe: Recipe = "three-file",
): string[] {
	const spinetab = SPINETAB_PLUGIN[bundler];
	return [
		...(BASE_PLUGINS[bundler] ?? []),
		...(isPluginRecipe(recipe) && spinetab ? [spinetab] : []),
	];
}

/** L1 allow-list, kept for callers that predate recipes. */
export const ALLOWED_PLUGINS: Record<string, readonly string[]> = BASE_PLUGINS;

/**
 * Option keys only a plugin recipe may have: the plugin line itself,
 * and for Next the option names `withSpinetab` sets. Each is checked against
 * the bundler's types like the allow-list.
 */
const NEXT_PLUGIN_OPTIONS = [
	"turbopack",
	"turbopack.resolveAlias",
	"turbopack.rules",
	"webpack",
];

export const PLUGIN_KEYS: Record<string, readonly string[]> = {
	vite: ["plugins"],
	astro: ["integrations"],
	webpack: [],
	rspack: [],
	next: NEXT_PLUGIN_OPTIONS,
	"next-webpack": NEXT_PLUGIN_OPTIONS,
};

/** One `turbopack.rules` entry `withSpinetab` adds, by the file it matches. */
const nextRuleKeys = (file: string): string[] =>
	["*", "**"].flatMap((glob) => {
		const rule = `turbopack.rules.${glob}/spinetab/dist/${file}`;
		return [
			rule,
			`${rule}.as`,
			`${rule}.condition`,
			`${rule}.condition.path`,
			`${rule}.loaders`,
		];
	});

/**
 * The data keys `withSpinetab` contributes, exactly: its alias
 * specifiers and its rule globs are values, not option names, so they are
 * admitted by exact path and never by prefix. Any other alias or rule, such
 * as a hand-written `spinetab/…` alias beside the wrapper, stays
 * outside the allow-list. The rule glob is accepted as `*` or `**`.
 */
const NEXT_PLUGIN_DATA = [
	"turbopack.resolveAlias.spinetab/wiring",
	"turbopack.resolveAlias.spinetab/wiring.browser",
	// The developer's worker file (a `./` project-relative path).
	"turbopack.resolveAlias.spinetab/worker-config",
	// The loader on the shipped stub; development: the wiring rule.
	...nextRuleKeys("worker-config.js"),
	...nextRuleKeys("auto/wiring.js"),
];

export const PLUGIN_DATA_KEYS: Record<string, readonly string[]> = {
	vite: [],
	astro: [],
	webpack: [],
	rspack: [],
	next: NEXT_PLUGIN_DATA,
	"next-webpack": NEXT_PLUGIN_DATA,
};

export interface ConfigScan {
	outside: string[];
	undeclared: string[];
	plugins: string[];
}

/**
 * Paths outside the allow-list, allow-listed leaf names absent from the
 * types, foreign plugins. For a plugin recipe `plugins` also reports
 * `missing:<plugin>` or `duplicate:<plugin>` unless exactly one Spinetab
 * plugin is present (Next: unless `withSpinetab`'s alias key is present).
 */
export function scanConfig(
	bundler: string,
	keys: readonly string[],
	plugins: readonly string[],
	typeText: string,
	recipe: Recipe = "three-file",
): ConfigScan {
	const plugin = isPluginRecipe(recipe);
	const exact = new Set(CONFIG_ALLOWLIST[bundler] ?? []);
	const wrapper = new Set(plugin ? (PLUGIN_KEYS[bundler] ?? []) : []);
	const data = new Set(plugin ? (PLUGIN_DATA_KEYS[bundler] ?? []) : []);
	const outside = keys.filter(
		(key) => !exact.has(key) && !wrapper.has(key) && !data.has(key),
	);
	const undeclared = keys
		.filter((key) => exact.has(key) || wrapper.has(key))
		.map((key) => key.split(".").at(-1) as string)
		.filter(
			(name, index, all) =>
				all.indexOf(name) === index &&
				!new RegExp(`\\b${name}\\??\\s*:`).test(typeText),
		);
	const permitted = new Set(allowedPlugins(bundler, recipe));
	const foreign = plugins.filter((entry) => !permitted.has(entry));
	const spinetab = SPINETAB_PLUGIN[bundler];
	if (plugin && spinetab) {
		const count = plugins.filter((entry) => entry === spinetab).length;
		if (count === 0) foreign.push(`missing:${spinetab}`);
		if (count > 1) foreign.push(`duplicate:${spinetab}`);
	} else if (plugin && isNextBundler(bundler)) {
		if (!keys.includes("turbopack.resolveAlias.spinetab/wiring")) {
			foreign.push("missing:withSpinetab");
		}
	}
	return { outside, undeclared, plugins: foreign };
}

const isNextBundler = (bundler: string) =>
	bundler === "next" || bundler === "next-webpack";

/**
 * Declaration text that names each bundler's options: the bundler's own types
 * plus the packages that declare the allow-listed sub-options (Rolldown's
 * `treeshake`, the dev servers' `host`/`port`).
 */
export function readTypeText(consumerRoot: string, bundler: string): string {
	const modules = join(consumerRoot, "node_modules");
	const sources: string[] = [];
	const add = (dir: string) => collectDeclarations(dir, sources);
	switch (bundler) {
		case "vite": {
			const vite = realpathSync(join(modules, "vite"));
			sources.push(join(vite, "dist/node/index.d.ts"));
			add(join(dirname(vite), "rolldown/dist"));
			break;
		}
		case "webpack":
			sources.push(join(modules, "webpack/types.d.ts"));
			add(join(modules, "webpack-dev-server/types"));
			break;
		case "rspack":
			add(join(modules, "@rspack/core/dist/config"));
			add(join(modules, "@rspack/dev-server/dist"));
			break;
		case "next":
		case "next-webpack":
			sources.push(join(modules, "next/dist/server/config-shared.d.ts"));
			break;
		case "astro":
			add(join(modules, "astro/dist/types/public"));
			sources.push(
				join(
					realpathSync(join(modules, "astro")),
					"../vite/dist/node/index.d.ts",
				),
			);
			break;
	}
	return sources
		.filter((file) => existsSync(file))
		.map((file) => readFileSync(file, "utf8"))
		.join("\n");
}

function collectDeclarations(dir: string, into: string[]): void {
	if (!existsSync(dir)) return;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) collectDeclarations(path, into);
		else if (/\.d\.(m|c)?ts$/.test(entry.name)) into.push(path);
	}
}

/**
 * The only accepted worker factory: the literal URL expression
 * with `type: "module"` and either no name (the one-file recipe) or
 * the literal name `"spinetab"`.
 */
export const WORKER_EXPRESSION =
	/new SharedWorker\(\s*new URL\(\s*["']\.\/live\.worker\.(js|ts)["']\s*,\s*import\.meta\.url\s*\)\s*,\s*\{\s*type:\s*["']module["']\s*(?:,\s*name:\s*["']spinetab["']\s*)?,?\s*\}\s*\)/;

const FORBIDDEN_SOURCE: ReadonlyArray<[RegExp, string]> = [
	[/transpilePackages/, "transpilePackages"],
	[/ssr:\s*false/, "dynamic(..., { ssr: false })"],
	[/\bblob:|URL\.createObjectURL|data:text\/javascript/, "blob:/data: worker"],
	[/importScripts\(/, "manual worker loading"],
];

export interface SourceScan {
	workerExpressions: string[];
	missingWorkerExpression: string[];
	violations: Array<{ file: string; rule: string }>;
	/** A `'use client'` module that only re-exports Spinetab. */
	wrappers: string[];
}

/**
 * Plugin recipes: the plugin supplies the wiring, so the
 * application writes no worker factory, never names the seams and never
 * imports the auto entries itself.
 */
const PLUGIN_SOURCE: ReadonlyArray<[RegExp, string]> = [
	[/new SharedWorker\(/, "a worker factory in a plugin recipe"],
	[
		/["']spinetab\/(wiring|worker-config|auto\/[a-z-]+)["']/,
		"a Spinetab seam specifier in application code",
	],
];

/** The L2 worker file: `spinetab.worker.*` or the `worker` option. */
export const WORKER_FILE = /(^|\/)spinetab\.worker\.(ts|mts|js|mjs)$/;

export function scanSources(
	root: string,
	dirs: readonly string[],
	recipe: Recipe = "three-file",
): SourceScan {
	const scan: SourceScan = {
		workerExpressions: [],
		missingWorkerExpression: [],
		violations: [],
		wrappers: [],
	};
	const plugin = isPluginRecipe(recipe);
	const files: string[] = [];
	for (const dir of dirs) collect(join(root, dir), files);
	const factories: string[] = [];
	for (const file of files) {
		const text = readFileSync(file, "utf8");
		const name = relative(root, file);
		if (/new SharedWorker\(/.test(text)) {
			factories.push(name);
			if (WORKER_EXPRESSION.test(text)) scan.workerExpressions.push(name);
			else scan.missingWorkerExpression.push(name);
		}
		for (const [pattern, rule] of [
			...FORBIDDEN_SOURCE,
			...(plugin ? PLUGIN_SOURCE : []),
		]) {
			if (pattern.test(text)) scan.violations.push({ file: name, rule });
		}
		const body = text
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/\/\/.*$/gm, "")
			.trim();
		if (
			/^["']use client["'];?/.test(body) &&
			body
				.replace(/^["']use client["'];?/, "")
				.trim()
				.split(/;\s*|\n+/)
				.filter(Boolean)
				.every((statement) =>
					/^export\s.*from\s+["']spinetab/.test(statement.trim()),
				)
		) {
			scan.wrappers.push(name);
		}
	}
	// L1 needs the verbatim factory; a plugin recipe needs none (and any is
	// already a violation above).
	if (factories.length === 0 && !plugin) {
		scan.missingWorkerExpression.push("(no factory)");
	}
	if (recipe === "plugin-worker") {
		const workers = files
			.map((file) => relative(root, file).replace(/\\/g, "/"))
			.filter((file) => WORKER_FILE.test(file));
		if (workers.length !== 1) {
			scan.violations.push({
				file: workers.join(", ") || "(none)",
				rule: "exactly one spinetab.worker file (L2)",
			});
		}
	}
	if (recipe === "plugin") {
		for (const file of files) {
			const name = relative(root, file).replace(/\\/g, "/");
			if (WORKER_FILE.test(name)) {
				scan.violations.push({
					file: name,
					rule: "a worker file in an L3 cell",
				});
			}
		}
	}
	return scan;
}

function collect(dir: string, into: string[]): void {
	if (!existsSync(dir)) return;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) collect(path, into);
		else if (/\.(m|c)?(j|t)sx?$/.test(entry.name)) into.push(path);
	}
}

const LOG_FAILURES =
	/Module not found|Can't resolve|Could not resolve|failed to resolve|Critical dependency/i;
const LOG_SPINETAB =
	/node_modules\/spinetab|["']spinetab(\/[a-z-]+)*["']|spinetab\/dist\//i;
/** Every plugin build message carries this prefix. */
const LOG_PLUGIN = /\[spinetab\]/;

/** A Spinetab dist path token, so a chunk named `errors-<hash>.js` never reads as a warning. */
const LOG_SPINETAB_PATH = /\S*node_modules\/spinetab\/dist\/\S*/g;

/**
 * Offending build-log lines: resolution failures, Spinetab
 * warnings and any `[spinetab]` plugin message (a clean cell has none).
 */
export function scanBuildLog(output: string): string[] {
	return output
		.split(/\r?\n/)
		.filter(
			(line) =>
				LOG_FAILURES.test(line) ||
				LOG_PLUGIN.test(line) ||
				(LOG_SPINETAB.test(line) &&
					/warn|error|⚠/i.test(line.replace(LOG_SPINETAB_PATH, ""))),
		);
}
