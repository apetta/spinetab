import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { createSpinetab, type SpinetabClient } from "spinetab";
import { swrSubscription } from "spinetab/swr";
import { websocket } from "spinetab/websocket";
import useSWRSubscription from "swr/subscription";

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
				name: "size-swr",
			}),
		local: () => import("./local"),
		sharing,
	});
	ready(client);
	const feed = websocket<string>({ url: "/ws", protocol: "json" });
	const subscribe = swrSubscription(client, (key: string) =>
		feed.subscription(key),
	);
	function Prices() {
		const { data } = useSWRSubscription("prices", subscribe);
		return createElement("p", null, JSON.stringify(data ?? null));
	}
	createRoot(root).render(createElement(Prices));
}
