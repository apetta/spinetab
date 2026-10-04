import type { DocumentNode } from "graphql";
import { graphqlWs } from "spinetab/graphql-ws";

/**
 * `TypedDocumentNode` as published by `@graphql-typed-document-node/core`
 * (what GraphQL Code Generator emits). Declared here because that package is
 * not a Spinetab peer: Spinetab matches typed documents structurally.
 */
export interface TypedDocumentNode<TResult, TVariables> extends DocumentNode {
	__apiType?: (variables: TVariables) => TResult;
}

export interface TicksData {
	ticks: { n: number; tag: string | null };
}

export declare const TicksDocument: TypedDocumentNode<
	TicksData,
	{ intervalMs?: number | null }
>;
export declare const RoomDocument: TypedDocumentNode<
	{ room: { id: string } },
	{ room: string }
>;

export const endpoint = graphqlWs({ url: "fx/graphql-ws", anonymous: true });
export const ticks = endpoint.subscription({
	query: TicksDocument,
	variables: { intervalMs: 200 },
});
