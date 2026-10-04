import { afterEach, describe, expect, it, vi } from "vitest";
import { warnUnowned } from "../../../src/bindings/shared/dev.ts";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

describe("runtime gate edge cases", () => {
	it("a process global without env does not throw and stays silent", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const scope = globalThis as { process?: unknown };
		const original = scope.process;
		try {
			scope.process = {};
			expect(() => warnUnowned("useSubscription", "vue")).not.toThrow();
		} finally {
			scope.process = original;
		}
		expect(warn).not.toHaveBeenCalled();
	});

	it("an unset NODE_ENV warns (development by default) with the exact wording", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.stubEnv("NODE_ENV", undefined as unknown as string);
		warnUnowned("useSpinetabStatus", "vue");
		warnUnowned("createSpinetabStatus", "solid");
		expect(warn.mock.calls).toEqual([
			[
				"[spinetab] useSpinetabStatus was called without an active effect scope; call dispose() yourself.",
			],
			[
				"[spinetab] createSpinetabStatus was called outside a reactive owner; call dispose() yourself.",
			],
		]);
	});
});

describe("an explicit default keeps the bindings' identity key", () => {
	it("omitted and explicit defaults normalise to identical requests", async () => {
		const { toRequest } = await import("../../../src/core/source.ts");
		const { stableStringify } = await import("../../../src/core/identity.ts");
		const { sse } = await import("../../../src/transports/sse/index.ts");
		const { stream } = await import("../../../src/transports/stream/index.ts");
		const { polling } = await import(
			"../../../src/transports/polling/index.ts"
		);
		const { graphqlSse } = await import(
			"../../../src/protocols/graphql-sse/index.ts"
		);
		const key = (source: Parameters<typeof toRequest>[0]) =>
			stableStringify(toRequest(source, "source"));
		const operation = { query: "subscription { ticks }" };
		const pairs: Array<[string, string, string]> = [
			["sse mode", key(sse("/t")), key(sse("/t", { mode: "fetch" }))],
			["sse url-first", key(sse("/t")), key(sse({ url: "/t" }))],
			[
				"stream parser",
				key(stream("/o")),
				key(stream("/o", { parser: "ndjson" })),
			],
			["polling url-first", key(polling("/q")), key(polling({ url: "/q" }))],
			[
				"graphql-sse mode",
				key(graphqlSse("/g").subscription(operation)),
				key(graphqlSse("/g", { mode: "distinct" }).subscription(operation)),
			],
		];
		for (const [name, omitted, explicit] of pairs) {
			expect(omitted, name).toBe(explicit);
		}
	});
});
