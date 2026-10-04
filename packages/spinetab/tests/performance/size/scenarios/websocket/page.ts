import { createSpinetab, type SpinetabClient } from "spinetab";
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
				name: "size-websocket",
			}),
		local: () => import("./local"),
		sharing,
	});
	ready(client);
	const feed = websocket<string>({ url: "/ws", protocol: "json" });
	client.subscribe(feed.subscription("prices"), {
		next: (event) => {
			root.textContent = JSON.stringify(event);
		},
	});
	void client.command(feed.command({ ping: 1 })).then((outcome) => {
		root.dataset.command = outcome.status;
	});
}
