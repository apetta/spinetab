import { createGraphqlEndpoint } from "../graphql/page.ts";
import type { GraphqlEndpoint } from "../graphql/types.ts";
import { toJson, withUrl } from "../shared/validate.ts";
import {
	type GraphqlSseConnection,
	validateGraphqlSseConnection,
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
export type { GraphqlSseConnection } from "./spec.ts";

/**
 * GraphQL over Server-Sent Events endpoint. Page-only: builds cloneable
 * requests; the worker hosts the real `graphql-sse` client through
 * `graphqlSseAdapter()` from `spinetab/graphql-sse/runtime`.
 *
 * ```ts
 * const feed = graphqlSse("/graphql/stream"); // mode "distinct" by default
 * client.subscribe(feed.subscription({ query: OnPrice, variables: { symbol } }), observer);
 * ```
 *
 * `graphqlSse(url, options)` and `graphqlSse({ url,...options })` give the
 * same connection, and an omitted `mode` is `"distinct"` in it.
 */
export function graphqlSse(
	url: string,
	options?: Omit<GraphqlSseConnection, "url">,
): GraphqlEndpoint<GraphqlSseConnection>;
/** Options form of `graphqlSse(url, options)`; both give the same connection. */
export function graphqlSse(
	options: GraphqlSseConnection,
): GraphqlEndpoint<GraphqlSseConnection>;
export function graphqlSse(
	input: string | GraphqlSseConnection,
	options?: Omit<GraphqlSseConnection, "url">,
): GraphqlEndpoint<GraphqlSseConnection> {
	const connection = withUrl(input, options);
	validateGraphqlSseConnection(connection, { absolute: false }, "graphqlSse");
	const canonical = toJson(connection);
	canonical.mode ??= "distinct";
	return createGraphqlEndpoint("graphql-sse", canonical);
}
