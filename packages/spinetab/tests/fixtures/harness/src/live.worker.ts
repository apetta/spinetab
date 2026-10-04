import { createRuntime } from "spinetab/runtime";
import { serveSharedWorker } from "spinetab/worker";
import { adapters } from "./live.adapters";

interface HarnessCommand {
	harness?: "crash" | "hang";
	ms?: number;
}

// Test-only extensions, handled by the harness worker (never the library):
// `{ harness: "crash" }` closes this worker instance so the next construction
// gets a new one; `{ harness: "hang", ms }` busy-loops to make it
// unresponsive. The runtime counts these messages as invalid envelopes.
self.addEventListener("connect", (event) => {
	const port = (event as MessageEvent).ports[0];
	port?.addEventListener("message", (message) => {
		const data = (message as MessageEvent).data as HarnessCommand | null;
		if (data?.harness === "crash") {
			self.close();
		} else if (data?.harness === "hang") {
			const until = Date.now() + (data.ms ?? 10_000);
			while (Date.now() < until) {
				// Busy loop: the worker cannot process messages.
			}
		}
	});
});

serveSharedWorker(() => createRuntime({ adapters }));
