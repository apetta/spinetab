import { pollingAdapter } from "spinetab/polling/runtime";
import type { AnyRuntimeAdapter } from "spinetab/runtime";

export function adapters(): AnyRuntimeAdapter[] {
	return [pollingAdapter()];
}
