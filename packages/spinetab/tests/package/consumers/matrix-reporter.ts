import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
	FullConfig,
	FullResult,
	Reporter,
	Suite,
} from "@playwright/test/reporter";
import type { ExecutionInventory } from "./execution.ts";
import { consumerRunId, matrixDir, packageRoot } from "./paths.ts";
import { assertFreshPack } from "./prepare.ts";

export default class MatrixReporter implements Reporter {
	private suite: Suite | undefined;
	private inventory: ExecutionInventory | undefined;
	private error: string | undefined;

	printsToStdio(): boolean {
		return false;
	}

	onBegin(_config: FullConfig, suite: Suite): void {
		try {
			this.suite = suite;
			const pack = assertFreshPack("consumer execution inventory");
			this.inventory = {
				runId: consumerRunId(),
				candidate: pack.sha256,
				complete: false,
				status: "running",
				tests: [],
			};
			const dir = matrixDir();
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "execution.json"), this.serialise(), {
				flag: "wx",
			});
			writeFileSync(
				join(packageRoot, "test-results/consumers/latest-run.json"),
				JSON.stringify({ runId: this.inventory.runId }),
			);
		} catch (error) {
			this.error = String(error);
			process.env.SPINETAB_CONSUMERS_EXECUTION_ERROR = this.error;
			console.error(this.error);
		}
	}

	private serialise(): string {
		if (!this.inventory || !this.suite)
			throw Error("No consumer execution inventory");
		this.inventory.tests = this.suite.allTests().map((test) => ({
			id: test.id,
			project: test.parent.project()?.name ?? "unknown",
			cell:
				test.annotations.find((a) => a.type === "consumer-cell")?.description ??
				null,
			title: test.title,
			status: test.results.at(-1)?.status ?? "not-run",
			explicitSkip: test.annotations.some(
				(a) => a.type === "skip" && Boolean(a.description),
			),
		}));
		return `${JSON.stringify(this.inventory, null, "\t")}\n`;
	}

	async onEnd(result: FullResult): Promise<{ status: "failed" } | undefined> {
		if (this.error || !this.inventory) return { status: "failed" };
		try {
			this.inventory.complete = true;
			this.inventory.status = result.status;
			writeFileSync(join(matrixDir(), "execution.json"), this.serialise());
		} catch (error) {
			console.error(String(error));
			return { status: "failed" };
		}
		return undefined;
	}
}
