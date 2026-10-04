import { sseAdapter } from "spinetab/sse/runtime";
import { defineWorker } from "spinetab/worker";

// The L2 variant's worker file, named through the plugin's `worker` option; the default build ignores it and generates the worker.
export default defineWorker(() => [sseAdapter()]);
