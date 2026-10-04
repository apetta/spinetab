// Worker-file selection takes precedence over explicit adapters, then import inference.

import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	compareText,
	rowOfEntry,
	rowOfKind,
	type SpinetabAdapterName,
} from "./adapters.ts";
import {
	devNameForGenerated,
	devNameForWorkerFile,
	generateWorker,
} from "./generate.ts";
import { buildMessage, SpinetabBuildError } from "./messages.ts";
import type { ValidOptions } from "./options.ts";
import { relativePosix } from "./paths.ts";
import {
	type InferredSet,
	inferAdapters,
	peerResolves,
	scanRootsFor,
	scanSource,
} from "./scan.ts";

const CONVENTIONAL_DIRECTORIES = ["src", "app", ""] as const;
const CONVENTIONAL_EXTENSIONS = ["ts", "mts", "js", "mjs"] as const;

export function findConventionalWorkerFiles(root: string): string[] {
	const found: string[] = [];
	for (const directory of CONVENTIONAL_DIRECTORIES) {
		for (const extension of CONVENTIONAL_EXTENSIONS) {
			const path = join(root, directory, `spinetab.worker.${extension}`);
			if (isFile(path)) found.push(resolve(path));
		}
	}
	return found;
}

export function isConventionalWorkerPath(root: string, file: string): boolean {
	const rel = relativePosix(root, file);
	return /^(?:(?:src|app)\/)?spinetab\.worker\.(?:ts|mts|js|mjs)$/.test(rel);
}

export type BuildPlan =
	| {
			level: "L2";
			root: string;
			/** Absolute developer worker file. */
			workerFile: string;
			/** Project-relative POSIX path. */
			relative: string;
	  }
	| {
			level: "L3";
			root: string;
			/** Scan roots: the project and linked workspace packages. */
			roots: readonly string[];
			/** Explicit set from the `adapters` option, or `null` to infer. */
			adapters: readonly SpinetabAdapterName[] | null;
			credentialOrigins: readonly string[];
	  };

export function resolvePlan(root: string, options: ValidOptions): BuildPlan {
	const projectRoot = resolve(root);
	if (options.worker !== undefined) {
		const file = resolve(projectRoot, options.worker);
		const rel = relativePosix(projectRoot, file);
		if (!isFile(file)) {
			throw new SpinetabBuildError({
				code: "worker-file-missing",
				files: [rel],
			});
		}
		return workerFilePlan(projectRoot, file);
	}
	const conventional = findConventionalWorkerFiles(projectRoot);
	if (conventional.length > 1) {
		throw new SpinetabBuildError({
			code: "worker-file-conflict",
			files: conventional.map((file) => relativePosix(projectRoot, file)),
		});
	}
	const [file] = conventional;
	if (file !== undefined) {
		if (options.adapters !== undefined || options.hasCredentialOrigins) {
			throw new SpinetabBuildError({ code: "worker-file-with-options" });
		}
		return workerFilePlan(projectRoot, file);
	}
	if (options.adapters !== undefined) {
		for (const kind of options.adapters) {
			const peer = rowOfKind(kind).peer;
			if (peer !== undefined && !peerResolves(projectRoot, peer)) {
				throw new SpinetabBuildError({ code: "missing-peer", kind, peer });
			}
		}
	}
	return {
		level: "L3",
		root: projectRoot,
		roots: scanRootsFor(projectRoot),
		adapters: options.adapters ?? null,
		credentialOrigins: options.credentialOrigins,
	};
}

function workerFilePlan(root: string, file: string): BuildPlan {
	const rel = relativePosix(root, file);
	if (!hasDefaultExport(readFileSync(file, "utf8"))) {
		throw new SpinetabBuildError({
			code: "worker-file-no-default",
			files: [rel],
		});
	}
	return { level: "L2", root, workerFile: file, relative: rel };
}

// Comments and string or template literals, in one left-to-right pass so a
// `//` inside a string or a quote inside a comment is read as its container.
const COMMENTS_AND_STRINGS =
	/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\[\s\S])*`/g;

/** Default export detection over raw text (comments and strings blanked). */
export function hasDefaultExport(code: string): boolean {
	const text = code.replace(COMMENTS_AND_STRINGS, (token) =>
		token.startsWith("/") ? " " : '""',
	);
	return (
		/(?:^|[\s;{}])export\s+default\b/.test(text) ||
		/(?:^|[\s;{}])export\s*\{[^}]*\bdefault\b[^}]*\}/.test(text)
	);
}

export interface AdapterSet {
	kinds: readonly SpinetabAdapterName[];
	explicit: boolean;
	/** Page entries the scan saw (empty for an explicit set). */
	entries: readonly string[];
	missingPeers: readonly { kind: SpinetabAdapterName; peer: string }[];
	text: string;
	/** Warnings for the bundler's warning channel (fixed messages). */
	warnings: readonly string[];
}

export interface AdapterSetContext {
	dev: boolean;
	/** Absolute directories the scan never walks (the output directory). */
	excludes?: readonly string[];
}

/**
 * The warnings of an inferred set and its empty-set rule. A set emptied
 * only by missing peers fails production with the first `missing-peer` by
 * kind order; an empty scan fails it with `no-adapters`. Development
 * warns instead. `scan-fallback` is a warning in both.
 */
export function inferredWarnings(
	inferred: InferredSet,
	dev: boolean,
): string[] {
	const warnings: string[] = [];
	if (inferred.fallbacks.length > 0) {
		warnings.push(
			buildMessage({ code: "scan-fallback", files: inferred.fallbacks }),
		);
	}
	for (const { kind, peer } of inferred.missingPeers) {
		warnings.push(buildMessage({ code: "missing-peer", kind, peer }));
	}
	if (inferred.kinds.length === 0) {
		const [missing] = inferred.missingPeers;
		if (!dev) {
			throw missing
				? new SpinetabBuildError({ code: "missing-peer", ...missing })
				: new SpinetabBuildError({ code: "no-adapters" });
		}
		if (!missing) warnings.push(buildMessage({ code: "no-adapters" }));
	}
	return warnings;
}

/**
 * The generated set for an L3 plan, applying the peer guard and the empty-set
 * rule: development warns, production fails unless `adapters: []`.
 */
export function resolveAdapterSet(
	plan: Extract<BuildPlan, { level: "L3" }>,
	context: AdapterSetContext,
): AdapterSet {
	let warnings: string[] = [];
	let kinds: readonly SpinetabAdapterName[];
	let entries: readonly string[] = [];
	let missingPeers: readonly { kind: SpinetabAdapterName; peer: string }[] = [];
	if (plan.adapters !== null) {
		kinds = plan.adapters;
	} else {
		const inferred = inferAdapters(plan.roots, {
			excludes: context.excludes ?? [],
		});
		kinds = inferred.kinds;
		entries = inferred.entries;
		missingPeers = inferred.missingPeers;
		warnings = inferredWarnings(inferred, context.dev);
	}
	return {
		kinds,
		explicit: plan.adapters !== null,
		entries,
		missingPeers,
		text: generateWorker(kinds, plan.credentialOrigins),
		warnings,
	};
}

export function devNameFor(plan: BuildPlan, set?: AdapterSet): string {
	if (plan.level === "L2") {
		let content = "";
		try {
			content = readFileSync(plan.workerFile, "utf8");
		} catch {
			// A deleted worker file still yields a stable name until restart.
		}
		return devNameForWorkerFile(plan.relative, content);
	}
	return devNameForGenerated(set?.text ?? "");
}

/** Adapter page entry → the files outside `node_modules` that import it. */
export type ImportedEntries = ReadonlyMap<string, ReadonlySet<string>>;

export function recordImport(
	imported: Map<string, Set<string>>,
	entry: string,
	importer: string,
): void {
	let importers = imported.get(entry);
	if (!importers) {
		importers = new Set();
		imported.set(entry, importers);
	}
	importers.add(importer);
}

/**
 * The build-time graph check: every adapter page entry imported from
 * outside `node_modules` must have an adapter in the generated set, unless
 * every importer imports it for types only. For an entry with several
 * kinds (tRPC), the importing files' named imports decide which kinds are
 * needed, so `adapters: ["trpc-ws"]` with a page using `spinetabSseLink`
 * fails here rather than at run time.
 */
export function checkGraph(
	set: Pick<AdapterSet, "kinds" | "missingPeers">,
	importedEntries: Iterable<string> | ImportedEntries,
): SpinetabBuildError | undefined {
	const present = new Set<string>(set.kinds);
	const importers: ImportedEntries =
		importedEntries instanceof Map
			? importedEntries
			: new Map([...importedEntries].map((entry) => [entry, new Set()]));
	for (const entry of [...importers.keys()].sort(compareText)) {
		const row = rowOfEntry(entry);
		if (!row) continue;
		const needed = neededKinds(row.entry, row.kinds, importers.get(entry));
		// Only type imports: the page loads no source of this entry.
		if (needed === "types") continue;
		const satisfied =
			needed.length > 0
				? needed.every((kind) => present.has(kind))
				: row.kinds.some((kind) => present.has(kind));
		if (satisfied) continue;
		const missing = set.missingPeers.find((item) =>
			row.kinds.includes(item.kind),
		);
		if (missing) {
			return new SpinetabBuildError({
				code: "missing-peer",
				kind: missing.kind,
				peer: missing.peer,
			});
		}
		return new SpinetabBuildError({ code: "adapter-not-generated", entry });
	}
	return undefined;
}

/**
 * What the importers of an entry need, read from their files on disk:
 * `types` when every importer imports it for types only (an inline all-type
 * list that `verbatimModuleSyntax` keeps as `import {}`); otherwise the
 * kinds of a multi-kind entry they pick by name. Empty when unknown (an
 * unreadable or virtual importer, or only namespace and dynamic imports): the
 * check then needs any one kind.
 */
function neededKinds(
	entry: string,
	kinds: readonly SpinetabAdapterName[],
	importers: ReadonlySet<string> | undefined,
): SpinetabAdapterName[] | "types" {
	if (!importers || importers.size === 0) return [];
	const needed = new Set<SpinetabAdapterName>();
	let values = false;
	for (const importer of importers) {
		let code: string;
		try {
			code = readFileSync(importer, "utf8");
		} catch {
			return [];
		}
		const scan = scanSource(code, importer);
		if (scan.entries.has(entry)) {
			values = true;
			for (const kind of scan.named) {
				if (kinds.includes(kind)) needed.add(kind);
			}
			continue;
		}
		// The importer resolved the entry, so a scan that reads neither a
		// value nor a type import of it (a syntax the scanner does not read)
		// can neither skip nor narrow the check.
		if (!scan.typeOnly.has(entry)) return [];
	}
	if (!values) return "types";
	return kinds.length < 2 ? [] : [...needed].sort(compareText);
}

export function adapterEntryOf(specifier: string): string | undefined {
	const match = /^spinetab\/([a-z0-9-]+)$/.exec(specifier);
	return match?.[1] !== undefined && rowOfEntry(match[1])
		? match[1]
		: undefined;
}

export function adapterEntryOfPath(path: string): string | undefined {
	const match = /[\\/]spinetab[\\/]dist[\\/]([a-z0-9-]+)\.c?js$/.exec(path);
	return match?.[1] !== undefined && rowOfEntry(match[1])
		? match[1]
		: undefined;
}

/** The plugin-absent wiring module in a client graph means no redirect ran. */
export function isDefaultWiringPath(path: string): boolean {
	return /[\\/]spinetab[\\/]dist[\\/]wiring\.c?js$/.test(path);
}

export function isAutoWiringPath(path: string): boolean {
	return /[\\/]spinetab[\\/]dist[\\/]auto[\\/]wiring\.js$/.test(path);
}

export function isWorkerConfigStubPath(path: string): boolean {
	return /[\\/]spinetab[\\/]dist[\\/]worker-config\.js$/.test(path);
}

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}
