import { spinetab } from "spinetab/vite";

// Vite recipe: the Spinetab plugin line and no aliases or
// optimiser options. CONSUMER_VARIANT=no-treeshake is the isolation build; CONSUMER_BASE builds under a base path;
// CONSUMER_PLUGIN=off is the plugin-absent control cell;
// CONSUMER_PLUGIN_ORIGINS (comma-separated) is the credentialOrigins sentinel
// pair of control cells.
const noTreeshake = process.env.CONSUMER_VARIANT === "no-treeshake";
const withPlugin = process.env.CONSUMER_PLUGIN !== "off";
const origins = process.env.CONSUMER_PLUGIN_ORIGINS;

export default {
	plugins: withPlugin
		? [
				spinetab(
					origins === undefined
						? undefined
						: { credentialOrigins: origins.split(",") },
				),
			]
		: [],
	base: process.env.CONSUMER_BASE ?? "/",
	build: {
		sourcemap: true,
		manifest: true,
		...(noTreeshake
			? { minify: false, rolldownOptions: { treeshake: false } }
			: {}),
	},
	...(noTreeshake ? { worker: { rolldownOptions: { treeshake: false } } } : {}),
};
