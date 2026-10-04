import { createTRPCUntypedClient } from "@trpc/client";
import type { AnyTRPCRouter } from "@trpc/server";
import { createSpinetab, type SpinetabClient } from "spinetab";
import { spinetabWsLink } from "spinetab/trpc";

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
				name: "size-trpc",
			}),
		local: () => import("./local"),
		sharing,
	});
	ready(client);
	const trpc = createTRPCUntypedClient<AnyTRPCRouter>({
		links: [
			spinetabWsLink<AnyTRPCRouter>({ client, url: "/trpc", anonymous: true }),
		],
	});
	trpc.subscription("ticks", undefined, {
		onData: (value: unknown) => {
			root.textContent = JSON.stringify(value);
		},
	});
}
