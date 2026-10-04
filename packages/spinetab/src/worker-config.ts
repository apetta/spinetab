// `spinetab/worker-config` (runtime realm stub): reached only when a plugin
// redirected `spinetab/wiring` without supplying the worker module. It fails
// when called, never at import, so `sideEffects: false` stays truthful.
import type { RuntimeHandle } from "./core/types.ts";

export default function workerConfigMissing(): RuntimeHandle {
	throw new Error(
		"spinetab: the bundler plugin redirected the wiring but supplied no worker module.",
	);
}
