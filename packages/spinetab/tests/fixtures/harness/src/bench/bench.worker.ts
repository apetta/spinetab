// Instrumentation first: every later timer and listener in this realm is counted.
import "./instrument";
import { createRuntime } from "spinetab/runtime";
import { serveSharedWorker } from "spinetab/worker";
import { benchAdapters } from "./adapters";
import { serveRealm } from "./realm";

// Spinetab bench SharedWorker: the timed bench adapters
// with package default limits and timings, plus the bench channel responder.
// Test instrumentation: a runtime retains diagnostic history
// only with a configured sink, and the performance recorder reads that history
// for `expiredCauses`. Not a production default.
const runtime = createRuntime({
	adapters: benchAdapters(),
	diagnostics: () => undefined,
});
serveRealm("worker", "worker", runtime);
serveSharedWorker(runtime);
