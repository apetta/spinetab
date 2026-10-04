import { createSpinetab, type SpinetabClient } from "spinetab";
import { pollEvery, polling } from "spinetab/polling";

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
				name: "size-polling",
			}),
		local: () => import("./local"),
		sharing,
	});
	ready(client);
	const feed = polling({ url: "/poll" });
	client.subscribe(
		feed.subscription(),
		{
			next: (event) => {
				root.textContent = JSON.stringify(event);
			},
		},
		pollEvery(5_000),
	);
}
