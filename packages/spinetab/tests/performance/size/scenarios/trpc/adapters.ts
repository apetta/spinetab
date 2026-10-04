import type { AnyRuntimeAdapter } from "spinetab/runtime";
import { trpcWsAdapter } from "spinetab/trpc/runtime";

export function adapters(): AnyRuntimeAdapter[] {
	return [trpcWsAdapter()];
}
