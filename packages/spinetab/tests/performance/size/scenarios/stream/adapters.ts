import type { AnyRuntimeAdapter } from "spinetab/runtime";
import { ndjsonParser, streamAdapter } from "spinetab/stream/runtime";

export function adapters(): AnyRuntimeAdapter[] {
	return [streamAdapter({ parsers: { ndjson: ndjsonParser() } })];
}
