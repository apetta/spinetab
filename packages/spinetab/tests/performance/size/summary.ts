import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { ADAPTER_TABLE } from "../../../src/build/adapters.ts";
import {
	type AttributeOptions,
	attributeChunk,
	type ChunkAttribution,
	type ComposedSource,
	type Compressed,
	compressed,
	GENERATED_KEY,
	gzipBytes,
	joinSpans,
	type SpinetabSpan,
	spinetabClosure,
	spinetabGzip,
} from "./attribute.ts";
import {
	isPluginScenario,
	NEXT_FRAMEWORK,
	type PluginScenario,
	type SizeScenario,
} from "./catalogue.ts";
import { isMeasured, type ScenarioOutcome } from "./guard.ts";
import type { Bundler } from "./project.ts";
import { sha256 } from "./provenance.ts";
import type { Realm } from "./realm.ts";

/**
 * Per-scenario size summary from attributed chunks.
 * Shared by `measure.ts` (fresh builds) and `reattribute.ts` (preserved
 * outputs), so both report the same fields. Node-runnable, no browser.
 */

export type RealmName = "page" | "worker" | "lazy";
export const REALMS: readonly RealmName[] = ["page", "worker", "lazy"];

export interface Chunk extends Compressed {
	file: string;
	realm: Realm;
	dests: { shared: string[]; local: string[] };
	/** sha256 of the emitted chunk; its map (relative to the chunk, or "inline") and the map's sha256. */
	sha256: string;
	mapFile: string | null;
	mapSha256: string | null;
	attribution: Record<string, number>;
	mapped: boolean;
	/** Composed peer sources with their provenance decision. */
	composed?: ComposedSource[];
}

export interface RealmTotals {
	/** Full emitted chunk bytes, gzip and brotli (the actual download). */
	bytes: number;
	gzip: number;
	brotli: number;
	spinetabBytes: number;
	/** Estimate: gzip of the reconstructed Spinetab text (attribute.ts). */
	spinetabGzip: number;
	peerBytes: number;
	appBytes: number;
	bundlerBytes: number;
}

/** A chunk after attribution, before realm totals. */
export interface AttributedChunk {
	path: string;
	realm: Realm;
	dests: { shared: string[]; local: string[] };
	size: Compressed;
	sha256: string;
	mapFile: string | null;
	mapSha256: string | null;
	attribution: ChunkAttribution;
}

/** JS files of an output directory (`.js`, `.mjs`), in directory walk order. */
export function listJs(dir: string): string[] {
	const files: string[] = [];
	const walk = (current: string) => {
		for (const entry of readdirSync(current)) {
			const path = join(current, entry);
			if (statSync(path).isDirectory()) walk(path);
			else if (/\.m?js$/.test(entry)) files.push(path);
		}
	};
	walk(dir);
	return files;
}

/** Attribute one emitted chunk file. */
export function attributeFile(
	file: string,
	path: string,
	placement: { realm: Realm; dests: { shared: string[]; local: string[] } },
	options: AttributeOptions = {},
): AttributedChunk {
	const bytes = readFileSync(file);
	const attribution = attributeChunk(file, options);
	const map = attribution.mapFile;
	return {
		path,
		...placement,
		size: compressed(bytes),
		sha256: sha256(bytes),
		mapFile:
			map === null
				? null
				: map.path === null
					? "inline"
					: relative(dirname(file), map.path).replaceAll("\\", "/"),
		mapSha256: map?.sha256 ?? null,
		attribution,
	};
}

export interface SummaryContext {
	scenario: SizeScenario;
	bundler: Bundler;
	allowedSpinetab: Set<string>;
	allowedPeers: Set<string>;
	/** Spinetab files only the helper's own subpaths reach (`helperOwnFiles`). */
	ownFiles?: Set<string>;
	/**
	 * Spinetab files no page realm may hold, from the installed package
	 * (`runtimeOnlyFiles(packageDir)`). Defaults to this repository's build.
	 */
	pageForbidden?: ReadonlySet<string>;
}

/**
 * Which attribution to sum: `bytes` resolved (provenance) or by path only,
 * and the exact (`runs`) or newline-per-segment (`legacy`) Spinetab text.
 * Measurements use `resolved`/`runs`; the others exist for comparisons.
 */
export interface SummaryView {
	bytes: "resolved" | "path";
	join: "runs" | "legacy";
}

export const CURRENT_VIEW: SummaryView = { bytes: "resolved", join: "runs" };

/** A helper's own attributable Spinetab code (page realm), never negative. */
export interface HelperOwn {
	realm: "page";
	files: string[];
	bytes: number;
	gzip: number;
}

export interface OutputSummary {
	chunks: Chunk[];
	realms: Record<RealmName, RealmTotals>;
	spinetabFiles: Record<string, number>;
	peers: Record<string, number>;
	offending: string[];
	/** Emitted chunks holding the scenario's local fallback module. */
	localChunks: string[];
	/** Composed peer sources over all chunks (resolved and unresolved). */
	composed: { resolved: number; unresolved: ComposedSource[] };
	helperOwn?: HelperOwn;
	/** Plugin scenarios only: the generated worker's adapters and bytes per realm. */
	generated?: GeneratedSummary;
}

/** The generated worker of a plugin scenario. */
export interface GeneratedSummary {
	/** Adapter kinds the generated module(s) hold, code-unit order. */
	adapters: string[];
	/** Distinct generated modules seen (1 at L3, 0 at L2). */
	modules: number;
	/** Emitted generated bytes and their gzip per realm (shared counts in both). */
	realms: Record<RealmName, { bytes: number; gzip: number }>;
}

function emptyTotals(): RealmTotals {
	return {
		bytes: 0,
		gzip: 0,
		brotli: 0,
		spinetabBytes: 0,
		spinetabGzip: 0,
		peerBytes: 0,
		appBytes: 0,
		bundlerBytes: 0,
	};
}

/**
 * Export subpaths that load only in a worker or the local fallback: the
 * engine and adapter runtime entries, and the plugin's keep stub and its
 * worker-config target.
 */
const RUNTIME_ENTRY =
	/^(?:runtime|worker|[^/]+\/runtime|auto\/worker|worker-config)$/;
/** Build-realm export targets (`./dist/build/…`), in no browser realm at all. */
const BUILD_TARGET = /^\.\/dist\/build\//;

/**
 * Spinetab files that only the `./runtime`, `./worker` and `./<entry>/runtime`
 * exports reach, in both attribution forms: installed dist files (hashed
 * chunks such as the `createRuntime` engine included) and the original
 * sources their maps list (`src/core/runtime.ts`, as Turbopack composes
 * them). Files a page export also reaches (errors, validation) stay allowed.
 */
export function runtimeOnlyFiles(packageDir: string): Set<string> {
	const manifest = JSON.parse(
		readFileSync(join(packageDir, "package.json"), "utf8"),
	) as { exports: Record<string, unknown> };
	const subpaths = Object.entries(manifest.exports)
		.filter(
			([, entry]) =>
				typeof entry === "object" &&
				entry !== null &&
				("import" in entry || "default" in entry) &&
				!BUILD_TARGET.test(
					String(
						(entry as { import?: { default?: string } }).import?.default ?? "",
					),
				),
		)
		.map(([key]) => (key === "." ? "." : key.replace(/^\.\//, "")));
	const worker = spinetabClosure(
		packageDir,
		subpaths.filter((subpath) => RUNTIME_ENTRY.test(subpath)),
	);
	const page = spinetabClosure(
		packageDir,
		subpaths.filter((subpath) => !RUNTIME_ENTRY.test(subpath)),
	);
	return new Set([...worker].filter((file) => !page.has(file)));
}

let repositoryRuntimeOnly: ReadonlySet<string> | undefined;
/** This repository's build; the packed tarball carries the same files. */
function defaultRuntimeOnly(): ReadonlySet<string> {
	repositoryRuntimeOnly ??= runtimeOnlyFiles(
		join(import.meta.dirname, "../../.."),
	);
	return repositoryRuntimeOnly;
}

/**
 * Spinetab files no page realm may contain : the runtime
 * and worker entries and every `<entry>/runtime.js` adapter entry by name,
 * as installed (`dist/…`) or as a composed source (`src/…`), plus every file
 * only those entries reach (`runtimeOnlyFiles`). One allow-list serves every
 * realm, so without this rule the engine could sit in the page and pass.
 * Keys are the `spinetab:` attribution paths.
 */
export function pageForbidden(
	file: string,
	runtimeOnly: ReadonlySet<string> = defaultRuntimeOnly(),
): boolean {
	return (
		/^(?:dist\/)?(?:(?:[^/]+\/)+runtime|runtime|worker)\.js$/.test(file) ||
		/^(?:dist\/)?(?:auto\/worker|worker-config)\.js$/.test(file) ||
		/^src\/(?:auto\/worker|worker-config)\.ts$/.test(file) ||
		/^src\/(?:runtime|worker)\/index\.ts$/.test(file) ||
		/^src\/(?:transports|protocols|integrations)\/[^/]+\/runtime\.ts$/.test(
			file,
		) ||
		runtimeOnly.has(file)
	);
}

/**
 * Build-realm files: the Node-only bundler plugins and
 * their loader, as installed (`dist/build/…`) or composed (`src/build/…`).
 * No browser realm (page, worker, lazy, shared or an emitted unused chunk)
 * may hold them. The shared origin validator (`src/core/origins.ts`) is
 * runtime code too and stays allowed.
 */
export function buildForbidden(file: string): boolean {
	return /^(?:dist\/)?build\//.test(file) || /^src\/build\//.test(file);
}

/** Production chunks must drop the unowned-subscription warning and replace process.env reads. */
export const DEV_RESIDUE = ["call dispose() yourself", "process.env"] as const;
const DEV_RESIDUE_SCENARIOS: ReadonlySet<string> = new Set(["vue", "solid"]);

/** Realms a chunk counts in: shared code in both page and worker. */
export const targetsOf = (realm: Realm): RealmName[] =>
	realm === "shared" ? ["page", "worker"] : realm === "unused" ? [] : [realm];

export function summarise(
	attributed: AttributedChunk[],
	context: SummaryContext,
	view: SummaryView = CURRENT_VIEW,
): OutputSummary {
	const { scenario, bundler, allowedSpinetab, allowedPeers, ownFiles } =
		context;
	const runtimeOnly = context.pageForbidden ?? defaultRuntimeOnly();
	const realms = {
		page: emptyTotals(),
		worker: emptyTotals(),
		lazy: emptyTotals(),
	};
	const texts: Record<RealmName, string[]> = { page: [], worker: [], lazy: [] };
	const ownSpans: SpinetabSpan[][] = [];
	let ownBytes = 0;
	const spinetabFiles: Record<string, number> = {};
	const peers: Record<string, number> = {};
	const offending = new Set<string>();
	const localChunks: string[] = [];
	const chunks: Chunk[] = [];
	let resolved = 0;
	const unresolved: ComposedSource[] = [];
	const plugin = isPluginScenario(scenario);
	const generatedSources = new Set<string>();
	const generatedBytes: Record<RealmName, number> = {
		page: 0,
		worker: 0,
		lazy: 0,
	};
	const generatedTexts: Record<RealmName, string[]> = {
		page: [],
		worker: [],
		lazy: [],
	};
	for (const item of attributed) {
		const { attribution } = item;
		const bytes =
			view.bytes === "path"
				? (attribution.pathBytes ?? attribution.bytes)
				: attribution.bytes;
		const text =
			view.join === "legacy"
				? (attribution.legacySpinetabText ?? attribution.spinetabText)
				: attribution.spinetabText;
		const composed = view.bytes === "path" ? [] : attribution.composed;
		chunks.push({
			file: item.path,
			realm: item.realm,
			dests: item.dests,
			...item.size,
			sha256: item.sha256,
			mapFile: item.mapFile,
			mapSha256: item.mapSha256,
			attribution: bytes,
			mapped: attribution.mapped,
			...(composed.length > 0 ? { composed } : {}),
		});
		for (const entry of composed) {
			if (entry.status === "resolved") resolved += 1;
			else unresolved.push(entry);
		}
		if (
			scenario.spinetab &&
			attribution.sources.some((source) =>
				plugin
					? AUTO_WORKER_SOURCE.test(source)
					: source.includes(`scenarios/${scenario.id}/local`),
			)
		) {
			localChunks.push(item.path);
		}
		const inPage = targetsOf(item.realm).includes("page");
		for (const [key, value] of Object.entries(bytes)) {
			if (key.startsWith("spinetab:")) {
				const file = key.slice("spinetab:".length);
				spinetabFiles[file] = (spinetabFiles[file] ?? 0) + value;
				if (!allowedSpinetab.has(file)) offending.add(key);
				if (inPage && pageForbidden(file, runtimeOnly))
					offending.add(`page-realm:${key}`);
				if (buildForbidden(file)) offending.add(`build-realm:${key}`);
			} else if (key.startsWith("peer:")) {
				const name = key.slice("peer:".length);
				peers[name] = (peers[name] ?? 0) + value;
				const framework =
					bundler === "next" &&
					(NEXT_FRAMEWORK.has(name) || name.startsWith("@next/"));
				if (!framework && !allowedPeers.has(name)) offending.add(key);
			} else if (key === GENERATED_KEY && inPage) {
				offending.add(`page-realm:${GENERATED_KEY}`);
			}
		}
		for (const text of attribution.generatedSources ?? []) {
			generatedSources.add(text);
		}
		if (DEV_RESIDUE_SCENARIOS.has(scenario.id)) {
			for (const needle of DEV_RESIDUE) {
				if (attribution.spinetabText.includes(needle)) {
					offending.add(`dev-residue:${needle}`);
				}
			}
		}
		// Duplication across realms is counted in each realm.
		for (const target of targetsOf(item.realm)) {
			const totals = realms[target];
			totals.bytes += item.size.bytes;
			totals.gzip += item.size.gzip;
			totals.brotli += item.size.brotli;
			for (const [key, value] of Object.entries(bytes)) {
				if (key.startsWith("spinetab:")) totals.spinetabBytes += value;
				else if (key.startsWith("peer:")) totals.peerBytes += value;
				else if (key === "app") totals.appBytes += value;
				else if (key === GENERATED_KEY) generatedBytes[target] += value;
				else totals.bundlerBytes += value;
			}
			texts[target].push(text);
			if (attribution.generatedText) {
				generatedTexts[target].push(attribution.generatedText);
			}
			if (target === "page" && ownFiles) {
				const own = attribution.spinetabSpans.filter((span) =>
					ownFiles.has(span.file),
				);
				ownSpans.push(own);
				for (const span of own) ownBytes += Buffer.byteLength(span.text);
			}
		}
	}
	for (const target of REALMS) {
		realms[target].spinetabGzip = spinetabGzip(texts[target]);
	}
	let generated: GeneratedSummary | undefined;
	if (plugin) {
		const realm = (target: RealmName) => ({
			bytes: generatedBytes[target],
			gzip: spinetabGzip(generatedTexts[target]),
		});
		generated = {
			adapters: generatedAdapters(generatedSources),
			modules: generatedSources.size,
			realms: {
				page: realm("page"),
				worker: realm("worker"),
				lazy: realm("lazy"),
			},
		};
		for (const problem of generatedProblems(scenario, generated)) {
			offending.add(problem);
		}
	}
	return {
		chunks,
		realms,
		spinetabFiles,
		peers,
		offending: [...offending].sort(),
		localChunks,
		composed: { resolved, unresolved },
		...(ownFiles
			? {
					helperOwn: {
						realm: "page" as const,
						files: [...ownFiles].sort(),
						bytes: ownBytes,
						gzip: gzipBytes(
							ownSpans
								.map(joinSpans)
								.filter((part) => part.length > 0)
								.join("\n"),
						),
					},
				}
			: {}),
		...(generated ? { generated } : {}),
	};
}

/**
 * The plugin's local module: `auto/worker` (the keep stub the shipped wiring
 * imports lazily) as installed or as Turbopack composes it. The
 * worker entry holds it too; `fallbackDownloads` counts only page fetches.
 */
const AUTO_WORKER_SOURCE =
	/(?:^|\/)spinetab\/(?:dist\/auto\/worker\.js|src\/auto\/worker\.ts)$/;

const FACTORY_KINDS = new Map(
	ADAPTER_TABLE.flatMap((row) =>
		Object.entries(row.factories).map(([kind, factory]) => [factory, kind]),
	),
);

/**
 * Adapter kinds in generated worker texts, read from the one
 * `defineWorker(() => [<factory>(), …])` call the generator writes
 * (src/build/generate.ts); an unknown factory is `unknown:<name>`.
 */
export function generatedAdapters(texts: Iterable<string>): string[] {
	const kinds = new Set<string>();
	for (const text of texts) {
		const list = /defineWorker\(\(\) => \[([^\]]*)\]/.exec(text)?.[1] ?? "";
		for (const call of list.split(",")) {
			const factory = call.trim().replace(/\(\)$/, "");
			if (factory === "") continue;
			kinds.add(FACTORY_KINDS.get(factory) ?? `unknown:${factory}`);
		}
	}
	return [...kinds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * What the generated worker makes offending: at L3 exactly one
 * generated set equal to `expectedAdapters` (an inferred extra adapter is a
 * size fact, the inference control's purpose); at L2 none at all.
 */
function generatedProblems(
	scenario: PluginScenario,
	generated: GeneratedSummary,
): string[] {
	if (scenario.level === "L2") {
		return generated.modules > 0 ? ["generated:unexpected-at-L2"] : [];
	}
	if (generated.modules === 0) return ["generated:missing"];
	const problems: string[] = [];
	if (generated.modules > 1) problems.push("generated:variants");
	const expected = [...(scenario.expectedAdapters ?? [])].sort();
	if (generated.adapters.join(",") !== expected.join(",")) {
		problems.push(`generated:adapters=${generated.adapters.join(",")}`);
	}
	return problems;
}

/** Realm totals with the generated worker's share, for the side-by-side report. */
export interface CategoryTotals extends RealmTotals {
	generatedBytes: number;
	generatedGzip: number;
}

/** A plugin scenario against its L1 counterpart, per realm. */
export interface PluginComparison {
	counterpart: string;
	level: "L2" | "L3";
	adapters: string[];
	realms: Record<
		RealmName,
		{
			l3: CategoryTotals;
			l1: CategoryTotals | null;
			delta: CategoryTotals | null;
		}
	>;
}

/** The fields of a measured result the side-by-side report reads. */
export interface WithRealms {
	minified: { realms: Record<RealmName, RealmTotals> };
	generated?: GeneratedSummary;
}

const CATEGORY_FIELDS = [
	"bytes",
	"gzip",
	"brotli",
	"spinetabBytes",
	"spinetabGzip",
	"peerBytes",
	"appBytes",
	"bundlerBytes",
	"generatedBytes",
	"generatedGzip",
] as const;

/**
 * Every category of each realm for a plugin scenario and its L1 counterpart
 * (same bundler, same run), and the L3 − L1 delta. The whole-realm `gzip`
 * delta is the honest cost: the plugin moves bytes from the application
 * (the wiring literal, the worker file) into Spinetab and the generated
 * module. `l1` and `delta` are null without a measured counterpart.
 */
export function pluginComparison(
	scenario: PluginScenario,
	own: WithRealms,
	counterpart: ScenarioOutcome | WithRealms | undefined,
): PluginComparison {
	const withGenerated = (
		outcome: WithRealms,
		realm: RealmName,
	): CategoryTotals => ({
		...outcome.minified.realms[realm],
		generatedBytes: outcome.generated?.realms[realm].bytes ?? 0,
		generatedGzip: outcome.generated?.realms[realm].gzip ?? 0,
	});
	const base = isMeasured(counterpart as ScenarioOutcome)
		? (counterpart as WithRealms)
		: undefined;
	const entry = (realm: RealmName) => {
		const l3 = withGenerated(own, realm);
		const l1 = base ? withGenerated(base, realm) : null;
		const delta = l1
			? (Object.fromEntries(
					CATEGORY_FIELDS.map((field) => [field, l3[field] - l1[field]]),
				) as unknown as CategoryTotals)
			: null;
		return { l3, l1, delta };
	};
	return {
		counterpart: scenario.counterpart,
		level: scenario.level,
		adapters: own.generated?.adapters ?? [],
		realms: {
			page: entry("page"),
			worker: entry("worker"),
			lazy: entry("lazy"),
		},
	};
}

export const PLUGIN_LIMITATION =
	"size.<id>.l3.* (informational): generated-path scenarios built with the Spinetab plugin (L2: the application's spinetab.worker.ts; L3: the generated worker) from each scenario's own project root. <realm>.gzip rows are Spinetab-only gzip as the L1 rows define it (generated code excluded: it is its own category, generated.gzip, keyed by the generated header in the worker-config stub path's sourcesContent); <realm>.delta.gzip is the realm's full emitted gzip minus the L1 counterpart's (the plugin moves bytes from the application into Spinetab); inference.gzip is the inferred scenario's total emitted gzip minus its explicit-adapters twin's. L1 rows and targets are unchanged. webpack, Rspack and Astro are not measured.";

/**
 * Spinetab files (dist files and their composed sources) that a helper's
 * own subpaths reach and its base scenario's do not: the helper's selected
 * area. Undefined for scenarios that are not helpers.
 */
export function helperOwnFiles(
	scenario: SizeScenario,
	base: SizeScenario | undefined,
	closure: (subpaths: string[]) => Set<string>,
): Set<string> | undefined {
	if (scenario.kind !== "helper" || !base) return undefined;
	const baseFiles = closure(base.subpaths);
	return new Set(
		[...closure(scenario.subpaths)].filter((file) => !baseFiles.has(file)),
	);
}

export const HELPER_DELTA_LIMITATION =
	"size.<helper>.incremental.gzip.<bundler> is the page-realm Spinetab-only gzip of the helper scenario minus its base scenario's: a comparative whole-page delta. The scenarios have different call sites, so tree shaking, inlining and compression context differ, and the delta can be negative; it is not the helper's size. size.<helper>.own.{bytes,gzip}.<bundler> (informational) is the helper's own attributable code: page-realm spans of the Spinetab files only its own subpaths reach (not its base's), reconstructed exactly and gzipped on their own (never negative; an estimate).";

export const SPINETAB_GZIP_NOTE =
	"Spinetab gzip = gzip of the Spinetab text reconstructed from each chunk (contiguous spans joined exactly as emitted, one newline between separated runs; chunks joined by a newline): an estimate beside the realm's full emitted chunk gzip (`gzip`). Differential gzip = the realm's full emitted gzip minus the base scenario's (size.<id>.differential.gzip.<bundler>, informational).";

/**
 * Informational values beside the budget rows (never gating): the full
 * emitted differential gzip for every incremental row, and each helper's own
 * attributable bytes and gzip.
 */
export function informationalRows(
	bundler: Bundler,
	selection: SizeScenario[],
	outcomes: Record<string, ScenarioOutcome>,
): Record<string, number> {
	const values: Record<string, number> = {};
	const selected = new Set(selection.map((scenario) => scenario.id));
	for (const scenario of selection) {
		if (!scenario.spinetab || !scenario.base || !selected.has(scenario.base)) {
			continue;
		}
		const own = outcomes[scenario.id];
		const base = outcomes[scenario.base];
		if (!isMeasured(own) || !isMeasured(base)) continue;
		const realms: Array<"page" | "worker"> =
			scenario.target === "page" ? ["page"] : ["page", "worker"];
		const sum = (outcome: typeof own) =>
			realms.reduce(
				(total, realm) => total + outcome.minified.realms[realm].gzip,
				0,
			);
		values[`size.${scenario.id}.differential.gzip.${bundler}`] =
			sum(own) - sum(base);
		const helper = (own as { helperOwn?: HelperOwn }).helperOwn;
		if (scenario.kind === "helper" && helper) {
			values[`size.${scenario.id}.own.bytes.${bundler}`] = helper.bytes;
			values[`size.${scenario.id}.own.gzip.${bundler}`] = helper.gzip;
		}
	}
	return values;
}
