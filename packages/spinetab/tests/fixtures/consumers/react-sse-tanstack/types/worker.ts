import { createRuntime } from "spinetab/runtime";
import { sseAdapter } from "spinetab/sse/runtime";
import { ndjsonParser, streamAdapter } from "spinetab/stream/runtime";
import { serveSharedWorker } from "spinetab/worker";

// Worker realm declarations: `WebWorker` lib only, no DOM. The
// three-file recipe stays the escape hatch (`serveSharedWorker`).
serveSharedWorker(() =>
	createRuntime({
		adapters: [
			sseAdapter({ decoders: { tick: (data) => JSON.parse(data) } }),
			streamAdapter({ parsers: { ndjson: ndjsonParser() } }),
		],
	}),
);
