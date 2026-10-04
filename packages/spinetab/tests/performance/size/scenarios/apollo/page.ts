import { ApolloClient, gql, InMemoryCache } from "@apollo/client";
import { createSpinetab, type SpinetabClient } from "spinetab";
import { SpinetabLink } from "spinetab/apollo";
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
				name: "size-apollo",
			}),
		local: () => import("./local"),
		sharing,
	});
	ready(client);
	const apollo = new ApolloClient({
		link: new SpinetabLink(
			client,
			graphqlWs({ url: "/graphql", anonymous: true }),
		),
		cache: new InMemoryCache(),
	});
	apollo.subscribe({ query: gql`subscription { tick }` }).subscribe({
		next: (result) => {
			root.textContent = JSON.stringify(result.data);
		},
	});
}
