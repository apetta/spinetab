import type { BudgetRow } from "../lib/stats.ts";
import type { PluginScenario, SizeScenario } from "./catalogue.ts";
import { PLUGIN_SCENARIOS, SCENARIOS, unselectedBases } from "./catalogue.ts";
import type { Mode as Build, Bundler } from "./project.ts";
import { destinations } from "./realm.ts";
import type { LoggedRequest } from "./static-server.ts";

/**
 * Fail-closed guards for size scenarios. Pure and Node-runnable so tests/unit/performance/size-guard.test.ts
 * can drive them without builds or a browser.
 *
 * A scenario's sizes are only usable when every load settled in the mode the
 * scenario template signals through `__sizeReady` for that load:
 *
 * - Spinetab scenarios: `sharing=prefer` → "shared", `sharing=off` → "local"
 * (the template publishes `status.mode` once it leaves inactive/starting).
 * - Baselines (`baseline-empty` with its no-op SharedWorker, `baseline-ws`,
 * `baseline-graphql-ws`): "baseline" for both loads (the templates ignore
 * `sharing`; `baseline-empty` signals only after its worker answers).
 *
 * Both the minified and the raw build are checked, the first ready value and
 * the value after the settle window alike. A timeout (no `__sizeReady`) or a
 * wrong mode marks the scenario not measured, keeps the diagnostics and never
 * yields size, absence, incremental or fallback data.
 */

/** Load keyed by the mode it must reach: `shared` is `sharing=prefer`, `local` is `sharing=off`. */
export type Load = "shared" | "local";
export const SHARING: Record<Load, "prefer" | "off"> = {
	shared: "prefer",
	local: "off",
};
export const BUILDS: readonly Build[] = ["min", "raw"];
export const LOADS: readonly Load[] = ["shared", "local"];
export const READY_TIMEOUT_MS = 20_000;
export const SETTLE_MS = 1_500;

export type ExpectedModes = Record<Load, string>;

export interface ModeObservation {
	/** First truthy `__sizeReady` within READY_TIMEOUT_MS; null when it timed out. */
	ready: string | null;
	/** `__sizeReady` after SETTLE_MS (a later fallback or failure shows here). */
	settled: string | null;
	/** Why the ready wait ended without a value (timeout, closed page). */
	readyError?: string;
}

export interface LoadObservation extends ModeObservation {
	requests: LoggedRequest[];
	/** Page console lines and uncaught page errors (capped). */
	console: string[];
}

export type Observed<T extends ModeObservation = ModeObservation> = Record<
	Build,
	Record<Load, T>
>;

export interface ModeMismatch {
	build: Build;
	load: Load;
	sharing: "prefer" | "off";
	expected: string;
	ready: string | null;
	settled: string | null;
}

export type ModeCheck =
	| { ok: true }
	| { ok: false; reason: string; mismatches: ModeMismatch[] };

/** Modes each load of a scenario must report (see the module comment). */
export function expectedModes(
	scenario: Pick<SizeScenario, "kind" | "spinetab">,
): ExpectedModes {
	if (scenario.kind === "baseline" && !scenario.spinetab) {
		return { shared: "baseline", local: "baseline" };
	}
	if (scenario.kind !== "baseline" && scenario.spinetab) {
		return { shared: "shared", local: "local" };
	}
	throw new Error(
		`size scenario kind ${scenario.kind} with spinetab=${scenario.spinetab} has no expected mode`,
	);
}

const quote = (value: string | null) =>
	value === null ? "none" : JSON.stringify(value);

/** Every build × load must be ready in, and stay in, its expected mode. */
export function assertLoadModes(
	observed: Observed,
	expected: ExpectedModes,
): ModeCheck {
	const mismatches: ModeMismatch[] = [];
	const parts: string[] = [];
	for (const build of BUILDS) {
		for (const load of LOADS) {
			const { ready, settled } = observed[build][load];
			const want = expected[load];
			if (ready === want && settled === want) continue;
			const sharing = SHARING[load];
			mismatches.push({ build, load, sharing, expected: want, ready, settled });
			const what =
				ready === null
					? `timed out after ${READY_TIMEOUT_MS / 1_000} s with no __sizeReady`
					: ready !== want
						? `got ${quote(ready)}`
						: `was ready ${quote(ready)} but settled ${quote(settled)}`;
			parts.push(
				`${build} sharing=${sharing} expected ${quote(want)}, ${what}`,
			);
		}
	}
	return mismatches.length === 0
		? { ok: true }
		: {
				ok: false,
				reason: `load mode check failed: ${parts.join("; ")}`,
				mismatches,
			};
}

/** A scenario that yields no usable data; `error` is the reason every row cites. */
export interface ScenarioFailure {
	bundler: Bundler;
	status: "not-measured";
	error: string;
	logs: string[];
	modeCheck?: {
		expected: ExpectedModes;
		observed: Observed;
		mismatches: ModeMismatch[];
	};
	/** Per build × load: requests and console, kept for diagnosis only. */
	loads?: Observed<LoadObservation>;
}

const modesOnly = (loads: Observed<LoadObservation>): Observed => {
	const pick = ({ ready, settled, readyError }: LoadObservation) =>
		readyError === undefined
			? { ready, settled }
			: { ready, settled, readyError };
	return {
		min: { shared: pick(loads.min.shared), local: pick(loads.min.local) },
		raw: { shared: pick(loads.raw.shared), local: pick(loads.raw.local) },
	};
};

/**
 * Gate a scenario's loads before any size is computed: the recorded mode
 * check on success, or the not-measured record with its diagnostics.
 */
export function gateLoads(
	scenario: Pick<SizeScenario, "kind" | "spinetab">,
	bundler: Bundler,
	loads: Observed<LoadObservation>,
	logs: string[],
):
	| {
			ok: true;
			modeCheck: { expected: ExpectedModes; observed: Observed };
	  }
	| { ok: false; failure: ScenarioFailure } {
	const expected = expectedModes(scenario);
	const observed = modesOnly(loads);
	const check = assertLoadModes(observed, expected);
	if (check.ok) return { ok: true, modeCheck: { expected, observed } };
	return {
		ok: false,
		failure: {
			bundler,
			status: "not-measured",
			error: check.reason,
			logs,
			modeCheck: { expected, observed, mismatches: check.mismatches },
			loads,
		},
	};
}

/** The fields of a measured scenario that rows are derived from. */
export interface MeasuredScenario {
	minified: {
		realms: Record<
			"page" | "worker" | "lazy",
			{ gzip: number; spinetabGzip: number }
		>;
	};
	offending: string[];
	fallbackInShared: string[];
}

export type ScenarioOutcome =
	| MeasuredScenario
	| { error: string }
	| ScenarioFailure
	| undefined;

export const isMeasured = (
	outcome: ScenarioOutcome,
): outcome is MeasuredScenario =>
	outcome !== undefined && "minified" in outcome && !("error" in outcome);

/** Why an outcome is not usable; undefined when it is measured. */
export function failureReason(outcome: ScenarioOutcome): string | undefined {
	if (isMeasured(outcome)) return undefined;
	if (outcome === undefined) return "no result";
	return "error" in outcome ? outcome.error : "no usable result";
}

const brief = (text: string) =>
	text.length > 300 ? `${text.slice(0, 300)}…` : text;

export type RowValue = { value: number } | { reason: string };

/**
 * `size.fallback-downloads-in-shared.<bundler>`: the sum of fallback chunks
 * downloaded in shared mode over every selected Spinetab scenario, measured
 * only when all of them were measured; otherwise not measured naming each
 * failed scenario. A non-zero sum is still a measured value (the budget
 * fails it).
 */
export function fallbackDownloadsMetric(
	entries: Array<{ id: string; outcome: ScenarioOutcome }>,
): RowValue {
	if (entries.length === 0) return { reason: "no Spinetab scenario selected" };
	const failed = entries.filter(({ outcome }) => !isMeasured(outcome));
	if (failed.length > 0) {
		return {
			reason: `Spinetab scenario(s) not measured: ${failed
				.map(
					({ id, outcome }) => `${id} (${brief(failureReason(outcome) ?? "")})`,
				)
				.join("; ")}`,
		};
	}
	let total = 0;
	for (const { outcome } of entries) {
		total += (outcome as MeasuredScenario).fallbackInShared.length;
	}
	return { value: total };
}

const NATIVE_TRANSPORTS = new Set(["websocket", "sse", "stream", "polling"]);

/** Every bundler a size run can build. */
export const BUNDLERS: readonly Bundler[] = ["vite", "next"];

/** Reason for the rows of a scenario left out by `--only`. */
export const NOT_SELECTED = "not selected (--only)";

/** Whether a not-measured reason comes from the run's selection, not a failure. */
export const isNotSelected = (reason: string) =>
	/not selected \(--(?:only|bundlers)\)|no Spinetab scenario selected/.test(
		reason,
	);

/**
 * Every size row of one bundler from the selected scenarios' outcomes. A
 * scenario that is not measured contributes no value to any row: its own
 * rows, the rows that use it as a base and the fallback row are not
 * measured with its reason. A failed baseline has no rows of its own, so it
 * is recorded as `size.<id>.baseline.<bundler>` (no budget row) and the CLI
 * still fails.
 *
 * Every catalogue scenario is accounted for: one left out by `--only`
 * has its rows recorded as not measured, "not selected (--only)", never
 * dropped, and the fallback row is not measured unless every Spinetab
 * scenario of the catalogue was selected (a partial sum is not the metric).
 * `catalogue` is the full catalogue except when reproducing a run recorded
 * before this rule (reattribute.ts) or in unit fixtures.
 */
export function deriveRows(
	bundler: Bundler,
	selection: SizeScenario[],
	outcomes: Record<string, ScenarioOutcome>,
	catalogue: readonly SizeScenario[] = SCENARIOS,
): { metrics: Record<string, number>; notMeasured: Record<string, string> } {
	const metrics: Record<string, number> = {};
	const notMeasured: Record<string, string> = {};
	const put = (id: string, row: RowValue) => {
		if ("value" in row && Number.isFinite(row.value)) metrics[id] = row.value;
		else
			notMeasured[id] =
				"reason" in row ? row.reason : `non-finite value for ${id}`;
	};
	const selected = new Set(selection.map((scenario) => scenario.id));
	const known = new Set(catalogue.map((scenario) => scenario.id));
	const outside = [...selected].filter((id) => !known.has(id));
	if (outside.length > 0) {
		throw new Error(
			`size scenarios not in the catalogue: ${outside.join(", ")}`,
		);
	}
	const why = (id: string) =>
		selected.has(id) ? failureReason(outcomes[id]) : NOT_SELECTED;
	const notMeasuredReason = (ids: string[]) => {
		const reasons = ids.flatMap((id) => {
			const reason = why(id);
			return reason === undefined
				? []
				: [`${id} not measured: ${brief(reason)}`];
		});
		return reasons.length > 0 ? reasons.join("; ") : undefined;
	};
	const sum = (
		id: string,
		realms: Array<"page" | "worker">,
		field: "gzip" | "spinetabGzip",
	) => {
		const outcome = outcomes[id] as MeasuredScenario;
		return realms.reduce(
			(total, realm) => total + outcome.minified.realms[realm][field],
			0,
		);
	};

	for (const scenario of catalogue) {
		if (scenario.spinetab) continue;
		const reason = why(scenario.id);
		if (reason !== undefined) {
			notMeasured[`size.${scenario.id}.baseline.${bundler}`] =
				`${scenario.id} not measured: ${brief(reason)}`;
		}
	}

	for (const realm of ["page", "worker"] as const) {
		const blocked = notMeasuredReason(["core"]);
		put(
			`size.core.${realm}.gzip.${bundler}`,
			blocked
				? { reason: blocked }
				: { value: sum("core", [realm], "spinetabGzip") },
		);
	}

	const missingBase = unselectedBases(selection);
	const spinetab = catalogue.filter((scenario) => scenario.spinetab);
	for (const scenario of spinetab) {
		const own = notMeasuredReason([scenario.id]);
		put(
			`size.${scenario.id}.absent.${bundler}`,
			own
				? { reason: own }
				: {
						value: (outcomes[scenario.id] as MeasuredScenario).offending.length,
					},
		);
		if (!scenario.base) continue;
		const incremental = `size.${scenario.id}.incremental.gzip.${bundler}`;
		if (missingBase[scenario.id]) {
			notMeasured[incremental] = `base ${scenario.base} ${NOT_SELECTED}`;
			if (bundler === "vite" && NATIVE_TRANSPORTS.has(scenario.id)) {
				notMeasured[`size.${scenario.id}.attribution-agreement.vite`] =
					`base ${scenario.base} ${NOT_SELECTED}`;
			}
			continue;
		}
		const realms: Array<"page" | "worker"> =
			scenario.target === "page" ? ["page"] : ["page", "worker"];
		const blocked = notMeasuredReason([scenario.id, scenario.base]);
		const spinetabDelta = blocked
			? Number.NaN
			: sum(scenario.id, realms, "spinetabGzip") -
				sum(scenario.base, realms, "spinetabGzip");
		put(incremental, blocked ? { reason: blocked } : { value: spinetabDelta });
		if (bundler === "vite" && NATIVE_TRANSPORTS.has(scenario.id)) {
			const agreement = `size.${scenario.id}.attribution-agreement.vite`;
			if (blocked) {
				notMeasured[agreement] = blocked;
				continue;
			}
			const differential =
				sum(scenario.id, realms, "gzip") - sum(scenario.base, realms, "gzip");
			put(agreement, {
				value:
					Math.abs(spinetabDelta - differential) / Math.max(differential, 1),
			});
		}
	}

	const chosen = spinetab.filter((scenario) => selected.has(scenario.id));
	const fallback = fallbackDownloadsMetric(
		chosen.map((scenario) => ({
			id: scenario.id,
			outcome: outcomes[scenario.id],
		})),
	);
	const unselected = spinetab
		.filter((scenario) => !selected.has(scenario.id))
		.map((scenario) => scenario.id);
	if (chosen.length > 0 && unselected.length > 0) {
		const note = `Spinetab scenario(s) ${NOT_SELECTED}: ${unselected.join(", ")}`;
		put(`size.fallback-downloads-in-shared.${bundler}`, {
			reason: "reason" in fallback ? `${fallback.reason}; ${note}` : note,
		});
	} else {
		put(`size.fallback-downloads-in-shared.${bundler}`, fallback);
	}
	return { metrics, notMeasured };
}

/**
 * Rows of the bundlers a run did not build (`--bundlers`), recorded as not
 * measured so no size row disappears from the report.
 */
export function unselectedBundlerRows(
	bundlers: readonly Bundler[],
	catalogue: readonly SizeScenario[] = SCENARIOS,
): Record<string, string> {
	const rows: Record<string, string> = {};
	for (const bundler of BUNDLERS) {
		if (bundlers.includes(bundler)) continue;
		const derived = deriveRows(bundler, [], {}, catalogue);
		for (const id of [
			...Object.keys(derived.metrics),
			...Object.keys(derived.notMeasured),
		]) {
			rows[id] = `bundler ${bundler} not selected (--bundlers)`;
		}
	}
	return rows;
}

/** `size.<id>.l3.*`: the generated-path (plugin) row family, informational. */
export const isPluginRow = (id: string): boolean =>
	/^size\.[^.]+\.l3\./.test(id);

/** A report's rows split into the L1 family and the plugin family. */
export function splitPluginRows<T>(rows: Record<string, T>): {
	l1: Record<string, T>;
	plugin: Record<string, T>;
} {
	const l1: Record<string, T> = {};
	const plugin: Record<string, T> = {};
	for (const [id, value] of Object.entries(rows)) {
		(isPluginRow(id) ? plugin : l1)[id] = value;
	}
	return { l1, plugin };
}

const REALM_NAMES = ["page", "worker", "lazy"] as const;

/**
 * The rows of one plugin scenario and bundler: Spinetab-only page and worker
 * gzip (the L1 row definition, generated code excluded), the generated
 * worker's gzip, each realm's emitted-gzip delta against the L1
 * counterpart, the inference cost (inferred minus explicit, every realm),
 * the absent count and the fallback downloads in shared mode.
 */
export function pluginRowIds(
	scenario: PluginScenario,
	bundler: Bundler,
): string[] {
	const row = (name: string) => `size.${scenario.id}.l3.${name}.${bundler}`;
	return [
		row("page.gzip"),
		row("worker.gzip"),
		...(scenario.level === "L3" ? [row("generated.gzip")] : []),
		...REALM_NAMES.map((realm) => row(`${realm}.delta.gzip`)),
		...(scenario.inferenceBase ? [row("inference.gzip")] : []),
		row("absent"),
		row("fallback-downloads-in-shared"),
	];
}

/** A measured plugin scenario: the L1 fields plus its generated worker's gzip. */
interface MeasuredPlugin extends MeasuredScenario {
	generated?: { realms: Record<"page" | "worker" | "lazy", { gzip: number }> };
}

/**
 * Every `size.<id>.l3.*` row of one bundler. As for the L1 rows,
 * every catalogue scenario is accounted for: an unselected one records its
 * rows "not selected (--only)", a failed one records its reason, and a delta
 * or inference row also needs its counterpart or explicit twin, from the
 * same run's outcomes (`l1Selection` names the L1 scenarios selected).
 */
export function derivePluginRows(
	bundler: Bundler,
	selection: PluginScenario[],
	outcomes: Record<string, ScenarioOutcome>,
	l1Selection: SizeScenario[],
	catalogue: readonly PluginScenario[] = PLUGIN_SCENARIOS,
): { metrics: Record<string, number>; notMeasured: Record<string, string> } {
	const known = new Set(catalogue.map((scenario) => scenario.id));
	const outside = selection
		.map((scenario) => scenario.id)
		.filter((id) => !known.has(id));
	if (outside.length > 0) {
		throw new Error(
			`plugin scenarios not in the plugin catalogue: ${outside.join(", ")}`,
		);
	}
	const selected = new Set(
		[...selection, ...l1Selection].map((scenario) => scenario.id),
	);
	const why = (id: string) =>
		selected.has(id) ? failureReason(outcomes[id]) : NOT_SELECTED;
	const blockedBy = (ids: string[]) => {
		const reasons = ids.flatMap((id) => {
			const reason = why(id);
			return reason === undefined
				? []
				: [`${id} not measured: ${brief(reason)}`];
		});
		return reasons.length > 0 ? reasons.join("; ") : undefined;
	};
	const metrics: Record<string, number> = {};
	const notMeasured: Record<string, string> = {};
	for (const scenario of catalogue) {
		const row = (name: string) => `size.${scenario.id}.l3.${name}.${bundler}`;
		const put = (name: string, needs: string[], value: () => number) => {
			const blocked = blockedBy(needs);
			if (blocked) notMeasured[row(name)] = blocked;
			else metrics[row(name)] = value();
		};
		const own = () => outcomes[scenario.id] as MeasuredPlugin;
		const realmOf = (id: string, realm: (typeof REALM_NAMES)[number]) =>
			(outcomes[id] as MeasuredScenario).minified.realms[realm];
		const total = (id: string) =>
			REALM_NAMES.reduce((sum, realm) => sum + realmOf(id, realm).gzip, 0);
		const self = [scenario.id];
		put("page.gzip", self, () => realmOf(scenario.id, "page").spinetabGzip);
		put("worker.gzip", self, () => realmOf(scenario.id, "worker").spinetabGzip);
		if (scenario.level === "L3") {
			put(
				"generated.gzip",
				self,
				() => own().generated?.realms.worker.gzip ?? 0,
			);
		}
		for (const realm of REALM_NAMES) {
			put(
				`${realm}.delta.gzip`,
				[scenario.id, scenario.counterpart],
				() =>
					realmOf(scenario.id, realm).gzip -
					realmOf(scenario.counterpart, realm).gzip,
			);
		}
		if (scenario.inferenceBase) {
			const base = scenario.inferenceBase;
			put(
				"inference.gzip",
				[scenario.id, base],
				() => total(scenario.id) - total(base),
			);
		}
		put("absent", self, () => own().offending.length);
		put(
			"fallback-downloads-in-shared",
			self,
			() => own().fallbackInShared.length,
		);
	}
	return { metrics, notMeasured };
}

/** Plugin rows of the bundlers a run did not build (`--bundlers`), as for L1. */
export function unselectedPluginBundlerRows(
	bundlers: readonly Bundler[],
): Record<string, string> {
	const rows: Record<string, string> = {};
	for (const bundler of BUNDLERS) {
		if (bundlers.includes(bundler)) continue;
		for (const scenario of PLUGIN_SCENARIOS) {
			for (const id of pluginRowIds(scenario, bundler)) {
				rows[id] = `bundler ${bundler} not selected (--bundlers)`;
			}
		}
	}
	return rows;
}

/**
 * Chunks of the local module downloaded in shared mode. L1: any chunk
 * holding the scenario's `local` module that the shared load fetched. Under
 * the plugin the local module is `auto/worker`, which the worker entry also
 * holds, so only a fetch by the page itself (`script`, not a worker's
 * `importScripts`) counts.
 */
export function fallbackDownloads(
	localChunks: readonly string[],
	sharedRequests: LoggedRequest[],
	plugin: boolean,
): string[] {
	if (!plugin) {
		const fetched = new Set(
			sharedRequests
				.filter((request) => request.status === 200)
				.map((request) => request.path),
		);
		return localChunks.filter((path) => fetched.has(path));
	}
	const dests = destinations(sharedRequests);
	return localChunks.filter((path) => dests.get(path)?.has("script"));
}

const pluginRowNote: Array<[RegExp, string, string, string]> = [
	[
		/\.l3\.(page|worker)\.gzip\./,
		"bundle-size",
		"B",
		"Spinetab-only gzip of the realm, generated code excluded",
	],
	[
		/\.l3\.generated\.gzip\./,
		"bundle-size",
		"B",
		"gzip of the generated worker module in the worker realm",
	],
	[
		/\.l3\.(page|worker|lazy)\.delta\.gzip\./,
		"bundle-size",
		"B",
		"realm's full emitted gzip minus the L1 counterpart's",
	],
	[
		/\.l3\.inference\.gzip\./,
		"bundle-size",
		"B",
		"total emitted gzip, inferred minus the explicit-adapters twin (expected 0)",
	],
	[
		/\.l3\.absent\./,
		"dependency-isolation",
		"sources",
		"attributed sources outside the scenario's allowed set, plus generated-worker mismatches",
	],
	[
		/\.l3\.fallback-downloads-in-shared\./,
		"dependency-isolation",
		"files",
		"local-module chunks the page fetched in shared mode",
	],
];

/** Plugin size rows are informational: report values without enforcing a target. */
export function pluginBudgetRows(): BudgetRow[] {
	return BUNDLERS.flatMap((bundler) =>
		PLUGIN_SCENARIOS.flatMap((scenario) =>
			pluginRowIds(scenario, bundler).map((id): BudgetRow => {
				const [, behaviour, unit, what] = pluginRowNote.find(([pattern]) =>
					pattern.test(id),
				) as [RegExp, string, string, string];
				return {
					id,
					behaviour,
					owner: "performance",
					unit,
					comparator: "report",
					target: null,
					targetState: "provisional",
					reason: `informational: ${what}`,
					evidence: `sizes.json#${scenario.id}/${bundler} (${scenario.level} plugin scenario; counterpart ${scenario.counterpart})`,
					kind: "size",
					gate: "all",
				};
			}),
		),
	);
}
