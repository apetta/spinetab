import { createTRPCClient, httpBatchLink, splitLink } from "@trpc/client";
import { spinetabSseLink } from "spinetab/trpc";
import { spinetab } from "./live";
import type { QueueView } from "./queue-types";
import type { AppRouter } from "./router";

const trpc = createTRPCClient<AppRouter>({
	links: [
		splitLink({
			condition: (operation) => operation.type === "subscription",
			true: spinetabSseLink<AppRouter>({
				client: spinetab,
				url: "/trpc",
				reconcile: "latest",
			}),
			false: httpBatchLink({ url: "/trpc" }),
		}),
	],
});

export function watchQueue(
	next: (value: QueueView) => void,
	fail: (message: string) => void,
) {
	const subscription = trpc.queue.subscribe(undefined, {
		onData: (value) => {
			fail("");
			next(value);
		},
		onConnectionStateChange: (state) => {
			if (state.error) fail(state.error.message);
		},
		onError: (error) => fail(error.message),
	});
	return () => subscription.unsubscribe();
}
