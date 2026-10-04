/**
 * Packed-consumer catalogue. Pure data: each
 * consumer's selected Spinetab entries and peers, what must stay absent, and
 * the ports each cell uses. Templates live in tests/fixtures/consumers/<name>.
 */

export type Bundler =
	| "vite"
	| "webpack"
	| "rspack"
	| "next"
	| "next-webpack"
	| "astro";
/** Bundlers whose cells run the Next CLI (`next-webpack` adds `--webpack`). */
export const NEXT_BUNDLERS = ["next", "next-webpack"] as const;
export const isNextBundler = (
	bundler: string,
): bundler is (typeof NEXT_BUNDLERS)[number] =>
	bundler === "next" || bundler === "next-webpack";
export type Mode = "dev" | "prod";
export type ConsumerKind = "bundlers" | "next" | "node";
/** How a cell proves one shared upstream for two pages. */
export type Proof = "sse" | "ws" | "graphql-ws" | "polling" | "ai" | "none";

export interface ConsumerSpec {
	name: string;
	kind: ConsumerKind;
	bundlers: readonly Bundler[];
	/** Spinetab subpaths the application imports. */
	entries: readonly string[];
	/** Spinetab peers the application installs directly. */
	peers: readonly string[];
	/**
	 * Spinetab peers present only because an upstream dependency installs them. pnpm binds such a package to Spinetab's optional
	 * peer, so it resolves from Spinetab; installs.test.ts records the lockfile
	 * dependant that brought it. Spinetab's integration for it is not selected,
	 * so the isolation inspection still forbids that area in every realm.
	 */
	upstreamInstalled: readonly string[];
	proof: Proof;
	/** `types/` declaration checks. */
	declarations: boolean;
	/** Builds whose output the isolation rule applies to. */
	isolation: boolean;
	/** Representative application. */
	representative?: boolean;
	/**
	 * Worker recipe. `plugin`: one plugin
	 * line and `createSpinetab()`; the plugin generates the worker from the
	 * app's imports. `plugin-worker`: the same plus the developer's
	 * `spinetab.worker.*`. `one-file`: `live.worker.*` with
	 * `defineWorker`, imported lazily as the local runtime, no worker name, no
	 * plugin. `three-file` (L1 escape hatch, default): `serveSharedWorker`,
	 * `live.local.*` and `live.adapters.*`, no plugin.
	 */
	recipe?: Recipe;
	/** Build-realm entries the bundler config imports (`./vite`, `./next`, …). */
	buildEntries?: readonly string[];
	/**
	 * The application directory below the consumer root, when the consumer
	 * is a workspace (`next-monorepo`: `apps/web`, lockfile at the root).
	 */
	appDir?: string;
}

export type Recipe = "plugin" | "plugin-worker" | "one-file" | "three-file";

export const recipeOf = (spec: ConsumerSpec): Recipe =>
	spec.recipe ?? "three-file";

/** L3 and L2: the Spinetab plugin supplies the wiring. */
export const isPluginRecipe = (recipe: Recipe | undefined): boolean =>
	recipe === "plugin" || recipe === "plugin-worker";

/** Source directory of a consumer's application code, below its app root. */
export const sourceDir = (spec: ConsumerSpec): string =>
	spec.kind === "next" ? "app" : "src";

/** The module the lazy local runtime is, relative to the app root. */
export function localModule(spec: ConsumerSpec): string {
	const dir = sourceDir(spec);
	const ext = spec.kind === "next" ? "ts" : "js";
	switch (recipeOf(spec)) {
		case "plugin":
			// The shipped keep stub, whose default is the generated worker.
			return "node_modules/spinetab/dist/auto/worker.js";
		case "plugin-worker":
			return `${dir}/spinetab.worker.${ext}`;
		case "one-file":
			return `${dir}/live.worker.${ext}`;
		case "three-file":
			return `${dir}/live.local.${ext}`;
	}
}

/** Manifest peers (package.json `peerDependencies`), verified by manifest.test.ts. */
export const SPINETAB_PEERS = [
	"@apollo/client",
	"@tanstack/query-core",
	"@trpc/client",
	"@trpc/server",
	"ai",
	"graphql",
	"graphql-sse",
	"graphql-ws",
	"react",
	"rxjs",
	"socket.io-client",
	"solid-js",
	"svelte",
	"swr",
	"vue",
] as const;

const BUNDLERS = ["vite", "webpack", "rspack"] as const;
const NEXT_ONLY = ["next", "next-webpack"] as const;
/** The root always imports `spinetab/wiring` (the plugin-absent default). */
const CORE_ENTRIES = [".", "./wiring", "./runtime", "./worker"];
/**
 * What a plugin cell's client graph adds: the redirected wiring,
 * the keep stub and the worker module it guards (generated at L3, the
 * developer's file at L2, where the stub itself stays out of the graph).
 */
const PLUGIN_ENTRIES = ["./auto/wiring", "./auto/worker", "./worker-config"];
const PLUGIN_WORKER_ENTRIES = ["./auto/wiring", "./auto/worker"];
/** Build entries (Node realm): never in a chunk of any realm. */
export const BUILD_ENTRIES = [
	"./vite",
	"./webpack",
	"./rspack",
	"./next",
	"./astro",
	"./nuxt",
	"./loader",
] as const;
const VITE_FAMILY_BUILD = ["./vite", "./webpack", "./rspack", "./loader"];
const NEXT_BUILD = ["./next", "./loader"];
const ALL_ENTRIES = [
	".",
	"./wiring",
	"./runtime",
	"./worker",
	"./websocket",
	"./websocket/runtime",
	"./sse",
	"./sse/runtime",
	"./stream",
	"./stream/runtime",
	"./polling",
	"./polling/runtime",
	"./graphql-ws",
	"./graphql-ws/runtime",
	"./graphql-sse",
	"./graphql-sse/runtime",
	"./socket-io",
	"./socket-io/runtime",
	"./apollo",
	"./tanstack-query",
	"./swr",
	"./trpc",
	"./trpc/runtime",
	"./ai-sdk",
	"./ai-sdk/runtime",
	"./react",
	"./vue",
	"./svelte",
	"./solid",
];

export const CONSUMERS: readonly ConsumerSpec[] = [
	{
		name: "vue-graphql-ws",
		kind: "bundlers",
		bundlers: BUNDLERS,
		entries: [
			...CORE_ENTRIES,
			...PLUGIN_WORKER_ENTRIES,
			"./vue",
			"./graphql-ws",
			"./graphql-ws/runtime",
		],
		peers: ["vue", "graphql-ws", "graphql"],
		upstreamInstalled: [],
		proof: "graphql-ws",
		declarations: true,
		isolation: true,
		recipe: "plugin-worker",
		buildEntries: VITE_FAMILY_BUILD,
	},
	{
		name: "react-sse-tanstack",
		kind: "bundlers",
		bundlers: BUNDLERS,
		entries: [
			...CORE_ENTRIES,
			"./react",
			"./sse",
			"./sse/runtime",
			"./stream",
			"./stream/runtime",
			"./tanstack-query",
		],
		peers: ["react", "@tanstack/query-core"],
		upstreamInstalled: [],
		proof: "sse",
		declarations: true,
		isolation: true,
	},
	{
		name: "vanilla-polling",
		kind: "bundlers",
		bundlers: BUNDLERS,
		entries: [
			...CORE_ENTRIES,
			...PLUGIN_ENTRIES,
			"./polling",
			"./polling/runtime",
		],
		peers: [],
		upstreamInstalled: [],
		proof: "polling",
		declarations: true,
		isolation: true,
		recipe: "plugin",
		buildEntries: VITE_FAMILY_BUILD,
	},
	{
		name: "react-ai-sdk",
		kind: "bundlers",
		bundlers: BUNDLERS,
		entries: [...CORE_ENTRIES, "./react", "./ai-sdk", "./ai-sdk/runtime"],
		peers: ["react", "ai"],
		// @ai-sdk/react 4.0.119 depends on swr ^2.4.1 (plan open risk 2).
		upstreamInstalled: ["swr"],
		proof: "ai",
		declarations: true,
		isolation: true,
		recipe: "one-file",
	},
	{
		name: "next-app",
		kind: "next",
		bundlers: NEXT_ONLY,
		entries: [
			...CORE_ENTRIES,
			...PLUGIN_WORKER_ENTRIES,
			"./react",
			"./websocket",
			"./websocket/runtime",
			"./sse",
			"./sse/runtime",
			"./tanstack-query",
		],
		peers: ["react", "@tanstack/query-core"],
		upstreamInstalled: [],
		proof: "ws",
		declarations: false,
		isolation: true,
		// Its WebSocket topic codecs are functions: a worker file.
		recipe: "plugin-worker",
		buildEntries: NEXT_BUILD,
	},
	{
		name: "next-ai",
		kind: "next",
		bundlers: NEXT_ONLY,
		entries: [...CORE_ENTRIES, "./react", "./ai-sdk", "./ai-sdk/runtime"],
		peers: ["react", "ai"],
		upstreamInstalled: ["swr"],
		proof: "ai",
		declarations: false,
		isolation: true,
		// The Next escape-hatch proof: explicit wiring, no plugin.
		recipe: "one-file",
	},
	{
		name: "next-negative",
		kind: "next",
		bundlers: ["next"],
		entries: [
			...CORE_ENTRIES,
			...PLUGIN_ENTRIES,
			"./react",
			"./websocket",
			"./websocket/runtime",
		],
		peers: ["react"],
		upstreamInstalled: [],
		proof: "none",
		declarations: false,
		isolation: false,
		recipe: "plugin",
		buildEntries: NEXT_BUILD,
	},
	{
		// Workspace: the lockfile at the root, the app in `apps/web`, and
		// the only `spinetab/sse` import inside the linked `packages/feeds`, so
		// inference must reach a declared workspace dependency.
		name: "next-monorepo",
		kind: "next",
		bundlers: NEXT_ONLY,
		entries: [
			...CORE_ENTRIES,
			...PLUGIN_ENTRIES,
			"./react",
			"./sse",
			"./sse/runtime",
		],
		peers: ["react"],
		upstreamInstalled: [],
		proof: "sse",
		declarations: false,
		isolation: true,
		recipe: "plugin",
		buildEntries: NEXT_BUILD,
		appDir: "apps/web",
	},
	{
		// Astro 7 static site with the integration.
		name: "astro-polling",
		kind: "bundlers",
		bundlers: ["astro"],
		entries: [
			...CORE_ENTRIES,
			...PLUGIN_ENTRIES,
			"./polling",
			"./polling/runtime",
		],
		peers: [],
		upstreamInstalled: [],
		proof: "polling",
		declarations: false,
		isolation: true,
		recipe: "plugin",
		buildEntries: ["./astro", "./vite"],
	},
	{
		// Proves CommonJS loading of every page entry, not isolation.
		name: "cjs-node",
		kind: "node",
		bundlers: [],
		entries: ALL_ENTRIES,
		peers: [
			"@apollo/client",
			"@tanstack/query-core",
			"@trpc/client",
			"@trpc/server",
			"ai",
			"graphql",
			"graphql-sse",
			"graphql-ws",
			"react",
			"rxjs",
			"socket.io-client",
			"solid-js",
			"svelte",
			"swr",
			"vue",
		],
		upstreamInstalled: [],
		proof: "none",
		declarations: false,
		isolation: false,
		// `check.cjs` requires and imports every build entry.
		buildEntries: BUILD_ENTRIES,
	},
	{
		// page and module-worker realms: imports every entry after
		// installing spies, so it installs every peer (not isolation evidence).
		name: "side-effects",
		kind: "bundlers",
		bundlers: ["vite"],
		entries: ALL_ENTRIES,
		peers: [
			"@apollo/client",
			"@tanstack/query-core",
			"@trpc/client",
			"@trpc/server",
			"ai",
			"graphql",
			"graphql-sse",
			"graphql-ws",
			"react",
			"rxjs",
			"socket.io-client",
			"solid-js",
			"svelte",
			"swr",
			"vue",
		],
		upstreamInstalled: [],
		proof: "none",
		declarations: false,
		isolation: false,
	},
	{
		name: "app-graphql",
		kind: "bundlers",
		bundlers: ["vite"],
		entries: [
			...CORE_ENTRIES,
			...PLUGIN_ENTRIES,
			"./react",
			"./graphql-ws",
			"./graphql-ws/runtime",
		],
		peers: ["react", "graphql-ws", "graphql"],
		upstreamInstalled: [],
		proof: "graphql-ws",
		declarations: false,
		isolation: true,
		representative: true,
		recipe: "plugin",
		buildEntries: ["./vite"],
	},
	{
		name: "app-http",
		kind: "bundlers",
		bundlers: ["vite"],
		entries: [
			...CORE_ENTRIES,
			...PLUGIN_ENTRIES,
			"./vue",
			"./sse",
			"./sse/runtime",
			"./polling",
			"./polling/runtime",
		],
		peers: ["vue"],
		upstreamInstalled: [],
		proof: "sse",
		declarations: false,
		isolation: true,
		representative: true,
		recipe: "plugin",
		buildEntries: ["./vite"],
	},
];

export function consumer(name: string): ConsumerSpec {
	const found = CONSUMERS.find((entry) => entry.name === name);
	if (!found) throw new Error(`Unknown consumer ${name}`);
	return found;
}

/** Spinetab peers the consumer never selected: absent from every chunk. */
export function unselectedPeers(spec: ConsumerSpec): string[] {
	return SPINETAB_PEERS.filter(
		(peer) =>
			!spec.peers.includes(peer) && !spec.upstreamInstalled.includes(peer),
	);
}

/**
 * Package-name matchers that must not appear in any chunk: unselected peers
 * plus the families they would bring (e.g. `@vue/*` without Vue).
 */
export function forbiddenPackages(spec: ConsumerSpec): Array<string | RegExp> {
	const unselected = new Set(unselectedPeers(spec));
	const forbidden: Array<string | RegExp> = [...unselected];
	if (unselected.has("react")) forbidden.push("react-dom", "scheduler");
	if (unselected.has("vue")) forbidden.push(/^@vue\//);
	if (unselected.has("@apollo/client")) forbidden.push(/^@apollo\//);
	if (unselected.has("@trpc/client") && unselected.has("@trpc/server")) {
		forbidden.push(/^@trpc\//);
	}
	if (unselected.has("@tanstack/query-core")) forbidden.push(/^@tanstack\//);
	if (unselected.has("ai")) forbidden.push(/^@ai-sdk\//);
	if (unselected.has("socket.io-client")) {
		forbidden.push("engine.io-client", "socket.io-parser");
	}
	return forbidden;
}

export function matchesPackage(
	name: string,
	matchers: ReadonlyArray<string | RegExp>,
): boolean {
	return matchers.some((matcher) =>
		typeof matcher === "string" ? matcher === name : matcher.test(name),
	);
}

/** Build variants per bundler. `module` runs only in full runs. */
export type Variant =
	| "prod"
	| "no-treeshake"
	| "dev"
	| "base"
	| "module"
	| "deploy-v2"
	| "cjs"
	| ControlCell["id"];

export interface BuildPlan {
	bundler: "vite" | "webpack" | "rspack" | "astro";
	variant: Variant;
	/** Output directory relative to the consumer. */
	out: string;
	env: Record<string, string>;
}

export function buildPlans(spec: ConsumerSpec, full: boolean): BuildPlan[] {
	const plans: BuildPlan[] = [];
	for (const bundler of spec.bundlers) {
		if (isNextBundler(bundler)) continue;
		if (bundler === "astro") {
			// `astro build` writes `dist/`, served statically; Astro's
			// pipeline has no tree-shaking switch the recipe may use.
			plans.push({
				bundler,
				variant: "prod",
				out: "dist",
				env: { CONSUMER_MODE: "production" },
			});
			continue;
		}
		const out = (variant: Variant) => `out/${bundler}-${variant}`;
		plans.push({
			bundler,
			variant: "prod",
			out: out("prod"),
			env: { CONSUMER_MODE: "production" },
		});
		if (spec.isolation) {
			plans.push({
				bundler,
				variant: "no-treeshake",
				out: out("no-treeshake"),
				env: { CONSUMER_MODE: "production", CONSUMER_VARIANT: "no-treeshake" },
			});
		}
		// webpack/Rspack write development output to disk for inspection; the
		// Vite dev server is inspected live.
		if (bundler !== "vite" && spec.isolation) {
			plans.push({
				bundler,
				variant: "dev",
				out: out("dev"),
				env: { CONSUMER_MODE: "development" },
			});
		}
		if (bundler === "vite" && spec.name === "react-sse-tanstack") {
			plans.push({
				bundler,
				variant: "base",
				out: out("base"),
				env: { CONSUMER_MODE: "production", CONSUMER_BASE: "/app/" },
			});
		}
		if (bundler !== "vite" && spec.name === "vanilla-polling") {
			// (consumer cell b): the page reaches Spinetab through
			// CommonJS (`src/main.cjs`), so the root's require of the wiring
			// seam must resolve to the plugin's wiring.
			plans.push({
				bundler,
				variant: "cjs",
				out: out("cjs"),
				env: { CONSUMER_MODE: "production", CONSUMER_ENTRY: "cjs" },
			});
		}
		if (bundler !== "vite" && full && spec.name === "react-sse-tanstack") {
			plans.push({
				bundler,
				variant: "module",
				out: out("module"),
				env: { CONSUMER_MODE: "production", CONSUMER_OUTPUT_MODULE: "1" },
			});
		}
	}
	return plans;
}

/** Next build variants. */
export interface NextBuildPlan {
	variant:
		| "prod"
		| "inspect"
		| "base"
		| "cdn"
		| "cdn-worker"
		| "worker-option"
		| "from-root";
	distDir: string;
	env: Record<string, string>;
	/** `next build --webpack`. */
	webpack?: boolean;
	fromRoot?: boolean;
}

export const CDN_ORIGIN = "http://127.0.0.1:4644";

/**
 * Next build plans for one bundler. Turbopack keeps the historical list;
 * `next-webpack` builds the production recipe (tree shaking cannot be
 * disabled there either) into its own `distDir`.
 */
export function nextBuildPlans(
	spec: ConsumerSpec,
	bundler: "next" | "next-webpack" = "next",
): NextBuildPlan[] {
	if (!spec.bundlers.includes(bundler)) return [];
	if (bundler === "next-webpack") {
		const plans: NextBuildPlan[] = [
			{
				variant: "prod",
				distDir: ".next-webpack",
				env: { CONSUMER_DIST_DIR: ".next-webpack" },
				webpack: true,
			},
		];
		if (spec.name === "next-monorepo") {
			plans.push({
				variant: "worker-option",
				distDir: ".next-webpack-worker-option",
				env: {
					CONSUMER_DIST_DIR: ".next-webpack-worker-option",
					CONSUMER_PLUGIN_WORKER: MONOREPO_WORKER,
				},
				webpack: true,
			});
		}
		return plans;
	}
	if (spec.name === "next-negative") {
		return [{ variant: "prod", distDir: ".next", env: {} }];
	}
	const plans: NextBuildPlan[] = [
		{ variant: "prod", distDir: ".next", env: {} },
		{
			variant: "inspect",
			distDir: ".next-inspect",
			env: {
				CONSUMER_VARIANT: "no-treeshake",
				CONSUMER_DIST_DIR: ".next-inspect",
			},
		},
	];
	if (spec.name === "next-monorepo") {
		plans.push(
			{
				variant: "worker-option",
				distDir: ".next-worker-option",
				env: {
					CONSUMER_DIST_DIR: ".next-worker-option",
					CONSUMER_PLUGIN_WORKER: MONOREPO_WORKER,
				},
			},
			{
				variant: "from-root",
				distDir: ".next-from-root",
				env: { CONSUMER_DIST_DIR: ".next-from-root" },
				fromRoot: true,
			},
		);
	}
	if (spec.name === "next-app") {
		plans.push(
			{
				variant: "base",
				distDir: ".next-base",
				env: {
					CONSUMER_BASE_PATH: "/app",
					CONSUMER_DIST_DIR: ".next-base",
					NEXT_PUBLIC_BASE_PATH: "/app",
				},
			},
			{
				variant: "cdn",
				distDir: ".next-cdn",
				env: {
					CONSUMER_ASSET_PREFIX: CDN_ORIGIN,
					CONSUMER_DIST_DIR: ".next-cdn",
				},
			},
			{
				variant: "cdn-worker",
				distDir: ".next-cdn-worker",
				env: {
					CONSUMER_ASSET_PREFIX: CDN_ORIGIN,
					CONSUMER_WORKER_ASSET_PREFIX: "",
					CONSUMER_DIST_DIR: ".next-cdn-worker",
				},
			},
		);
	}
	return plans;
}

/**
 * The L2 variant of `next-monorepo`: a worker file outside the
 * conventional names, selected through the plugin's `worker` option.
 */
export const MONOREPO_WORKER = "worker/live.worker.ts";

/**
 * Negative and control cells. Each builds one consumer on
 * Vite with a variant: an environment switch its config reads, and/or files
 * from the template's `variants/<id>/` copied over `src/` for the build
 * only. A `fail` cell's build must exit non-zero with exactly one
 * `[spinetab] <code>:` line; a `pass` cell is proved in the browser
 * (`consumers-plugin.spec.ts`).
 */
export interface ControlCell {
	id:
		| "plugin-absent"
		| "empty-set"
		| "worker-with-options"
		| "explicit-options"
		| "credential-origins"
		| "invalid-credential-origin"
		| "verbatim-type-only";
	consumer: string;
	bundler: "vite";
	env: Record<string, string>;
	/**
	 * `src/<file>` replacements, stored as `variants/<id>/<file>.txt` so the
	 * plugin's scanner (which reads every source file of the root) never sees
	 * them outside their own cell.
	 */
	files: readonly string[];
	/**
	 * Root-relative directories moved out of the consumer for the build only:
	 * the scanner reads the whole root, so `types/` checks that
	 * value-import `spinetab/polling` would otherwise stay in the set.
	 */
	hide: readonly string[];
	out: string;
	expect:
		| {
				build: "fail";
				code: string;
				/** The exact message the build prints, when fixed. */
				line?: string;
		  }
		| { build: "pass"; browser: "not-configured" | "explicit" | "none" };
	/**
	 * text the build log never contains; in a passing
	 * cell it may appear only in worker and lazy-local chunks and their maps.
	 */
	sentinel?: string;
}

/** sentinels: an audience host and a userinfo password. */
export const SENTINEL_HOST = "sentinel.example";
export const SENTINEL_SECRET = "sentinelsecret";

export const CONTROL_CELLS: readonly ControlCell[] = [
	{
		// Plugin absent: the root sees the inert default wiring.
		id: "plugin-absent",
		consumer: "vanilla-polling",
		bundler: "vite",
		env: { CONSUMER_MODE: "production", CONSUMER_PLUGIN: "off" },
		files: [],
		hide: [],
		out: "out/vite-plugin-absent",
		expect: { build: "pass", browser: "not-configured" },
	},
	{
		// No `spinetab/<source>` import anywhere: production fails.
		id: "empty-set",
		consumer: "vanilla-polling",
		bundler: "vite",
		env: { CONSUMER_MODE: "production" },
		// `main.cjs` (the CommonJS page cell's entry) carries a real `require`
		// of `spinetab/polling`, so it is replaced too.
		files: ["main.js", "main.cjs"],
		hide: ["types"],
		out: "out/vite-empty-set",
		expect: { build: "fail", code: "no-adapters" },
	},
	{
		// A worker file plus generated-worker options.
		id: "worker-with-options",
		consumer: "vue-graphql-ws",
		bundler: "vite",
		env: {
			CONSUMER_MODE: "production",
			CONSUMER_PLUGIN_ADAPTERS: "graphql-ws",
		},
		files: [],
		hide: [],
		out: "out/vite-worker-with-options",
		expect: { build: "fail", code: "worker-file-with-options" },
	},
	{
		// Plugin present, explicit `worker`/`local`: L1 behaviour, all or
		// nothing; the auto chunks are emitted but never downloaded.
		id: "explicit-options",
		consumer: "vanilla-polling",
		bundler: "vite",
		env: { CONSUMER_MODE: "production" },
		files: ["main.js", "live.worker.js"],
		hide: [],
		out: "out/vite-explicit-options",
		expect: { build: "pass", browser: "explicit" },
	},
	{
		// A plugin `credentialOrigins` reaches only the generated worker, in
		// the worker and lazy-local chunks, never a URL or page chunk.
		id: "credential-origins",
		consumer: "vanilla-polling",
		bundler: "vite",
		env: {
			CONSUMER_MODE: "production",
			CONSUMER_PLUGIN_ORIGINS: `https://${SENTINEL_HOST}`,
		},
		files: [],
		hide: [],
		out: "out/vite-credential-origins",
		expect: { build: "pass", browser: "none" },
		sentinel: SENTINEL_HOST,
	},
	{
		// An invalid entry names its index, never its value: the userinfo
		// password stays out of the whole log.
		id: "invalid-credential-origin",
		consumer: "vanilla-polling",
		bundler: "vite",
		env: {
			CONSUMER_MODE: "production",
			CONSUMER_PLUGIN_ORIGINS: `https://user:${SENTINEL_SECRET}@bad.example`,
		},
		files: [],
		hide: [],
		out: "out/vite-invalid-credential-origin",
		expect: {
			build: "fail",
			code: "invalid-credential-origin",
			line: '[spinetab] invalid-credential-origin: credentialOrigins[0] must be an exact https: origin such as "https://api.example.com" (http: only for loopback), without a path, query, fragment or userinfo.',
		},
		sentinel: SENTINEL_SECRET,
	},
	{
		// (consumer cell c): Vite 8 with verbatimModuleSyntax
		// (src/tsconfig.json) keeps `import { type SseFeed } from
		// "spinetab/sse"` as `import {} from "spinetab/sse"`, so the entry
		// reaches the graph check while the app never uses SSE as a value.
		// The check ignores the type-only importer: the build passes and the
		// worker holds polling alone. The output cannot show the retained
		// import (Rolldown drops it even untreeshaken); the discriminator is
		// the plugin's adapter selection with verbatimModuleSyntax enabled.
		id: "verbatim-type-only",
		consumer: "vanilla-polling",
		bundler: "vite",
		env: { CONSUMER_MODE: "production" },
		files: ["main.js", "feed-label.ts", "tsconfig.json"],
		hide: [],
		out: "out/vite-verbatim-type-only",
		expect: { build: "pass", browser: "none" },
	},
];

/**
 * The hoisted npm control cell: `npm install` of the
 * tarball into a flat `node_modules`, outside pnpm's isolated layout. The
 * root's `spinetab/wiring` self-import must resolve inside the installed
 * package, to its inert default, from ESM and CommonJS. `npm.test.ts` runs
 * it in `<work root>/<dir>`.
 */
export const NPM_HOISTED_CELL = {
	id: "npm-hoisted",
	dir: "npm-hoisted",
} as const;

/** The exact build-log line of a failing control cell. */
export const buildErrorLine = (code: string): RegExp =>
	new RegExp(`\\[spinetab\\] ${code}: `);

/** Ports: front ports, upstream = front + 100. */
export const PORTS = {
	fixture: 4500,
	fixtureSecond: 4501,
	vite: { prod: 4610, dev: 4611, base: 4612 },
	webpack: { prod: 4620, dev: 4621, base: 4622 },
	rspack: { prod: 4630, dev: 4631, base: 4632 },
	next: { prod: 4640, dev: 4641, base: 4642, cdnApp: 4643, cdnStatic: 4644 },
	"next-webpack": { prod: 4650, dev: 4651, base: 4652 },
	astro: { prod: 4660, dev: 4661, base: 4662 },
} as const;

export function appRoot(spec: ConsumerSpec, consumerRoot: string): string {
	return spec.appDir ? `${consumerRoot}/${spec.appDir}` : consumerRoot;
}

export const upstreamPort = (frontPort: number) => frontPort + 100;

/** Strict production policy for static cells. */
export const STATIC_CSP =
	"default-src 'self'; script-src 'self'; worker-src 'self'; connect-src 'self'; style-src 'self'; object-src 'none'; base-uri 'self'";

/** Documented startup reasons for worker asset/CSP failures. */
export const STARTUP_REASONS = [
	"unsupported",
	"worker-construct-failed",
	"worker-error",
	"worker-startup-error",
	"startup-timeout",
	"incompatible-version",
	"handshake-invalid",
] as const;
