/**
 * Per-entry dependency allow-list for the built package. Shared by the dist checks (`tests/package/*.test.ts`)
 * and the packed-consumer isolation inspection (`consumers/inspect.ts`).
 *
 * Areas come from sourcemap `sources` (JS) or `//#region src/…` markers
 * (declarations): `src/core/**`, `src/runtime/**`, `src/worker/**`,
 * `src/index.ts` and `src/wiring.ts` are core; the plugin seams
 * (`src/auto/**`, `src/worker-config.ts`) are `auto`; `src/build/**` is
 * `build`, never core; `src/<kind>/<name>/**` is the area `<kind>/<name>`.
 * An entry's closure may contain core, its own areas and the helper areas it
 * explicitly wraps, nothing else. Build closures are narrower still: only
 * `BUILD_SOURCES` and `BUILD_SHARED_SOURCES`.
 */

export const CORE = "core";
/** The plugin seams: the shipped literals, the keep stub and its stub target. */
export const AUTO = "auto";
/** The Node-only bundler plugins and their loader. */
export const BUILD = "build";

export type Realm = "page" | "runtime" | "build";

export interface EntryRule {
	/** Non-core areas the entry's closure may contain. */
	areas: readonly string[];
	/** Bare-specifier packages its emitted JS closure may import. */
	jsPeers: readonly string[];
	/** Bare-specifier packages its declaration closure may import. */
	typePeers: readonly string[];
	/**
	 * Page entries never reach the engine, runtime entries never reach page
	 * code, and build entries (Node-only, dual format) reach neither.
	 */
	realm: Realm;
	/**
	 * Package self-imports its emitted closure keeps bare, so a bundler plugin
	 * can redirect them. Never a peer, never followed into `dist`.
	 */
	selfImports?: readonly string[];
	/** `node:` built-ins are allowed in build rules and nowhere else. */
	nodeBuiltins?: boolean;
	/**
	 * The one permitted dynamic edge from a page closure into the runtime
	 * realm: the emitted `import()` target, the source it maps to, and the
	 * runtime subpath whose own rule judges everything past the edge.
	 */
	runtimeEdge?: { source: string; subpath: string };
}

const transport = (name: string, realm: EntryRule["realm"]): EntryRule => ({
	areas: [`transports/${name}`, "transports/shared"],
	jsPeers: [],
	typePeers: [],
	realm,
});

const graphqlAreas = (name: string) => [
	`protocols/${name}`,
	"protocols/graphql",
	"protocols/shared",
];

/** Build entries: structural types, no peers, `node:` built-ins only. */
const build: EntryRule = {
	areas: [BUILD],
	jsPeers: [],
	typePeers: [],
	realm: "build",
	nodeBuiltins: true,
};

export const ENTRY_RULES: Readonly<Record<string, EntryRule>> = {
	".": {
		areas: [],
		jsPeers: [],
		typePeers: [],
		realm: "page",
		selfImports: ["spinetab/wiring"],
	},
	// The plugin-absent default the root imports.
	"./wiring": { areas: [], jsPeers: [], typePeers: [], realm: "page" },
	// The shipped literals: page realm, with the one dynamic edge into the
	// runtime realm (`import("./worker.js")`, the lazy local module).
	"./auto/wiring": {
		areas: [AUTO],
		jsPeers: [],
		typePeers: [],
		realm: "page",
		runtimeEdge: { source: "src/auto/worker.ts", subpath: "./auto/worker" },
	},
	// The keep stub: its bare `spinetab/worker-config` is what the plugin
	// supplies (the developer's file at L2, generated text at L3).
	"./auto/worker": {
		areas: [AUTO],
		jsPeers: [],
		typePeers: [],
		realm: "runtime",
		selfImports: ["spinetab/worker-config"],
	},
	"./worker-config": {
		areas: [AUTO],
		jsPeers: [],
		typePeers: [],
		realm: "runtime",
	},
	"./runtime": { areas: [], jsPeers: [], typePeers: [], realm: "runtime" },
	"./worker": { areas: [], jsPeers: [], typePeers: [], realm: "runtime" },
	"./websocket": transport("websocket", "page"),
	"./websocket/runtime": transport("websocket", "runtime"),
	"./sse": transport("sse", "page"),
	"./sse/runtime": transport("sse", "runtime"),
	"./stream": transport("stream", "page"),
	"./stream/runtime": transport("stream", "runtime"),
	"./polling": transport("polling", "page"),
	"./polling/runtime": transport("polling", "runtime"),
	"./graphql-ws": {
		areas: graphqlAreas("graphql-ws"),
		jsPeers: [],
		typePeers: [],
		realm: "page",
	},
	"./graphql-ws/runtime": {
		areas: graphqlAreas("graphql-ws"),
		jsPeers: ["graphql-ws", "graphql"],
		typePeers: ["graphql-ws", "graphql"],
		realm: "runtime",
	},
	"./graphql-sse": {
		areas: graphqlAreas("graphql-sse"),
		jsPeers: [],
		typePeers: [],
		realm: "page",
	},
	"./graphql-sse/runtime": {
		areas: graphqlAreas("graphql-sse"),
		jsPeers: ["graphql-sse", "graphql"],
		typePeers: ["graphql-sse", "graphql"],
		realm: "runtime",
	},
	"./socket-io": {
		areas: ["protocols/socket-io", "protocols/shared"],
		jsPeers: [],
		typePeers: [],
		realm: "page",
	},
	"./socket-io/runtime": {
		areas: ["protocols/socket-io", "protocols/shared"],
		jsPeers: ["socket.io-client"],
		typePeers: ["socket.io-client"],
		realm: "runtime",
	},
	// Apollo accepts either GraphQL endpoint as input; it wraps the shared
	// page-side GraphQL types, never a GraphQL adapter entry.
	"./apollo": {
		areas: ["integrations/apollo", "protocols/graphql"],
		jsPeers: ["@apollo/client", "rxjs"],
		typePeers: ["@apollo/client", "rxjs", "graphql"],
		realm: "page",
	},
	"./tanstack-query": {
		areas: ["integrations/tanstack-query"],
		jsPeers: [],
		typePeers: ["@tanstack/query-core"],
		realm: "page",
	},
	"./swr": {
		areas: ["integrations/swr"],
		jsPeers: [],
		typePeers: ["swr"],
		realm: "page",
	},
	// `@trpc/server` is type-only (AnyTRPCRouter). The contract lists it
	// for `spinetab/trpc`; the runtime entry's declarations reuse the same
	// router constraint.
	"./trpc": {
		areas: ["integrations/trpc", "protocols/shared"],
		jsPeers: ["@trpc/client"],
		typePeers: ["@trpc/client", "@trpc/server"],
		realm: "page",
	},
	"./trpc/runtime": {
		areas: ["integrations/trpc", "protocols/shared"],
		jsPeers: ["@trpc/client"],
		typePeers: ["@trpc/client", "@trpc/server"],
		realm: "runtime",
	},
	"./ai-sdk": {
		areas: ["integrations/ai-sdk"],
		jsPeers: [],
		typePeers: ["ai"],
		realm: "page",
	},
	"./ai-sdk/runtime": {
		areas: ["integrations/ai-sdk"],
		jsPeers: [],
		// Runtime declarations type wire chunks structurally (`AiChunk`), so the
		// worker realm never loads the AI SDK's Node/DOM-dependent declarations.
		typePeers: [],
		realm: "runtime",
	},
	"./react": {
		areas: ["bindings/react", "bindings/shared"],
		jsPeers: ["react"],
		typePeers: ["react"],
		realm: "page",
	},
	"./vue": {
		areas: ["bindings/vue", "bindings/shared"],
		jsPeers: ["vue"],
		typePeers: ["vue"],
		realm: "page",
	},
	"./svelte": {
		areas: ["bindings/svelte", "bindings/shared"],
		jsPeers: ["svelte"],
		typePeers: ["svelte"],
		realm: "page",
	},
	"./solid": {
		areas: ["bindings/solid", "bindings/shared"],
		jsPeers: ["solid-js"],
		typePeers: ["solid-js"],
		realm: "page",
	},
	"./vite": build,
	"./webpack": build,
	"./rspack": build,
	"./next": build,
	"./astro": build,
	"./nuxt": build,
	"./loader": build,
};

/** The seam subpaths a plugin recipe's graph may reach. */
export const SEAM_SUBPATHS: readonly string[] = [
	"./wiring",
	"./auto/wiring",
	"./auto/worker",
	"./worker-config",
];

/** Bundler packages: devDependencies for the package's own tests, never peers. */
export const BUNDLER_PACKAGES: readonly string[] = [
	"vite",
	"webpack",
	"@rspack/core",
	"next",
	"astro",
];

/**
 * Engine sources a page entry must never reach, and page sources a runtime
 * entry must never reach. The seams join their realm:
 * the keep stub and its target are runtime code, the wiring modules page code.
 */
export const ENGINE_SOURCES: readonly RegExp[] = [
	/^src\/core\/(runtime|broker|host|adapter)\.ts$/,
	/^src\/runtime\//,
	/^src\/worker\//,
	/^src\/auto\/worker\.ts$/,
	/^src\/worker-config\.ts$/,
];
export const PAGE_SOURCES: readonly RegExp[] = [
	/^src\/index\.ts$/,
	/^src\/wiring\.ts$/,
	/^src\/auto\/wiring\.ts$/,
	/^src\/core\/(client|attachment|lifecycle|local)\.ts$/,
	/^src\/bindings\//,
	/^src\/(transports|protocols)\/[^/]+\/index\.ts$/,
	/^src\/integrations\/[^/]+\/index\.ts$/,
];
/** Build-realm sources: no page or runtime closure may reach them. */
export const BUILD_SOURCES: readonly RegExp[] = [/^src\/build\//];
/**
 * The only non-build sources a build closure may reach: the pure credential
 * origin validator shared with the runtime .
 */
export const BUILD_SHARED_SOURCES: readonly string[] = ["src/core/origins.ts"];

/**
 * Packages that must never appear anywhere in dist. `node:`
 * built-ins are a per-realm rule (`nodeBuiltins`), not a global ban.
 */
export const FORBIDDEN_SPECIFIERS: readonly RegExp[] = [
	/^next(\/|$)/,
	/^server-only$/,
	/^client-only$/,
];

export const isNodeBuiltin = (specifier: string) =>
	specifier.startsWith("node:");

/** Area of a source path relative to the package root, e.g. `src/core/x.ts`. */
export function areaOf(source: string): string | undefined {
	const path = source.replace(/\\/g, "/");
	if (path === "src/index.ts" || path === "src/wiring.ts") return CORE;
	if (/^src\/(core|runtime|worker)\//.test(path)) return CORE;
	if (/^src\/auto\/[^/]+$/.test(path) || path === "src/worker-config.ts")
		return AUTO;
	if (path.startsWith("src/build/")) return BUILD;
	const match =
		/^src\/(transports|protocols|integrations|bindings)\/([^/]+)\//.exec(path);
	return match ? `${match[1]}/${match[2]}` : undefined;
}

/** Package name of a bare specifier (`@scope/name/sub` → `@scope/name`). */
export function packageName(specifier: string): string {
	const parts = specifier.split("/");
	return specifier.startsWith("@")
		? `${parts[0]}/${parts[1] ?? ""}`
		: (parts[0] ?? specifier);
}

export function isBareSpecifier(specifier: string): boolean {
	return !(
		specifier.startsWith(".") ||
		specifier.startsWith("/") ||
		/^[a-z][a-z0-9+.-]*:/i.test(specifier)
	);
}

/** Union of every peer any entry may import: must equal the manifest peers. */
export function allowlistedPeers(): string[] {
	const peers = new Set<string>();
	for (const rule of Object.values(ENTRY_RULES)) {
		for (const peer of [...rule.jsPeers, ...rule.typePeers]) peers.add(peer);
	}
	return [...peers].sort();
}

/** Areas an entry may reach, core included. */
export function allowedAreas(subpath: string): Set<string> {
	const rule = ENTRY_RULES[subpath];
	if (!rule) throw new Error(`No allow-list rule for ${subpath}`);
	return new Set([CORE, ...rule.areas]);
}

/** Sources a closure of this realm must never reach. */
export function forbiddenSources(realm: Realm): readonly RegExp[] {
	if (realm === "page") return [...ENGINE_SOURCES, ...BUILD_SOURCES];
	if (realm === "runtime") return [...PAGE_SOURCES, ...BUILD_SOURCES];
	return [];
}

/** Whether a build closure may hold this source (build sources and the shared validator only). */
export const buildMayReach = (source: string) =>
	BUILD_SOURCES.some((pattern) => pattern.test(source)) ||
	BUILD_SHARED_SOURCES.includes(source);

/**
 * Whether an entry's emitted closure may import this bare specifier: its
 * peers (JS or types), its declared self-imports, and `node:` built-ins for
 * build rules only.
 */
export function allowsSpecifier(
	rule: EntryRule,
	specifier: string,
	kind: "js" | "types",
): boolean {
	if (isNodeBuiltin(specifier)) return rule.nodeBuiltins === true;
	if (rule.selfImports?.includes(specifier)) return true;
	const peers = kind === "js" ? rule.jsPeers : rule.typePeers;
	return peers.includes(packageName(specifier));
}

/** Every self-import any rule declares (bare `spinetab/…` specifiers kept external). */
export function allowlistedSelfImports(): string[] {
	const imports = new Set<string>();
	for (const rule of Object.values(ENTRY_RULES)) {
		for (const specifier of rule.selfImports ?? []) imports.add(specifier);
	}
	return [...imports].sort();
}
