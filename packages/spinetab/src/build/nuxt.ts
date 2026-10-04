import type { SpinetabPluginOptions } from "./types.ts";
import { createVitePlugin, type SpinetabVitePlugin } from "./vite-plugin.ts";

export type { SpinetabPluginOptions } from "./types.ts";

/** Structural types keep Nuxt and its transitive types out of the package. */
export interface NuxtManifestEntry {
	file: string;
	dynamicImports?: string[];
	preload?: boolean;
	prefetch?: boolean;
}

export type NuxtManifest = Record<string, NuxtManifestEntry>;

interface NuxtLike {
	options: { rootDir: string; app: { buildAssetsDir: string } };
	hook(
		name: "vite:extendConfig",
		listener: (
			config: { plugins?: unknown[] },
			env: { isClient: boolean },
		) => void,
	): unknown;
	hook(
		name: "build:manifest",
		listener: (manifest: NuxtManifest) => void,
	): unknown;
}

/** Nuxt 4 with Vite: `modules: [["spinetab/nuxt", { adapters: ["sse"] }]]`. */
export default function spinetabNuxt(
	options: SpinetabPluginOptions,
	nuxt: NuxtLike,
): void {
	const resources = { worker: new Set<string>(), local: new Set<string>() };
	const plugin: SpinetabVitePlugin = createVitePlugin(options, {
		root: nuxt.options.rootDir,
		resources,
	});
	nuxt.hook("vite:extendConfig", (config, { isClient }) => {
		if (!isClient) return;
		config.plugins ??= [];
		config.plugins.push(plugin);
	});
	nuxt.hook("build:manifest", (manifest) => {
		// Nuxt strips app.buildAssetsDir from emitted filenames before this hook.
		const prefix = `${nuxt.options.app.buildAssetsDir.replace(/^\/+|\/+$/g, "")}/`;
		const manifestName = (file: string) =>
			file.startsWith(prefix) ? file.slice(prefix.length) : file;
		const workerFiles = new Set([...resources.worker].map(manifestName));
		const localFiles = new Set([...resources.local].map(manifestName));
		for (const entry of Object.values(manifest)) {
			if (workerFiles.has(entry.file)) {
				entry.preload = false;
				entry.prefetch = false;
			}
			// Drop only the lazy runtime's prefetch edge. Other imports, assets,
			// workers and shared route dependencies retain Nuxt's normal hints.
			if (entry.dynamicImports)
				entry.dynamicImports = entry.dynamicImports.filter(
					(id) => !localFiles.has(manifest[id]?.file ?? ""),
				);
		}
	});
}
