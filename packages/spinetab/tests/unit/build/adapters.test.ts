import { describe, expect, it } from "vitest";
import { ADAPTER_NAMES, isAdapterName } from "../../../src/build/adapters.ts";

describe("adapter name validation", () => {
	it("accepts every supported name and rejects unknown names", () => {
		for (const name of ADAPTER_NAMES)
			expect(isAdapterName(name), name).toBe(true);
		for (const name of ["", "trpc", "unknown", "constructor", "toString"])
			expect(isAdapterName(name), name).toBe(false);
	});
});
