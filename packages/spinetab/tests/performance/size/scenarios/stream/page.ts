import { createSpinetab, type SpinetabClient } from "spinetab";
import { stream } from "spinetab/stream";

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
				name: "size-stream",
			}),
		local: () => import("./local"),
		sharing,
	});
	ready(client);
	const feed = stream({ url: "/stream", parser: "ndjson", repeatable: true });
	client.subscribe(feed.subscription(), {
		next: (event) => {
			root.textContent = JSON.stringify(event);
		},
	});
}
