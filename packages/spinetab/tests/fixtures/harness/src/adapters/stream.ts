/**
 * Fetch stream part of the harness worker.
 *
 * Wiring (core-owned harness files):
 * live.worker.ts: import * as streamRuntime from "spinetab/stream/runtime";
 * import { streamAdapter } from "./adapters/stream.ts";
 * createRuntime({ adapters: [..., streamAdapter(streamRuntime)] })
 * Pages use `{ adapter: "stream", connection: { url, parser: "ndjson",... },
 * subscription: {}, repeatable }` against `/stream/ndjson` (plain data;
 * `stream()` builds the same).
 *
 * Parsers: `ndjson` (the shipped recipe), `ndjson-heartbeat` (recipe with
 * `{"type":"heartbeat"}` lines classified as heartbeats) and `lines`.
 */
type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };

export interface StreamRuntimeModule<A, P> {
	streamAdapter(options: { parsers: Record<string, P> }): A;
	ndjsonParser(options?: { heartbeat?: (value: JsonValue) => boolean }): P;
	lineFramer(): P;
}

export function streamAdapter<A, P>(runtime: StreamRuntimeModule<A, P>): A {
	return runtime.streamAdapter({
		parsers: {
			ndjson: runtime.ndjsonParser(),
			"ndjson-heartbeat": runtime.ndjsonParser({
				heartbeat: (value) =>
					typeof value === "object" &&
					value !== null &&
					!Array.isArray(value) &&
					value.type === "heartbeat",
			}),
			lines: runtime.lineFramer(),
		},
	});
}
