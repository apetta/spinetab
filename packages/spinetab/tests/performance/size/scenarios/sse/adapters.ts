import type { AnyRuntimeAdapter } from "spinetab/runtime";
import { sseAdapter } from "spinetab/sse/runtime";

export function adapters(): AnyRuntimeAdapter[] {
	return [sseAdapter()];
}
