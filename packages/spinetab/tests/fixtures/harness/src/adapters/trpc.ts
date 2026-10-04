import { trpcSseAdapter, trpcWsAdapter } from "spinetab/trpc/runtime";
import superjson from "superjson";

/**
 * tRPC part of the harness worker (add both to live.adapters.ts). The worker
 * runs superjson, matching the fixture router, so Date and Map values reach
 * the page through structured clone. The SSE adapter uses the browser's
 * native EventSource (cookie recipe); fixture tags starting with `anon` need
 * no credentials.
 */
export const trpcWsHarnessAdapter = trpcWsAdapter({
	transformer: superjson,
	retryDelayMs: (attempt) => Math.min(100 * 2 ** attempt, 1_000),
});

export const trpcSseHarnessAdapter = trpcSseAdapter({
	transformer: superjson,
	retryDelayMs: (attempt) => Math.min(100 * 2 ** attempt, 1_000),
});
