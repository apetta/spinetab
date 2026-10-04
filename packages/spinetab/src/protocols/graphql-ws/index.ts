import { createGraphqlEndpoint } from "../graphql/page.ts";
import type { GraphqlEndpoint } from "../graphql/types.ts";
import { toJson, withUrl } from "../shared/validate.ts";
import {
	type GraphqlWsConnection,
	validateGraphqlWsConnection,
} from "./spec.ts";

export type {
	AnyGraphqlDocument,
	DocumentTypeDecoration,
	GraphqlDocument,
	GraphqlEndpoint,
	GraphqlFormattedError,
	GraphqlOperation,
	GraphqlRequestOptions,
	GraphqlResult,
	GraphqlSubscriptionRequest,
	GraphqlSubscriptionSpec,
	ResultOf,
	VariablesOf,
} from "../graphql/types.ts";
export type { GraphqlWsConnection } from "./spec.ts";

/**
 * GraphQL over WebSocket (`graphql-transport-ws`) endpoint. Page-only: builds
 * cloneable requests; the worker hosts the real `graphql-ws` client through
 * `graphqlWsAdapter()` from `spinetab/graphql-ws/runtime`.
 *
 * ```ts
 * const feed = graphqlWs("/graphql");
 * client.subscribe(feed.subscription({ query: OnMessage, variables: { room } }), observer);
 * ```
 *
 * `graphqlWs(url, options)` and `graphqlWs({ url,...options })` give the same
 * connection.
 */
export function graphqlWs(
	url: string,
	options?: Omit<GraphqlWsConnection, "url">,
): GraphqlEndpoint<GraphqlWsConnection>;
/** Options form of `graphqlWs(url, options)`; both give the same connection. */
export function graphqlWs(
	options: GraphqlWsConnection,
): GraphqlEndpoint<GraphqlWsConnection>;
export function graphqlWs(
	input: string | GraphqlWsConnection,
	options?: Omit<GraphqlWsConnection, "url">,
): GraphqlEndpoint<GraphqlWsConnection> {
	const connection = withUrl(input, options);
	validateGraphqlWsConnection(connection, { absolute: false }, "graphqlWs");
	return createGraphqlEndpoint("graphql-ws", toJson(connection));
}
