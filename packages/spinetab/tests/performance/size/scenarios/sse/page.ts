import { createSpinetab, type SpinetabClient } from "spinetab";
import { sse } from "spinetab/sse";

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
				name: "size-sse",
			}),
		local: () => import("./local"),
		sharing,
	});
	ready(client);
	const feed = sse({ url: "/sse", mode: "fetch", decoder: "text" });
	client.subscribe(feed.subscription({ event: "tick" }), {
		next: (event, meta) => {
			root.textContent = `${meta.eventId ?? ""} ${String(event)}`;
		},
	});
}
