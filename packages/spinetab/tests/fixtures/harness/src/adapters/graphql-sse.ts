import { graphqlSseAdapter } from "spinetab/graphql-sse/runtime";

/**
 * graphql-sse part of the harness worker (add to live.adapters.ts). Fixture
 * endpoints are `/graphql-sse/<tag>`; tags starting with `anon` need no
 * credentials (declare `anonymous: true`). Backoff shortened for browser runs.
 */
export const graphqlSseHarnessAdapter = graphqlSseAdapter({
	retry: (retries) =>
		new Promise((resolve) =>
			setTimeout(resolve, Math.min(100 * 2 ** retries, 1_000)),
		),
});
