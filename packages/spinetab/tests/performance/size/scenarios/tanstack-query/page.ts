import { QueryClient } from "@tanstack/query-core";
import { createSpinetab, type SpinetabClient } from "spinetab";
import { bindQuery } from "spinetab/tanstack-query";
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
				name: "size-tanstack-query",
			}),
		local: () => import("./local"),
		sharing,
	});
	ready(client);
	const feed = websocket<string>({ url: "/ws", protocol: "json" });
	const queryClient = new QueryClient();
	bindQuery(client, feed.subscription("prices"), {
		queryClient,
		onEvent: (event, tools) => {
			tools.setQueryData(["prices"], event);
			root.textContent = JSON.stringify(tools.getQueryData(["prices"]));
		},
	});
}
