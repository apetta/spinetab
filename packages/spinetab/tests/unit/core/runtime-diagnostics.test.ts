import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../../src/core/runtime.ts";
import type { DiagnosticEvent } from "../../../src/core/types.ts";
import { ManualClock, settle } from "./helpers/clock.ts";
import { RawPage } from "./helpers/page.ts";
import { createTestAdapter } from "./helpers/test-adapter.ts";

// Runtime history requires a diagnostics sink; a page can receive live diagnostics without enabling that history.

const runtimes: Runtime[] = [];
afterEach(() => {
	for (const runtime of runtimes.splice(0)) runtime.dispose();
});

function setup(sink?: (event: DiagnosticEvent) => void) {
	const clock = new ManualClock();
	const test = createTestAdapter();
	const runtime = createRuntime({
		adapters: [test.adapter],
		clock,
		...(sink === undefined ? {} : { diagnostics: sink }),
	});
	runtimes.push(runtime);
	return { clock, test, runtime };
}

async function attach(
	runtime: Runtime,
	clock: ManualClock,
	fields: Record<string, unknown> = {},
) {
	const raw = new RawPage(runtime);
	raw.hello(fields);
	await settle(clock);
	return raw;
}

/** Runtime events forwarded to a page, by type. */
const forwarded = (raw: RawPage) =>
	raw.ofType("diagnostic").map((message) => message.event.type);

/** Settle until `done()` holds or the round budget is spent. */
async function until(
	clock: ManualClock,
	done: () => boolean,
	rounds = 60,
): Promise<void> {
	for (let i = 0; i < rounds && !done(); i += 1) await settle(clock);
}

describe("runtime diagnostics are genuinely opt-in", () => {
	it("with no sink and no opted-in page: empty history, counters still count", async () => {
		const { clock, runtime } = setup();
		const raw = await attach(runtime, clock);
		raw.port.postMessage({ nonsense: true });
		raw.send({ t: "nonsense" } as never);
		await until(clock, () => runtime.stats().invalidEnvelopes === 2);
		const stats = runtime.stats();
		expect(stats.invalidEnvelopes).toBe(2);
		expect(stats.attachments).toBe(1);
		expect(stats.diagnostics).toEqual([]);
		expect(raw.ofType("diagnostic")).toEqual([]);
	});

	it("with a runtime sink: every event is delivered and at most 100 are retained", async () => {
		const seen: DiagnosticEvent[] = [];
		const { clock, runtime } = setup((event) => seen.push(event));
		const raw = await attach(runtime, clock);
		for (let i = 0; i < 120; i += 1) raw.port.postMessage({ i });
		await until(clock, () => runtime.stats().invalidEnvelopes === 120);
		const stats = runtime.stats();
		expect(stats.invalidEnvelopes).toBe(120);
		expect(
			seen.filter((event) => event.type === "invalid-envelope"),
		).toHaveLength(120);
		expect(stats.diagnostics).toHaveLength(100);
		expect(stats.diagnostics.every((event) => event.realm === "runtime")).toBe(
			true,
		);
		expect(stats.diagnostics.at(-1)).toEqual(seen.at(-1));
		// The page did not opt in, so it receives no forwarded events.
		expect(raw.ofType("diagnostic")).toEqual([]);
	});

	it("page-only opt-in: live events are forwarded while the runtime keeps no history", async () => {
		const { clock, runtime } = setup();
		const raw = await attach(runtime, clock, { diagnostics: true });
		raw.port.postMessage({ nonsense: true });
		await until(clock, () => runtime.stats().invalidEnvelopes === 1);
		expect(runtime.stats().diagnostics).toEqual([]);
		expect(forwarded(raw)).toEqual(["attached", "invalid-envelope"]);
		expect(runtime.stats().invalidEnvelopes).toBe(1);
	});

	it("a throwing sink is contained: history, forwarding and counters are unaffected", async () => {
		let calls = 0;
		const { clock, runtime } = setup(() => {
			calls += 1;
			throw new Error("sink failed");
		});
		const raw = await attach(runtime, clock, { diagnostics: true });
		raw.port.postMessage({ nonsense: true });
		await until(clock, () => runtime.stats().invalidEnvelopes === 1);
		const stats = runtime.stats();
		expect(calls).toBe(2);
		expect(stats.invalidEnvelopes).toBe(1);
		expect(stats.handlerErrors).toBe(0);
		expect(stats.diagnostics.map((event) => event.type)).toEqual([
			"attached",
			"invalid-envelope",
		]);
		expect(forwarded(raw)).toEqual(["attached", "invalid-envelope"]);
	});

	it("a re-entrant diagnostic raised from inside the sink is dropped, not recursed", async () => {
		let nested = 0;
		const context = setup((event) => {
			if (event.type !== "invalid-envelope") return;
			nested += 1;
			context.test.connections[0]?.ctx.diagnostic({ type: "nested" });
		});
		const { clock, runtime } = context;
		const raw = await attach(runtime, clock);
		raw.subscribe("c1", {});
		await settle(clock);
		expect(context.test.connections).toHaveLength(1);
		raw.port.postMessage({ nonsense: true });
		await until(clock, () => runtime.stats().invalidEnvelopes === 1);
		expect(nested).toBe(1);
		const types = runtime.stats().diagnostics.map((event) => event.type);
		expect(types).toContain("invalid-envelope");
		expect(types).not.toContain("nested");
	});

	it("when the last opted-in page leaves, nothing is retained or forwarded again", async () => {
		const { clock, runtime } = setup();
		const optedIn = await attach(runtime, clock, { diagnostics: true });
		const plain = await attach(runtime, clock);
		plain.port.postMessage({ nonsense: true });
		await until(clock, () => runtime.stats().invalidEnvelopes === 1);
		expect(forwarded(optedIn)).toContain("invalid-envelope");
		expect(plain.ofType("diagnostic")).toEqual([]);

		optedIn.send({ t: "detach" } as never);
		await until(clock, () => runtime.stats().attachments === 1);
		// The `detached` diagnostic was forwarded before release; let it land.
		await settle(clock, 16);
		const seenBefore = optedIn.ofType("diagnostic").length;

		plain.port.postMessage({ nonsense: true });
		await until(clock, () => runtime.stats().invalidEnvelopes === 2);
		const stats = runtime.stats();
		expect(stats.invalidEnvelopes).toBe(2);
		expect(stats.diagnostics).toEqual([]);
		expect(optedIn.ofType("diagnostic")).toHaveLength(seenBefore);
		expect(plain.ofType("diagnostic")).toEqual([]);
	});

	it("expiry is counted and reported the same with or without diagnostics", async () => {
		const seen: DiagnosticEvent[] = [];
		for (const sink of [
			undefined,
			(event: DiagnosticEvent) => seen.push(event),
		]) {
			const { clock, runtime } = setup(sink);
			const raw = await attach(runtime, clock, { lease: 1_000 });
			expect(runtime.stats().attachments).toBe(1);
			clock.advance(1_001);
			await until(clock, () => runtime.stats().attachments === 0);
			// The `detached` message was posted before the port closed; let it land.
			await settle(clock);
			expect(runtime.stats().expired).toBe(1);
			expect(raw.ofType("detached").map((message) => message.code)).toEqual([
				"lease-expired",
			]);
			expect(runtime.stats().diagnostics.map((event) => event.type)).toEqual(
				sink === undefined ? [] : ["attached", "attachment-expired"],
			);
		}
		expect(seen.map((event) => event.type)).toEqual([
			"attached",
			"attachment-expired",
		]);
	});
});
