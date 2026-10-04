import { createSpinetab, type SpinetabClient } from "spinetab";
import { useSubscription } from "spinetab/vue";
import { websocket } from "spinetab/websocket";
import { createApp, defineComponent, h } from "vue";

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
				name: "size-vue",
			}),
		local: () => import("./local"),
		sharing,
	});
	ready(client);
	const feed = websocket<string>({ url: "/ws", protocol: "json" });
	const Prices = defineComponent({
		setup() {
			// biome-ignore lint/correctness/useHookAtTopLevel: a Vue composable inside setup(), not a React hook
			const { status } = useSubscription(
				client,
				() => feed.subscription("prices"),
				{
					next: (event) => {
						root.dataset.last = JSON.stringify(event);
					},
				},
			);
			return () => h("p", status.value.connection.state);
		},
	});
	createApp(Prices).mount(root);
}
