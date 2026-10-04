// Vite recipe: no plugins, aliases or optimiser options.
// CONSUMER_VARIANT=no-treeshake is the isolation build;
// CONSUMER_BASE builds under a base path.
const noTreeshake = process.env.CONSUMER_VARIANT === "no-treeshake";

export default {
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
