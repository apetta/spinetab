import { graphqlWsAdapter } from "spinetab/graphql-ws/runtime";
import type { AnyRuntimeAdapter } from "spinetab/runtime";

export function adapters(): AnyRuntimeAdapter[] {
	return [graphqlWsAdapter()];
}
