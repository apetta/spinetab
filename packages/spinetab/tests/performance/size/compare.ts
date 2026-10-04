import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { packageRoot, repoRoot } from "../lib/evidence.ts";
import { type BudgetRow, evaluateRow } from "../lib/stats.ts";
import { isNotSelected } from "./guard.ts";

/**
 * Compare a size run with an earlier one:
 *
 * node tests/performance/size/compare.ts --new <sizes.json>
 * [--old <sizes.json>] [--out <file>]
 *
 * Lists every metric of either run and every `size.*` budget row, including
 * the absent, attribution-agreement and fallback rows, with the old and new
 * value, the delta and the budget verdict of the new value; the failing rows
 * first; the rows not selected (`--only`, `--bundlers`); the rows not
 * measured with their reasons; the budget rows neither run accounts for
 * (older reports omitted unselected scenarios); the
 * minified realm gzip per scenario and bundler; and, for the plugin
 * scenarios, each realm against its L1 counterpart with the plugin
 * bundlers the harness does not build. Pure apart from the CLI.
 * `--out` never overwrites a file.
 *
 * The report says whether the new run is complete: nothing not selected or
 * not measured, no budget row missing, every scenario with a minified
 * result. The CLI exits 1 when it is not, as measure.ts does; budget
 * verdicts never change the exit status (the aggregate gates them).
 */

interface RealmGzip {
	gzip?: number;
}

interface SideTotals {
	gzip: number;
	spinetabGzip: number;
	generatedGzip: number;
}

interface ScenarioReport {
	status?: string;
	error?: string;
	minified?: { realms?: Record<string, RealmGzip> };
	/** Plugin scenarios (summary.ts `pluginComparison`). */
	sideBySide?: {
		realms: Record<
			string,
			{ l3: SideTotals; l1: SideTotals | null; delta: SideTotals | null }
		>;
	};
}

/** The fields of a sizes.json this compare reads. */
export interface SizesReport {
	run?: string;
	tarball?: { sha256?: string };
	metrics?: Record<string, number>;
	notMeasured?: Record<string, string>;
	scenarios?: Record<string, Partial<Record<string, ScenarioReport>>>;
	pluginBundlersNotMeasured?: Readonly<Record<string, string>>;
}

export type CompareStatus =
	| "pass"
	| "fail"
	| "noisy"
	| "informational"
	| "not measured"
	| "not selected"
	| "no budget row";

export interface CompareRow {
	id: string;
	previous: number | null;
	current: number | null;
	delta: number | null;
	comparator: BudgetRow["comparator"] | null;
	target: number | null;
	status: CompareStatus;
	reason: string;
}

export interface RealmRow {
	scenario: string;
	bundler: string;
	realm: string;
	previous: number | null;
	current: number | null;
}

/** One realm of a plugin scenario against its L1 counterpart (gzip bytes). */
export interface PluginRealmRow {
	scenario: string;
	bundler: string;
	realm: string;
	l1Gzip: number | null;
	l3Gzip: number;
	delta: number | null;
	l1Spinetab: number | null;
	l3Spinetab: number;
	generatedGzip: number;
}

export interface SizeComparison {
	current: { run: string | null; tarball: string | null };
	previous: { run: string | null; tarball: string | null } | null;
	rows: CompareRow[];
	failing: string[];
	notSelected: string[];
	notMeasured: Array<{ id: string; reason: string }>;
	/** Budget rows the new report neither measured nor recorded. */
	unaccounted: string[];
	realms: RealmRow[];
	scenariosNotMeasured: Array<{
		scenario: string;
		bundler: string;
		reason: string;
	}>;
	plugin: PluginRealmRow[];
	pluginBundlersNotMeasured: Array<{ bundler: string; reason: string }>;
	/** No row not selected, not measured or unaccounted, and no scenario without a result. */
	complete: boolean;
}

const value = (report: SizesReport | undefined, id: string) => {
	const found = report?.metrics?.[id];
	return typeof found === "number" && Number.isFinite(found) ? found : null;
};

export function compareSizes(
	current: SizesReport,
	rows: readonly BudgetRow[],
	previous?: SizesReport,
): SizeComparison {
	const budget = new Map(
		rows
			.filter((row) => row.id.startsWith("size."))
			.map((row) => [row.id, row]),
	);
	const ids = [
		...new Set([
			...budget.keys(),
			...Object.keys(current.metrics ?? {}),
			...Object.keys(current.notMeasured ?? {}),
			...Object.keys(previous?.metrics ?? {}),
		]),
	].sort();
	const compared: CompareRow[] = [];
	const notSelected: string[] = [];
	const notMeasured: Array<{ id: string; reason: string }> = [];
	const unaccounted: string[] = [];
	for (const id of ids) {
		const row = budget.get(id);
		const before = value(previous, id);
		const after = value(current, id);
		const recorded = current.notMeasured?.[id];
		let status: CompareStatus;
		let reason = "";
		if (after !== null) {
			if (row) {
				const evaluation = evaluateRow(row, [after]);
				status =
					evaluation.status === "not-measured"
						? "not measured"
						: evaluation.status;
				reason = evaluation.reason;
			} else {
				status = "no budget row";
			}
		} else if (recorded !== undefined) {
			reason = recorded;
			if (isNotSelected(recorded)) {
				status = "not selected";
				notSelected.push(id);
			} else {
				status = "not measured";
				notMeasured.push({ id, reason });
			}
		} else {
			status = "not measured";
			reason = "neither measured nor recorded in the new report";
			if (row) unaccounted.push(id);
		}
		compared.push({
			id,
			previous: before,
			current: after,
			delta: before !== null && after !== null ? after - before : null,
			comparator: row?.comparator ?? null,
			target: row?.target ?? null,
			status,
			reason,
		});
	}

	const realms: RealmRow[] = [];
	const plugin: PluginRealmRow[] = [];
	const scenariosNotMeasured: SizeComparison["scenariosNotMeasured"] = [];
	for (const scenario of Object.keys(current.scenarios ?? {}).sort()) {
		const byBundler = current.scenarios?.[scenario] ?? {};
		for (const bundler of Object.keys(byBundler).sort()) {
			const report = byBundler[bundler];
			for (const [realm, side] of Object.entries(
				report?.sideBySide?.realms ?? {},
			)) {
				plugin.push({
					scenario,
					bundler,
					realm,
					l1Gzip: side.l1?.gzip ?? null,
					l3Gzip: side.l3.gzip,
					delta: side.delta?.gzip ?? null,
					l1Spinetab: side.l1?.spinetabGzip ?? null,
					l3Spinetab: side.l3.spinetabGzip,
					generatedGzip: side.l3.generatedGzip,
				});
			}
			const after = report?.minified?.realms;
			if (!after) {
				scenariosNotMeasured.push({
					scenario,
					bundler,
					reason: report?.error ?? report?.status ?? "no minified result",
				});
				continue;
			}
			const before =
				previous?.scenarios?.[scenario]?.[bundler]?.minified?.realms;
			for (const realm of Object.keys(after).sort()) {
				realms.push({
					scenario,
					bundler,
					realm,
					previous: before?.[realm]?.gzip ?? null,
					current: after[realm]?.gzip ?? null,
				});
			}
		}
	}
	const identify = (report: SizesReport) => ({
		run: report.run ?? null,
		tarball: report.tarball?.sha256 ?? null,
	});
	return {
		current: identify(current),
		previous: previous ? identify(previous) : null,
		rows: compared,
		failing: compared
			.filter((row) => row.status === "fail")
			.map((row) => row.id),
		notSelected,
		notMeasured,
		unaccounted,
		realms,
		scenariosNotMeasured,
		plugin,
		pluginBundlersNotMeasured: Object.entries(
			current.pluginBundlersNotMeasured ?? {},
		).map(([bundler, reason]) => ({ bundler, reason })),
		complete:
			notSelected.length === 0 &&
			notMeasured.length === 0 &&
			unaccounted.length === 0 &&
			scenariosNotMeasured.length === 0,
	};
}

const show = (number: number | null) =>
	number === null
		? "—"
		: Number.isInteger(number)
			? String(number)
			: number.toFixed(4);
const signed = (number: number | null) =>
	number === null ? "—" : `${number > 0 ? "+" : ""}${show(number)}`;
const pad = (text: string, width: number) => text.padEnd(width);

export function formatComparison(comparison: SizeComparison): string {
	const label = (side: { run: string | null; tarball: string | null }) =>
		`${side.run ?? "unnamed"} (tarball ${side.tarball?.slice(0, 12) ?? "unknown"})`;
	const lines = [
		`Size compare: new run ${label(comparison.current)}${
			comparison.previous
				? `; old run ${label(comparison.previous)}`
				: "; no old run"
		}.`,
		comparison.complete
			? "Complete run: yes."
			: `Complete run: no (${comparison.notSelected.length} not selected, ${comparison.notMeasured.length} not measured, ${comparison.unaccounted.length} budget rows neither measured nor recorded, ${comparison.scenariosNotMeasured.length} scenarios without a minified result); the compare exits 1.`,
		`Failing rows (${comparison.failing.length}): ${comparison.failing.join(", ") || "none"}.`,
		"",
		"## Every metric and size budget row",
		"",
		`${pad("row", 52)} ${pad("old", 10)} ${pad("new", 10)} ${pad("delta", 10)} ${pad("budget", 12)} status`,
	];
	const ordered = [
		...comparison.rows.filter((row) => row.status === "fail"),
		...comparison.rows.filter((row) => row.status !== "fail"),
	];
	for (const row of ordered) {
		const budget =
			row.comparator === null
				? "—"
				: row.comparator === "report" || row.target === null
					? "report"
					: `${row.comparator} ${show(row.target)}`;
		lines.push(
			`${pad(row.id, 52)} ${pad(show(row.previous), 10)} ${pad(show(row.current), 10)} ${pad(signed(row.delta), 10)} ${pad(budget, 12)} ${row.status}`,
		);
	}
	const list = (title: string, entries: string[]) => {
		lines.push("", `## ${title} (${entries.length}):`, "");
		for (const entry of entries) lines.push(`- ${entry}`);
		if (entries.length === 0) lines.push("- none");
	};
	list(
		"Not selected",
		comparison.notSelected.map(
			(id) => `${id}: ${comparison.rows.find((row) => row.id === id)?.reason}`,
		),
	);
	list(
		"Not measured",
		comparison.notMeasured.map(({ id, reason }) => `${id}: ${reason}`),
	);
	list("Budget rows neither measured nor recorded", comparison.unaccounted);
	list(
		"Scenarios without a minified result",
		comparison.scenariosNotMeasured.map(
			({ scenario, bundler, reason }) => `${scenario} ${bundler}: ${reason}`,
		),
	);
	lines.push(
		"",
		"## Minified realm gzip (bytes)",
		"",
		`${pad("scenario", 16)} ${pad("bundler", 8)} ${pad("realm", 8)} ${pad("old", 9)} ${pad("new", 9)} delta`,
	);
	for (const realm of comparison.realms) {
		const delta =
			realm.previous !== null && realm.current !== null
				? realm.current - realm.previous
				: null;
		lines.push(
			`${pad(realm.scenario, 16)} ${pad(realm.bundler, 8)} ${pad(realm.realm, 8)} ${pad(show(realm.previous), 9)} ${pad(show(realm.current), 9)} ${signed(delta)}`,
		);
	}
	if (comparison.plugin.length > 0) {
		lines.push(
			"",
			"## Generated path (plugin) against L1 per realm (gzip bytes)",
			"",
			`${pad("scenario", 20)} ${pad("bundler", 8)} ${pad("realm", 8)} ${pad("L1", 8)} ${pad("L3", 8)} ${pad("delta", 8)} ${pad("L1 Spinetab", 12)} ${pad("L3 Spinetab", 12)} generated`,
		);
		for (const row of comparison.plugin) {
			lines.push(
				`${pad(row.scenario, 20)} ${pad(row.bundler, 8)} ${pad(row.realm, 8)} ${pad(show(row.l1Gzip), 8)} ${pad(show(row.l3Gzip), 8)} ${pad(signed(row.delta), 8)} ${pad(show(row.l1Spinetab), 12)} ${pad(show(row.l3Spinetab), 12)} ${show(row.generatedGzip)}`,
			);
		}
	}
	if (comparison.pluginBundlersNotMeasured.length > 0) {
		list(
			"Plugin bundlers not measured",
			comparison.pluginBundlersNotMeasured.map(
				({ bundler, reason }) => `${bundler}: ${reason}`,
			),
		);
	}
	return `${lines.join("\n")}\n`;
}

function main(): void {
	const { values } = parseArgs({
		options: {
			new: { type: "string" },
			old: { type: "string" },
			out: { type: "string" },
		},
	});
	if (!values.new) {
		throw new Error(
			"usage: node tests/performance/size/compare.ts --new <sizes.json> [--old <sizes.json>] [--out <file>]",
		);
	}
	const read = (path: string) =>
		JSON.parse(readFileSync(resolve(path), "utf8")) as SizesReport;
	const budgets = JSON.parse(
		readFileSync(join(packageRoot, "tests/performance/budgets.json"), "utf8"),
	) as { rows: BudgetRow[] };
	const comparison = compareSizes(
		read(values.new),
		budgets.rows,
		values.old ? read(values.old) : undefined,
	);
	const text = formatComparison(comparison);
	if (values.out) {
		const out = isAbsolute(values.out)
			? values.out
			: resolve(repoRoot, values.out);
		if (existsSync(out))
			throw new Error(`${out} exists; --out never overwrites.`);
		writeFileSync(out, text);
	}
	process.stdout.write(text);
	if (!comparison.complete) process.exitCode = 1;
}

if (import.meta.main) main();
