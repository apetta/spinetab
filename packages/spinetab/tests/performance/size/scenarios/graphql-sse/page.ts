import { createSpinetab, type SpinetabClient } from "spinetab";
import { graphqlSse } from "spinetab/graphql-sse";

/** Tells the size runner which mode settled (shared, local or failed). */
function ready(client: SpinetabClient): void {
	client.status.subscribe((status) => {
		if (status.mode !== "inactive" && status.mode !== "starting") {
			(globalThis as { __sizeReady?: string }).__sizeReady = status.mode;
		}
	});
}

export function start(root: HTMLElement): void {
	const sharing =
		new URLSearchParams(location.search).get("sharing") === "off"
			? "off"
			: "prefer";
	const client = createSpinetab({
		worker: () =>
			new SharedWorker(new URL("./worker.ts", import.meta.url), {
				type: "module",
				name: "size-graphql-sse",
			}),
		local: () => import("./local"),
		sharing,
	});
	ready(client);
	const endpoint = graphqlSse({
		url: "/graphql/stream",
		mode: "distinct",
		anonymous: true,
	});
	client.subscribe(endpoint.subscription({ query: "subscription { tick }" }), {
		next: (result) => {
			root.textContent = JSON.stringify(result.data);
		},
	});
}
