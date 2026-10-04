import { graphqlWsAdapter } from "spinetab/graphql-ws/runtime";
import type { AnyRuntimeAdapter } from "spinetab/runtime";
import { websocketAdapter } from "spinetab/websocket/runtime";
import { benchProtocol } from "./protocol";
import { timed } from "./timed";

/**
 * Bench runtime adapters with package defaults (no shortened backoff or
 * heartbeat): graphql-ws for the GraphQL variant, and the native WebSocket
 * adapter with the bench protocol (`bench`, and `bench-auth` for the privacy
 * scan). Each is wrapped by `timed()` for receipt and probe timestamps.
 */
export function benchAdapters(): AnyRuntimeAdapter[] {
	return [
		timed(
			websocketAdapter({
				protocols: {
					bench: benchProtocol(),
					"bench-auth": benchProtocol({ auth: true }),
				},
			}),
		),
		timed(graphqlWsAdapter()),
	];
}
