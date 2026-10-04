import type { RawRecord } from "./evidence.ts";
import type { BudgetRow, Evaluation } from "./stats.ts";

/**
 * Pinned acceptance eligibility. Pure.
 *
 * A repetition counts towards pinned acceptance only when the run's
 * `environment.json` has `profile: "pinned"` and `loadGate[<rep>]` (written by
 * `ensureEnvironment` in environment.ts) is well formed, `passed: true`,
 * `ignored: false` and satisfies its recorded host policy, and the run is tied to a
 * candidate: a tarball sha256, package and harness dist hashes, and
 * `identityCheck[<rep>]` hashes equal to them. Anything else (no manifest, no
 * gate, malformed gate, a failed gate, a gate bypassed with
 * `SPINETAB_PERF_IGNORE_LOAD=1`, no tarball, no identity, dist changed) fails
 * closed: the repetition's values are kept as informational diagnostics with
 * the reason, never as acceptance evidence.
 */

/** Mirrors `LOAD_LIMIT` in environment.ts: pinned reps start below load 2. */
export const LOAD_LIMIT = 2;

/** `environment.loadGate[<rep>]` as environment.ts writes it. */
export interface LoadGate {
	passed: boolean;
	ignored: boolean;
	loadAverage: number[];
	project: string;
	at: string;
	policy?: "load-v1" | "observed-host-v1";
	host?: {
		platform: string;
		acPower: boolean;
		lowPowerMode: boolean;
		thermalState: number;
		logicalCpus: number;
		cpuSampleMs: number;
		cpuIdlePercent: number;
	};
}

export type Eligibility =
	| { eligible: true; gate: LoadGate }
	| { eligible: false; reason: string };

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Explicit reference-Mac policy; load remains a reported observation.
 * Repeated measurements must still meet the unchanged budgets and noise limits.
 * Legacy records retain the original load-v1 rule and are never reclassified.
 */
export function hostProblem(value: unknown): string | undefined {
	if (!isObject(value)) return "missing host observations";
	if (value.platform !== "darwin") return "reference host is not macOS";
	if (value.acPower !== true) return "AC power not confirmed";
	if (value.lowPowerMode !== false) return "Low Power Mode off not confirmed";
	if (value.thermalState !== 0) return "nominal thermal state not confirmed";
	if (!Number.isInteger(value.logicalCpus) || Number(value.logicalCpus) < 1)
		return "invalid CPU count";
	if (
		typeof value.cpuSampleMs !== "number" ||
		!Number.isFinite(value.cpuSampleMs) ||
		value.cpuSampleMs < 1_000
	)
		return "invalid CPU sampling interval";
	if (
		typeof value.cpuIdlePercent !== "number" ||
		!Number.isFinite(value.cpuIdlePercent) ||
		value.cpuIdlePercent < 0 ||
		value.cpuIdlePercent > 100
	)
		return "invalid CPU activity observation";
	return undefined;
}

/** The gate, or the names of its missing or invalid fields. */
export function readLoadGate(value: unknown): LoadGate | string {
	if (!isObject(value)) return "not an object";
	const invalid: string[] = [];
	if (typeof value.passed !== "boolean") invalid.push("passed");
	if (typeof value.ignored !== "boolean") invalid.push("ignored");
	const load = value.loadAverage;
	if (
		!Array.isArray(load) ||
		load.length === 0 ||
		!load.every((entry) => typeof entry === "number" && Number.isFinite(entry))
	) {
		invalid.push("loadAverage");
	}
	if (typeof value.project !== "string") invalid.push("project");
	if (typeof value.at !== "string") invalid.push("at");
	if (
		value.policy !== undefined &&
		value.policy !== "load-v1" &&
		value.policy !== "observed-host-v1"
	)
		invalid.push("policy");
	return invalid.length > 0
		? `invalid ${invalid.join(", ")}`
		: (value as unknown as LoadGate);
}

const no = (reason: string): Eligibility => ({
	eligible: false,
	reason: `ineligible: ${reason}`,
});

/** Whether repetition `rep` of this run may count towards pinned acceptance. */
export function repEligibility(environment: unknown, rep: string): Eligibility {
	if (!isObject(environment)) return no("no environment manifest");
	if (environment.profile !== "pinned") {
		return no(
			`environment profile ${JSON.stringify(environment.profile ?? null)} is not pinned`,
		);
	}
	const gates = environment.loadGate;
	if (gates === undefined) return no("no load gate metadata");
	if (!isObject(gates)) {
		return no("malformed load gate metadata (loadGate is not an object)");
	}
	if (!Object.hasOwn(gates, rep)) {
		return no(`no load gate metadata for rep ${rep}`);
	}
	const gate = readLoadGate(gates[rep]);
	if (typeof gate === "string") {
		return no(`malformed load gate metadata for rep ${rep} (${gate})`);
	}
	const load = gate.loadAverage[0] as number;
	const shown = load.toFixed(2);
	if (gate.ignored) {
		return no(`load gate ignored (SPINETAB_PERF_IGNORE_LOAD=1, load ${shown})`);
	}
	if (gate.policy === "observed-host-v1") {
		const problem = hostProblem(gate.host);
		if (problem) return no(problem);
		if (!gate.passed) return no("observed host gate failed");
		const identity = identityProblem(environment, rep);
		return identity ? no(identity) : { eligible: true, gate };
	}
	if (!gate.passed) {
		return no(`load gate failed (load ${shown} ≥ ${LOAD_LIMIT})`);
	}
	if (load >= LOAD_LIMIT) {
		// A pinned gate cannot pass at this load: never trust it.
		return no(
			`load gate inconsistent (passed at load ${shown} ≥ ${LOAD_LIMIT})`,
		);
	}
	const identity = identityProblem(environment, rep);
	if (identity) return no(identity);
	return { eligible: true, gate };
}

const SHA256 = /^[0-9a-f]{64}$/;
const hex = (value: unknown): string | null =>
	typeof value === "string" && SHA256.test(value) ? value : null;
const short = (value: string | null) => (value ? value.slice(0, 12) : "none");

/** `tarball.sha256.value`, `identity.<tree>.sha256` as environment.ts writes them. */
function recorded(environment: Record<string, unknown>) {
	const tarball = isObject(environment.tarball) ? environment.tarball : {};
	const probe = isObject(tarball.sha256) ? tarball.sha256 : {};
	const identity = isObject(environment.identity) ? environment.identity : {};
	const tree = (name: string) => {
		const entry = identity[name];
		return isObject(entry) ? hex(entry.sha256) : null;
	};
	return {
		method: typeof identity.method === "string" ? identity.method : null,
		tarballPath: typeof tarball.path === "string" ? tarball.path : null,
		tarball: hex(probe.value),
		packageDist: tree("packageDist"),
		harnessDist: tree("harnessDist"),
	};
}

/**
 * Why repetition `rep` cannot be tied to the candidate, or undefined:
 * no tarball sha256 (the pinned profile needs `SPINETAB_PERF_TARBALL`), no
 * package or harness dist hash, no hash taken when the repetition started,
 * or trees that differ from the run's identity ("dist changed").
 */
export function identityProblem(
	environment: unknown,
	rep: string,
): string | undefined {
	if (!isObject(environment)) return "no environment manifest";
	const base = recorded(environment);
	if (!base.tarball) {
		return "no candidate tarball recorded (the pinned profile needs SPINETAB_PERF_TARBALL)";
	}
	if (!base.packageDist || !base.harnessDist) {
		return "no dist identity recorded (package and harness dist hashes)";
	}
	const checks = isObject(environment.identityCheck)
		? environment.identityCheck
		: {};
	const check = Object.hasOwn(checks, rep) ? checks[rep] : undefined;
	if (!isObject(check)) return `no dist identity check for rep ${rep}`;
	const changed: string[] = [];
	const packageDist = hex(check.packageDist);
	const harnessDist = hex(check.harnessDist);
	if (packageDist !== base.packageDist) {
		changed.push(
			`package dist ${short(base.packageDist)} → ${short(packageDist)}`,
		);
	}
	if (harnessDist !== base.harnessDist) {
		changed.push(
			`harness dist ${short(base.harnessDist)} → ${short(harnessDist)}`,
		);
	}
	return changed.length > 0
		? `dist changed since the run's identity was recorded (${changed.join("; ")})`
		: undefined;
}

/** What a summary reports about the candidate a run measured. */
export interface IdentitySummary {
	method: string | null;
	tarball: { path: string | null; sha256: string | null };
	packageDist: string | null;
	harnessDist: string | null;
	reps: Record<
		string,
		{ packageDist: string | null; harnessDist: string | null; matches: boolean }
	>;
}

export function identitySummary(environment: unknown): IdentitySummary {
	const base = isObject(environment) ? recorded(environment) : undefined;
	const checks =
		isObject(environment) && isObject(environment.identityCheck)
			? environment.identityCheck
			: {};
	const reps: IdentitySummary["reps"] = {};
	for (const rep of Object.keys(checks).sort()) {
		const check = checks[rep];
		const packageDist = isObject(check) ? hex(check.packageDist) : null;
		const harnessDist = isObject(check) ? hex(check.harnessDist) : null;
		reps[rep] = {
			packageDist,
			harnessDist,
			matches:
				packageDist !== null &&
				harnessDist !== null &&
				packageDist === base?.packageDist &&
				harnessDist === base?.harnessDist,
		};
	}
	return {
		method: base?.method ?? null,
		tarball: { path: base?.tarballPath ?? null, sha256: base?.tarball ?? null },
		packageDist: base?.packageDist ?? null,
		harnessDist: base?.harnessDist ?? null,
		reps,
	};
}

/** A record is eligible when it is pinned and its repetition is eligible. */
export function recordEligibility(
	record: Pick<RawRecord, "profile" | "rep">,
	environment: unknown,
): Eligibility {
	if (record.profile !== "pinned") {
		return no(`${String(record.profile)} profile record`);
	}
	return repEligibility(environment, record.rep);
}

export interface Partition<R> {
	eligible: R[];
	ineligible: Array<{ record: R; reason: string }>;
}

export function partitionRecords<R extends Pick<RawRecord, "profile" | "rep">>(
	records: readonly R[],
	environment: unknown,
): Partition<R> {
	const result: Partition<R> = { eligible: [], ineligible: [] };
	for (const record of records) {
		const verdict = recordEligibility(record, environment);
		if (verdict.eligible) result.eligible.push(record);
		else result.ineligible.push({ record, reason: verdict.reason });
	}
	return result;
}

/** Distinct reasons, the first three verbatim (for row notes). */
export function describeReasons(reasons: Iterable<string>): string {
	const distinct = [...new Set(reasons)];
	const shown = distinct.slice(0, 3).join("; ");
	return distinct.length > 3
		? `${shown}; +${distinct.length - 3} more reason(s)`
		: shown;
}

/** What the ineligible (diagnostic) runs of one row would have produced. */
export interface Diagnostic extends Evaluation {
	runs: number;
	why: string;
}

/**
 * Final row verdict from the eligible evaluation and the diagnostic one.
 * Diagnostics never pass or gate a row; a structural failure in them (a
 * wrong count, a leaked handle) is still a `fail`, never hidden.
 */
export function combineEvaluation(
	row: Pick<BudgetRow, "kind" | "role">,
	eligible: Evaluation,
	diagnostic: Diagnostic | undefined,
): Evaluation {
	if (!diagnostic || diagnostic.runs === 0) return eligible;
	const excluded = `${diagnostic.runs} ineligible run(s) excluded (${diagnostic.why})`;
	const structural =
		(row.kind ?? "structural") === "structural" && row.role !== "informational";
	if (eligible.status === "fail") {
		return { ...eligible, reason: `${eligible.reason}; ${excluded}` };
	}
	if (structural && diagnostic.status === "fail") {
		return {
			measured: diagnostic.measured,
			cv: diagnostic.cv,
			status: "fail",
			reason: `${diagnostic.why}: ${diagnostic.reason} (a structural failure in ineligible runs is never hidden)`,
		};
	}
	if (eligible.status === "not-measured") {
		return {
			measured: diagnostic.measured,
			cv: diagnostic.cv,
			status: "informational",
			reason: `${diagnostic.why}; diagnostic only, never acceptance (would be ${diagnostic.status}: ${diagnostic.reason})`,
		};
	}
	return { ...eligible, reason: `${eligible.reason}; ${excluded}` };
}

/** `env.pinned-runs` reason in a smoke-only run. */
export const SMOKE_PINNED_NOT_APPLICABLE =
	"smoke profile: pinned repetitions not applicable; timing and heap never gate";

/**
 * Whether the pinned repetition count is not applicable because the run is a
 * smoke run and nothing else. Smoke can never count as
 * pinned, so requiring ten eligible pinned repetitions there is meaningless.
 * Fails closed: every record of the gating project must be smoke and the
 * manifest must say `profile: "smoke"`; a mixed run, a missing manifest or a
 * pinned manifest keeps the strict ≥ 10 eligible repetitions rule.
 */
export function smokeOnly(
	records: ReadonlyArray<Pick<RawRecord, "profile" | "project">>,
	environment: unknown,
	project: string,
): boolean {
	const gating = records.filter((record) => record.project === project);
	return (
		gating.length > 0 &&
		gating.every((record) => record.profile === "smoke") &&
		isObject(environment) &&
		environment.profile === "smoke"
	);
}
