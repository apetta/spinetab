// Scan only for known adapter entries; source text must never enter generated output.

import {
	type Dirent,
	existsSync,
	lstatSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
} from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import {
	ADAPTER_TABLE,
	type AdapterRow,
	compareText,
	rowOfEntry,
	type SpinetabAdapterName,
} from "./adapters.ts";
import { DECLARATION_FILE, type ImportRecord, readImports } from "./lex.ts";
import { relativePosix } from "./paths.ts";

const EXTENSIONS: ReadonlySet<string> = new Set([
	".js",
	".jsx",
	".mjs",
	".cjs",
	".ts",
	".tsx",
	".mts",
	".cts",
	".vue",
	".svelte",
	".astro",
	".mdx",
	".html",
]);

/** Skipped at every depth. */
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
	"node_modules",
	"__tests__",
	"__mocks__",
]);

/**
 * Output and end-to-end directories, skipped only at each scan root's top
 * level: a nested `app/build/` or `src/dist/` is source.
 */
const ROOT_SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
	"dist",
	"build",
	"out",
	"coverage",
	"e2e",
]);

const SKIPPED_FILE = /\.(?:test|spec|stories)\.[^.]+$/;

export interface SourceScan {
	kinds: Set<SpinetabAdapterName>;
	/** Adapter page entries it imports as values (for the peer and graph checks). */
	entries: Set<string>;
	/** Kinds picked by explicit named imports only (tRPC links). */
	named: Set<SpinetabAdapterName>;
	/** Adapter page entries it imports for types only somewhere. */
	typeOnly: Set<string>;
	/** A region could not be closed and was read as literal mentions. */
	fallback: boolean;
}

/** One adapter entry quoted anywhere: the fail-open reading of a region. */
const MENTIONS = ADAPTER_TABLE.map((row) => ({
	row,
	pattern: new RegExp(`["'\`]spinetab/${row.entry}["'\`]`),
}));

/**
 * Scan one file's text; `path` selects the regions by extension. A
 * region that cannot be closed fails open to every entry it quotes.
 */
export function scanSource(code: string, path = ""): SourceScan {
	const scan: SourceScan = {
		kinds: new Set(),
		entries: new Set(),
		named: new Set(),
		typeOnly: new Set(),
		fallback: false,
	};
	if (!code.includes("spinetab/")) return scan;
	const { imports, unread } = readImports(code, path);
	for (const record of imports) add(scan, record);
	for (const text of unread) {
		for (const { row, pattern } of MENTIONS) {
			if (pattern.test(text)) {
				add(scan, {
					specifier: `spinetab/${row.entry}`,
					typeOnly: false,
					names: undefined,
				});
			}
		}
	}
	scan.fallback = unread.length > 0;
	return scan;
}

function add(scan: SourceScan, record: ImportRecord): void {
	// `/runtime` subpaths, `spinetab/worker` and `spinetab/runtime` are
	// worker-side code, never a page request for an adapter.
	const entry = /^spinetab\/([a-z0-9-]+)$/.exec(record.specifier)?.[1];
	const row = entry === undefined ? undefined : rowOfEntry(entry);
	if (!row) return;
	if (record.typeOnly) {
		scan.typeOnly.add(row.entry);
		return;
	}
	scan.entries.add(row.entry);
	const picked = pickedKinds(row, record.names);
	for (const kind of picked) scan.named.add(kind);
	for (const kind of picked.length > 0 ? picked : row.kinds)
		scan.kinds.add(kind);
}

/**
 * tRPC named imports pick a kind. Namespace, dynamic or bare imports, and
 * named lists that pick no link, pick nothing: the caller then takes every
 * kind, since those cannot narrow the set safely.
 */
function pickedKinds(
	row: AdapterRow,
	names: readonly string[] | undefined,
): readonly SpinetabAdapterName[] {
	if (!row.namedImports || names === undefined) return [];
	const imported = new Set(names);
	return row.kinds.filter((kind) => {
		const name = row.namedImports?.[kind];
		return name !== undefined && imported.has(name);
	});
}

export interface ScanResult {
	kinds: readonly SpinetabAdapterName[];
	entries: readonly string[];
	/** Absolute paths of files read by fallback. */
	fallbacks: readonly string[];
}

export interface ScanOptions {
	/** Absolute directories never walked (the resolved output directory). */
	excludes?: readonly string[];
}

export function scanRoots(
	roots: readonly string[],
	options: ScanOptions = {},
): ScanResult {
	const kinds = new Set<SpinetabAdapterName>();
	const entries = new Set<string>();
	const fallbacks = new Set<string>();
	const excludes = new Set((options.excludes ?? []).map((dir) => resolve(dir)));
	const walk = (dir: string, top: boolean): void => {
		let items: Dirent[];
		try {
			items = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const item of items) {
			const name = String(item.name);
			const path = join(dir, name);
			// Symlinks are never followed out of a root; declared workspace
			// dependencies are separate roots.
			if (item.isSymbolicLink()) continue;
			if (item.isDirectory()) {
				if (
					name.startsWith(".") ||
					SKIPPED_DIRECTORIES.has(name) ||
					(top && ROOT_SKIPPED_DIRECTORIES.has(name))
				) {
					continue;
				}
				if (excludes.has(path)) continue;
				walk(path, false);
			} else if (
				item.isFile() &&
				EXTENSIONS.has(extname(name)) &&
				!SKIPPED_FILE.test(name) &&
				// Declarations emit no code.
				!DECLARATION_FILE.test(name)
			) {
				let code: string;
				try {
					code = readFileSync(path, "utf8");
				} catch {
					continue;
				}
				const result = scanSource(code, name);
				for (const kind of result.kinds) kinds.add(kind);
				for (const entry of result.entries) entries.add(entry);
				if (result.fallback) fallbacks.add(path);
			}
		}
	};
	for (const root of roots) walk(resolve(root), true);
	return {
		kinds: [...kinds].sort(compareText),
		entries: [...entries].sort(compareText),
		fallbacks: [...fallbacks].sort(compareText),
	};
}

/**
 * The project root plus every dependency of its `package.json` whose real
 * path (from the nearest `node_modules` link) lies outside `node_modules` and whose own manifest lists `spinetab` in
 * `dependencies` or `peerDependencies` (linked workspace packages).
 */
export function scanRootsFor(root: string): string[] {
	const roots = [resolve(root)];
	const manifest = readManifest(join(root, "package.json"));
	if (!manifest) return roots;
	const names = new Set([
		...Object.keys(asRecord(manifest.dependencies)),
		...Object.keys(asRecord(manifest.devDependencies)),
	]);
	const found: string[] = [];
	for (const name of [...names].sort(compareText)) {
		if (name === "spinetab") continue;
		// npm, Yarn and Bun workspaces hoist the link to an ancestor's
		// `node_modules`; Node resolves the nearest one, and so does this.
		const link = installedPath(root, name);
		if (link === undefined) continue;
		let real: string;
		try {
			if (!lstatSync(link).isSymbolicLink()) continue;
			real = realpathSync(link);
		} catch {
			continue;
		}
		if (real.split(sep).includes("node_modules")) continue;
		const dependency = readManifest(join(real, "package.json"));
		if (!dependency) continue;
		if (
			"spinetab" in asRecord(dependency.dependencies) ||
			"spinetab" in asRecord(dependency.peerDependencies)
		) {
			found.push(real);
		}
	}
	return [...roots, ...found];
}

/** The nearest `node_modules/<name>` entry from `root` upwards, unfollowed. */
function installedPath(root: string, name: string): string | undefined {
	let dir = resolve(root);
	for (;;) {
		const candidate = join(dir, "node_modules", ...name.split("/"));
		try {
			lstatSync(candidate);
			return candidate;
		} catch {}
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/** Workspace roots scan whole, including `dist` (built libraries keep imports). */
export function scanProject(
	roots: readonly string[],
	options: ScanOptions = {},
): ScanResult {
	const [project, ...workspaces] = roots;
	const kinds = new Set<SpinetabAdapterName>();
	const entries = new Set<string>();
	const fallbacks = new Set<string>();
	const merge = (result: ScanResult) => {
		for (const kind of result.kinds) kinds.add(kind);
		for (const entry of result.entries) entries.add(entry);
		for (const file of result.fallbacks) fallbacks.add(file);
	};
	if (project !== undefined) merge(scanRoots([project], options));
	for (const workspace of workspaces) {
		merge(scanRoots([workspace], options));
		const dist = join(workspace, "dist");
		if (existsSync(dist)) merge(scanDist(dist));
	}
	return {
		kinds: [...kinds].sort(compareText),
		entries: [...entries].sort(compareText),
		fallbacks: [...fallbacks].sort(compareText),
	};
}

/** A workspace package's `dist`, which the ordinary walk skips by name. */
function scanDist(dist: string): ScanResult {
	return scanRoots([dist]);
}

/**
 * Whether `peer` resolves from `root` by Node's lookup (each ancestor's
 * `node_modules`). Reads the file system only; never imports the peer.
 */
export function peerResolves(root: string, peer: string): boolean {
	let dir = resolve(root);
	for (;;) {
		const candidate = join(dir, "node_modules", ...peer.split("/"));
		try {
			if (statSync(join(candidate, "package.json")).isFile()) return true;
		} catch {}
		const parent = dirname(dir);
		if (parent === dir) return false;
		dir = parent;
	}
}

export interface InferredSet {
	kinds: readonly SpinetabAdapterName[];
	entries: readonly string[];
	missingPeers: readonly { kind: SpinetabAdapterName; peer: string }[];
	/** Files read by fallback, relative to the project root, POSIX. */
	fallbacks: readonly string[];
}

export function inferAdapters(
	roots: readonly string[],
	options: ScanOptions = {},
): InferredSet {
	const result = scanProject(roots, options);
	const project = roots[0] ?? ".";
	const kinds: SpinetabAdapterName[] = [];
	const missingPeers: { kind: SpinetabAdapterName; peer: string }[] = [];
	for (const kind of result.kinds) {
		const row = ADAPTER_TABLE.find((candidate) =>
			candidate.kinds.includes(kind),
		);
		if (row?.peer && !peerResolves(project, row.peer)) {
			missingPeers.push({ kind, peer: row.peer });
			continue;
		}
		kinds.push(kind);
	}
	return {
		kinds,
		entries: result.entries,
		missingPeers,
		fallbacks: result.fallbacks
			.map((file) => relativePosix(project, file))
			.sort(compareText),
	};
}

function readManifest(path: string): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		return value && typeof value === "object"
			? (value as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: {};
}
