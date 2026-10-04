import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { createSpinetab, type SpinetabClient } from "spinetab";
import { useLive } from "spinetab/react";
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
				name: "size-react",
			}),
		local: () => import("./local"),
		sharing,
	});
	ready(client);
	const feed = websocket<string>({ url: "/ws", protocol: "json" });
	// useLive tracks; every field it returns is
	// rendered, so nothing is optimised away.
	function Prices() {
		const { data, error, status, needsReconcile } = useLive(
			client,
			feed.subscription("prices"),
		);
		return createElement(
			"p",
			{ "data-reconcile": needsReconcile ? "needed" : "no" },
			status.connection.state,
			" ",
			error ? error.code : JSON.stringify(data ?? null),
		);
	}
	createRoot(root).render(createElement(Prices));
}
