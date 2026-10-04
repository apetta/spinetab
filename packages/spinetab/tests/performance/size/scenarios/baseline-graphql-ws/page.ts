import { createClient } from "graphql-ws";

/** Upstream client used directly: the peer-cost baseline for graphql-ws. */
export function start(root: HTMLElement): void {
	const url = new URL("/graphql", location.href);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	const client = createClient({ url: url.href, lazy: true });
	client.subscribe(
		{ query: "subscription { tick }" },
		{
			next: (result) => {
				root.textContent = JSON.stringify(result.data);
			},
			error: () => {
				root.dataset.failed = "1";
			},
			complete: () => {},
		},
	);
	(globalThis as { __sizeReady?: string }).__sizeReady = "baseline";
}
