import { describe, expect, it } from "vitest";
import { scanSource } from "../../../src/build/scan.ts";
import { CASES, type Case, RESIDUAL_CASES } from "./scan-corpus.ts";

const read = (item: Case) => {
	const scan = scanSource(item.code, item.file);
	return { kinds: [...scan.kinds].sort(), fallback: scan.fallback };
};

describe("scan corpus", () => {
	it.each(CASES.map((item) => [item.id, item] as const))("%s", (_, item) => {
		expect(item.residual).toBeUndefined();
		// Only an unclosable file reads by fallback (and warns scan-fallback).
		expect(read(item)).toEqual({
			kinds: [...item.expected].sort(),
			fallback: item.fallback ?? false,
		});
	});

	it("keeps case ids unique across the corpus and the residuals", () => {
		const ids = [...CASES, ...RESIDUAL_CASES].map((item) => item.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});

describe("scan residuals: today's result, never a silent pass", () => {
	it.each(
		RESIDUAL_CASES.map((item) => [item.id, item] as const),
	)("%s", (_, item) => {
		const residual = item.residual;
		expect(residual, "a residual row records its residual").toBeDefined();
		if (!residual) return;
		expect(residual.why.length).toBeGreaterThan(0);
		expect(residual.remedy.length).toBeGreaterThan(0);
		const meaning = {
			kinds: [...item.expected].sort(),
			fallback: item.fallback ?? false,
		};
		const today = {
			kinds: [...residual.kinds].sort(),
			fallback: residual.fallback,
		};
		// A row whose residual matches the meaning is a genuine case: move it.
		expect(today).not.toEqual(meaning);
		expect(read(item)).toEqual(today);
	});
});
