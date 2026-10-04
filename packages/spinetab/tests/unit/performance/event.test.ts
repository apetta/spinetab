import { describe, expect, it } from "vitest";
import {
	EVENT_BYTES,
	FEED_QUERY,
	makeEvent,
	readEvent,
	serialisedBytes,
} from "../../fixtures/harness/src/bench/event.ts";

const utf8 = (value: unknown) =>
	new TextEncoder().encode(JSON.stringify(value)).byteLength;

describe("makeEvent", () => {
	const origins = [
		0, 1.5, 1_759_000_000_000, 1_759_000_000_000.123, 1_759_000_000_123.4568,
		1e21, 5e-7,
	];

	it("serialises to exactly 1024 bytes for seq 0…10⁶ (sampled) and varied timestamps", () => {
		const seqs = [0, 1, 9, 10, 99, 100, 999, 1_000, 65_535, 999_999, 1_000_000];
		for (let seq = 0; seq <= 1_000_000; seq += 9_973) seqs.push(seq);
		for (const topic of [0, 1, 9, 10, 99]) {
			for (const seq of seqs) {
				for (const emittedAt of origins) {
					const event = makeEvent(topic, seq, emittedAt);
					expect(utf8(event)).toBe(EVENT_BYTES);
					expect(serialisedBytes(event)).toBe(EVENT_BYTES);
				}
			}
		}
	});

	it("honours other sizes and seeds the marker without changing the size", () => {
		for (const size of [256, 4_096, 64 * 1024, 255 * 1024, 257 * 1024]) {
			expect(utf8(makeEvent(3, 42, 1_759_000_000_000.25, size))).toBe(size);
		}
		const marked = makeEvent(7, 12, 99.5, EVENT_BYTES, "STPAYLOAD-run1");
		expect(utf8(marked)).toBe(EVENT_BYTES);
		expect(marked.body.startsWith("STPAYLOAD-run1")).toBe(true);
	});

	it("keeps field order and ASCII bodies", () => {
		const event = makeEvent(5, 6, 7.25);
		expect(Object.keys(event)).toEqual(["topic", "seq", "emittedAt", "body"]);
		expect(/^[a-z0-9]*$/.test(event.body)).toBe(true);
	});

	it("rejects invalid input instead of producing a wrong size", () => {
		expect(() => makeEvent(-1, 0, 0)).toThrow(RangeError);
		expect(() => makeEvent(0, 1.5, 0)).toThrow(RangeError);
		expect(() => makeEvent(0, 0, Number.NaN)).toThrow(RangeError);
		expect(() => makeEvent(0, 0, 0, EVENT_BYTES, 'bad"marker')).toThrow(
			RangeError,
		);
	});
});

describe("readEvent", () => {
	it("reads native events and graphql-ws results", () => {
		const event = makeEvent(4, 8, 15.5);
		expect(readEvent(event)).toEqual({ topic: 4, seq: 8, emittedAt: 15.5 });
		expect(readEvent({ data: { feed: event } })).toEqual({
			topic: 4,
			seq: 8,
			emittedAt: 15.5,
		});
		expect(readEvent({ data: null, errors: [] })).toBeUndefined();
		expect(readEvent("text")).toBeUndefined();
	});

	it("selects every event field in the GraphQL document", () => {
		for (const field of ["topic", "seq", "emittedAt", "body"]) {
			expect(FEED_QUERY).toContain(field);
		}
	});
});
