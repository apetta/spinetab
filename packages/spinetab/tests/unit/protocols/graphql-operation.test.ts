import type { TypedDocumentNode } from "@apollo/client";
import { parse } from "graphql";
import { describe, expect, expectTypeOf, it } from "vitest";
import { normaliseOperation } from "../../../src/protocols/graphql/operation.ts";
import type {
	DocumentTypeDecoration,
	GraphqlResult,
} from "../../../src/protocols/graphql/types.ts";
import { graphqlSse } from "../../../src/protocols/graphql-sse/index.ts";
import { graphqlWs } from "../../../src/protocols/graphql-ws/index.ts";

// P-U-01, P-U-02:.

const SUB = "subscription OnTick($room: String!) { ticks(room: $room) { n } }";

describe("canonical GraphQL operation identity", () => {
	it("normalises formatting only, with print(parse()) sent and hashed", () => {
		const compact = normaliseOperation({
			query: SUB,
			variables: { room: "a" },
		});
		const spaced = normaliseOperation({
			query: `\n  subscription   OnTick($room: String!)   {\n ticks( room : $room ) { n } }  # comment\n`,
			variables: { room: "a" },
		});
		expect(spaced.key).toBe(compact.key);
		expect(spaced.payload.query).toBe(compact.payload.query);
		expect(compact.payload.query).toContain("subscription OnTick");
	});

	it("never reorders fields or merges semantically equal documents", () => {
		const ab = normaliseOperation({ query: "subscription { a b }" });
		const ba = normaliseOperation({ query: "subscription { b a }" });
		expect(ab.key).not.toBe(ba.key);
	});

	it("canonicalises variables: key order ignored, undefined dropped, null distinct", () => {
		const one = normaliseOperation({
			query: SUB,
			variables: { room: "a", x: 1 },
		});
		const two = normaliseOperation({
			query: SUB,
			variables: { x: 1, room: "a", y: undefined },
		});
		const nulled = normaliseOperation({
			query: SUB,
			variables: { room: "a", x: 1, y: null },
		});
		expect(two.key).toBe(one.key);
		expect(nulled.key).not.toBe(one.key);
		expect(two.payload.variables).toEqual({ room: "a", x: 1 });
	});

	it("separates operation name, extensions and declared context", () => {
		const base = normaliseOperation({ query: SUB });
		expect(
			normaliseOperation({ query: SUB, extensions: { trace: 1 } }).key,
		).not.toBe(base.key);
		expect(
			normaliseOperation({ query: SUB, operationName: "OnTick" }).key,
		).not.toBe(base.key);
		const withContext = normaliseOperation({
			query: SUB,
			context: { locale: "fr" },
		});
		expect(withContext.key).not.toBe(base.key);
		// Context separates identities but is not sent upstream by default.
		expect(withContext.payload).toEqual(base.payload);
	});

	it("excludes a caller-supplied extensions.operationId when asked (graphql-sse single mode)", () => {
		const plain = normaliseOperation({ query: SUB }, "s", {
			omitExtensions: ["operationId"],
		});
		const withId = normaliseOperation(
			{ query: SUB, extensions: { operationId: "x" } },
			"s",
			{ omitExtensions: ["operationId"] },
		);
		expect(withId.key).toBe(plain.key);
		expect(withId.payload.extensions).toBeUndefined();
	});

	it("accepts plain document ASTs (loc removed on the page) and matches the text form", () => {
		const request = graphqlWs({ url: "/graphql" }).subscription({
			query: parse(SUB),
		});
		expect(JSON.stringify(request.subscription)).not.toContain('"loc"');
		expect(structuredClone(request.subscription)).toEqual(request.subscription);
		const fromAst = normaliseOperation(request.subscription);
		expect(fromAst.key).toBe(normaliseOperation({ query: SUB }).key);
	});
});

describe("operation validation", () => {
	const code = { code: "unsupported-option" };

	it("rejects queries and mutations: only subscriptions are shared", () => {
		expect(() => normaliseOperation({ query: "query { a }" })).toThrowError(
			expect.objectContaining({
				...code,
				detail: { path: "subscription.query" },
			}),
		);
		expect(() => normaliseOperation({ query: "mutation { a }" })).toThrowError(
			expect.objectContaining(code),
		);
	});

	it("selects the operation by operationName in multi-operation documents", () => {
		const doc = "query Q { a } subscription S { b }";
		expect(() => normaliseOperation({ query: doc })).toThrowError(
			expect.objectContaining({
				detail: { path: "subscription.operationName" },
			}),
		);
		expect(
			normaliseOperation({ query: doc, operationName: "S" }).payload
				.operationName,
		).toBe("S");
		expect(() =>
			normaliseOperation({ query: doc, operationName: "Q" }),
		).toThrowError(expect.objectContaining(code));
	});

	it("rejects non-JSON variables whose wire form differs from their identity", () => {
		for (const value of [new Date(), 10n, Number.NaN, new Map(), () => 1]) {
			expect(() =>
				normaliseOperation({ query: SUB, variables: { v: value } }),
			).toThrowError(expect.objectContaining(code));
		}
	});

	it("rejects invalid documents and unknown keys", () => {
		expect(() => normaliseOperation({ query: "subscription {" })).toThrowError(
			expect.objectContaining(code),
		);
		expect(() => normaliseOperation({ query: SUB, headers: {} })).toThrowError(
			expect.objectContaining({ detail: { path: "subscription.headers" } }),
		);
	});
});

describe("typed documents infer data and variables", () => {
	type Data = { ticks: { n: number } };
	type Vars = { room: string; limit?: number };
	const endpoint = graphqlWs({ url: "/graphql" });

	it("infers from TypedDocumentNode and requires required variables", () => {
		const doc = parse(SUB) as TypedDocumentNode<Data, Vars>;
		const request = endpoint.subscription({
			query: doc,
			variables: { room: "a" },
		});
		expectTypeOf(request.__event).toEqualTypeOf<
			GraphqlResult<Data> | undefined
		>();
		// @ts-expect-error: `room` is required
		endpoint.subscription({ query: doc, variables: {} });
		// @ts-expect-error: variables are required when the operation declares required ones
		endpoint.subscription({ query: doc });
		// @ts-expect-error: wrong variable type
		endpoint.subscription({ query: doc, variables: { room: 1 } });
	});

	it("infers from typed string documents (TypedDocumentString)", () => {
		const doc = SUB as string & DocumentTypeDecoration<Data, { room?: string }>;
		const request = graphqlSse({ url: "/g", mode: "distinct" }).subscription({
			query: doc,
		});
		expectTypeOf(request.__event).toEqualTypeOf<
			GraphqlResult<Data> | undefined
		>();
	});

	it("falls back to Record<string, unknown>, never any, for untyped documents", () => {
		const request = endpoint.subscription({ query: SUB });
		type Event = NonNullable<typeof request.__event>;
		expectTypeOf<Event["data"]>().toEqualTypeOf<
			Record<string, unknown> | null | undefined
		>();
		expectTypeOf<Event["data"]>().not.toBeAny();
		const fromAst = endpoint.subscription({ query: parse(SUB) });
		expectTypeOf<NonNullable<typeof fromAst.__event>["data"]>().not.toBeAny();
	});
});
