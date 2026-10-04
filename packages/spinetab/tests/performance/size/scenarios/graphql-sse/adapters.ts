import { graphqlSseAdapter } from "spinetab/graphql-sse/runtime";
import type { AnyRuntimeAdapter } from "spinetab/runtime";

export function adapters(): AnyRuntimeAdapter[] {
	return [graphqlSseAdapter()];
}
