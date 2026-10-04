import { graphqlWsAdapter } from "spinetab/graphql-ws/runtime";

/**
 * graphql-ws part of the harness worker. Wiring (core-owned live.adapters.ts):
 * `import { graphqlWsHarnessAdapter } from "./adapters/graphql-ws.ts"` and add
 * it to `adapters`. Pages send plain requests such as
 * `{ adapter: "graphql-ws", connection: { url: "/graphql-ws?tag=t&anonymous=1",
 * anonymous: true }, subscription: { query } }`; `graphqlWs()` builds the same.
 * Backoff is shortened for browser runs; production keeps upstream's.
 */
export const graphqlWsHarnessAdapter = graphqlWsAdapter({
	retryWait: (retries) =>
		new Promise((resolve) =>
			setTimeout(resolve, Math.min(100 * 2 ** retries, 1_000)),
		),
});
