import { join, resolve } from "node:path";
import { GENERATOR_VERSION } from "./generate.ts";
import { buildMessage } from "./messages.ts";
import { validateOptions } from "./options.ts";
import { findPackageDir, inNodeModules } from "./paths.ts";
import {
	adapterEntryOf,
	type BuildPlan,
	checkGraph,
	isDefaultWiringPath,
	recordImport,
	resolveAdapterSet,
	resolvePlan,
} from "./plan.ts";
import type { SpinetabLoaderOptions, SpinetabPluginOptions } from "./types.ts";

type Tap<Args extends unknown[]> = {
	tap(name: string, fn: (...args: Args) => unknown): void;
};

/** What the plugin reads from a normal module factory's resolve data. */
export interface ResolveDataLike {
	request?: string;
	contextInfo?: { issuer?: string };
}

/** Structural subset of webpack's and Rspack's `Compilation`. */
export interface CompilationLike {
	errors: unknown[];
	warnings: unknown[];
	hooks: { finishModules: Tap<[Iterable<unknown>]> };
}

/** Structural subset of webpack's and Rspack's `Compiler`. */
export interface CompilerLike {
	context: string;
	options: {
		mode?: string;
		resolve?: unknown;
		module?: unknown;
		output?: { path?: string };
	};
	platform?: { web?: boolean | null };
	webpack?: unknown;
	rspack?: unknown;
	hooks: {
		afterEnvironment: Tap<[]>;
		thisCompilation: Tap<
			[
				CompilationLike,
				{
					normalModuleFactory: {
						hooks: { beforeResolve: Tap<[ResolveDataLike]> };
					};
				},
			]
		>;
	};
}

export const LOADER = "spinetab/loader";
export const WORKER_CONFIG_TEST =
	/[\\/]spinetab[\\/]dist[\\/]worker-config\.js$/;
export const AUTO_WIRING_TEST =
	/[\\/]spinetab[\\/]dist[\\/]auto[\\/]wiring\.js$/;

/**
 * The loader options for a plan (JSON; part of every bundler's cache key).
 * `excludes` are the absolute output directories inference skips.
 */
export function loaderOptions(
	plan: BuildPlan,
	role: "worker" | "wiring",
	dev: boolean,
	excludes: readonly string[] = [],
): SpinetabLoaderOptions {
	if (plan.level === "L2") {
		return {
			role,
			adapters: [],
			credentialOrigins: [],
			roots: [plan.root],
			dev,
			version: GENERATOR_VERSION,
			worker: plan.workerFile,
		};
	}
	return {
		role,
		adapters: plan.adapters === null ? null : [...plan.adapters],
		credentialOrigins: [...plan.credentialOrigins],
		roots: [...plan.roots],
		excludes: [...excludes],
		dev,
		version: GENERATOR_VERSION,
		worker: null,
	};
}

export function addExactAlias(
	resolveOptions: { alias?: unknown },
	request: string,
	target: string,
): void {
	const alias = resolveOptions.alias;
	if (Array.isArray(alias)) {
		alias.push({ name: request, alias: target, onlyModule: true });
		return;
	}
	resolveOptions.alias = {
		...(alias && typeof alias === "object" ? alias : {}),
		[`${request}$`]: target,
	};
}

export function contributedRules(
	plan: BuildPlan,
	dev: boolean,
	excludes: readonly string[] = [],
): object[] {
	const rules: object[] = [];
	const use = (role: "worker" | "wiring") => [
		{ loader: LOADER, options: loaderOptions(plan, role, dev, excludes) },
	];
	if (plan.level === "L3") {
		rules.push({ test: WORKER_CONFIG_TEST, use: use("worker") });
	}
	if (dev) {
		rules.push({ test: AUTO_WIRING_TEST, use: use("wiring") });
	}
	return rules;
}

/**
 * Aliases and rules for a client compiler's options (webpack, Rspack, Next).
 * `spinetab/wiring` goes to the absolute real path of the installed
 * `dist/auto/wiring.js`: the package exports `./auto/wiring` under `import`
 * only, so a bare target fails for CommonJS page code, whose root does
 * `require("spinetab/wiring")`. `excludes` adds output directories
 * to the compiler's own `output.path`.
 */
export function applyClientConfig(
	options: { resolve?: unknown; module?: unknown; output?: unknown },
	plan: BuildPlan,
	dev: boolean,
	extra: { excludes?: readonly string[] } = {},
): void {
	const resolveOptions = asObject(options, "resolve");
	addExactAlias(
		resolveOptions,
		"spinetab/wiring",
		join(findPackageDir(plan.root), "dist", "auto", "wiring.js"),
	);
	if (plan.level === "L2") {
		addExactAlias(resolveOptions, "spinetab/worker-config", plan.workerFile);
	}
	const output = (options.output as { path?: unknown } | undefined)?.path;
	const excludes = [
		...new Set([
			...(extra.excludes ?? []),
			...(typeof output === "string" ? [resolve(output)] : []),
		]),
	];
	const moduleOptions = asObject(options, "module") as { rules?: unknown };
	const rules = Array.isArray(moduleOptions.rules) ? moduleOptions.rules : [];
	rules.push(...contributedRules(plan, dev, excludes));
	moduleOptions.rules = rules;
}

/**
 * The graph check and the `wiring-not-applied` self-check, in
 * `finishModules`. `planFor` returns `undefined` when the plugin is inert.
 */
export function applyGraphCheck(
	compiler: CompilerLike,
	name: string,
	state: () => { plan: BuildPlan; dev: boolean } | undefined,
): void {
	compiler.hooks.thisCompilation.tap(name, (compilation, params) => {
		const current = state();
		if (!current) return;
		const imported = new Map<string, Set<string>>();
		params.normalModuleFactory.hooks.beforeResolve.tap(name, (data) => {
			const entry = adapterEntryOf(data?.request ?? "");
			const issuer = data?.contextInfo?.issuer;
			if (entry && issuer && !inNodeModules(issuer)) {
				recordImport(imported, entry, issuer);
			}
		});
		compilation.hooks.finishModules.tap(name, (modules) => {
			for (const module of modules) {
				const resource = (module as { resource?: unknown }).resource;
				if (typeof resource === "string" && isDefaultWiringPath(resource)) {
					compilation.errors.push(
						buildError(compiler, buildMessage({ code: "wiring-not-applied" })),
					);
					return;
				}
			}
			if (current.plan.level !== "L3") return;
			let set: ReturnType<typeof resolveAdapterSet>;
			try {
				// The loader owns the empty-set and peer warnings; this pass only
				// needs the set, so it never fails on an empty one.
				set = resolveAdapterSet(current.plan, {
					dev: true,
					excludes: outputExcludes(compiler),
				});
			} catch (error) {
				compilation.errors.push(buildError(compiler, messageOf(error)));
				return;
			}
			const failure = checkGraph(set, imported);
			if (failure)
				compilation.errors.push(buildError(compiler, failure.message));
		});
	});
}

class SpinetabPlugin {
	readonly #options: SpinetabPluginOptions | undefined;

	constructor(options?: SpinetabPluginOptions) {
		this.#options = options;
	}

	apply(compiler: CompilerLike): void {
		const name = "SpinetabPlugin";
		let failure: string | undefined;
		let active: { plan: BuildPlan; dev: boolean } | undefined;
		compiler.hooks.afterEnvironment.tap(name, () => {
			// Client builds only: a server or Node target keeps the
			// inert default wiring.
			if (compiler.platform?.web === false) return;
			try {
				const plan = resolvePlan(
					compiler.context,
					validateOptions(this.#options),
				);
				const dev = compiler.options.mode === "development";
				applyClientConfig(compiler.options, plan, dev);
				active = { plan, dev };
			} catch (error) {
				failure = messageOf(error);
			}
		});
		compiler.hooks.thisCompilation.tap(name, (compilation) => {
			if (failure !== undefined) {
				compilation.errors.push(buildError(compiler, failure));
				return;
			}
			if (!active) return;
			const parser = (compiler.options.module as ParserOptions | undefined)
				?.parser;
			if (workerParsingDisabled(parser)) {
				compilation.errors.push(
					buildError(
						compiler,
						buildMessage({ code: "worker-parser-disabled" }),
					),
				);
			}
		});
		applyGraphCheck(compiler, name, () => active);
	}
}

interface ParserOptions {
	parser?: Record<string, { worker?: unknown } | undefined>;
}

/** SharedWorker parsing must remain enabled for auto/wiring.js under javascript/esm. */
export function workerParsingDisabled(
	parser: ParserOptions["parser"],
): boolean {
	let worker: unknown;
	for (const type of ["javascript", "javascript/esm"]) {
		const value = parser?.[type]?.worker;
		if (value === undefined) continue;
		if (Array.isArray(value) && value.includes("...") && worker !== undefined) {
			const earlier = worker;
			worker = value.flatMap((item: unknown) =>
				item !== "..." ? [item] : Array.isArray(earlier) ? earlier : [earlier],
			);
		} else {
			worker = value;
		}
	}
	if (worker === false) return true;
	return (
		Array.isArray(worker) &&
		!worker.some((item) => item === "..." || item === "SharedWorker")
	);
}

export function createSpinetabPlugin(
	options?: SpinetabPluginOptions,
): SpinetabWebpackPlugin {
	return new SpinetabPlugin(options);
}

export interface SpinetabWebpackPlugin {
	apply(compiler: CompilerLike): void;
}

function outputExcludes(compiler: CompilerLike): string[] {
	const path = compiler.options.output?.path;
	return typeof path === "string" ? [path] : [];
}

function asObject(owner: object, key: string): Record<string, unknown> {
	const record = owner as Record<string, unknown>;
	const value = record[key];
	if (value && typeof value === "object") {
		return value as Record<string, unknown>;
	}
	const created: Record<string, unknown> = {};
	record[key] = created;
	return created;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

type ErrorConstructorLike = new (message: string) => Error;

/** A bundler error without a stack (the message is the whole story). */
export function buildError(compiler: CompilerLike, message: string): Error {
	const bundler = (compiler.webpack ?? compiler.rspack) as
		| { WebpackError?: ErrorConstructorLike }
		| undefined;
	const Constructor = bundler?.WebpackError ?? Error;
	const error = new Constructor(message);
	// `hideStack` keeps the stack out of the printed error, and replacing
	// it keeps V8 frames (absolute paths) out of `errorDetails` too.
	Object.assign(error, {
		hideStack: true,
		stack: `${error.name}: ${message}`,
	});
	return error;
}
