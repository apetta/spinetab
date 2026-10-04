import type { SpinetabPluginOptions } from "./types.ts";
import {
	createSpinetabPlugin,
	type SpinetabWebpackPlugin,
} from "./webpack-plugin.ts";

// A function of its own, not a re-export: an entry with no code of its own
// is emitted without a source map.
export function spinetab(
	options?: SpinetabPluginOptions,
): SpinetabWebpackPlugin {
	return createSpinetabPlugin(options);
}

export type {
	SpinetabAdapterName,
	SpinetabPluginOptions,
} from "./types.ts";
export type {
	CompilerLike,
	SpinetabWebpackPlugin,
} from "./webpack-plugin.ts";
