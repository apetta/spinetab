import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	SCENARIOS,
	type SizeScenario,
	selectScenarios,
} from "../../performance/size/catalogue.ts";
import {
	assertLoadModes,
	BUILDS,
	deriveRows,
	expectedModes,
	fallbackDownloadsMetric,
	gateLoads,
	LOADS,
	type LoadObservation,
	type MeasuredScenario,
	type Observed,
	type ScenarioOutcome,
} from "../../performance/size/guard.ts";
import type { LoggedRequest } from "../../performance/size/static-server.ts";

// Fail-closed size guards: every load of both builds must report the scenario's
// expected `__sizeReady` mode before any size row is emitted, and the
// fallback row needs every selected Spinetab scenario measured.

const byId = (id: string) => {
	const scenario = SCENARIOS.find((candidate) => candidate.id === id);
	if (!scenario) throw new Error(`no scenario ${id}`);
	return scenario;
};
const core = byId("core");
const websocket = byId("websocket");
const baselineEmpty = byId("baseline-empty");

const request = (path: string, dest: string, status = 200): LoggedRequest => ({
	path,
	dest,
	referrer: null,
	status,
	bytes: 1,
});

const observation = (
	ready: string | null,
	settled: string | null = ready,
): LoadObservation => ({
	ready,
	settled,
	...(ready === null ? { readyError: "Timeout 20000ms exceeded." } : {}),
	requests: [
		request("/html/core.html", "document"),
		request("/assets/worker-a.js", "sharedworker", ready === null ? 404 : 200),
	],
	console: ready === null ? ["error: Failed to load resource: 404"] : [],
});

/** Loads that all report `modes`, with `override` applied to one build × load. */
const loads = (
	modes: { shared: string | null; local: string | null },
	override?: {
		build: "min" | "raw";
		load: "shared" | "local";
		value: LoadObservation;
	},
): Observed<LoadObservation> => {
	const result = {
		min: {
			shared: observation(modes.shared),
			local: observation(modes.local),
		},
		raw: {
			shared: observation(modes.shared),
			local: observation(modes.local),
		},
	};
	if (override) result[override.build][override.load] = override.value;
	return result;
};

const logs = ["/work/vite/logs/core-min.log", "/work/vite/logs/core-raw.log"];

describe("expected modes per scenario", () => {
	it("Spinetab scenarios expect shared for sharing=prefer and local for sharing=off", () => {
		for (const scenario of SCENARIOS.filter((s) => s.spinetab)) {
			expect(expectedModes(scenario), scenario.id).toEqual({
				shared: "shared",
				local: "local",
			});
		}
	});

	it("baselines expect their own baseline mode for both loads", () => {
		const baselines = SCENARIOS.filter((s) => s.kind === "baseline");
		expect(baselines.map((s) => s.id)).toEqual([
			"baseline-empty",
			"baseline-graphql-ws",
			"baseline-ws",
		]);
		for (const scenario of baselines) {
			expect(expectedModes(scenario), scenario.id).toEqual({
				shared: "baseline",
				local: "baseline",
			});
		}
	});

	it("a kind/spinetab combination without a template signal has no expected mode", () => {
		expect(() => expectedModes({ kind: "baseline", spinetab: true })).toThrow(
			/no expected mode/,
		);
		expect(() => expectedModes({ kind: "core", spinetab: false })).toThrow(
			/no expected mode/,
		);
	});

	it("each template signals exactly the mode its scenario expects", () => {
		const templates = join(
			import.meta.dirname,
			"../../performance/size/scenarios",
		);
		for (const scenario of SCENARIOS) {
			const page = readFileSync(
				join(templates, scenario.id, "page.ts"),
				"utf8",
			);
			const signals = [...page.matchAll(/__sizeReady = ([^;]+);/g)].map(
				(match) => match[1],
			);
			expect(signals, scenario.id).toEqual(
				scenario.spinetab ? ["status.mode"] : ['"baseline"'],
			);
			if (scenario.spinetab) {
				// Only settled modes are published; `sharing=off` comes from the query.
				expect(page, scenario.id).toMatch(
					/status\.mode !== "inactive" && status\.mode !== "starting"/,
				);
				expect(page, scenario.id).toMatch(/get\("sharing"\) === "off"/);
			}
		}
	});
});

describe("load mode gate", () => {
	it("correct modes on every build and load pass and record the check", () => {
		const gate = gateLoads(
			core,
			"vite",
			loads({ shared: "shared", local: "local" }),
			logs,
		);
		expect(gate.ok).toBe(true);
		if (!gate.ok) return;
		expect(gate.modeCheck.expected).toEqual({
			shared: "shared",
			local: "local",
		});
		for (const build of BUILDS) {
			expect(gate.modeCheck.observed[build]).toEqual({
				shared: { ready: "shared", settled: "shared" },
				local: { ready: "local", settled: "local" },
			});
		}
	});

	it("a baseline in its own mode passes", () => {
		const gate = gateLoads(
			baselineEmpty,
			"next",
			loads({ shared: "baseline", local: "baseline" }),
			logs,
		);
		expect(gate.ok).toBe(true);
	});

	it("a timeout (null ready) is not measured with its reason and diagnostics", () => {
		const timedOut = observation(null);
		const gate = gateLoads(
			core,
			"vite",
			loads(
				{ shared: "shared", local: "local" },
				{ build: "min", load: "shared", value: timedOut },
			),
			logs,
		);
		expect(gate.ok).toBe(false);
		if (gate.ok) return;
		const { failure } = gate;
		expect(failure.status).toBe("not-measured");
		expect(failure.error).toBe(
			'load mode check failed: min sharing=prefer expected "shared", timed out after 20 s with no __sizeReady',
		);
		expect(failure).not.toHaveProperty("minified");
		expect(failure.logs).toEqual(logs);
		expect(failure.modeCheck?.mismatches).toEqual([
			{
				build: "min",
				load: "shared",
				sharing: "prefer",
				expected: "shared",
				ready: null,
				settled: null,
			},
		]);
		expect(failure.modeCheck?.observed.min.shared).toEqual({
			ready: null,
			settled: null,
			readyError: "Timeout 20000ms exceeded.",
		});
		expect(failure.loads?.min.shared.requests).toEqual(timedOut.requests);
		expect(failure.loads?.min.shared.console).toEqual([
			"error: Failed to load resource: 404",
		]);
		// The gated failure feeds no row.
		const rows = deriveRows("vite", [core], { core: failure });
		expect(rows.metrics).toEqual({});
	});

	const wrong: Array<{
		build: "min" | "raw";
		load: "shared" | "local";
		value: string;
		sharing: string;
		expected: string;
	}> = [
		{
			build: "min",
			load: "shared",
			value: "local",
			sharing: "prefer",
			expected: "shared",
		},
		{
			build: "raw",
			load: "shared",
			value: "local",
			sharing: "prefer",
			expected: "shared",
		},
		{
			build: "min",
			load: "local",
			value: "shared",
			sharing: "off",
			expected: "local",
		},
		{
			build: "raw",
			load: "local",
			value: "shared",
			sharing: "off",
			expected: "local",
		},
		{
			build: "raw",
			load: "shared",
			value: "failed",
			sharing: "prefer",
			expected: "shared",
		},
	];
	for (const { build, load, value, sharing, expected } of wrong) {
		it(`${build} sharing=${sharing} reporting ${value} (expected ${expected}) is not measured`, () => {
			const gate = gateLoads(
				core,
				"vite",
				loads(
					{ shared: "shared", local: "local" },
					{ build, load, value: observation(value) },
				),
				logs,
			);
			expect(gate.ok).toBe(false);
			if (gate.ok) return;
			expect(gate.failure.error).toBe(
				`load mode check failed: ${build} sharing=${sharing} expected "${expected}", got "${value}"`,
			);
			expect(gate.failure.modeCheck?.mismatches).toHaveLength(1);
			expect(gate.failure.modeCheck?.mismatches[0]).toMatchObject({
				build,
				load,
				expected,
				ready: value,
			});
		});
	}

	it("a load that was ready in the right mode but settled in another is not measured", () => {
		const check = assertLoadModes(
			{
				min: {
					shared: { ready: "shared", settled: "local" },
					local: { ready: "local", settled: "local" },
				},
				raw: {
					shared: { ready: "shared", settled: "shared" },
					local: { ready: "local", settled: "local" },
				},
			},
			expectedModes(core),
		);
		expect(check).toMatchObject({
			ok: false,
			reason:
				'load mode check failed: min sharing=prefer expected "shared", was ready "shared" but settled "local"',
		});
	});

	it("every failing load is named, raw and min alike", () => {
		const check = assertLoadModes(
			{
				min: {
					shared: { ready: "local", settled: "local" },
					local: { ready: "local", settled: "local" },
				},
				raw: {
					shared: { ready: null, settled: null },
					local: { ready: "local", settled: "local" },
				},
			},
			expectedModes(websocket),
		);
		expect(check.ok).toBe(false);
		if (check.ok) return;
		expect(check.mismatches.map((m) => `${m.build}/${m.load}`)).toEqual([
			"min/shared",
			"raw/shared",
		]);
	});

	it("a Spinetab scenario reporting baseline, and a baseline reporting shared, are not measured", () => {
		expect(
			gateLoads(
				core,
				"vite",
				loads({ shared: "baseline", local: "baseline" }),
				logs,
			).ok,
		).toBe(false);
		expect(
			gateLoads(
				baselineEmpty,
				"vite",
				loads({ shared: "shared", local: "local" }),
				logs,
			).ok,
		).toBe(false);
		expect(
			gateLoads(
				baselineEmpty,
				"vite",
				loads(
					{ shared: "baseline", local: "baseline" },
					{ build: "raw", load: "local", value: observation(null) },
				),
				logs,
			).ok,
		).toBe(false);
	});

	it("checks all four build × load combinations", () => {
		expect(BUILDS).toEqual(["min", "raw"]);
		expect(LOADS).toEqual(["shared", "local"]);
	});
});

/** A measured scenario with the given Spinetab/total gzip per realm. */
const measured = (
	spinetab: { page: number; worker: number },
	total: { page: number; worker: number },
	fallbackInShared: string[] = [],
	offending: string[] = [],
): MeasuredScenario => ({
	minified: {
		realms: {
			page: { gzip: total.page, spinetabGzip: spinetab.page },
			worker: { gzip: total.worker, spinetabGzip: spinetab.worker },
			lazy: { gzip: 0, spinetabGzip: 0 },
		},
	},
	offending,
	fallbackInShared,
});

const preflight = selectScenarios("baseline-empty,core,websocket");
const good = (): Record<string, ScenarioOutcome> => ({
	"baseline-empty": measured(
		{ page: 0, worker: 0 },
		{ page: 60_000, worker: 100 },
	),
	core: measured(
		{ page: 12_511, worker: 13_069 },
		{ page: 72_000, worker: 13_900 },
	),
	websocket: measured(
		{ page: 15_000, worker: 16_493 },
		{ page: 75_000, worker: 17_000 },
	),
});

const failure = (
	id: string,
	reason = `load mode check failed: min sharing=prefer expected "shared", got "local"`,
): ScenarioOutcome => ({
	bundler: "vite",
	status: "not-measured",
	error: reason,
	logs: [`/work/vite/logs/${id}-min.log`],
});

describe("derived rows", () => {
	// These fixtures are a complete run of the three-scenario preflight
	// catalogue; unselected catalogue scenarios: size-compare.test.ts.
	it("all selected scenarios measured: every row measured, nothing not measured", () => {
		const rows = deriveRows("vite", preflight, good(), preflight);
		expect(rows.notMeasured).toEqual({});
		expect(rows.metrics).toEqual({
			"size.core.page.gzip.vite": 12_511,
			"size.core.worker.gzip.vite": 13_069,
			"size.core.absent.vite": 0,
			"size.core.incremental.gzip.vite": 25_580,
			"size.websocket.absent.vite": 0,
			"size.websocket.incremental.gzip.vite": 5_913,
			"size.websocket.attribution-agreement.vite":
				Math.abs(5_913 - 6_100) / 6_100,
			"size.fallback-downloads-in-shared.vite": 0,
		});
	});

	it("Next has no attribution-agreement row", () => {
		const rows = deriveRows("next", preflight, good(), preflight);
		expect(Object.keys(rows.metrics).sort()).toEqual([
			"size.core.absent.next",
			"size.core.incremental.gzip.next",
			"size.core.page.gzip.next",
			"size.core.worker.gzip.next",
			"size.fallback-downloads-in-shared.next",
			"size.websocket.absent.next",
			"size.websocket.incremental.gzip.next",
		]);
	});

	it("a wrong-mode core marks its rows, its dependants and the fallback row not measured", () => {
		const outcomes = { ...good(), core: failure("core") };
		const rows = deriveRows("vite", preflight, outcomes, preflight);
		const reason =
			'core not measured: load mode check failed: min sharing=prefer expected "shared", got "local"';
		expect(rows.metrics).toEqual({ "size.websocket.absent.vite": 0 });
		expect(rows.notMeasured).toEqual({
			"size.core.page.gzip.vite": reason,
			"size.core.worker.gzip.vite": reason,
			"size.core.absent.vite": reason,
			"size.core.incremental.gzip.vite": reason,
			"size.websocket.incremental.gzip.vite": reason,
			"size.websocket.attribution-agreement.vite": reason,
			"size.fallback-downloads-in-shared.vite": `Spinetab scenario(s) not measured: core (load mode check failed: min sharing=prefer expected "shared", got "local")`,
		});
	});

	it("a timed-out baseline is recorded and its dependant is not measured", () => {
		const outcomes = {
			...good(),
			"baseline-empty": failure(
				"baseline-empty",
				'load mode check failed: min sharing=prefer expected "baseline", timed out after 20 s with no __sizeReady',
			),
		};
		const rows = deriveRows("vite", preflight, outcomes, preflight);
		expect(rows.notMeasured["size.baseline-empty.baseline.vite"]).toMatch(
			/^baseline-empty not measured: load mode check failed: .*timed out/,
		);
		expect(rows.notMeasured["size.core.incremental.gzip.vite"]).toMatch(
			/^baseline-empty not measured/,
		);
		// Rows that do not use the baseline stay measured.
		expect(rows.metrics["size.core.page.gzip.vite"]).toBe(12_511);
		expect(rows.metrics["size.websocket.incremental.gzip.vite"]).toBe(5_913);
		expect(rows.metrics["size.fallback-downloads-in-shared.vite"]).toBe(0);
	});

	it("a failed build ({ error }) and a missing result are not measured", () => {
		const outcomes = {
			...good(),
			websocket: { error: "build or load failed: x" },
		};
		const rows = deriveRows("vite", preflight, outcomes);
		expect(rows.notMeasured["size.websocket.absent.vite"]).toBe(
			"websocket not measured: build or load failed: x",
		);
		const missing = deriveRows("vite", preflight, {
			...good(),
			websocket: undefined,
		});
		expect(missing.notMeasured["size.websocket.absent.vite"]).toBe(
			"websocket not measured: no result",
		);
	});

	it("an unselected base or core keeps its --only reason", () => {
		const rows = deriveRows("vite", selectScenarios("websocket"), {
			websocket: good().websocket,
		});
		expect(rows.notMeasured).toMatchObject({
			"size.core.page.gzip.vite": "core not measured: not selected (--only)",
			"size.websocket.incremental.gzip.vite": "base core not selected (--only)",
		});
		expect(rows.metrics["size.websocket.absent.vite"]).toBe(0);
	});

	it("offending sources are a measured absence count", () => {
		const outcomes = {
			...good(),
			websocket: measured(
				{ page: 15_000, worker: 16_493 },
				{ page: 75_000, worker: 17_000 },
				[],
				["peer:graphql-ws"],
			),
		};
		expect(
			deriveRows("vite", preflight, outcomes).metrics[
				"size.websocket.absent.vite"
			],
		).toBe(1);
	});
});

describe("fallback downloads in shared mode", () => {
	const entries = (outcomes: Record<string, ScenarioOutcome>) =>
		preflight
			.filter((scenario: SizeScenario) => scenario.spinetab)
			.map((scenario) => ({ id: scenario.id, outcome: outcomes[scenario.id] }));

	it("all selected Spinetab scenarios measured with no fallback download: measured 0", () => {
		expect(fallbackDownloadsMetric(entries(good()))).toEqual({ value: 0 });
	});

	it("one selected scenario failed: not measured naming it, though another succeeded", () => {
		const result = fallbackDownloadsMetric(
			entries({ ...good(), websocket: failure("websocket") }),
		);
		expect(result).toEqual({
			reason: `Spinetab scenario(s) not measured: websocket (load mode check failed: min sharing=prefer expected "shared", got "local")`,
		});
	});

	it("every failed scenario is named", () => {
		const result = fallbackDownloadsMetric(
			entries({
				...good(),
				core: { error: "build or load failed: a" },
				websocket: undefined,
			}),
		);
		expect(result).toEqual({
			reason:
				"Spinetab scenario(s) not measured: core (build or load failed: a); websocket (no result)",
		});
	});

	it("a non-zero download is a measured value for the budget to fail", () => {
		const outcomes = {
			...good(),
			websocket: measured(
				{ page: 15_000, worker: 16_493 },
				{ page: 75_000, worker: 17_000 },
				["/assets/local-a.js", "/assets/local-b.js"],
			),
		};
		expect(fallbackDownloadsMetric(entries(outcomes))).toEqual({ value: 2 });
		expect(
			deriveRows("vite", preflight, outcomes, preflight).metrics[
				"size.fallback-downloads-in-shared.vite"
			],
		).toBe(2);
	});

	it("no Spinetab scenario selected: not measured", () => {
		expect(fallbackDownloadsMetric([])).toEqual({
			reason: "no Spinetab scenario selected",
		});
		expect(
			deriveRows("vite", selectScenarios("baseline-empty"), {
				"baseline-empty": good()["baseline-empty"],
			}).notMeasured["size.fallback-downloads-in-shared.vite"],
		).toBe("no Spinetab scenario selected");
	});
});
