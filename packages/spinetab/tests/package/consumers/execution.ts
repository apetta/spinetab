export interface ExecutionInventory {
	runId: string;
	candidate: string;
	complete: boolean;
	status: string;
	tests: Array<{
		id: string;
		project: string;
		cell: string | null;
		title: string;
		status: string;
		explicitSkip: boolean;
	}>;
}

/** Missing hooks, unrun serial tests and stale green rows all fail closed. */
export function executionFailures(
	run: ExecutionInventory,
	records: ReadonlyArray<{
		runId?: string;
		project: string;
		cell: string;
		candidate: { sha256: string };
	}>,
): string[] {
	const failures: string[] = [];
	if (!run.complete || run.status !== "passed")
		failures.push(
			`consumer execution ${run.runId} is ${run.complete ? run.status : "incomplete"}`,
		);
	if (run.tests.length === 0)
		failures.push("consumer execution selected no tests");
	for (const test of run.tests) {
		if (
			test.status !== "passed" &&
			!(test.status === "skipped" && test.explicitSkip)
		)
			failures.push(`${test.project}/${test.title}: ${test.status}`);
	}
	const expected = new Set(
		run.tests.flatMap((test) =>
			test.cell ? [`${test.project}/${test.cell}`] : [],
		),
	);
	const actual = new Set(
		records.map((record) => `${record.project}/${record.cell}`),
	);
	for (const key of expected)
		if (!actual.has(key))
			failures.push(`${key}: missing current-run matrix record`);
	for (const record of records) {
		if (record.runId !== run.runId || record.candidate.sha256 !== run.candidate)
			failures.push(`${record.project}/${record.cell}: stale run or candidate`);
		if (!expected.has(`${record.project}/${record.cell}`))
			failures.push(
				`${record.project}/${record.cell}: not selected in this execution`,
			);
	}
	return failures;
}
