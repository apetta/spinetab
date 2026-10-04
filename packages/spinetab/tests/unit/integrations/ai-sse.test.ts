import { describe, expect, it } from "vitest";
import { isSpinetabError } from "../../../src/core/errors.ts";
import { createSseDataParser } from "../../../src/integrations/ai-sdk/sse.ts";

// the UI message stream is parsed once in the runtime.
const encode = (text: string) => new TextEncoder().encode(text);

describe("createSseDataParser", () => {
	it("emits one data string per event and passes [DONE] through", () => {
		const parser = createSseDataParser(1024);
		expect(parser.push('data: {"type":"start"}\n\ndata: [DONE]\n\n')).toEqual([
			'{"type":"start"}',
			"[DONE]",
		]);
		expect(parser.end()).toEqual([]);
	});

	it("handles CR, LF and CRLF, including a CRLF split across chunks", () => {
		const parser = createSseDataParser(1024);
		const out = [
			...parser.push("data: a\r\n\r"),
			...parser.push("\ndata: b\r\rdata: c\n\n"),
		];
		expect(out).toEqual(["a", "b", "c"]);
	});

	it("joins multi-line data with LF, ignores comments and other fields", () => {
		const parser = createSseDataParser(1024);
		expect(
			parser.push(": keep-alive\nevent: x\nid: 7\ndata: one\ndata:two\n\n"),
		).toEqual(["one\ntwo"]);
	});

	it("decodes UTF-8 split across byte chunks and strips a leading BOM", () => {
		const parser = createSseDataParser(1024);
		const bytes = encode('﻿data: {"delta":"é✓"}\n\n');
		const out = [
			...parser.push(bytes.slice(0, 16)),
			...parser.push(bytes.slice(16)),
		];
		expect(out).toEqual(['{"delta":"é✓"}']);
	});

	it("discards an incomplete event at the end of the stream", () => {
		const parser = createSseDataParser(1024);
		expect(parser.push("data: complete\n\ndata: partial")).toEqual([
			"complete",
		]);
		expect(parser.end()).toEqual([]);
	});

	it("bounds a partial frame with frame-too-large", () => {
		const parser = createSseDataParser(16);
		let caught: unknown;
		try {
			parser.push(`data: ${"x".repeat(32)}`);
		} catch (error) {
			caught = error;
		}
		expect(isSpinetabError(caught, "frame-too-large")).toBe(true);
	});

	it("bounds accumulated multi-line data", () => {
		const parser = createSseDataParser(20);
		expect(() =>
			parser.push("data: 0123456789\ndata: 0123456789\n"),
		).toThrowError(expect.objectContaining({ code: "frame-too-large" }));
	});
});

// the frame limit is in UTF-8 bytes, with the same
// outcome whatever the network chunk width.
describe("createSseDataParser frame limit in UTF-8 bytes", () => {
	const parseInWidth = (input: Uint8Array, width: number, limit: number) => {
		const parser = createSseDataParser(limit);
		const out: string[] = [];
		for (let start = 0; start < input.length; start += width) {
			out.push(...parser.push(input.subarray(start, start + width)));
		}
		out.push(...parser.end());
		return out;
	};
	const everyWidth = (input: Uint8Array) =>
		Array.from({ length: input.length }, (_, index) => index + 1);

	it("rejects 40 CJK characters (161 bytes, 81 UTF-16 units) at limit 128 for every width", () => {
		const delta = JSON.stringify({
			type: "text-delta",
			id: "t",
			delta: "界".repeat(40),
		});
		expect(delta.length).toBeLessThan(128);
		expect(encode(delta).length).toBe(161);
		const input = encode(`data: ${delta}\n\n`);
		for (const width of everyWidth(input)) {
			expect(() => parseInWidth(input, width, 128), `width ${width}`).toThrow(
				expect.objectContaining({ code: "frame-too-large" }),
			);
			expect(parseInWidth(input, width, 1024)).toEqual([delta]);
		}
	});

	it("accepts a line of exactly the limit in bytes and rejects one byte less, at every width", () => {
		const line = `data: ${"é".repeat(10)}`; // 6 + 20 bytes
		expect(encode(line).length).toBe(26);
		const input = encode(`${line}\n\n`);
		for (const width of everyWidth(input)) {
			expect(parseInWidth(input, width, 26)).toEqual(["é".repeat(10)]);
			expect(() => parseInWidth(input, width, 25)).toThrow(
				expect.objectContaining({ code: "frame-too-large" }),
			);
		}
	});

	it("bounds ignored fields and multi-line data identically for whole and split chunks", () => {
		for (const text of [
			`event: ${"x".repeat(40)}\n\n`,
			"data: 0123456789\ndata: 0123456789\n\n",
		]) {
			const input = encode(text);
			for (const width of everyWidth(input)) {
				expect(
					() => parseInWidth(input, width, 20),
					`${text} @ ${width}`,
				).toThrow(expect.objectContaining({ code: "frame-too-large" }));
			}
		}
	});

	it("counts a surrogate pair split across string pushes as four bytes", () => {
		const parser = createSseDataParser(10); // "data: " + 4 bytes
		expect([
			...parser.push("data: \uD83D"),
			...parser.push("\uDE00\n\n"),
		]).toEqual(["😀"]);
	});
});
