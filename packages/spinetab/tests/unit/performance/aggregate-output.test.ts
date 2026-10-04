import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { packageRoot, repoRoot } from "../../performance/lib/evidence.ts";

describe("performance aggregation output", () => {
	it("writes passing and failing summaries without changing budget definitions", () => {
		const budgetsPath = join(packageRoot, "tests/performance/budgets.json");
		const before = readFileSync(budgetsPath, "utf8");
		const base = join(repoRoot, "docs/evidence/perf");
		mkdirSync(base, { recursive: true });
		const dir = mkdtempSync(join(base, "aggregate-output-"));
		try {
			writeFileSync(
				join(dir, "environment.json"),
				JSON.stringify({ profile: "smoke" }),
			);
			mkdirSync(join(dir, "raw"));
			writeFileSync(
				join(dir, "raw/smoke.json"),
				JSON.stringify({
					schema: 1,
					run: basename(dir),
					rep: "01",
					profile: "smoke",
					project: "chromium-perf",
					scenario: "aggregate-output",
					config: "synthetic",
					writtenAt: new Date().toISOString(),
					metrics: {},
					detail: {},
				}),
			);
			for (const value of [0, 1]) {
				writeFileSync(
					join(dir, "sizes.json"),
					JSON.stringify({ metrics: { "size.core.absent.vite": value } }),
				);
				const result = spawnSync(
					process.execPath,
					[
						join(packageRoot, "tests/performance/aggregate.ts"),
						"--run",
						basename(dir),
					],
					{ encoding: "utf8", timeout: 10_000 },
				);
				expect(result.error).toBeUndefined();
				expect(result.status, result.stdout + result.stderr).toBe(value);
				const summary = JSON.parse(
					readFileSync(join(dir, "summary.json"), "utf8"),
				) as { rows: Array<{ id: string; status: string }> };
				expect(
					summary.rows.find((row) => row.id === "size.core.absent.vite")
						?.status,
				).toBe(value === 0 ? "pass" : "fail");
				expect(readFileSync(join(dir, "summary.md"), "utf8")).toContain(
					"size.core.absent.vite",
				);
				expect(readFileSync(budgetsPath, "utf8")).toBe(before);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 30_000);
});
