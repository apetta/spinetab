import { createRuntime } from "spinetab/runtime";
import { benchAdapters } from "./adapters";
import { serveRealm } from "./realm";

// Lazily imported local runtime (local mode only). It answers the bench
// channel as `local:<pageId>` so its measurements never mix with a worker's.
export default () => {
	// History opt-in for the recorder's `expiredCauses`.
	const runtime = createRuntime({
		adapters: benchAdapters(),
		diagnostics: () => undefined,
	});
	const page =
		(globalThis as { __spinetabBenchPage?: string }).__spinetabBenchPage ?? "";
	serveRealm("local", `local:${page}`, runtime);
	return runtime;
};
