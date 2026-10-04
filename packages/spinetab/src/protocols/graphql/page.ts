import type { Json } from "../../core/types.ts";
import {
	assertBoolean,
	assertJson,
	assertKnownKeys,
	assertPlainObject,
	assertString,
	invalid,
	isPlainObject,
	toJson,
} from "../shared/validate.ts";
import type {
	AnyGraphqlDocument,
	GraphqlAdapterKind,
	GraphqlDocumentNode,
	GraphqlEndpoint,
	GraphqlOperation,
	GraphqlRequestOptions,
	GraphqlSubscriptionRequest,
	GraphqlSubscriptionSpec,
	ResultOf,
} from "./types.ts";

/**
 * Page-side GraphQL helpers. No `graphql` import: documents become either
 * their query text or a plain AST copy without source locations; the runtime
 * adapter parses, validates and prints them.
 */

const OPERATION_KEYS = [
	"query",
	"operationName",
	"variables",
	"extensions",
	"context",
] as const;
const REQUEST_OPTION_KEYS = ["scope", "repeatable"] as const;

export function createGraphqlEndpoint<TConnection>(
	adapter: GraphqlAdapterKind,
	connection: TConnection,
): GraphqlEndpoint<TConnection> {
	return {
		adapter,
		connection,
		subscription<const TDocument extends AnyGraphqlDocument>(
			operation: GraphqlOperation<TDocument>,
			options?: GraphqlRequestOptions,
		): GraphqlSubscriptionRequest<ResultOf<TDocument>, TConnection> {
			// `subscribe(endpoint, …)` calls this with no argument.
			if (operation === undefined) {
				throw invalid(
					"subscription",
					"needs an operation; pass endpoint.subscription({ query }), not the endpoint.",
				);
			}
			const request: GraphqlSubscriptionRequest<
				ResultOf<TDocument>,
				TConnection
			> = {
				adapter,
				connection,
				subscription: toSubscriptionSpec(operation, "subscription"),
			};
			if (options !== undefined) {
				const raw: unknown = options;
				assertPlainObject(raw, "options");
				assertKnownKeys(raw, REQUEST_OPTION_KEYS, "options");
				assertString(raw.scope, "options.scope", { optional: true });
				assertBoolean(raw.repeatable, "options.repeatable");
				if (options.scope !== undefined) request.scope = options.scope;
				if (options.repeatable !== undefined) {
					request.repeatable = options.repeatable;
				}
			}
			return request;
		},
	};
}

/** Convert an operation into its cloneable, identity-bearing wire form. */
export function toSubscriptionSpec(
	operation: unknown,
	path: string,
): GraphqlSubscriptionSpec {
	assertPlainObject(operation, path);
	assertKnownKeys(operation, OPERATION_KEYS, path);
	const spec: GraphqlSubscriptionSpec = {
		query: documentSource(operation.query, `${path}.query`),
	};
	if (operation.operationName !== undefined) {
		assertString(operation.operationName, `${path}.operationName`, {
			nonEmpty: true,
		});
		spec.operationName = operation.operationName as string;
	}
	if (operation.variables !== undefined) {
		assertPlainObject(operation.variables, `${path}.variables`);
		assertJson(operation.variables, `${path}.variables`);
		spec.variables = toJson(operation.variables) as Record<string, Json>;
	}
	if (operation.extensions !== undefined) {
		assertPlainObject(operation.extensions, `${path}.extensions`);
		assertJson(operation.extensions, `${path}.extensions`);
		spec.extensions = toJson(operation.extensions) as Record<string, Json>;
	}
	if (operation.context !== undefined) {
		assertJson(operation.context, `${path}.context`);
		spec.context = toJson(operation.context);
	}
	return spec;
}

/** Query text, a `String` document (TypedDocumentString) or a plain AST copy. */
function documentSource(
	value: unknown,
	path: string,
): string | GraphqlDocumentNode {
	if (typeof value === "string") {
		if (!value.trim()) throw invalid(path, "must not be empty.");
		return value;
	}
	if (value instanceof String) return documentSource(value.toString(), path);
	if (
		typeof value === "object" &&
		value !== null &&
		(value as { kind?: unknown }).kind === "Document" &&
		Array.isArray((value as { definitions?: unknown }).definitions)
	) {
		return stripLocations(value, path) as GraphqlDocumentNode;
	}
	throw invalid(path, "must be a query string or a GraphQL document.");
}

/**
 * Parsed documents carry `loc` objects (class instances linking the source
 * text and token list). The AST without them is plain JSON data.
 */
function stripLocations(value: unknown, path: string): unknown {
	if (Array.isArray(value)) {
		return value.map((item, index) =>
			stripLocations(item, `${path}[${index}]`),
		);
	}
	if (typeof value === "object" && value !== null) {
		const result: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) {
			if (key === "loc" || item === undefined) continue;
			result[key] = stripLocations(item, `${path}.${key}`);
		}
		return result;
	}
	if (
		typeof value === "string" ||
		typeof value === "boolean" ||
		typeof value === "number" ||
		value === null
	) {
		return value;
	}
	throw invalid(path, "document nodes must be plain data.");
}

export function isGraphqlEndpoint(value: unknown): value is GraphqlEndpoint {
	return (
		isPlainObject(value) &&
		(value.adapter === "graphql-ws" || value.adapter === "graphql-sse") &&
		typeof value.subscription === "function"
	);
}
