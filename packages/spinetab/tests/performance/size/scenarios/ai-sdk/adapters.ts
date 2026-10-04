import { aiSdkAdapter } from "spinetab/ai-sdk/runtime";
import type { AnyRuntimeAdapter } from "spinetab/runtime";

export function adapters(): AnyRuntimeAdapter[] {
	return [aiSdkAdapter()];
}
