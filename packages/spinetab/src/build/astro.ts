import { fileURLToPath } from "node:url";
import type { SpinetabPluginOptions } from "./types.ts";
import { createVitePlugin, type SpinetabVitePlugin } from "./vite-plugin.ts";

export interface AstroConfigSetupLike {
	config: { root: URL };
	command: string;
	updateConfig(config: { vite: { plugins: SpinetabVitePlugin[] } }): unknown;
}

export interface SpinetabAstroIntegration {
	name: "spinetab";
	hooks: {
		"astro:config:setup": (options: AstroConfigSetupLike) => void;
	};
}

export function spinetab(
	options?: SpinetabPluginOptions,
): SpinetabAstroIntegration {
	return {
		name: "spinetab",
		hooks: {
			"astro:config:setup": ({ updateConfig, config, command }) => {
				updateConfig({
					vite: {
						plugins: [
							createVitePlugin(options, {
								root: fileURLToPath(config.root),
								// Only `astro build` writes a worker. `sync`
								// (also run by `astro check`) and `preview` set the
								// integration up too, and must not fail an empty set.
								dev: command !== "build",
							}),
						],
					},
				});
			},
		},
	};
}

export type {
	SpinetabAdapterName,
	SpinetabPluginOptions,
} from "./types.ts";
export type { SpinetabVitePlugin } from "./vite-plugin.ts";
