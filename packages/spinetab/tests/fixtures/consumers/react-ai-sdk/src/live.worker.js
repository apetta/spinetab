import { aiSdkAdapter } from "spinetab/ai-sdk/runtime";
import { defineWorker } from "spinetab/worker";

// One worker file: evaluated as the SharedWorker it serves, and
// imported lazily as the local runtime when the page cannot share. No plugin:
// the escape-hatch proof on Vite, webpack and Rspack.
export default defineWorker(() => [aiSdkAdapter()]);
