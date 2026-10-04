import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../../src/core/runtime.ts";
import { ManualClock, settle } from "./helpers/clock.ts";
import { RawPage } from "./helpers/page.ts";
import { createTestAdapter } from "./helpers/test-adapter.ts";

// Runtime behaviour under lifecycle and message-order changes.

const runtimes: Runtime[] = [];
afterEach(() => {
	for (const runtime of runtimes.splice(0)) runtime.dispose();
});

function setup(leaseMs = 180_000) {
	const clock = new ManualClock();
	const test = createTestAdapter();
	const runtime = createRuntime({
		adapters: [test.adapter],
		clock,
		limits: { leaseMs },
		// History opt-in: these tests read `stats().diagnostics`.
		diagnostics: () => undefined,
	});
	runtimes.push(runtime);
	return { clock, test, runtime };
}

async function page(runtime: Runtime, clock: ManualClock, fields = {}) {
	const raw = new RawPage(runtime);
	raw.hello(fields);
	await settle(clock);
	return raw;
}

describe("leases", () => {
	it("expires an abandoned attachment after the lease and releases its upstream work", async () => {
		const { clock, test, runtime } = setup(60_000);
		const gone = await page(runtime, clock);
		const alive = await page(runtime, clock);
		gone.subscribe("1", { subscription: { f: "gone" } });
		alive.subscribe("1", { subscription: { f: "alive" } });
		await settle(clock);
		for (let step = 0; step < 6; step += 1) {
			clock.advance(15_000);
			alive.send({ t: "renew" });
			await settle(clock);
		}
		expect(gone.ofType("detached")[0]).toMatchObject({ code: "lease-expired" });
		expect(runtime.stats().attachments).toBe(1);
		expect(test.all()[0]?.unsubscribed).toBe(true);
		expect(test.all()[1]?.unsubscribed).toBe(false);
		expect(alive.ofType("detached")).toHaveLength(0);
		expect(
			runtime
				.stats()
				.diagnostics.some((event) => event.type === "attachment-expired"),
		).toBe(true);
	});

	it("honours a shorter page lease and never a longer one", async () => {
		const { clock, runtime } = setup(60_000);
		const short = await page(runtime, clock, { lease: 3_000 });
		const long = await page(runtime, clock, { lease: 600_000 });
		expect(short.ofType("welcome")[0]?.lease).toBe(3_000);
		expect(long.ofType("welcome")[0]?.lease).toBe(60_000);
		clock.advance(3_000);
		await settle(clock);
		expect(short.ofType("detached")[0]).toMatchObject({
			code: "lease-expired",
		});
		expect(long.ofType("detached")).toHaveLength(0);
	});

	it("does not expire attachments across a scheduling gap (suspension)", async () => {
		const { clock, runtime } = setup(60_000);
		const raw = await page(runtime, clock);
		clock.jump(10 * 60_000);
		clock.advance(0);
		await settle(clock);
		expect(raw.ofType("detached")).toHaveLength(0);
		expect(
			runtime
				.stats()
				.diagnostics.some((event) => event.type === "scheduling-gap"),
		).toBe(true);
		clock.advance(60_000);
		await settle(clock);
		expect(raw.ofType("detached")[0]).toMatchObject({ code: "lease-expired" });
	});

	it("releases an attachment when its port closes (hint) and ignores later unsubscribes", async () => {
		const { clock, test, runtime } = setup();
		const raw = await page(runtime, clock);
		raw.subscribe("1", {});
		await settle(clock);
		raw.close();
		await settle(clock);
		expect(runtime.stats().attachments).toBe(0);
		expect(test.last().unsubscribed).toBe(true);
	});
});

describe("fencing by attachment and generation", () => {
	it("drops every message type from a stale generation before any side effect", async () => {
		const { clock, test, runtime } = setup();
		const raw = await page(runtime, clock, { credentials: true });
		raw.subscribe("1", {});
		await settle(clock);
		const upstream = test.last();
		for (let n = 1; n <= 3; n += 1) upstream.emit(n);
		await settle(clock);
		const before = runtime.stats();
		const stale = { g: 0 };
		const bodies = [
			{
				t: "subscribe",
				c: "9",
				request: {
					adapter: "test",
					connection: { url: "https://x.test/feed" },
					subscription: { other: 1 },
				},
			},
			{ t: "unsubscribe", c: "1" },
			{ t: "update", c: "1", consumer: { x: 1 } },
			{ t: "ack", c: "1", seq: 3 },
			{ t: "ack", k: 99 },
			{ t: "reconcile", c: "1" },
			{
				t: "command",
				id: "x",
				request: { adapter: "test", connection: {}, payload: 1 },
				timeoutMs: 10,
			},
			{ t: "cancel", id: "x" },
			{
				t: "credentials",
				id: "x",
				ok: true,
				credentials: { token: "old" },
				revision: 1,
			},
			{ t: "revision", revision: 9, restart: true },
			{ t: "probe", id: "p" },
			{ t: "retry" },
			{ t: "visibility", visible: false },
			{ t: "detach" },
		];
		for (const body of bodies) raw.send(body, stale);
		for (const body of bodies) raw.send(body, { a: "someone-else" });
		await settle(clock);
		const after = runtime.stats();
		expect(after.staleMessages - before.staleMessages).toBe(bodies.length * 2);
		expect(after.consumers).toBe(1);
		expect(after.pendingMessages).toBe(3);
		expect(after.attachments).toBe(1);
		expect(upstream.consumers.get(`${raw.a}/1`)).toEqual({
			options: undefined,
			visible: true,
		});
		expect(test.connections[0]?.rotations).toBe(0);
		expect(raw.ofType("probeResult")).toHaveLength(0);
		// A stale sender is told once that its attachment is gone.
		expect(
			raw.ofType("detached").filter((message) => message.a === "someone-else"),
		).toHaveLength(1);
		upstream.emit(4);
		await settle(clock);
		expect(raw.data("1")).toEqual([1, 2, 3, 4]);
	});

	it("treats a new hello on the same port as a new attachment and retires the old one", async () => {
		const { clock, test, runtime } = setup();
		const raw = await page(runtime, clock);
		raw.subscribe("1", {});
		await settle(clock);
		raw.g = 2;
		raw.hello();
		await settle(clock);
		expect(runtime.stats()).toMatchObject({ attachments: 1, consumers: 0 });
		expect(test.last().unsubscribed).toBe(true);
	});
});
