import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PORTS } from "./catalogue.ts";
import { type Readiness, startCell } from "./launch.ts";
import { evidenceDir } from "./paths.ts";
import { assertFreshPack } from "./prepare.ts";

/**
 * Clean-start gate: repeated `next dev` starts of packed
 * Next consumers under the strict readiness rule (any 5xx fails at once,
 * every status and the first 4 KiB of each >= 400 body recorded, Next's
 * development log and trace archived on failure).
 *
 * node tests/package/consumers/clean-start.ts [--subject <id>[,<id>]] [--runs <n>]
 *
 * Run it on the frozen candidate after `consumers:prepare` (a fresh install
 * of the tarball), with ports 4641/4741 free and no dist watcher. A cold
 * start removes `<distDir>/dev` first; the warm series primes once, then
 * restarts over the kept `.next/dev`. Writes
 * `test-results/consumers/<run>/clean-start/summary.json`; exits 1 when a
 * plugin subject answered a 5xx or failed to start. A 5xx on a plugin
 * subject only is a release blocker; the no-plugin control at a similar rate
 * is a Next 16.3.6 limitation for root to decide.
 */
export interface Subject {
	id: string;
	consumer: string;
	runs: number;
	warm: boolean;
	plugin: boolean;
	fromRoot?: boolean;
	env?: Record<string, string>;
}

export const SUBJECTS: readonly Subject[] = [
	{
		id: "next-app-cold",
		consumer: "next-app",
		runs: 20,
		warm: false,
		plugin: true,
	},
	{
		id: "next-app-warm",
		consumer: "next-app",
		runs: 10,
		warm: true,
		plugin: true,
	},
	{
		id: "next-monorepo-from-root-cold",
		consumer: "next-monorepo",
		runs: 10,
		warm: false,
		plugin: true,
		fromRoot: true,
		env: { CONSUMER_PLUGIN_DIR: "1" },
	},
	{
		id: "next-ai-control-cold",
		consumer: "next-ai",
		runs: 10,
		warm: false,
		plugin: false,
	},
];

export interface StartResult {
	subject: string;
	run: number;
	kind: "prime" | "cold" | "warm";
	ok: boolean;
	/** Every status the readiness probe saw, in order. */
	statuses: number[];
	/** The first answered request (the page's first compile), if any. */
	first: { status: number; ms: number } | null;
	error: string | null;
}

/** One start's row from its readiness record (or its failure). */
export function startResult(
	base: Pick<StartResult, "subject" | "run" | "kind">,
	readiness: Readiness | null,
	error: string | null,
): StartResult {
	const answered = (readiness?.attempts ?? []).filter(
		(attempt) => attempt.status !== undefined,
	);
	const first = answered[0];
	return {
		...base,
		ok: error === null,
		statuses: answered.map((attempt) => attempt.status as number),
		first:
			first?.status === undefined
				? null
				: { status: first.status, ms: first.ms ?? -1 },
		error,
	};
}

/** Per subject: starts, failures and 5xx answers; plugin subjects gate. */
export function summarise(
	subjects: readonly Subject[],
	results: StartResult[],
) {
	const rows = subjects.map((subject) => {
		const mine = results.filter(
			(result) => result.subject === subject.id && result.kind !== "prime",
		);
		const serverErrors = mine.filter((result) =>
			result.statuses.some((status) => status >= 500),
		).length;
		const failed = mine.filter((result) => !result.ok).length;
		return {
			subject: subject.id,
			plugin: subject.plugin,
			starts: mine.length,
			failed,
			serverErrors,
			firstMs: mine.map((result) => result.first?.ms ?? null),
		};
	});
	const pass = rows.every(
		(row) => !row.plugin || (row.failed === 0 && row.serverErrors === 0),
	);
	return { pass, rows };
}

async function gate(options: {
	only?: string[];
	runs?: number;
}): Promise<boolean> {
	const record = assertFreshPack("consumers:clean-start");
	const out = join(
		evidenceDir(
			process.env.SPINETAB_CONSUMERS_RUN_ID ?? record.distHash.slice(0, 12),
		),
		"clean-start",
	);
	mkdirSync(out, { recursive: true });
	const subjects = SUBJECTS.filter(
		(subject) => !options.only || options.only.includes(subject.id),
	);
	const results: StartResult[] = [];
	for (const subject of subjects) {
		const runs = options.runs ?? subject.runs;
		const kinds: StartResult["kind"][] = subject.warm
			? ["prime", ...Array<"warm">(runs).fill("warm")]
			: Array<"cold">(runs).fill("cold");
		for (const [index, kind] of kinds.entries()) {
			const base = { subject: subject.id, run: index, kind };
			let readiness: Readiness | null = null;
			let error: string | null = null;
			try {
				const cell = await startCell({
					id: `${subject.id}-${index}`,
					consumer: subject.consumer,
					bundler: "next",
					mode: "dev",
					frontPort: PORTS.next.dev,
					evidence: join(out, subject.id, `start-${index}`),
					warm: kind === "warm",
					...(subject.fromRoot ? { fromRoot: true } : {}),
					...(subject.env ? { env: subject.env } : {}),
				});
				readiness = cell.readiness;
				await cell.stop();
			} catch (caught) {
				error = caught instanceof Error ? caught.message : String(caught);
			}
			const result = startResult(base, readiness, error);
			results.push(result);
			console.log(
				`${subject.id} ${kind} ${index}: ${result.ok ? "ok" : "FAILED"} statuses [${result.statuses.join(", ")}] first ${result.first ? `${result.first.status} in ${result.first.ms} ms` : "none"}`,
			);
		}
	}
	const summary = summarise(subjects, results);
	writeFileSync(
		join(out, "summary.json"),
		`${JSON.stringify({ candidate: record.sha256, ...summary, results }, null, "\t")}\n`,
	);
	assertFreshPack("consumers:clean-start (end)");
	return summary.pass;
}

const isMain =
	process.argv[1] !== undefined &&
	fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
	const args = process.argv.slice(2);
	const value = (flag: string) => {
		const index = args.indexOf(flag);
		return index >= 0 ? args[index + 1] : undefined;
	};
	const only = value("--subject")?.split(",").filter(Boolean);
	const runs = value("--runs");
	try {
		const pass = await gate({
			...(only ? { only } : {}),
			...(runs ? { runs: Number(runs) } : {}),
		});
		process.exitCode = pass ? 0 : 1;
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}
