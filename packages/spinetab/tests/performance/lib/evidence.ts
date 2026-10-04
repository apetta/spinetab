import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Evidence layout: raw per-run records under
 * `docs/evidence/perf/<run>/raw/` (git-ignored, local), large artefacts
 * (heap snapshots, reporter output) under `packages/spinetab/test-results/perf/<run>/`.
 * Node-runnable (erasable TypeScript, no Playwright import).
 */

export const packageRoot = fileURLToPath(new URL("../../../", import.meta.url));
export const repoRoot = join(packageRoot, "..", "..");

export type Profile = "pinned" | "smoke";

export function profile(): Profile {
	return process.env.SPINETAB_PERF_PROFILE === "smoke" ? "smoke" : "pinned";
}

function shortSha(): string {
	try {
		return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
			cwd: repoRoot,
			encoding: "utf8",
		}).trim();
	} catch {
		return "nogit";
	}
}

function today(): string {
	const now = new Date();
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
}

let cachedRun: string | undefined;

/** `SPINETAB_PERF_RUN`, else `<YYYYMMDD>-<shortsha>`. */
export function runId(): string {
	cachedRun ??= process.env.SPINETAB_PERF_RUN || `${today()}-${shortSha()}`;
	if (!/^[A-Za-z0-9._-]+$/.test(cachedRun)) {
		throw new Error(`Invalid run id "${cachedRun}": use [A-Za-z0-9._-]`);
	}
	return cachedRun;
}

/** Repetition label (`SPINETAB_PERF_REP`, default 01). */
export function rep(): string {
	const value = process.env.SPINETAB_PERF_REP ?? "01";
	if (!/^[0-9]{1,3}$/.test(value)) {
		throw new Error(`Invalid SPINETAB_PERF_REP "${value}"`);
	}
	return value.padStart(2, "0");
}

export const evidenceDir = (run = runId()) =>
	join(repoRoot, "docs", "evidence", "perf", run);
export const rawDir = (run = runId()) => join(evidenceDir(run), "raw");
export const artefactDir = (run = runId()) =>
	join(packageRoot, "test-results", "perf", run);

export function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, "\t")}\n`);
}

export function readJson<T>(path: string): T | undefined {
	if (!existsSync(path)) return undefined;
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** Metric values keyed by budget row id; an array holds one run's trials. */
export type Metrics = Record<string, number | number[]>;

export interface RawRecord {
	schema: 1;
	run: string;
	rep: string;
	profile: Profile;
	project: string;
	scenario: string;
	config: string;
	/** Playwright `repeatEachIndex` (0 without `--repeat-each`). */
	repeat?: number;
	writtenAt: string;
	metrics: Metrics;
	/** Rows this record explicitly could not measure, with reasons. */
	notMeasured?: Record<string, string>;
	detail: unknown;
}

/**
 * Write one raw record: `raw/<scenario>-<config>-<project>-rep<NN>.json`.
 * Existing files are replaced (a rerun of the same rep supersedes it).
 */
export function writeRaw(
	record: Omit<RawRecord, "schema" | "run" | "rep" | "profile" | "writtenAt">,
): string {
	const full: RawRecord = {
		schema: 1,
		run: runId(),
		rep: rep(),
		profile: profile(),
		writtenAt: new Date().toISOString(),
		...record,
	};
	const safe = (value: string) => value.replace(/[^A-Za-z0-9._-]+/g, "_");
	const repeat = record.repeat ? `-r${record.repeat}` : "";
	const path = join(
		rawDir(),
		`${safe(record.scenario)}-${safe(record.config)}-${safe(record.project)}-rep${full.rep}${repeat}.json`,
	);
	writeJson(path, full);
	return path;
}
