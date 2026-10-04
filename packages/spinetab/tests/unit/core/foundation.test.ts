import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type Clock,
	MAX_TIMER_MS,
	systemClock,
} from "../../../src/core/clock.ts";
import { isSpinetabError } from "../../../src/core/errors.ts";
import { estimateBytes } from "../../../src/core/estimate.ts";
import { stableStringify } from "../../../src/core/identity.ts";
import { DEFAULT_LIMITS, resolveLimits } from "../../../src/core/limits.ts";
import { createRuntime, type Runtime } from "../../../src/core/runtime.ts";
import { createStore } from "../../../src/core/store.ts";
import { RawPage } from "./helpers/page.ts";
import { createTestAdapter } from "./helpers/test-adapter.ts";

// Input validation and payload estimation rules. These are source-level checks; the
// real-bridge cases live in the core runtime and browser suites.

const MIB = 1024 * 1024;

describe("stableStringify", () => {
	it("ignores plain object key order and keeps array order", () => {
		expect(stableStringify({ x: 1, y: { b: 2, a: 3 } })).toBe(
			stableStringify({ y: { a: 3, b: 2 }, x: 1 }),
		);
		expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
	});

	it("drops undefined properties but keeps null distinct", () => {
		expect(stableStringify({ a: undefined, b: 1 })).toBe(
			stableStringify({ b: 1 }),
		);
		expect(stableStringify({ a: null })).not.toBe(stableStringify({}));
	});

	it("rejects sparse arrays instead of aliasing them with shorter arrays", () => {
		expect(() => stableStringify(new Array(1))).toThrowError(
			expect.objectContaining({ code: "unsupported-option" }),
		);
		const holed: unknown[] = [1, 2, 3];
		delete holed[1];
		expect(() => stableStringify(holed)).toThrowError(
			expect.objectContaining({ code: "unsupported-option" }),
		);
	});

	it("rejects cyclic input with an actionable package error", () => {
		const input: Record<string, unknown> = {};
		input.self = input;
		let caught: unknown;
		try {
			stableStringify(input);
		} catch (error) {
			caught = error;
		}
		expect(isSpinetabError(caught, "unsupported-option")).toBe(true);
		expect((caught as Error).message).toContain("cyclic");
	});

	it("rejects functions, symbols and non-plain objects", () => {
		for (const value of [
			{ callback() {} },
			{ s: Symbol("x") },
			new Date(0),
			new Map(),
			new Uint8Array(1),
		]) {
			expect(() => stableStringify(value)).toThrowError(
				expect.objectContaining({ code: "unsupported-option" }),
			);
		}
	});

	it("keeps bigint distinct from numbers", () => {
		expect(stableStringify(1n)).not.toBe(stableStringify(1));
	});
});

describe("estimateBytes", () => {
	it("charges multi-byte strings at least their UTF-8 length", () => {
		const value = "🙂".repeat(2000);
		expect(estimateBytes(value)).toBeGreaterThanOrEqual(
			new TextEncoder().encode(value).byteLength,
		);
	});

	it("charges a small typed-array view for its whole cloned backing buffer", () => {
		const view = new Uint8Array(new ArrayBuffer(MIB), 0, 8);
		expect(estimateBytes(view)).toBeGreaterThanOrEqual(
			structuredClone(view).buffer.byteLength,
		);
	});

	it("charges a large key even when its value is undefined", () => {
		const value = { ["x".repeat(MIB)]: undefined };
		const clonedKey = Object.keys(structuredClone(value))[0] as string;
		expect(estimateBytes(value)).toBeGreaterThanOrEqual(clonedKey.length);
	});

	it("charges an Error's cloned cause and stack", () => {
		const value = new Error("small", { cause: new Uint8Array(MIB) });
		const cloned = structuredClone(value) as Error & { cause: Uint8Array };
		expect(estimateBytes(value)).toBeGreaterThanOrEqual(
			cloned.cause.byteLength,
		);
	});

	it("charges array own metadata, File names and Blob types", () => {
		const array: unknown[] & { metadata?: string } = [];
		array.metadata = "x".repeat(MIB);
		expect(estimateBytes(array)).toBeGreaterThanOrEqual(MIB);
		const file = new File([], "x".repeat(MIB));
		expect(estimateBytes(file)).toBeGreaterThanOrEqual(MIB);
		const blob = new Blob([], { type: "x".repeat(32768) });
		expect(estimateBytes(blob)).toBeGreaterThanOrEqual(32768);
	});

	it("rejects accessor properties that could change between estimate and clone", () => {
		let reads = 0;
		const value = {
			get data() {
				reads += 1;
				return reads === 1 ? "x" : "x".repeat(MIB);
			},
		};
		expect(estimateBytes(value)).toBeUndefined();
		const array: unknown[] = [];
		Object.defineProperty(array, "extra", {
			enumerable: true,
			get: () => "x".repeat(MIB),
		});
		expect(estimateBytes(array)).toBeUndefined();
	});

	it("returns undefined for values structured clone rejects", () => {
		expect(estimateBytes({ callback() {} })).toBeUndefined();
		expect(estimateBytes(Symbol("x"))).toBeUndefined();
		expect(estimateBytes(new Error("x", { cause: () => 1 }))).toBeUndefined();
		expect(() => structuredClone({ callback() {} })).toThrow();
	});

	it("terminates on cyclic values", () => {
		const value: Record<string, unknown> = { n: 1 };
		value.self = value;
		expect(estimateBytes(value)).toBeGreaterThan(0);
	});
});

describe("resolveLimits", () => {
	it("rejects invalid values and unknown or inherited keys", () => {
		for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 1.5]) {
			expect(() => resolveLimits({ maxPendingBytes: value })).toThrowError(
				expect.objectContaining({ code: "unsupported-option" }),
			);
		}
		expect(() =>
			resolveLimits({ toString: 1 } as unknown as Record<string, number>),
		).toThrowError(expect.objectContaining({ code: "unsupported-option" }));
		expect(() =>
			resolveLimits([] as unknown as Record<string, number>),
		).toThrowError(expect.objectContaining({ code: "unsupported-option" }));
	});

	it("keeps per-consumer caps within the aggregate and the message size within a consumer cap", () => {
		expect(() =>
			resolveLimits({
				maxPendingMessagesPerConsumer: DEFAULT_LIMITS.maxPendingMessages + 1,
			}),
		).toThrowError(expect.objectContaining({ code: "unsupported-option" }));
		expect(() =>
			resolveLimits({
				maxMessageBytes: DEFAULT_LIMITS.maxPendingBytesPerConsumer + 1,
			}),
		).toThrowError(expect.objectContaining({ code: "unsupported-option" }));
		expect(resolveLimits({ lingerMs: 0 }).lingerMs).toBe(0);
		expect(() => resolveLimits({ lingerMs: 6000 })).toThrowError(
			expect.objectContaining({ code: "unsupported-option" }),
		);
	});
});

describe("createStore", () => {
	it("keeps the snapshot stable until a real change and honours unsubscribe", () => {
		const store = createStore({ state: "inactive" });
		const initial = store.get();
		let calls = 0;
		const unsubscribe = store.subscribe(() => {
			calls += 1;
		});
		store.patch({ state: "inactive" });
		expect(store.get()).toBe(initial);
		expect(calls).toBe(0);
		store.patch({ state: "active" });
		expect(store.get()).not.toBe(initial);
		expect(calls).toBe(1);
		unsubscribe();
		store.patch({ state: "disposed" });
		expect(calls).toBe(1);
	});
});

// Regression coverage for clock, credential and lifecycle boundaries.
// Host timers take a 32-bit signed delay: Node clamps a larger one to 1 ms
// (TimeoutOverflowWarning) and browsers convert it with WebIDL `long`, so
// 2^31 ms runs at once.
describe("C1-F4 every timeout stays within MAX_TIMER_MS", () => {
	const MAX = 2_147_483_647;
	const runtimes: Runtime[] = [];
	afterEach(() => {
		for (const runtime of runtimes.splice(0)) runtime.dispose();
		vi.restoreAllMocks();
	});
	const wait = (ms: number) =>
		new Promise((resolve) => globalThis.setTimeout(resolve, ms));

	it("C1-F4 MAX_TIMER_MS is 2^31 - 1, the largest delay a host timer honours", () => {
		expect(MAX_TIMER_MS).toBe(MAX);
	});

	for (const key of [
		"leaseMs",
		"commandTimeoutMs",
		"credentialTimeoutMs",
	] as const) {
		it(`C1-F4 resolveLimits caps ${key} at MAX_TIMER_MS`, () => {
			expect(resolveLimits({ [key]: MAX })[key]).toBe(MAX);
			for (const value of [MAX + 1, 2 ** 32]) {
				let caught: unknown;
				try {
					resolveLimits({ [key]: value });
				} catch (error) {
					caught = error;
				}
				expect(isSpinetabError(caught, "unsupported-option")).toBe(true);
				expect(caught).toMatchObject({
					message: `limits.${key} must not exceed ${MAX}.`,
					detail: { path: `limits.${key}`, cap: MAX },
				});
			}
		});
	}

	it("C1-F4 createRuntime refuses limits.leaseMs 2^32 and limits.credentialTimeoutMs 2^31", () => {
		for (const limits of [
			{ leaseMs: 2 ** 32 },
			{ credentialTimeoutMs: 2 ** 31 },
			{ commandTimeoutMs: 2 ** 31 },
		]) {
			expect(() =>
				createRuntime({ adapters: [createTestAdapter().adapter], limits }),
			).toThrowError(expect.objectContaining({ code: "unsupported-option" }));
		}
	});

	it("C1-F4 systemClock hands the host at most MAX_TIMER_MS, so a longer delay never runs at once", async () => {
		const spy = vi.spyOn(globalThis, "setTimeout");
		let fired = false;
		const handle = systemClock.setTimeout(() => {
			fired = true;
		}, 2 ** 31);
		const delay = spy.mock.calls[0]?.[1];
		spy.mockRestore();
		await wait(20);
		systemClock.clearTimeout(handle);
		expect(delay).toBe(MAX);
		expect(fired).toBe(false);
	});

	it("C1-F4 guard: limits.leaseMs MAX_TIMER_MS arms the lease timer once on a real-time clock", async () => {
		let arms = 0;
		const clock: Clock = {
			now: () => Date.now(),
			setTimeout: (callback, ms) => {
				arms += 1;
				return systemClock.setTimeout(callback, ms);
			},
			clearTimeout: (handle) => systemClock.clearTimeout(handle),
		};
		const test = createTestAdapter();
		const runtime = createRuntime({
			adapters: [test.adapter],
			limits: { leaseMs: MAX },
			clock,
		});
		runtimes.push(runtime);
		const raw = new RawPage(runtime);
		raw.hello();
		await wait(100);
		expect(raw.ofType("welcome")).toHaveLength(1);
		expect(arms).toBeLessThanOrEqual(2);
	});
});
