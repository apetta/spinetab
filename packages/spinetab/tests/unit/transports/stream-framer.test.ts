import { describe, expect, it } from "vitest";
import { isSpinetabError } from "../../../src/core/errors.ts";
import {
	lineFramer,
	ndjsonParser,
	type Parser,
	type ParserContext,
	type ParserFailure,
} from "../../../src/transports/stream/framer.ts";

// NT-U-11/12: lineFramer and the NDJSON recipe.

const encoder = new TextEncoder();

function strictContext(
	maxFrameBytes = Number.POSITIVE_INFINITY,
): ParserContext {
	return {
		maxFrameBytes,
		malformed(reason) {
			throw Object.assign(new Error(reason), { code: "malformed-frame" });
		},
	};
}

function run<E>(
	parser: Parser<E>,
	chunks: Array<Uint8Array | string>,
	context: ParserContext = strictContext(),
) {
	const instance = parser(context);
	const out: E[] = [];
	for (const chunk of chunks) out.push(...instance.push(chunk));
	out.push(...instance.end());
	return out;
}

function randomSplit(bytes: Uint8Array, seed: number): Uint8Array[] {
	let state = seed;
	const next = () => {
		state = (state * 1103515245 + 12345) & 0x7fffffff;
		return state / 0x7fffffff;
	};
	const chunks: Uint8Array[] = [];
	for (let index = 0; index < bytes.length; ) {
		const size = 1 + Math.floor(next() * 9);
		chunks.push(bytes.slice(index, index + size));
		index += size;
	}
	return chunks;
}

describe("lineFramer", () => {
	it("splits on LF, strips one trailing CR and emits a final unterminated line", () => {
		expect(run(lineFramer(), ["a\r\nb\n\nc\r\r\nd"])).toEqual([
			"a",
			"b",
			"",
			"c\r",
			"d",
		]);
		expect(run(lineFramer({ skipEmpty: true }), ["a\n\n\r\nb\n"])).toEqual([
			"a",
			"b",
		]);
	});

	it("never parses across lines and keeps state per instance", () => {
		const parser = lineFramer();
		const first = parser(strictContext());
		expect(first.push("partial")).toEqual([]);
		const second = parser(strictContext());
		expect(second.push("fresh\n")).toEqual(["fresh"]);
		expect(first.push(" line\n")).toEqual(["partial line"]);
	});

	it("bounds pending and completed lines by the context's maxFrameBytes", () => {
		const instance = lineFramer()(strictContext(8));
		expect(instance.push("1234567")).toEqual([]);
		expect(instance.pendingBytes?.()).toBe(7);
		let caught: unknown;
		try {
			instance.push("89");
		} catch (error) {
			caught = error;
		}
		expect(isSpinetabError(caught, "frame-too-large")).toBe(true);
		expect(() => lineFramer()(strictContext(4)).push("123456\n")).toThrowError(
			expect.objectContaining({ code: "frame-too-large" }),
		);
		expect(() =>
			lineFramer({ maxLineBytes: 2 })(strictContext()).push("abc\n"),
		).toThrowError(expect.objectContaining({ code: "frame-too-large" }));
	});
});

describe("ndjsonParser", () => {
	const lines = [
		{ n: 1, text: "héllo 🌍" },
		{ n: 2, text: "✓" },
		{ n: 3, nested: { list: [1, 2, 3] } },
	];
	const body = `${lines.map((line) => JSON.stringify(line)).join("\r\n")}\n\n`;
	const bytes = encoder.encode(body);

	it("parses one value per line and skips blank lines by default", () => {
		expect(run(ndjsonParser(), [bytes])).toEqual(lines);
		expect(run(ndjsonParser(), ['{"a":1}\n   \n\n{"b":2}\n'])).toEqual([
			{ a: 1 },
			{ b: 2 },
		]);
	});

	it("accepts a non-empty final line without a trailing newline", () => {
		expect(run(ndjsonParser(), ['{"a":1}\n{"b":2}'])).toEqual([
			{ a: 1 },
			{ b: 2 },
		]);
	});

	it("gives identical output for 1-byte, random and whole chunking", () => {
		const oneByte = Array.from(bytes, (byte) => Uint8Array.of(byte));
		expect(run(ndjsonParser(), oneByte)).toEqual(lines);
		for (let seed = 1; seed <= 40; seed += 1) {
			expect(run(ndjsonParser(), randomSplit(bytes, seed))).toEqual(lines);
		}
	});

	it("decodes 2-, 3- and 4-byte characters split at every offset", () => {
		for (const sample of ["é", "✓", "🌍"]) {
			const encoded = encoder.encode(`${JSON.stringify({ s: sample })}\n`);
			for (let cut = 1; cut < encoded.length; cut += 1) {
				expect(
					run(ndjsonParser(), [encoded.slice(0, cut), encoded.slice(cut)]),
				).toEqual([{ s: sample }]);
			}
		}
	});

	it("reports invalid JSON as malformed without its content", () => {
		const reasons: string[] = [];
		const lenient: ParserContext = {
			maxFrameBytes: Number.POSITIVE_INFINITY,
			malformed: (reason) => {
				reasons.push(reason);
			},
		};
		expect(
			run(ndjsonParser(), ['{"a":1}\n{secret\n{"b":2}\n'], lenient),
		).toEqual([{ a: 1 }, { b: 2 }]);
		expect(reasons).toEqual(["Line 2 is not valid JSON."]);
		expect(reasons.join()).not.toContain("secret");
		expect(() => run(ndjsonParser(), ["{bad\n"])).toThrowError(
			expect.objectContaining({ code: "malformed-frame" }),
		);
		expect(() =>
			ndjsonParser()(undefined as unknown as ParserContext).push("{bad\n"),
		).toThrowError(expect.objectContaining({ code: "malformed-frame" }));
	});

	it("attaches frames completed before a failure so they keep their order", () => {
		let caught: unknown;
		try {
			ndjsonParser()(strictContext()).push('{"a":1}\n{"b":2}\n{bad\n{"c":3}\n');
		} catch (error) {
			caught = error;
		}
		expect((caught as { partial?: unknown[] }).partial).toEqual([
			{ a: 1 },
			{ b: 2 },
		]);
		let tooLarge: unknown;
		try {
			lineFramer()(strictContext(4)).push("ok\nlonger line\n");
		} catch (error) {
			tooLarge = error;
		}
		expect(isSpinetabError(tooLarge, "frame-too-large")).toBe(true);
		expect((tooLarge as { partial?: unknown[] }).partial).toEqual(["ok"]);
	});

	it("reports blank lines as malformed only when skipping is turned off", () => {
		expect(() =>
			run(ndjsonParser({ skipEmpty: false }), ["{}\n\n"]),
		).toThrowError(expect.objectContaining({ code: "malformed-frame" }));
	});

	it("classifies heartbeat values through an application predicate", () => {
		const instance = ndjsonParser({
			heartbeat: (value) =>
				typeof value === "object" &&
				value !== null &&
				!Array.isArray(value) &&
				value.type === "heartbeat",
		})(strictContext());
		const frames = instance.push('{"type":"heartbeat"}\n{"n":1}\n');
		expect(frames.map((frame) => instance.heartbeat?.(frame))).toEqual([
			true,
			false,
		]);
	});
});

// NT-U-39, (phase 2b): frames completed in the same push as an
// unterminated oversized tail travel in `partial`, so every chunking delivers
// the same frames before `frame-too-large`.
describe("frames completed before an oversized tail", () => {
	const tail = "x".repeat(40);

	/** Frames returned or carried in `partial`, and the failure code. */
	function delivered<E>(parser: Parser<E>, chunks: string[]) {
		const instance = parser(strictContext(16));
		const frames: E[] = [];
		try {
			for (const chunk of chunks) frames.push(...instance.push(chunk));
			frames.push(...instance.end());
		} catch (error) {
			frames.push(...((error as ParserFailure<E>).partial ?? []));
			return { frames, code: (error as { code?: string }).code };
		}
		return { frames, code: undefined };
	}

	const chunkings = (text: string) => ({
		whole: [text],
		split: [text.slice(0, text.length - tail.length), tail],
		bytewise: Array.from(text),
	});

	it("attaches the lines completed in the same push as partial", () => {
		let caught: unknown;
		try {
			lineFramer()(strictContext(16)).push(`a\nb\n${tail}`);
		} catch (error) {
			caught = error;
		}
		expect(isSpinetabError(caught, "frame-too-large")).toBe(true);
		expect((caught as ParserFailure<string>).partial).toEqual(["a", "b"]);
	});

	it("delivers the same lines and NDJSON values for whole, split and 1-byte chunkings", () => {
		for (const [name, chunks] of Object.entries(chunkings(`a\nb\n${tail}`))) {
			expect(delivered(lineFramer(), chunks), name).toEqual({
				frames: ["a", "b"],
				code: "frame-too-large",
			});
		}
		for (const [name, chunks] of Object.entries(
			chunkings(`{"n":1}\n{"n":2}\n${tail}`),
		)) {
			expect(delivered(ndjsonParser(), chunks), name).toEqual({
				frames: [{ n: 1 }, { n: 2 }],
				code: "frame-too-large",
			});
		}
	});
});
