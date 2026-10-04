import { describe, expect, it } from "vitest";
import { isSpinetabError } from "../../../src/core/errors.ts";
import {
	parseServerSentEvents,
	type ServerSentEvent,
} from "../../../src/transports/sse/parser.ts";

// NT-U-06/07/08: HTML "interpreting an event stream" golden vectors, byte
// chunking properties and the pending-bytes bound.

const encoder = new TextEncoder();

function parseChunks(chunks: Uint8Array[], lastEventId?: string) {
	const parser = parseServerSentEvents({ lastEventId });
	const events: ServerSentEvent[] = [];
	for (const chunk of chunks) events.push(...parser.push(chunk));
	events.push(...parser.end());
	return { events, lastEventId: parser.lastEventId, retry: parser.retry };
}

function whole(text: string | Uint8Array): Uint8Array[] {
	return [typeof text === "string" ? encoder.encode(text) : text];
}

function bytewise(bytes: Uint8Array): Uint8Array[] {
	return Array.from(bytes, (byte) => Uint8Array.of(byte));
}

/** Deterministic pseudo-random splits (mulberry32). */
function randomChunks(bytes: Uint8Array, seed: number): Uint8Array[] {
	let state = seed;
	const random = () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	const chunks: Uint8Array[] = [];
	let index = 0;
	while (index < bytes.length) {
		const size = 1 + Math.floor(random() * 7);
		chunks.push(bytes.slice(index, index + size));
		index += size;
	}
	return chunks;
}

const golden: Array<{
	name: string;
	input: string;
	expected: ServerSentEvent[];
	lastEventId: string;
}> = [
	{
		name: "spec example: data lines joined with LF, id set",
		input: "data: YHOO\ndata: +2\ndata: 10\n\n",
		expected: [{ type: "message", data: "YHOO\n+2\n10", lastEventId: "" }],
		lastEventId: "",
	},
	{
		name: "comments ignored, id persists, empty data dispatches empty string",
		input:
			": test stream\n\ndata: first event\nid: 1\n\ndata:second event\nid\n\ndata:  third event\n\n",
		expected: [
			{ type: "message", data: "first event", lastEventId: "1" },
			{ type: "message", data: "second event", lastEventId: "" },
			{ type: "message", data: " third event", lastEventId: "" },
		],
		lastEventId: "",
	},
	{
		name: "field without colon is an empty value; trailing incomplete event discarded",
		input: "data\n\ndata\ndata\n\ndata:",
		expected: [
			{ type: "message", data: "", lastEventId: "" },
			{ type: "message", data: "\n", lastEventId: "" },
		],
		lastEventId: "",
	},
	{
		name: "only one space after the colon is stripped",
		input: "data:test\n\ndata: test\n\ndata:  test\n\n",
		expected: [
			{ type: "message", data: "test", lastEventId: "" },
			{ type: "message", data: "test", lastEventId: "" },
			{ type: "message", data: " test", lastEventId: "" },
		],
		lastEventId: "",
	},
	{
		name: "named events, CRLF and lone CR line endings",
		input: "event: tick\r\ndata: 1\r\n\r\nevent: alert\rdata: 2\r\rdata: 3\n\n",
		expected: [
			{ type: "tick", data: "1", lastEventId: "" },
			{ type: "alert", data: "2", lastEventId: "" },
			{ type: "message", data: "3", lastEventId: "" },
		],
		lastEventId: "",
	},
	{
		name: "id-only block commits the cursor without dispatching; later events inherit it",
		input: "id: 7\n\ndata: a\n\n",
		expected: [{ type: "message", data: "a", lastEventId: "7" }],
		lastEventId: "7",
	},
	{
		name: "empty id resets the cursor; NUL id ignored",
		input:
			"id: 1\ndata: a\n\nid\ndata: b\n\nid: 9\n\nid: x\u0000y\ndata: c\n\n",
		expected: [
			{ type: "message", data: "a", lastEventId: "1" },
			{ type: "message", data: "b", lastEventId: "" },
			{ type: "message", data: "c", lastEventId: "9" },
		],
		lastEventId: "9",
	},
	{
		name: "unknown fields ignored; event type resets after dispatch",
		input: "foo: bar\nevent: alert\ndata: x\n\ndata: y\n\n",
		expected: [
			{ type: "alert", data: "x", lastEventId: "" },
			{ type: "message", data: "y", lastEventId: "" },
		],
		lastEventId: "",
	},
	{
		name: "incomplete final event does not commit its id",
		input: "data: a\nid: 1\n\ndata: b\nid: 2\n",
		expected: [{ type: "message", data: "a", lastEventId: "1" }],
		lastEventId: "1",
	},
	{
		name: "non-ASCII data survives",
		input: "data: héllo 🌍 ✓\n\n",
		expected: [{ type: "message", data: "héllo 🌍 ✓", lastEventId: "" }],
		lastEventId: "",
	},
];

describe("parseServerSentEvents golden vectors", () => {
	for (const vector of golden) {
		it(vector.name, () => {
			const bytes = encoder.encode(vector.input);
			for (const chunks of [
				whole(bytes),
				bytewise(bytes),
				randomChunks(bytes, 1),
				randomChunks(bytes, 99),
			]) {
				const result = parseChunks(chunks);
				expect(result.events).toEqual(vector.expected);
				expect(result.lastEventId).toBe(vector.lastEventId);
			}
		});
	}

	it("treats CR at a chunk end followed by LF as one line ending, not an early dispatch", () => {
		const parser = parseServerSentEvents();
		expect(parser.push("data: a\r")).toEqual([]);
		expect(parser.push("\ndata: b\r")).toEqual([]);
		expect(parser.push("\n\r\n")).toEqual([
			{ type: "message", data: "a\nb", lastEventId: "" },
		]);
	});

	it("strips exactly one leading BOM per stream, for bytes and strings", () => {
		const bom = Uint8Array.of(0xef, 0xbb, 0xbf);
		const body = encoder.encode("data: x\n\n");
		const bytes = new Uint8Array([...bom, ...body]);
		for (const chunks of [whole(bytes), bytewise(bytes)]) {
			expect(parseChunks(chunks).events).toEqual([
				{ type: "message", data: "x", lastEventId: "" },
			]);
		}
		const parser = parseServerSentEvents();
		expect(parser.push("﻿data: y\n\n﻿data: z\n\n")).toEqual([
			{ type: "message", data: "y", lastEventId: "" },
		]);
	});

	it("parses retry only from ASCII digits", () => {
		for (const [input, expected] of [
			["retry: 1500\n\n", 1500],
			["retry: 15a\n\n", undefined],
			["retry: -1\n\n", undefined],
			["retry:\n\n", undefined],
			["retry: 1.5\n\n", undefined],
			["retry: 20\nretry: x\n\n", 20],
		] as const) {
			expect(parseChunks(whole(input)).retry).toBe(expected);
		}
	});

	it("starts from a carried cursor so events without id inherit it", () => {
		const result = parseChunks(whole("data: a\n\n"), "41");
		expect(result.events).toEqual([
			{ type: "message", data: "a", lastEventId: "41" },
		]);
	});
});

describe("UTF-8 split at every offset", () => {
	const samples = ["é", "✓", "🌍", "aé✓🌍b"];
	for (const sample of samples) {
		it(`decodes ${JSON.stringify(sample)} split at every byte offset`, () => {
			const bytes = encoder.encode(`data: ${sample}\n\n`);
			for (let cut = 1; cut < bytes.length; cut += 1) {
				const result = parseChunks([bytes.slice(0, cut), bytes.slice(cut)]);
				expect(result.events).toEqual([
					{ type: "message", data: sample, lastEventId: "" },
				]);
			}
			for (let a = 1; a < bytes.length - 1; a += 1) {
				for (let b = a + 1; b < bytes.length; b += 1) {
					const result = parseChunks([
						bytes.slice(0, a),
						bytes.slice(a, b),
						bytes.slice(b),
					]);
					expect(result.events[0]?.data).toBe(sample);
				}
			}
		});
	}

	it("replaces invalid UTF-8 with U+FFFD rather than failing (fatal: false)", () => {
		const bytes = new Uint8Array([
			...encoder.encode("data: a"),
			0xff,
			...encoder.encode("b\n\n"),
		]);
		expect(parseChunks(whole(bytes)).events[0]?.data).toBe("a�b");
	});
});

describe("chunks are not messages", () => {
	it("gives identical output for every chunking of a mixed stream", () => {
		const input =
			'﻿: hi\r\nretry: 3000\r\nid: 1\r\nevent: tick\r\ndata: {"n":1}\r\n\r\nid\ndata: é\ndata: 🌍\n\nid: 3\n\ndata: tail\r\rdata: partial';
		const bytes = encoder.encode(input);
		const reference = parseChunks(whole(bytes));
		expect(reference.events).toHaveLength(3);
		for (let seed = 1; seed <= 50; seed += 1) {
			expect(parseChunks(randomChunks(bytes, seed))).toEqual(reference);
		}
		expect(parseChunks(bytewise(bytes))).toEqual(reference);
	});
});

describe("bounded pending bytes", () => {
	it("throws frame-too-large when an unterminated line exceeds the bound", () => {
		const parser = parseServerSentEvents({ maxPendingBytes: 16 });
		parser.push("data: 0123456");
		let caught: unknown;
		try {
			parser.push("789abcdef");
		} catch (error) {
			caught = error;
		}
		expect(isSpinetabError(caught, "frame-too-large")).toBe(true);
	});

	it("bounds an event built from many short data lines", () => {
		const parser = parseServerSentEvents({ maxPendingBytes: 32 });
		expect(() => {
			for (let index = 0; index < 20; index += 1) parser.push("data: abc\n");
		}).toThrowError(expect.objectContaining({ code: "frame-too-large" }));
	});

	it("counts UTF-8 bytes, not code units", () => {
		const parser = parseServerSentEvents({ maxPendingBytes: 10 });
		// Four U+1F30D characters are 8 code units but 16 bytes.
		expect(() => parser.push("🌍🌍🌍🌍")).toThrowError(
			expect.objectContaining({ code: "frame-too-large" }),
		);
	});

	it("resets after each dispatched event and ignores comment volume", () => {
		const parser = parseServerSentEvents({ maxPendingBytes: 32 });
		for (let index = 0; index < 100; index += 1) {
			parser.push(": keep-alive comment padding\n");
			expect(parser.push("data: 0123456789\n\n")).toHaveLength(1);
		}
		expect(parser.pendingBytes()).toBe(0);
	});
});

// The bound is independent of chunk boundaries and charges retained
// metadata.
describe("chunk-independent bound on lines and retained metadata", () => {
	type Outcome =
		| { events: ServerSentEvent[]; lastEventId: string }
		| { error: string };

	function parseAtWidth(
		bytes: Uint8Array,
		width: number,
		options: { maxPendingBytes?: number; lastEventId?: string } = {},
	): Outcome {
		const parser = parseServerSentEvents(options);
		const events: ServerSentEvent[] = [];
		try {
			for (let start = 0; start < bytes.length; start += width) {
				events.push(...parser.push(bytes.subarray(start, start + width)));
			}
			events.push(...parser.end());
		} catch (error) {
			return { error: isSpinetabError(error) ? error.code : String(error) };
		}
		return { events, lastEventId: parser.lastEventId };
	}

	const tooLarge = { error: "frame-too-large" };

	for (const field of ["id", "event"]) {
		it(`rejects an oversized ${field} line whole, split and byte by byte`, () => {
			const bytes = encoder.encode(
				`${field}: ${"x".repeat(4096)}\ndata: ok\n\n`,
			);
			for (const width of [bytes.length, 4097, 1000, 7, 1]) {
				expect(parseAtWidth(bytes, width, { maxPendingBytes: 64 })).toEqual(
					tooLarge,
				);
			}
		});
	}

	it("charges a retained id against later data in the same and later events", () => {
		const id = "i".repeat(56); // "id: " + 56 bytes = 60-byte line
		const fits = encoder.encode(`id: ${id}\n\ndata: ab\n\n`); // 56 + 8 = 64
		const exceeds = encoder.encode(`id: ${id}\n\ndata: abc\n\n`); // 56 + 9 = 65
		for (let width = 1; width <= exceeds.length; width += 1) {
			expect(parseAtWidth(fits, width, { maxPendingBytes: 64 })).toEqual({
				events: [{ type: "message", data: "ab", lastEventId: id }],
				lastEventId: id,
			});
			expect(parseAtWidth(exceeds, width, { maxPendingBytes: 64 })).toEqual(
				tooLarge,
			);
		}
	});

	it("releases the id budget when the id is reset and charges a carried cursor", () => {
		const parser = parseServerSentEvents({ maxPendingBytes: 64 });
		parser.push(`id: ${"i".repeat(56)}\n\n`);
		expect(parser.pendingBytes()).toBe(56);
		parser.push("id\n\n");
		expect(parser.pendingBytes()).toBe(0);
		expect(parser.push(`data: ${"d".repeat(50)}\n\n`)).toHaveLength(1);

		const carried = parseServerSentEvents({
			maxPendingBytes: 64,
			lastEventId: "c".repeat(60),
		});
		expect(carried.pendingBytes()).toBe(60);
		expect(() => carried.push("data: x\n")).toThrowError(
			expect.objectContaining({ code: "frame-too-large" }),
		);
	});

	it("gives the same accept or reject outcome at every bound and chunk width", () => {
		const bytes = encoder.encode(
			"id: 12\r\nevent: tick\r\ndata: é🌍\r\n\r\nevent: x\ndata: abcdef\n\nid\ndata: z\n\n",
		);
		for (let bound = 0; bound <= 24; bound += 1) {
			const reference = parseAtWidth(bytes, bytes.length, {
				maxPendingBytes: bound,
			});
			for (let width = 1; width < bytes.length; width += 1) {
				expect(
					parseAtWidth(bytes, width, { maxPendingBytes: bound }),
					`bound ${bound}, width ${width}`,
				).toEqual(reference);
			}
		}
	});

	it("leaves golden vectors unchanged at every chunk width under a bound", () => {
		for (const vector of golden) {
			const bytes = encoder.encode(vector.input);
			for (let width = 1; width <= bytes.length; width += 1) {
				expect(
					parseAtWidth(bytes, width, { maxPendingBytes: 64 }),
					`${vector.name}, width ${width}`,
				).toEqual({ events: vector.expected, lastEventId: vector.lastEventId });
			}
		}
	});
});

// NT-U-40, (phase 2b): events dispatched in the same push as an
// oversized line travel in `partial` on the `frame-too-large` error, so every
// chunking yields the same events before the failure.
describe("events dispatched before frame-too-large", () => {
	const small = "id: 1\ndata: a\n\nid: 2\ndata: b\n\n";
	const big = `data: ${"x".repeat(100)}\n\n`;

	function delivered(chunks: Uint8Array[]) {
		const parser = parseServerSentEvents({ maxPendingBytes: 64 });
		const events: ServerSentEvent[] = [];
		try {
			for (const chunk of chunks) events.push(...parser.push(chunk));
			events.push(...parser.end());
		} catch (error) {
			events.push(
				...((error as { partial?: ServerSentEvent[] }).partial ?? []),
			);
			return {
				events,
				code: (error as { code?: string }).code,
				lastEventId: parser.lastEventId,
			};
		}
		return { events, code: undefined, lastEventId: parser.lastEventId };
	}

	it("attaches the events dispatched in the same push as partial", () => {
		expect(delivered(whole(small + big))).toEqual({
			events: [
				{ type: "message", data: "a", lastEventId: "1" },
				{ type: "message", data: "b", lastEventId: "2" },
			],
			code: "frame-too-large",
			lastEventId: "2",
		});
	});

	it("gives the same events before the failure for every chunking", () => {
		const bytes = encoder.encode(small + big);
		const reference = delivered(whole(bytes));
		expect(reference.events).toHaveLength(2);
		expect(delivered([encoder.encode(small), encoder.encode(big)])).toEqual(
			reference,
		);
		expect(delivered(bytewise(bytes))).toEqual(reference);
		for (let seed = 1; seed <= 20; seed += 1) {
			expect(delivered(randomChunks(bytes, seed)), `seed ${seed}`).toEqual(
				reference,
			);
		}
	});
});
