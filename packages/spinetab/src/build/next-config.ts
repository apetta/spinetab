// Return a function-form config so Next's phase determines development mode.

import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, resolve } from "node:path";
import { SpinetabBuildError } from "./messages.ts";
import { type ValidOptions, validateOptions } from "./options.ts";
import { dotRelative, findPackageDir } from "./paths.ts";
import { type BuildPlan, resolvePlan } from "./plan.ts";
import type { SpinetabNextOptions } from "./types.ts";
import {
	applyClientConfig,
	applyGraphCheck,
	type CompilerLike,
	LOADER,
	loaderOptions,
} from "./webpack-plugin.ts";

export interface NextWebpackContextLike {
	isServer: boolean;
	dev?: boolean;
	dir?: string;
}

export interface NextConfigLike {
	turbopack?: {
		resolveAlias?: Record<string, unknown>;
		rules?: Record<string, unknown>;
		[key: string]: unknown;
	};
	// biome-ignore lint/suspicious/noExplicitAny: Next's own hook signature.
	webpack?: ((config: any, context: any) => any) | null;
	[key: string]: unknown;
}

/**
 * The context Next passes to a function-form config. `defaultConfig` is Next's
 * full default configuration, so the returned function accepts any object
 * there: typing it as the input's `Config` would make the result unassignable
 * to Next's own function config type (a literal such as `{ reactStrictMode:
 * true }` is narrower than `NextConfig`).
 */
export interface NextPhaseContextLike {
	defaultConfig: object;
}

export type NextConfigInput<Config extends object> =
	| Config
	| ((
			phase: string,
			context: { defaultConfig: Config },
	  ) => Config | Promise<Config>);

const DEVELOPMENT_PHASE = "phase-development-server";
const WORKER_CONFIG_PATH = /(^|\/)spinetab\/dist\/worker-config\.js$/;
const AUTO_WIRING_PATH = /(^|\/)spinetab\/dist\/auto\/wiring\.js$/;

export function withSpinetab<Config extends object>(
	config: NextConfigInput<Config> = {} as Config,
	options?: SpinetabNextOptions,
): (phase: string, context: NextPhaseContextLike) => Promise<Config> {
	return async (phase, context) => {
		const base =
			typeof config === "function"
				? await config(phase, context as { defaultConfig: Config })
				: config;
		const dev = phase === DEVELOPMENT_PHASE;
		const valid = validateOptions(options, "next");
		const root = projectDirectory(valid.dir);
		// Next evaluates the config again in its build workers, which inherit
		// process.env but neither the CLI arguments nor the directory.
		process.env[PROJECT_DIRECTORY_ENV] = root;
		const plan = resolvePlan(root, valid);
		return extendConfig(
			base as Config & NextConfigLike,
			plan,
			dev,
			valid,
		) as Config;
	};
}

/**
 * The contributed Turbopack and webpack configuration for a plan. Turbopack
 * takes the plan made at config time; the `webpack` hook plans again from
 * the directory Next passes it (`ctx.dir`) when that differs.
 */
export function extendConfig(
	base: NextConfigLike,
	plan: BuildPlan,
	dev: boolean,
	options: ValidOptions = validateOptions(undefined, "next"),
): NextConfigLike {
	const turbopack = base.turbopack ?? {};
	// Next's output directory is never scanned, whatever its name.
	const distDir = (root: string) => [
		resolve(root, typeof base.distDir === "string" ? base.distDir : ".next"),
	];
	const resolveAlias: Record<string, unknown> = {
		...turbopack.resolveAlias,
		// A require("spinetab/wiring") keeps require conditions when aliased.
		// auto/wiring is ESM-only, so target its file rather than its export.
		// The browser condition leaves server imports on the inert default.
		"spinetab/wiring": {
			browser: dotRelative(
				plan.root,
				join(findPackageDir(plan.root), "dist", "auto", "wiring.js"),
			),
		},
	};
	const rules: Record<string, unknown> = { ...turbopack.rules };
	if (plan.level === "L2") {
		// Turbopack alias targets are bare or `./` project-relative.
		resolveAlias["spinetab/worker-config"] = dotRelative(
			plan.root,
			plan.workerFile,
		);
	} else {
		// `**/`: the package sits several directories deep under pnpm
		// (`node_modules/.pnpm/…/node_modules/spinetab`); a single `*/`
		// segment matches only a hoisted layout, and the stub then ships.
		// No `as`: the matched file is already `.js`, so the loader output
		// keeps its ecmascript type; `as: "*.js"` would only rename the module
		// to `worker-config.js.js`.
		rules["**/spinetab/dist/worker-config.js"] = {
			condition: { path: WORKER_CONFIG_PATH },
			loaders: [
				{
					loader: LOADER,
					options: loaderOptions(plan, "worker", dev, distDir(plan.root)),
				},
			],
		};
	}
	if (dev) {
		rules["**/spinetab/dist/auto/wiring.js"] = {
			condition: { path: AUTO_WIRING_PATH },
			loaders: [
				{
					loader: LOADER,
					options: loaderOptions(plan, "wiring", dev, distDir(plan.root)),
				},
			],
		};
	}
	const userWebpack = base.webpack;
	return {
		...base,
		turbopack: { ...turbopack, resolveAlias, rules },
		// biome-ignore lint/suspicious/noExplicitAny: Next's own hook signature.
		webpack(webpackConfig: any, context: NextWebpackContextLike) {
			if (!context.isServer) {
				const dir =
					typeof context.dir === "string" ? resolve(context.dir) : plan.root;
				const clientPlan = dir === plan.root ? plan : resolvePlan(dir, options);
				applyClientConfig(webpackConfig, clientPlan, dev, {
					excludes: distDir(clientPlan.root),
				});
				const plugins = Array.isArray(webpackConfig.plugins)
					? webpackConfig.plugins
					: [];
				plugins.push(graphCheckPlugin(clientPlan, dev));
				webpackConfig.plugins = plugins;
			}
			return typeof userWebpack === "function"
				? userWebpack(webpackConfig, context)
				: webpackConfig;
		},
	};
}

function graphCheckPlugin(
	plan: BuildPlan,
	dev: boolean,
): { apply(compiler: CompilerLike): void } {
	return {
		apply(compiler) {
			applyGraphCheck(compiler, "SpinetabPlugin", () => ({ plan, dev }));
		},
	};
}

/**
 * The config files Next 16.3.6 loads (`.mts` with native TypeScript); it
 * refuses next.config.cjs, so that marks no project.
 */
const NEXT_CONFIG_FILES = [
	"next.config.js",
	"next.config.mjs",
	"next.config.ts",
	"next.config.mts",
] as const;

/**
 * The project directory an earlier evaluation in this process tree resolved.
 * Next's build workers (lib/worker.js) start with a copy of process.env.
 */
export const PROJECT_DIRECTORY_ENV = "__SPINETAB_NEXT_PROJECT_DIR";

/**
 * The Next project directory, in order: the `dir` option; the
 * invocation directory when it holds a next.config file (when the `next
 * <command> <dir>` directory holds another, the pair is ambiguous);
 * the `next <command> <dir>` directory when that holds one; the directory an
 * earlier evaluation handed on through `PROJECT_DIRECTORY_ENV` when that
 * holds one (`next build <dir>` evaluates the config again in its build
 * worker, with neither the command nor the directory in argv). Otherwise
 * `project-directory-unknown`: `next dev <dir>` evaluates the config only in
 * a child process whose argv holds neither and whose cwd is the parent's, so
 * a guess would plan against the wrong tree.
 */
export function projectDirectory(
	dir: string | undefined,
	cwd: string = process.cwd(),
	argv: readonly string[] = process.argv,
	env: NodeJS.ProcessEnv = process.env,
): string {
	if (dir !== undefined) {
		if (!isDirectory(dir)) {
			throw new SpinetabBuildError({ code: "invalid-dir-option" });
		}
		return resolve(dir);
	}
	const positional = cliDirectory(argv, cwd);
	const named =
		positional !== undefined && holdsNextConfig(positional)
			? positional
			: undefined;
	if (holdsNextConfig(cwd)) {
		// Two projects named at once: ambiguous, never a guess.
		if (named !== undefined && named !== resolve(cwd)) {
			throw new SpinetabBuildError({ code: "project-directory-unknown" });
		}
		return resolve(cwd);
	}
	if (named !== undefined) return named;
	const handed = env[PROJECT_DIRECTORY_ENV];
	if (handed !== undefined && isAbsolute(handed) && holdsNextConfig(handed)) {
		return handed;
	}
	throw new SpinetabBuildError({ code: "project-directory-unknown" });
}

function holdsNextConfig(dir: string): boolean {
	return NEXT_CONFIG_FILES.some((name) => isFile(join(dir, name)));
}

/** Commands that load next.config for a `[directory]` argument. */
const NEXT_COMMANDS = new Set([
	"build",
	"dev",
	"start",
	"export",
	"typegen",
	"experimental-analyze",
]);
/**
 * Next 16.3.6 options that take a value (`next/dist/bin/next`): a
 * required `<value>` is always the next argument; an optional `[value]` is
 * the next argument unless that starts with `-` (commander). Every other
 * option, `--debug-prerender` included, is boolean.
 */
const REQUIRED_VALUE = new Set([
	"-p",
	"--port",
	"-H",
	"--hostname",
	"--experimental-https-key",
	"--experimental-https-cert",
	"--experimental-https-ca",
	"--experimental-upload-trace",
	"--debug-build-paths",
	"--keepAliveTimeout",
]);
const OPTIONAL_VALUE = new Set([
	"--experimental-build-mode",
	"--internal-trace",
	"--inspect",
]);

/** `next <command> [dir]`: the positional directory, when one exists. */
export function cliDirectory(
	argv: readonly string[],
	cwd: string,
): string | undefined {
	const commandIndex = argv.findIndex((arg) => NEXT_COMMANDS.has(arg));
	if (commandIndex === -1) return undefined;
	let operands = false;
	for (let index = commandIndex + 1; index < argv.length; index += 1) {
		const arg = argv[index] ?? "";
		if (!operands) {
			if (arg === "--") {
				operands = true;
				continue;
			}
			if (REQUIRED_VALUE.has(arg)) {
				index += 1;
				continue;
			}
			if (OPTIONAL_VALUE.has(arg)) {
				if (!(argv[index + 1] ?? "-").startsWith("-")) index += 1;
				continue;
			}
			if (arg.startsWith("-")) continue;
		}
		const dir = resolve(cwd, normalize(arg));
		if (isDirectory(dir)) return dir;
		return undefined;
	}
	return undefined;
}

function isDirectory(path: string): boolean {
	try {
		return existsSync(path) && statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}
