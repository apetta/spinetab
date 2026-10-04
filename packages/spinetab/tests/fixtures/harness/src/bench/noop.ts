import { timerResolution } from "./channel";
import type { PageInfo } from "./types";

/**
 * Baseline page. `?worker=1` connects to the
 * no-op SharedWorker (browser-worker baseline); otherwise it is the empty-tab
 * baseline. No Spinetab code is loaded.
 */

const withWorker = new URLSearchParams(location.search).get("worker") === "1";
const pageId = crypto.randomUUID();
const resolution = timerResolution();
let worker: SharedWorker | undefined;

if (withWorker) {
	worker = new SharedWorker(new URL("./noop.worker.ts", import.meta.url), {
		type: "module",
		name: "spinetab-bench-noop",
	});
	worker.port.start();
}

const noop = {
	ready: true,
	info(): PageInfo {
		return {
			kind: withWorker ? "noop" : "empty",
			pageId,
			visibility: document.visibilityState,
			resolution,
			timeOrigin: performance.timeOrigin,
		};
	},
	/** Round trip to the no-op worker (proves it is live); NaN without one. */
	ping(): Promise<number> {
		const port = worker?.port;
		if (!port) return Promise.resolve(Number.NaN);
		const started = performance.now();
		return new Promise((resolve) => {
			const onMessage = () => {
				port.removeEventListener("message", onMessage);
				resolve(performance.now() - started);
			};
			port.addEventListener("message", onMessage);
			port.postMessage({ op: "ping" });
		});
	},
};

(window as unknown as { bench: typeof noop }).bench = noop;
