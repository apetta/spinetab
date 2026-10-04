import { aiSdkAdapter } from "spinetab/ai-sdk/runtime";
import { defineWorker } from "spinetab/worker";

// Use the same module as the SharedWorker entry and the lazily imported local runtime.
export default defineWorker(() => [aiSdkAdapter()]);
