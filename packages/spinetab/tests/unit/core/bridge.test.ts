import { describe, expect, expectTypeOf, it } from "vitest";
import {
	BRIDGE_VERSION,
	type PageMessage,
	type RuntimeMessage,
} from "../../../src/core/bridge.ts";
import {
	isUnknownRuntimeType,
	parseAnnounce,
	parseRuntimeMessage,
} from "../../../src/core/bridge-page.ts";
import {
	foreignHello,
	parsePageMessage,
} from "../../../src/core/bridge-runtime.ts";

// (typed envelopes, validation, fuzz), and
// (every message carries attachment id and generation).

const envelope = { v: BRIDGE_VERSION, a: "att-1", g: 3 };

describe("page → runtime envelopes", () => {
	it("accepts every message type of the closed union with its required fields", () => {
		const valid = [
			{ t: "hello", page: "p", scope: "", revision: null, heartbeatMs: 20000 },
			{
				t: "hello",
				page: "p",
				scope: "s",
				revision: 2,
				heartbeatMs: 1,
				limits: {},
				lease: 5,
				visible: true,
				credentials: true,
				diagnostics: false,
			},
			{
				t: "subscribe",
				c: "1",
				request: { adapter: "x", connection: {}, subscription: {} },
			},
			{ t: "unsubscribe", c: "1" },
			{ t: "update", c: "1", consumer: { intervalMs: 1000 } },
			{ t: "ack", c: "1", seq: 4 },
			{ t: "ack", k: 7 },
			{ t: "reconcile", c: "1" },
			{
				t: "command",
				id: "c1",
				request: { adapter: "x", connection: {}, payload: 1 },
				timeoutMs: 100,
			},
			{ t: "cancel", id: "c1" },
			{
				t: "credentials",
				id: "r1",
				ok: true,
				credentials: { headers: {} },
				revision: 1,
			},
			{
				t: "credentials",
				id: "r1",
				ok: false,
				error: { code: "timeout", message: "m" },
				revision: null,
			},
			{ t: "revision", revision: 20260927, restart: false },
			{ t: "probe", id: "p1", hint: true },
			{ t: "renew" },
			{ t: "retry" },
			{ t: "visibility", visible: false },
			{ t: "detach" },
		];
		for (const body of valid) {
			expect(parsePageMessage({ ...envelope, ...body }), body.t).toBeDefined();
		}
	});

	it("rejects missing envelope fields, other versions and malformed bodies", () => {
		const invalid: unknown[] = [
			null,
			42,
			"hello",
			[],
			{ t: "renew" },
			{ ...envelope, t: "unknown" },
			{ ...envelope, v: 2, t: "renew" },
			{ ...envelope, a: "", t: "renew" },
			{ ...envelope, g: -1, t: "renew" },
			{ ...envelope, g: 1.5, t: "renew" },
			{
				...envelope,
				t: "subscribe",
				c: 1,
				request: { adapter: "x", connection: {}, subscription: {} },
			},
			{
				...envelope,
				t: "subscribe",
				c: "1",
				request: { adapter: "x", connection: {} },
			},
			{
				...envelope,
				t: "subscribe",
				c: "1",
				request: {
					adapter: "x",
					connection: {},
					subscription: {},
					share: "sometimes",
				},
			},
			{ ...envelope, t: "ack", c: "1", seq: -1 },
			{
				...envelope,
				t: "command",
				id: "c",
				request: { adapter: "x", connection: {} },
				timeoutMs: 1,
			},
			{ ...envelope, t: "credentials", id: "r", ok: "yes", revision: null },
			{ ...envelope, t: "revision", revision: null, restart: false },
			{
				...envelope,
				t: "hello",
				page: "p",
				scope: 1,
				revision: null,
				heartbeatMs: 1,
			},
			{
				...envelope,
				t: "hello",
				page: "p",
				scope: "",
				revision: Number.NaN,
				heartbeatMs: 1,
			},
			{ ...envelope, t: "visibility", visible: "yes" },
		];
		for (const value of invalid)
			expect(parsePageMessage(value)).toBeUndefined();
	});

	it("never throws on random input (fuzz)", () => {
		let seed = 7;
		const random = () => {
			seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
			return seed / 2 ** 31;
		};
		const pick = <T>(items: T[]): T =>
			items[Math.floor(random() * items.length)] as T;
		const values = [
			null,
			undefined,
			0,
			-1,
			1.5,
			"",
			"x",
			true,
			[],
			{},
			{ a: 1 },
			BRIDGE_VERSION,
		];
		const keys = [
			"v",
			"t",
			"a",
			"g",
			"c",
			"seq",
			"k",
			"request",
			"id",
			"ok",
			"revision",
			"kind",
			"data",
		];
		const types = [
			"hello",
			"subscribe",
			"ack",
			"event",
			"status",
			"welcome",
			"credentials",
			"zzz",
		];
		for (let index = 0; index < 5_000; index += 1) {
			const value: Record<string, unknown> = {};
			for (const key of keys)
				if (random() < 0.5)
					value[key] = key === "t" ? pick(types) : pick(values);
			expect(() => parsePageMessage(value)).not.toThrow();
			expect(() => parseRuntimeMessage(value)).not.toThrow();
		}
	});
});

describe("runtime → page envelopes", () => {
	it("validates event kinds, control sequence and batched consumer lists", () => {
		expect(
			parseRuntimeMessage({
				...envelope,
				t: "event",
				c: "1",
				seq: 1,
				kind: "next",
				data: { x: 1 },
			}),
		).toBeDefined();
		expect(
			parseRuntimeMessage({
				...envelope,
				t: "event",
				c: "1",
				seq: 2,
				k: 3,
				kind: "complete",
			}),
		).toBeDefined();
		expect(
			parseRuntimeMessage({
				...envelope,
				t: "event",
				c: "1",
				seq: 2,
				kind: "complete",
			}),
		).toBeUndefined();
		expect(
			parseRuntimeMessage({
				...envelope,
				t: "event",
				c: "1",
				seq: 2,
				k: 1,
				kind: "error",
			}),
		).toBeUndefined();
		expect(
			parseRuntimeMessage({
				...envelope,
				t: "status",
				k: 1,
				c: ["1", "2"],
				connection: { state: "connected", since: 1 },
			}),
		).toBeDefined();
		expect(
			parseRuntimeMessage({
				...envelope,
				t: "status",
				k: 1,
				c: [],
				connection: { state: "connected", since: 1 },
			}),
		).toBeUndefined();
		expect(
			parseRuntimeMessage({
				...envelope,
				t: "welcome",
				runtime: "r",
				limits: {},
				adapters: [{ kind: "x", version: 1 }],
				lease: 1,
			}),
		).toBeDefined();
		expect(
			parseRuntimeMessage({
				...envelope,
				t: "welcome",
				runtime: "r",
				limits: {},
				adapters: [{ kind: 1 }],
				lease: 1,
			}),
		).toBeUndefined();
		expect(
			parseRuntimeMessage({
				...envelope,
				t: "reject",
				code: "incompatible-version",
				supported: [1],
				received: 0,
			}),
		).toBeDefined();
		expect(
			parseRuntimeMessage({
				v: 0,
				t: "welcome",
				a: "att-1",
				g: 3,
				runtime: "old",
			}),
		).toBeUndefined();
	});

	it("accepts a batched continuity with one missed count per consumer only", () => {
		const gap = { state: "gap", reason: "overflow", since: 1 };
		const batch = { ...envelope, t: "continuity", k: 2, continuity: gap };
		expect(
			parseRuntimeMessage({ ...batch, c: ["1", "2"], missed: [3, 1] }),
		).toBeDefined();
		expect(parseRuntimeMessage({ ...batch, c: ["1", "2"] })).toBeDefined();
		for (const invalid of [
			{ c: ["1", "2"], missed: [3] },
			{ c: ["1"], missed: [3, 1] },
			{ c: "1", missed: [3] },
			{ c: ["1", "2"], missed: [3, -1] },
			{ c: ["1", "2"], missed: [3, 1.5] },
			{ c: ["1", "2"], missed: [] },
			{ c: ["1", "2"], missed: "3,1" },
		]) {
			expect(parseRuntimeMessage({ ...batch, ...invalid })).toBeUndefined();
		}
	});

	it("parses the port-level announce, which carries no attachment id", () => {
		const announce = {
			v: BRIDGE_VERSION,
			t: "announce",
			runtime: "r-1",
			generation: 1,
		};
		expect(parseAnnounce(announce)).toEqual(announce);
		for (const invalid of [
			{ ...announce, v: 0 },
			{ ...announce, runtime: "" },
			{ ...announce, runtime: 7 },
			{ ...announce, generation: -1 },
			{ ...announce, t: "welcome" },
			null,
			"announce",
		]) {
			expect(parseAnnounce(invalid)).toBeUndefined();
		}
		// Not an attachment envelope: the fenced parser never accepts it.
		expect(parseRuntimeMessage(announce)).toBeUndefined();
		expect(isUnknownRuntimeType(announce)).toBe(false);
	});

	it("tells a well-formed v1 envelope of an unknown type from a foreign peer", () => {
		expect(isUnknownRuntimeType({ ...envelope, t: "future-message" })).toBe(
			true,
		);
		expect(isUnknownRuntimeType({ ...envelope, t: "toString" })).toBe(true);
		expect(
			isUnknownRuntimeType({
				...envelope,
				t: "welcome",
				runtime: "r",
				limits: {},
				adapters: [],
				lease: 1,
			}),
		).toBe(false);
		// A known type with a malformed body is still invalid, not unknown.
		expect(isUnknownRuntimeType({ ...envelope, t: "welcome" })).toBe(false);
		expect(
			isUnknownRuntimeType({ ...envelope, v: 0, t: "future-message" }),
		).toBe(false);
		expect(isUnknownRuntimeType({ hello: "not spinetab" })).toBe(false);
	});

	it("never matches a message type against an inherited object member", () => {
		for (const t of [
			"toString",
			"constructor",
			"__proto__",
			"hasOwnProperty",
		]) {
			expect(parseRuntimeMessage({ ...envelope, t })).toBeUndefined();
			expect(parsePageMessage({ ...envelope, t })).toBeUndefined();
		}
	});

	it("identifies a hello from another bridge version for a stable reject", () => {
		expect(foreignHello({ v: 0, t: "hello", a: "x", g: 1 })).toEqual({
			a: "x",
			g: 1,
			received: 0,
		});
		expect(
			foreignHello({ v: BRIDGE_VERSION, t: "hello", a: "x", g: 1 }),
		).toBeUndefined();
		expect(foreignHello({ v: 2, t: "renew", a: "x", g: 1 })).toBeUndefined();
	});
});

describe("bridge fields", () => {
	const hello = {
		t: "hello",
		page: "p",
		scope: "s",
		revision: null,
		heartbeatMs: 1,
	};

	it("accepts hello.anonymous only as true", () => {
		expect(
			parsePageMessage({ ...envelope, ...hello, anonymous: true }),
		).toBeDefined();
		for (const anonymous of [false, "true", 1, null]) {
			expect(
				parsePageMessage({ ...envelope, ...hello, anonymous }),
			).toBeUndefined();
		}
	});

	it("accepts retry with an optional consumer id", () => {
		expect(parsePageMessage({ ...envelope, t: "retry" })).toBeDefined();
		expect(parsePageMessage({ ...envelope, t: "retry", c: "7" })).toBeDefined();
		for (const c of [7, null, true, {}]) {
			expect(parsePageMessage({ ...envelope, t: "retry", c })).toBeUndefined();
		}
	});
});

describe("revisions are non-negative safe integers on the bridge", () => {
	it("refuses string, negative, fractional and unsafe revisions", () => {
		const bodies = (revision: unknown) => [
			{
				t: "hello",
				page: "p",
				scope: "s",
				revision,
				heartbeatMs: 1,
			},
			{ t: "revision", revision, restart: false },
			{ t: "credentials", id: "r", ok: true, credentials: {}, revision },
		];
		for (const revision of [
			"2026-09-27",
			"1",
			-1,
			1.5,
			Number.MAX_SAFE_INTEGER + 1,
			Number.NaN,
		]) {
			for (const body of bodies(revision)) {
				expect(
					parsePageMessage({ ...envelope, ...body }),
					`${body.t} ${String(revision)}`,
				).toBeUndefined();
			}
		}
		for (const body of bodies(0)) {
			expect(parsePageMessage({ ...envelope, ...body })).toBeDefined();
		}
		expect(
			parsePageMessage({
				...envelope,
				t: "revision",
				revision: null,
				restart: false,
			}),
		).toBeUndefined();
	});
});

describe("event metadata on the bridge", () => {
	const next = { ...envelope, t: "event", c: "c", seq: 1, kind: "next" };
	it("accepts a string event name beside eventId and refuses any other type", () => {
		expect(
			parseRuntimeMessage({ ...next, data: 1, eventId: "7", event: "price" }),
		).toMatchObject({ eventId: "7", event: "price" });
		expect(parseRuntimeMessage({ ...next, data: 1 })).toBeDefined();
		for (const event of [1, null, {}, ["price"]]) {
			expect(parseRuntimeMessage({ ...next, data: 1, event })).toBeUndefined();
		}
	});
});

describe("hello carries no credential audience", () => {
	const hello = {
		...envelope,
		t: "hello",
		page: "p",
		scope: "s",
		revision: null,
		heartbeatMs: 1,
	};

	it("the hello type has no audience field", () => {
		type Hello = Extract<PageMessage, { t: "hello" }>;
		expectTypeOf<Hello>().not.toHaveProperty("credentialOrigins");
		expectTypeOf<Hello>().not.toHaveProperty("audience");
	});

	it("the validator never reads an audience key a page adds", () => {
		// Unknown keys stay additive (older peers ignore them), so the proof is
		// that no value of such a key changes the verdict; the runtime reads the
		// audience only from its own options (runtime-origins-parity.test.ts).
		for (const value of [
			["https://evil.test"],
			"https://evil.test",
			42,
			null,
			{},
		]) {
			expect(
				parsePageMessage({ ...hello, credentialOrigins: value }),
			).toBeDefined();
			expect(parsePageMessage({ ...hello, audience: value })).toBeDefined();
		}
	});
});

describe("the replay marker on the bridge", () => {
	const subscribe = {
		t: "subscribe",
		c: "1",
		request: { adapter: "test", connection: {}, subscription: {} },
	};
	const welcome = {
		t: "welcome",
		runtime: "r",
		limits: {},
		adapters: [{ kind: "test", version: 1 }],
		lease: 1,
	};

	it("accepts subscribe.replay only as true", () => {
		expect(parsePageMessage({ ...envelope, ...subscribe })).toBeDefined();
		expect(
			parsePageMessage({ ...envelope, ...subscribe, replay: true }),
		).toBeDefined();
		for (const replay of [false, "true", 1, null]) {
			expect(
				parsePageMessage({ ...envelope, ...subscribe, replay }),
			).toBeUndefined();
		}
	});

	it("guard: a welcome with or without replay, of any value, is never dropped", () => {
		for (const extra of [{}, { replay: true }, { replay: "yes" }]) {
			expect(
				parseRuntimeMessage({ ...envelope, ...welcome, ...extra }),
			).toBeDefined();
		}
	});

	it("the bridge types carry replay on welcome and subscribe", () => {
		type Subscribe = Extract<PageMessage, { t: "subscribe" }>;
		type Welcome = Extract<RuntimeMessage, { t: "welcome" }>;
		expectTypeOf<Subscribe["replay"]>().toEqualTypeOf<true | undefined>();
		expectTypeOf<Welcome["replay"]>().toEqualTypeOf<true | undefined>();
	});
});
