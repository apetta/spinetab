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

async function setup() {
	const clock = new ManualClock();
	const test = createTestAdapter();
	const runtime = createRuntime({ adapters: [test.adapter], clock });
	runtimes.push(runtime);
	const page = async () => {
		const raw = new RawPage(runtime);
		raw.hello();
		await settle(clock);
		return raw;
	};
	return { clock, test, runtime, page };
}

describe("resume cursors", () => {
	it("reports resumed only to consumers whose cursor was used; others are told unknown", async () => {
		const clock = new ManualClock();
		let seen: unknown;
		const runtime = createRuntime({
			clock,
			adapters: [
				{
					kind: "test",
					version: 1,
					connect: () => ({
						subscribe: (_spec, sink, options) => {
							seen = options.cursor;
							setTimeout(
								() =>
									sink.continuity("resumed-with-cursor", {
										cursor: options.cursor,
										duplicatesPossible: true,
									}),
								0,
							);
							return { unsubscribe() {} };
						},
						dispose() {},
					}),
				},
			],
		});
		runtimes.push(runtime);
		const first = new RawPage(runtime);
		first.hello();
		const second = new RawPage(runtime);
		second.hello();
		const fresh = new RawPage(runtime);
		fresh.hello();
		await settle(clock);
		const request = { adapter: "test", connection: {}, subscription: {} };
		first.send({ t: "subscribe", c: "1", request, cursor: "e10" });
		second.send({ t: "subscribe", c: "1", request, cursor: "e7" });
		fresh.send({ t: "subscribe", c: "1", request });
		await settle(clock);
		await new Promise((resolve) => setTimeout(resolve, 5));
		await settle(clock);
		expect(seen).toBe("e10");
		expect(first.continuity("1")[0]?.continuity).toMatchObject({
			state: "resumed",
			reason: "resumed-with-cursor",
			cursor: "e10",
			duplicatesPossible: true,
		});
		expect(second.continuity("1")[0]?.continuity).toMatchObject({
			state: "unknown",
			reason: "reconnected",
		});
		expect(fresh.continuity("1")[0]?.continuity).toMatchObject({
			state: "resumed",
		});
	});
});

describe("hint-driven checks and explicit retry", () => {
	it("starts at most one fresh series per 30 s for retry-exhausted connections and never for failed or auth-blocked", async () => {
		const { clock, test, page } = await setup();
		const raw = await page();
		raw.subscribe("1", { connection: { url: "https://a.test" } });
		raw.subscribe("2", { connection: { url: "https://b.test" } });
		raw.subscribe("3", { connection: { url: "https://c.test" } });
		await settle(clock);
		const [exhausted, failed, blocked] = test.connections;
		exhausted?.ctx.setStatus({
			state: "retry-exhausted",
			reason: "attempts-exhausted",
		});
		failed?.ctx.setStatus({ state: "failed", reason: "permanent-error" });
		blocked?.ctx.setStatus({
			state: "auth-blocked",
			reason: "credentials-rejected",
		});
		await settle(clock);
		raw.send({ t: "probe", id: "p1", hint: true });
		raw.send({ t: "probe", id: "p2", hint: true });
		await settle(clock);
		expect([exhausted?.retries, failed?.retries, blocked?.retries]).toEqual([
			1, 0, 0,
		]);
		clock.advance(29_999);
		raw.send({ t: "probe", id: "p3", hint: true });
		await settle(clock);
		expect(exhausted?.retries).toBe(1);
		clock.advance(1);
		raw.send({ t: "probe", id: "p4", hint: true });
		await settle(clock);
		expect(exhausted?.retries).toBe(2);
		expect(raw.ofType("probeResult")).toHaveLength(4);
	});

	it("coalesces explicit retries from several tabs into one fresh series", async () => {
		const { clock, test, page } = await setup();
		const tabs = [await page(), await page(), await page()];
		for (const tab of tabs) tab.subscribe("1", {});
		await settle(clock);
		test.connections[0]?.ctx.setStatus({
			state: "auth-blocked",
			reason: "credentials-rejected",
		});
		await settle(clock);
		for (const tab of tabs) tab.send({ t: "retry" });
		await settle(clock);
		expect(test.connections[0]?.retries).toBe(1);
		test.connections[0]?.ctx.setStatus({ state: "connected" });
		tabs[0]?.send({ t: "retry" });
		await settle(clock);
		expect(test.connections[0]?.retries).toBe(1);
	});

	it("probes each connection at most once per 5 s for hint checks", async () => {
		const { clock, test, page } = await setup();
		const a = await page();
		const b = await page();
		a.subscribe("1", {});
		b.subscribe("1", {});
		await settle(clock);
		a.send({ t: "probe", id: "1", hint: true });
		b.send({ t: "probe", id: "2", hint: true });
		a.send({ t: "probe", id: "3" });
		await settle(clock);
		expect(test.connections[0]?.probes).toBe(1);
		clock.advance(5_000);
		b.send({ t: "probe", id: "4", hint: true });
		await settle(clock);
		expect(test.connections[0]?.probes).toBe(2);
	});
});

// Regression coverage for clock, credential and lifecycle boundaries.

/** Step the wall clock back without running timers (an NTP or manual step). */
function stepBack(clock: ManualClock, ms: number): void {
	(clock as unknown as { time: number }).time -= ms;
}

describe("C1-F2 a backwards wall-clock step never holds back a retry or a hint", () => {
	it("an explicit retry after a backwards step still starts a fresh series", async () => {
		const { clock, test, page } = await setup();
		const raw = await page();
		raw.subscribe("1", {});
		await settle(clock);
		const conn = test.connections[0];
		conn?.ctx.setStatus({ state: "failed", reason: "permanent-error" });
		await settle(clock);
		raw.send({ t: "retry" });
		await settle(clock);
		expect(conn?.retries).toBe(1);
		// The series fails again; 10 s later the wall clock is stepped back 1 h.
		conn?.ctx.setStatus({ state: "connecting" });
		conn?.ctx.setStatus({ state: "failed", reason: "permanent-error" });
		clock.advance(10_000);
		stepBack(clock, 3_600_000);
		raw.send({ t: "retry" });
		await settle(clock);
		expect(conn?.retries).toBe(2);
		// Coalescing still holds from the stepped-back time.
		raw.send({ t: "retry" });
		await settle(clock);
		expect(conn?.retries).toBe(2);
	});

	it("a hint after a backwards step starts one fresh series for a retry-exhausted connection", async () => {
		const { clock, test, page } = await setup();
		const raw = await page();
		raw.subscribe("1", {});
		await settle(clock);
		const conn = test.connections[0];
		conn?.ctx.setStatus({
			state: "retry-exhausted",
			reason: "attempts-exhausted",
		});
		await settle(clock);
		raw.send({ t: "probe", id: "h1", hint: true });
		await settle(clock);
		expect(conn?.retries).toBe(1);
		conn?.ctx.setStatus({ state: "connecting" });
		conn?.ctx.setStatus({
			state: "retry-exhausted",
			reason: "attempts-exhausted",
		});
		clock.advance(40_000);
		stepBack(clock, 3_600_000);
		raw.send({ t: "probe", id: "h2", hint: true });
		await settle(clock);
		expect(conn?.retries).toBe(2);
		// At most one series per spacing window, measured from the new time.
		raw.send({ t: "probe", id: "h3", hint: true });
		await settle(clock);
		expect(conn?.retries).toBe(2);
	});

	it("a hint after a backwards step still probes a live connection (5 s spacing)", async () => {
		const { clock, test, page } = await setup();
		const raw = await page();
		raw.subscribe("1", {});
		await settle(clock);
		const conn = test.connections[0];
		raw.send({ t: "probe", id: "h1", hint: true });
		await settle(clock);
		expect(conn?.probes).toBe(1);
		clock.advance(6_000);
		stepBack(clock, 3_600_000);
		raw.send({ t: "probe", id: "h2", hint: true });
		await settle(clock);
		expect(conn?.probes).toBe(2);
		raw.send({ t: "probe", id: "h3", hint: true });
		await settle(clock);
		expect(conn?.probes).toBe(2);
	});
});

describe("C1-F3 a detected suspension permits one fresh series and one check", () => {
	/**
	 * Stay awake `awakeMs` more, still before the lease timer (armed at hello
	 * for 180 s) is due, then sleep 10 minutes: the overdue lease timer
	 * detects the gap at executable time 180 s.
	 */
	async function sleepAcrossLeaseTimer(clock: ManualClock, awakeMs: number) {
		clock.advance(awakeMs);
		clock.jump(600_000);
		clock.advance(0);
		await settle(clock);
	}

	it("a gap hint within 30 s of the last series still starts one fresh series", async () => {
		const { clock, test, runtime, page } = await setup();
		const raw = await page();
		raw.subscribe("1", {});
		await settle(clock);
		const conn = test.connections[0];
		clock.advance(160_000);
		raw.send({ t: "renew" });
		await settle(clock);
		clock.advance(10_000); // t = 170 s
		conn?.ctx.setStatus({
			state: "retry-exhausted",
			reason: "attempts-exhausted",
		});
		await settle(clock);
		raw.send({ t: "probe", id: "h1", hint: true });
		await settle(clock);
		expect(conn?.retries).toBe(1);
		// The short series exhausts again at once, then the device sleeps.
		conn?.ctx.setStatus({ state: "connecting" });
		conn?.ctx.setStatus({
			state: "retry-exhausted",
			reason: "attempts-exhausted",
		});
		await sleepAcrossLeaseTimer(clock, 5_000); // asleep at t = 175 s
		// The gap extended the lease: nothing expired.
		expect(runtime.stats()).toMatchObject({ attachments: 1, expired: 0 });
		raw.send({ t: "probe", id: "h2", hint: true }); // the page's gap hint
		await settle(clock);
		expect(conn?.retries).toBe(2);
		// One series per resume: a second hint right after is coalesced.
		raw.send({ t: "probe", id: "h3", hint: true });
		await settle(clock);
		expect(conn?.retries).toBe(2);
	});

	it("a gap hint within 5 s of the last probe still runs one check", async () => {
		const { clock, test, page } = await setup();
		const raw = await page();
		raw.subscribe("1", {});
		await settle(clock);
		const conn = test.connections[0];
		clock.advance(160_000);
		raw.send({ t: "renew" });
		await settle(clock);
		clock.advance(17_000); // t = 177 s
		raw.send({ t: "probe", id: "h1", hint: true });
		await settle(clock);
		expect(conn?.probes).toBe(1);
		await sleepAcrossLeaseTimer(clock, 1_000); // asleep at t = 178 s
		raw.send({ t: "probe", id: "h2", hint: true });
		await settle(clock);
		expect(conn?.probes).toBe(2);
		raw.send({ t: "probe", id: "h3", hint: true });
		await settle(clock);
		expect(conn?.probes).toBe(2);
	});

	it("guard: without a gap the 30 s series spacing still holds", async () => {
		const { clock, test, page } = await setup();
		const raw = await page();
		raw.subscribe("1", {});
		await settle(clock);
		const conn = test.connections[0];
		conn?.ctx.setStatus({
			state: "retry-exhausted",
			reason: "attempts-exhausted",
		});
		await settle(clock);
		raw.send({ t: "probe", id: "h1", hint: true });
		await settle(clock);
		conn?.ctx.setStatus({ state: "connecting" });
		conn?.ctx.setStatus({
			state: "retry-exhausted",
			reason: "attempts-exhausted",
		});
		clock.advance(29_000);
		raw.send({ t: "probe", id: "h2", hint: true });
		await settle(clock);
		expect(conn?.retries).toBe(1);
	});
});
