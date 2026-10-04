import { createSpinetab, type SpinetabClient } from "spinetab";
import { SpinetabChatTransport } from "spinetab/ai-sdk";

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
				name: "size-ai-sdk",
			}),
		local: () => import("./local"),
		sharing,
	});
	ready(client);
	const transport = new SpinetabChatTransport({ client, api: "/api/chat" });
	void transport
		.sendMessages({
			trigger: "submit-message",
			chatId: "size",
			messageId: undefined,
			messages: [],
			abortSignal: undefined,
		})
		.then(async (chunks) => {
			const { value } = await chunks.getReader().read();
			root.textContent = JSON.stringify(value ?? null);
		})
		.catch(() => {
			root.dataset.failed = "1";
		});
}
