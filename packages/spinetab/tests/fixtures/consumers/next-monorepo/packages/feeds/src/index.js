import { sse } from "spinetab/sse";

// The app's only `spinetab/<source>` import: the plugin must scan this
// declared workspace dependency to generate a worker with the SSE adapter.
export function ticks(path, run) {
	return sse(
		`${path}?run=${encodeURIComponent(run)}&scope=monorepo&rate=250`,
	).subscription({ event: "tick" });
}
