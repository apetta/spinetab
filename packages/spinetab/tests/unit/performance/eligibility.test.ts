import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluateRun } from "../../performance/aggregate.ts";
import {
	LOAD_LIMIT,
	type LoadGate,
	recordEligibility,
	repEligibility,
	SMOKE_PINNED_NOT_APPLICABLE,
	smokeOnly,
} from "../../performance/lib/eligibility.ts";
import type { RawRecord } from "../../performance/lib/evidence.ts";
import { type BudgetRow, cv, median } from "../../performance/lib/stats.ts";

// Synthetic records validate eligibility rules; they are not package measurements.

const budgets = JSON.parse(
	readFileSync(
		new URL("../../performance/budgets.json", import.meta.url),
		"utf8",
	),
) as { rows: BudgetRow[] };

const TIMING = "latency.ws.n1.cross.p95";
const HEAP = "heap.cycles.ws.page";
const TRIAL = "return.graphql-ws.check-health.stall.restored";
const SAFETY = "tabs.ws.spinetab.n1.lost";
const rows = budgets.rows.filter((row) =>
	[TIMING, HEAP, TRIAL, SAFETY, "env.manifest", "env.pinned-runs"].includes(
		row.id,
	),
);

const gate = (overrides: Partial<LoadGate> = {}): LoadGate => ({
	passed: true,
	ignored: false,
	loadAverage: [1, 1, 1],
	project: "chromium-perf",
	at: "2026-09-27T00:00:00.000Z",
	...overrides,
});
const IGNORED = gate({ ignored: true, loadAverage: [9, 9, 9] });
const FAILED = gate({ passed: false, loadAverage: [6.8, 6, 5] });

const repId = (index: number) => String(index).padStart(2, "0");

function record(
	rep: string,
	values: { timing?: number; lost?: number; unbudgeted?: number } = {},
	profile: RawRecord["profile"] = "pinned",
): RawRecord {
	const timing = values.timing ?? 1;
	return {
		schema: 1,
		run: "SYNTHETIC",
		rep,
		profile,
		project: "chromium-perf",
		scenario: "tabs",
		config: "spinetab-ws-n1",
		writtenAt: `2026-09-27T00:00:${rep}.000Z`,
		metrics: {
			[TIMING]: timing,
			[HEAP]: timing,
			[TRIAL]: [timing, timing],
			[SAFETY]: values.lost ?? 0,
			"synthetic.unbudgeted": values.unbudgeted ?? timing,
		},
		detail: { synthetic: true },
	};
}

/** The candidate identity a pinned run records (environment-identity.test.ts). */
const IDENTITY = {
	tarball: {
		path: "/synthetic/spinetab-0.0.0.tgz",
		sha256: { value: "c".repeat(64) },
	},
	identity: {
		method: "synthetic",
		packageDist: { path: "/synthetic/dist", sha256: "a".repeat(64), files: 1 },
		harnessDist: {
			path: "/synthetic/harness",
			sha256: "b".repeat(64),
			files: 1,
		},
	},
};
const MATCHING_CHECK = {
	at: "2026-09-27T00:00:00.000Z",
	project: "chromium-perf",
	packageDist: "a".repeat(64),
	harnessDist: "b".repeat(64),
};

/** A manifest with these load gates, tied to its candidate for every gated rep. */
function environment(gates: Record<string, unknown>, profile = "pinned") {
	const identityCheck =
		typeof gates === "object" && gates !== null && !Array.isArray(gates)
			? Object.fromEntries(
					Object.keys(gates).map((rep) => [rep, MATCHING_CHECK]),
				)
			: {};
	return {
		schema: 1,
		run: "SYNTHETIC",
		profile,
		loadGate: gates,
		...IDENTITY,
		identityCheck,
	};
}

/** `count` reps starting at `from`, each with the same gate. */
function reps(from: number, count: number, loadGate: unknown) {
	const gates: Record<string, unknown> = {};
	for (let index = from; index < from + count; index += 1) {
		gates[repId(index)] = loadGate;
	}
	return gates;
}

const result = (run: ReturnType<typeof evaluateRun>, id: string) => {
	const found = run.evaluated.find(({ row }) => row.id === id);
	if (!found) throw new Error(`no row ${id}`);
	return found;
};
const status = (run: ReturnType<typeof evaluateRun>, id: string) =>
	result(run, id).evaluation.status;

const ACCEPTANCE = [TIMING, HEAP, TRIAL];

describe("repEligibility", () => {
	const observed = (): LoadGate =>
		gate({
			policy: "observed-host-v1",
			loadAverage: [33, 47, 55],
			host: {
				platform: "darwin",
				acPower: true,
				lowPowerMode: false,
				thermalState: 0,
				logicalCpus: 10,
				cpuSampleMs: 2_000,
				cpuIdlePercent: 70,
			},
		});

	it("accepts an explicit observed-host record without retroactively accepting legacy high-load records", () => {
		expect(
			repEligibility(environment({ "01": observed() }), "01").eligible,
		).toBe(true);
		expect(
			repEligibility(environment({ "01": gate({ loadAverage: [33] }) }), "01")
				.eligible,
		).toBe(false);
	});

	it.each([
		{ host: undefined },
		{ host: { ...observed().host, acPower: false } },
		{ host: { ...observed().host, lowPowerMode: true } },
		{ host: { ...observed().host, thermalState: 1 } },
		{ host: { ...observed().host, cpuIdlePercent: Number.NaN } },
		{ host: { ...observed().host, cpuSampleMs: 0 } },
		{ host: { ...observed().host, logicalCpus: 0 } },
		{ host: { ...observed().host, platform: "linux" } },
		{ passed: false },
		{ ignored: true },
		{ policy: "unknown" },
	])("rejects missing, adverse, bypassed or malformed observed-host evidence: %j", (change) => {
		expect(
			repEligibility(environment({ "01": { ...observed(), ...change } }), "01")
				.eligible,
		).toBe(false);
	});

	it("keeps budget and repetition gates for observed-host measurements", () => {
		const accepted = evaluateRun({
			rows,
			records: Array.from({ length: 10 }, (_, i) => record(repId(i + 1))),
			environment: environment(reps(1, 10, observed())),
		});
		expect(status(accepted, TIMING)).toBe("pass");
		const tooSlow = evaluateRun({
			rows,
			records: Array.from({ length: 10 }, (_, i) =>
				record(repId(i + 1), { timing: 10_000 }),
			),
			environment: environment(reps(1, 10, observed())),
		});
		expect(status(tooSlow, TIMING)).toBe("fail");
		const tooFew = evaluateRun({
			rows,
			records: [record("01")],
			environment: environment({ "01": observed() }),
		});
		expect(status(tooFew, TIMING)).not.toBe("pass");
	});

	it("accepts a well-formed passed pinned gate below the load limit", () => {
		expect(repEligibility(environment({ "01": gate() }), "01").eligible).toBe(
			true,
		);
	});

	it.each([
		["no manifest", undefined, /no environment manifest/],
		[
			"smoke manifest",
			environment({ "01": gate() }, "smoke"),
			/profile "smoke" is not pinned/,
		],
		["no loadGate", { schema: 1, profile: "pinned" }, /no load gate metadata$/],
		[
			"loadGate not an object",
			environment([] as unknown as Record<string, unknown>),
			/malformed load gate metadata \(loadGate is not an object\)/,
		],
		["rep absent", environment({ "02": gate() }), /no load gate .* rep 01/],
		[
			"string booleans",
			environment({ "01": { passed: "true", ignored: "false" } }),
			/malformed .* \(invalid passed, ignored, loadAverage, project, at\)/,
		],
		[
			"empty loadAverage",
			environment({ "01": gate({ loadAverage: [] }) }),
			/malformed .* \(invalid loadAverage\)/,
		],
		[
			"ignored",
			environment({ "01": IGNORED }),
			/load gate ignored \(SPINETAB_PERF_IGNORE_LOAD=1, load 9\.00\)/,
		],
		[
			"failed",
			environment({ "01": FAILED }),
			/load gate failed \(load 6\.80 ≥ 2\)/,
		],
		[
			"passed above the limit",
			environment({ "01": gate({ loadAverage: [LOAD_LIMIT] }) }),
			/load gate inconsistent/,
		],
	])("fails closed: %s", (_name, manifest, reason) => {
		const verdict = repEligibility(manifest, "01");
		expect(verdict.eligible).toBe(false);
		expect(verdict.eligible ? "" : verdict.reason).toMatch(/^ineligible: /);
		expect(verdict.eligible ? "" : verdict.reason).toMatch(reason);
	});

	it("rejects a smoke record even under an eligible gate", () => {
		const verdict = recordEligibility(
			{ profile: "smoke", rep: "01" },
			environment({ "01": gate() }),
		);
		expect(verdict).toEqual({
			eligible: false,
			reason: "ineligible: smoke profile record",
		});
	});
});

describe("evaluateRun pinned eligibility", () => {
	const ten = Array.from({ length: 10 }, (_, index) =>
		record(repId(index + 1)),
	);

	it("passes ten eligible identical repetitions exactly as before", () => {
		const run = evaluateRun({
			records: ten,
			environment: environment(reps(1, 10, gate())),
			rows,
		});
		for (const id of [...ACCEPTANCE, SAFETY, "env.manifest"]) {
			expect(status(run, id), id).toBe("pass");
		}
		expect(result(run, TIMING).evaluation).toMatchObject({
			measured: 1,
			cv: 0,
			reason:
				"median of 10 run(s); budget-relative dispersion 0.0 % (SD ÷ target) ≤ 10 %",
		});
		expect(result(run, "env.pinned-runs").evaluation).toMatchObject({
			measured: 10,
			status: "pass",
		});
		expect(run.eligibility.records).toEqual({
			total: 10,
			eligible: 10,
			ineligible: 0,
		});
		expect(run.evaluated.every(({ ineligible }) => !ineligible)).toBe(true);
	});

	it.each([
		["ignored", IGNORED, /load gate ignored \(SPINETAB_PERF_IGNORE_LOAD=1/],
		["failed", FAILED, /load gate failed \(load 6\.80 ≥ 2\)/],
		[
			"malformed",
			{ passed: "true", ignored: "false" },
			/malformed load gate metadata/,
		],
	])("keeps a %s load gate informational, never acceptance", (_name, loadGate, reason) => {
		const run = evaluateRun({
			records: ten,
			environment: environment(reps(1, 10, loadGate)),
			rows,
		});
		for (const id of ACCEPTANCE) {
			const { evaluation, ineligible } = result(run, id);
			expect(evaluation.status, id).toBe("informational");
			// Raw diagnostic value kept, with the explicit reason.
			expect(evaluation.measured, id).toBe(1);
			expect(evaluation.reason, id).toMatch(reason);
			expect(evaluation.reason, id).toMatch(/never acceptance/);
			expect(ineligible?.runs, id).toBe(10);
		}
		expect(result(run, "env.pinned-runs").evaluation).toMatchObject({
			measured: 0,
			status: "fail",
		});
		expect(result(run, "env.pinned-runs").evaluation.reason).toMatch(reason);
		expect(result(run, "env.manifest").evaluation).toMatchObject({
			measured: 0,
			status: "fail",
		});
		// A passing structural observation is reported, not accepted.
		expect(status(run, SAFETY)).toBe("informational");
		expect(Object.values(run.counts).reduce((a, b) => a + b)).toBe(rows.length);
		expect(run.counts.pass).toBeUndefined();
		expect(run.eligibility.records.ineligible).toBe(10);
		expect(Object.keys(run.eligibility.reasons)[0]).toMatch(reason);
	});

	it.each([
		["no environment manifest", undefined, /no environment manifest/],
		["no load gate", { schema: 1, profile: "pinned" }, /no load gate metadata/],
		["empty load gate map", environment({}), /no load gate metadata for rep/],
	])("fails closed with %s", (_name, manifest, reason) => {
		const run = evaluateRun({ records: ten, environment: manifest, rows });
		for (const id of [...ACCEPTANCE, "env.manifest", "env.pinned-runs"]) {
			expect(status(run, id), id).not.toBe("pass");
		}
		expect(result(run, TIMING).evaluation.reason).toMatch(reason);
		expect(result(run, "env.pinned-runs").evaluation.measured).toBe(0);
	});

	it("computes medians and CV from eligible runs only when mixed with diagnostics", () => {
		const eligibleValues = [2, 2.1, 1.9, 2, 2.05, 1.95, 2, 2.02, 1.98, 2];
		const records = [
			...eligibleValues.map((timing, index) =>
				record(repId(index + 1), { timing }),
			),
			...Array.from({ length: 5 }, (_, index) =>
				record(repId(index + 11), { timing: 50 }),
			),
		];
		const run = evaluateRun({
			records,
			environment: environment({
				...reps(1, 10, gate()),
				...reps(11, 5, IGNORED),
			}),
			rows,
		});
		const timing = result(run, TIMING);
		expect(timing.evaluation.status).toBe("pass");
		expect(timing.evaluation.measured).toBe(median(eligibleValues));
		expect(timing.evaluation.cv).toBeCloseTo(cv(eligibleValues), 12);
		expect(timing.evaluation.reason).toMatch(
			/^median of 10 run\(s\); budget-relative dispersion /,
		);
		expect(timing.evaluation.reason).toMatch(
			/; 5 ineligible run\(s\) excluded \(ineligible: load gate ignored/,
		);
		expect(timing.ineligible).toMatchObject({ runs: 5, measured: 50 });
		expect(result(run, "env.pinned-runs").evaluation).toMatchObject({
			measured: 10,
			status: "pass",
		});
		expect(result(run, "env.pinned-runs").evaluation.reason).toMatch(
			/10 of 15 pinned rep\(s\) eligible/,
		);
		expect(run.eligibility.reps.ineligible.map(({ rep }) => rep)).toEqual([
			"11",
			"12",
			"13",
			"14",
			"15",
		]);
		expect(run.reported["synthetic.unbudgeted"]).toMatchObject({
			n: 10,
			median: median(eligibleValues),
		});
		expect(run.reportedIneligible["synthetic.unbudgeted"]).toMatchObject({
			n: 5,
			median: 50,
		});
	});

	it("never tops up the required count with diagnostic repetitions", () => {
		const records = Array.from({ length: 10 }, (_, index) =>
			record(repId(index + 1)),
		);
		const run = evaluateRun({
			records,
			environment: environment({
				...reps(1, 9, gate()),
				...reps(10, 1, IGNORED),
			}),
			rows,
		});
		for (const id of ACCEPTANCE) expect(status(run, id), id).not.toBe("pass");
		expect(result(run, TIMING).evaluation.reason).toMatch(
			/only 9 run\(s\); 10 needed/,
		);
		expect(result(run, "env.pinned-runs").evaluation).toMatchObject({
			measured: 9,
			status: "fail",
		});
		expect(status(run, "env.manifest")).toBe("fail");
	});

	it.each([
		["ineligible only", 0],
		["mixed with ten eligible", 10],
	])("still fails a structural row on ineligible data (%s)", (_name, eligible) => {
		const records = [
			...Array.from({ length: eligible }, (_, index) =>
				record(repId(index + 1)),
			),
			...Array.from({ length: 3 }, (_, index) =>
				record(repId(eligible + index + 1), { lost: 1 }),
			),
		];
		const run = evaluateRun({
			records,
			environment: environment({
				...reps(1, eligible, gate()),
				...reps(eligible + 1, 3, IGNORED),
			}),
			rows,
		});
		const safety = result(run, SAFETY).evaluation;
		expect(safety.status).toBe("fail");
		expect(safety.measured).toBe(1);
		expect(safety.reason).toMatch(/load gate ignored/);
		expect(safety.reason).toMatch(/never hidden/);
	});

	it("keeps the smoke profile's structural checks and never gates timing", () => {
		const run = evaluateRun({
			records: [record("01", {}, "smoke")],
			environment: environment({ "01": gate() }, "smoke"),
			rows,
		});
		expect(run.profile).toBe("smoke");
		expect(run.eligibility.applied).toBe(false);
		expect(status(run, SAFETY)).toBe("pass");
		expect(status(run, TIMING)).toBe("informational");
		expect(status(run, "env.manifest")).toBe("pass");
		expect(run.eligibility.pinnedRunsApplicable).toBe(false);
	});
});

// smoke can never count as pinned, so the pinned repetition
// count is not applicable there; the pinned profile keeps ≥ 10 eligible.
describe("env.pinned-runs applicability", () => {
	const pinnedRuns = (run: ReturnType<typeof evaluateRun>) =>
		result(run, "env.pinned-runs").evaluation;

	it("positive control: ten eligible pinned repetitions pass", () => {
		const run = evaluateRun({
			records: Array.from({ length: 10 }, (_, index) =>
				record(repId(index + 1)),
			),
			environment: environment(reps(1, 10, gate())),
			rows,
		});
		expect(run.eligibility.pinnedRunsApplicable).toBe(true);
		expect(pinnedRuns(run)).toMatchObject({ measured: 10, status: "pass" });
	});

	it("negative control: nine eligible pinned repetitions fail", () => {
		const run = evaluateRun({
			records: Array.from({ length: 9 }, (_, index) =>
				record(repId(index + 1)),
			),
			environment: environment(reps(1, 9, gate())),
			rows,
		});
		expect(pinnedRuns(run)).toMatchObject({ measured: 9, status: "fail" });
		expect(pinnedRuns(run).reason).toMatch(/9 of 9 pinned rep\(s\) eligible/);
	});

	it("negative control: ten ignored-load pinned repetitions fail", () => {
		const run = evaluateRun({
			records: Array.from({ length: 10 }, (_, index) =>
				record(repId(index + 1)),
			),
			environment: environment(reps(1, 10, IGNORED)),
			rows,
		});
		expect(pinnedRuns(run)).toMatchObject({ measured: 0, status: "fail" });
		expect(pinnedRuns(run).reason).toMatch(/load gate ignored/);
	});

	it("smoke: informational with the explicit reason, never fail and never pass", () => {
		const run = evaluateRun({
			records: [record("01", {}, "smoke")],
			environment: environment({ "01": gate() }, "smoke"),
			rows,
		});
		expect(pinnedRuns(run)).toMatchObject({
			measured: 0,
			status: "informational",
		});
		expect(pinnedRuns(run).reason).toBe(
			`${SMOKE_PINNED_NOT_APPLICABLE}; 0 of 0 pinned rep(s) eligible`,
		);
		expect(SMOKE_PINNED_NOT_APPLICABLE).toBe(
			"smoke profile: pinned repetitions not applicable; timing and heap never gate",
		);
		// Nothing else is relaxed: timing stays informational, safety gates.
		expect(status(run, TIMING)).toBe("informational");
		expect(status(run, SAFETY)).toBe("pass");
		expect(run.counts.fail).toBeUndefined();
	});

	it.each([
		[
			"smoke records under a pinned manifest",
			[record("01", {}, "smoke")],
			environment({ "01": gate() }),
		],
		[
			"smoke records without a manifest",
			[record("01", {}, "smoke")],
			undefined,
		],
		[
			"a smoke manifest with one pinned record",
			[record("01", {}, "smoke"), record("02")],
			environment({ "01": gate(), "02": gate() }, "smoke"),
		],
	])("fails closed for %s: the count stays strict", (_name, records, manifest) => {
		const run = evaluateRun({ records, environment: manifest, rows });
		expect(run.eligibility.pinnedRunsApplicable).toBe(true);
		expect(pinnedRuns(run).status).toBe("fail");
	});

	it("smokeOnly needs every gating record and the manifest to be smoke", () => {
		const smoke = { profile: "smoke" as const, project: "chromium-perf" };
		const pinned = { profile: "pinned" as const, project: "chromium-perf" };
		const other = { profile: "pinned" as const, project: "firefox-functional" };
		const manifest = { profile: "smoke" };
		expect(smokeOnly([smoke, other], manifest, "chromium-perf")).toBe(true);
		expect(smokeOnly([smoke, pinned], manifest, "chromium-perf")).toBe(false);
		expect(smokeOnly([], manifest, "chromium-perf")).toBe(false);
		expect(smokeOnly([smoke], { profile: "pinned" }, "chromium-perf")).toBe(
			false,
		);
		expect(smokeOnly([smoke], undefined, "chromium-perf")).toBe(false);
	});
});
