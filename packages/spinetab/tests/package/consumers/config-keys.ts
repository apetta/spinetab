import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Print the flattened option paths of a bundler config module as JSON:
 *
 * node config-keys.ts <config.mjs>
 *
 * Run in a child process with the variant's environment so each variant's
 * module evaluation is fresh. Plain objects are walked; arrays, functions and
 * class instances are leaves. Entries of `plugins` and `integrations` are
 * reported by constructor (class instances, e.g. `SpinetabPlugin`) or, for
 * plain objects, as `name:<name>` (Vite plugins, Astro integrations); nested
 * plugin arrays are flattened and falsy entries skipped, as Vite does.
 *
 * Function-form configs are evaluated with their bundler's convention: Next
 * calls `(phase, { defaultConfig })`, with the phase from `CONSUMER_NEXT_PHASE`
 * (default `phase-production-build`); Vite and webpack-family configs get
 * `{ mode, command }`.
 */
export interface ConfigKeys {
	keys: string[];
	plugins: string[];
}

const PLUGIN_LISTS = new Set(["plugins", "integrations"]);

/** How one plugin or integration entry is named in the scan. */
export function pluginName(plugin: unknown): string {
	if (isPlainObject(plugin)) {
		return typeof plugin.name === "string" ? `name:${plugin.name}` : "Object";
	}
	return (
		(plugin as { constructor?: { name?: string } } | null)?.constructor?.name ??
		typeof plugin
	);
}

export function flattenConfig(config: unknown, prefix = ""): ConfigKeys {
	const keys: string[] = [];
	const plugins: string[] = [];
	const addPlugins = (list: readonly unknown[]) => {
		for (const plugin of list) {
			if (Array.isArray(plugin)) addPlugins(plugin);
			else if (plugin) plugins.push(pluginName(plugin));
		}
	};
	const walk = (value: unknown, path: string) => {
		if (!isPlainObject(value)) return;
		for (const [key, child] of Object.entries(value)) {
			const childPath = path ? `${path}.${key}` : key;
			keys.push(childPath);
			if (PLUGIN_LISTS.has(key) && Array.isArray(child)) {
				addPlugins(child);
			} else {
				walk(child, childPath);
			}
		}
	};
	walk(config, prefix);
	return { keys: keys.sort(), plugins };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

/** Next's phase constants (`next/constants`), as its CLI passes them. */
export const NEXT_PHASES = [
	"phase-production-build",
	"phase-development-server",
	"phase-production-server",
] as const;

/**
 * Evaluate a config module's default export as its bundler would: Next's
 * `(phase, { defaultConfig })`, else `{ mode, command }`. Async results are
 * awaited (Next accepts an async function).
 */
export async function evaluateConfig(
	entry: string,
	exported: unknown,
	env: NodeJS.ProcessEnv = process.env,
): Promise<unknown> {
	if (typeof exported !== "function") return exported;
	if (/^next\.config\.(m|c)?(j|t)s$/.test(basename(entry))) {
		const phase = env.CONSUMER_NEXT_PHASE ?? "phase-production-build";
		return await (exported as (phase: string, context: unknown) => unknown)(
			phase,
			{ defaultConfig: {} },
		);
	}
	return await (exported as (env: unknown) => unknown)({
		mode: env.CONSUMER_MODE ?? "production",
		command: "build",
	});
}

const entry = process.argv[2];
if (entry && process.argv[1]?.endsWith("config-keys.ts")) {
	const module = (await import(pathToFileURL(resolve(entry)).href)) as {
		default?: unknown;
	};
	const config = await evaluateConfig(entry, module.default);
	process.stdout.write(JSON.stringify(flattenConfig(config)));
}
