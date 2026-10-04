// Next.js recipe: application CSP headers and documented
// deployment options only. `'unsafe-inline'` is Next's own requirement
// without nonces; `'unsafe-eval'` is React's development requirement and is
// added only by `next dev` (Next CSP guide). Neither is needed by Spinetab.
const isDev = process.env.NODE_ENV === "development";
const assetPrefix = process.env.CONSUMER_ASSET_PREFIX;
const workerAssetPrefix = process.env.CONSUMER_WORKER_ASSET_PREFIX;
const inspect = process.env.CONSUMER_VARIANT === "no-treeshake";
const cdn = assetPrefix ? ` ${assetPrefix}` : "";

const csp = [
	"default-src 'self'",
	`script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}${cdn}`,
	"worker-src 'self'",
	"connect-src 'self' ws://127.0.0.1:4500",
	`style-src 'self' 'unsafe-inline'${cdn}`,
	"object-src 'none'",
	"base-uri 'self'",
].join("; ");

export default {
	reactStrictMode: true,
	productionBrowserSourceMaps: true,
	...(process.env.CONSUMER_BASE_PATH
		? { basePath: process.env.CONSUMER_BASE_PATH }
		: {}),
	...(process.env.CONSUMER_DIST_DIR
		? { distDir: process.env.CONSUMER_DIST_DIR }
		: {}),
	...(assetPrefix ? { assetPrefix } : {}),
	...(workerAssetPrefix !== undefined || inspect
		? {
				experimental: {
					...(workerAssetPrefix !== undefined
						? { turbopackWorkerAssetPrefix: workerAssetPrefix }
						: {}),
					// Inspection-only variant: never the recipe.
					...(inspect
						? {
								turbopackRemoveUnusedExports: false,
								turbopackRemoveUnusedImports: false,
								turbopackInferModuleSideEffects: false,
								turbopackMinify: false,
								turbopackScopeHoisting: false,
							}
						: {}),
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
};
