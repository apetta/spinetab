import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeMessage } from "../../../src/core/bridge.ts";
import { consumerIds } from "../../../src/core/bridge-page.ts";
import { DEFAULT_LIMITS } from "../../../src/core/limits.ts";
import { createRuntime, type Runtime } from "../../../src/core/runtime.ts";
import type {
	DiagnosticEvent,
	RuntimeLimits,
	SubscriptionStatus,
} from "../../../src/core/types.ts";
import { disposeAll, feed, makeClient } from "./helpers/client.ts";
import { ManualClock, settle } from "./helpers/clock.ts";
import { RawPage } from "./helpers/page.ts";
import {
	createTestAdapter,
	type TestSubscription,
} from "./helpers/test-adapter.ts";

// per-attachment control flow control. Bursts of
// more than `maxControlMessages` control messages in one runtime turn (100
// subscriptions, re-registration after replacement, terminal fan-out) wait
// in a bounded outbox instead of expiring a healthy attachment; order is
// production order; a page that never acknowledges is still isolated and
// expired exactly once. Control limits stay at their defaults throughout.

const TOPICS = 100;
const WINDOW = DEFAULT_LIMITS.maxControlMessages;
const QUEUE_CAP =
	2 *
	(DEFAULT_LIMITS.maxConsumersPerAttachment +
		DEFAULT_LIMITS.maxPendingCommands);
const STALL_MS = 30_000;

const runtimes: Runtime[] = [];
afterEach(() => {
	for (const runtime of runtimes.splice(0)) runtime.dispose();
	disposeAll();
});

function setup(limits: Partial<RuntimeLimits> = {}) {
	const clock = new ManualClock();
	const test = createTestAdapter();
	const diagnostics: DiagnosticEvent[] = [];
	const runtime = createRuntime({
		adapters: [test.adapter],
		clock,
		limits,
		diagnostics: (event) => diagnostics.push(event),
	});
	runtimes.push(runtime);
	return { clock, test, runtime, diagnostics };
}

async function page(runtime: Runtime, clock: ManualClock, fields = {}) {
	const raw = new RawPage(runtime);
	raw.hello(fields);
	await settle(clock);
	return raw;
}

/** Subscribe `count` distinct topics in one synchronous turn. */
function burst(raw: RawPage, prefix = "", count = TOPICS): void {
	for (let topic = 0; topic < count; topic += 1) {
		raw.subscribe(`${prefix}${topic}`, { subscription: { topic } });
	}
}

/** A responsive page: acknowledge control until nothing more arrives. */
async function drain(raw: RawPage, clock: ManualClock): Promise<void> {
	for (let round = 0; round < 100; round += 1) {
		const before = raw.received.length;
		raw.ackControl();
		await settle(clock);
		if (raw.received.length === before) return;
	}
	throw new Error("control did not drain");
}

const statsOf = (runtime: Runtime, raw: RawPage) =>
	runtime.stats().perAttachment.find((entry) => entry.a === raw.a);

const expiries = (diagnostics: DiagnosticEvent[]) =>
	diagnostics.filter((event) => event.type === "attachment-expired");

/** Control sequences in arrival order. */
const sequences = (raw: RawPage) =>
	raw.received.flatMap((message) =>
		"k" in message && typeof message.k === "number" ? [message.k] : [],
	);

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

/** Flap one connection's status `times` times (each a distinct status). */
function flap(ctx: { setStatus(status: object): void }, times: number) {
	for (let attempt = 1; attempt <= times; attempt += 1) {
		ctx.setStatus({ state: "reconnecting", reason: "network", attempt });
	}
}

describe("control flow control", () => {
	it("queues a 100-subscription burst beyond the window and drains it in order, without expiry", async () => {
		const { runtime, clock, test, diagnostics } = setup();
		const raw = await page(runtime, clock);
		burst(raw);
		await settle(clock);
		// The page has not acknowledged yet: the window is full, the rest waits.
		expect(raw.ofType("status")).toHaveLength(WINDOW);
		expect(raw.ofType("detached")).toHaveLength(0);
		expect(statsOf(runtime, raw)).toMatchObject({
			consumers: TOPICS,
			pendingControl: WINDOW,
			queuedControl: TOPICS - WINDOW,
		});
		await drain(raw, clock);
		const statuses = raw.ofType("status");
		expect(statuses.map((message) => message.c)).toEqual(
			Array.from({ length: TOPICS }, (_, topic) => String(topic)),
		);
		expect(sequences(raw)).toEqual(
			Array.from({ length: TOPICS }, (_, index) => index + 1),
		);
		expect(runtime.stats()).toMatchObject({
			attachments: 1,
			subscriptions: TOPICS,
			expired: 0,
		});
		expect(runtime.stats().hwm).toMatchObject({
			controlMessages: WINDOW,
			controlQueued: TOPICS - WINDOW,
		});
		expect(statsOf(runtime, raw)?.queuedControl).toBe(0);
		expect(expiries(diagnostics)).toEqual([]);
		expect(test.all()).toHaveLength(TOPICS);
	});

	it("never lets data overtake queued control: every status snapshot precedes its consumer's first event", async () => {
		const { runtime, clock, test } = setup();
		const raw = await page(runtime, clock);
		burst(raw);
		await settle(clock);
		// Events for every topic while 36 snapshots still wait.
		for (const upstream of test.all()) upstream.emit({ n: 1 });
		await settle(clock);
		expect(raw.events()).toHaveLength(0);
		expect(runtime.stats().pendingMessages).toBe(TOPICS);
		await drain(raw, clock);
		const order = raw.received.map((message: RuntimeMessage) =>
			message.t === "status" || message.t === "event"
				? `${message.t}:${consumerIds(message.c).join(",")}`
				: message.t,
		);
		for (let topic = 0; topic < TOPICS; topic += 1) {
			const status = order.indexOf(`status:${topic}`);
			const event = order.indexOf(`event:${topic}`);
			expect(status, `topic ${topic}`).toBeGreaterThanOrEqual(0);
			expect(event, `topic ${topic}`).toBeGreaterThan(status);
		}
		// Production order: all 100 snapshots, then the 100 events.
		expect(order.lastIndexOf(`status:${TOPICS - 1}`)).toBeLessThan(
			order.findIndex((entry) => entry.startsWith("event:")),
		);
		for (let topic = 0; topic < TOPICS; topic += 1) {
			expect(raw.events(String(topic)).map((event) => event.seq)).toEqual([1]);
		}
		expect(runtime.stats().expired).toBe(0);
	});

	const finish = {
		complete: (upstream: TestSubscription) => upstream.sink.complete(),
		error: (upstream: TestSubscription) =>
			upstream.sink.error({ code: "upstream-error", message: "boom" }),
	};

	for (const kind of ["complete", "error"] as const) {
		it(`keeps each final missed count before its terminal in a 100-consumer ${kind} burst, without expiry`, async () => {
			// One data credit per consumer (a data limit, not a control limit).
			const { runtime, clock, test } = setup({
				maxPendingMessagesPerConsumer: 1,
			});
			const raw = await page(runtime, clock);
			burst(raw);
			await settle(clock);
			await drain(raw, clock);
			const upstreams = test.all();
			// Per consumer: one delivered, then two lost, with nothing acknowledged.
			for (let n = 1; n <= 3; n += 1) {
				for (const upstream of upstreams) upstream.emit({ n });
			}
			// Then every stream ends in the same turn (point 22 × 100).
			for (const upstream of upstreams) finish[kind](upstream);
			await settle(clock);
			expect(raw.ofType("detached")).toHaveLength(0);
			expect(statsOf(runtime, raw)?.pendingControl).toBeLessThanOrEqual(WINDOW);
			expect(statsOf(runtime, raw)?.queuedControl).toBeGreaterThan(0);
			await drain(raw, clock);
			for (let topic = 0; topic < TOPICS; topic += 1) {
				const c = String(topic);
				const events = timeline(raw, c);
				expect(raw.data(c), c).toEqual([{ n: 1 }]);
				expect(events.at(-1), c).toBe(kind);
				expect(events.at(-2), c).toBe("gap:2");
				expect(
					events.filter((entry) => entry === kind),
					c,
				).toHaveLength(1);
			}
			expect(runtime.stats()).toMatchObject({
				attachments: 1,
				expired: 0,
				subscriptions: 0,
			});
			expect(runtime.stats().hwm.controlMessages).toBeLessThanOrEqual(WINDOW);
		});
	}

	it("handles a 100-unsubscribe burst and an immediate 100-subscribe burst on one attachment", async () => {
		const { runtime, clock, test } = setup();
		const raw = await page(runtime, clock);
		burst(raw, "a");
		await settle(clock);
		await drain(raw, clock);
		for (let topic = 0; topic < TOPICS; topic += 1) {
			raw.send({ t: "unsubscribe", c: `a${topic}` });
		}
		burst(raw, "b");
		await settle(clock);
		expect(raw.ofType("detached")).toHaveLength(0);
		await drain(raw, clock);
		expect(
			raw
				.ofType("status")
				.filter((message) =>
					consumerIds(message.c).some((c) => c.startsWith("b")),
				),
		).toHaveLength(TOPICS);
		// The same upstreams were rejoined within the linger turn.
		expect(test.all()).toHaveLength(TOPICS);
		expect(runtime.stats()).toMatchObject({
			consumers: TOPICS,
			subscriptions: TOPICS,
			expired: 0,
		});
		for (let topic = 0; topic < TOPICS; topic += 1) {
			raw.send({ t: "unsubscribe", c: `b${topic}` });
		}
		await settle(clock);
		expect(test.active()).toHaveLength(0);
		expect(runtime.stats()).toMatchObject({
			attachments: 1,
			consumers: 0,
			subscriptions: 0,
			expired: 0,
		});
	});

	it("fans out two attachments × 100 subscriptions; a page that never acknowledges is expired alone, once, after the stall bound", async () => {
		const { runtime, clock, test, diagnostics } = setup();
		const healthy = await page(runtime, clock);
		const silent = await page(runtime, clock);
		burst(healthy, "h");
		burst(silent, "s");
		await settle(clock);
		expect(test.all()).toHaveLength(TOPICS);
		expect(runtime.stats().consumers).toBe(2 * TOPICS);
		await drain(healthy, clock);
		for (const upstream of test.all()) upstream.emit("one");
		await settle(clock);
		expect(healthy.events()).toHaveLength(TOPICS);
		expect(silent.events()).toHaveLength(0);
		expect(silent.ofType("status")).toHaveLength(WINDOW);

		clock.advance(STALL_MS - 1);
		await settle(clock);
		expect(silent.ofType("detached")).toHaveLength(0);
		clock.advance(1);
		await settle(clock);
		expect(silent.ofType("detached")).toEqual([
			expect.objectContaining({ code: "attachment-expired" }),
		]);
		expect(expiries(diagnostics)).toEqual([
			expect.objectContaining({
				detail: { reason: "attachment-expired", cause: "control-stalled" },
			}),
		]);
		expect(runtime.stats()).toMatchObject({
			attachments: 1,
			consumers: TOPICS,
			subscriptions: TOPICS,
			expired: 1,
		});
		// The healthy page carries on.
		for (const upstream of test.all()) upstream.emit("two");
		await settle(clock);
		expect(healthy.events()).toHaveLength(2 * TOPICS);
		clock.advance(STALL_MS);
		await settle(clock);
		expect(runtime.stats().expired).toBe(1);
	});

	it("treats a runtime suspension as a scheduling gap, not a stalled page", async () => {
		const { runtime, clock, test } = setup();
		const raw = await page(runtime, clock);
		raw.subscribe("1", {});
		await settle(clock);
		const ctx = test.connections[0]?.ctx;
		if (!ctx) throw new Error("no connection");
		flap(ctx, WINDOW);
		await settle(clock);
		expect(statsOf(runtime, raw)?.queuedControl).toBe(1);
		// The whole runtime was suspended well past the stall bound.
		clock.jump(100_000);
		clock.advance(0);
		await settle(clock);
		expect(raw.ofType("detached")).toHaveLength(0);
		expect(runtime.stats().diagnostics.map((event) => event.type)).toContain(
			"scheduling-gap",
		);
		// The page gets a full bound from resumption to acknowledge.
		clock.advance(STALL_MS - 1);
		await settle(clock);
		expect(raw.ofType("detached")).toHaveLength(0);
		raw.ackControl();
		await settle(clock);
		expect(statsOf(runtime, raw)?.queuedControl).toBe(0);
		clock.advance(STALL_MS);
		await settle(clock);
		expect(runtime.stats().expired).toBe(0);
	});

	it("resets the stall bound on acknowledgement progress", async () => {
		const { runtime, clock, test } = setup();
		const raw = await page(runtime, clock);
		raw.subscribe("1", {});
		await settle(clock);
		const ctx = test.connections[0]?.ctx;
		if (!ctx) throw new Error("no connection");
		flap(ctx, TOPICS);
		await settle(clock);
		expect(statsOf(runtime, raw)?.queuedControl).toBe(TOPICS + 1 - WINDOW);
		clock.advance(20_000);
		await settle(clock);
		// Partial progress: ten acknowledged, ten more posted, the rest waits.
		raw.send({ t: "ack", k: 10 });
		await settle(clock);
		expect(statsOf(runtime, raw)?.queuedControl).toBe(TOPICS + 1 - WINDOW - 10);
		clock.advance(20_000);
		await settle(clock);
		expect(raw.ofType("detached")).toHaveLength(0);
		clock.advance(STALL_MS - 20_000);
		await settle(clock);
		expect(raw.ofType("detached")).toHaveLength(1);
		expect(runtime.stats().expired).toBe(1);
	});

	it("expires a page that never acknowledges exactly once when the queued-control count bound is exceeded", async () => {
		const { runtime, clock, test, diagnostics } = setup();
		const raw = await page(runtime, clock);
		const other = await page(runtime, clock);
		raw.subscribe("1", {});
		other.subscribe("1", {
			connection: { url: "https://example.test/other" },
		});
		await settle(clock);
		const ctx = test.connections[0]?.ctx;
		if (!ctx) throw new Error("no connection");
		// One snapshot plus changes fill the window and then the whole outbox.
		flap(ctx, WINDOW + QUEUE_CAP - 1);
		await settle(clock);
		expect(raw.ofType("detached")).toHaveLength(0);
		expect(statsOf(runtime, raw)).toMatchObject({
			pendingControl: WINDOW,
			queuedControl: QUEUE_CAP,
		});
		ctx.setStatus({ state: "connected" });
		ctx.setStatus({ state: "reconnecting", reason: "network", attempt: 1 });
		await settle(clock);
		expect(raw.ofType("detached")).toEqual([
			expect.objectContaining({ code: "attachment-expired" }),
		]);
		expect(expiries(diagnostics)).toEqual([
			expect.objectContaining({
				detail: { reason: "attachment-expired", cause: "control-queue" },
			}),
		]);
		expect(runtime.stats()).toMatchObject({ attachments: 1, expired: 1 });
		expect(runtime.stats().hwm.controlQueued).toBe(QUEUE_CAP);
		expect(runtime.stats().hwm.controlMessages).toBe(WINDOW);
		// The other attachment, on another connection, is untouched.
		expect(other.ofType("detached")).toHaveLength(0);
		clock.advance(STALL_MS);
		await settle(clock);
		expect(runtime.stats().expired).toBe(1);
	});

	it("expires when queued control content exceeds maxControlMessages × maxMessageBytes", async () => {
		const { runtime, clock, test, diagnostics } = setup();
		// The page tightens its own maxMessageBytes; status codes stay within it.
		const raw = await page(runtime, clock, {
			limits: { maxMessageBytes: 1024 },
		});
		raw.subscribe("1", {});
		await settle(clock);
		const ctx = test.connections[0]?.ctx;
		if (!ctx) throw new Error("no connection");
		const code = "c".repeat(300);
		for (let attempt = 1; attempt <= WINDOW + 200; attempt += 1) {
			ctx.setStatus({
				state: "reconnecting",
				reason: "network",
				attempt,
				code,
			});
		}
		await settle(clock);
		const statuses = raw.ofType("status");
		expect(statuses[1]?.connection.code).toBe(code);
		expect(raw.ofType("detached")).toHaveLength(1);
		expect(expiries(diagnostics)).toEqual([
			expect.objectContaining({
				detail: { reason: "attachment-expired", cause: "control-queue" },
			}),
		]);
		// The byte bound, not the count bound, ended it.
		const { controlQueued } = runtime.stats().hwm;
		expect(controlQueued).toBeGreaterThan(0);
		expect(controlQueued).toBeLessThan(200);
	});
});

describe("re-registration after runtime replacement", () => {
	it("the page client re-registers 100 subscriptions in one burst on the replacement runtime without expiry", async () => {
		const diagnostics: DiagnosticEvent[] = [];
		const { client, host, clock } = makeClient({
			sharing: "require",
			diagnostics: (event) => diagnostics.push(event),
		});
		const statuses: Array<SubscriptionStatus | undefined> = [];
		for (let topic = 0; topic < TOPICS; topic += 1) {
			client.subscribe(feed({ topic }), {
				next() {},
				status: (status) => {
					statuses[topic] = status;
				},
			});
		}
		await settle(clock);
		expect(host.runtime.stats()).toMatchObject({
			consumers: TOPICS,
			subscriptions: TOPICS,
			expired: 0,
		});
		expect(client.status.get()).toMatchObject({
			mode: "shared",
			generation: 1,
		});
		const first = host.runtime;

		host.reinit();
		await settle(clock);
		expect(host.runtime).not.toBe(first);
		expect(client.status.get()).toMatchObject({
			mode: "shared",
			health: "healthy",
			generation: 2,
			runtimeId: host.runtime.id,
		});
		expect(host.runtime.stats()).toMatchObject({
			attachments: 1,
			consumers: TOPICS,
			subscriptions: TOPICS,
			expired: 0,
		});
		expect(host.test.all()).toHaveLength(TOPICS);
		expect(
			diagnostics
				.filter((event) => event.type === "runtime-lost")
				.map((event) => event.detail),
		).toEqual([{ reason: "runtime-announced" }]);
		// Every subscription heard the new runtime's snapshot and continuity.
		host.test.connections[0]?.ctx.setStatus({ state: "connected" });
		await settle(clock);
		for (let topic = 0; topic < TOPICS; topic += 1) {
			expect(statuses[topic]?.connection.state, `topic ${topic}`).toBe(
				"connected",
			);
			expect(statuses[topic]?.continuity.state, `topic ${topic}`).toBe(
				"unknown",
			);
		}
		expect(host.runtime.stats().expired).toBe(0);
	});
});
