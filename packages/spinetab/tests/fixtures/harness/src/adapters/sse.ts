/**
 * SSE part of the harness worker.
 *
 * Wiring (core-owned harness files):
 * live.worker.ts: import * as sseRuntime from "spinetab/sse/runtime";
 * import { sseAdapter } from "./adapters/sse.ts";
 * createRuntime({ adapters: [..., sseAdapter(sseRuntime)] })
 * Pages use `{ adapter: "sse", connection: { url, mode,... }, subscription:
 * { event } }` against `/sse/ticks` (plain data; `sse()` builds the same).
 *
 * Decoders: built-in `text` and `json`, plus `ticks` (the fixture's tick
 * payload reduced to its sequence number). Resume URL hook `path` places the
 * cursor in a `cursor` query parameter, as an application-specific
 * alternative to `resume: { query }`.
 */
export interface SseRuntimeModule<A> {
	sseAdapter(options: {
		decoders: Record<string, (data: string) => unknown>;
		resumeUrls: Record<string, (url: URL, cursor: string) => string | URL>;
	}): A;
}

export function sseAdapter<A>(runtime: SseRuntimeModule<A>): A {
	return runtime.sseAdapter({
		decoders: {
			ticks: (data) => (JSON.parse(data) as { n: number }).n,
		},
		resumeUrls: {
			path: (url, cursor) => {
				const next = new URL(url);
				next.searchParams.set("cursor", cursor);
				return next;
			},
		},
	});
}
