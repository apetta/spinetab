import { afterEach, describe, expect, it } from "vitest";
import { consumerIds } from "../../../src/core/bridge-page.ts";
import { estimateBytes } from "../../../src/core/estimate.ts";
import { createRuntime, type Runtime } from "../../../src/core/runtime.ts";
import type { RuntimeLimits } from "../../../src/core/types.ts";
import { ManualClock, settle } from "./helpers/clock.ts";
import { RawPage } from "./helpers/page.ts";
import {
	createTestAdapter,
	type TestSubscription,
} from "./helpers/test-adapter.ts";

// Real bridge coverage for projected admission, UTF-8 and backing-buffer
// charging, aggregate budgets, clone failures and acknowledgement accounting.

const MIB = 1024 * 1024;
const runtimes: Runtime[] = [];
afterEach(() => {
	for (const runtime of runtimes.splice(0)) runtime.dispose();
});

function setup(limits: Partial<RuntimeLimits> = {}) {
	const clock = new ManualClock();
	const test = createTestAdapter();
	const runtime = createRuntime({
		adapters: [test.adapter],
		clock,
		limits,
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

const gapReasons = (raw: RawPage, c: string) =>
	raw
		.continuity(c)
		.map((message) => [message.continuity.reason, message.continuity.missed]);

/** The latest gap notice for `c`, single or batched (`missed[i]` for `c[i]`). */
function latestGap(raw: RawPage, c: string) {
	let found: { reason?: string; missed?: number; batched: boolean } | undefined;
	for (const message of raw.ofType("continuity")) {
		const index = consumerIds(message.c).indexOf(c);
		if (index === -1) continue;
		found = {
			...(message.continuity.reason === undefined
				? {}
				: { reason: message.continuity.reason }),
			...((message.missed?.[index] ?? message.continuity.missed) === undefined
				? {}
				: {
						missed: (message.missed?.[index] ??
							message.continuity.missed) as number,
					}),
			batched: Array.isArray(message.c),
		};
	}
	return found;
}

/** Gap notices (`gap:<missed>`) and terminal events for `c`, in arrival order. */
function timeline(raw: RawPage, c: string): string[] {
	return raw.received.flatMap((message) => {
		if (message.t === "continuity") {
			const index = consumerIds(message.c).indexOf(c);
			if (index === -1) return [];
			return [`gap:${message.missed?.[index] ?? message.continuity.missed}`];
		}
		if (message.t === "event" && message.c === c && message.kind !== "next") {
			return [message.kind];
		}
		return [];
	});
}

describe("credit window and acknowledgements", () => {
	it("keeps per-consumer order and releases records with cumulative acks", async () => {
		const { runtime, clock, test } = setup();
		const raw = await page(runtime, clock);
		raw.subscribe("1", {});
		await settle(clock);
		for (let n = 1; n <= 5; n += 1) test.last().emit(n);
		await settle(clock);
		expect(raw.events("1").map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
		expect(runtime.stats().pendingMessages).toBe(5);
		raw.send({ t: "ack", c: "1", seq: 3 });
		await settle(clock);
		expect(runtime.stats().pendingMessages).toBe(2);
		raw.send({ t: "ack", c: "1", seq: 99 });
		raw.send({ t: "ack", c: "1", seq: 1 });
		await settle(clock);
		expect(runtime.stats().pendingMessages).toBe(0);
		expect(runtime.stats().pendingBytes).toBe(0);
	});

	it("never posts beyond the per-consumer count window while acks are withheld", async () => {
		const { runtime, clock, test } = setup({
			maxPendingMessagesPerConsumer: 4,
			maxPendingMessages: 8,
		});
		const raw = await page(runtime, clock);
		raw.subscribe("1", {});
		await settle(clock);
		for (let n = 1; n <= 20; n += 1) test.last().emit(n);
		await settle(clock);
		expect(raw.data("1")).toEqual([1, 2, 3, 4]);
		expect(runtime.stats().pendingMessages).toBe(4);
		expect(gapReasons(raw, "1")[0]).toEqual(["overflow", 1]);
	});

	it("uses projected admission: a message within maxMessageBytes that crosses the remaining window overflows", async () => {
		const small = { text: "a".repeat(40) };
		const large = { text: "b".repeat(70) };
		const smallBytes = estimateBytes(small) as number;
		const largeBytes = estimateBytes(large) as number;
		const window = smallBytes + largeBytes - 1;
		const { runtime, clock, test } = setup({
			maxMessageBytes: largeBytes,
			maxPendingBytesPerConsumer: window,
			maxPendingBytes: window,
		});
		const raw = await page(runtime, clock);
		raw.subscribe("1", {});
		await settle(clock);
		test.last().emit(small);
		test.last().emit(large);
		await settle(clock);
		// pending (smallBytes) < window, and large fits maxMessageBytes, but the
		// projected total exceeds the window: overflow, not a post.
		expect(raw.data("1")).toEqual([small]);
		expect(gapReasons(raw, "1")[0]).toEqual(["overflow", 1]);
		expect(runtime.stats().pendingBytes).toBe(smallBytes);
	});

	it("charges multi-byte strings by UTF-8 length so they cannot evade the byte window", async () => {
		const emoji = "🙂".repeat(20_000);
		expect(new TextEncoder().encode(emoji).byteLength).toBe(80_000);
		const { runtime, clock, test } = setup({
			maxMessageBytes: 60_000,
			maxPendingBytesPerConsumer: 60_000,
			maxPendingBytes: 60_000,
		});
		const raw = await page(runtime, clock);
		raw.subscribe("1", {});
		await settle(clock);
		test.last().emit(emoji);
		await settle(clock);
		expect(raw.data("1")).toEqual([]);
		expect(gapReasons(raw, "1")[0]?.[0]).toBe("message-too-large");
	});
});

describe("aggregate budget and posted debt", () => {
	it("keeps posted debt after unsubscribe and releases it only by acknowledgement", async () => {
		const { runtime, clock, test } = setup();
		const raw = await page(runtime, clock);
		raw.subscribe("1", {});
		await settle(clock);
		for (let n = 1; n <= 3; n += 1) test.last().emit(n);
		await settle(clock);
		raw.send({ t: "unsubscribe", c: "1" });
		await settle(clock);
		expect(runtime.stats()).toMatchObject({
			consumers: 0,
			ledgers: 1,
			pendingMessages: 3,
		});
		raw.send({ t: "ack", c: "1", seq: 2 });
		await settle(clock);
		expect(runtime.stats()).toMatchObject({ ledgers: 1, pendingMessages: 1 });
		raw.send({ t: "ack", c: "1", seq: 3 });
		await settle(clock);
		expect(runtime.stats()).toMatchObject({ ledgers: 0, pendingMessages: 0 });
	});

	it("never gives a stalled port with rotating consumers a fresh aggregate window", async () => {
		const { runtime, clock, test } = setup({
			maxPendingMessages: 6,
			maxPendingMessagesPerConsumer: 2,
		});
		const stalled = await page(runtime, clock);
		const healthy = await page(runtime, clock);
		healthy.subscribe("h", {});
		for (let round = 0; round < 8; round += 1) {
			const c = `r${round}`;
			stalled.subscribe(c, {});
			await settle(clock);
			test.last().emit(round);
			test.last().emit(round);
			await settle(clock);
			stalled.send({ t: "unsubscribe", c });
			healthy.ackAll("h");
			await settle(clock);
		}
		// Adversarial MessageChannel case: every posted message really arrived
		// at the stalled page although its consumers were removed, and the
		// runtime still counts them, capped by the aggregate.
		expect(
			stalled.events().filter((event) => event.kind === "next"),
		).toHaveLength(6);
		const stalledStats = runtime
			.stats()
			.perAttachment.find((entry) => entry.a === stalled.a);
		expect(stalledStats?.pendingMessages).toBe(6);
		expect(healthy.data("h")).toHaveLength(16);
		// Later consumers overflowed at once instead of opening a fresh window.
		expect(stalled.continuity("r3")[0]?.continuity).toMatchObject({
			state: "gap",
			reason: "overflow",
		});
		expect(stalled.data("r7")).toEqual([]);
		// Acknowledging after the unsubscribes drains the debt.
		for (let round = 0; round < 3; round += 1) stalled.ackAll(`r${round}`);
		await settle(clock);
		expect(
			runtime.stats().perAttachment.find((entry) => entry.a === stalled.a)
				?.pendingMessages,
		).toBe(0);
	});

	it("overflows only the consumer whose per-consumer cap or the page aggregate is exhausted", async () => {
		const { runtime, clock, test } = setup({
			maxPendingMessages: 5,
			maxPendingMessagesPerConsumer: 3,
		});
		const one = await page(runtime, clock);
		const two = await page(runtime, clock);
		one.subscribe("a", { subscription: { f: "a" } });
		one.subscribe("b", { subscription: { f: "b" } });
		two.subscribe("a", { subscription: { f: "a" } });
		await settle(clock);
		const [feedA, feedB] = test.all();
		for (let n = 0; n < 4; n += 1) feedA?.emit(n);
		await settle(clock);
		expect(one.data("a")).toEqual([0, 1, 2]);
		expect(two.data("a")).toEqual([0, 1, 2]);
		for (let n = 0; n < 3; n += 1) feedB?.emit(n);
		await settle(clock);
		// Aggregate 5 on page one: 3 (a) + 2 (b) then b overflows.
		expect(one.data("b")).toEqual([0, 1]);
		expect(one.continuity("b")[0]?.continuity.reason).toBe("overflow");
		expect(two.continuity("b")).toHaveLength(0);
	});

	it("drops later events for an overflowed consumer, counts them and retains nothing", async () => {
		const { runtime, clock, test } = setup({
			maxPendingMessagesPerConsumer: 2,
			maxPendingMessages: 4,
			maxControlMessages: 64,
		});
		const stalled = await page(runtime, clock);
		const healthy = await page(runtime, clock);
		stalled.subscribe("1", {});
		healthy.subscribe("1", {});
		await settle(clock);
		for (let n = 1; n <= 10; n += 1) {
			test.last().emit({ n, blob: "x".repeat(100) });
			healthy.ackAll("1");
			healthy.ackControl();
			await settle(clock);
		}
		expect(healthy.data("1")).toHaveLength(10);
		expect(healthy.continuity("1")).toHaveLength(0);
		expect(stalled.data("1")).toHaveLength(2);
		// One unacknowledged notice at a time: the count is coalesced.
		expect(stalled.continuity("1")).toHaveLength(1);
		expect(
			runtime.stats().perAttachment.find((entry) => entry.a === stalled.a)
				?.pendingMessages,
		).toBe(2);
		stalled.ackControl();
		await settle(clock);
		const notices = stalled.continuity("1");
		expect(notices).toHaveLength(2);
		const delivered = stalled.data("1").length;
		const missed = notices.at(-1)?.continuity.missed ?? 0;
		expect(delivered + missed).toBe(10);
	});

	it("restarts delivery after reconcile in a new epoch while old debt stays until acked", async () => {
		const { runtime, clock, test } = setup({
			maxPendingMessagesPerConsumer: 2,
			maxPendingMessages: 2,
		});
		const raw = await page(runtime, clock);
		raw.subscribe("1", {});
		await settle(clock);
		for (let n = 1; n <= 3; n += 1) test.last().emit(n);
		await settle(clock);
		raw.send({ t: "reconcile", c: "1" });
		await settle(clock);
		test.last().emit(4);
		await settle(clock);
		// Still stalled: the old debt fills the window, so it overflows again.
		expect(raw.data("1")).toEqual([1, 2]);
		expect(raw.continuity("1")).toHaveLength(2);
		raw.ackAll("1");
		raw.ackControl();
		raw.send({ t: "reconcile", c: "1" });
		await settle(clock);
		test.last().emit(5);
		await settle(clock);
		expect(raw.data("1")).toEqual([1, 2, 5]);
		expect(raw.events("1").map((event) => event.seq)).toEqual([1, 2, 3]);
	});

	it("refuses a consumer id reused while its posted debt is unacknowledged", async () => {
		const { runtime, clock, test } = setup();
		const raw = await page(runtime, clock);
		raw.subscribe("1", {});
		await settle(clock);
		test.last().emit("posted");
		await settle(clock);
		raw.send({ t: "unsubscribe", c: "1" });
		raw.subscribe("1", {});
		await settle(clock);
		expect(raw.ofType("error")[0]).toMatchObject({
			c: "1",
			code: "invalid-envelope",
		});
		expect(runtime.stats()).toMatchObject({
			consumers: 0,
			ledgers: 1,
			pendingMessages: 1,
		});
		raw.ackAll("1");
		await settle(clock);
		raw.subscribe("1", {});
		await settle(clock);
		expect(runtime.stats()).toMatchObject({ consumers: 1, pendingMessages: 0 });
	});

	it("releases a retired attachment's whole ledger on detach", async () => {
		const { runtime, clock, test } = setup();
		const raw = await page(runtime, clock);
		raw.subscribe("1", {});
		await settle(clock);
		test.last().emit("a");
		test.last().emit("b");
		await settle(clock);
		raw.send({ t: "detach" });
		await settle(clock);
		expect(runtime.stats()).toMatchObject({
			attachments: 0,
			ledgers: 0,
			pendingMessages: 0,
		});
	});
});

describe("batched gap notices (acceptance scenario 2)", () => {
	it("a stalled page with 100 consumers gets gap/overflow per consumer without exhausting the control bound while a healthy page continues", async () => {
		const { runtime, clock, test } = setup();
		const stalled = await page(runtime, clock);
		const healthy = await page(runtime, clock);
		const topics = 100;
		// they acknowledge the status snapshots well inside the control window.
		for (let topic = 0; topic < topics; topic += 1) {
			stalled.subscribe(`s${topic}`, { subscription: { topic } });
			healthy.subscribe(`h${topic}`, { subscription: { topic } });
			if (topic % 16 === 15) {
				await settle(clock);
				stalled.ackControl();
				healthy.ackControl();
			}
		}
		await settle(clock);
		stalled.ackControl();
		healthy.ackControl();
		await settle(clock);
		const feeds = test.all();
		expect(feeds).toHaveLength(topics);
		const topicOf = (index: number) =>
			(feeds[index]?.spec as { topic: number }).topic;

		// The stalled page acknowledges nothing from here on.
		let produced = 0;
		const round = async () => {
			produced += 1;
			for (const [index, upstream] of feeds.entries()) {
				upstream.emit({ topic: topicOf(index), round: produced });
			}
			for (let topic = 0; topic < topics; topic += 1) {
				healthy.ackAll(`h${topic}`);
			}
			healthy.ackControl();
			await settle(clock);
		};
		for (let n = 0; n < 10; n += 1) await round();

		expect(stalled.ofType("detached")).toHaveLength(0);
		expect(runtime.stats()).toMatchObject({ attachments: 2, expired: 0 });
		const stalledStats = runtime
			.stats()
			.perAttachment.find((entry) => entry.a === stalled.a);
		// Aggregate window held; control stayed well inside its 64-message bound.
		expect(stalledStats?.pendingMessages).toBe(256);
		expect(stalledStats?.pendingControl).toBeLessThanOrEqual(32);
		const noticesWhileStalled = stalled.ofType("continuity").length;
		expect(noticesWhileStalled).toBeLessThanOrEqual(32);

		// The page returns: it acknowledges, and every consumer learns its loss.
		stalled.ackControl();
		for (let topic = 0; topic < topics; topic += 1) stalled.ackAll(`s${topic}`);
		await settle(clock);
		stalled.ackControl();
		await settle(clock);
		const batches = stalled
			.ofType("continuity")
			.slice(noticesWhileStalled)
			.filter((message) => Array.isArray(message.c));
		expect(batches.length).toBeGreaterThanOrEqual(1);
		expect(stalled.ofType("continuity").length).toBeLessThanOrEqual(
			noticesWhileStalled + 3,
		);
		for (let topic = 0; topic < topics; topic += 1) {
			const c = `s${topic}`;
			const gap = latestGap(stalled, c);
			expect(gap?.reason, c).toBe("overflow");
			expect(stalled.data(c).length + (gap?.missed ?? 0), c).toBe(produced);
		}

		// Healthy attachment: every event, no continuity change.
		for (let topic = 0; topic < topics; topic += 1) {
			expect(healthy.data(`h${topic}`)).toHaveLength(produced);
			expect(healthy.continuity(`h${topic}`)).toHaveLength(0);
		}

		// Stopped consumers stay stopped; later counts arrive batched after acks.
		await round();
		stalled.ackControl();
		await settle(clock);
		for (let topic = 0; topic < topics; topic += 1) {
			const c = `s${topic}`;
			expect(
				stalled.data(c).length + (latestGap(stalled, c)?.missed ?? 0),
			).toBe(produced);
		}
		expect(stalled.ofType("detached")).toHaveLength(0);
		expect(healthy.data("h0")).toHaveLength(produced);
	});

	it("consumers of one attachment stopped by the same event share one notice with their own counts", async () => {
		const { runtime, clock, test } = setup({
			maxPendingMessagesPerConsumer: 1,
			maxPendingMessages: 3,
		});
		const raw = await page(runtime, clock);
		for (const c of ["1", "2", "3"]) raw.subscribe(c, {});
		await settle(clock);
		raw.ackControl();
		test.last().emit("posted");
		test.last().emit("overflows");
		await settle(clock);
		const notices = raw.ofType("continuity");
		expect(notices).toHaveLength(1);
		expect(notices[0]).toMatchObject({
			c: ["1", "2", "3"],
			missed: [1, 1, 1],
			continuity: { state: "gap", reason: "overflow" },
		});
		expect(notices[0]?.continuity.missed).toBeUndefined();
	});

	it("withholds gap notices beyond half the control window until acknowledged", async () => {
		const { runtime, clock, test } = setup({
			maxPendingMessagesPerConsumer: 1,
			maxPendingMessages: 1,
			maxControlMessages: 2,
		});
		const raw = await page(runtime, clock);
		raw.subscribe("1", {});
		await settle(clock);
		// One unacknowledged control message (the status snapshot) fills the
		// gap half of a two-message control window.
		test.last().emit(1);
		test.last().emit(2);
		test.last().emit(3);
		await settle(clock);
		expect(raw.continuity("1")).toHaveLength(0);
		expect(raw.ofType("detached")).toHaveLength(0);
		raw.ackControl();
		await settle(clock);
		expect(raw.continuity("1")).toHaveLength(1);
		expect(latestGap(raw, "1")).toMatchObject({
			reason: "overflow",
			missed: 2,
		});
	});

	it("never lets a terminal event overtake a withheld first gap notice", async () => {
		const { runtime, clock, test } = setup({
			maxPendingMessagesPerConsumer: 1,
			maxPendingMessages: 1,
			maxControlMessages: 4,
		});
		const raw = await page(runtime, clock);
		raw.subscribe("1", {});
		await settle(clock);
		// Two unacknowledged control messages close the gap half of the window.
		test.connections[0]?.ctx.setStatus({ state: "connected" });
		test.last().emit(1);
		test.last().emit(2);
		await settle(clock);
		expect(raw.continuity("1")).toHaveLength(0);
		test.last().sink.complete();
		await settle(clock);
		const order = raw.received
			.filter(
				(message) =>
					(message.t === "continuity" &&
						consumerIds(message.c).includes("1")) ||
					(message.t === "event" && message.kind === "complete"),
			)
			.map((message) => message.t);
		expect(order).toEqual(["continuity", "event"]);
		expect(latestGap(raw, "1")).toMatchObject({
			reason: "overflow",
			missed: 1,
		});
		expect(raw.ofType("detached")).toHaveLength(0);
	});

	// the terminal event removes the consumer, so a count
	// update withheld for an unacknowledged notice must go before it.
	const finish = {
		complete: (upstream: TestSubscription) => upstream.sink.complete(),
		error: (upstream: TestSubscription) =>
			upstream.sink.error({ code: "upstream-error", message: "boom" }),
	};

	for (const kind of ["complete", "error"] as const) {
		it(`reports the final known missed count before ${kind} although the previous notice is unacknowledged`, async () => {
			const { runtime, clock, test } = setup({
				maxPendingMessagesPerConsumer: 1,
				maxPendingMessages: 1,
			});
			const raw = await page(runtime, clock);
			raw.subscribe("1", {});
			await settle(clock);
			raw.ackControl();
			await settle(clock);
			// One data credit, four events, no acknowledgements, then the end.
			for (let n = 1; n <= 4; n += 1) test.last().emit(n);
			finish[kind](test.last());
			await settle(clock);
			expect(raw.data("1")).toEqual([1]);
			expect(timeline(raw, "1")).toEqual(["gap:1", "gap:3", kind]);
			expect(latestGap(raw, "1")).toMatchObject({
				reason: "overflow",
				missed: 3,
			});
			expect(raw.ofType("detached")).toHaveLength(0);
			// Later acknowledgements publish nothing more for the ended consumer.
			raw.ackAll("1");
			raw.ackControl();
			await settle(clock);
			expect(timeline(raw, "1")).toEqual(["gap:1", "gap:3", kind]);
		});
	}

	it("batches the final counts of several consumers into one notice per reason within the control bound", async () => {
		const { runtime, clock, test } = setup({
			maxPendingMessagesPerConsumer: 1,
			maxPendingMessages: 4,
			maxControlMessages: 6,
		});
		const raw = await page(runtime, clock);
		for (const c of ["1", "2", "3"]) raw.subscribe(c, {});
		raw.subscribe("other", { subscription: { topic: "other" } });
		await settle(clock);
		raw.ackControl();
		await settle(clock);
		const [shared, other] = test.all();
		if (!shared || !other) throw new Error("expected two upstreams");
		shared.emit("posted");
		other.emit("posted");
		// Every consumer stops; the shared three get one batched first notice
		// and `other` its own (two unacknowledged control messages).
		shared.emit(1);
		other.emit(1);
		// Further losses: all four count updates wait for an acknowledgement.
		shared.emit(2);
		shared.emit(3);
		other.emit(2);
		await settle(clock);
		const pendingControl = () =>
			runtime.stats().perAttachment.find((entry) => entry.a === raw.a)
				?.pendingControl;
		expect(pendingControl()).toBe(2);
		expect(raw.ofType("continuity")).toHaveLength(2);

		shared.sink.complete();
		await settle(clock);
		// One batched final update, then three terminal events: exactly at the
		// six-message control bound, without expiring the attachment.
		const notices = raw.ofType("continuity");
		expect(notices).toHaveLength(3);
		expect(notices[2]).toMatchObject({
			c: ["1", "2", "3"],
			missed: [3, 3, 3],
			continuity: { state: "gap", reason: "overflow" },
		});
		for (const c of ["1", "2", "3"]) {
			expect(raw.data(c)).toEqual(["posted"]);
			expect(timeline(raw, c), c).toEqual(["gap:1", "gap:3", "complete"]);
		}
		expect(pendingControl()).toBe(6);
		expect(runtime.stats()).toMatchObject({ attachments: 1, expired: 0 });
		expect(raw.ofType("detached")).toHaveLength(0);
		// The unterminated consumer keeps the rule: its update waits.
		expect(latestGap(raw, "other")).toMatchObject({ missed: 1 });

		raw.ackControl();
		await settle(clock);
		expect(latestGap(raw, "other")).toMatchObject({
			reason: "overflow",
			missed: 2,
		});
		expect(raw.ofType("continuity")).toHaveLength(4);
		for (const c of ["1", "2", "3"]) {
			expect(timeline(raw, c), c).toEqual(["gap:1", "gap:3", "complete"]);
		}
	});
});

describe("structured-clone fan-out of binary events", () => {
	for (const [label, make] of [
		[
			"an ArrayBuffer",
			() => new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]).buffer,
		],
		["a typed-array view", () => new Uint16Array([1, 2, 3, 65_535, 42])],
	] as const) {
		it(`delivers ${label} with identical bytes to two attachments without transferring the runtime's buffer`, async () => {
			const { runtime, clock, test } = setup();
			const one = await page(runtime, clock);
			const two = await page(runtime, clock);
			one.subscribe("1", {});
			two.subscribe("1", {});
			await settle(clock);
			expect(test.all()).toHaveLength(1);
			const event = make();
			const buffer = ArrayBuffer.isView(event) ? event.buffer : event;
			const original = new Uint8Array(buffer.slice(0));
			test.last().emit(event);
			await settle(clock);
			const received = [one.data("1")[0], two.data("1")[0]];
			for (const value of received) {
				expect(value?.constructor).toBe(event.constructor);
				const bytes = ArrayBuffer.isView(value)
					? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
					: new Uint8Array(value as ArrayBuffer);
				expect([...bytes]).toEqual([...original]);
				// A structured clone, not the runtime's own object.
				expect(value).not.toBe(event);
			}
			expect(received[0]).not.toBe(received[1]);
			// The runtime's buffer was cloned per consumer, never transferred.
			// `detached` is ES2024 (Node 20+); the byte length check covers older engines.
			expect((buffer as { detached?: boolean }).detached).toBe(false);
			expect(buffer.byteLength).toBe(original.byteLength);
			expect([...new Uint8Array(buffer)]).toEqual([...original]);
			const charge = estimateBytes(event) as number;
			for (const raw of [one, two]) {
				expect(
					runtime.stats().perAttachment.find((entry) => entry.a === raw.a),
				).toMatchObject({ pendingMessages: 1, pendingBytes: charge });
			}
		});
	}
});

describe("size limits and cloneability", () => {
	async function single(limits: Partial<RuntimeLimits> = {}) {
		const setupResult = setup(limits);
		const one = await page(setupResult.runtime, setupResult.clock);
		const two = await page(setupResult.runtime, setupResult.clock);
		one.subscribe("1", {});
		two.subscribe("1", {});
		one.subscribe("2", { subscription: { other: true } });
		await settle(setupResult.clock);
		return { ...setupResult, one, two };
	}

	const cases: Array<[string, () => unknown, string]> = [
		[
			"an 8-byte view of a 1 MiB buffer (charged as 1 MiB)",
			() => new Uint8Array(new ArrayBuffer(MIB), 0, 8),
			"message-too-large",
		],
		[
			"a 1 MiB key whose value is undefined",
			() => ({ ["k".repeat(MIB)]: undefined }),
			"message-too-large",
		],
		[
			"an Error with a 1 MiB cause",
			() => new Error("small", { cause: new Uint8Array(MIB) }),
			"message-too-large",
		],
		[
			"an empty array with 1 MiB own metadata",
			() => Object.assign([], { metadata: "m".repeat(MIB) }),
			"message-too-large",
		],
		[
			"a function inside a plain object",
			() => ({ ok: 1, callback() {} }),
			"event-not-serialisable",
		],
		[
			"an accessor property",
			() => ({
				get data() {
					return "x";
				},
			}),
			"event-not-serialisable",
		],
		[
			"a class instance",
			() =>
				new (class Point {
					x = 1;
				})(),
			"event-not-serialisable",
		],
	];

	for (const [label, make, reason] of cases) {
		it(`marks every consumer gap/${reason} for ${label} without posting it`, async () => {
			const { clock, test, one, two, runtime } = await single();
			const upstream = test.all()[0];
			upstream?.emit(make());
			upstream?.emit("after");
			test.all()[1]?.emit("other-feed");
			await settle(clock);
			for (const raw of [one, two]) {
				expect(raw.data("1")).toEqual([]);
				expect(raw.continuity("1")[0]?.continuity).toMatchObject({
					state: "gap",
					reason,
				});
			}
			expect(one.data("2")).toEqual(["other-feed"]);
			expect(runtime.stats().pendingBytes).toBeLessThan(1024);
		});
	}

	it("recovers from a DataCloneError that estimation cannot predict (Proxy) without breaking the port", async () => {
		const { clock, test, one, two, runtime } = await single();
		test.all()[0]?.emit({ value: new Proxy({ a: 1 }, {}) });
		test.all()[1]?.emit("still-flowing");
		await settle(clock);
		expect(one.data("1")).toEqual([]);
		expect(two.data("1")).toEqual([]);
		expect(one.continuity("1")[0]?.continuity).toMatchObject({
			state: "gap",
			reason: "event-not-serialisable",
		});
		expect(one.data("2")).toEqual(["still-flowing"]);
		expect(runtime.stats().dataCloneErrors).toBeGreaterThan(0);
		expect(
			runtime.stats().perAttachment.find((entry) => entry.a === one.a)
				?.pendingMessages,
		).toBe(1);
	});

	it("applies a page-tightened maxMessageBytes to that page only", async () => {
		const { runtime, clock, test } = setup();
		const strict = await page(runtime, clock, {
			limits: { maxMessageBytes: 64 },
		});
		const loose = await page(runtime, clock);
		strict.subscribe("1", {});
		loose.subscribe("1", {});
		await settle(clock);
		test.last().emit("z".repeat(100));
		await settle(clock);
		expect(strict.continuity("1")[0]?.continuity.reason).toBe(
			"message-too-large",
		);
		expect(loose.data("1")).toHaveLength(1);
	});

	it("never truncates: an adapter size hint can only raise the charge", async () => {
		const { runtime, clock, test } = setup({
			maxMessageBytes: 1_000,
			maxPendingBytesPerConsumer: 1_000,
			maxPendingBytes: 2_000,
		});
		const raw = await page(runtime, clock);
		raw.subscribe("1", {});
		await settle(clock);
		test.last().emit("tiny", { bytes: 5_000 });
		test
			.last()
			.emit(new Uint8Array(new ArrayBuffer(10_000), 0, 1), { bytes: 1 });
		await settle(clock);
		expect(raw.data("1")).toEqual([]);
		expect(raw.continuity("1")[0]?.continuity.reason).toBe("message-too-large");
	});
});

describe("control messages", () => {
	// beyond the window, control waits in a bounded outbox;
	// a page that leaves it unacknowledged is expired once (was: at once).
	it("queues control beyond the bound and expires an attachment that leaves it unacknowledged, once, and reports it", async () => {
		const { runtime, clock, test } = setup({ maxControlMessages: 4 });
		const raw = await page(runtime, clock);
		raw.subscribe("1", {});
		await settle(clock);
		const ctx = test.connections[0]?.ctx;
		ctx?.setStatus({ state: "connected" });
		ctx?.setStatus({ state: "reconnecting", reason: "network", attempt: 1 });
		ctx?.setStatus({ state: "connected" });
		ctx?.setStatus({ state: "reconnecting", reason: "network", attempt: 2 });
		await settle(clock);
		expect(raw.ofType("status")).toHaveLength(4);
		expect(raw.ofType("detached")).toHaveLength(0);
		expect(runtime.stats().perAttachment[0]).toMatchObject({
			pendingControl: 4,
			queuedControl: 1,
		});
		clock.advance(30_000);
		await settle(clock);
		expect(raw.ofType("detached")).toEqual([
			expect.objectContaining({ code: "attachment-expired" }),
		]);
		expect(runtime.stats().attachments).toBe(0);
		expect(runtime.stats().expired).toBe(1);
		expect(
			runtime
				.stats()
				.diagnostics.filter((event) => event.type === "attachment-expired"),
		).toEqual([
			expect.objectContaining({
				detail: { reason: "attachment-expired", cause: "control-stalled" },
			}),
		]);
	});

	it("keeps an attachment that acknowledges control messages", async () => {
		const { runtime, clock, test } = setup({ maxControlMessages: 4 });
		const raw = await page(runtime, clock);
		raw.subscribe("1", {});
		await settle(clock);
		const ctx = test.connections[0]?.ctx;
		for (let attempt = 1; attempt <= 12; attempt += 1) {
			ctx?.setStatus({ state: "reconnecting", reason: "network", attempt });
			await settle(clock);
			raw.ackControl();
			await settle(clock);
		}
		expect(raw.ofType("detached")).toHaveLength(0);
		expect(raw.ofType("status")).toHaveLength(13);
	});

	it("suppresses duplicate status and batches consumers of one attachment", async () => {
		const { runtime, clock, test } = setup();
		const raw = await page(runtime, clock);
		raw.subscribe("1", { subscription: { f: 1 } });
		raw.subscribe("2", { subscription: { f: 2 } });
		await settle(clock);
		const ctx = test.connections[0]?.ctx;
		ctx?.setStatus({ state: "connected" });
		ctx?.setStatus({ state: "connected" });
		await settle(clock);
		const statuses = raw.ofType("status");
		expect(statuses).toHaveLength(3);
		expect(statuses[2]).toMatchObject({
			c: ["1", "2"],
			connection: { state: "connected" },
		});
	});

	it("does not block terminal messages behind exhausted data credits", async () => {
		const { runtime, clock, test } = setup({
			maxPendingMessagesPerConsumer: 1,
			maxPendingMessages: 1,
		});
		const raw = await page(runtime, clock);
		raw.subscribe("1", {});
		await settle(clock);
		test.last().emit(1);
		test.last().emit(2);
		test.last().sink.complete();
		await settle(clock);
		expect(raw.events("1").map((event) => event.kind)).toEqual([
			"next",
			"complete",
		]);
		expect(raw.events("1").map((event) => event.seq)).toEqual([1, 2]);
	});

	it("counts messageerror without treating it as attachment loss", async () => {
		const clock = new ManualClock();
		const test = createTestAdapter();
		const runtime = createRuntime({ adapters: [test.adapter], clock });
		runtimes.push(runtime);
		const channel = new MessageChannel();
		runtime.accept(channel.port2);
		channel.port2.dispatchEvent(new MessageEvent("messageerror"));
		await settle(clock);
		expect(runtime.stats().messageErrors).toBe(1);
		channel.port1.close();
	});
});
