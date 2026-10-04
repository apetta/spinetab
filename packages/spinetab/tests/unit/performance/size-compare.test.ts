import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { BudgetRow } from "../../performance/lib/stats.ts";
import {
	SCENARIOS,
	selectScenarios,
} from "../../performance/size/catalogue.ts";
import {
	compareSizes,
	formatComparison,
	type SizesReport,
} from "../../performance/size/compare.ts";
import {
	BUNDLERS,
	deriveRows,
	isNotSelected,
	isPluginRow,
	type MeasuredScenario,
	NOT_SELECTED,
	type ScenarioOutcome,
	unselectedBundlerRows,
} from "../../performance/size/guard.ts";

// Every row must be measured or recorded as not measured with its reason.

// its reason ("not selected (--only)" for unselected scenarios), and the
// compare lists every metric, the not-selected rows and any budget row that
// neither run accounts for.

const budgets = JSON.parse(
	readFileSync(
		new URL("../../performance/budgets.json", import.meta.url),
		"utf8",
	),
) as { rows: BudgetRow[] };
// L1 size rows; the plugin rows (size.<id>.l3.*) are accounted for in
// size-generated.test.ts.
const sizeRows = budgets.rows.filter(
	(row) => row.id.startsWith("size.") && !isPluginRow(row.id),
);

const measured = (spinetab: number, gzip: number): MeasuredScenario => ({
	minified: {
		realms: {
			page: { gzip, spinetabGzip: spinetab },
			worker: { gzip, spinetabGzip: spinetab },
			lazy: { gzip: 0, spinetabGzip: 0 },
		},
	},
	offending: [],
	fallbackInShared: [],
});

const preflight = selectScenarios("baseline-empty,core,websocket");
const good = (): Record<string, ScenarioOutcome> => ({
	"baseline-empty": measured(0, 100),
	core: measured(1_000, 2_000),
	websocket: measured(1_500, 2_600),
});
const everything = () =>
	Object.fromEntries(
		SCENARIOS.map((scenario) => [scenario.id, measured(2_000, 3_000)]),
	);

describe("unselected scenarios are recorded, never dropped", () => {
	it("records every unselected scenario's rows as not selected (--only)", () => {
		const rows = deriveRows("vite", preflight, good());
		expect(NOT_SELECTED).toBe("not selected (--only)");
		expect(rows.notMeasured).toMatchObject({
			"size.sse.absent.vite": "sse not measured: not selected (--only)",
			"size.sse.incremental.gzip.vite":
				"sse not measured: not selected (--only)",
			"size.sse.attribution-agreement.vite":
				"sse not measured: not selected (--only)",
			"size.react.absent.vite": "react not measured: not selected (--only)",
			"size.react.incremental.gzip.vite":
				"react not measured: not selected (--only)",
			"size.baseline-ws.baseline.vite":
				"baseline-ws not measured: not selected (--only)",
		});
		// The selected scenarios keep their measured rows.
		expect(rows.metrics["size.websocket.absent.vite"]).toBe(0);
		expect(rows.metrics["size.core.page.gzip.vite"]).toBe(1_000);
	});

	it("never reports a partial fallback sum as measured", () => {
		const rows = deriveRows("next", preflight, good());
		expect(rows.metrics["size.fallback-downloads-in-shared.next"]).toBe(
			undefined,
		);
		const reason = rows.notMeasured["size.fallback-downloads-in-shared.next"];
		expect(reason).toMatch(/^Spinetab scenario\(s\) not selected \(--only\): /);
		expect(reason).toContain("sse");
		expect(reason).toContain("solid");
		expect(reason).not.toContain("websocket,");
	});

	it("accounts for every size budget row of both bundlers, whatever the selection", () => {
		for (const selection of [
			preflight,
			selectScenarios("websocket"),
			selectScenarios("baseline-empty"),
			[...SCENARIOS],
		]) {
			const accounted = new Set<string>();
			for (const bundler of BUNDLERS) {
				const rows = deriveRows(bundler, selection, everything());
				for (const id of [
					...Object.keys(rows.metrics),
					...Object.keys(rows.notMeasured),
				]) {
					accounted.add(id);
				}
			}
			const missing = sizeRows
				.map((row) => row.id)
				.filter((id) => !accounted.has(id));
			expect(missing, selection.map((s) => s.id).join(",")).toEqual([]);
		}
	});

	it("a complete selection has nothing not selected", () => {
		for (const bundler of BUNDLERS) {
			const rows = deriveRows(bundler, [...SCENARIOS], everything());
			expect(rows.notMeasured).toEqual({});
			expect(rows.metrics[`size.fallback-downloads-in-shared.${bundler}`]).toBe(
				0,
			);
		}
	});

	it("records an unselected bundler's rows as not selected (--bundlers)", () => {
		const rows = unselectedBundlerRows(["vite"]);
		const next = sizeRows
			.map((row) => row.id)
			.filter((id) => id.endsWith(".next"));
		for (const id of next) {
			expect(rows[id], id).toBe("bundler next not selected (--bundlers)");
		}
		expect(Object.keys(rows).some((id) => id.endsWith(".vite"))).toBe(false);
		expect(unselectedBundlerRows([...BUNDLERS])).toEqual({});
		expect(isNotSelected(rows["size.core.absent.next"] as string)).toBe(true);
	});

	it("refuses a selection outside the catalogue", () => {
		expect(() =>
			deriveRows("vite", preflight, good(), selectScenarios("core")),
		).toThrow(/not in the catalogue: baseline-empty, websocket/);
	});
});

describe("size compare", () => {
	const previous: SizesReport = {
		run: "old",
		tarball: { sha256: "1".repeat(64) },
		metrics: {
			"size.core.absent.next": 0,
			"size.core.page.gzip.next": 6_000,
			"size.sse.attribution-agreement.vite": 0.002,
		},
		notMeasured: {},
		scenarios: {
			core: {
				next: {
					minified: {
						realms: {
							page: { gzip: 147_000 },
							worker: { gzip: 20_000 },
							lazy: { gzip: 240 },
						},
					},
				},
			},
		},
	};
	const current: SizesReport = {
		run: "new",
		tarball: { sha256: "2".repeat(64) },
		metrics: {
			"size.core.absent.next": 1,
			"size.core.page.gzip.next": 6_100,
			"size.sse.attribution-agreement.vite": 0.003,
			"size.fallback-downloads-in-shared.vite": 0,
			"size.core.differential.gzip.next": 99,
		},
		notMeasured: {
			"size.react.absent.vite": "react not measured: not selected (--only)",
			"size.websocket.absent.vite": "websocket not measured: build failed",
		},
		scenarios: {
			core: {
				next: {
					minified: {
						realms: {
							page: { gzip: 147_445 },
							worker: { gzip: 20_296 },
							lazy: { gzip: 242 },
						},
					},
				},
			},
			websocket: { next: { status: "not-measured", error: "build failed" } },
		},
	};

	it("lists every metric and budget row with its verdict", () => {
		const comparison = compareSizes(current, sizeRows, previous);
		const byId = new Map(comparison.rows.map((row) => [row.id, row]));
		expect(byId.get("size.core.absent.next")).toMatchObject({
			previous: 0,
			current: 1,
			delta: 1,
			comparator: "==",
			target: 0,
			status: "fail",
		});
		expect(byId.get("size.sse.attribution-agreement.vite")).toMatchObject({
			previous: 0.002,
			current: 0.003,
			status: "pass",
		});
		expect(byId.get("size.fallback-downloads-in-shared.vite")).toMatchObject({
			previous: null,
			current: 0,
			status: "pass",
		});
		expect(byId.get("size.core.differential.gzip.next")).toMatchObject({
			current: 99,
			status: "no budget row",
		});
		expect(byId.get("size.react.absent.vite")).toMatchObject({
			current: null,
			status: "not selected",
			reason: "react not measured: not selected (--only)",
		});
		expect(byId.get("size.websocket.absent.vite")).toMatchObject({
			status: "not measured",
			reason: "websocket not measured: build failed",
		});
		// Every size budget row appears once.
		for (const row of sizeRows) expect(byId.has(row.id), row.id).toBe(true);
	});

	it("separates not-selected, not-measured and unaccounted rows", () => {
		const comparison = compareSizes(current, sizeRows, previous);
		expect(comparison.notSelected).toEqual(["size.react.absent.vite"]);
		expect(comparison.notMeasured).toEqual([
			{
				id: "size.websocket.absent.vite",
				reason: "websocket not measured: build failed",
			},
		]);
		expect(comparison.unaccounted).toContain("size.solid.absent.next");
		expect(comparison.unaccounted).not.toContain("size.core.absent.next");
		expect(comparison.unaccounted).not.toContain("size.react.absent.vite");
		expect(comparison.failing).toEqual(["size.core.absent.next"]);
	});

	it("lists realm gzip per scenario and bundler, with not-measured scenarios", () => {
		const comparison = compareSizes(current, sizeRows, previous);
		expect(comparison.realms).toEqual([
			{
				scenario: "core",
				bundler: "next",
				realm: "lazy",
				previous: 240,
				current: 242,
			},
			{
				scenario: "core",
				bundler: "next",
				realm: "page",
				previous: 147_000,
				current: 147_445,
			},
			{
				scenario: "core",
				bundler: "next",
				realm: "worker",
				previous: 20_000,
				current: 20_296,
			},
		]);
		expect(comparison.scenariosNotMeasured).toEqual([
			{ scenario: "websocket", bundler: "next", reason: "build failed" },
		]);
	});

	it("formats every section, failing rows first", () => {
		const text = formatComparison(compareSizes(current, sizeRows, previous));
		expect(text).toContain("new run new (tarball 222222222222)");
		expect(text).toContain("old run old (tarball 111111111111)");
		expect(text).toMatch(/Failing rows \(1\): size\.core\.absent\.next/);
		expect(text).toMatch(
			/size\.core\.absent\.next\s+0\s+1\s+\+1\s+== 0\s+fail/,
		);
		expect(text).toContain("Not selected (1):");
		expect(text).toContain("Not measured (1):");
		expect(text).toMatch(/Budget rows neither measured nor recorded \(\d+\):/);
		expect(text).toContain("size.solid.absent.next");
	});

	it("works without a previous run", () => {
		const comparison = compareSizes(current, sizeRows);
		expect(
			comparison.rows.find((row) => row.id === "size.core.absent.next"),
		).toMatchObject({
			previous: null,
			current: 1,
			delta: null,
			status: "fail",
		});
	});
});
