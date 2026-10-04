import { describe, expect, it } from "vitest";
import type {
	TimedEntry,
	TimedStatusEntry,
} from "../../fixtures/harness/src/bench/timed.ts";
import {
	derivePhases,
	type PhaseInput,
	type Phases,
} from "../../performance/lib/phases.ts";

/** Worker clock is OFFSET ahead of the page clock: page = remote − OFFSET. */
const OFFSET = 250;
const T0 = 10_000;
const G = "graphql-ws";

/** A status `ms` after t0 on the page clock, stamped on the worker clock. */
function status(
	ms: number,
	state: string,
	extra: Partial<TimedStatusEntry> = {},
): TimedStatusEntry {
	return { at: T0 + ms + OFFSET, adapter: G, state, ...extra };
}

function probe(ms: number, adapter = G): TimedEntry {
	return { at: T0 + ms + OFFSET, adapter };
}

function input(overrides: Partial<PhaseInput> = {}): PhaseInput {
	return {
		t0: T0,
		offset: OFFSET,
		statuses: [],
		probes: [probe(2)],
		firstEvent: T0 + 5_300,
		restored: T0 + 5_400,
		adapter: G,
		...overrides,
	};
}

const DERIVED = ["detection", "retryStart", "ack"] as const;

function expectNoted(phases: Phases, name: string): void {
	expect(phases.notes.some((note) => note.startsWith(`${name}:`))).toBe(true);
}

describe("derivePhases", () => {
	it("derives the watchdog path: heartbeat-timeout, retry, ack, delivery", () => {
		const phases = derivePhases(
			input({
				statuses: [
					status(5_002, "reconnecting", { reason: "heartbeat-timeout" }),
					status(5_004, "reconnecting", {
						reason: "heartbeat-timeout",
						code: "close:4499",
					}),
					status(5_150, "reconnecting", {
						reason: "heartbeat-timeout",
						attempt: 1,
					}),
					status(5_210, "connected"),
				],
			}),
		);
		expect(phases.label).toBe("derived, informational");
		expect(phases.detection).toBe(5_002);
		expect(phases.retryStart).toBe(5_150);
		expect(phases.ack).toBe(5_210);
		expect(phases.ackAfter).toBe("retry-start");
		expect(phases.healthStart).toBe(2);
		expect(phases.firstEvent).toBe(5_300);
		expect(phases.restored).toBe(5_400);
		expect(phases.statuses).toHaveLength(4);
		expect(phases.notes).toEqual([]);
	});

	it("derives the terminate path from a close-driven reconnecting status", () => {
		const phases = derivePhases(
			input({
				statuses: [
					status(40, "reconnecting", { reason: "network", code: "close:1006" }),
					status(900, "reconnecting", { reason: "network", attempt: 1 }),
					status(960, "connected"),
				],
			}),
		);
		expect(phases.detection).toBe(40);
		expect(phases.retryStart).toBe(900);
		expect(phases.ack).toBe(960);
		expect(phases.statuses[0]).toEqual({
			ms: 40,
			state: "reconnecting",
			reason: "network",
			code: "close:1006",
		});
	});

	it("reports a slow-but-healthy trial as null phases with reasons, not zeros", () => {
		const phases = derivePhases(input());
		for (const name of DERIVED) {
			expect(phases[name]).toBeNull();
			expectNoted(phases, name);
		}
		expect(phases.ackAfter).toBeNull();
		expect(phases.notes).toContain(
			"detection: no reconnecting status observed",
		);
		expect(phases.healthStart).toBe(2);
	});

	it("does not attribute a connected status without a preceding detection", () => {
		const phases = derivePhases(
			input({
				statuses: [
					status(100, "connecting", { attempt: 0 }),
					status(180, "connected"),
				],
			}),
		);
		expect(phases.ack).toBeNull();
		expect(phases.ackAfter).toBeNull();
		expect(phases.notes.find((note) => note.startsWith("ack:"))).toMatch(
			/no detection observed/,
		);
	});

	it("labels an ack that follows detection when no retry start was observed", () => {
		const phases = derivePhases(
			input({
				statuses: [
					status(10, "reconnecting", { reason: "network" }),
					status(70, "connected"),
				],
			}),
		);
		expect(phases.retryStart).toBeNull();
		expectNoted(phases, "retryStart");
		expect(phases.ack).toBe(70);
		expect(phases.ackAfter).toBe("detection");
	});

	it("keeps detection null for an adapter that reports an attempt on every reconnecting status", () => {
		const phases = derivePhases(
			input({
				adapter: "websocket",
				statuses: [
					{
						...status(30, "reconnecting", { reason: "network", attempt: 1 }),
						adapter: "websocket",
					},
					{ ...status(600, "connected"), adapter: "websocket" },
				],
			}),
		);
		for (const name of DERIVED) expect(phases[name]).toBeNull();
		expect(phases.notes.find((note) => note.startsWith("detection:"))).toMatch(
			/attempt field on every reconnecting status/,
		);
	});

	it("ignores and counts statuses before the window start", () => {
		const earlier = [
			status(-20_000, "reconnecting", { reason: "heartbeat-timeout" }),
			status(-19_000, "reconnecting", { reason: "network", attempt: 1 }),
			status(-18_900, "connected"),
		];
		const withoutFault = derivePhases(input({ statuses: earlier }));
		expect(withoutFault.stale).toBe(3);
		expect(withoutFault.statuses).toEqual([]);
		for (const name of DERIVED) expect(withoutFault[name]).toBeNull();
		expect(withoutFault.notes[0]).toMatch(/precede the window start \(t0\)/);

		// With faultAt, a fault-driven recovery before the hint is kept and
		// reported as negative (preceding t0); older trials stay stale.
		const withFault = derivePhases(
			input({
				faultAt: T0 - 3_000,
				statuses: [
					...earlier,
					status(-2_900, "reconnecting", { reason: "network" }),
					status(-2_000, "reconnecting", { reason: "network", attempt: 1 }),
					status(-1_950, "connected"),
				],
			}),
		);
		expect(withFault.stale).toBe(3);
		expect(withFault.detection).toBe(-2_900);
		expect(withFault.retryStart).toBe(-2_000);
		expect(withFault.ack).toBe(-1_950);
		expect(withFault.notes).toContain(
			"detection: precedes t0 (before the return hint)",
		);
		expect(withFault.notes[0]).toMatch(/\(faultAt\)/);
	});

	it("filters out other adapters' statuses", () => {
		const phases = derivePhases(
			input({
				statuses: [
					{
						...status(10, "reconnecting", { reason: "network" }),
						adapter: "websocket",
					},
					{
						...status(20, "reconnecting", { reason: "network", attempt: 1 }),
						adapter: "websocket",
					},
					{ ...status(30, "connected"), adapter: "websocket" },
				],
			}),
		);
		expect(phases.otherAdapter).toBe(3);
		expect(phases.statuses).toEqual([]);
		for (const name of DERIVED) expect(phases[name]).toBeNull();
	});

	it("calibrates worker stamps to the page clock as remote − offset", () => {
		const raw: TimedStatusEntry = {
			at: T0 + 1_000,
			adapter: G,
			state: "reconnecting",
			reason: "heartbeat-timeout",
		};
		const phases = derivePhases(input({ statuses: [raw] }));
		expect(phases.detection).toBe(1_000 - OFFSET);
		// The raw entry is not mutated.
		expect(raw.at).toBe(T0 + 1_000);
	});

	it("matches return.perf.ts's health-start rule", () => {
		const probes = [probe(-500), probe(-1), probe(3), probe(9)];
		// return.perf.ts: probes.map(at − offset).find(at ≥ t0) − t0.
		const reference = probes
			.map((entry) => entry.at - OFFSET)
			.find((at) => at >= T0);
		expect(derivePhases(input({ probes })).healthStart).toBe(
			(reference as number) - T0,
		);
		expect(derivePhases(input({ probes: [probe(0)] })).healthStart).toBe(0);
		const none = derivePhases(input({ probes: [probe(-1)] }));
		expect(none.healthStart).toBeNull();
		expectNoted(none, "healthStart");
	});

	it("turns missing deliveries into null with reasons", () => {
		const phases = derivePhases(
			input({ firstEvent: Number.NaN, restored: Number.NaN }),
		);
		expect(phases.firstEvent).toBeNull();
		expect(phases.restored).toBeNull();
		expectNoted(phases, "firstEvent");
		expectNoted(phases, "restored");
	});

	it("never fabricates a zero duration when the supporting status is absent", () => {
		// Every status at exactly t0 would yield 0 if a phase were derived; a
		// fabricated fallback (e.g. `?? 0` or t0 − t0) would show up here too.
		const cases: TimedStatusEntry[][] = [
			[],
			[status(0, "connected")],
			[status(0, "connecting", { attempt: 0 })],
			[status(0, "reconnecting", { reason: "network", attempt: 1 })],
			[{ ...status(0, "reconnecting"), adapter: "websocket" }],
		];
		for (const statuses of cases) {
			const phases = derivePhases(
				input({
					statuses,
					probes: [],
					firstEvent: Number.NaN,
					restored: Number.NaN,
				}),
			);
			for (const name of [
				...DERIVED,
				"healthStart",
				"firstEvent",
				"restored",
			] as const) {
				expect(phases[name], `${name} with ${JSON.stringify(statuses)}`).toBe(
					null,
				);
				expectNoted(phases, name);
			}
		}
	});
});
