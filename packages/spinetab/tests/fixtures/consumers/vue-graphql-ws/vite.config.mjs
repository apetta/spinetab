import { spinetab } from "spinetab/vite";

// Vite recipe: the Spinetab plugin line; the worker is
// src/spinetab.worker.js. CONSUMER_VARIANT=no-treeshake is the isolation
// build; CONSUMER_BASE builds under a base path;
// CONSUMER_PLUGIN_ADAPTERS is the worker-file-with-options control cell.
const noTreeshake = process.env.CONSUMER_VARIANT === "no-treeshake";
const adapters = process.env.CONSUMER_PLUGIN_ADAPTERS;

export default {
	plugins: [
		spinetab(
			adapters === undefined ? undefined : { adapters: adapters.split(",") },
		),
	],
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
