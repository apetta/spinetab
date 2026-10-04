import { createSpinetab, type SpinetabClient } from "spinetab";
import { pollEvery, polling } from "spinetab/polling";

// Inference control: socket.io import text that is not an import.
// import { socketIo } from "spinetab/socket-io";

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
	// The plugin supplies the wiring and generates the worker.
	const client = createSpinetab({ sharing });
	ready(client);
	root.dataset.note = "import { socketIo } from 'spinetab/socket-io'";
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
