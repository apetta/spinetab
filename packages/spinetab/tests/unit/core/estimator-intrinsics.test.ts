import { afterEach, describe, expect, it } from "vitest";
import { estimateBytes } from "../../../src/core/estimate.ts";
import { createRuntime, type Runtime } from "../../../src/core/runtime.ts";
import { ManualClock, settle } from "./helpers/clock.ts";
import { RawPage } from "./helpers/page.ts";
import { createTestAdapter } from "./helpers/test-adapter.ts";

const MIB = 1024 * 1024;
const runtimes: Runtime[] = [];
afterEach(() => {
	for (const runtime of runtimes.splice(0)) runtime.dispose();
});

const largeNativeValues: Array<{ name: string; make(): unknown }> = [
	{
		name: "ArrayBuffer byteLength",
		make() {
			const value = new ArrayBuffer(MIB);
			Object.defineProperty(value, "byteLength", { value: 0 });
			return value;
		},
	},
	...[
		{
			name: "typed-array buffer",
			make: () => new Uint8Array(new ArrayBuffer(MIB)),
		},
		{ name: "DataView buffer", make: () => new DataView(new ArrayBuffer(MIB)) },
	].map(({ name, make }) => ({
		name,
		make() {
			const value = make();
			Object.defineProperty(value, "buffer", { value: new ArrayBuffer(0) });
			return value;
		},
	})),
	{
		name: "Blob size",
		make() {
			const value = new Blob(["x".repeat(MIB)]);
			Object.defineProperty(value, "size", { value: 0 });
			return value;
		},
	},
	{
		name: "File name",
		make() {
			const value = new File([], "x".repeat(MIB));
			Object.defineProperty(value, "name", { value: "a" });
			return value;
		},
	},
	{
		name: "RegExp source",
		make() {
			const value = new RegExp("x".repeat(MIB));
			Object.defineProperty(value, "source", { value: "a" });
			return value;
		},
	},
	{
		name: "Map iterator",
		make() {
			const value = new Map([["entry", "x".repeat(MIB)]]);
			Object.defineProperty(value, Symbol.iterator, { value: function* () {} });
			return value;
		},
	},
	{
		name: "Set iterator",
		make() {
			const value = new Set(["x".repeat(MIB)]);
			Object.defineProperty(value, Symbol.iterator, { value: function* () {} });
			return value;
		},
	},
];

async function subscribed(maxMessageBytes = 256) {
	const clock = new ManualClock();
	const adapter = createTestAdapter();
	const runtime = createRuntime({
		adapters: [adapter.adapter],
		clock,
		limits: {
			maxMessageBytes,
			maxPendingBytesPerConsumer: maxMessageBytes * 2,
			maxPendingBytes: maxMessageBytes * 4,
		},
	});
	runtimes.push(runtime);
	const page = new RawPage(runtime);
	page.hello();
	await settle(clock);
	page.subscribe("one", {});
	await settle(clock);
	page.ackControl();
	await settle(clock);
	return { clock, page, runtime, upstream: adapter.last() };
}

describe("native clone accounting", () => {
	it.each(
		largeNativeValues,
	)("charges the internal value despite shadowed $name", ({ make }) => {
		expect(estimateBytes(make())).toBeGreaterThanOrEqual(MIB);
	});

	it.each(
		largeNativeValues,
	)("refuses shadowed $name at the real message bridge", async ({ make }) => {
		const { clock, page, runtime, upstream } = await subscribed();
		try {
			upstream.emit(make());
			await settle(clock);
			expect(page.data("one")).toEqual([]);
			expect(page.continuity("one")[0]?.continuity.reason).toBe(
				"message-too-large",
			);
			expect(runtime.stats().pendingBytes).toBe(0);
		} finally {
			page.close();
		}
	});

	it("does not invoke shadowed built-in getters or iterators", () => {
		let reads = 0;
		const forbidden = () => {
			reads += 1;
			throw new Error("not clone metadata");
		};
		const buffer = new ArrayBuffer(8);
		Object.defineProperty(buffer, "byteLength", { get: forbidden });
		const blob = new Blob(["small"]);
		Object.defineProperty(blob, "size", { get: forbidden });
		Object.defineProperty(blob, "type", { get: forbidden });
		const map = new Map([["entry", 1]]);
		Object.defineProperty(map, Symbol.iterator, { get: forbidden });
		const set = new Set([1]);
		Object.defineProperty(set, Symbol.iterator, { get: forbidden });
		for (const value of [buffer, blob, map, set]) {
			expect(estimateBytes(value)).toBeGreaterThan(0);
		}
		expect(reads).toBe(0);
	});

	it("preserves ordinary native Error stacks and recursively charges causes", async () => {
		const value = new Error("small", { cause: new Uint8Array([1, 2, 3]) });
		expect(estimateBytes(value)).toBeGreaterThan(0);
		const { clock, page, upstream } = await subscribed(16_384);
		try {
			upstream.emit(value);
			await settle(clock);
			expect(page.data("one")[0]).toBeInstanceOf(Error);
			expect((page.data("one")[0] as Error).cause).toEqual(
				new Uint8Array([1, 2, 3]),
			);
		} finally {
			page.close();
		}
	});

	it.each([
		"name",
		"message",
		"cause",
		"stack",
	])("rejects custom Error %s accessors without reading them", async (key) => {
		let reads = 0;
		const value = new Error("small");
		Object.defineProperty(value, key, {
			get() {
				reads += 1;
				return reads <= 2 ? "small" : "x".repeat(MIB);
			},
		});
		expect(estimateBytes(value)).toBeUndefined();
		const { clock, page, runtime, upstream } = await subscribed();
		try {
			upstream.emit(value);
			await settle(clock);
			expect(page.data("one")).toEqual([]);
			expect(page.continuity("one")[0]?.continuity.reason).toBe(
				"event-not-serialisable",
			);
			expect(runtime.stats().pendingBytes).toBe(0);
			expect(reads).toBe(0);
		} finally {
			page.close();
		}
	});

	it("fails closed on native proxies and keeps cyclic containers estimable", () => {
		expect(estimateBytes(new Proxy(new Map(), {}))).toBeUndefined();
		const value = new Map<string, unknown>();
		value.set("self", value);
		expect(estimateBytes(value)).toBeGreaterThan(0);
	});

	it("charges shared backing buffers for typed arrays and DataViews", () => {
		const buffer = new SharedArrayBuffer(2_048);
		expect(estimateBytes(new Uint8Array(buffer))).toBe(2_048);
		expect(estimateBytes(new DataView(buffer))).toBe(2_048);
	});
});
