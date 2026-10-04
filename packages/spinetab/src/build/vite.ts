import type { SpinetabPluginOptions } from "./types.ts";
import { createVitePlugin, type SpinetabVitePlugin } from "./vite-plugin.ts";

export function spinetab(options?: SpinetabPluginOptions): SpinetabVitePlugin {
	return createVitePlugin(options);
}

export type {
	SpinetabAdapterName,
	SpinetabPluginOptions,
} from "./types.ts";
export type {
	SpinetabVitePlugin,
	SpinetabViteWorkerPlugin,
	ViteDevServerLike,
	ViteResolvedConfigLike,
} from "./vite-plugin.ts";
