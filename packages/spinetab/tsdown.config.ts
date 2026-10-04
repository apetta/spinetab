import { defineConfig } from "tsdown";

const pageEntries = {
	index: "src/index.ts",
	websocket: "src/transports/websocket/index.ts",
	sse: "src/transports/sse/index.ts",
	stream: "src/transports/stream/index.ts",
	polling: "src/transports/polling/index.ts",
	"graphql-ws": "src/protocols/graphql-ws/index.ts",
	"graphql-sse": "src/protocols/graphql-sse/index.ts",
	"socket-io": "src/protocols/socket-io/index.ts",
	apollo: "src/integrations/apollo/index.ts",
	"tanstack-query": "src/integrations/tanstack-query/index.ts",
	swr: "src/integrations/swr/index.ts",
	trpc: "src/integrations/trpc/index.ts",
	"ai-sdk": "src/integrations/ai-sdk/index.ts",
	react: "src/bindings/react/index.ts",
	vue: "src/bindings/vue/index.ts",
	svelte: "src/bindings/svelte/index.ts",
	solid: "src/bindings/solid/index.ts",
	// The plugin-absent wiring default; imported by the root.
	wiring: "src/wiring.ts",
};

// Runtime entries run in the SharedWorker or the lazily loaded local runtime.
// They are modules only; CommonJS output would not imply a Node runtime.
const runtimeEntries = {
	runtime: "src/runtime/index.ts",
	worker: "src/worker/index.ts",
	"websocket/runtime": "src/transports/websocket/runtime.ts",
	"sse/runtime": "src/transports/sse/runtime.ts",
	"stream/runtime": "src/transports/stream/runtime.ts",
	"polling/runtime": "src/transports/polling/runtime.ts",
	"graphql-ws/runtime": "src/protocols/graphql-ws/runtime.ts",
	"graphql-sse/runtime": "src/protocols/graphql-sse/runtime.ts",
	"socket-io/runtime": "src/protocols/socket-io/runtime.ts",
	"trpc/runtime": "src/integrations/trpc/runtime.ts",
	"ai-sdk/runtime": "src/integrations/ai-sdk/runtime.ts",
};

// Build auto/wiring and auto/worker together so the lazy import remains a sibling reference.
const seamEntries = {
	"auto/wiring": "src/auto/wiring.ts",
	"auto/worker": "src/auto/worker.ts",
	"worker-config": "src/worker-config.ts",
};

// Optional peers stay external in every entry; they are installed only with
// the adapter that needs them.
const external = [
	// Package self-imports stay bare so a bundler plugin can redirect them.
	/^spinetab\/(wiring|worker-config)$/,
	/^@apollo\/client(\/|$)/,
	/^@tanstack\/query-core(\/|$)/,
	/^@trpc\/(client|server)(\/|$)/,
	/^ai(\/|$)/,
	/^graphql(\/|$)/,
	/^graphql-sse(\/|$)/,
	/^graphql-ws(\/|$)/,
	/^react(\/|$)/,
	/^rxjs(\/|$)/,
	/^socket\.io-client(\/|$)/,
	/^solid-js(\/|$)/,
	/^svelte(\/|$)/,
	/^swr(\/|$)/,
	/^vue(\/|$)/,
];

/**
 * Declarations ship without `.d.ts.map` files: `src/` is not published, so a
 * declaration map would only dangle. rolldown-plugin-dts 0.28.6
 * gives its declaration output the JS `sourcemap` setting and, with
 * `dts.sourcemap: false`, deletes the map asset in `generateBundle` while the
 * declaration chunk keeps its `sourceMappingURL` comment. This post hook drops
 * that comment from this build's declaration chunks before they are written;
 * JS chunks and their maps are untouched.
 */
const stripDeclarationMapReferences = {
	name: "spinetab:strip-declaration-map-references",
	generateBundle: {
		order: "post" as const,
		handler(
			_options: unknown,
			bundle: Record<string, { type: string; fileName: string; code?: string }>,
		) {
			const pattern =
				/\n?\/\/# sourceMappingURL=[^\n]*\.d\.[cm]?ts\.map[ \t]*\n?$/;
			for (const output of Object.values(bundle)) {
				if (output.type !== "chunk" || typeof output.code !== "string")
					continue;
				if (!/\.d\.[cm]?ts$/.test(output.fileName)) continue;
				const stripped = output.code.replace(pattern, "\n");
				if (stripped !== output.code) output.code = stripped;
			}
		},
	},
};

const shared = {
	platform: "neutral",
	target: "es2022",
	dts: { sourcemap: false },
	sourcemap: true,
	exports: false,
	external,
} as const;

export default defineConfig([
	{
		...shared,
		clean: true,
		entry: { ...pageEntries, ...runtimeEntries, ...seamEntries },
		format: "esm",
		plugins: [stripDeclarationMapReferences],
	},
	{
		...shared,
		clean: false,
		entry: pageEntries,
		format: "cjs",
		plugins: [stripDeclarationMapReferences],
		// tsdown emits CJS declarations from a separate rolldown run that has no
		// user plugins, so the hook above cannot reach `.d.cts` chunks. That run
		// emits declarations only; without a JS sourcemap setting the dts plugin
		// writes neither a map nor a reference, and CJS JS maps are unaffected.
		outputOptions: (options, _format, { cjsDts }) =>
			cjsDts ? { ...options, sourcemap: false } : options,
	},
]);
