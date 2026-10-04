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
	const client = createSpinetab({
		worker: () =>
			new SharedWorker(new URL("./worker.ts", import.meta.url), {
				type: "module",
				name: "size-core",
			}),
		local: () => import("./local"),
		sharing,
	});
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
