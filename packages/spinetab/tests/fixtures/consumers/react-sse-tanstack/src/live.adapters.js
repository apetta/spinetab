import { sseAdapter } from "spinetab/sse/runtime";
import { ndjsonParser, streamAdapter } from "spinetab/stream/runtime";
import { DEPLOYMENT } from "./deployment.js";

// Runtime adapters for the SharedWorker and the lazy local runtime: two
// adapters sharing Spinetab's HTTP stream core.
export function adapters() {
	return [
		sseAdapter({ decoders: { deployment: () => DEPLOYMENT } }),
		streamAdapter({ parsers: { ndjson: ndjsonParser() } }),
	];
}
