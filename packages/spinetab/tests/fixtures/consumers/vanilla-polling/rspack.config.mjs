import { resolve } from "node:path";
import { rspack } from "@rspack/core";
import { spinetab } from "spinetab/rspack";

// Rspack recipe: default worker settings, the built-in
// HTML plugin, the Spinetab plugin, no aliases, fallbacks, externals or swc rules.
// CONSUMER_VARIANT=no-treeshake disables used-exports and side-effects
// optimisation for isolation evidence. CONSUMER_ENTRY=cjs builds
// the CommonJS page entry.
const noTreeshake = process.env.CONSUMER_VARIANT === "no-treeshake";
const workerPublicPath = process.env.CONSUMER_WORKER_PUBLIC_PATH;

export default {
	mode:
		process.env.CONSUMER_MODE === "development" ? "development" : "production",
	entry:
		process.env.CONSUMER_ENTRY === "cjs" ? "./src/main.cjs" : "./src/main.js",
	devtool: "source-map",
	output: {
		path: resolve(import.meta.dirname, process.env.CONSUMER_OUT ?? "dist"),
		...(process.env.CONSUMER_OUTPUT_MODULE === "1" ? { module: true } : {}),
		...(workerPublicPath === undefined ? {} : { workerPublicPath }),
	},
	...(noTreeshake
		? {
				optimization: {
					usedExports: false,
					sideEffects: false,
					minimize: false,
					concatenateModules: false,
				},
			}
		: {}),
	plugins: [
		new rspack.HtmlRspackPlugin({ title: "Spinetab consumer" }),
		spinetab(),
	],
	devServer: {
		host: "127.0.0.1",
		port: Number(process.env.CONSUMER_PORT ?? 4731),
	},
};
