import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ExecutionInventory, executionFailures } from "./execution.ts";
import { consumerRunId, evidenceDir, matrixDir, packageRoot } from "./paths.ts";

/**
 * Compatibility matrix feed. Each
 * Playwright cell writes `test-results/consumers/matrix/<project>-<cell>.json`;
 * `node matrix.ts` merges them into `matrix.json` and `matrix.md` and
 * reconciles each manifest peer range's lower bound with the tested versions.
 * Representative app reports are added as one row per app and engine.
 */

export interface MatrixRecord {
	runId?: string;
	cell: string;
	project: string;
	consumer: string;
	bundler: { name: string; version: string | null };
	mode: string;
	variant: string;
	browser: { name: string; version: string };
	peers: Array<{ name: string; version: string | null; min: boolean }>;
	candidate: {
		sha256: string;
		distHash: string;
		gitHead: string;
		dirty: boolean;
		sourceHash: string;
	};
	command: {
		build: string[] | null;
		serve: string[];
		env: Record<string, string>;
	};
	evidence: string;
	sizes: {
		emitted: Record<string, { raw: number; gzip: number; files: number }>;
		downloaded: Record<string, number>;
	};
	treeShaking: "on" | "off" | "not-disableable";
	pass: boolean;
	blocked: string | null;
	counters: unknown;
	notes: string[];
}

export interface PeerReconciliation {
	peer: string;
	range: string;
	lowerBound: string | null;
	tested: string[];
	status: "min-tested" | "below-tested" | "not-in-matrix";
}

/** One representative app report, per engine. */
export interface AppRow {
	app: string;
	browser: string;
	file: string;
	candidate: string | null;
	connections: { shared: number | null; perTab: number | null };
	recovery: {
		samples: number;
		median: number | null;
		p95: number | null;
		/** app-http: upstream responses in the recovery run. */
		streams: number | null;
	};
	fallback: string | null;
}

export const appsDir = () => join(evidenceDir(consumerRunId()), "apps");

const APP_REPORT = /^app-(.+)-(chromium|firefox|webkit)\.json$/;

/**
 * Per-engine app reports in `dir` (not `archive/`). The engine comes from the
 * file name; an older engine-less `app-<name>.json` is not read.
 */
export function readAppReports(dir: string = appsDir()): AppRow[] {
	if (!existsSync(dir)) return [];
	const rows: AppRow[] = [];
	for (const file of readdirSync(dir).sort()) {
		const match = APP_REPORT.exec(file);
		if (!match) continue;
		const report = JSON.parse(readFileSync(join(dir, file), "utf8")) as {
			app?: string;
			candidate?: string;
			connections?: { shared?: number; perTab?: number };
			recoveryLatencyMs?: {
				samples?: number[];
				median?: number | null;
				p95?: number | null;
			};
			recovery?: { streams?: number };
			fallbackReasons?: Record<string, string | null>;
		};
		rows.push({
			app: report.app ?? (match[1] as string),
			browser: match[2] as string,
			file,
			candidate: report.candidate ?? null,
			connections: {
				shared: report.connections?.shared ?? null,
				perTab: report.connections?.perTab ?? null,
			},
			recovery: {
				samples: report.recoveryLatencyMs?.samples?.length ?? 0,
				median: report.recoveryLatencyMs?.median ?? null,
				p95: report.recoveryLatencyMs?.p95 ?? null,
				streams: report.recovery?.streams ?? null,
			},
			fallback: report.fallbackReasons?.["worker-404"] ?? null,
		});
	}
	return rows;
}

export function readRecords(dir: string = matrixDir()): MatrixRecord[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter(
			(file) =>
				file.endsWith(".json") &&
				file !== "matrix.json" &&
				file !== "execution.json",
		)
		.sort()
		.map(
			(file) =>
				JSON.parse(readFileSync(join(dir, file), "utf8")) as MatrixRecord,
		);
}

/** Lowest version any alternative of a range admits (`^16.0.0 || ^17.0.0` → 16.0.0). */
export function lowerBound(range: string): string | null {
	const bounds = range
		.split("||")
		.map((part) => /(\d+)\.(\d+)\.(\d+)/.exec(part.trim()))
		.filter((match): match is RegExpExecArray => match !== null)
		.map((match) => `${match[1]}.${match[2]}.${match[3]}`);
	if (bounds.length === 0) return null;
	return bounds.sort(compareVersions)[0] ?? null;
}

export function compareVersions(left: string, right: string): number {
	const a = left.split(/[.-]/).map(Number);
	const b = right.split(/[.-]/).map(Number);
	for (let index = 0; index < 3; index += 1) {
		const difference = (a[index] ?? 0) - (b[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return 0;
}

export function reconcilePeers(
	peerDependencies: Record<string, string>,
	records: readonly MatrixRecord[],
): PeerReconciliation[] {
	return Object.entries(peerDependencies)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([peer, range]) => {
			const tested = [
				...new Set(
					records.flatMap((record) =>
						record.peers
							.filter((entry) => entry.name === peer && entry.version)
							.map((entry) => entry.version as string),
					),
				),
			].sort(compareVersions);
			const bound = lowerBound(range);
			let status: PeerReconciliation["status"] = "not-in-matrix";
			if (tested.length > 0 && bound) {
				status =
					compareVersions(bound, tested[0] as string) < 0
						? "below-tested"
						: "min-tested";
			}
			return { peer, range, lowerBound: bound, tested, status };
		});
}

const cell = (value: string) => value.replace(/\|/g, "\\|");

export function renderTable(
	records: readonly MatrixRecord[],
	peers: readonly PeerReconciliation[],
	apps: readonly AppRow[] = [],
): string {
	const lines = [
		"| Cell | Browser | Bundler | Mode | Variant | Tree shaking | Peers | Candidate | Result |",
		"| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
	];
	for (const record of records) {
		const peerText =
			record.peers
				.map(
					(peer) =>
						`${peer.name} ${peer.version ?? "absent"}${peer.min ? " (min)" : ""}`,
				)
				.join(", ") || "none";
		const result = record.blocked
			? `blocked: ${record.blocked}`
			: record.pass
				? "pass"
				: "fail";
		lines.push(
			`| ${cell(record.cell)} | ${record.browser.name} ${record.browser.version} | ${record.bundler.name} ${record.bundler.version ?? "?"} | ${record.mode} | ${record.variant} | ${record.treeShaking} | ${cell(peerText)} | ${record.candidate.sha256.slice(0, 12)}${record.candidate.dirty ? " (dirty)" : ""} | ${cell(result)} |`,
		);
	}
	lines.push(
		"",
		"| Peer | Range | Lower bound | Tested | Status |",
		"| --- | --- | --- | --- | --- |",
	);
	for (const peer of peers) {
		lines.push(
			`| ${peer.peer} | ${cell(peer.range)} | ${peer.lowerBound ?? "?"} | ${peer.tested.join(", ") || "none"} | ${peer.status} |`,
		);
	}
	if (apps.length > 0) {
		const value = (number: number | null) =>
			number === null ? "?" : String(number);
		lines.push(
			"",
			"| App | Browser | Candidate | Connections shared / per tab | Recovery samples | Median ms | p95 ms | Recovery upstreams | Worker 404 reason |",
			"| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
		);
		for (const app of apps) {
			lines.push(
				`| ${cell(app.app)} | ${app.browser} | ${app.candidate?.slice(0, 12) ?? "?"} | ${value(app.connections.shared)} / ${value(app.connections.perTab)} | ${app.recovery.samples} | ${value(app.recovery.median)} | ${value(app.recovery.p95)} | ${app.recovery.streams === null ? "n/a" : app.recovery.streams} | ${cell(app.fallback ?? "?")} |`,
			);
		}
	}
	return `${lines.join("\n")}\n`;
}

export function mergeMatrix(
	dir: string = matrixDir(),
	apps: readonly AppRow[] = readAppReports(),
): {
	records: MatrixRecord[];
	peers: PeerReconciliation[];
	apps: AppRow[];
	markdown: string;
	failures: string[];
} {
	const records = readRecords(dir);
	const manifest = JSON.parse(
		readFileSync(join(packageRoot, "package.json"), "utf8"),
	) as { peerDependencies?: Record<string, string> };
	const peers = reconcilePeers(manifest.peerDependencies ?? {}, records);
	const failures = [
		...peers
			.filter((peer) => peer.status === "below-tested")
			.map(
				(peer) =>
					`${peer.peer}: range ${peer.range} admits ${peer.lowerBound}, lowest tested ${peer.tested[0]}`,
			),
		...records
			.filter((record) => !record.pass && !record.blocked)
			.map((record) => `${record.project}/${record.cell}: failed`),
	];
	const candidates = new Set(records.map((record) => record.candidate.sha256));
	const executionFile = join(dir, "execution.json");
	if (!existsSync(executionFile)) {
		failures.push(
			"execution inventory missing; historical or partial records cannot certify this run",
		);
	} else {
		const execution = JSON.parse(
			readFileSync(executionFile, "utf8"),
		) as ExecutionInventory;
		failures.push(...executionFailures(execution, records));
	}
	if (candidates.size > 1) {
		failures.push(
			`records span ${candidates.size} candidates; re-run from one pack`,
		);
	}
	for (const app of apps) {
		if (
			app.candidate &&
			candidates.size > 0 &&
			!candidates.has(app.candidate)
		) {
			failures.push(
				`${app.file}: candidate ${app.candidate.slice(0, 12)} is not the matrix candidate`,
			);
		}
	}
	return {
		records,
		peers,
		apps: [...apps],
		markdown: renderTable(records, peers, apps),
		failures,
	};
}

const isMain =
	process.argv[1] !== undefined &&
	fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
	const dir = matrixDir();
	const merged = mergeMatrix(dir);
	writeFileSync(
		join(dir, "matrix.json"),
		`${JSON.stringify({ records: merged.records, peers: merged.peers, apps: merged.apps, failures: merged.failures }, null, "\t")}\n`,
	);
	writeFileSync(join(dir, "matrix.md"), merged.markdown);
	console.log(merged.markdown);
	if (merged.failures.length > 0) {
		console.error(merged.failures.join("\n"));
		process.exitCode = 1;
	}
}
