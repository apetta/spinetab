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
};

const shared = {
	platform: "neutral",
	target: "es2022",
	dts: true,
	sourcemap: true,
	clean: true,
	exports: false,
} as const;

export default defineConfig([
	{
		...shared,
		entry: { ...pageEntries, worker: "src/worker/index.ts" },
		format: "esm",
	},
	{
		...shared,
		entry: pageEntries,
		format: "cjs",
	},
]);
