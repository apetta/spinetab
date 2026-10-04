// Keep these literal worker URLs intact: bundlers discover both runtime entry points from them.
import type { SpinetabWiring } from "../core/types.ts";

export const wiring: SpinetabWiring = {
	worker: () =>
		new SharedWorker(new URL("./worker.js", import.meta.url), {
			type: "module",
		}),
	local: () => import("./worker.ts"),
};
