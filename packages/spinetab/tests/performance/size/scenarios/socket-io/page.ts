import { createSpinetab, type SpinetabClient } from "spinetab";
import { socketIo } from "spinetab/socket-io";

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
				name: "size-socket-io",
			}),
		local: () => import("./local"),
		sharing,
	});
	ready(client);
	const endpoint = socketIo({ url: "/", sharing: "shared", anonymous: true });
	client.subscribe(endpoint.subscription({ event: "tick" }), {
		next: (args) => {
			root.textContent = JSON.stringify(args);
		},
	});
	void client
		.command(endpoint.command({ event: "echo", args: [1] }))
		.then((outcome) => {
			root.dataset.command = outcome.status;
		});
}
