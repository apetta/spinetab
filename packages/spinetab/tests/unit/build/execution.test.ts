import { describe, expect, it } from "vitest";
import {
	type ExecutionInventory,
	executionFailures,
} from "../../package/consumers/execution.ts";

const run = (): ExecutionInventory => ({
	runId: "fresh",
	candidate: "candidate",
	complete: true,
	status: "passed",
	tests: [
		{
			id: "a",
			project: "chromium",
			cell: "vite-prod",
			title: "sharing",
			status: "passed",
			explicitSkip: false,
		},
	],
});
const record = () => ({
	runId: "fresh",
	project: "chromium",
	cell: "vite-prod",
	candidate: { sha256: "candidate" },
});
const extraTest = (status: string, explicitSkip = false) => ({
	id: "b",
	project: "chromium",
	cell: "vite-prod",
	title: "cleanup",
	status,
	explicitSkip,
});

describe("consumer execution acceptance", () => {
	it("accepts a completed invocation with its selected cell and candidate", () => {
		expect(executionFailures(run(), [record()])).toEqual([]);
	});
	it("cannot fill a failed beforeAll or absent cell with a historic green row", () => {
		expect(executionFailures(run(), [])).toContain(
			"chromium/vite-prod: missing current-run matrix record",
		);
		expect(executionFailures(run(), [{ ...record(), runId: "old" }])).toContain(
			"chromium/vite-prod: stale run or candidate",
		);
		expect(
			executionFailures(run(), [{ ...record(), candidate: { sha256: "old" } }]),
		).toContain("chromium/vite-prod: stale run or candidate");
	});
	it.each([
		"not-run",
		"failed",
		"timedOut",
		"skipped",
	])("rejects %s even beside another passed test in the same cell", (status) => {
		const inventory = run();
		inventory.tests.push(extraTest(status));
		expect(executionFailures(inventory, [record()])).toContain(
			`chromium/cleanup: ${status}`,
		);
	});
	it("records an intentional engine-independent skip without treating an unrun test as that skip", () => {
		const inventory = run();
		const extra = { ...extraTest("skipped", true), title: "static graph" };
		inventory.tests.push(extra);
		expect(executionFailures(inventory, [record()])).toEqual([]);
		extra.status = "not-run";
		expect(executionFailures(inventory, [record()])).toContain(
			"chromium/static graph: not-run",
		);
	});
	it("rejects an unfinished run, empty selection and an unselected cell", () => {
		expect(
			executionFailures({ ...run(), complete: false }, [record()]),
		).toContain("consumer execution fresh is incomplete");
		expect(executionFailures({ ...run(), tests: [] }, [])).toContain(
			"consumer execution selected no tests",
		);
		expect(
			executionFailures(run(), [{ ...record(), project: "firefox" }]),
		).toContain("firefox/vite-prod: not selected in this execution");
	});
});
