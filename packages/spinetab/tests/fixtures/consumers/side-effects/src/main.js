import { probeDefineWorker } from "./define-worker.js";
import { snapshot } from "./spies.js";

// Page realm: peers are loaded first, then each Spinetab entry is imported on
// its own after the spies, so any effect is attributed to that entry.
const entries = {
	".": () => import("spinetab"),
	// The plugin-absent default the root imports: browser entries
	// only, so the build entries and the plugin-owned seams stay out.
	"./wiring": () => import("spinetab/wiring"),
	"./runtime": () => import("spinetab/runtime"),
	"./worker": () => import("spinetab/worker"),
	"./websocket": () => import("spinetab/websocket"),
	"./websocket/runtime": () => import("spinetab/websocket/runtime"),
	"./sse": () => import("spinetab/sse"),
	"./sse/runtime": () => import("spinetab/sse/runtime"),
	"./stream": () => import("spinetab/stream"),
	"./stream/runtime": () => import("spinetab/stream/runtime"),
	"./polling": () => import("spinetab/polling"),
	"./polling/runtime": () => import("spinetab/polling/runtime"),
	"./graphql-ws": () => import("spinetab/graphql-ws"),
	"./graphql-ws/runtime": () => import("spinetab/graphql-ws/runtime"),
	"./graphql-sse": () => import("spinetab/graphql-sse"),
	"./graphql-sse/runtime": () => import("spinetab/graphql-sse/runtime"),
	"./socket-io": () => import("spinetab/socket-io"),
	"./socket-io/runtime": () => import("spinetab/socket-io/runtime"),
	"./apollo": () => import("spinetab/apollo"),
	"./tanstack-query": () => import("spinetab/tanstack-query"),
	"./swr": () => import("spinetab/swr"),
	"./trpc": () => import("spinetab/trpc"),
	"./trpc/runtime": () => import("spinetab/trpc/runtime"),
	"./ai-sdk": () => import("spinetab/ai-sdk"),
	"./ai-sdk/runtime": () => import("spinetab/ai-sdk/runtime"),
	"./react": () => import("spinetab/react"),
	"./vue": () => import("spinetab/vue"),
	"./svelte": () => import("spinetab/svelte"),
	"./solid": () => import("spinetab/solid"),
};

async function run() {
	await import("./peers.js");
	// Loading the peers' chunks is the harness's own work, not an entry's.
	snapshot();
	const page = {};
	for (const [subpath, load] of Object.entries(entries)) {
		const module = await load();
		page[subpath] = { ...snapshot(), exports: Object.keys(module).length };
	}
	const { defineWorker } = await import("spinetab/worker");
	const defineWorkerCall = probeDefineWorker(defineWorker, snapshot);
	const worker = await new Promise((resolve, reject) => {
		const probe = new Worker(new URL("./probe.worker.js", import.meta.url), {
			type: "module",
		});
		probe.addEventListener("message", (event) => resolve(event.data));
		probe.addEventListener("error", (event) =>
			reject(new Error(event.message || "probe worker failed")),
		);
	});
	const report = { page, defineWorker: defineWorkerCall, worker, done: true };
	window.__sideEffects = report;
	document.getElementById("report").textContent = JSON.stringify(
		report,
		null,
		2,
	);
}

run().catch((error) => {
	window.__sideEffects = { done: true, error: String(error?.stack ?? error) };
});
