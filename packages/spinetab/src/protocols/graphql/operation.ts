import {
	type DocumentNode,
	GraphQLError,
	getOperationAST,
	Kind,
	parse,
	print,
} from "graphql";
import { stableStringify } from "../../core/identity.ts";
import type { Json } from "../../core/types.ts";
import {
	assertJson,
	assertKnownKeys,
	assertPlainObject,
	assertString,
	invalid,
	isPlainObject,
	toJson,
} from "../shared/validate.ts";
import type { GraphqlSubscriptionSpec } from "./types.ts";

/**
 * Runtime-side GraphQL operation handling shared by the graphql-ws and
 * graphql-sse adapters. Documents are normalised with
 * `print(parse(document))`: formatting only, no field reordering and no
 * semantic equivalence. The normalised text is both hashed and sent, so the
 * server receives exactly what was identified.
 */

export interface GraphqlPayload {
	query: string;
	operationName?: string;
	variables?: Record<string, Json>;
	extensions?: Record<string, Json>;
}

export interface NormalisedOperation {
	payload: GraphqlPayload;
	/** Canonical identity: document, operation name, variables, extensions, context. */
	key: string;
	context?: Json;
}

const SPEC_KEYS = [
	"query",
	"operationName",
	"variables",
	"extensions",
	"context",
] as const;
const CACHE_LIMIT = 256;
const documents = new Map<string, DocumentNode>();

export function validateGraphqlSubscription(
	spec: unknown,
	path = "subscription",
): asserts spec is GraphqlSubscriptionSpec {
	normaliseOperation(spec, path);
}

export function normaliseOperation(
	spec: unknown,
	path = "subscription",
	options: { omitExtensions?: readonly string[] } = {},
): NormalisedOperation {
	assertPlainObject(spec, path);
	assertKnownKeys(spec, SPEC_KEYS, path);
	if (spec.operationName !== undefined) {
		assertString(spec.operationName, `${path}.operationName`, {
			nonEmpty: true,
		});
	}
	for (const key of ["variables", "extensions"] as const) {
		if (spec[key] !== undefined) {
			assertPlainObject(spec[key], `${path}.${key}`);
			assertJson(spec[key], `${path}.${key}`);
		}
	}
	if (spec.context !== undefined) assertJson(spec.context, `${path}.context`);

	const document = parseDocument(spec.query, `${path}.query`);
	const operationName = spec.operationName as string | undefined;
	const operation = getOperationAST(document, operationName);
	if (!operation) {
		throw invalid(
			`${path}.operationName`,
			operationName === undefined
				? "the document has several operations; name the subscription with operationName."
				: "does not name an operation in the document.",
		);
	}
	if (operation.operation !== "subscription") {
		// Queries and mutations stay with Apollo or HTTP clients; they
		// are never shared or re-executed by the runtime.
		throw invalid(
			`${path}.query`,
			`only subscription operations are shared; received a ${operation.operation}.`,
		);
	}

	const payload: GraphqlPayload = { query: print(document) };
	if (operationName !== undefined) payload.operationName = operationName;
	if (spec.variables !== undefined) {
		payload.variables = toJson(spec.variables) as Record<string, Json>;
	}
	if (spec.extensions !== undefined) {
		const extensions = toJson(spec.extensions) as Record<string, Json>;
		for (const omitted of options.omitExtensions ?? []) {
			delete extensions[omitted];
		}
		if (Object.keys(extensions).length > 0) payload.extensions = extensions;
	}
	const context =
		spec.context === undefined ? undefined : (toJson(spec.context) as Json);
	const key = stableStringify({
		query: payload.query,
		operationName: payload.operationName ?? null,
		variables: payload.variables ?? null,
		extensions: payload.extensions ?? null,
		context: context ?? null,
	});
	return context === undefined ? { payload, key } : { payload, key, context };
}

function parseDocument(query: unknown, path: string): DocumentNode {
	if (typeof query === "string") {
		const cached = documents.get(query);
		if (cached) return cached;
		const document = parseText(query, path);
		documents.set(query, document);
		if (documents.size > CACHE_LIMIT) {
			const oldest = documents.keys().next().value;
			if (oldest !== undefined) documents.delete(oldest);
		}
		return document;
	}
	if (
		isPlainObject(query) &&
		query.kind === Kind.DOCUMENT &&
		Array.isArray(query.definitions)
	) {
		let text: string;
		try {
			text = print(query as unknown as DocumentNode);
		} catch {
			throw invalid(path, "is not a valid GraphQL document AST.");
		}
		return parseDocument(text, path);
	}
	throw invalid(path, "must be a query string or a plain GraphQL document.");
}

function parseText(query: string, path: string): DocumentNode {
	try {
		return parse(query);
	} catch (error) {
		const detail = error instanceof GraphQLError ? `: ${error.message}` : "";
		throw invalid(path, `is not a valid GraphQL document${detail}`);
	}
}

/** GraphQL error arrays are plain `GraphQLFormattedError` data. */
export function isFormattedErrors(value: unknown): value is Json[] {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.every(
			(item) =>
				isPlainObject(item) &&
				typeof (item as { message?: unknown }).message === "string",
		)
	);
}
