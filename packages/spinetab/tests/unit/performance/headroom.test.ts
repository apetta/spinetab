import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	type HwmKey,
	headroomRows,
	highWater,
	Recorded,
	type RuntimeStatsLike,
	recordHighWater,
	SAMPLED_ONLY,
} from "../../performance/lib/record.ts";
import {
	type BudgetRow,
	collectRuns,
	evaluateRow,
	isGateRow,
	isSampledMetric,
	type MetricTable,
	sampledGateRows,
} from "../../performance/lib/stats.ts";

// Sampled high-water marks bound the peak from below and must never produce a passing headroom gate.

const budgets = JSON.parse(
	readFileSync(
		new URL("../../performance/budgets.json", import.meta.url),
		"utf8",
	),
) as { rows: BudgetRow[] };
const row = (id: string) => {
	const found = budgets.rows.find((entry) => entry.id === id);
	if (!found) throw new Error(`no budget row ${id}`);
	return found;
};

function snapshot(
	overrides: Partial<RuntimeStatsLike> = {},
	pendingMessages = 10,
): RuntimeStatsLike {
	return {
		id: "runtime",
		attachments: 1,
		consumers: 100,
		ledgers: 100,
		pendingMessages,
		pendingBytes: pendingMessages * 3_000,
		connections: 1,
		subscriptions: 100,
		pendingCommands: 0,
		pendingCredentialRequests: 0,
		perAttachment: [
			{
				consumers: 100,
				ledgers: 100,
				pendingMessages,
				pendingBytes: pendingMessages * 3_000,
				pendingControl: 0,
				queuedControl: 0,
				queuedControlBytes: 0,
			},
		],
		diagnostics: [],
		...overrides,
	};
}

/** What tabs.perf.ts records for one config, run through the budget path. */
function headroomRun(samples: RuntimeStatsLike[], at = "ws.n5") {
	const out = new Recorded();
	recordHighWater(out, highWater(samples), headroomRows(at));
	return out;
}

/** Ten pinned runs of the same record, as aggregate.ts tables them. */
function table(out: Recorded): MetricTable {
	const result: MetricTable = new Map();
	for (const [id, value] of Object.entries(out.metrics)) {
		const runs = new Map<string, number | number[]>();
		for (let rep = 0; rep < 10; rep += 1) runs.set(`${rep}.0`, value);
		result.set(id, runs);
	}
	return result;
}

const evaluate = (id: string, metrics: MetricTable) => {
	const budget = row(id);
	return evaluateRow(budget, collectRuns(metrics, budget));
};

const HWM: Partial<Record<HwmKey, number>> = {
	pendingMessages: 10,
	pendingBytes: 30_000,
	perConsumerMessages: 2,
	perConsumerBytes: 6_000,
	pendingCommands: 0,
	controlMessages: 1,
	controlQueued: 36,
	controlQueuedBytes: 6_876,
	subscriptions: 100,
	consumersPerAttachment: 100,
	connections: 1,
};

describe("recordHighWater", () => {
	it("marks the gate ids not measured and reports sampled values apart", () => {
		const out = headroomRun([snapshot(), snapshot({}, 12)]);
		expect(out.notMeasured["headroom.ws.n5.pendingMessages"]).toBe(
			SAMPLED_ONLY,
		);
		expect(out.metrics["headroom.ws.n5.pendingMessages"]).toBeUndefined();
		expect(out.metrics["headroom.sampled.ws.n5.pendingMessages"]).toBeCloseTo(
			256 / 12,
			12,
		);
		// Per-consumer peaks are not visible in snapshots at all.
		expect(
			out.notMeasured["headroom.sampled.ws.n5.perConsumerMessages"],
		).toMatch(/snapshots do not expose/);
		for (const id of Object.keys(out.metrics)) {
			expect(isSampledMetric(id), id).toBe(true);
		}
	});

	it("measures the gate ids from the runtime's own hwm", () => {
		const out = headroomRun([snapshot({ hwm: HWM })]);
		expect(out.metrics["headroom.ws.n5.pendingMessages"]).toBeCloseTo(25.6, 12);
		expect(out.metrics["headroom.ws.n5.connections"]).toBe(32);
		expect(Object.keys(out.metrics).some(isSampledMetric)).toBe(false);
		expect(Object.keys(out.notMeasured)).toEqual([]);
	});
});

describe("headroom gates", () => {
	const gates = [
		"headroom.pendingMessages",
		"headroom.pendingBytes",
		"headroom.controlQueued",
		"headroom.controlQueuedBytes",
		"headroom.subscriptions",
		"headroom.consumersPerAttachment",
		"headroom.connections",
	];

	it("never pass from sampled data, however large the sampled headroom", () => {
		const metrics = table(headroomRun([snapshot({}, 1)]));
		for (const id of gates) {
			const result = evaluate(id, metrics);
			expect(result.status, id).toBe("not-measured");
			expect(result.measured, id).toBeNull();
		}
		for (const id of gates.map((gate) =>
			gate.replace("headroom.", "headroom.sampled."),
		)) {
			const result = evaluate(id, metrics);
			expect(result.status, id).toBe("informational");
			expect(result.measured, id).not.toBeNull();
		}
	});

	it("ignore sampled ids even when a gate pattern would match them", () => {
		const broad = {
			id: "headroom.any",
			role: "gate" as const,
			comparator: ">=" as const,
			target: 4,
			gate: "all" as const,
			kind: "structural" as const,
			match: { pattern: "pendingMessages$", reduce: "min" as const },
		};
		const metrics = table(headroomRun([snapshot({}, 1)]));
		expect(collectRuns(metrics, broad)).toEqual([]);
		expect(evaluateRow(broad, collectRuns(metrics, broad)).status).toBe(
			"not-measured",
		);
	});

	it("pass and fail from the runtime hwm", () => {
		const healthy = table(headroomRun([snapshot({ hwm: HWM })]));
		for (const id of gates) {
			expect(evaluate(id, healthy).status, id).toBe("pass");
		}
		const tight = table(
			headroomRun([snapshot({ hwm: { ...HWM, pendingMessages: 200 } })]),
		);
		const result = evaluate("headroom.pendingMessages", tight);
		expect(result.status).toBe("fail");
		expect(result.measured).toBeCloseTo(1.28, 12);
		// No sampled row receives runtime values.
		expect(evaluate("headroom.sampled.pendingMessages", healthy).measured).toBe(
			null,
		);
	});
});

describe("informational rows", () => {
	it("never pass, fail or become noisy, whatever the comparator", () => {
		const base = {
			comparator: ">=" as const,
			target: 4,
			role: "informational" as const,
		};
		const ten = (value: number) => Array.from({ length: 10 }, () => value);
		for (const [runs, gate, kind] of [
			[ten(100), "all", "structural"],
			[ten(1), "all", "structural"],
			[[...ten(1), Number.NaN], "all", "structural"],
			[[1, 1, 1, 1, 1, 9, 9, 9, 9, 9], "median", "timing"],
			[[], "median", "timing"],
		] as const) {
			const result = evaluateRow({ ...base, gate, kind }, runs);
			expect(result.status).toBe("informational");
			expect(result.reason).toMatch(/^informational row, never gates/);
		}
	});
});

describe("budgets.json", () => {
	it("has no gate row whose evidence is sampled", () => {
		expect(sampledGateRows(budgets.rows).map((entry) => entry.id)).toEqual([]);
	});

	it("keeps every sampled row informational", () => {
		const sampled = budgets.rows.filter((entry) => isSampledMetric(entry.id));
		expect(sampled.length).toBeGreaterThanOrEqual(17);
		for (const entry of sampled) {
			expect(entry.role, entry.id).toBe("informational");
			expect(evaluateRow(entry, [1]).status, entry.id).toBe("informational");
			expect(isGateRow(entry), entry.id).toBe(false);
		}
	});

	it("gates headroom and window caps at the plan's targets", () => {
		for (const name of [
			"pendingMessages",
			"pendingBytes",
			"perConsumerMessages",
			"perConsumerBytes",
			"controlQueued",
			"controlQueuedBytes",
			"subscriptions",
			"consumersPerAttachment",
			"connections",
		]) {
			const gate = row(`headroom.${name}`);
			expect(isGateRow(gate), gate.id).toBe(true);
			expect([gate.comparator, gate.target]).toEqual([">=", 4]);
		}
		// the posted window is flow control. The row keeps its
		// recorded target and history but is informational.
		const posted = row("headroom.controlMessages");
		expect(isGateRow(posted)).toBe(false);
		expect([posted.comparator, posted.target, posted.role]).toEqual([
			">=",
			4,
			"informational",
		]);
		expect(isGateRow(row("headroom.pendingCommands"))).toBe(false);
		expect(isGateRow(row("limits.window.ws.pending-messages.hwm"))).toBe(true);
		expect(isGateRow(row("limits.window.ws.sampled.pending-messages"))).toBe(
			false,
		);
	});
});
