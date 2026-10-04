import { afterEach, describe, expect, it } from "vitest";
import { estimateBytes } from "../../../src/core/estimate.ts";
import { createRuntime, type Runtime } from "../../../src/core/runtime.ts";
import type { RuntimeLimits } from "../../../src/core/types.ts";
import { ManualClock, settle } from "./helpers/clock.ts";
import { RawPage } from "./helpers/page.ts";
import { createTestAdapter } from "./helpers/test-adapter.ts";

// Runtime.stats().hwm high-water marks and stats({ resetHwm: true }).

const runtimes: Runtime[] = [];
afterEach(() => {
	for (const runtime of runtimes.splice(0)) runtime.dispose();
});

function setup(limits: Partial<RuntimeLimits> = {}) {
	const clock = new ManualClock();
	const test = createTestAdapter({ command: () => new Promise(() => {}) });
	const runtime = createRuntime({ adapters: [test.adapter], clock, limits });
	runtimes.push(runtime);
	return { clock, test, runtime };
}

async function page(runtime: Runtime, clock: ManualClock) {
	const raw = new RawPage(runtime);
	raw.hello();
	await settle(clock);
	return raw;
}

const ZERO = {
	pendingMessages: 0,
	pendingBytes: 0,
	perConsumerMessages: 0,
	perConsumerBytes: 0,
	pendingCommands: 0,
	controlMessages: 0,
	controlQueued: 0,
	controlQueuedBytes: 0,
	dataQueued: 0,
	dataQueuedBytes: 0,
	subscriptions: 0,
	consumersPerAttachment: 0,
	connections: 0,
};

describe("Runtime.stats().hwm", () => {
	it("starts at zero and records per-attachment, per-consumer and runtime maxima that never fall with current levels", async () => {
		const { runtime, clock, test } = setup();
		expect(runtime.stats().hwm).toEqual(ZERO);
		const one = await page(runtime, clock);
		const two = await page(runtime, clock);
		one.subscribe("x1", { subscription: { f: "x" } });
		one.subscribe("x2", { subscription: { f: "x" } });
		one.subscribe("y", { subscription: { f: "y" } });
		two.subscribe("z", {
			connection: { url: "https://example.test/other" },
			subscription: { f: "z" },
		});
		await settle(clock);
		const [feedX] = test.all();
		const event = { n: 1, text: "payload" };
		const charge = estimateBytes(event) as number;
		for (let n = 0; n < 5; n += 1) feedX?.emit(event);
		await settle(clock);
		for (let n = 0; n < 3; n += 1) {
			one.send({
				t: "command",
				id: `cmd-${n}`,
				request: {
					adapter: "test",
					connection: { url: "https://example.test/feed" },
					payload: n,
				},
				timeoutMs: 60_000,
			});
		}
		await settle(clock);
		const peak = runtime.stats().hwm;
		expect(peak).toEqual({
			// Page one: two consumers of feed x, five events each, unacknowledged.
			pendingMessages: 10,
			pendingBytes: 10 * charge,
			perConsumerMessages: 5,
			perConsumerBytes: 5 * charge,
			pendingCommands: 3,
			// Three status snapshots, none acknowledged by the raw page.
			controlMessages: 3,
			// Well inside the window: nothing waited in the outbox.
			controlQueued: 0,
			controlQueuedBytes: 0,
			dataQueued: 0,
			dataQueuedBytes: 0,
			subscriptions: 3,
			consumersPerAttachment: 3,
			connections: 2,
		});

		// Current levels fall; the marks do not.
		one.ackAll("x1");
		one.ackAll("x2");
		one.ackControl();
		one.send({ t: "unsubscribe", c: "y" });
		two.send({ t: "detach" });
		await settle(clock);
		const after = runtime.stats();
		expect(after.pendingMessages).toBe(0);
		expect(after.perAttachment[0]?.pendingControl).toBe(0);
		expect(after.hwm).toEqual(peak);
	});

	it("stats({ resetHwm: true }) returns the marks, then restarts them from the current levels", async () => {
		const { runtime, clock, test } = setup();
		const raw = await page(runtime, clock);
		raw.subscribe("a", { subscription: { f: "a" } });
		raw.subscribe("b", { subscription: { f: "b" } });
		await settle(clock);
		const [feedA] = test.all();
		for (let n = 0; n < 4; n += 1) feedA?.emit(n);
		await settle(clock);
		raw.ackAll("a");
		raw.send({ t: "unsubscribe", c: "b" });
		await settle(clock);
		clock.advance(1);
		await settle(clock);

		const reported = runtime.stats({ resetHwm: true });
		expect(reported.hwm).toMatchObject({
			pendingMessages: 4,
			perConsumerMessages: 4,
			subscriptions: 2,
			consumersPerAttachment: 2,
			controlMessages: 2,
			connections: 1,
		});
		// Restarted from what is held now: one consumer, one subscription,
		// one connection, the two unacknowledged status snapshots, no data debt.
		expect(runtime.stats().hwm).toEqual({
			...ZERO,
			controlMessages: 2,
			subscriptions: 1,
			consumersPerAttachment: 1,
			connections: 1,
		});
		feedA?.emit("again");
		await settle(clock);
		expect(runtime.stats().hwm).toMatchObject({
			pendingMessages: 1,
			perConsumerMessages: 1,
		});
		// A plain stats() call never resets.
		expect(runtime.stats().hwm.pendingMessages).toBe(1);
	});

	it("records the control high-water mark of a stalled page within the bound", async () => {
		const { runtime, clock, test } = setup({
			maxPendingMessagesPerConsumer: 1,
			maxPendingMessages: 1,
		});
		const raw = await page(runtime, clock);
		for (let c = 0; c < 40; c += 1) {
			raw.subscribe(`c${c}`, { subscription: { f: c } });
			if (c % 8 === 7) {
				await settle(clock);
				raw.ackControl();
			}
		}
		await settle(clock);
		raw.ackControl();
		await settle(clock);
		for (const upstream of test.all()) upstream.emit("one");
		for (const upstream of test.all()) upstream.emit("two");
		await settle(clock);
		const { hwm } = runtime.stats();
		expect(hwm.controlMessages).toBeGreaterThan(0);
		expect(hwm.controlMessages).toBeLessThanOrEqual(64);
		expect(hwm.pendingMessages).toBe(1);
		expect(runtime.stats().expired).toBe(0);
	});
});
