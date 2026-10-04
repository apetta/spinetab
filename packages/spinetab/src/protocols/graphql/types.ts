import type { Json, SubscriptionRequest } from "../../core/types.ts";

/**
 * Page-side GraphQL subscription contract shared by `spinetab/graphql-ws`,
 * `spinetab/graphql-sse` and `spinetab/apollo`. Type-only and free of peer
 * imports: typed documents are matched structurally, so documents from
 * `@graphql-typed-document-node/core`, GraphQL Code Generator (including
 * `TypedDocumentString`) and Apollo infer `data` and `variables`.
 */

/** Structural `DocumentTypeDecoration` from `@graphql-typed-document-node/core`. */
export interface DocumentTypeDecoration<TResult, TVariables> {
	__apiType?: (variables: TVariables) => TResult;
}

/** Structural `DocumentNode`; `loc` and other source details are dropped. */
export interface GraphqlDocumentNode {
	readonly kind: string;
	readonly definitions: readonly unknown[];
}

/**
 * Any accepted document. Variables are `never` in the constraint because
 * `__apiType` is checked contravariantly: every typed document is assignable.
 */
export type AnyGraphqlDocument = GraphqlDocument<unknown, never>;

/** A query string, a typed string document or a parsed/typed document node. */
export type GraphqlDocument<TData = unknown, TVariables = unknown> =
	| string
	| (DocumentTypeDecoration<TData, TVariables> &
			(GraphqlDocumentNode | { toString(): string }));

export type GraphqlVariables = Record<string, unknown>;

type Untyped<T, Fallback> = unknown extends T ? Fallback : T;

/** Result `data` inferred from a typed document; untyped → `Record<string, unknown>`. */
export type ResultOf<TDocument> =
	TDocument extends DocumentTypeDecoration<infer TResult, infer _TVariables>
		? Untyped<TResult, Record<string, unknown>>
		: Record<string, unknown>;

/** Variables inferred from a typed document; untyped → `Record<string, unknown>`. */
export type VariablesOf<TDocument> =
	TDocument extends DocumentTypeDecoration<infer _TResult, infer TVariables>
		? Untyped<TVariables, GraphqlVariables>
		: GraphqlVariables;

/** Required when the operation declares required variables. */
export type VariablesField<TVariables> =
	Record<string, never> extends TVariables
		? { variables?: TVariables }
		: { variables: TVariables };

export interface GraphqlFormattedError {
	readonly message: string;
	readonly locations?: ReadonlyArray<{ line: number; column: number }>;
	readonly path?: ReadonlyArray<string | number>;
	readonly extensions?: Record<string, unknown>;
}

/** One upstream result, delivered unchanged (`FormattedExecutionResult`). */
export interface GraphqlResult<
	TData = Record<string, unknown>,
	TExtensions = Record<string, unknown>,
> {
	data?: TData | null;
	errors?: readonly GraphqlFormattedError[];
	extensions?: TExtensions;
	hasNext?: boolean;
}

/** Operation passed to an endpoint's `subscription()`. */
export type GraphqlOperation<TDocument extends AnyGraphqlDocument> = {
	query: TDocument;
	operationName?: string;
	/** Sent to the server and part of identity. */
	extensions?: Record<string, Json>;
	/**
	 * Response-affecting, credential-free context declared by the
	 * application (for example Apollo's `context.spinetab`). Enters
	 * identity so requests with different context never share.
	 */
	context?: Json;
} & VariablesField<NoInfer<VariablesOf<TDocument>>>;

/** Wire form of an operation; crosses the bridge and is identity-bearing. */
export interface GraphqlSubscriptionSpec {
	/** Query text or a plain document AST (source locations removed). */
	query: string | GraphqlDocumentNode;
	operationName?: string;
	variables?: Record<string, Json>;
	extensions?: Record<string, Json>;
	context?: Json;
}

export interface GraphqlRequestOptions {
	/** Auth scope; defaults to the client's scope. */
	scope?: string;
	/** Default `true`: GraphQL subscriptions are declared repeatable intent. */
	repeatable?: boolean;
}

export type GraphqlAdapterKind = "graphql-ws" | "graphql-sse";

export type GraphqlSubscriptionRequest<TData, TConnection> =
	SubscriptionRequest<
		GraphqlResult<TData>,
		TConnection,
		GraphqlSubscriptionSpec
	>;

/** What `graphqlWs()` and `graphqlSse()` return; also accepted by `SpinetabLink`. */
export interface GraphqlEndpoint<TConnection = unknown> {
	readonly adapter: GraphqlAdapterKind;
	readonly connection: TConnection;
	subscription<const TDocument extends AnyGraphqlDocument>(
		operation: GraphqlOperation<TDocument>,
		options?: GraphqlRequestOptions,
	): GraphqlSubscriptionRequest<ResultOf<TDocument>, TConnection>;
}
