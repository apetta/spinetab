import { describe, expect, it } from "vitest";
import {
	cv,
	evaluateRow,
	histogram,
	median,
	nearestRank,
	sampleSd,
	slope,
	summarise,
} from "../../performance/lib/stats.ts";

describe("percentiles and spread", () => {
	const values = [15, 20, 35, 40, 50];

	it("uses nearest rank for p50/p95", () => {
		expect(nearestRank(values, 50)).toBe(35);
		expect(nearestRank(values, 95)).toBe(50);
		expect(nearestRank(values, 0)).toBe(15);
		expect(nearestRank(values, 100)).toBe(50);
		const hundred = Array.from({ length: 100 }, (_, index) => index + 1);
		expect(nearestRank(hundred, 95)).toBe(95);
		expect(nearestRank([], 50)).toBeNaN();
	});

	it("computes the median, sample SD and CV", () => {
		expect(median(values)).toBe(35);
		expect(median([1, 2, 3, 4])).toBe(2.5);
		expect(sampleSd([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.13809, 5);
		expect(cv([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.13809 / 5, 5);
		expect(cv([1])).toBeNaN();
		expect(cv([0, 0])).toBeNaN();
	});

	it("ignores non-finite values in summaries", () => {
		const summary = summarise([3, Number.NaN, 1, 2, Number.POSITIVE_INFINITY]);
		expect(summary.n).toBe(3);
		expect(summary.min).toBe(1);
		expect(summary.max).toBe(3);
		expect(summary.p50).toBe(2);
	});

	it("bins a 0.1 ms histogram without float drift", () => {
		expect(histogram([0.05, 0.1, 0.19, 0.3, 0.3])).toEqual([
			[0, 1],
			[0.1, 2],
			[0.3, 2],
		]);
	});

	it("fits a least-squares slope", () => {
		expect(slope([0, 1, 2, 3], [10, 12, 14, 16])).toBeCloseTo(2, 12);
		expect(slope([1, 1], [2, 3])).toBeNaN();
	});
});

describe("evaluateRow", () => {
	const timing = {
		comparator: "<=" as const,
		target: 5,
		kind: "timing" as const,
		gate: "median" as const,
	};
	const ten = (value: number) => Array.from({ length: 10 }, () => value);

	it("gates on the median of ≥ 10 runs", () => {
		const result = evaluateRow(timing, [...ten(4), 4.2]);
		expect(result.status).toBe("pass");
		expect(result.measured).toBe(4);
		// One slow run among eleven raises the CV above 10 %: rerun, not pass.
		expect(evaluateRow(timing, [...ten(4), 9]).status).toBe("noisy");
		expect(evaluateRow(timing, ten(6)).status).toBe("fail");
	});

	it("never gates timing below the minimum runs or in the smoke profile", () => {
		expect(evaluateRow(timing, [1, 1, 1]).status).toBe("informational");
		expect(
			evaluateRow(timing, ten(9), {
				profile: "smoke",
				minRuns: 10,
				maxCv: 0.1,
			}).status,
		).toBe("informational");
	});

	it("marks a CV above 10 % noisy", () => {
		const result = evaluateRow(timing, [1, 1, 1, 1, 1, 4, 4, 4, 4, 4]);
		expect(result.status).toBe("noisy");
		expect(result.cv).toBeGreaterThan(0.1);
	});

	it("does not accept timing measurements with undefined CV", () => {
		const result = evaluateRow(timing, ten(0));
		expect(result.measured).toBe(0);
		expect(result.cv).toBeNull();
		expect(result.status).toBe("not-measured");
		expect(result.reason).toContain("timing CV is undefined");
	});

	describe("explicit budget-relative clock measurements", () => {
		const clockTiming = {
			...timing,
			target: 0.5,
			noiseScale: "budget" as const,
		};

		it("qualifies quantised near-zero readings while retaining their actual CV", () => {
			const values = [0, 0.05, 0, 0.05, 0, 0.05, 0, 0.05, 0, 0.05];
			expect(evaluateRow(timing, values).status).toBe("noisy");
			const result = evaluateRow(clockTiming, values);
			expect(result.status).toBe("pass");
			expect(result.cv).toBeGreaterThan(0.1);
			expect(result.reason).toContain("budget-relative dispersion");
			const zero = evaluateRow(clockTiming, ten(0));
			expect(zero.status).toBe("pass");
			expect(zero.cv).toBeNull();
		});

		it("keeps high absolute variation noisy", () => {
			const values = [0, 0.5, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0.5];
			expect(evaluateRow(clockTiming, values).status).toBe("noisy");
		});

		it("fails stable above-budget readings and non-finite observations", () => {
			expect(evaluateRow(clockTiming, ten(0.6)).status).toBe("fail");
			expect(evaluateRow(clockTiming, [...ten(0.1), Number.NaN]).status).toBe(
				"fail",
			);
		});

		it("requires ten eligible readings and never gates a smoke run", () => {
			expect(evaluateRow(clockTiming, [0.1, 0.1, 0.1]).status).toBe(
				"informational",
			);
			expect(
				evaluateRow(clockTiming, ten(0.6), {
					profile: "smoke",
					minRuns: 10,
					maxCv: 0.1,
				}).status,
			).toBe("informational");
		});

		it("does not accept an invalid dispersion budget", () => {
			for (const target of [
				null,
				0,
				-1,
				Number.POSITIVE_INFINITY,
				Number.NaN,
			]) {
				expect(evaluateRow({ ...clockTiming, target }, ten(0.1)).status).toBe(
					"not-measured",
				);
			}
		});

		it("rejects unsupported noise scales and non-median timing gates", () => {
			for (const row of [
				{ ...clockTiming, kind: "structural" as const },
				{ ...clockTiming, gate: "all" as const },
				{ ...clockTiming, gate: "pooled-p95" as const },
				{ ...clockTiming, noiseScale: "invalid" as "budget" },
			]) {
				expect(evaluateRow(row, ten(0.1)).status).toBe("not-measured");
			}
		});
	});

	it("requires every run for structural rows and reports the violator", () => {
		const row = { comparator: "==" as const, target: 1, gate: "all" as const };
		expect(evaluateRow(row, [1, 1, 1]).status).toBe("pass");
		const failed = evaluateRow(row, [1, 2, 1]);
		expect(failed.status).toBe("fail");
		expect(failed.measured).toBe(2);
		expect(failed.reason).toContain("1 of 3");
	});

	it("pools trials for p95 rows and needs 20 trials", () => {
		const row = {
			comparator: "<=" as const,
			target: 5_000,
			gate: "pooled-p95" as const,
			kind: "timing" as const,
		};
		const runs = Array.from({ length: 10 }, (_, index) => [
			1_000 + index,
			2_000 + index,
		]);
		const result = evaluateRow(row, runs);
		expect(result.status).toBe("pass");
		// Nearest rank: ceil(0.95 × 20) = 19th smallest.
		expect(result.measured).toBe(2_008);
		expect(evaluateRow(row, runs.slice(0, 5)).status).toBe("informational");
		expect(
			evaluateRow(row, [...runs, [Number.NaN]]).status,
			"a trial that never restored fails the row",
		).toBe("fail");
	});

	it("keeps unmeasured rows explicit and reports rows without targets", () => {
		expect(evaluateRow(timing, []).status).toBe("not-measured");
		const report = evaluateRow(
			{ comparator: "report", target: null, gate: "median" },
			[3, 5, 4],
		);
		expect(report.status).toBe("informational");
		expect(report.measured).toBe(4);
	});

	it("fails when a run produced no value", () => {
		expect(evaluateRow(timing, [...ten(1), Number.NaN]).status).toBe("fail");
	});
});
