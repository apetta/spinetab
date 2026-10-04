import { createSpinetab, type SpinetabClient } from "spinetab";
import { subscriptionStore } from "spinetab/svelte";
import { websocket } from "spinetab/websocket";

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
				name: "size-svelte",
			}),
		local: () => import("./local"),
		sharing,
	});
	ready(client);
	const feed = websocket<string>({ url: "/ws", protocol: "json" });
	const store = subscriptionStore(client, feed.subscription("prices"), {
		next: (event) => {
			root.dataset.last = JSON.stringify(event);
		},
	});
	store.subscribe((status) => {
		root.textContent = status.connection.state;
	});
}
