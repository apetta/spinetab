import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
	combineEvaluation,
	type Diagnostic,
	describeReasons,
	identitySummary,
	partitionRecords,
	repEligibility,
	SMOKE_PINNED_NOT_APPLICABLE,
	smokeOnly,
} from "./lib/eligibility.ts";
import {
	evidenceDir,
	packageRoot,
	type RawRecord,
	readJson,
	repoRoot,
	writeJson,
} from "./lib/evidence.ts";
import { deriveControlFlow } from "./lib/record.ts";
import {
	type BudgetRow,
	collectRuns,
	DEFAULT_EVALUATION,
	type Evaluation,
	evaluateRow,
	isGateRow,
	type MetricTable,
	type RunValue,
	rowMatches,
	summarise,
} from "./lib/stats.ts";

/**
 * Aggregate one evidence run:
 *
 * node tests/performance/aggregate.ts --run <RUN> [--dry-run] [--out <DIR>]
 *
 * Reads docs/evidence/perf/<run>/raw/*.json (+ sizes.json, environment.json),
 * evaluates every budget row (median of per-run values for timing/heap,
 * every run for structural facts, pooled p95 for trial rows), writes
 * summary.json and summary.md beside the raw files. Budget definitions are
 * never rewritten. Gating rows use the `chromium-perf` project;
 * Firefox/WebKit values are reported as functional evidence only.
 * Rows with `role: "informational"` (for example sampled high-water marks)
 * are reported and never pass or fail; gate rows never read sampled metrics.
 *
 * Pinned eligibility: only repetitions whose
 * environment.json records a passed, not ignored load gate and the candidate
 * identity (tarball sha256; package and harness dist hashes unchanged at the
 * repetition's start) count towards `env.pinned-runs`, `env.manifest`
 * and every timing, heap, trial and structural verdict. Other records are
 * kept as informational diagnostics with the reason; a structural failure in
 * them still fails its row. In a smoke-only run `env.pinned-runs` is
 * informational (not applicable); a mixed run keeps the strict count (review
 * point 32). The summary reports the identity and each repetition's check.
 *
 * A heap row with a per-row `minRuns` gates on that many eligible
 * runs (floor 3); other timing and heap rows need the default ten.
 *
 * Control flow: a tab record written before the control
 * rows existed gets them re-derived from its retained `detail.hwm`
 * (`deriveControlFlow`); the summary lists every derived id.
 *
 * `--out <DIR>` writes summary.{json,md} to DIR instead of the run directory
 * (an existing summary there is never overwritten), so an earlier summary of
 * the same raw records is kept.
 */

interface BudgetFile {
	schema: 1;
	package: string;
	rows: BudgetRow[];
}

export interface SizesFile {
	metrics?: Record<string, number>;
	notMeasured?: Record<string, string>;
}

export const GATING_PROJECT = "chromium-perf";
const budgetsPath = join(packageRoot, "tests/performance/budgets.json");

function toValue(value: unknown): RunValue {
	if (Array.isArray(value)) {
		return value.map((entry) =>
			typeof entry === "number" ? entry : Number.NaN,
		);
	}
	return typeof value === "number" ? value : Number.NaN;
}

function loadRaw(dir: string): RawRecord[] {
	if (!existsSync(dir)) return [];
	const records: RawRecord[] = [];
	for (const file of readdirSync(dir).sort()) {
		if (!file.endsWith(".json")) continue;
		const record = readJson<RawRecord>(join(dir, file));
		if (record?.schema === 1 && record.metrics && record.project) {
			records.push(record);
		}
	}
	return records.sort((a, b) => a.writtenAt.localeCompare(b.writtenAt));
}

function tables(records: RawRecord[]) {
	const byProject = new Map<string, MetricTable>();
	const reasons = new Map<string, string>();
	for (const record of records) {
		let table = byProject.get(record.project);
		if (!table) {
			table = new Map();
			byProject.set(record.project, table);
		}
		for (const [id, value] of Object.entries(record.metrics)) {
			let runs = table.get(id);
			if (!runs) {
				runs = new Map();
				table.set(id, runs);
			}
			// Each repetition (and each --repeat-each copy) is one run.
			runs.set(`${record.rep}.${record.repeat ?? 0}`, toValue(value));
		}
		if (record.project === GATING_PROJECT) {
			for (const [id, reason] of Object.entries(record.notMeasured ?? {})) {
				reasons.set(id, reason);
			}
		}
	}
	return { byProject, reasons };
}

function format(value: number | null, unit: string): string {
	if (value === null || !Number.isFinite(value)) return "—";
	if (unit === "B" && Math.abs(value) >= 1024) {
		return `${(value / 1024).toFixed(1)} KiB`;
	}
	return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

/** Tab-scaling records define a pinned repetition (attribution excluded). */
const isRepetitionRecord = (record: RawRecord) =>
	record.project === GATING_PROJECT &&
	record.profile === "pinned" &&
	record.scenario === "tabs" &&
	!record.config.endsWith("-attribution");

export interface RowResult {
	row: BudgetRow;
	evaluation: Evaluation;
	/** What ineligible (diagnostic) runs alone would give; never acceptance. */
	ineligible?: Diagnostic;
}

export interface RunInput {
	records: RawRecord[];
	environment: Record<string, unknown> | undefined;
	sizes?: SizesFile | undefined;
	rows: BudgetRow[];
}

/**
 * Evaluate every budget row for one run (pure: no I/O). In the pinned profile
 * only eligible records reach a verdict; the smoke profile never gates timing
 * or heap and keeps its structural checks over every record.
 */
export function evaluateRun({
	records: input,
	environment,
	sizes,
	rows,
}: RunInput) {
	const derivedIds: Record<string, string[]> = {};
	const records = input.map((raw) => {
		const { record, derived } = deriveControlFlow(raw);
		if (derived.length > 0) {
			derivedIds[`${raw.scenario}-${raw.config}-${raw.project}-rep${raw.rep}`] =
				derived;
		}
		return record;
	});
	const profile = records.some(
		(record) => record.project === GATING_PROJECT && record.profile === "smoke",
	)
		? "smoke"
		: "pinned";
	const partition =
		profile === "pinned"
			? partitionRecords(records, environment)
			: { eligible: records, ineligible: [] };
	const eligibleTables = tables(partition.eligible);
	const diagnosticTables = tables(
		partition.ineligible.map(({ record }) => record),
	);
	const { reasons } = eligibleTables;
	const gating = eligibleTables.byProject.get(GATING_PROJECT) ?? new Map();
	const diagnostic =
		diagnosticTables.byProject.get(GATING_PROJECT) ?? new Map();
	const why = describeReasons(
		partition.ineligible
			.filter(({ record }) => record.project === GATING_PROJECT)
			.map(({ reason }) => reason),
	);

	// Pinned repetitions: every rep with a tab-scaling record, then only
	// those whose load gate makes them eligible (fail closed).
	const allReps = [
		...new Set(records.filter(isRepetitionRecord).map((r) => r.rep)),
	].sort();
	const repVerdicts = new Map(
		allReps.map((rep) => [rep, repEligibility(environment, rep)]),
	);
	const pinnedReps = allReps.filter((rep) => repVerdicts.get(rep)?.eligible);
	const ineligibleReps: Array<{ rep: string; reason: string }> = [];
	for (const [rep, verdict] of repVerdicts) {
		if (!verdict.eligible) ineligibleReps.push({ rep, reason: verdict.reason });
	}
	const repNote = `${pinnedReps.length} of ${allReps.length} pinned rep(s) eligible${
		ineligibleReps.length > 0
			? ` (${describeReasons(ineligibleReps.map(({ reason }) => reason))})`
			: ""
	}`;
	const options = { ...DEFAULT_EVALUATION, profile } as const;
	const pinnedRunsApplicable = !smokeOnly(records, environment, GATING_PROJECT);

	const evaluated: RowResult[] = [];
	for (const row of rows) {
		let runs: RunValue[] = [];
		let diagnosticRuns: RunValue[] = [];
		if (row.id === "env.manifest") {
			// Pinned: the manifest must certify ≥ minRuns eligible repetitions.
			runs = [
				environment &&
				(profile === "smoke" || pinnedReps.length >= options.minRuns)
					? 1
					: 0,
			];
		} else if (row.id === "env.pinned-runs") runs = [pinnedReps.length];
		else if (row.id.startsWith("size.")) {
			const value = sizes?.metrics?.[row.id];
			runs = value === undefined ? [] : [value];
		} else {
			runs = collectRuns(gating, row);
			diagnosticRuns = collectRuns(diagnostic, row);
		}
		let evaluation = evaluateRow(row, runs, options);
		if (evaluation.status === "not-measured") {
			const reason =
				reasons.get(row.id) ??
				[...reasons].find(([id]) => rowMatches(row, id))?.[1] ??
				(row.id.startsWith("size.")
					? sizes?.notMeasured?.[row.id]
					: undefined) ??
				(row.owner !== "performance" ? row.reason : undefined) ??
				row.reason;
			evaluation = { ...evaluation, reason: reason || evaluation.reason };
		} else if (evaluation.status === "pass" && row.match) {
			// A minimum over configs passes only when every config was measured.
			const missing = [...reasons].find(([id]) => rowMatches(row, id));
			if (missing) {
				evaluation = {
					...evaluation,
					status: "not-measured",
					reason: `${missing[0]} not measured: ${missing[1]}`,
				};
			}
		}
		if (row.id === "env.manifest" && profile === "pinned") {
			evaluation = {
				...evaluation,
				reason: environment
					? `${evaluation.reason}; ${repNote}; ${options.minRuns} needed`
					: `no environment manifest; ${repNote}`,
			};
		} else if (row.id === "env.pinned-runs") {
			evaluation = pinnedRunsApplicable
				? { ...evaluation, reason: `${evaluation.reason}; ${repNote}` }
				: {
						...evaluation,
						status: "informational",
						reason: `${SMOKE_PINNED_NOT_APPLICABLE}; ${repNote}`,
					};
		}
		if (
			row.id.endsWith("spinetab-vs-independent") &&
			evaluation.measured !== null &&
			row.derive
		) {
			const spinetab = [...(gating.get(row.derive.a)?.values() ?? [])];
			const independent = [...(gating.get(row.derive.b)?.values() ?? [])];
			const diff =
				summarise(spinetab as number[]).median -
				summarise(independent as number[]).median;
			if (evaluation.measured > 1.1 && diff > 1) {
				evaluation = {
					...evaluation,
					reason: `investigate: Spinetab CPU ${(evaluation.measured * 100 - 100).toFixed(0)} % and ${diff.toFixed(2)} ms/s above independent`,
				};
			}
		}
		let ineligible: Diagnostic | undefined;
		if (diagnosticRuns.length > 0) {
			ineligible = {
				...evaluateRow(row, diagnosticRuns, options),
				runs: diagnosticRuns.length,
				why,
			};
			evaluation = combineEvaluation(row, evaluation, ineligible);
		}
		evaluated.push(
			ineligible ? { row, evaluation, ineligible } : { row, evaluation },
		);
	}

	// Functional engines: same comparators, informational only.
	const { byProject } = tables(records);
	const functional: Record<string, Array<Record<string, unknown>>> = {};
	for (const [project, table] of byProject) {
		if (project === GATING_PROJECT) continue;
		functional[project] = [];
		for (const row of rows) {
			if (!isGateRow(row) || row.derive || row.match) continue;
			const runs = collectRuns(table, row);
			if (runs.length === 0) continue;
			const evaluation = evaluateRow({ ...row, kind: "structural" }, runs, {
				...DEFAULT_EVALUATION,
				profile,
			});
			functional[project]?.push({
				id: row.id,
				measured: evaluation.measured,
				wouldPass: evaluation.status === "pass",
			});
		}
	}

	// Metrics without a budget row: reported, never gated. Diagnostic
	// (ineligible) values are summarised apart so they never move a median.
	const budgeted = new Set(rows.map((row) => row.id));
	const report = (table: MetricTable) => {
		const out: Record<string, ReturnType<typeof summarise>> = {};
		for (const [id, runs] of table) {
			if (budgeted.has(id)) continue;
			const flat = [...runs.values()].flatMap((value) =>
				typeof value === "number" ? [value] : value,
			);
			out[id] = summarise(flat);
		}
		return out;
	};
	const reported = report(gating);
	const reportedIneligible = report(diagnostic);

	const counts: Record<string, number> = {};
	for (const { evaluation } of evaluated) {
		counts[evaluation.status] = (counts[evaluation.status] ?? 0) + 1;
	}
	const reasonCounts: Record<string, number> = {};
	for (const { reason } of partition.ineligible) {
		reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
	}
	return {
		profile,
		evaluated,
		functional,
		reported,
		reportedIneligible,
		counts,
		pinnedReps,
		identity: identitySummary(environment),
		derived: {
			rule: "control outbox headroom and posted occupancy re-derived from a record's retained runtime detail.hwm when the record predates those metrics; drain rows are then not measured",
			records: derivedIds,
		},
		eligibility: {
			applied: profile === "pinned",
			pinnedRunsApplicable,
			rule: "pinned acceptance requires profile pinned, a passed and not ignored host gate under its recorded policy (load-v1: load below 2; observed-host-v1: macOS on AC, Low Power Mode off, nominal thermal state and a valid CPU activity sample), recorded tarball/package/harness sha256 identities and matching identityCheck[rep]; anything else is informational",
			reps: {
				total: allReps,
				eligible: pinnedReps,
				ineligible: ineligibleReps,
			},
			records: {
				total: records.length,
				eligible: partition.eligible.length,
				ineligible: partition.ineligible.length,
			},
			reasons: reasonCounts,
		},
	};
}

function main(): void {
	const { values } = parseArgs({
		options: {
			run: { type: "string" },
			// Retained for existing commands; budget definitions are always read-only.
			"dry-run": { type: "boolean", default: false },
			out: { type: "string" },
		},
	});
	const run = values.run;
	if (!run)
		throw new Error(
			"usage: node tests/performance/aggregate.ts --run <RUN> [--dry-run] [--out <DIR>]",
		);
	const dir = evidenceDir(run);
	if (!existsSync(dir)) {
		throw new Error(
			`No evidence run at ${dir}; run the performance suite first.`,
		);
	}
	const outDir = values.out
		? isAbsolute(values.out)
			? values.out
			: resolve(repoRoot, values.out)
		: dir;
	if (values.out) {
		if (existsSync(join(outDir, "summary.json"))) {
			throw new Error(
				`${join(outDir, "summary.json")} exists; --out never overwrites a summary.`,
			);
		}
		mkdirSync(outDir, { recursive: true });
	}
	const records = loadRaw(join(dir, "raw"));
	const environmentPath = join(dir, "environment.json");
	const environment = readJson<Record<string, unknown>>(environmentPath);
	const sizes = readJson<SizesFile>(join(dir, "sizes.json"));
	const budgets = readJson<BudgetFile>(budgetsPath);
	if (!budgets) throw new Error(`Missing ${budgetsPath}`);
	const {
		profile,
		evaluated,
		functional,
		reported,
		reportedIneligible,
		counts,
		pinnedReps,
		identity,
		derived,
		eligibility,
	} = evaluateRun({ records, environment, sizes, rows: budgets.rows });

	const git = environment?.git as { sha?: string | null } | undefined;
	const summary = {
		schema: 1,
		run,
		profile,
		createdAt: new Date().toISOString(),
		commit: git?.sha ?? null,
		source: relative(repoRoot, dir),
		environment: existsSync(environmentPath)
			? relative(repoRoot, environmentPath)
			: null,
		records: records.length,
		pinnedReps,
		identity,
		eligibility,
		derived,
		counts,
		rows: evaluated.map(({ row, evaluation, ineligible }) => ({
			id: row.id,
			behaviour: row.behaviour,
			owner: row.owner,
			unit: row.unit,
			comparator: row.comparator,
			target: row.target,
			...(row.minRuns !== undefined ? { minRuns: row.minRuns } : {}),
			...evaluation,
			evidence: row.evidence,
			...(ineligible ? { ineligible } : {}),
		})),
		functional,
		reported,
		reportedIneligible,
	};
	writeJson(join(outDir, "summary.json"), summary);

	const lines: string[] = [
		`# Performance summary ${run}`,
		"",
		`Profile: ${profile}. Raw records: ${records.length} (${eligibility.records.eligible} eligible, ${eligibility.records.ineligible} ineligible). Eligible pinned reps: ${pinnedReps.length} of ${eligibility.reps.total.length}.`,
		...(eligibility.applied
			? []
			: [
					"Smoke profile: the pinned load gate is not applied; timing and heap values never gate.",
				]),
		...(eligibility.pinnedRunsApplicable
			? []
			: [
					`\`env.pinned-runs\` is informational: ${SMOKE_PINNED_NOT_APPLICABLE}.`,
				]),
		...(Object.keys(derived.records).length > 0
			? [
					`Control flow rows re-derived from retained \`detail.hwm\` for ${Object.keys(derived.records).length} record(s) without explicit control metrics (listed in summary.json \`derived\`).`,
				]
			: []),
		...Object.entries(eligibility.reasons).map(
			([reason, count]) => `Informational only, ${count} record(s): ${reason}.`,
		),
		`Raw records: \`${summary.source}\`. Environment manifest: \`${summary.environment ?? "missing"}\` (git ${git?.sha ?? "unknown"}).`,
		`Candidate: tarball sha256 ${identity.tarball.sha256 ?? "not recorded"}; package dist ${identity.packageDist ?? "not recorded"}; harness dist ${identity.harnessDist ?? "not recorded"}${
			Object.keys(identity.reps).length > 0
				? `; repetitions checked ${Object.keys(identity.reps).length}, dist changed in ${
						Object.entries(identity.reps)
							.filter(([, check]) => !check.matches)
							.map(([rep]) => rep)
							.join(", ") || "none"
					}`
				: "; no repetition checked"
		} (tree hashes: ${identity.method ?? "no method recorded"}).`,
		`Status counts: ${Object.entries(counts)
			.map(([status, count]) => `${status} ${count}`)
			.join(", ")}.`,
		"",
		"Targets are provisional; a failed row is kept, never re-targeted silently.",
		"Timing and heap rows gate only in the pinned profile with ≥ 10 runs and CV ≤ 10 %; a heap row with its own minRuns gates on that many runs (floor 3).",
		"Only repetitions with a passed, not ignored load gate and a matching candidate identity in environment.json count; other runs are informational.",
		"",
	];
	const behaviours = [
		...new Set(evaluated.map(({ row }) => row.behaviour)),
	].sort();
	for (const behaviour of behaviours) {
		lines.push(`## ${behaviour}`, "");
		lines.push("| Row | Measured | Target | Status | CV | Reason | Evidence |");
		lines.push("| --- | --- | --- | --- | --- | --- | --- |");
		for (const { row, evaluation } of evaluated) {
			if (row.behaviour !== behaviour) continue;
			const target =
				row.comparator === "report" || row.target === null
					? "report"
					: `${row.comparator} ${format(row.target, row.unit)}`;
			const cvText =
				evaluation.cv === null ? "—" : `${(evaluation.cv * 100).toFixed(1)} %`;
			lines.push(
				`| \`${row.id}\` | ${format(evaluation.measured, row.unit)} ${row.unit} | ${target} | ${evaluation.status} | ${cvText} | ${evaluation.reason.replaceAll("|", "\\|")} | ${row.evidence.replaceAll("|", "\\|")} |`,
			);
		}
		lines.push("");
	}
	for (const [project, rows] of Object.entries(functional)) {
		lines.push(`## Functional evidence: ${project} (informational)`, "");
		lines.push("| Row | Measured | Would pass |", "| --- | --- | --- |");
		for (const entry of rows) {
			lines.push(
				`| \`${entry.id}\` | ${format(entry.measured as number | null, "")} | ${entry.wouldPass ? "yes" : "no"} |`,
			);
		}
		lines.push("");
	}
	lines.push("## Reported metrics without a budget row", "");
	lines.push(
		"| Metric | n | Median | p95 | CV |",
		"| --- | --- | --- | --- | --- |",
	);
	for (const [id, stats] of Object.entries(reported).sort()) {
		lines.push(
			`| \`${id}\` | ${stats.n} | ${format(stats.median, "")} | ${format(stats.p95, "")} | ${Number.isFinite(stats.cv) ? `${(stats.cv * 100).toFixed(1)} %` : "—"} |`,
		);
	}
	lines.push("");
	const ineligibleIds = Object.keys(reportedIneligible).sort();
	if (ineligibleIds.length > 0) {
		lines.push(
			"## Ineligible metrics without a budget row (informational)",
			"",
		);
		lines.push(
			"| Metric | n | Median | p95 | CV |",
			"| --- | --- | --- | --- | --- |",
		);
		for (const id of ineligibleIds) {
			const stats = reportedIneligible[id] as ReturnType<typeof summarise>;
			lines.push(
				`| \`${id}\` | ${stats.n} | ${format(stats.median, "")} | ${format(stats.p95, "")} | ${Number.isFinite(stats.cv) ? `${(stats.cv * 100).toFixed(1)} %` : "—"} |`,
			);
		}
		lines.push("");
	}
	writeFileSync(join(outDir, "summary.md"), `${lines.join("\n")}\n`);

	const failing = evaluated.filter(
		({ evaluation }) => evaluation.status === "fail",
	);
	console.log(
		`Aggregated ${records.length} raw record(s) into ${relative(repoRoot, outDir)}/summary.{json,md}: ${Object.entries(
			counts,
		)
			.map(([status, count]) => `${status} ${count}`)
			.join(", ")}`,
	);
	if (failing.length > 0) {
		console.log(`Failing rows: ${failing.map(({ row }) => row.id).join(", ")}`);
		process.exitCode = 1;
	}
}

if (import.meta.main) main();
