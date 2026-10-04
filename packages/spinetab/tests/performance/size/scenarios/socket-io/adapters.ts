import type { AnyRuntimeAdapter } from "spinetab/runtime";
import { socketIoAdapter } from "spinetab/socket-io/runtime";

export function adapters(): AnyRuntimeAdapter[] {
	return [socketIoAdapter()];
}
