import { createTRPCClient } from "@trpc/client";
import superjson from "superjson";
import { describe, expect, it } from "vitest";
import { isSpinetabError } from "../../../src/core/errors.ts";
import {
	spinetabSseLink,
	spinetabWsLink,
} from "../../../src/integrations/trpc/index.ts";
import {
	trpcSseAdapter,
	trpcWsAdapter,
} from "../../../src/integrations/trpc/runtime.ts";
import type { FixtureTrpcRouter } from "../../fixtures/servers/trpc.ts";
import { createFakeClient } from "./fakes.ts";

// the page-side `transformer: true` marker and the worker
// adapter's refusal when it was constructed without a transformer.

/** The fixed sentence, written out here so a reworded source fails the test. */
const SENTENCE =
	"This tRPC router uses a transformer; construct trpcWsAdapter({ transformer }) or trpcSseAdapter({ transformer }) in your worker file.";

const WS = { url: "wss://api.example.com/trpc-ws" };
const SSE = { url: "https://api.example.com/trpc" };

function caught(run: () => unknown): unknown {
	try {
		run();
	} catch (error) {
		return error;
	}
	return undefined;
}

type LinkName = "ws" | "sse";

function sentConnection(
	kind: LinkName,
	transformer: unknown,
): Record<string, unknown> {
	const { client, calls } = createFakeClient();
	const options = {
		client,
		url: kind === "ws" ? "/trpc-ws" : "/trpc",
		...(transformer === undefined ? {} : { transformer }),
	} as never;
	const link =
		kind === "ws"
			? spinetabWsLink<FixtureTrpcRouter>(options)
			: spinetabSseLink<FixtureTrpcRouter>(options);
	const trpc = createTRPCClient<FixtureTrpcRouter>({ links: [link] });
	trpc.ticks.subscribe({ tag: "a" }, {});
	const request = calls[0]?.request;
	expect(request?.adapter).toBe(kind === "ws" ? "trpc-ws" : "trpc-sse");
	return request?.connection as Record<string, unknown>;
}

describe("page links: the transformer marker", () => {
	for (const kind of ["ws", "sse"] as const) {
		it(`${kind}: transformer: true reaches the request as plain JSON`, () => {
			const connection = sentConnection(kind, true);
			expect(connection.transformer).toBe(true);
			// It must survive the bridge's structured clone unchanged.
			expect(structuredClone(connection)).toEqual(connection);
		});

		it(`${kind}: transformer: false sends the same request as omitting it`, () => {
			const omitted = sentConnection(kind, undefined);
			const off = sentConnection(kind, false);
			expect(omitted).not.toHaveProperty("transformer");
			expect(off).toEqual(omitted);
		});

		it(`${kind}: refuses the transformer itself, or any non-boolean`, () => {
			const { client } = createFakeClient();
			const build = kind === "ws" ? spinetabWsLink : spinetabSseLink;
			for (const value of [superjson, "superjson", 1, null]) {
				const error = caught(() =>
					build({ client, url: "/t", transformer: value as never }),
				);
				expect(isSpinetabError(error) && error.code, String(value)).toBe(
					"unsupported-option",
				);
				expect((error as Error).message).toBe(
					"options.transformer: must be true or false; pass the transformer itself to trpcWsAdapter({ transformer }) or trpcSseAdapter({ transformer }) in your worker file.",
				);
				expect(
					isSpinetabError(error) &&
						(error.detail as { path?: string } | undefined)?.path,
				).toBe("options.transformer");
			}
		});
	}
});

describe("worker adapters without a transformer", () => {
	const adapters = [
		["trpcWsAdapter", trpcWsAdapter(), WS],
		["trpcSseAdapter", trpcSseAdapter(), SSE],
	] as const;

	for (const [name, adapter, base] of adapters) {
		it(`${name}() refuses a marked request with the fixed sentence`, () => {
			const error = caught(() =>
				adapter.validateConnection?.({ ...base, transformer: true }),
			);
			expect(isSpinetabError(error)).toBe(true);
			if (!isSpinetabError(error)) return;
			expect(error.code).toBe("unsupported-option");
			expect(error.message).toBe(SENTENCE);
			expect(error.detail).toEqual({ path: "connection.transformer" });
		});

		it(`${name}() accepts unmarked requests as before`, () => {
			expect(() => adapter.validateConnection?.({ ...base })).not.toThrow();
			// `false` is not the marker; only the page link drops it.
			expect(() =>
				adapter.validateConnection?.({ ...base, transformer: false }),
			).not.toThrow();
		});

		it(`${name}() still refuses a non-boolean marker as an invalid option`, () => {
			const error = caught(() =>
				adapter.validateConnection?.({ ...base, transformer: "yes" }),
			);
			expect(isSpinetabError(error) && error.code).toBe("unsupported-option");
			expect((error as Error).message).toBe(
				"connection.transformer: must be a boolean.",
			);
		});
	}
});

describe("worker adapters with a transformer", () => {
	const adapters = [
		["trpcWsAdapter", trpcWsAdapter({ transformer: superjson }), WS],
		["trpcSseAdapter", trpcSseAdapter({ transformer: superjson }), SSE],
		[
			"trpcWsAdapter (input/output)",
			trpcWsAdapter({ transformer: { input: superjson, output: superjson } }),
			WS,
		],
	] as const;

	for (const [name, adapter, base] of adapters) {
		it(`${name} accepts marked and unmarked requests`, () => {
			expect(() =>
				adapter.validateConnection?.({ ...base, transformer: true }),
			).not.toThrow();
			expect(() => adapter.validateConnection?.({ ...base })).not.toThrow();
		});

		it(`${name}: the marker is not part of connection identity`, () => {
			// Marked and unmarked consumers of one endpoint share one upstream.
			expect(adapter.connectionKey?.({ ...base, transformer: true })).toBe(
				adapter.connectionKey?.({ ...base }),
			);
		});
	}
});
