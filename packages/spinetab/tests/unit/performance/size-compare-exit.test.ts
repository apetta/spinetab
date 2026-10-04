import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { BudgetRow } from "../../performance/lib/stats.ts";
import {
	compareSizes,
	formatComparison,
	type SizesReport,
} from "../../performance/size/compare.ts";

// Incomplete size runs exit non-zero; budget failures belong to the aggregate gate.

const budgets = JSON.parse(
	readFileSync(
		new URL("../../performance/budgets.json", import.meta.url),
		"utf8",
	),
) as { rows: BudgetRow[] };
const sizeRows = budgets.rows.filter((row) => row.id.startsWith("size."));
const cli = fileURLToPath(
	new URL("../../performance/size/compare.ts", import.meta.url),
);

/** Every size budget row measured (0), nothing recorded as not measured. */
const complete = (): SizesReport => ({
	run: "complete",
	metrics: Object.fromEntries(sizeRows.map((row) => [row.id, 0])),
	notMeasured: {},
	scenarios: {
		core: { vite: { minified: { realms: { page: { gzip: 100 } } } } },
	},
});

const without = (report: SizesReport, id: string): SizesReport => {
	const metrics = { ...report.metrics };
	delete metrics[id];
	return { ...report, metrics };
};

function runCli(report: SizesReport) {
	const dir = mkdtempSync(join(tmpdir(), "spinetab-size-compare-"));
	try {
		const file = join(dir, "sizes.json");
		writeFileSync(file, JSON.stringify(report));
		return spawnSync(process.execPath, [cli, "--new", file], {
			encoding: "utf8",
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const incomplete: Array<[string, () => SizesReport]> = [
	[
		"a row not selected",
		() => ({
			...without(complete(), "size.react.absent.vite"),
			notMeasured: {
				"size.react.absent.vite": "react not measured: not selected (--only)",
			},
		}),
	],
	[
		"a row not measured",
		() => ({
			...without(complete(), "size.core.absent.next"),
			notMeasured: {
				"size.core.absent.next": "core not measured: build failed",
			},
		}),
	],
	[
		"a budget row neither measured nor recorded",
		() => without(complete(), "size.solid.absent.next"),
	],
	[
		"a scenario without a minified result",
		() => ({
			...complete(),
			scenarios: {
				websocket: { next: { status: "not-measured", error: "build failed" } },
			},
		}),
	],
];

describe("size compare completeness and exit status (V-3)", () => {
	it("a complete run is complete, whatever the budget verdicts", () => {
		const report = complete();
		const failing = { ...report.metrics, "size.core.absent.vite": 3 };
		const comparison = compareSizes({ ...report, metrics: failing }, sizeRows);
		expect(comparison.failing).toContain("size.core.absent.vite");
		expect(comparison.complete).toBe(true);
		expect(formatComparison(comparison)).toMatch(/^Complete run: yes\.$/m);
	});

	for (const [what, report] of incomplete) {
		it(`${what} makes the run incomplete`, () => {
			const comparison = compareSizes(report(), sizeRows);
			expect(comparison.complete).toBe(false);
			expect(formatComparison(comparison)).toMatch(
				/^Complete run: no \(\d+ not selected, \d+ not measured, \d+ budget rows neither measured nor recorded, \d+ scenarios without a minified result\); the compare exits 1\.$/m,
			);
		});
	}

	it("the CLI exits 1 for each incomplete run and 0 for a complete one", () => {
		const results = incomplete.map(([what, report]) => ({
			what,
			result: runCli(report()),
		}));
		const done = runCli(complete());
		expect(
			results.map(({ what, result }) => `${what}: ${result.status}`),
		).toEqual(incomplete.map(([what]) => `${what}: 1`));
		expect(done.status, done.stderr).toBe(0);
		expect(done.stdout).toMatch(/^Complete run: yes\.$/m);
		for (const { what, result } of results) {
			expect(result.stdout, what).toMatch(/^Complete run: no \(/m);
			// The report is still written in full.
			expect(result.stdout, what).toContain(
				"## Every metric and size budget row",
			);
		}
	});
});
