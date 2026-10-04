import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	type BudgetRow,
	budgetDispersion,
	evaluateRow,
	isGateRow,
	sampleSd,
} from "../../performance/lib/stats.ts";

// Signed heap differences use standard deviation relative to a positive budget; coefficient of variation is unstable near zero.

const budgets = JSON.parse(
	readFileSync(
		new URL("../../performance/budgets.json", import.meta.url),
		"utf8",
	),
) as { rows: BudgetRow[] };

function row(id: string): BudgetRow {
	const found = budgets.rows.find((entry) => entry.id === id);
	if (!found) throw new Error(`no budget row ${id}`);
	return found;
}

const MiB = 1_048_576;
const alternate = (low: number, high: number) =>
	Array.from({ length: 10 }, (_, index) => (index % 2 === 0 ? low : high));
const ten = (value: number) => Array.from({ length: 10 }, () => value);

const cycles = row("heap.cycles.graphql-ws.page");
const slope = row("history.ws.page.slope");
// Exercise ordinary timing, independently of the explicit clock-scale opt-in.
const timing = { ...row("latency.ws.n1.cross.p95"), noiseScale: undefined };

describe("signed heap measurement controls", () => {
	it("uses the real 1 MiB signed heap row", () => {
		expect(cycles).toMatchObject({
			kind: "heap",
			gate: "median",
			comparator: "<=",
			target: MiB,
		});
	});

	it("passes small signed variation around zero on its median", () => {
		const result = evaluateRow(cycles, alternate(-1024, 1024));
		expect(result.status).toBe("pass");
		expect(result.measured).toBe(0);
		// Raw CV stays informational: undefined at mean 0, never replaced by 0.
		expect(result.cv).toBeNull();
		expect(result.reason).toMatch(/^median of 10 run\(s\)/);
		expect(result.reason).toContain("budget-relative dispersion 0.1 %");
	});

	it("does not flip when the same readings shift by one byte", () => {
		const result = evaluateRow(cycles, alternate(-1023, 1025));
		expect(result.status).toBe("pass");
		expect(result.measured).toBe(1);
		expect(result.cv).toBeCloseTo(1079.3907746708069, 9);
	});

	it("marks large signed variation around zero noisy, never pass", () => {
		const values = alternate(-2 * MiB, 2 * MiB);
		const result = evaluateRow(cycles, values);
		expect(result.status).toBe("noisy");
		expect(result.measured).toBe(0);
		expect(result.cv).toBeNull();
		expect(result.reason).toContain("budget-relative dispersion 210.8 %");
		expect(result.reason).toContain("> 10 %");
		expect(budgetDispersion(values, MiB)).toBeCloseTo(
			2_210_592.3065258125 / MiB,
			12,
		);
	});
});

describe("budget-relative dispersion for gated heap rows", () => {
	it("is sample SD ÷ positive target, NaN without a usable scale", () => {
		const values = alternate(-1024, 1024);
		expect(budgetDispersion(values, MiB)).toBe(sampleSd(values) / MiB);
		for (const scale of [null, 0, -MiB, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(budgetDispersion(values, scale), String(scale)).toBeNaN();
		}
		expect(budgetDispersion([5], MiB)).toBeNaN();
	});

	it("still fails a stable above-budget result", () => {
		const stable = evaluateRow(cycles, ten(2 * MiB));
		expect(stable.status).toBe("fail");
		expect(stable.measured).toBe(2 * MiB);
		const nearly = evaluateRow(cycles, alternate(2 * MiB - 1024, 2 * MiB));
		expect(nearly.status).toBe("fail");
	});

	it("keeps above-noise values noisy, above or below the budget", () => {
		// history slope: target 16 B/event, so the tolerance is SD ≤ 1.6.
		expect(slope).toMatchObject({ kind: "heap", target: 16 });
		expect(evaluateRow(slope, alternate(-1.4, 1.4)).status).toBe("pass");
		expect(evaluateRow(slope, alternate(-1.6, 1.6)).status).toBe("noisy");
		expect(evaluateRow(slope, alternate(0, 40)).status).toBe("noisy");
		expect(evaluateRow(slope, alternate(100, 140)).status).toBe("noisy");
	});

	it("does not call small positive heap deltas noisy because of their CV", () => {
		const values = alternate(100, 200);
		const result = evaluateRow(cycles, values);
		expect(result.cv).toBeGreaterThan(0.1);
		expect(result.status).toBe("pass");
	});

	it("fails closed without a positive finite scale for a gated heap row", () => {
		for (const target of [
			null,
			0,
			-MiB,
			Number.NaN,
			Number.POSITIVE_INFINITY,
		]) {
			const result = evaluateRow({ ...cycles, target }, ten(0));
			expect(result.status, String(target)).toBe("not-measured");
			expect(result.measured).toBe(0);
			expect(result.reason).toContain("budget-relative dispersion");
			expect(result.reason).toContain("never a pass");
		}
	});

	it("fails closed when the spread itself is undefined", () => {
		const result = evaluateRow(cycles, [0], {
			profile: "pinned",
			minRuns: 1,
			maxCv: 0.1,
		});
		expect(result.status).toBe("not-measured");
	});

	it("keeps the ten-repetition and smoke rules", () => {
		const nine = evaluateRow(cycles, alternate(-1024, 1024).slice(0, 9));
		expect(nine.status).toBe("informational");
		expect(nine.reason).toBe("only 9 run(s); 10 needed before gating");
		const smoke = evaluateRow(cycles, alternate(-2 * MiB, 2 * MiB), {
			profile: "smoke",
			minRuns: 10,
			maxCv: 0.1,
		});
		expect(smoke.status).toBe("informational");
		expect(evaluateRow(cycles, []).status).toBe("not-measured");
		expect(evaluateRow(cycles, [...ten(0), Number.NaN]).status).toBe("fail");
	});

	it("applies to every gated heap row, all of which have positive targets", () => {
		const gated = budgets.rows.filter(
			(entry) => entry.kind === "heap" && isGateRow(entry),
		);
		expect(gated.length).toBeGreaterThanOrEqual(18);
		for (const entry of gated) {
			expect(entry.target, entry.id).toBeGreaterThan(0);
			expect(entry.gate ?? "median", entry.id).toBe("median");
			const scale = entry.target as number;
			const large = alternate(-2 * scale, 2 * scale);
			expect(evaluateRow(entry, large).status, entry.id).toBe("noisy");
			expect(evaluateRow(entry, ten(0)).status, entry.id).toBe("pass");
		}
	});
});

describe("rows the heap rule leaves alone", () => {
	it("keeps report-only and informational heap rows informative", () => {
		const report = row("heap.five-tabs.ws.vs-noop-worker");
		expect(report).toMatchObject({ kind: "heap", comparator: "report" });
		const reported = evaluateRow(report, alternate(-2 * MiB, 2 * MiB));
		expect(reported.status).toBe("informational");
		expect(reported.measured).toBe(0);
		const informational = evaluateRow(
			{ ...cycles, role: "informational" },
			alternate(-2 * MiB, 2 * MiB),
		);
		expect(informational.status).toBe("informational");
		expect(informational.reason).toMatch(/^informational row, never gates/);
	});

	it("keeps the CV rule for ordinary positive-duration timing rows", () => {
		expect(timing).toMatchObject({ kind: "timing", target: 5 });
		const passed = evaluateRow(timing, [...ten(4), 4.2]);
		expect(passed.status).toBe("pass");
		expect(passed.reason).toBe("median of 11 run(s)");
		const noisy = evaluateRow(timing, [1, 1, 1, 1, 1, 4, 4, 4, 4, 4]);
		expect(noisy.status).toBe("noisy");
		expect(noisy.reason).toMatch(/^CV \d+\.\d % > 10 %: rerun$/);
		expect(evaluateRow(timing, ten(6)).status).toBe("fail");
	});

	it("keeps structural semantics", () => {
		const structural = {
			comparator: "==" as const,
			target: 1,
			gate: "all" as const,
		};
		expect(evaluateRow(structural, ten(1)).status).toBe("pass");
		expect(evaluateRow(structural, [...ten(1), 2]).status).toBe("fail");
	});
});
