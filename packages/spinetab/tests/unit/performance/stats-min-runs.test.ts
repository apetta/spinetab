import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	type BudgetRow,
	DEFAULT_EVALUATION,
	evaluateRow,
	isGateRow,
	MIN_RUNS_FLOOR,
	minRunsProblems,
} from "../../performance/lib/stats.ts";

const budgets = JSON.parse(
	readFileSync(
		new URL("../../performance/budgets.json", import.meta.url),
		"utf8",
	),
) as { rows: BudgetRow[] };

const THREE_RUN_ROWS = [
	"history.graphql-ws.page.slope",
	"history.graphql-ws.page.growth",
	"history.graphql-ws.worker.slope",
	"history.graphql-ws.worker.growth",
	"history.ws.page.slope",
	"history.ws.page.growth",
	"history.ws.worker.slope",
	"history.ws.worker.growth",
	"limits.window.graphql-ws.worker-heap-delta",
	"limits.window.ws.worker-heap-delta",
	"limits.window-bytes.graphql-ws.worker-heap-delta",
	"limits.window-bytes.ws.worker-heap-delta",
];
const history = budgets.rows.filter(
	(row) => row.id.startsWith("history.") && row.kind === "heap",
);
const limitsHeap = budgets.rows.filter(
	(row) =>
		row.id.startsWith("limits.") &&
		(row.kind === "heap" || row.kind === "timing") &&
		row.comparator !== "report",
);
/** Far inside ≤ 16 B/event and ≤ 256 KiB. */
const good = (row: BudgetRow) => (row.unit === "B/event" ? 1 : 1024);

describe("short heap scenarios", () => {
	it("history heap rows are covered by the short-scenario sample floor", () => {
		expect(history.map((row) => row.id).sort()).toEqual(
			THREE_RUN_ROWS.filter((id) => id.startsWith("history.")).sort(),
		);
	});

	it("gated heap/timing rows fed only by @limits are the four window heap deltas", () => {
		expect(limitsHeap.map((row) => row.id).sort()).toEqual(
			THREE_RUN_ROWS.filter((id) => id.startsWith("limits.")).sort(),
		);
	});

	it("three excellent, stable eligible runs (all the procedure produces) gate", () => {
		for (const row of history) {
			const value = good(row);
			expect(
				evaluateRow(row, [value, value, value], DEFAULT_EVALUATION).status,
				row.id,
			).toBe("pass");
		}
	});

	it("three labelled @limits stall-window reps gate; one run stays informational", () => {
		for (const row of limitsHeap) {
			expect(
				evaluateRow(row, [4096, 4096, 4096], DEFAULT_EVALUATION).status,
				row.id,
			).toBe("pass");
			const one = evaluateRow(row, [4096], DEFAULT_EVALUATION);
			expect(one.status, row.id).toBe("informational");
			expect(one.reason).toBe("only 1 run(s); 3 needed before gating");
		}
	});
});

describe("per-row minRuns", () => {
	const heap: BudgetRow = {
		...(history[0] as BudgetRow),
		target: 16,
		minRuns: 3,
	};
	const timing: BudgetRow = {
		...(budgets.rows.find(
			(row) => row.kind === "timing" && isGateRow(row),
		) as BudgetRow),
		target: 5,
	};

	it("gates a heap row at its minRuns and keeps two runs informational", () => {
		expect(evaluateRow(heap, [1, 1, 1]).status).toBe("pass");
		expect(evaluateRow(heap, [20, 20, 20]).status).toBe("fail");
		const two = evaluateRow(heap, [1, 1]);
		expect(two.status).toBe("informational");
		expect(two.reason).toBe("only 2 run(s); 3 needed before gating");
	});

	it("never lets a heap row gate below the floor of 3", () => {
		expect(MIN_RUNS_FLOOR).toBe(3);
		for (const minRuns of [0, 1, 2]) {
			const row = { ...heap, minRuns };
			expect(evaluateRow(row, [1, 1]).status, String(minRuns)).toBe(
				"informational",
			);
			expect(evaluateRow(row, [1, 1, 1]).status, String(minRuns)).toBe("pass");
		}
	});

	it("keeps the dispersion and smoke rules at three runs", () => {
		const noisy = evaluateRow(heap, [0, 8, 16]);
		expect(noisy.status).toBe("noisy");
		expect(noisy.reason).toContain("budget-relative dispersion");
		const smoke = evaluateRow(heap, [1, 1, 1], {
			...DEFAULT_EVALUATION,
			profile: "smoke",
		});
		expect(smoke.status).toBe("informational");
	});

	it("may raise but never lower a timing row's ten-run minimum", () => {
		const three = Array(3).fill(1);
		const ten = Array(10).fill(1);
		expect(evaluateRow({ ...timing, minRuns: 3 }, three).status).toBe(
			"informational",
		);
		expect(evaluateRow({ ...timing, minRuns: 3 }, ten).status).toBe("pass");
		const raised = evaluateRow({ ...timing, minRuns: 12 }, ten);
		expect(raised.status).toBe("informational");
		expect(raised.reason).toBe("only 10 run(s); 12 needed before gating");
	});

	it("rows without minRuns keep the evaluation's ten runs", () => {
		const { minRuns: _omit, ...plain } = heap;
		const nine = evaluateRow(plain, Array(9).fill(1));
		expect(nine.status).toBe("informational");
		expect(nine.reason).toBe("only 9 run(s); 10 needed before gating");
	});
});

describe("budgets.json minRuns", () => {
	it("every declared minRuns sits on a gated heap median row as an integer ≥ 3", () => {
		expect(minRunsProblems(budgets.rows)).toEqual([]);
		expect(
			minRunsProblems([
				{ ...historyRow(), minRuns: 2 },
				{ ...historyRow(), id: "x.float", minRuns: 3.5 },
				{ ...historyRow(), id: "x.timing", kind: "timing", minRuns: 3 },
				{ ...historyRow(), id: "x.report", comparator: "report", minRuns: 3 },
				{ ...historyRow(), id: "x.all", gate: "all", minRuns: 3 },
			]),
		).toEqual([
			"history.graphql-ws.page.slope: minRuns 2 must be an integer ≥ 3",
			"x.float: minRuns 3.5 must be an integer ≥ 3",
			"x.timing: minRuns is only allowed on gated heap rows gated by median",
			"x.report: minRuns is only allowed on gated heap rows gated by median",
			"x.all: minRuns is only allowed on gated heap rows gated by median",
		]);
	});

	it("short heap scenarios declare a three-run floor", () => {
		const declared = budgets.rows.filter((row) => row.minRuns !== undefined);
		expect(declared.map((row) => row.id).sort()).toEqual(
			[...THREE_RUN_ROWS].sort(),
		);
		for (const row of declared)
			expect(row.minRuns, row.id).toBe(MIN_RUNS_FLOOR);
	});
});

function historyRow(): BudgetRow {
	return { ...(history[0] as BudgetRow) };
}
