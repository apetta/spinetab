import { afterEach, describe, expect, it } from "vitest";
import { BRIDGE_VERSION } from "../../../src/core/bridge.ts";
import { createRuntime, type Runtime } from "../../../src/core/runtime.ts";
import { ManualClock, settle } from "./helpers/clock.ts";
import { RawPage } from "./helpers/page.ts";
import { createTestAdapter } from "./helpers/test-adapter.ts";

// U-RT-1 and U-RT-2 against the real runtime over MessageChannel.

const runtimes: Runtime[] = [];
function setup(
	options: Parameters<typeof createTestAdapter>[0] = {},
	limits = {},
) {
	const clock = new ManualClock();
	const test = createTestAdapter(options);
	const runtime = createRuntime({ adapters: [test.adapter], clock, limits });
	runtimes.push(runtime);
	return { clock, test, runtime };
}
afterEach(() => {
	for (const runtime of runtimes.splice(0)) runtime.dispose();
});

async function attached(runtime: Runtime, clock: ManualClock, fields = {}) {
	const page = new RawPage(runtime);
	page.hello(fields);
	await settle(clock);
	return page;
}

describe("handshake and versioning", () => {
	it("answers hello with welcome listing adapters, limits and lease", async () => {
		const { runtime, clock } = setup();
		const page = await attached(runtime, clock);
		const welcome = page.ofType("welcome")[0];
		expect(welcome).toMatchObject({
			v: BRIDGE_VERSION,
			a: page.a,
			g: 1,
			runtime: runtime.id,
			adapters: [{ kind: "test", version: 1 }],
			lease: 180_000,
		});
		expect(welcome?.limits.maxPendingMessages).toBe(256);
		expect(welcome?.limits.credentialTimeoutMs).toBe(5_000);
	});

	it("rejects another bridge version with a stable reject and serves nothing", async () => {
		const { runtime, clock, test } = setup();
		const page = new RawPage(runtime);
		page.send(
			{ t: "hello", page: "p", scope: "", revision: null, heartbeatMs: 1 },
			{ v: 0 },
		);
		page.send({
			t: "subscribe",
			c: "1",
			request: { adapter: "test", connection: {}, subscription: {} },
		});
		await settle(clock);
		expect(page.raw[0]).toMatchObject({ t: "announce", runtime: runtime.id });
		expect(page.raw[1]).toEqual({
			v: BRIDGE_VERSION,
			t: "reject",
			a: page.a,
			g: 1,
			code: "incompatible-version",
			supported: [1],
			received: 0,
		});
		expect(test.all()).toHaveLength(0);
		expect(runtime.stats().attachments).toBe(0);
		expect(runtime.stats().staleMessages).toBe(1);
	});

	it("keeps serving other attachments when one page has an incompatible version", async () => {
		const { runtime, clock, test } = setup();
		const good = await attached(runtime, clock);
		good.subscribe("1", {});
		const bad = new RawPage(runtime);
		bad.send({ t: "hello" }, { v: 7 });
		await settle(clock);
		test.last().emit({ n: 1 });
		await settle(clock);
		expect(good.data("1")).toEqual([{ n: 1 }]);
	});

	it("rejects duplicate adapter kinds and malformed definitions at construction", () => {
		const one = createTestAdapter();
		expect(() =>
			createRuntime({ adapters: [one.adapter, one.adapter] }),
		).toThrowError(expect.objectContaining({ code: "unsupported-option" }));
		expect(() =>
			createRuntime({ adapters: [{ kind: "", version: 1 } as never] }),
		).toThrowError(expect.objectContaining({ code: "unsupported-option" }));
		expect(() =>
			createRuntime({ adapters: [], limits: { maxPendingBytes: 0 } }),
		).toThrowError(expect.objectContaining({ code: "unsupported-option" }));
	});

	it("fails an unknown adapter with adapter-not-registered on that request only", async () => {
		const { runtime, clock } = setup();
		const page = await attached(runtime, clock);
		page.subscribe("1", { adapter: "nope" });
		await settle(clock);
		expect(page.ofType("error")[0]).toMatchObject({
			c: "1",
			code: "adapter-not-registered",
		});
		expect(runtime.stats().attachments).toBe(1);
	});

	it("validates connection options with a path and rejects relative endpoints", async () => {
		const { runtime, clock } = setup({ strict: true });
		const page = await attached(runtime, clock);
		page.subscribe("1", { connection: { url: "https://x.test", bogus: 1 } });
		page.subscribe("2", { connection: { url: "/relative" } });
		page.subscribe("3", { connection: { url: "https://u:p@x.test/" } });
		await settle(clock);
		const errors = page.ofType("error");
		expect(errors[0]).toMatchObject({
			c: "1",
			code: "unsupported-option",
			detail: { path: "connection.bogus" },
		});
		expect(errors[1]).toMatchObject({ c: "2", code: "invalid-endpoint" });
		expect(errors[2]).toMatchObject({ c: "3", code: "invalid-endpoint" });
	});

	it("drops invalid envelopes and counts them without breaking the port", async () => {
		const { runtime, clock } = setup();
		const page = await attached(runtime, clock);
		page.port.postMessage({ nonsense: true });
		page.port.postMessage("text");
		page.send({ t: "subscribe", c: 5 });
		page.subscribe("1", {});
		await settle(clock);
		expect(runtime.stats().invalidEnvelopes).toBe(3);
		expect(page.ofType("status")).toHaveLength(1);
	});
});

describe("identity, references and lifetime", () => {
	it("shares one upstream subscription for identical requests and separates different ones", async () => {
		const { runtime, clock, test } = setup();
		const a = await attached(runtime, clock);
		const b = await attached(runtime, clock);
		a.subscribe("1", { subscription: { topic: "x", opts: { b: 1, a: 2 } } });
		b.subscribe("1", { subscription: { opts: { a: 2, b: 1 }, topic: "x" } });
		b.subscribe("2", { subscription: { topic: "y" } });
		await settle(clock);
		expect(test.connections).toHaveLength(1);
		expect(test.all()).toHaveLength(2);
		const shared = test.all()[0];
		expect(shared?.consumers.size).toBe(2);
		shared?.emit("tick");
		await settle(clock);
		expect(a.data("1")).toEqual(["tick"]);
		expect(b.data("1")).toEqual(["tick"]);
		expect(b.data("2")).toEqual([]);
	});

	it("splits connection groups by scope and endpoint", async () => {
		const { runtime, clock, test } = setup();
		const alice = await attached(runtime, clock, { scope: "alice" });
		const bob = await attached(runtime, clock, { scope: "bob" });
		alice.subscribe("1", {});
		bob.subscribe("1", {});
		alice.subscribe("2", { connection: { url: "https://example.test/other" } });
		await settle(clock);
		expect(test.connections).toHaveLength(3);
		expect(
			new Set(test.connections.map((connection) => connection.ctx.scope)),
		).toEqual(new Set(["alice", "bob"]));
		expect(
			test.connections.every(
				(connection) => !connection.ctx.key.includes("secret"),
			),
		).toBe(true);
	});

	it("gives unshareable and non-repeatable requests separate upstream work", async () => {
		const { runtime, clock, test } = setup({
			shareable: (spec) => (spec as { share?: boolean }).share !== false,
		});
		const page = await attached(runtime, clock);
		page.subscribe("1", { subscription: { share: false } });
		page.subscribe("2", { subscription: { share: false } });
		page.subscribe("3", { subscription: {}, repeatable: false });
		page.subscribe("4", { subscription: {} });
		await settle(clock);
		expect(test.all()).toHaveLength(4);
		expect(test.all()[2]?.repeatable).toBe(false);
		expect(test.all()[3]?.repeatable).toBe(true);
		expect(
			page.ofType("status").find((status) => status.c === "3")?.repeatable,
		).toBe(false);
	});

	it("rejects uncanonicalisable identity instead of a partial key", async () => {
		const { runtime, clock, test } = setup();
		const page = await attached(runtime, clock);
		page.subscribe("1", { subscription: { when: new Date(0) } });
		const holed: number[] = [];
		holed[0] = 1;
		holed[2] = 3;
		page.subscribe("2", { subscription: { list: holed } });
		await settle(clock);
		expect(page.ofType("error").map((error) => error.code)).toEqual([
			"unsupported-option",
			"unsupported-option",
		]);
		expect(test.all()).toHaveLength(0);
	});

	it("starts once for concurrent joiners and treats duplicate registration idempotently", async () => {
		const { runtime, clock, test } = setup();
		const pages = await Promise.all(
			[1, 2, 3].map(() => attached(runtime, clock)),
		);
		for (const page of pages) page.subscribe("1", {});
		pages[0]?.subscribe("1", {});
		await settle(clock);
		expect(test.all()).toHaveLength(1);
		expect(test.last().consumers.size).toBe(3);
		expect(runtime.stats().consumers).toBe(3);
	});

	it("keeps upstream when a non-final consumer leaves and stops it after the linger", async () => {
		const { runtime, clock, test } = setup();
		const a = await attached(runtime, clock);
		const b = await attached(runtime, clock);
		a.subscribe("1", {});
		b.subscribe("1", {});
		await settle(clock);
		a.send({ t: "unsubscribe", c: "1" });
		a.send({ t: "unsubscribe", c: "1" });
		await settle(clock);
		const upstream = test.last();
		expect(upstream.unsubscribed).toBe(false);
		upstream.emit("still");
		await settle(clock);
		expect(b.data("1")).toEqual(["still"]);
		expect(b.continuity("1")).toHaveLength(0);
		b.send({ t: "unsubscribe", c: "1" });
		await settle(clock);
		expect(upstream.unsubscribed).toBe(true);
		expect(runtime.stats().subscriptions).toBe(0);
	});

	it("absorbs unsubscribe-then-resubscribe churn within one macrotask linger", async () => {
		const { runtime, clock, test } = setup();
		const page = await attached(runtime, clock);
		page.subscribe("1", {});
		await settle(clock);
		page.send({ t: "unsubscribe", c: "1" });
		page.subscribe("2", {});
		await settle(clock);
		expect(test.all()).toHaveLength(1);
		expect(test.last().unsubscribed).toBe(false);
		expect([...test.last().consumers.keys()]).toEqual([`${page.a}/2`]);
	});

	it("does not deliver linger-window events and joins a lingering upstream as a new consumer", async () => {
		const { runtime, clock, test } = setup({}, { lingerMs: 1_000 });
		const page = await attached(runtime, clock);
		page.subscribe("1", {});
		await settle(clock);
		page.send({ t: "unsubscribe", c: "1" });
		await settle(clock);
		test.last().emit("during-linger");
		page.subscribe("2", {});
		await settle(clock);
		test.last().emit("after-join");
		await settle(clock);
		expect(page.data("2")).toEqual(["after-join"]);
		expect(test.all()).toHaveLength(1);
	});

	it("closes an unused connection after the idle timeout and reuses it within the window", async () => {
		const { runtime, clock, test } = setup({}, { idleCloseMs: 5_000 });
		const page = await attached(runtime, clock);
		page.subscribe("1", {});
		await settle(clock);
		page.send({ t: "unsubscribe", c: "1" });
		await settle(clock);
		clock.advance(4_000);
		page.subscribe("2", {});
		await settle(clock);
		clock.advance(10_000);
		expect(test.connections).toHaveLength(1);
		expect(test.connections[0]?.disposed).toBe(false);
		page.send({ t: "unsubscribe", c: "2" });
		await settle(clock);
		clock.advance(4_999);
		expect(test.connections[0]?.disposed).toBe(false);
		clock.advance(1);
		expect(test.connections[0]?.disposed).toBe(true);
		expect(test.connections[0]?.ctx.signal.aborted).toBe(true);
		expect(runtime.stats().connections).toBe(0);
	});

	it("honours adapter idleCloseMs capped at 60 s", async () => {
		const { runtime, clock, test } = setup({ idleCloseMs: 120_000 });
		const page = await attached(runtime, clock);
		page.subscribe("1", {});
		await settle(clock);
		page.send({ t: "unsubscribe", c: "1" });
		await settle(clock);
		clock.advance(59_999);
		expect(test.connections[0]?.disposed).toBe(false);
		clock.advance(1);
		expect(test.connections[0]?.disposed).toBe(true);
	});

	it("fans out completion and errors after prior data, releases and starts fresh next time", async () => {
		const { runtime, clock, test } = setup();
		const a = await attached(runtime, clock);
		const b = await attached(runtime, clock);
		a.subscribe("1", {});
		b.subscribe("1", {});
		await settle(clock);
		const first = test.last();
		first.emit(1);
		first.sink.complete();
		first.emit(2);
		await settle(clock);
		for (const page of [a, b]) {
			expect(page.events("1").map((event) => event.kind)).toEqual([
				"next",
				"complete",
			]);
			expect(page.events("1").map((event) => event.seq)).toEqual([1, 2]);
		}
		expect(runtime.stats().subscriptions).toBe(0);
		a.subscribe("2", {});
		await settle(clock);
		expect(test.all()).toHaveLength(2);
		test.last().sink.error({ code: "upstream-error", message: "boom" });
		await settle(clock);
		expect(a.events("2").at(-1)).toMatchObject({
			kind: "error",
			error: { code: "upstream-error", message: "boom" },
		});
	});

	it("reports a synchronous subscribe failure as terminal for the joined consumer", async () => {
		const clock = new ManualClock();
		const runtime = createRuntime({
			clock,
			adapters: [
				{
					kind: "test",
					version: 1,
					connect: () => ({
						subscribe: () => {
							throw new Error("refused");
						},
						dispose: () => {},
					}),
				},
			],
		});
		runtimes.push(runtime);
		const page = await attached(runtime, clock);
		page.subscribe("1", {});
		await settle(clock);
		expect(page.events("1")[0]).toMatchObject({
			kind: "error",
			error: { code: "subscribe-rejected" },
		});
		expect(runtime.stats().subscriptions).toBe(0);
	});

	it("rejects before-start joiners after the stream started (share: before-start)", async () => {
		const { runtime, clock, test } = setup();
		const page = await attached(runtime, clock);
		page.subscribe("1", { share: "before-start" });
		page.subscribe("2", { share: "before-start" });
		await settle(clock);
		expect(test.all()).toHaveLength(1);
		test.last().sink.started();
		page.subscribe("3", { share: "before-start" });
		await settle(clock);
		expect(page.ofType("error")[0]).toMatchObject({
			c: "3",
			code: "late-join-unsupported",
		});
	});

	it("gives a late joiner only future events (no last-result cache)", async () => {
		const { runtime, clock, test } = setup();
		const page = await attached(runtime, clock);
		page.subscribe("1", {});
		await settle(clock);
		test.last().emit("early");
		await settle(clock);
		page.subscribe("2", {});
		await settle(clock);
		test.last().emit("late");
		await settle(clock);
		expect(page.data("1")).toEqual(["early", "late"]);
		expect(page.data("2")).toEqual(["late"]);
		expect(
			page.ofType("status").find((status) => status.c === "2"),
		).toBeDefined();
	});

	it("enforces consumer, subscription and connection caps with limit-exceeded", async () => {
		const { runtime, clock } = setup(
			{},
			{ maxConsumersPerAttachment: 2, maxSubscriptions: 3, maxConnections: 2 },
		);
		const page = await attached(runtime, clock);
		page.subscribe("1", { subscription: { n: 1 } });
		page.subscribe("2", { subscription: { n: 2 } });
		page.subscribe("3", { subscription: { n: 3 } });
		await settle(clock);
		expect(page.ofType("error")[0]).toMatchObject({
			c: "3",
			code: "limit-exceeded",
			detail: { limit: "maxConsumersPerAttachment" },
		});
		const other = await attached(runtime, clock);
		other.subscribe("1", { connection: { url: "https://b.test" } });
		other.subscribe("2", { connection: { url: "https://c.test" } });
		await settle(clock);
		expect(other.ofType("error")[0]).toMatchObject({
			c: "2",
			code: "limit-exceeded",
			detail: { limit: "maxConnections" },
		});
	});

	it("passes consumer options, updates and visibility to the adapter and validates them", async () => {
		const { runtime, clock, test } = setup({ consumerCheck: true });
		const page = await attached(runtime, clock, { visible: false });
		page.subscribe("1", {}, { weight: 1 });
		page.subscribe("2", {}, { weight: "heavy" });
		await settle(clock);
		const upstream = test.last();
		expect(upstream.consumers.get(`${page.a}/1`)).toEqual({
			options: { weight: 1 },
			visible: false,
		});
		expect(page.ofType("error")[0]).toMatchObject({
			c: "2",
			code: "unsupported-option",
		});
		page.send({ t: "update", c: "1", consumer: { weight: 3 } });
		page.send({ t: "visibility", visible: true });
		await settle(clock);
		expect(upstream.consumers.get(`${page.a}/1`)).toEqual({
			options: { weight: 3 },
			visible: true,
		});
		page.send({ t: "update", c: "1", consumer: { weight: "x" } });
		await settle(clock);
		expect(page.ofType("error")[1]).toMatchObject({
			c: "1",
			code: "unsupported-option",
		});
	});

	it("keeps registry sizes at baseline after many subscribe/unsubscribe cycles", async () => {
		const { runtime, clock, test } = setup();
		const page = await attached(runtime, clock);
		for (let cycle = 0; cycle < 200; cycle += 1) {
			page.subscribe(`c${cycle}`, { subscription: { id: cycle % 10 } });
			page.send({ t: "unsubscribe", c: `c${cycle}` });
		}
		await settle(clock);
		clock.advance(10_000);
		const stats = runtime.stats();
		expect(stats.consumers).toBe(0);
		expect(stats.ledgers).toBe(0);
		expect(stats.subscriptions).toBe(0);
		expect(stats.connections).toBe(0);
		expect(test.active()).toHaveLength(0);
	});
});

describe("the replay marker on the runtime", () => {
	const INTERRUPTED =
		"The runtime was replaced and this subscription cannot be restarted automatically; its outcome is unknown.";

	const replay = (
		page: RawPage,
		c: string,
		request: Record<string, unknown> = {},
		marker: unknown = true,
	) =>
		page.send({
			t: "subscribe",
			c,
			request: {
				adapter: "test",
				connection: { url: "https://example.test/feed" },
				subscription: {},
				...request,
			},
			replay: marker,
		});

	it("the welcome advertises that the runtime honours the marker", async () => {
		const { runtime, clock } = setup();
		const page = await attached(runtime, clock);
		expect(page.ofType("welcome")[0]).toMatchObject({ replay: true });
	});

	it("a replayed subscribe for an adapter-default non-repeatable request ends interrupted before any upstream work", async () => {
		const { runtime, clock, test } = setup({ repeatable: () => false });
		const page = await attached(runtime, clock);
		replay(page, "1");
		await settle(clock);
		expect(page.ofType("error")).toEqual([
			expect.objectContaining({
				c: "1",
				code: "interrupted",
				message: INTERRUPTED,
			}),
		]);
		expect(page.ofType("status")).toHaveLength(0);
		expect(test.connections).toHaveLength(0);
		expect(runtime.stats()).toMatchObject({ consumers: 0, subscriptions: 0 });
		// The page answers the error with an unsubscribe: nothing to release.
		page.send({ t: "unsubscribe", c: "1" });
		await settle(clock);
		expect(runtime.stats()).toMatchObject({
			consumers: 0,
			invalidEnvelopes: 0,
		});
	});

	it("a replayed subscribe with an explicit repeatable: false ends the same way", async () => {
		const { runtime, clock, test } = setup();
		const page = await attached(runtime, clock);
		replay(page, "1", { repeatable: false });
		await settle(clock);
		expect(page.ofType("error")).toEqual([
			expect.objectContaining({
				c: "1",
				code: "interrupted",
				message: INTERRUPTED,
			}),
		]);
		expect(test.connections).toHaveLength(0);
	});

	it("guard: a replayed subscribe for a repeatable request proceeds as a plain subscribe", async () => {
		const { runtime, clock, test } = setup();
		const page = await attached(runtime, clock);
		replay(page, "1");
		await settle(clock);
		expect(page.ofType("error")).toHaveLength(0);
		expect(page.ofType("status")[0]).toMatchObject({
			c: "1",
			repeatable: true,
		});
		expect(test.active()).toHaveLength(1);
		expect(runtime.stats().consumers).toBe(1);
	});

	it("guard: without the marker a non-repeatable first subscribe starts upstream work", async () => {
		const { runtime, clock, test } = setup({ repeatable: () => false });
		const page = await attached(runtime, clock);
		page.subscribe("1", {});
		await settle(clock);
		expect(page.ofType("error")).toHaveLength(0);
		expect(page.ofType("status")[0]).toMatchObject({
			c: "1",
			repeatable: false,
		});
		expect(test.active()).toHaveLength(1);
	});

	it("guard: validation errors keep precedence over the marker", async () => {
		const { runtime, clock } = setup({ repeatable: () => false });
		const page = await attached(runtime, clock);
		replay(page, "1", { adapter: "nope" });
		await settle(clock);
		expect(page.ofType("error")[0]).toMatchObject({
			c: "1",
			code: "adapter-not-registered",
		});
	});

	it("a malformed marker is dropped and counted like any malformed field", async () => {
		const { runtime, clock, test } = setup({ repeatable: () => false });
		const page = await attached(runtime, clock);
		replay(page, "1", {}, "yes");
		await settle(clock);
		expect(page.ofType("error")).toHaveLength(0);
		expect(test.connections).toHaveLength(0);
		expect(runtime.stats().invalidEnvelopes).toBe(1);
	});
});
