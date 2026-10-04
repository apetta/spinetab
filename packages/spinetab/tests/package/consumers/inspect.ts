import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { allowedAreas, areaOf, ENTRY_RULES } from "../allowlist.ts";
import {
	type ConsumerSpec,
	forbiddenPackages,
	isPluginRecipe,
	MONOREPO_WORKER,
	matchesPackage,
	recipeOf,
} from "./catalogue.ts";
import {
	createGeneratedClassifier,
	devTextLocalPaths,
	emptyMapForm,
	type GeneratedFile,
	type GeneratedShape,
	type GeneratedWorker,
	type InstalledFiles,
	LOCAL_PATH,
	localPathsIn,
	NEXT_IGNORED_MODULE,
	parseGeneratedWorker,
	ruleInputFile,
	spinetabDevModules,
	wiringCopyProblems,
} from "./generated.ts";

/**
 * Isolation inspection of consumer output.
 * Two steps, never minified identifiers:
 * 1. each emitted chunk's sourcemap names the installed files it contains.
 * Regular maps and index maps (`sections`, walked in offset order) are
 * decoded per ECMA-426: `sourceRoot` is prepended and each source resolved
 * against the map's URL (§9.3, §10). A Spinetab path is
 * `…/spinetab/dist/<f>` (installed file) or `…/spinetab/src/<f>` (a
 * library map the bundler composed in), directly or through the pnpm
 * virtual store; other `node_modules/<pkg>/…` paths are peers;
 * 2. each Spinetab dist file maps to source areas through its own map.
 * Rule: unselected Spinetab areas and unselected peers are absent from every
 * chunk. The realm (page, worker, fallback, shared) comes from the
 * bundler's own graph (`readChunkGraph`), never from file names; it names
 * the chunks the browser cells check, and does not affect the verdict.
 *
 * Fail closed: a map form the walker does not support, a Spinetab-looking
 * path it cannot classify, an application source it cannot read, and an
 * exercised Spinetab import with no Spinetab attribution are chunk problems
 * that fail the chunk. A chunk without any map, or whose map is empty for
 * non-empty code, needs positive provenance (`generated.ts`: an installed file
 * copied verbatim, or a narrow generated shape the options enable). Classified
 * files are listed in `generated` with that provenance; anything else is
 * `unmapped` (or keeps its chunk problem) and fails the report.
 */

export type Realm = "page" | "worker" | "fallback" | "shared" | "dev-deps";

export type SourceKind =
	| { kind: "spinetab"; distFile: string }
	/** A Spinetab source composed into the consumer map, `src/…`. */
	| { kind: "spinetab-source"; source: string }
	| { kind: "package"; name: string }
	| { kind: "app"; path: string }
	/** Looks like Spinetab but is neither `dist/` nor `src/`: fails closed. */
	| { kind: "unclassified"; reason: string }
	| { kind: "other" };

export interface ChunkReport {
	consumer: string;
	bundler: string;
	variant: string;
	chunk: string;
	realm: Realm;
	bytes: number;
	gzip: number;
	spinetab: string[];
	/** Installed dist files (`<f>`) and composed sources (`src/<f>`). */
	spinetabFiles: string[];
	/** Application files the chunk's map names (`classifySource`). */
	appFiles: string[];
	peers: string[];
	/** Spinetab specifiers the chunk's application sources import (values). */
	exercised: string[];
	unexpected: { spinetab: string[]; peers: string[] };
	/** Reasons the chunk could not be verified; any entry fails it. */
	problems: string[];
	verdict: "pass" | "fail";
}

export interface IsolationReport {
	consumer: string;
	bundler: string;
	variant: string;
	outDir: string;
	chunks: ChunkReport[];
	/** Emitted JS without a resolvable sourcemap: isolation cannot be shown. */
	unmapped: string[];
	/** Unattributed JS with positive provenance (`generated.ts`). */
	generated: GeneratedFile[];
	/** Server-realm files naming an unselected package (Next). */
	serverMentions: Array<{ file: string; packages: string[] }>;
	/**
	 * Plugin cells: server-graph files holding worker code, generated workers found in the client maps, development
	 * worker names, and local paths in development output.
	 */
	plugin?: {
		serverWorkerCode: Array<{ file: string; markers: string[] }>;
		generated: GeneratedWorker[];
		wiringHashes: string[];
		localPaths: Array<{ chunk: string; paths: string[] }>;
		/**
		 * Next `--webpack`'s own ignored-module source name, which embeds the
		 * absolute path of Next's loader directory in every build, with or
		 * without Spinetab (`NEXT_IGNORED_MODULE`). Recorded, not failed.
		 */
		frameworkPaths: Array<{ chunk: string; source: string }>;
		/**
		 * Development output only: map sources naming a local path. `next dev`
		 * writes absolute `file:` sources for every module, with or without
		 * Spinetab; they are bundler metadata, counted here, not failed.
		 * covers the Spinetab modules' code (`spinetabDevModules`) and the
		 * generated worker's content.
		 */
		devMapPaths?: number;
	};
	/**
	 * Emitted bytes per realm, plus `generated` (present only when some file
	 * has positive provenance) so the output total is complete without
	 * attributing generated files to a Spinetab realm.
	 */
	sizes: Record<string, { raw: number; gzip: number; files: number }>;
	verdict: "pass" | "fail";
}

/** One `sources` entry after ECMA-426 §9.3 resolution. */
export interface MapSource {
	/** The entry with `sourceRoot` prepended. */
	raw: string;
	/** `raw` resolved against the map's URL: a path for file URLs, else a URL. */
	resolved: string;
	content: string | null;
}

export interface DecodedMap {
	sources: MapSource[];
	problems: string[];
}

/** Index maps nested deeper than this are reported, not walked. */
const MAX_SECTION_DEPTH = 4;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isIndex = (value: unknown): value is number =>
	Number.isInteger(value) && (value as number) >= 0;

/** Resolve one prefixed source against the map's URL (ECMA-426 §9.3.1). */
export function resolveSource(raw: string, mapUrl: URL): string {
	let url: URL;
	try {
		url = new URL(raw, mapUrl);
	} catch {
		return raw;
	}
	if (url.protocol === "file:") {
		return fileURLToPath(url).replace(/\\/g, "/");
	}
	let path = url.pathname;
	try {
		path = decodeURIComponent(path);
	} catch {
		// Keep the encoded form; classification still sees the segments.
	}
	return `${url.protocol}//${url.host}${path}`;
}

/**
 * Walk a regular or index map (ECMA-426 §9, §10). `mapPath` is the file the
 * sources resolve against (the chunk itself for inline maps).
 * `generatedLines` bounds section offsets when known.
 */
export function decodeMap(
	json: unknown,
	mapPath: string,
	generatedLines?: number,
): DecodedMap {
	const sources: MapSource[] = [];
	const problems: string[] = [];
	const mapUrl = pathToFileURL(mapPath);

	const visit = (value: unknown, where: string, depth: number): void => {
		if (!isRecord(value)) {
			problems.push(`${where}: not a JSON object`);
			return;
		}
		if (value.version !== 3) {
			problems.push(
				`${where}: unsupported version ${JSON.stringify(value.version)} (ECMA-426 requires 3)`,
			);
			return;
		}
		if ("sections" in value) {
			visitSections(value, where, depth);
			return;
		}
		if (!Array.isArray(value.sources)) {
			problems.push(`${where}: neither a sources array nor sections`);
			return;
		}
		if (typeof value.mappings !== "string") {
			problems.push(`${where}: mappings is not a string`);
		}
		const root = value.sourceRoot;
		if (root !== undefined && root !== null && typeof root !== "string") {
			problems.push(`${where}: sourceRoot is not a string`);
			return;
		}
		// §9.3.1: a root not ending in "/" gains one. An empty root is treated
		// as absent, as mainstream consumers do.
		const prefix =
			typeof root === "string" && root !== ""
				? root.endsWith("/")
					? root
					: `${root}/`
				: "";
		const contents = Array.isArray(value.sourcesContent)
			? value.sourcesContent
			: [];
		value.sources.forEach((source: unknown, index: number) => {
			// Null sources name no file (§9.3.1); their code is unattributed.
			if (source === null) return;
			if (typeof source !== "string") {
				problems.push(`${where}.sources[${index}]: not a string or null`);
				return;
			}
			const raw = `${prefix}${source}`;
			const content = contents[index];
			sources.push({
				raw,
				resolved: resolveSource(raw, mapUrl),
				content: typeof content === "string" ? content : null,
			});
		});
	};

	const visitSections = (
		value: Record<string, unknown>,
		where: string,
		depth: number,
	): void => {
		const sections = value.sections;
		if (!Array.isArray(sections) || sections.length === 0) {
			problems.push(`${where}: sections is not a non-empty array`);
			return;
		}
		// ECMA-426 §10 index maps carry sections only. Turbopack also writes
		// `"sources": []`; an empty array names nothing, so the sections are
		// consumed as usual (§9.4, §10.1). Anything else stays ambiguous.
		const sources = value.sources;
		if (
			"sources" in value &&
			!(Array.isArray(sources) && sources.length === 0)
		) {
			problems.push(
				`${where}: index map also has non-empty sources (ECMA-426 §10)`,
			);
		}
		if ("mappings" in value) {
			problems.push(`${where}: index map also has mappings (ECMA-426 §10)`);
		}
		if (depth >= MAX_SECTION_DEPTH) {
			problems.push(`${where}: index maps nested deeper than ${depth}`);
			return;
		}
		let previous: [number, number] | undefined;
		sections.forEach((section: unknown, index: number) => {
			const at = `${where}.sections[${index}]`;
			if (!isRecord(section)) {
				problems.push(`${at}: not a JSON object`);
				return;
			}
			const offset = section.offset;
			if (
				!isRecord(offset) ||
				!isIndex(offset.line) ||
				!isIndex(offset.column)
			) {
				problems.push(`${at}: offset needs non-negative integer line/column`);
			} else {
				const { line, column } = offset;
				if (
					previous &&
					(line < previous[0] || (line === previous[0] && column < previous[1]))
				) {
					problems.push(
						`${at}: offset ${line}:${column} precedes the previous section (sections must be sorted)`,
					);
				}
				if (generatedLines !== undefined && line >= generatedLines) {
					problems.push(
						`${at}: offset line ${line} is beyond the generated file (${generatedLines} lines)`,
					);
				}
				previous = [line, column];
			}
			if (!("map" in section)) {
				problems.push(
					`${at}: no embedded map${"url" in section ? " (url sections are not supported)" : ""}`,
				);
				return;
			}
			visit(section.map, `${at}.map`, depth + 1);
		});
	};

	visit(json, "map", 0);
	return { sources, problems };
}

const clean = (path: string) =>
	path
		.replace(/\\/g, "/")
		.replace(/^[a-z][a-z0-9+.-]*:\/\/\/?(\[project\]\/)?/i, "")
		.replace(/[?#].*$/, "");

/** `dist/<f>` or `src/<f>` below a Spinetab package root. */
function packagePath(sub: string, path: string): SourceKind {
	if (sub.startsWith("dist/") && sub.length > 5) {
		return { kind: "spinetab", distFile: ruleInputFile(sub.slice(5)) };
	}
	if (sub.startsWith("src/") && sub.length > 4) {
		return { kind: "spinetab-source", source: sub };
	}
	return {
		kind: "unclassified",
		reason: `Spinetab path outside dist/ and src/: ${path}`,
	};
}

function spinetabKind(path: string): SourceKind | undefined {
	const at = path.lastIndexOf("node_modules/");
	if (at >= 0) {
		const rest = path.slice(at + "node_modules/".length);
		if (rest === "spinetab" || rest.startsWith("spinetab/")) {
			return packagePath(rest.slice("spinetab/".length), path);
		}
	}
	// Composed or relocated paths without node_modules, and pnpm store dirs.
	const bare = /^(?:.*\/)?spinetab(?:@[^/]*)?\/((?:dist|src)\/.+)$/.exec(path);
	if (bare?.[1]) return packagePath(bare[1], path);
	if (/(?:^|\/)spinetab@[^/]*(?:\/|$)/.test(path)) {
		return {
			kind: "unclassified",
			reason: `pnpm store path without spinetab/dist or spinetab/src: ${path}`,
		};
	}
	return undefined;
}

/** Application sources: `src/` or `app/`, and next-monorepo's L2 worker file. */
const APP_SOURCE = new RegExp(
	`(?:^|/)((?:src|app)/[^?#]+|${MONOREPO_WORKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})$`,
);

/**
 * Classify one consumer-map source. `source` is the entry with `sourceRoot`
 * prepended; `resolved` is it resolved against the map's URL. Spinetab and
 * peer paths are read from both; application paths from `source` only, so the
 * output's own location never names an application directory.
 */
export function classifySource(raw: string, resolved = raw): SourceKind {
	const source = clean(raw);
	const path = clean(resolved);
	const spinetab = spinetabKind(path) ?? spinetabKind(source);
	if (spinetab) return spinetab;
	for (const candidate of [path, source]) {
		const at = candidate.lastIndexOf("node_modules/");
		if (at < 0) continue;
		const rest = candidate.slice(at + "node_modules/".length);
		const parts = rest.split("/");
		const name = rest.startsWith("@")
			? `${parts[0]}/${parts[1] ?? ""}`
			: (parts[0] ?? "");
		// `.pnpm`, `.vite` and other dot directories are not packages.
		if (name && !name.startsWith(".")) return { kind: "package", name };
	}
	const app = APP_SOURCE.exec(source);
	if (app?.[1]) return { kind: "app", path: app[1] };
	return { kind: "other" };
}

const SPECIFIER = `["'](spinetab(?:/[^"'\\s]*)?)["']`;
const IMPORT_PATTERNS = [
	new RegExp(
		`\\bimport\\s+(?!type[\\s{*])([^'";]*?)\\bfrom\\s*${SPECIFIER}`,
		"g",
	),
	new RegExp(
		`\\bexport\\s+(?!type[\\s{*])([^'";]*?)\\bfrom\\s*${SPECIFIER}`,
		"g",
	),
	new RegExp(`\\bimport()\\s*${SPECIFIER}`, "g"),
	new RegExp(`\\bimport\\s*\\(()\\s*${SPECIFIER}`, "g"),
	new RegExp(`\\brequire\\s*\\(()\\s*${SPECIFIER}`, "g"),
];

/** Spinetab specifiers a source imports as values (type-only imports skipped). */
export function spinetabImports(text: string): string[] {
	const found = new Set<string>();
	for (const pattern of IMPORT_PATTERNS) {
		for (const match of text.matchAll(pattern)) {
			const clause = (match[1] ?? "").trim();
			const named = /^\{([^}]*)\}$/.exec(clause)?.[1];
			const items = named
				?.split(",")
				.map((item) => item.trim())
				.filter(Boolean);
			const typeOnly =
				items !== undefined &&
				items.length > 0 &&
				items.every((item) => item.startsWith("type "));
			if (!typeOnly) found.add(match[2] as string);
		}
	}
	return [...found].sort();
}

/** `spinetab/x` → `./x`, `spinetab` → `.`. */
const entryOf = (specifier: string) =>
	specifier === "spinetab" ? "." : `./${specifier.slice("spinetab/".length)}`;

/**
 * A chunk's place in the bundler's own graph: loaded by
 * the `new SharedWorker(new URL(…))` entry, by a dynamic `import()`, or both.
 */
export interface ChunkRole {
	worker: boolean;
	lazy: boolean;
}

/**
 * Chunk roles read from the bundler's output, never from file names, so one
 * module serving as both the worker entry and the lazy local runtime
 * (`defineWorker`) is told apart by where the bundler put it:
 * - Vite: `.vite/manifest.json`. Worker bundles are the JS `assets` of the
 * chunk that constructs them; the lazy chunks are the `dynamicImports`
 * closure outside the entries' static closure.
 * - webpack and Rspack: every entry chunk carries the bundler's bootstrap
 * (`webpack/bootstrap` or `webpack/runtime/*` in its own map). The page
 * entry is the one the emitted HTML loads; any other entry chunk is a
 * worker entry. A chunk without the bootstrap is loaded on demand, by the
 * page or by a worker entry, which only a stats file would tell apart; so
 * only on-demand chunks holding application code count as lazy, and split
 * vendor chunks keep the default realm. Plugin recipes add the chunks the
 * bundled `auto/wiring.js` loads from its `local` factory, by chunk id.
 * - Next (Turbopack production): the worker helper names its chunk list
 * (`"…/turbopack-worker-….js", [chunks]`) and each async loader names its
 * own (`Promise.all([chunks].map(…))`).
 */
export interface ChunkGraph {
	worker: ReadonlySet<string>;
	lazy: ReadonlySet<string>;
}

/** What `readChunkGraph` needs of one emitted chunk. */
export interface GraphChunk {
	/** Path relative to the output directory. */
	chunk: string;
	text: string;
	/** Its sourcemap's sources, as listed. */
	sources: readonly string[];
	/** The application files among them (`classifySource`). */
	appFiles: readonly string[];
}

const JS_FILE = /\.m?js$/;

/** Output-relative path of a URL-ish reference from a file in `fromDir`. */
function outputPath(reference: string, fromDir: string): string | undefined {
	const bare = reference.replace(/[?#].*$/, "");
	if (bare === "" || /^[a-z][a-z0-9+.-]*:/i.test(bare)) return undefined;
	const joined = bare.startsWith("/")
		? bare.slice(1)
		: join(fromDir, bare).replace(/\\/g, "/");
	return joined.replace(/^\.\//, "");
}

/** Vite's build manifest (`build.manifest: true`). */
export function viteGraph(manifestJson: unknown): ChunkGraph | undefined {
	if (!isRecord(manifestJson)) return undefined;
	type Entry = {
		file?: unknown;
		isEntry?: unknown;
		imports?: unknown;
		dynamicImports?: unknown;
		assets?: unknown;
	};
	const manifest = manifestJson as Record<string, Entry>;
	const list = (value: unknown): string[] =>
		Array.isArray(value)
			? value.filter((item): item is string => typeof item === "string")
			: [];
	const closure = (keys: readonly string[]): Set<string> => {
		const files = new Set<string>();
		const seen = new Set<string>();
		const visit = (key: string) => {
			if (seen.has(key)) return;
			seen.add(key);
			const entry = manifest[key];
			if (!isRecord(entry)) return;
			if (typeof entry.file === "string") files.add(entry.file);
			for (const next of list(entry.imports)) visit(next);
		};
		for (const key of keys) visit(key);
		return files;
	};
	const entries = Object.keys(manifest).filter(
		(key) => manifest[key]?.isEntry === true,
	);
	const page = closure(entries);
	const dynamic = Object.values(manifest).flatMap((entry) =>
		isRecord(entry) ? list(entry.dynamicImports) : [],
	);
	const lazy = new Set([...closure(dynamic)].filter((file) => !page.has(file)));
	const worker = new Set(
		Object.values(manifest)
			.flatMap((entry) => (isRecord(entry) ? list(entry.assets) : []))
			.filter((file) => JS_FILE.test(file)),
	);
	return { worker, lazy };
}

const BOOTSTRAP = /(?:^|\/)webpack\/(?:bootstrap|runtime\/)/;
const SCRIPT_SRC =
	/<script\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

const AUTO_WIRING =
	/(?:^|\/)spinetab(?:@[^/]*)?\/(?:.*\/)?dist\/auto\/wiring\.js(?:\.js)?$/;
/**
 * The bundled wiring object: the worker factory, then `local`'s chunk loads
 * up to its `.then(`. webpack and Rspack compile the worker URL to a
 * run-time `__webpack_require__.u(<id>)`, so no literal names the chunks.
 */
const WIRING_LOCAL =
	/new SharedWorker\(\s*new URL\([\s\S]{0,400}?\blocal\s*:\s*\(\s*\)\s*=>([\s\S]{0,600}?)\.then\(/g;
const CHUNK_LOAD =
	/\.e\(\s*(?:\/\*[\s\S]*?\*\/\s*)?(\d+|"[^"\\]+"|'[^'\\]+')\s*\)/g;
/** A JSONP chunk's own ids: `(self.webpackChunk…||[]).push([[<ids>], …`. */
const CHUNK_IDS = /^[\s\S]{0,300}?\.push\(\s*\[\s*\[([^\]]*)\]\s*,/;
const chunkIds = (list: string) =>
	[...list.matchAll(/\d+|"[^"\\]+"|'[^'\\]+'/g)].map((match) =>
		match[0].replace(/^["']|["']$/g, ""),
	);

/**
 * Plugin recipes on webpack and Rspack: the chunks the shipped wiring's
 * `local: () => import("./worker.js")` loads (`auto/wiring.js`'s
 * `__webpack_require__.e(<id>)` calls), found by their declared chunk ids.
 * They hold only Spinetab and generated code, so `appFiles` cannot mark them.
 */
export function wiringLazyChunks(chunks: readonly GraphChunk[]): Set<string> {
	const wanted = new Set<string>();
	for (const { text, sources } of chunks) {
		if (!sources.some((source) => AUTO_WIRING.test(clean(source)))) continue;
		for (const match of text.matchAll(WIRING_LOCAL)) {
			for (const load of (match[1] as string).matchAll(CHUNK_LOAD)) {
				wanted.add(chunkIds(load[1] as string)[0] as string);
			}
		}
	}
	const lazy = new Set<string>();
	if (wanted.size === 0) return lazy;
	for (const { chunk, text } of chunks) {
		const ids = CHUNK_IDS.exec(text)?.[1];
		if (ids !== undefined && chunkIds(ids).some((id) => wanted.has(id))) {
			lazy.add(chunk);
		}
	}
	return lazy;
}

/**
 * webpack and Rspack: entry chunks by their bootstrap, the page entry by the
 * HTML files (`html` maps each output-relative HTML path to its text). For
 * plugin recipes the chunks the shipped wiring loads lazily are `lazy` too
 * (`wiringLazyChunks`); L1 recipes keep the application-file rule alone.
 */
export function webpackGraph(
	chunks: readonly GraphChunk[],
	html: ReadonlyMap<string, string>,
	plugin = false,
): ChunkGraph {
	const loaded = new Set<string>();
	for (const [file, text] of html) {
		const dir = dirname(file);
		for (const match of text.matchAll(SCRIPT_SRC)) {
			const src = match[1] ?? match[2] ?? match[3] ?? "";
			const path = outputPath(src, dir === "." ? "" : dir);
			if (path) loaded.add(path);
		}
	}
	const worker = new Set<string>();
	const lazy = plugin ? wiringLazyChunks(chunks) : new Set<string>();
	for (const { chunk, sources, appFiles } of chunks) {
		const entry = sources.some((source) => BOOTSTRAP.test(source));
		if (!entry) {
			if (appFiles.length > 0) lazy.add(chunk);
		} else if (!loaded.has(chunk)) worker.add(chunk);
	}
	// An entry chunk is never loaded on demand.
	for (const chunk of worker) lazy.delete(chunk);
	return { worker, lazy };
}

const TURBOPACK_WORKER =
	/["']([^"']*turbopack-worker-[^"']*\.js)["']\s*,\s*\[([^\]]*)\]/g;
const TURBOPACK_LAZY = /Promise\.all\(\s*\[([^\]]*)\]\s*\.map\(/g;
const quoted = (list: string) =>
	[...list.matchAll(/["']([^"']+)["']/g)].map((match) => match[1] as string);

/** Next with Turbopack (production): chunk lists named in emitted code. */
export function turbopackGraph(chunks: readonly GraphChunk[]): ChunkGraph {
	const worker = new Set<string>();
	const lazy = new Set<string>();
	for (const { text } of chunks) {
		for (const match of text.matchAll(TURBOPACK_WORKER)) {
			for (const file of quoted(match[2] ?? "")) worker.add(file);
		}
		for (const match of text.matchAll(TURBOPACK_LAZY)) {
			for (const file of quoted(match[1] ?? "")) {
				if (JS_FILE.test(file)) lazy.add(file);
			}
		}
	}
	return { worker, lazy };
}

/** The graph for one output, or undefined when the bundler left none. */
export function readChunkGraph(
	bundler: string,
	outDir: string,
	chunks: readonly GraphChunk[],
	plugin = false,
): ChunkGraph | undefined {
	switch (bundler) {
		case "vite": {
			const path = join(outDir, ".vite/manifest.json");
			if (!existsSync(path)) return undefined;
			try {
				return viteGraph(JSON.parse(readFileSync(path, "utf8")));
			} catch {
				return undefined;
			}
		}
		case "webpack":
		case "rspack": {
			const html = new Map<string, string>();
			if (existsSync(outDir)) {
				for (const name of readdirSync(outDir)) {
					if (name.endsWith(".html")) {
						html.set(name, readFileSync(join(outDir, name), "utf8"));
					}
				}
			}
			// Without the HTML there is no page entry to tell from a worker's.
			return html.size > 0 ? webpackGraph(chunks, html, plugin) : undefined;
		}
		case "next":
			return turbopackGraph(chunks);
		case "astro": {
			const path = join(outDir, ".vite/manifest.json");
			if (existsSync(path)) {
				try {
					return viteGraph(JSON.parse(readFileSync(path, "utf8")));
				} catch {
					return pluginGraph(chunks);
				}
			}
			return pluginGraph(chunks);
		}
		case "next-webpack":
			return pluginGraph(chunks);
		default:
			return undefined;
	}
}

const AUTO_WORKER =
	/(?:^|\/)spinetab(?:@[^/]*)?\/(?:.*\/)?dist\/auto\/worker\.js$/;
/**
 * An L2 worker file: the conventional `spinetab.worker.*` or a one-file
 * `live.worker.*` below `src/` or `app/`, or `next-monorepo`'s file named
 * through the `worker` option (`MONOREPO_WORKER`).
 */
const L2_WORKER = new RegExp(
	`(?:^|/)(?:(?:src|app)/(?:.*/)?(?:spinetab\\.worker|live\\.worker)\\.(?:m?[jt]s)|${MONOREPO_WORKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})$`,
);
/** The URL literal in any quote form: Rolldown emits a template literal. */
const LITERAL_WORKER =
	/new SharedWorker\(\s*new URL\(\s*(["'`])([^"'`]+\.m?js)\1/g;

/**
 * Every literal worker URL (`new SharedWorker(new URL(<literal>, …))`) in
 * `text`, whatever it ends with, so a query or hash is seen.
 */
export function workerUrlLiterals(text: string): string[] {
	return [
		...text.matchAll(/new SharedWorker\(\s*new URL\(\s*(["'`])([^"'`]*)\1/g),
	].map((match) => match[2] as string);
}

/**
 * Plugin outputs without a bundler graph file (Astro without a manifest,
 * Next `--webpack`): the chunk holding the keep stub (or the L2 worker file)
 * is the worker entry when it carries the webpack bootstrap or is named by a
 * literal worker URL, and the lazy local chunk otherwise.
 */
export function pluginGraph(chunks: readonly GraphChunk[]): ChunkGraph {
	const worker = new Set<string>();
	const lazy = new Set<string>();
	const named = new Set<string>();
	for (const { chunk, text } of chunks) {
		const dir = dirname(chunk);
		for (const match of text.matchAll(LITERAL_WORKER)) {
			const path = outputPath(match[2] as string, dir === "." ? "" : dir);
			if (path) named.add(path);
		}
	}
	for (const { chunk, sources } of chunks) {
		const holds = sources.some(
			(source) => AUTO_WORKER.test(source) || L2_WORKER.test(source),
		);
		if (!holds) continue;
		const entry =
			named.has(chunk) || sources.some((source) => BOOTSTRAP.test(source));
		(entry ? worker : lazy).add(chunk);
	}
	return { worker, lazy };
}

/** A chunk's role in `graph`, or undefined when there is no graph. */
export function roleOf(
	graph: ChunkGraph | undefined,
	chunk: string,
): ChunkRole | undefined {
	return graph
		? { worker: graph.worker.has(chunk), lazy: graph.lazy.has(chunk) }
		: undefined;
}

/**
 * Realm of a chunk. Only the bundler's graph makes the worker and fallback
 * realms: a lazily imported chunk is `fallback`, as a page fetches it only
 * when it cannot share, even when the worker loads it too (Turbopack emits
 * the one-file module once, for both); a chunk only the worker entry loads
 * is `worker`. Page chunks are recognised by their application files; any
 * other chunk keeps the default.
 */
export function realmOf(
	appFiles: readonly string[],
	role: ChunkRole | undefined,
	fallback: Realm,
): Realm {
	if (role?.lazy) return "fallback";
	if (role?.worker) return "worker";
	if (
		appFiles.some((file) =>
			/(^|\/)(main|page|layout|live|live-view|chat-view)\.[jt]sx?$/.test(file),
		)
	) {
		return "page";
	}
	return fallback;
}

/**
 * Areas of one installed Spinetab dist file, through its own map or regions.
 * Anything that cannot be attributed yields a non-area marker (`missing:`,
 * `invalid-map:`, `unmapped:`, `unknown:`) that no entry allows.
 */
export function createDistResolver(
	installedDist: string,
): (distFile: string) => string[] {
	const packageRoot = dirname(installedDist);
	const cache = new Map<string, string[]>();
	return (distFile) => {
		const cached = cache.get(distFile);
		if (cached) return cached;
		const areas = new Set<string>();
		const mapPath = join(installedDist, `${distFile}.map`);
		if (existsSync(mapPath)) {
			let json: unknown;
			try {
				json = JSON.parse(readFileSync(mapPath, "utf8"));
			} catch {
				areas.add(`invalid-map:${distFile}: not JSON`);
			}
			if (json !== undefined) {
				const decoded = decodeMap(json, mapPath);
				for (const problem of decoded.problems) {
					areas.add(`invalid-map:${distFile}: ${problem}`);
				}
				for (const source of decoded.sources) {
					const path = isAbsolute(source.resolved)
						? relative(packageRoot, source.resolved).replace(/\\/g, "/")
						: source.raw;
					areas.add(areaOf(path) ?? `unknown:${path}`);
				}
			}
			if (areas.size === 0) areas.add(`unmapped:${distFile}`);
		} else if (existsSync(join(installedDist, distFile))) {
			const text = readFileSync(join(installedDist, distFile), "utf8");
			for (const match of text.matchAll(/\/\/#region (src\/\S+)/g)) {
				const path = (match[1] as string).replace(/\.d\.ts$/, ".ts");
				areas.add(areaOf(path) ?? `unknown:${path}`);
			}
			if (areas.size === 0) areas.add(`unmapped:${distFile}`);
		} else {
			areas.add(`missing:${distFile}`);
		}
		const result = [...areas].sort();
		cache.set(distFile, result);
		return result;
	};
}

export function listChunks(outDir: string): string[] {
	const files: string[] = [];
	const walk = (dir: string) => {
		if (!existsSync(dir)) return;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (/\.(m|c)?js$/.test(entry.name)) files.push(path);
		}
	};
	walk(outDir);
	return files.sort();
}

/**
 * A chunk's map: `sourceMappingURL` (file or data URL) or `<chunk>.map`.
 * `base` is what its sources resolve against: the map file, or the chunk for
 * an inline map. Unreadable maps carry `error` instead of `json`.
 */
export type ChunkMap =
	| { base: string; json: unknown }
	| { base: string; error: string };

export function readChunkMap(chunkPath: string): ChunkMap | undefined {
	const text = readFileSync(chunkPath, "utf8");
	const matches = [...text.matchAll(/[#@] sourceMappingURL=(\S+)/g)];
	const reference = matches.at(-1)?.[1];
	const parse = (base: string, read: () => string): ChunkMap => {
		try {
			return { base, json: JSON.parse(read()) };
		} catch (error) {
			return {
				base,
				error: `unreadable sourcemap: ${(error as Error).message}`,
			};
		}
	};
	if (reference?.startsWith("data:")) {
		return parse(chunkPath, () => {
			const comma = reference.indexOf(",");
			const payload = reference.slice(comma + 1);
			return reference.slice(0, comma).includes(";base64")
				? Buffer.from(payload, "base64").toString("utf8")
				: decodeURIComponent(payload);
		});
	}
	const candidates = [
		...(reference
			? [join(dirname(chunkPath), decodeURIComponent(reference))]
			: []),
		`${chunkPath}.map`,
	];
	for (const candidate of candidates) {
		if (existsSync(candidate) && statSync(candidate).isFile()) {
			return parse(candidate, () => readFileSync(candidate, "utf8"));
		}
	}
	return undefined;
}

export interface InspectOptions {
	spec: ConsumerSpec;
	bundler: string;
	variant: string;
	outDir: string;
	/** Realpath of the consumer's installed `node_modules/spinetab/dist`. */
	installedDist: string;
	/** Directories below `outDir` to walk (default: all of it). */
	dirs?: string[];
	/** Directories below `outDir` whose chunks are server realm (Next). */
	serverDirs?: string[];
	/** Realm for chunks without application files. */
	defaultRealm?: Realm;
	/**
	 * Installed package directories whose `*.js` files the bundler copies
	 * verbatim (Next: `next`'s `dist/build/polyfills`).
	 */
	installedFiles?: readonly InstalledFiles[];
	/** Generated shapes this output may contain (Next only). */
	generatedShapes?: readonly GeneratedShape[];
	/** Consumer root for `[project]/…` module ids (`next dev` loaders). */
	projectRoot?: string;
	/** Chunk roles to use instead of reading the bundler's (`readChunkGraph`). */
	graph?: ChunkGraph;
	/** Development output: allows the development worker name and runs the scan. */
	development?: boolean;
	/** Consumer root (realpath): must never appear in a plugin cell's output. */
	consumerRoot?: string;
}

/**
 * The `next dev` inspection walks only the dev output: Next 16 writes it
 * below `.next/dev`, and the production `static`/`server` of the same `.next`
 * belong to the production cells, not to the dev report.
 */
export const NEXT_DEV_INSPECTION = {
	dirs: ["dev/static", "dev/server"],
	serverDirs: ["dev/server"],
	generatedShapes: ["next-manifest", "turbopack-bootstrap", "turbopack-dev"],
} as const satisfies Pick<
	InspectOptions,
	"dirs" | "serverDirs" | "generatedShapes"
>;

/** Application source text: `sourcesContent`, else the resolved file. */
function appText(source: MapSource): string | undefined {
	if (source.content !== null) return source.content;
	const path = source.resolved;
	return isAbsolute(path) && existsSync(path) && statSync(path).isFile()
		? readFileSync(path, "utf8")
		: undefined;
}

/** Code left once the trailing map comment is removed. */
const hasCode = (text: string) =>
	text.replace(/\/\/[#@] sourceMappingURL=\S+\s*$/, "").trim().length > 0;

export function inspectOutput(options: InspectOptions): IsolationReport {
	const { spec, outDir } = options;
	const allowed = new Set<string>();
	for (const entry of spec.entries) {
		for (const area of allowedAreas(entry)) allowed.add(area);
	}
	const forbidden = forbiddenPackages(spec);
	const resolveDist = createDistResolver(options.installedDist);
	const serverRoots = (options.serverDirs ?? []).map((dir) =>
		join(outDir, dir),
	);
	const isServer = (file: string) =>
		serverRoots.some((root) => file.startsWith(root));
	const chunks: ChunkReport[] = [];
	/** Per entry of `chunks`: what the realm and size need after the walk. */
	const pending: Array<GraphChunk & { bytes: Buffer }> = [];
	const unmapped: string[] = [];
	const generated: GeneratedFile[] = [];
	const serverMentions: IsolationReport["serverMentions"] = [];
	const sizes: IsolationReport["sizes"] = {};
	/** Adds one file to a sizes key; returns its gzip size. */
	const count = (key: string, bytes: Buffer): number => {
		const gzip = gzipSync(bytes).length;
		const size = sizes[key] ?? { raw: 0, gzip: 0, files: 0 };
		sizes[key] = size;
		size.raw += bytes.length;
		size.gzip += gzip;
		size.files += 1;
		return gzip;
	};
	const addGenerated = (file: GeneratedFile, bytes: Buffer) => {
		generated.push(file);
		count("generated", bytes);
	};
	const recipe = recipeOf(spec);
	const plugin = isPluginRecipe(recipe);
	const development = options.development === true;
	const pluginReport: NonNullable<IsolationReport["plugin"]> = {
		serverWorkerCode: [],
		generated: [],
		wiringHashes: [],
		localPaths: [],
		frameworkPaths: [],
	};
	const installedText = (distFile: string) => {
		const path = join(options.installedDist, distFile);
		return existsSync(path) ? readFileSync(path, "utf8") : "";
	};
	const roots = options.consumerRoot ? [options.consumerRoot] : [];

	const files = options.dirs
		? options.dirs.flatMap((dir) => listChunks(join(outDir, dir)))
		: listChunks(outDir);
	const classify = createGeneratedClassifier({
		installedFiles: options.installedFiles ?? [],
		shapes: options.generatedShapes ?? [],
		installedDist: options.installedDist,
		...(existsSync(join(outDir, "BUILD_ID"))
			? { buildId: readFileSync(join(outDir, "BUILD_ID"), "utf8").trim() }
			: {}),
		outputFiles: files.map((file) =>
			relative(outDir, file).replace(/\\/g, "/"),
		),
		...(options.projectRoot === undefined
			? {}
			: { projectRoot: options.projectRoot }),
	});
	for (const file of files) {
		const chunk = relative(outDir, file).replace(/\\/g, "/");
		const bytes = readFileSync(file);
		const text = bytes.toString("utf8");
		if (isServer(file)) {
			const packages = mentionedPackages(text).filter((name) =>
				matchesPackage(name, forbidden),
			);
			if (packages.length > 0) serverMentions.push({ file: chunk, packages });
			// Next's loadable manifest names the client's dynamic imports (the
			// wiring's lazy `./worker.js`) as data; it is not server code.
			if (plugin && !isNextLoadableManifest(chunk, text)) {
				const markers = serverWorkerMarkers(text);
				if (markers.length > 0) {
					pluginReport.serverWorkerCode.push({ file: chunk, markers });
				}
			}
			continue;
		}
		// Scan production and development output alike. Development
		// chunks also carry framework code with the project path (Next's
		// devtools define `__NEXT_DIST_DIR`), so scan only the Spinetab
		// modules' code without map metadata.
		if (plugin && development) {
			for (const module of spinetabDevModules(text)) {
				const paths = devTextLocalPaths(module.text, roots, {
					mapSources: false,
				});
				if (paths.length > 0) pluginReport.localPaths.push({ chunk, paths });
			}
		} else if (plugin) {
			const paths = localPathsIn(text, roots);
			if (paths.length > 0) pluginReport.localPaths.push({ chunk, paths });
		}
		const found = readChunkMap(file);
		if (!found) {
			if (bytes.length > 0) {
				const known = classify(chunk, bytes, "none");
				if (known) addGenerated(known, bytes);
				else unmapped.push(chunk);
			}
			continue;
		}
		// Only a map that attributes nothing is open to provenance.
		const empty = "json" in found ? emptyMapForm(found.json) : undefined;
		if (empty && hasCode(text)) {
			const known = classify(chunk, bytes, empty);
			if (known) {
				addGenerated(known, bytes);
				continue;
			}
		}
		const problems: string[] = [];
		let sources: MapSource[] = [];
		if ("error" in found) {
			problems.push(found.error);
		} else {
			const decoded = decodeMap(
				found.json,
				found.base,
				text.split("\n").length,
			);
			sources = decoded.sources;
			problems.push(...decoded.problems);
		}
		if (sources.length === 0 && problems.length === 0 && hasCode(text)) {
			problems.push("sourcemap names no sources for non-empty code");
		}
		const spinetabAreas = new Set<string>();
		const spinetabFiles = new Set<string>();
		const peers = new Set<string>();
		const exercised = new Set<string>();
		const appFiles: string[] = [];
		for (const source of sources) {
			const kind = classifySource(source.raw, source.resolved);
			if (plugin && LOCAL_PATH.test(source.raw)) {
				if (development) {
					pluginReport.devMapPaths = (pluginReport.devMapPaths ?? 0) + 1;
				} else if (
					options.bundler === "next-webpack" &&
					NEXT_IGNORED_MODULE.test(source.raw)
				) {
					pluginReport.frameworkPaths.push({ chunk, source: source.raw });
				} else {
					pluginReport.localPaths.push({ chunk, paths: [source.raw] });
				}
			}
			if (kind.kind === "spinetab") {
				spinetabFiles.add(kind.distFile);
				for (const area of resolveDist(kind.distFile)) spinetabAreas.add(area);
				problems.push(
					...pluginSourceProblems(kind.distFile, source.content, {
						recipe,
						development,
						installed: installedText(kind.distFile),
						roots,
						report: pluginReport,
						exercised,
					}),
				);
			} else if (kind.kind === "spinetab-source") {
				spinetabFiles.add(kind.source);
				spinetabAreas.add(areaOf(kind.source) ?? `unknown:${kind.source}`);
				if (/^src\/build\//.test(kind.source)) {
					problems.push(`attributes the build realm (${kind.source})`);
				}
				if (kind.source === "src/worker-config.ts") {
					problems.push(
						"bundles the worker-config stub instead of a worker module",
					);
				}
			} else if (kind.kind === "package") {
				peers.add(kind.name);
			} else if (kind.kind === "app") {
				appFiles.push(kind.path);
				const content = appText(source);
				if (content === undefined) {
					problems.push(
						`cannot read ${kind.path} (no sourcesContent) to find its Spinetab imports`,
					);
				} else {
					for (const specifier of spinetabImports(content)) {
						exercised.add(specifier);
					}
				}
			} else if (kind.kind === "unclassified") {
				problems.push(`unclassified source ${source.raw}: ${kind.reason}`);
			}
		}
		for (const specifier of exercised) {
			const entry = entryOf(specifier);
			if (!ENTRY_RULES[entry]) {
				problems.push(`imports ${specifier}, which is not a Spinetab entry`);
			} else if (!spec.entries.includes(entry)) {
				problems.push(`imports ${specifier}, an unselected entry`);
			}
		}
		const unexpectedSpinetab = [...spinetabAreas].filter(
			(area) => !allowed.has(area),
		);
		const unexpectedPeers = [...peers].filter((name) =>
			matchesPackage(name, forbidden),
		);
		// The realm needs every chunk's map first (readChunkGraph below).
		pending.push({
			chunk,
			text,
			sources: sources.map((source) => source.raw),
			appFiles,
			bytes,
		});
		chunks.push({
			consumer: spec.name,
			bundler: options.bundler,
			variant: options.variant,
			chunk,
			realm: options.defaultRealm ?? "shared",
			bytes: bytes.length,
			gzip: 0,
			spinetab: [...spinetabAreas].sort(),
			spinetabFiles: [...spinetabFiles].sort(),
			appFiles: [...new Set(appFiles)].sort(),
			peers: [...peers].sort(),
			exercised: [...exercised].sort(),
			unexpected: {
				spinetab: unexpectedSpinetab.sort(),
				peers: unexpectedPeers.sort(),
			},
			problems,
			verdict: "pass",
		});
	}

	const graph =
		options.graph ?? readChunkGraph(options.bundler, outDir, pending, plugin);
	pending.forEach((item, index) => {
		const report = chunks[index] as ChunkReport;
		report.realm = realmOf(
			item.appFiles,
			roleOf(graph, item.chunk),
			options.defaultRealm ?? "shared",
		);
		report.gzip = count(report.realm, item.bytes);
	});

	// An exercised import must be attributed: in its own chunk, or in another
	// chunk of this output when the bundler split shared vendor code out.
	const attributed = new Set(chunks.flatMap((chunk) => chunk.spinetab));
	for (const chunk of chunks) {
		for (const specifier of chunk.exercised) {
			const entry = entryOf(specifier);
			// Unknown and unselected entries are already chunk problems.
			if (!ENTRY_RULES[entry] || !spec.entries.includes(entry)) continue;
			const areas = allowedAreas(entry);
			const here = chunk.spinetab.some((area) => areas.has(area));
			if (here || [...attributed].some((area) => areas.has(area))) continue;
			chunk.problems.push(
				`exercised import ${specifier} has no Spinetab attribution in any chunk (expected one of ${[...areas].sort().join(", ")})`,
			);
		}
		chunk.verdict =
			chunk.problems.length === 0 &&
			chunk.unexpected.spinetab.length === 0 &&
			chunk.unexpected.peers.length === 0
				? "pass"
				: "fail";
	}
	// At L3 each development name is the hash of a generated worker of
	// this output (at L2 it hashes the worker file, which the matrix does not
	// recompute).
	const hashes = new Set(pluginReport.generated.map((worker) => worker.hash12));
	const staleNames =
		recipe === "plugin"
			? pluginReport.wiringHashes.filter((hash) => !hashes.has(hash))
			: [];
	const verdict =
		chunks.every((chunk) => chunk.verdict === "pass") &&
		unmapped.length === 0 &&
		generated.every((file) => file.kind && file.provenance) &&
		serverMentions.length === 0 &&
		pluginReport.serverWorkerCode.length === 0 &&
		pluginReport.localPaths.length === 0 &&
		staleNames.length === 0
			? "pass"
			: "fail";
	return {
		consumer: spec.name,
		bundler: options.bundler,
		variant: options.variant,
		outDir,
		chunks,
		unmapped,
		generated,
		serverMentions,
		...(plugin ? { plugin: pluginReport } : {}),
		sizes,
		verdict,
	};
}

/**
 * Worker code in a server-graph file: a worker factory, the auto
 * seams, the worker module or a runtime entry. Plugin cells only; the server
 * graph receives the inert default wiring.
 */
export function serverWorkerMarkers(text: string): string[] {
	const markers: string[] = [];
	if (/new SharedWorker\(/.test(text)) markers.push("new SharedWorker(");
	// Turbopack's rule outputs (`worker-config.js.js`) report as their input.
	for (const match of text.matchAll(
		/spinetab(?:@[^/\s"']*)?\/(?:node_modules\/spinetab\/)?dist\/(auto\/[a-z-]+\.js|worker-config\.js|worker\.js|runtime\.js|[a-z-]+\/runtime\.js)(?:\.js)?/g,
	)) {
		markers.push(`spinetab/dist/${match[1]}`);
	}
	return [...new Set(markers)].sort();
}

const LOADABLE_MANIFEST_PATH =
	/(?:^|\/)middleware-react-loadable-manifest\.js$/;
const LOADABLE_MANIFEST =
	/^self\.__REACT_LOADABLE_MANIFEST\s*=\s*'([^'\\]*)';?\s*$/;
const LOADABLE_CHUNK = /^static\/chunks\/[\w.-]+\.js$/;

/**
 * Next `--webpack`'s `server/middleware-react-loadable-manifest.js`, by
 * exact shape: one assignment of a JSON string mapping each client dynamic
 * import (`<module> -> <request>`) to `{ id, files }`, where every file is a
 * client chunk `static/chunks/*.js`. Its keys name `spinetab/dist/auto/…`
 * because the page's wiring lazily imports the worker module; the value is
 * data only, so the scan exempts exactly this file and nothing else.
 */
export function isNextLoadableManifest(file: string, text: string): boolean {
	if (!LOADABLE_MANIFEST_PATH.test(file)) return false;
	const payload = LOADABLE_MANIFEST.exec(text)?.[1];
	if (payload === undefined) return false;
	let value: unknown;
	try {
		value = JSON.parse(payload);
	} catch {
		return false;
	}
	if (!isRecord(value)) return false;
	return Object.values(value).every((entry) => {
		if (!isRecord(entry)) return false;
		const keys = Object.keys(entry).sort().join(",");
		if (keys !== "files,id" && keys !== "files") return false;
		if (
			"id" in entry &&
			typeof entry.id !== "number" &&
			typeof entry.id !== "string"
		) {
			return false;
		}
		return (
			Array.isArray(entry.files) &&
			entry.files.every(
				(chunk) => typeof chunk === "string" && LOADABLE_CHUNK.test(chunk),
			)
		);
	});
}

interface PluginSourceContext {
	recipe: ReturnType<typeof recipeOf>;
	development: boolean;
	/** The installed dist file's text. */
	installed: string;
	roots: readonly string[];
	report: NonNullable<IsolationReport["plugin"]>;
	exercised: Set<string>;
}

/**
 * Problems with one Spinetab dist source of a consumer map: the
 * build realm never appears; `worker-config.js` holds the generated worker
 * in L3 cells and nothing else; `auto/wiring.js` is the shipped file or
 * its development `name` variant. The generated worker's runtime imports
 * feed `exercised`, so each must be attributed like an application import.
 */
export function pluginSourceProblems(
	distFile: string,
	content: string | null,
	context: PluginSourceContext,
): string[] {
	const problems: string[] = [];
	const plugin = isPluginRecipe(context.recipe);
	if (distFile.startsWith("build/")) {
		problems.push(`attributes the build realm (dist/${distFile})`);
		return problems;
	}
	if (distFile === "worker-config.js") {
		if (context.recipe !== "plugin") {
			problems.push(
				`bundles spinetab/dist/worker-config.js in a ${context.recipe} cell`,
			);
			return problems;
		}
		if (content === null) {
			problems.push(
				"worker-config.js has no sourcesContent: the generated worker cannot be checked",
			);
			return problems;
		}
		const parsed = parseGeneratedWorker(content);
		if ("problems" in parsed) {
			const stub = content.trimEnd() === context.installed.trimEnd();
			problems.push(
				stub
					? "bundles the worker-config stub, not a generated worker"
					: `generated worker: ${parsed.problems.join("; ")}`,
			);
			return problems;
		}
		const paths = localPathsIn(content, context.roots);
		if (paths.length > 0) {
			problems.push(`generated worker names local paths: ${paths.join(", ")}`);
		}
		if (
			!context.report.generated.some(
				(worker) => worker.hash12 === parsed.worker.hash12,
			)
		) {
			context.report.generated.push(parsed.worker);
		}
		for (const specifier of parsed.worker.specifiers) {
			context.exercised.add(specifier);
		}
		return problems;
	}
	if (distFile === "auto/wiring.js" || distFile === "auto/worker.js") {
		if (!plugin) {
			// L1 cells never redirect the wiring.
			problems.push(`bundles spinetab/dist/${distFile} without the plugin`);
			return problems;
		}
		if (distFile === "auto/wiring.js" && content === null) {
			// Fail closed, like worker-config.js: without the bundled text the
			// literal and the production-name rule go unchecked.
			problems.push(
				"auto/wiring.js has no sourcesContent: the bundled wiring cannot be checked",
			);
		} else if (distFile === "auto/wiring.js" && content !== null) {
			const checked = wiringCopyProblems(
				content,
				context.installed,
				context.development,
			);
			problems.push(...checked.problems);
			if (checked.hash && !context.report.wiringHashes.includes(checked.hash)) {
				context.report.wiringHashes.push(checked.hash);
			}
		}
	}
	return problems;
}

/** Package names that appear as `node_modules/<name>/` in text. */
export function mentionedPackages(text: string): string[] {
	const names = new Set<string>();
	for (const match of text.matchAll(
		/node_modules\/((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)\//gi,
	)) {
		const name = match[1] as string;
		if (name !== ".pnpm") names.add(name);
	}
	return [...names].sort();
}

/** Offending rows, for test failure messages. */
export function failures(report: IsolationReport): ChunkReport[] {
	return report.chunks.filter((chunk) => chunk.verdict === "fail");
}

/** Chunks per realm, for the browser cells (fallback never requested). */
export function chunksByRealm(report: IsolationReport, realm: Realm): string[] {
	return report.chunks
		.filter((chunk) => chunk.realm === realm)
		.map((chunk) => chunk.chunk);
}
