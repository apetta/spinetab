import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { evidenceDir, repoRoot, writeJson } from "../lib/evidence.ts";
import { dependencyClosure, spinetabClosure } from "./attribute.ts";
import {
	PLUGIN_SCENARIOS,
	SCENARIOS,
	type SizeScenario,
	selectScenarios,
} from "./catalogue.ts";
import {
	deriveRows,
	type ScenarioOutcome,
	splitPluginRows,
	unselectedBundlerRows,
} from "./guard.ts";
import { type Bundler, nextScenarioPaths } from "./project.ts";
import { createProvenanceResolver, sha256 } from "./provenance.ts";
import { destinations, realmOf } from "./realm.ts";
import type { LoggedRequest } from "./static-server.ts";
import {
	type AttributedChunk,
	attributeFile,
	CURRENT_VIEW,
	HELPER_DELTA_LIMITATION,
	helperOwnFiles,
	informationalRows,
	listJs,
	type OutputSummary,
	type RealmTotals,
	SPINETAB_GZIP_NOTE,
	type SummaryView,
	summarise,
} from "./summary.ts";

/**
 * Re-attribute a preserved size run
 * without building or loading anything:
 *
 * node tests/performance/size/reattribute.ts --from <run> --run <new run>
 * [--work <preserved work root>]
 *
 * Reads the original `sizes.json` and the work root it names (emitted
 * minified chunks, their maps, the installed consumer projects and the
 * extracted tarball); never writes there. Realms come from the request logs
 * preserved in the report (realm.ts); raw bytes, requests, modes and mode
 * checks are carried over. Fails closed before writing when the preserved
 * outputs are not the measured ones (file set, bytes, gzip, brotli, realm)
 * or when the path-keyed legacy view does not reproduce the original report
 * exactly (every chunk attribution, realm total, file, peer, offending list,
 * fallback list and metric). Then writes a NEW
 * docs/evidence/perf/<run>/sizes.json (never overwrites) with the current
 * view (verified peer provenance, exact Spinetab join) and a metric-by-metric
 * diff for each stage. Plugin scenarios and their `size.<id>.l3.*`
 * rows are carried over unchanged, never re-attributed, and stay out of the
 * reproduction check.
 */

interface OriginalChunk {
	file: string;
	realm: string;
	dests: { shared: string[]; local: string[] };
	bytes: number;
	gzip: number;
	brotli: number;
	attribution: Record<string, number>;
	mapped: boolean;
}

interface OriginalScenario {
	bundler: Bundler;
	minified?: {
		chunks: OriginalChunk[];
		realms: Record<"page" | "worker" | "lazy", RealmTotals>;
	};
	requests?: { shared: LoggedRequest[]; local: LoggedRequest[] };
	spinetabFiles?: Record<string, number>;
	peers?: Record<string, number>;
	offending?: string[];
	fallbackInShared?: string[];
	status?: string;
	error?: string;
	[key: string]: unknown;
}

interface OriginalReport {
	run: string;
	createdAt: string;
	tarball: unknown;
	workRoot: string;
	/** Present when the report records unselected scenarios. */
	catalogue?: string[];
	tools: Record<string, unknown>;
	peers: Record<string, string>;
	metrics: Record<string, number>;
	notMeasured: Record<string, string>;
	scenarios: Record<string, Partial<Record<Bundler, OriginalScenario>>>;
}

export interface MetricChange {
	id: string;
	original: number | null;
	value: number | null;
	delta: number | null;
}

/** Metric-by-metric differences (added, removed or changed ids), sorted. */
export function diffMetrics(
	original: Record<string, number>,
	current: Record<string, number>,
): { changes: MetricChange[]; unchanged: number } {
	const ids = [
		...new Set([...Object.keys(original), ...Object.keys(current)]),
	].sort();
	const changes: MetricChange[] = [];
	let unchanged = 0;
	for (const id of ids) {
		const before = original[id];
		const after = current[id];
		if (before === after) {
			unchanged += 1;
			continue;
		}
		changes.push({
			id,
			original: before ?? null,
			value: after ?? null,
			delta:
				before === undefined || after === undefined ? null : after - before,
		});
	}
	return { changes, unchanged };
}

/** Key-order-insensitive JSON equality for plain records. */
export function sameJson(a: unknown, b: unknown): boolean {
	const canonical = (value: unknown): unknown =>
		Array.isArray(value)
			? value.map(canonical)
			: value && typeof value === "object"
				? Object.fromEntries(
						Object.entries(value as Record<string, unknown>)
							.sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
							.map(([key, inner]) => [key, canonical(inner)]),
					)
				: value;
	return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

const sorted = (values: Iterable<string>) => [...values].sort();

function outputDir(work: string, bundler: Bundler, id: string): string {
	return bundler === "vite"
		? join(work, "vite", "dist", `${id}-min`)
		: nextScenarioPaths(join(work, "next"), id, "min").exportDir;
}

interface Views {
	reproduction: OutputSummary;
	provenanceOnly: OutputSummary;
	current: OutputSummary;
}

const VIEWS: Record<keyof Views, SummaryView> = {
	reproduction: { bytes: "path", join: "legacy" },
	provenanceOnly: { bytes: "resolved", join: "legacy" },
	current: CURRENT_VIEW,
};

const asOutcome = (
	summary: OutputSummary,
	fallbackInShared: string[],
): ScenarioOutcome & { helperOwn?: OutputSummary["helperOwn"] } => ({
	minified: { realms: summary.realms },
	offending: summary.offending,
	fallbackInShared,
	...(summary.helperOwn ? { helperOwn: summary.helperOwn } : {}),
});

export async function main(argv = process.argv.slice(2)): Promise<void> {
	const { values: args } = parseArgs({
		args: argv,
		options: {
			from: { type: "string" },
			run: { type: "string" },
			work: { type: "string" },
		},
	});
	if (!args.from || !args.run) {
		throw new Error("usage: reattribute.ts --from <run> --run <new run>");
	}
	if (!/^[A-Za-z0-9._-]+$/.test(args.run) || args.run === args.from) {
		throw new Error(`--run must be a new run id, not ${args.run}`);
	}
	const sourcePath = join(evidenceDir(args.from), "sizes.json");
	const outPath = join(evidenceDir(args.run), "sizes.json");
	if (!existsSync(sourcePath)) throw new Error(`No report at ${sourcePath}`);
	if (existsSync(outPath)) {
		throw new Error(`${outPath} exists; re-attribution never overwrites`);
	}
	const sourceBytes = readFileSync(sourcePath);
	const original = JSON.parse(sourceBytes.toString("utf8")) as OriginalReport;
	const originalMetrics = splitPluginRows(original.metrics);
	const originalNotMeasured = splitPluginRows(original.notMeasured);
	const carriedScenarios = Object.fromEntries(
		PLUGIN_SCENARIOS.filter(
			(scenario) => scenario.id in original.scenarios,
		).map((scenario) => [scenario.id, original.scenarios[scenario.id]]),
	);
	const work = args.work ?? original.workRoot;
	const packageDir = join(work, "package");
	for (const path of [work, packageDir]) {
		if (!existsSync(path)) throw new Error(`Preserved ${path} is missing`);
	}
	const selection = selectScenarios(
		SCENARIOS.map((scenario) => scenario.id)
			.filter((id) => id in original.scenarios)
			.join(","),
	);
	const bundlers = Object.keys(original.tools).filter(
		(name): name is Bundler => name === "vite" || name === "next",
	);
	// The reproduction follows the rule its report was written under: before
	// an `--only` run dropped unselected scenarios (no `catalogue`).
	const recordedCatalogue = Array.isArray(original.catalogue)
		? SCENARIOS.filter((scenario) => original.catalogue?.includes(scenario.id))
		: undefined;
	const problems: string[] = [];
	const scenarios: Record<string, Partial<Record<Bundler, unknown>>> = {};
	const metrics: Record<keyof Views, Record<string, number>> = {
		reproduction: {},
		provenanceOnly: {},
		current: {},
	};
	const notMeasured: Record<keyof Views, Record<string, string>> = {
		reproduction: {},
		provenanceOnly: {},
		current: {},
	};
	const informational: Record<string, number> = {};
	const chunkHashes: Array<{
		scenario: string;
		bundler: Bundler;
		file: string;
		sha256: string;
		mapFile: string | null;
		mapSha256: string | null;
	}> = [];
	let composedResolved = 0;
	const composedUnresolved: Array<{
		scenario: string;
		bundler: Bundler;
		source: string;
		reason: string;
	}> = [];

	for (const bundler of bundlers) {
		const projectDir = join(work, bundler);
		const resolver = createProvenanceResolver(projectDir, {
			pinned: original.peers,
		});
		const outcomes: Record<keyof Views, Record<string, ScenarioOutcome>> = {
			reproduction: {},
			provenanceOnly: {},
			current: {},
		};
		for (const scenario of selection) {
			const record = original.scenarios[scenario.id]?.[bundler];
			if (!record?.minified || !record.requests) {
				// Not measured originally: carried over unchanged, never re-measured.
				for (const view of Object.keys(outcomes) as Array<keyof Views>) {
					outcomes[view][scenario.id] = record as ScenarioOutcome;
				}
				scenarios[scenario.id] = {
					...(scenarios[scenario.id] ?? {}),
					[bundler]: record,
				};
				continue;
			}
			const where = `${scenario.id}/${bundler}`;
			const dir = outputDir(work, bundler, scenario.id);
			const emitted = listJs(dir).map(
				(file) => `/${relative(dir, file).replaceAll("\\", "/")}`,
			);
			const measured = record.minified.chunks.map((chunk) => chunk.file);
			if (!sameJson(sorted(emitted), sorted(measured))) {
				problems.push(
					`${where}: preserved JS files differ from the measured chunks`,
				);
				continue;
			}
			const shared = destinations(record.requests.shared);
			const local = destinations(record.requests.local);
			const attributed: AttributedChunk[] = [];
			for (const chunk of record.minified.chunks) {
				const dests = {
					shared: [...(shared.get(chunk.file) ?? [])],
					local: [...(local.get(chunk.file) ?? [])],
				};
				const realm = realmOf(new Set(dests.shared), new Set(dests.local));
				if (realm !== chunk.realm || !sameJson(dests, chunk.dests)) {
					problems.push(
						`${where} ${chunk.file}: realm ${realm} from the preserved requests, report says ${chunk.realm}`,
					);
				}
				const item = attributeFile(
					join(dir, chunk.file.slice(1)),
					chunk.file,
					{ realm, dests },
					{ resolver, compare: true },
				);
				for (const field of ["bytes", "gzip", "brotli"] as const) {
					if (item.size[field] !== chunk[field]) {
						problems.push(
							`${where} ${chunk.file}: ${field} ${item.size[field]} ≠ measured ${chunk[field]}`,
						);
					}
				}
				attributed.push(item);
				chunkHashes.push({
					scenario: scenario.id,
					bundler,
					file: chunk.file,
					sha256: item.sha256,
					mapFile: item.mapFile,
					mapSha256: item.mapSha256,
				});
			}
			const context = {
				scenario,
				bundler,
				allowedSpinetab: spinetabClosure(packageDir, scenario.subpaths),
				allowedPeers: dependencyClosure(projectDir, scenario.peers),
			};
			const ownFiles = helperOwnFiles(
				scenario,
				SCENARIOS.find((candidate) => candidate.id === scenario.base),
				(subpaths) => spinetabClosure(packageDir, subpaths),
			);
			const views: Views = {
				reproduction: summarise(attributed, context, VIEWS.reproduction),
				provenanceOnly: summarise(
					attributed,
					{ ...context, ...(ownFiles ? { ownFiles } : {}) },
					VIEWS.provenanceOnly,
				),
				current: summarise(
					attributed,
					{ ...context, ...(ownFiles ? { ownFiles } : {}) },
					VIEWS.current,
				),
			};
			const sharedPaths = new Set(
				record.requests.shared
					.filter((request) => request.status === 200)
					.map((request) => request.path),
			);
			const fallbackInShared = views.current.localChunks.filter((path) =>
				sharedPaths.has(path),
			);
			// The legacy view must reproduce the original record exactly.
			const reproduced = views.reproduction;
			const mismatch = (
				[
					["realms", reproduced.realms, record.minified.realms],
					["spinetabFiles", reproduced.spinetabFiles, record.spinetabFiles],
					["peers", reproduced.peers, record.peers],
					["offending", reproduced.offending, record.offending],
					["fallbackInShared", fallbackInShared, record.fallbackInShared],
					[
						"chunk attribution",
						reproduced.chunks.map((chunk) => chunk.attribution),
						record.minified.chunks.map((chunk) => chunk.attribution),
					],
				] as const
			).filter(([, ours, theirs]) => !sameJson(ours, theirs));
			for (const [field] of mismatch) {
				problems.push(`${where}: legacy view does not reproduce ${field}`);
			}
			for (const view of Object.keys(views) as Array<keyof Views>) {
				outcomes[view][scenario.id] = asOutcome(views[view], fallbackInShared);
			}
			const current = views.current;
			composedResolved += current.composed.resolved;
			for (const entry of current.composed.unresolved) {
				if (entry.status === "unresolved") {
					composedUnresolved.push({
						scenario: scenario.id,
						bundler,
						source: entry.source,
						reason: entry.reason,
					});
				}
			}
			const {
				minified: _minified,
				spinetabFiles: _files,
				peers: _peers,
				offending: _offending,
				fallbackInShared: _fallback,
				...carried
			} = record;
			scenarios[scenario.id] = {
				...(scenarios[scenario.id] ?? {}),
				[bundler]: {
					...carried,
					minified: { chunks: current.chunks, realms: current.realms },
					spinetabFiles: current.spinetabFiles,
					peers: current.peers,
					offending: current.offending,
					composed: current.composed,
					...(current.helperOwn ? { helperOwn: current.helperOwn } : {}),
					fallbackInShared,
					original: {
						offending: record.offending,
						peers: record.peers,
						realms: record.minified.realms,
					},
				},
			};
		}
		for (const view of Object.keys(outcomes) as Array<keyof Views>) {
			const catalogue =
				view === "reproduction" ? (recordedCatalogue ?? selection) : SCENARIOS;
			const rows = deriveRows(bundler, selection, outcomes[view], catalogue);
			Object.assign(metrics[view], rows.metrics);
			Object.assign(notMeasured[view], rows.notMeasured);
		}
		Object.assign(
			informational,
			informationalRows(bundler, selection, outcomes.current),
		);
	}
	if (recordedCatalogue) {
		Object.assign(
			notMeasured.reproduction,
			unselectedBundlerRows(bundlers, recordedCatalogue),
		);
	}
	Object.assign(notMeasured.provenanceOnly, unselectedBundlerRows(bundlers));
	Object.assign(notMeasured.current, unselectedBundlerRows(bundlers));

	const reproduction = diffMetrics(originalMetrics.l1, metrics.reproduction);
	if (
		reproduction.changes.length > 0 ||
		!sameJson(notMeasured.reproduction, originalNotMeasured.l1)
	) {
		problems.push(
			`legacy view metrics differ from the original: ${reproduction.changes
				.map((change) => change.id)
				.join(", ")}`,
		);
	}
	if (problems.length > 0) {
		throw new Error(
			`Re-attribution refused (${problems.length} problem(s)); nothing written:\n${problems.join("\n")}`,
		);
	}
	const provenanceOnly = diffMetrics(
		originalMetrics.l1,
		metrics.provenanceOnly,
	);
	const current = diffMetrics(originalMetrics.l1, metrics.current);
	const nativeTransports = selection.filter(
		(scenario: SizeScenario) =>
			scenario.kind === "transport" && scenario.peers.length === 0,
	);
	writeJson(outPath, {
		schema: 1,
		run: args.run,
		createdAt: new Date().toISOString(),
		kind: "re-attribution of preserved outputs: no build, no install, no browser load",
		reattributedFrom: {
			run: original.run,
			report: relative(repoRoot, sourcePath),
			sha256: sha256(sourceBytes),
			createdAt: original.createdAt,
			workRoot: work,
		},
		tarball: original.tarball,
		workRoot: work,
		tools: original.tools,
		peers: original.peers,
		note: SPINETAB_GZIP_NOTE,
		limitations: [
			HELPER_DELTA_LIMITATION,
			"Re-attributed from the preserved minified outputs, maps and installs: realms from the preserved request logs; raw bytes, requests, modes and mode checks carried from the original report. Loads and builds were not repeated.",
			"Plugin scenarios and their size.<id>.l3.* rows are carried over from the original report unchanged; they are not re-attributed.",
		],
		metrics: { ...metrics.current, ...originalMetrics.plugin },
		notMeasured: { ...notMeasured.current, ...originalNotMeasured.plugin },
		informational,
		stages: {
			reproduction: {
				view: VIEWS.reproduction,
				description:
					"path-derived keys and the newline-per-segment newline-per-segment join: must reproduce the original report exactly",
				identical: true,
				unchangedMetrics: reproduction.unchanged,
			},
			provenanceOnly: {
				view: VIEWS.provenanceOnly,
				description:
					"verified installed-package provenance for composed peer sources; legacy Spinetab join",
				metrics: metrics.provenanceOnly,
				changes: provenanceOnly.changes,
				unchangedMetrics: provenanceOnly.unchanged,
			},
			current: {
				view: VIEWS.current,
				description:
					"verified provenance and the exact Spinetab join (contiguous spans joined as emitted)",
				changes: current.changes,
				unchangedMetrics: current.unchanged,
			},
		},
		joinComparison: Object.fromEntries(
			nativeTransports.map((scenario) => [
				scenario.id,
				{
					differentialGzip:
						informational[`size.${scenario.id}.differential.gzip.vite`] ?? null,
					legacyIncrementalGzip:
						metrics.provenanceOnly[
							`size.${scenario.id}.incremental.gzip.vite`
						] ?? null,
					incrementalGzip:
						metrics.current[`size.${scenario.id}.incremental.gzip.vite`] ??
						null,
					legacyAgreement:
						metrics.provenanceOnly[
							`size.${scenario.id}.attribution-agreement.vite`
						] ?? null,
					agreement:
						metrics.current[`size.${scenario.id}.attribution-agreement.vite`] ??
						null,
				},
			]),
		),
		provenance: {
			rule: "a composed peer source outside its pnpm store entry's package is keyed to that package only when one of the entry's own input maps lists the same path with a byte-identical sourcesContent body (sha256), the matches belong to exactly one package, and that package is the entry's own name@version (and the pinned version); otherwise the path-derived key stays",
			resolved: composedResolved,
			unresolved: composedUnresolved,
		},
		chunkHashes,
		scenarios: { ...scenarios, ...carriedScenarios },
	});
	console.log(
		JSON.stringify(
			{
				wrote: relative(repoRoot, outPath),
				original: {
					report: relative(repoRoot, sourcePath),
					sha256: sha256(sourceBytes),
				},
				chunks: chunkHashes.length,
				reproduction: { identical: true, metrics: reproduction.unchanged },
				provenanceOnly: provenanceOnly.changes,
				current: current.changes,
				composed: {
					resolved: composedResolved,
					unresolved: composedUnresolved.length,
				},
			},
			null,
			2,
		),
	);
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	await main();
}
