import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { BudgetRow } from "../../performance/lib/stats.ts";
import { SCENARIOS } from "../../performance/size/catalogue.ts";

const budgets = JSON.parse(
	readFileSync(
		new URL("../../performance/budgets.json", import.meta.url),
		"utf8",
	),
) as { rows: BudgetRow[] };

const page = (id: string) =>
	readFileSync(
		new URL(`../../performance/size/scenarios/${id}/page.ts`, import.meta.url),
		"utf8",
	);

/** Names a page imports from `spinetab/react`, as written. */
const reactImports = (text: string) =>
	[
		...text.matchAll(/import\s*\{([^}]*)\}\s*from\s*"spinetab\/react"/g),
	].flatMap((match) =>
		(match[1] ?? "")
			.split(",")
			.map((name) => name.trim())
			.filter(Boolean),
	);

describe("the React size scenario measures useLive (V-2)", () => {
	it("imports useLive, and only useLive, from spinetab/react", () => {
		const hooks = Object.fromEntries(
			SCENARIOS.filter((scenario) => scenario.spinetab)
				.map((scenario): [string, string[]] => [
					scenario.id,
					reactImports(page(scenario.id)),
				])
				.filter(([, names]) => names.length > 0),
		);
		expect(hooks).toEqual({ react: ["useLive"] });
	});

	it("renders everything useLive returns, so nothing is optimised away", () => {
		const text = page("react");
		expect(text).toMatch(
			/const \{ data, error, status, needsReconcile \} = useLive\(/,
		);
		expect(text).toContain("error ? error.code : JSON.stringify(data ?? null)");
		expect(text).toContain('needsReconcile ? "needed" : "no"');
		expect(text).toContain("status.connection.state");
		expect(text).toContain('name: "size-react"');
	});

	it("keeps its catalogue entry and budget rows: the React rows are the useLive check", () => {
		expect(SCENARIOS.find((scenario) => scenario.id === "react")).toEqual({
			id: "react",
			kind: "helper",
			subpaths: [
				".",
				"runtime",
				"worker",
				"react",
				"websocket",
				"websocket/runtime",
			],
			peers: ["react", "react-dom"],
			base: "websocket",
			spinetab: true,
			target: "page",
		});
		expect(
			budgets.rows
				.filter((row) => row.id.startsWith("size.react."))
				.map((row) => [row.id, row.comparator, row.target]),
		).toEqual([
			["size.react.incremental.gzip.vite", "<=", 3072],
			["size.react.absent.vite", "==", 0],
			["size.react.incremental.gzip.next", "<=", 3072],
			["size.react.absent.next", "==", 0],
		]);
	});
});
