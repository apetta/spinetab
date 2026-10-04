import { withSpinetab } from "spinetab/next";

// Next.js recipe: `withSpinetab`, application CSP
// headers and documented options only. CONSUMER_PLUGIN_WORKER selects the L2
// variant through the plugin's `worker` option (a file outside the
// conventional names). CONSUMER_PLUGIN_DIR names this directory through the
// `dir` option, for `next dev apps/web` from the workspace root; the
// cell proves `import.meta.dirname` in next.config.mjs.
// `'unsafe-inline'` is Next's own requirement without nonces; `'unsafe-eval'`
// is React's development requirement and is added only by `next dev` (Next
// CSP guide). Neither is needed by Spinetab.
const worker = process.env.CONSUMER_PLUGIN_WORKER;
const dir = process.env.CONSUMER_PLUGIN_DIR ? import.meta.dirname : undefined;
const pluginOptions = {
	...(worker ? { worker } : {}),
	...(dir ? { dir } : {}),
};
const isDev = process.env.NODE_ENV === "development";
const inspect = process.env.CONSUMER_VARIANT === "no-treeshake";

const csp = [
	"default-src 'self'",
	`script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
	"worker-src 'self'",
	"connect-src 'self'",
	"style-src 'self' 'unsafe-inline'",
	"object-src 'none'",
	"base-uri 'self'",
].join("; ");

export default withSpinetab(
	{
		reactStrictMode: true,
		productionBrowserSourceMaps: true,
		...(process.env.CONSUMER_DIST_DIR
			? { distDir: process.env.CONSUMER_DIST_DIR }
			: {}),
		// Inspection-only variant: never the recipe.
		...(inspect
			? {
					experimental: {
						turbopackRemoveUnusedExports: false,
						turbopackRemoveUnusedImports: false,
						turbopackInferModuleSideEffects: false,
						turbopackMinify: false,
						turbopackScopeHoisting: false,
					},
				}
			: {}),
		async headers() {
			return [
				{
					source: "/(.*)",
					headers: [{ key: "Content-Security-Policy", value: csp }],
				},
			];
		},
	},
	Object.keys(pluginOptions).length > 0 ? pluginOptions : undefined,
);
