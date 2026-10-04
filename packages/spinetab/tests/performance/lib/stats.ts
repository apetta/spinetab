/**
 * Statistics and budget evaluation.
 * Pure functions with no I/O: unit-tested in tests/unit/performance.
 */

export interface Summary {
	n: number;
	min: number;
	max: number;
	mean: number;
	median: number;
	p50: number;
	p95: number;
	sd: number;
	cv: number;
}

const finite = (values: readonly number[]) =>
	values.filter((value) => Number.isFinite(value));

const ascending = (values: readonly number[]) =>
	[...finite(values)].sort((a, b) => a - b);

/** Nearest-rank percentile (p in 0…100); NaN for an empty set. */
export function nearestRank(values: readonly number[], p: number): number {
	const sorted = ascending(values);
	if (sorted.length === 0) return Number.NaN;
	if (p <= 0) return sorted[0] as number;
	const rank = Math.ceil((p / 100) * sorted.length);
	return sorted[Math.min(sorted.length, rank) - 1] as number;
}

/** Median (mean of the two middle values for an even count). */
export function median(values: readonly number[]): number {
	const sorted = ascending(values);
	if (sorted.length === 0) return Number.NaN;
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1
		? (sorted[middle] as number)
		: ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

export function mean(values: readonly number[]): number {
	const list = finite(values);
	if (list.length === 0) return Number.NaN;
	return list.reduce((sum, value) => sum + value, 0) / list.length;
}

/** Sample standard deviation (n − 1); NaN below two values. */
export function sampleSd(values: readonly number[]): number {
	const list = finite(values);
	if (list.length < 2) return Number.NaN;
	const average = mean(list);
	const squares = list.reduce((sum, value) => sum + (value - average) ** 2, 0);
	return Math.sqrt(squares / (list.length - 1));
}

/** Coefficient of variation: sample SD / mean; NaN below two values or at mean 0. */
export function cv(values: readonly number[]): number {
	const average = mean(values);
	if (!Number.isFinite(average) || average === 0) return Number.NaN;
	return sampleSd(values) / Math.abs(average);
}

/**
 * Budget-relative dispersion: sample SD ÷ the row's positive
 * target, so spread is judged in the row's own units against its budget. Used
 * for gated `kind: "heap"` rows, which are signed differences or slopes: their
 * mean can sit at or near 0, where CV is undefined or unbounded (CV needs
 * ratio-scale data). Not a CV and not a confidence interval. NaN when the
 * scale is missing, non-finite or non-positive, or below two values.
 */
export function budgetDispersion(
	values: readonly number[],
	scale: number | null,
): number {
	if (scale === null || !Number.isFinite(scale) || scale <= 0) {
		return Number.NaN;
	}
	return sampleSd(values) / scale;
}

export function summarise(values: readonly number[]): Summary {
	const sorted = ascending(values);
	return {
		n: sorted.length,
		min: sorted.length ? (sorted[0] as number) : Number.NaN,
		max: sorted.length ? (sorted[sorted.length - 1] as number) : Number.NaN,
		mean: mean(sorted),
		median: median(sorted),
		p50: nearestRank(sorted, 50),
		p95: nearestRank(sorted, 95),
		sd: sampleSd(sorted),
		cv: cv(sorted),
	};
}

/** Fixed-width histogram as sparse [binStart, count] pairs (default 0.1 ms). */
export function histogram(
	values: readonly number[],
	width = 0.1,
): Array<[number, number]> {
	const bins = new Map<number, number>();
	for (const value of finite(values)) {
		const index = Math.floor(value / width + 1e-9);
		bins.set(index, (bins.get(index) ?? 0) + 1);
	}
	return [...bins.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([index, count]) => [Number((index * width).toFixed(6)), count]);
}

/** Least-squares slope of y over x; NaN when x has no spread. */
export function slope(xs: readonly number[], ys: readonly number[]): number {
	const n = Math.min(xs.length, ys.length);
	if (n < 2) return Number.NaN;
	const mx = mean(xs.slice(0, n));
	const my = mean(ys.slice(0, n));
	let numerator = 0;
	let denominator = 0;
	for (let index = 0; index < n; index += 1) {
		const dx = (xs[index] as number) - mx;
		numerator += dx * ((ys[index] as number) - my);
		denominator += dx * dx;
	}
	return denominator === 0 ? Number.NaN : numerator / denominator;
}

export type Comparator = "<=" | ">=" | "==" | "report";
export type RowStatus =
	| "pass"
	| "fail"
	| "noisy"
	| "not-measured"
	| "informational";
/**
 * How per-run values become the gate value: `median` of per-run values
 * (timing and heap), `all` (every run must satisfy; structural facts),
 * `pooled-p95` (trial values pooled across runs, nearest-rank p95).
 */
export type Gate = "median" | "all" | "pooled-p95";
export type RowKind = "timing" | "heap" | "structural" | "size";
/**
 * `gate` rows may pass or fail; `informational` rows are reported only and
 * never become `pass`, `fail` or `noisy`, whatever their comparator.
 */
export type RowRole = "gate" | "informational";

export interface BudgetRow {
	id: string;
	behaviour: string;
	owner: string;
	unit: string;
	comparator: Comparator;
	target: number | null;
	targetState: "provisional" | "frozen";
	reason: string;
	evidence: string;
	kind?: RowKind;
	gate?: Gate;
	/** Minimum pooled trials for `pooled-p95` rows. */
	minTrials?: number;
	/**
	 * Minimum runs before this row may gate: a gated heap row
	 * whose scenario runs in fewer repetitions by procedure (history flatness
	 * in pinned reps 1–3, the @limits stall windows in three labelled reps).
	 * Never below `MIN_RUNS_FLOOR`; on timing rows it can only raise the
	 * evaluation's minimum (see `minRunsProblems` for where it is allowed).
	 */
	minRuns?: number;
	/** Defaults to `gate`. */
	role?: RowRole;
	/** Explicit clock-scale timing qualification; raw CV remains reported. */
	noiseScale?: "budget";
	/** Per-run value: `op` of metrics `a` and `b`. */
	derive?: { op: "sub" | "div"; a: string; b: string };
	/** Per-run value: `reduce` over every metric whose id matches `pattern`. */
	match?: { pattern: string; reduce: "min" | "max" };
}

export interface EvaluationOptions {
	profile: "pinned" | "smoke";
	/** Minimum runs before a timing or heap row may gate. */
	minRuns: number;
	/**
	 * Noise tolerance: a timing row is `noisy` above this CV; a gated
	 * heap row is `noisy` above this budget-relative dispersion.
	 */
	maxCv: number;
}

export const DEFAULT_EVALUATION: EvaluationOptions = {
	profile: "pinned",
	minRuns: 10,
	maxCv: 0.1,
};

/** The fewest runs a gated heap row may gate on, whatever its `minRuns`. */
export const MIN_RUNS_FLOOR = 3;

/**
 * Runs a timed row needs before it gates: a heap row's own `minRuns` (never
 * below the floor), a timing row's `minRuns` only when it raises the
 * evaluation's minimum, otherwise the evaluation's minimum.
 */
function requiredRuns(
	row: Pick<BudgetRow, "kind" | "minRuns">,
	options: EvaluationOptions,
): number {
	if (row.minRuns === undefined) return options.minRuns;
	return row.kind === "heap"
		? Math.max(MIN_RUNS_FLOOR, row.minRuns)
		: Math.max(options.minRuns, row.minRuns);
}

/**
 * Budget rows whose `minRuns` is misplaced or invalid: it belongs only on
 * gated heap rows gated by median, as an integer ≥ `MIN_RUNS_FLOOR`.
 */
export function minRunsProblems(
	rows: ReadonlyArray<
		Pick<
			BudgetRow,
			"id" | "kind" | "gate" | "minRuns" | "role" | "comparator" | "target"
		>
	>,
): string[] {
	const problems: string[] = [];
	for (const row of rows) {
		if (row.minRuns === undefined) continue;
		if (
			row.kind !== "heap" ||
			(row.gate ?? "median") !== "median" ||
			!isGateRow(row)
		) {
			problems.push(
				`${row.id}: minRuns is only allowed on gated heap rows gated by median`,
			);
		} else if (!Number.isInteger(row.minRuns) || row.minRuns < MIN_RUNS_FLOOR) {
			problems.push(
				`${row.id}: minRuns ${row.minRuns} must be an integer ≥ ${MIN_RUNS_FLOOR}`,
			);
		}
	}
	return problems;
}

export interface Evaluation {
	measured: number | null;
	cv: number | null;
	status: RowStatus;
	reason: string;
}

export function compare(
	value: number,
	comparator: Comparator,
	target: number | null,
): boolean {
	if (comparator === "report" || target === null) return true;
	if (comparator === "<=") return value <= target;
	if (comparator === ">=") return value >= target;
	return value === target;
}

/**
 * Evaluate one budget row from per-run values (one entry per run; an array
 * entry holds that run's trial values for `pooled-p95`). Only `measured`,
 * `cv`, `status` and `reason` are produced: targets and approvals are never
 * touched here.
 */
export function evaluateRow(
	row: Pick<
		BudgetRow,
		| "comparator"
		| "target"
		| "kind"
		| "gate"
		| "minTrials"
		| "minRuns"
		| "role"
		| "noiseScale"
	>,
	runs: ReadonlyArray<number | readonly number[]>,
	options: EvaluationOptions = DEFAULT_EVALUATION,
): Evaluation {
	if (row.role === "informational") {
		// Evaluated as a report so no comparator can turn it into a verdict.
		const reported = evaluateGate(
			{ ...row, comparator: "report", target: null },
			runs,
			options,
		);
		return {
			measured: reported.measured,
			cv: reported.cv,
			status: "informational",
			reason: `informational row, never gates: ${reported.reason}`,
		};
	}
	return evaluateGate(row, runs, options);
}

function evaluateGate(
	row: Pick<
		BudgetRow,
		| "comparator"
		| "target"
		| "kind"
		| "gate"
		| "minTrials"
		| "minRuns"
		| "noiseScale"
	>,
	runs: ReadonlyArray<number | readonly number[]>,
	options: EvaluationOptions,
): Evaluation {
	const gate = row.gate ?? "median";
	const kind = row.kind ?? "structural";
	if (
		row.noiseScale !== undefined &&
		(row.noiseScale !== "budget" || kind !== "timing" || gate !== "median")
	) {
		return {
			measured: null,
			cv: null,
			status: "not-measured",
			reason: "budget noise scale requires a median timing row; never a pass",
		};
	}
	if (runs.length === 0) {
		return {
			measured: null,
			cv: null,
			status: "not-measured",
			reason: "no measurement in this run",
		};
	}
	if (gate === "pooled-p95") {
		const pooled = runs.flatMap((run) =>
			typeof run === "number" ? [run] : [...run],
		);
		const trials = finite(pooled);
		if (trials.length !== pooled.length) {
			return {
				measured: null,
				cv: null,
				status: "fail",
				reason: `${pooled.length - trials.length} trial(s) did not complete`,
			};
		}
		const measured = nearestRank(trials, 95);
		const minimum = row.minTrials ?? 20;
		const spread = cv(trials);
		if (row.comparator === "report") {
			return informational(measured, spread, "reported, no target");
		}
		if (options.profile === "smoke" || trials.length < minimum) {
			return informational(
				measured,
				spread,
				options.profile === "smoke"
					? "smoke profile: timing values never gate"
					: `only ${trials.length} trial(s); ${minimum} needed`,
			);
		}
		return {
			measured,
			cv: finiteOrNull(spread),
			status: compare(measured, row.comparator, row.target) ? "pass" : "fail",
			reason: `p95 of ${trials.length} pooled trials`,
		};
	}
	const values = runs.map((run) =>
		typeof run === "number" ? run : median(run),
	);
	const valid = finite(values);
	if (valid.length !== values.length) {
		return {
			measured: null,
			cv: null,
			status: "fail",
			reason: `${values.length - valid.length} run(s) produced no value`,
		};
	}
	const spread = cv(valid);
	if (gate === "all") {
		const failures = valid.filter(
			(value) => !compare(value, row.comparator, row.target),
		);
		const worst =
			row.comparator === ">="
				? Math.min(...valid)
				: row.comparator === "=="
					? (failures[0] ?? valid[0] ?? Number.NaN)
					: Math.max(...valid);
		if (row.comparator === "report") {
			return informational(worst, spread, "reported, no target");
		}
		return {
			measured: worst,
			cv: finiteOrNull(spread),
			status: failures.length === 0 ? "pass" : "fail",
			reason:
				failures.length === 0
					? `all ${valid.length} run(s) satisfy ${row.comparator} ${row.target}`
					: `${failures.length} of ${valid.length} run(s) violate ${row.comparator} ${row.target}`,
		};
	}
	const measured = median(valid);
	if (row.comparator === "report") {
		return informational(measured, spread, "reported, no target");
	}
	const timed = kind === "timing" || kind === "heap";
	if (timed && options.profile === "smoke") {
		return informational(
			measured,
			spread,
			"smoke profile: timing and heap values never gate",
		);
	}
	const required = requiredRuns(row, options);
	if (timed && valid.length < required) {
		return informational(
			measured,
			spread,
			`only ${valid.length} run(s); ${required} needed before gating`,
		);
	}
	const tolerance = `${(options.maxCv * 100).toFixed(0)} %`;
	let quality = "";
	if (kind === "heap" || row.noiseScale === "budget") {
		// Signed heap differences and explicitly reviewed clock-scale timings
		// use absolute budget-relative spread. Keep raw CV for information.
		const dispersion = budgetDispersion(valid, row.target);
		if (!Number.isFinite(dispersion)) {
			return {
				measured,
				cv: finiteOrNull(spread),
				status: "not-measured",
				reason: `budget-relative dispersion undefined (target ${row.target}, ${valid.length} run(s)): a gated ${kind} row needs a positive finite target and ≥ 2 runs; never a pass`,
			};
		}
		const percent = `${(dispersion * 100).toFixed(1)} %`;
		if (dispersion > options.maxCv) {
			return {
				measured,
				cv: finiteOrNull(spread),
				status: "noisy",
				reason: `budget-relative dispersion ${percent} (SD ÷ target) > ${tolerance}: rerun`,
			};
		}
		quality = `; budget-relative dispersion ${percent} (SD ÷ target) ≤ ${tolerance}`;
	} else if (timed) {
		if (!Number.isFinite(spread)) {
			return {
				measured,
				cv: null,
				status: "not-measured",
				reason:
					"timing CV is undefined; measurement quality cannot be established; never a pass",
			};
		}
		if (spread > options.maxCv) {
			return {
				measured,
				cv: spread,
				status: "noisy",
				reason: `CV ${(spread * 100).toFixed(1)} % > ${tolerance}: rerun`,
			};
		}
	}
	return {
		measured,
		cv: finiteOrNull(spread),
		status: compare(measured, row.comparator, row.target) ? "pass" : "fail",
		reason: `median of ${valid.length} run(s)${quality}`,
	};
}

function informational(
	measured: number,
	spread: number,
	reason: string,
): Evaluation {
	return {
		measured: Number.isFinite(measured) ? measured : null,
		cv: finiteOrNull(spread),
		status: "informational",
		reason,
	};
}

function finiteOrNull(value: number): number | null {
	return Number.isFinite(value) ? value : null;
}

/**
 * Metric ids derived from periodic `stats()` snapshots carry a `sampled`
 * segment (for example `headroom.sampled.ws.n5.pendingMessages`). A snapshot
 * maximum is only a lower bound on peak usage, so it is never gate evidence.
 */
export function isSampledMetric(id: string): boolean {
	return id.split(".").includes("sampled");
}

/** A row that can pass or fail: not informational and not a report. */
export function isGateRow(
	row: Pick<BudgetRow, "role" | "comparator" | "target">,
): boolean {
	return (
		row.role !== "informational" &&
		row.comparator !== "report" &&
		row.target !== null
	);
}

/** Gate rows whose id, inputs or evidence refer to sampled data (must be none). */
export function sampledGateRows<
	Row extends Pick<
		BudgetRow,
		"id" | "role" | "comparator" | "target" | "evidence" | "derive" | "match"
	>,
>(rows: readonly Row[]): Row[] {
	return rows.filter(
		(row) =>
			isGateRow(row) &&
			(isSampledMetric(row.id) ||
				/\bsampled\b/i.test(row.evidence) ||
				/sampled/i.test(row.match?.pattern ?? "") ||
				(row.derive !== undefined &&
					(isSampledMetric(row.derive.a) || isSampledMetric(row.derive.b)))),
	);
}

export type RunValue = number | number[];
/** metric id → run key → value. */
export type MetricTable = Map<string, Map<string, RunValue>>;

/**
 * Per-run values for one row: its own id, a `derive` of two metrics or a
 * `match` reduction. Gate rows never read sampled metrics, even when a
 * pattern would match them, so sampled data cannot produce a gate verdict.
 */
export function collectRuns(
	table: MetricTable,
	row: Pick<
		BudgetRow,
		"id" | "role" | "comparator" | "target" | "derive" | "match"
	>,
): RunValue[] {
	const gating = isGateRow(row);
	const usable = (id: string) => !(gating && isSampledMetric(id));
	if (row.derive) {
		const { op, a, b } = row.derive;
		if (!usable(a) || !usable(b)) return [];
		const result: RunValue[] = [];
		for (const [run, left] of table.get(a) ?? []) {
			const right = table.get(b)?.get(run);
			if (typeof left !== "number" || typeof right !== "number") continue;
			result.push(op === "sub" ? left - right : left / right);
		}
		return result;
	}
	if (row.match) {
		const pattern = new RegExp(row.match.pattern);
		const reduce = row.match.reduce === "min" ? Math.min : Math.max;
		const result = new Map<string, number>();
		for (const [id, runs] of table) {
			if (!pattern.test(id) || !usable(id)) continue;
			for (const [run, value] of runs) {
				if (typeof value !== "number") continue;
				const previous = result.get(run);
				result.set(
					run,
					previous === undefined ? value : reduce(previous, value),
				);
			}
		}
		return [...result.values()];
	}
	if (!usable(row.id)) return [];
	return [...(table.get(row.id)?.values() ?? [])];
}

/** Metric ids a row reads (for not-measured reasons). */
export function rowMatches(
	row: Pick<BudgetRow, "id" | "derive" | "match">,
	id: string,
): boolean {
	if (row.derive) return id === row.derive.a || id === row.derive.b;
	if (row.match) return new RegExp(row.match.pattern).test(id);
	return id === row.id;
}
