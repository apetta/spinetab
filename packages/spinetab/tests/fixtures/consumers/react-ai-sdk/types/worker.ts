import { aiSdkAdapter } from "spinetab/ai-sdk/runtime";
import { createRuntime } from "spinetab/runtime";
import { serveSharedWorker } from "spinetab/worker";

// Worker realm declarations: `WebWorker` lib only, no DOM.
serveSharedWorker(() => createRuntime({ adapters: [aiSdkAdapter()] }));
