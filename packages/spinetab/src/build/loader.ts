// Absolute scan roots stay in loader options; generated output must not contain them.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	applyDevName,
	devNameForGenerated,
	devNameForWorkerFile,
	generateWorker,
} from "./generate.ts";
import { SpinetabBuildError } from "./messages.ts";
import { relativePosix } from "./paths.ts";
import { findConventionalWorkerFiles, inferredWarnings } from "./plan.ts";
import { inferAdapters } from "./scan.ts";
import type { SpinetabLoaderOptions } from "./types.ts";

export interface SpinetabLoaderContext {
	getOptions(): unknown;
	addContextDependency(path: string): void;
	addDependency(path: string): void;
	cacheable(flag?: boolean): void;
	emitWarning(warning: Error): void;
	rootContext?: string;
}

// Development warns once per process for the same message.
const warned = new Set<string>();

export default function spinetabLoader(
	this: SpinetabLoaderContext,
	source: string,
): string {
	const options = readOptions(this.getOptions());
	// The output depends on files outside the module graph (the scan roots),
	// so a cached result could hold a stale adapter set.
	this.cacheable(false);
	if (options.role === "wiring") {
		if (!options.dev) return source;
		return applyDevName(source, devName(this, options));
	}
	checkUnwiredWorkerFile(this, options);
	const { kinds, warnings } = adapterSet(this, options);
	for (const message of warnings) {
		if (!options.dev || !warned.has(message)) {
			warned.add(message);
			this.emitWarning(new SpinetabWarning(message));
		}
	}
	return generateWorker(kinds, options.credentialOrigins);
}

// The CommonJS build is `module.exports = spinetabLoader`, which loader
// runners read, and `loader.d.cts` declares a default export. The function
// carries itself as `default` so both shapes hold; not enumerable, so the
// module's own keys stay empty.
Object.defineProperty(spinetabLoader, "default", { value: spinetabLoader });

function adapterSet(
	context: SpinetabLoaderContext,
	options: SpinetabLoaderOptions,
): { kinds: readonly string[]; warnings: string[] } {
	if (options.adapters !== null)
		return { kinds: options.adapters, warnings: [] };
	for (const root of options.roots) context.addContextDependency(root);
	// The bundler's output directory, as the graph check skips it.
	const inferred = inferAdapters(options.roots, { excludes: options.excludes });
	return {
		kinds: inferred.kinds,
		warnings: inferredWarnings(inferred, options.dev),
	};
}

function devName(
	context: SpinetabLoaderContext,
	options: SpinetabLoaderOptions,
): string {
	const root = options.roots[0] ?? context.rootContext ?? ".";
	if (typeof options.worker === "string") {
		context.addDependency(options.worker);
		let content = "";
		try {
			content = readFileSync(options.worker, "utf8");
		} catch {
			// A deleted worker file keeps a stable name until the restart.
		}
		return devNameForWorkerFile(relativePosix(root, options.worker), content);
	}
	const { kinds } = adapterSet(context, { ...options, dev: true });
	return devNameForGenerated(generateWorker(kinds, options.credentialOrigins));
}

/**
 * Next decides the level from the invocation directory; the loader runs
 * with the real project directory. A conventional worker file there that the
 * plan did not wire is a build error, never a silently generated worker.
 */
function checkUnwiredWorkerFile(
	context: SpinetabLoaderContext,
	options: SpinetabLoaderOptions,
): void {
	const rootContext = context.rootContext;
	if (rootContext === undefined) return;
	const files = findConventionalWorkerFiles(rootContext);
	if (files.length === 0) return;
	const planRoot = options.roots[0];
	const rel = files.map((file) => relativePosix(rootContext, file));
	if (planRoot !== undefined && resolve(planRoot) === resolve(rootContext)) {
		// Same root: the file appeared after the level was decided.
		throw new SpinetabBuildError({ code: "restart-required", files: rel });
	}
	throw new SpinetabBuildError({ code: "worker-file-not-wired", files: rel });
}

function readOptions(value: unknown): SpinetabLoaderOptions {
	const options = (value ?? {}) as Partial<SpinetabLoaderOptions>;
	if (options.role !== "worker" && options.role !== "wiring") {
		throw new TypeError(
			"spinetab/loader: options.role must be worker or wiring.",
		);
	}
	return {
		role: options.role,
		adapters: Array.isArray(options.adapters) ? options.adapters : null,
		credentialOrigins: Array.isArray(options.credentialOrigins)
			? options.credentialOrigins
			: [],
		roots: Array.isArray(options.roots) ? options.roots : [],
		excludes: Array.isArray(options.excludes)
			? options.excludes.filter((dir) => typeof dir === "string")
			: [],
		dev: options.dev === true,
		version: typeof options.version === "string" ? options.version : "",
		worker: typeof options.worker === "string" ? options.worker : null,
	};
}

/** A warning whose stack is not printed (webpack honours `hideStack`). */
class SpinetabWarning extends Error {
	readonly hideStack = true;

	constructor(message: string) {
		super(message);
		this.name = "SpinetabWarning";
		// The stack is still kept as details; V8 frames hold absolute paths.
		this.stack = `${this.name}: ${message}`;
	}
}
