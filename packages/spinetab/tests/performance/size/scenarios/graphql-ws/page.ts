import { createSpinetab, type SpinetabClient } from "spinetab";
import { graphqlWs } from "spinetab/graphql-ws";

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
				name: "size-graphql-ws",
			}),
		local: () => import("./local"),
		sharing,
	});
	ready(client);
	const endpoint = graphqlWs({ url: "/graphql", anonymous: true });
	client.subscribe(endpoint.subscription({ query: "subscription { tick }" }), {
		next: (result) => {
			root.textContent = JSON.stringify(result.data);
		},
	});
}
