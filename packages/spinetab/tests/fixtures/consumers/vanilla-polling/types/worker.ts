import { pollingAdapter } from "spinetab/polling/runtime";
import { defineWorker } from "spinetab/worker";

// The one worker file. Checked twice: here with the `WebWorker` lib
// only (tsconfig.worker.json), and as the page's lazy `local` import with the
// DOM lib (tsconfig.bundler.json), so its declarations need neither.
export default defineWorker(() => [pollingAdapter()], {
	limits: { maxSubscriptions: 64 },
	setupTimeoutMs: 5_000,
});
