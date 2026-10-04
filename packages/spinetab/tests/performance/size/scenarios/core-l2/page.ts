import { createSpinetab, type SpinetabClient } from "spinetab";

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
	// The plugin supplies the wiring: this scenario's spinetab.worker.ts.
	const client = createSpinetab({ sharing });
	ready(client);
	client.subscribe<number>(
		{ adapter: "clock", connection: {}, subscription: {} },
		{
			next: (value) => {
				root.textContent = String(value);
			},
		},
	);
	void client
		.command({ adapter: "clock", connection: {}, payload: { reset: true } })
		.then((outcome) => {
			root.dataset.command = outcome.status;
		});
}
