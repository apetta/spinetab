import { createHash } from "node:crypto";
import {
	existsSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
} from "node:fs";
import { basename, join, relative, sep } from "node:path";
import ts from "typescript";

/**
 * Positive provenance for emitted JavaScript that no sourcemap attributes. The isolation inspection calls this only for a chunk
 * with no map, or whose map is empty (no sources, no mappings). Anything not
 * classified here stays `unmapped` or keeps its chunk problem and fails.
 *
 * Classes, each narrow:
 * - `installed-file`: sha256-identical to a `*.js` file under an explicitly
 * named directory of an installed package (Next copies
 * `dist/build/polyfills/polyfill-nomodule.js` verbatim);
 * - `next-manifest`: `static/<BUILD_ID>/_buildManifest.js`,
 * `_clientMiddlewareManifest.js` or `_ssgManifest.js` (the directory is the
 * output's own `BUILD_ID`; under `next dev`'s `dev/` prefix it is Next's
 * fixed dev build id `development`) whose whole text is the generated
 * assignment and whose payload parses as JSON (data, not code), or Next's
 * exact empty SSG manifest constant;
 * - `turbopack-bootstrap`: the Turbopack worker entry, accepted only as an
 * exact match with one of the two reviewed Next 16.3.6 bodies, or an async chunk loader (one module
 * that loads `static/chunks/*.js` files of this output, then imports one
 * module id), checked by structure;
 * - `turbopack-bootstrap` under `next dev` only (shape `turbopack-dev`,
 * below `dev/static/chunks/`): a dev async loader whose module id is a
 * string naming an existing project file, Turbopack's fixed HMR client id,
 * or the installed `spinetab/dist/auto/worker.js` (the target of the
 * shipped wiring's `local: () => import("./worker.js")`, verified by
 * realpath), and whose map is `{"version":3,"sources":[],"sections":[]}`, and an
 * entry chunk list (`TURBOPACK_CHUNK_LISTS`, no map), and the Pages Router
 * dev page chunk lists `dev/static/chunks/pages/_app.js` and `_error.js`
 * (`__turbopack_load_page_chunks__("/_app" | "/_error", [<chunks>])`, no
 * map; Next compiles them for its own 404 and error pages, they hold no
 * application or Spinetab code). Every chunk either names must be an
 * emitted file of the same dev output.
 *
 * Every classified file also passes the negative controls in `tokenProblems`;
 * for the dev shapes they run on the text with the verified module-id and
 * chunk-path string literals removed, so `[project]` or `spinetab_dist`
 * inside a verified literal is allowed and anywhere else still fails.
 */

export type GeneratedKind =
	| "installed-file"
	| "next-manifest"
	| "turbopack-bootstrap"
	/** Next `--webpack`'s dependency-only entry stubs (shape `next-webpack`). */
	| "webpack-bootstrap"
	/** Turbopack's `static/media` copy of the shipped keep stub. */
	| "spinetab-stub";

/**
 * Structural classes an output may contain; installed files are separate.
 * `turbopack-dev` is enabled only for the `next dev` inspection.
 */
export type GeneratedShape =
	| "next-manifest"
	| "turbopack-bootstrap"
	| "turbopack-dev"
	/**
	 * Next `--webpack` only: the webpack-shaped `_buildManifest.js` and the
	 * dependency-only entry stubs (`nextWebpackEntryStub`).
	 */
	| "next-webpack";

export type Provenance =
	| {
			source: "installed";
			package: string;
			version: string;
			/** Relative to the package root. */
			file: string;
	  }
	| {
			source: "spinetab";
			/** Installed dist file the bytes equal. */
			file: string;
			evidence: string[];
	  }
	| {
			source: "structure";
			generator: "next" | "turbopack" | "webpack";
			shape: string;
			/** What was verified, in order. */
			evidence: string[];
			/**
			 * Files the text names, all verified to exist: emitted files of the
			 * same output (relative to its root) and `project:<path>` files of
			 * the consumer root.
			 */
			references?: string[];
	  };

export interface GeneratedFile {
	chunk: string;
	bytes: number;
	sha256: string;
	kind: GeneratedKind;
	provenance: Provenance;
}

/** Installed package root (realpath) and the directory below it to index. */
export interface InstalledFiles {
	root: string;
	dir: string;
}

export interface ClassifierOptions {
	installedFiles?: readonly InstalledFiles[];
	shapes?: readonly GeneratedShape[];
	/** Installed Spinetab `dist`: its JS basenames are negative tokens. */
	installedDist: string;
	/** The output's Next `BUILD_ID`; manifests are recognised only below it. */
	buildId?: string;
	/** Every emitted file of the output, relative to its root. */
	outputFiles: readonly string[];
	/**
	 * Consumer root that `[project]/…` module ids resolve against (`next dev`
	 * loaders). Without it no `[project]` loader is classified.
	 */
	projectRoot?: string;
}

/** How the inspection found a file's map, passed to the classifier. */
export type MapForm = "none" | "empty" | "empty-sections";

export const MANIFEST_MAX_BYTES = 16 * 1024;
export const BOOTSTRAP_MAX_BYTES = 4 * 1024;

const sha256 = (bytes: Buffer | string) =>
	createHash("sha256").update(bytes).digest("hex");

function walk(dir: string, match: RegExp): string[] {
	if (!existsSync(dir)) return [];
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...walk(path, match));
		else if (entry.isFile() && match.test(entry.name)) files.push(path);
	}
	return files.sort();
}

/** sha256 → installed file, over each named directory's `*.js` files. */
function indexInstalled(
	sources: readonly InstalledFiles[],
): Map<string, Provenance & { source: "installed" }> {
	const index = new Map<string, Provenance & { source: "installed" }>();
	for (const { root, dir } of sources) {
		const manifest = JSON.parse(
			readFileSync(join(root, "package.json"), "utf8"),
		) as { name?: string; version?: string };
		if (!manifest.name || !manifest.version) {
			throw new Error(`${root}/package.json has no name or version`);
		}
		for (const file of walk(join(root, dir), /\.js$/)) {
			index.set(sha256(readFileSync(file)), {
				source: "installed",
				package: manifest.name,
				version: manifest.version,
				file: relative(root, file).replace(/\\/g, "/"),
			});
		}
	}
	return index;
}

const escapeRegExp = (text: string) =>
	text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Turbopack names a loader rule's output after the rule's `as` glob (`*.js`), so a map lists the generated worker as `dist/worker-config.js.js` and,
 * in development, the transformed wiring as `dist/auto/wiring.js.js`. Only
 * these two files take a Spinetab rule; every other doubled name stays as it
 * is, and so fails its area lookup.
 */
const RULE_OUTPUTS: ReadonlyMap<string, string> = new Map([
	["worker-config.js.js", "worker-config.js"],
	["auto/wiring.js.js", "auto/wiring.js"],
]);

/** The installed dist file a Spinetab map source names (see `RULE_OUTPUTS`). */
export const ruleInputFile = (distFile: string): string =>
	RULE_OUTPUTS.get(distFile) ?? distFile;

/** Offending tokens: Spinetab, package paths, dynamic loading, network APIs. */
export function tokenProblems(
	text: string,
	distBasenames: ReadonlySet<string>,
): string[] {
	const problems: string[] = [];
	const tokens: Array<[RegExp, string]> = [
		[/spinetab/i, "names Spinetab"],
		[/\[project\]/, "names a [project] path"],
		[/node_modules\//, "names a node_modules/ path"],
		[/\bimport\s*\(/, "calls import()"],
		[/\brequire\s*\(/, "calls require()"],
		[/\bfetch\s*\(/, "calls fetch()"],
		[/\bWebSocket\b/, "names WebSocket"],
		[/\bEventSource\b/, "names EventSource"],
	];
	for (const [pattern, reason] of tokens) {
		if (pattern.test(text)) problems.push(reason);
	}
	for (const name of distBasenames) {
		const segment = new RegExp(
			`(?:^|[/"'\`\\s(])${escapeRegExp(name)}(?=$|["'\`\\s)?#])`,
		);
		if (segment.test(text)) problems.push(`names Spinetab dist file ${name}`);
	}
	return problems;
}

/** Syntax errors from the TypeScript parser, for plain JavaScript. */
function syntaxErrors(code: string): string[] {
	return (
		ts.transpileModule(code, {
			reportDiagnostics: true,
			fileName: "generated.js",
			compilerOptions: {
				allowJs: true,
				target: ts.ScriptTarget.ESNext,
				module: ts.ModuleKind.Preserve,
			},
		}).diagnostics ?? []
	).map((diagnostic) =>
		ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
	);
}

/** Text without one trailing `//# sourceMappingURL=` comment. */
const withoutMapComment = (text: string) =>
	text.replace(/\n?\/\/[#@] sourceMappingURL=\S+\s*$/, "");

// Next build manifests.

const MANIFESTS: Record<
	string,
	{ pattern: RegExp; payload: (value: unknown) => boolean; label: string }
> = {
	_buildManifest: {
		pattern:
			/^self\.__BUILD_MANIFEST = (\{[\s\S]*\});self\.__BUILD_MANIFEST_CB && self\.__BUILD_MANIFEST_CB\(\)\s*$/,
		payload: (value) =>
			typeof value === "object" && value !== null && !Array.isArray(value),
		label: "JSON object",
	},
	_clientMiddlewareManifest: {
		pattern:
			/^self\.__MIDDLEWARE_MATCHERS = (\[[\s\S]*\]);self\.__MIDDLEWARE_MATCHERS_CB && self\.__MIDDLEWARE_MATCHERS_CB\(\)\s*$/,
		payload: Array.isArray,
		label: "JSON array",
	},
	_ssgManifest: {
		pattern:
			/^self\.__SSG_MANIFEST=new Set\((\[[\s\S]*\])\);self\.__SSG_MANIFEST_CB&&self\.__SSG_MANIFEST_CB\(\)\s*$/,
		payload: (value) =>
			Array.isArray(value) && value.every((item) => typeof item === "string"),
		label: "JSON array of strings",
	},
};

const MANIFEST_PATH =
	/^(dev\/)?static\/([^/]+)\/(_buildManifest|_clientMiddlewareManifest|_ssgManifest)\.js$/;

/**
 * `next dev` writes its manifests below `.next/dev` with this fixed build id
 * (next 16.3.6 `dist/server/dev/hot-reloader-turbopack.js`).
 */
export const DEV_BUILD_ID = "development";

/**
 * Next's own empty SSG manifest (`srcEmptySsgManifest` in next 16.3.6
 * `dist/build/webpack/plugins/build-manifest-plugin-utils.js`), which
 * `next dev` writes verbatim: `new Set` without an argument.
 */
export const EMPTY_SSG_MANIFEST =
	"self.__SSG_MANIFEST=new Set;self.__SSG_MANIFEST_CB&&self.__SSG_MANIFEST_CB()";

/**
 * Evidence for a Next build manifest below `static/<buildId>/` (or
 * `dev/static/development/` for `next dev`), or undefined.
 */
export function nextManifest(
	chunk: string,
	text: string,
	bytes: number,
	buildId: string | undefined,
): string[] | undefined {
	const [, dev, directory, name] = MANIFEST_PATH.exec(chunk) ?? [];
	const expected = dev ? DEV_BUILD_ID : buildId;
	const rule = name ? MANIFESTS[name] : undefined;
	if (
		!expected ||
		directory !== expected ||
		!name ||
		!rule ||
		bytes > MANIFEST_MAX_BYTES
	) {
		return undefined;
	}
	const emptySet =
		name === "_ssgManifest" && text.trimEnd() === EMPTY_SSG_MANIFEST;
	const payload = emptySet ? "[]" : rule.pattern.exec(text)?.[1];
	if (payload === undefined) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(payload);
	} catch {
		return undefined;
	}
	if (!rule.payload(value)) return undefined;
	return [
		dev
			? `path dev/static/<next dev build id ${DEV_BUILD_ID}>/${name}.js`
			: `path static/<BUILD_ID ${buildId}>/${name}.js`,
		`${bytes} B <= ${MANIFEST_MAX_BYTES} B`,
		emptySet
			? "whole text is Next's empty SSG manifest constant"
			: `whole text is the generated ${name} assignment`,
		`payload is a ${rule.label}`,
	];
}

// Next `--webpack` (Next 16.3.6): the build manifest is a JavaScript object
// literal, not JSON, and routes with no client code of their own get a
// dependency-only entry stub without a map.

const WEBPACK_BUILD_MANIFEST =
	/^self\.__BUILD_MANIFEST=(\{[\s\S]*\})[,;]self\.__BUILD_MANIFEST_CB&&self\.__BUILD_MANIFEST_CB\(\);?\s*$/;
const WEBPACK_MANIFEST_PATH = /^static\/([^/]+)\/_buildManifest\.js$/;

/**
 * A data-only literal: numbers (with an optional minus), strings, booleans,
 * `null`, `NaN`, arrays and plain object literals with non-computed keys.
 * No call, identifier reference, spread, getter or function.
 */
function isDataLiteral(node: ts.Node): boolean {
	if (ts.isParenthesizedExpression(node)) return isDataLiteral(node.expression);
	if (
		ts.isNumericLiteral(node) ||
		ts.isStringLiteral(node) ||
		ts.isNoSubstitutionTemplateLiteral(node) ||
		node.kind === ts.SyntaxKind.TrueKeyword ||
		node.kind === ts.SyntaxKind.FalseKeyword ||
		node.kind === ts.SyntaxKind.NullKeyword
	) {
		return true;
	}
	if (ts.isIdentifier(node)) return node.text === "NaN";
	if (ts.isPrefixUnaryExpression(node)) {
		return (
			node.operator === ts.SyntaxKind.MinusToken &&
			ts.isNumericLiteral(node.operand)
		);
	}
	if (ts.isArrayLiteralExpression(node)) {
		return node.elements.every(isDataLiteral);
	}
	if (ts.isObjectLiteralExpression(node)) {
		return node.properties.every(
			(property) =>
				ts.isPropertyAssignment(property) &&
				(ts.isIdentifier(property.name) ||
					ts.isStringLiteral(property.name) ||
					ts.isNumericLiteral(property.name)) &&
				isDataLiteral(property.initializer),
		);
	}
	return false;
}

/**
 * Evidence for Next `--webpack`'s `static/<BUILD_ID>/_buildManifest.js`:
 * the whole text is the manifest assignment and its callback, and the
 * assigned value is one data-only object literal with `sortedPages`.
 */
export function nextWebpackManifest(
	chunk: string,
	text: string,
	bytes: number,
	buildId: string | undefined,
): string[] | undefined {
	const directory = WEBPACK_MANIFEST_PATH.exec(chunk)?.[1];
	if (!buildId || directory !== buildId || bytes > MANIFEST_MAX_BYTES) {
		return undefined;
	}
	const payload = WEBPACK_BUILD_MANIFEST.exec(text)?.[1];
	if (payload === undefined) return undefined;
	const file = ts.createSourceFile(
		"manifest.js",
		`(${payload});`,
		ts.ScriptTarget.ESNext,
		false,
		ts.ScriptKind.JS,
	);
	const [statement, ...rest] = file.statements;
	if (
		rest.length > 0 ||
		!statement ||
		!ts.isExpressionStatement(statement) ||
		syntaxErrors(`(${payload});`).length > 0
	) {
		return undefined;
	}
	const value = ts.isParenthesizedExpression(statement.expression)
		? statement.expression.expression
		: statement.expression;
	if (!ts.isObjectLiteralExpression(value) || !isDataLiteral(value)) {
		return undefined;
	}
	const keys = value.properties.map((property) =>
		property.name && ts.isIdentifier(property.name) ? property.name.text : "",
	);
	if (!keys.includes("sortedPages")) return undefined;
	return [
		`path static/<BUILD_ID ${buildId}>/_buildManifest.js`,
		`${bytes} B <= ${MANIFEST_MAX_BYTES} B`,
		"whole text is the webpack-built __BUILD_MANIFEST assignment and its callback",
		"payload is one data-only object literal (numbers, strings, NaN, arrays, objects) with sortedPages",
	];
}

/** Entry stubs are 155 B in Next 16.3.6; the cap leaves room for longer id lists. */
export const WEBPACK_STUB_MAX_BYTES = 1024;
const IDS = "\\d+(?:,\\d+)*";
/**
 * The whole text of a dependency-only webpack entry chunk, exactly: one push
 * onto `webpackChunk_N_E` of numeric chunk ids, one entry module whose
 * factory is empty (`()=>{}`), and a runtime callback that only waits for
 * numeric chunk ids and then runs that same empty module.
 */
const WEBPACK_ENTRY_STUB = new RegExp(
	[
		"^\\(self\\.webpackChunk_N_E=self\\.webpackChunk_N_E\\|\\|\\[\\]\\)\\.push\\(\\[",
		`\\[${IDS}\\],`,
		"\\{(?<module>\\d+):\\(\\)=>\\{\\}\\},",
		`(?<r>[A-Za-z_$][\\w$]*)=>\\{\\k<r>\\.O\\(0,\\[${IDS}\\],\\(\\)=>\\k<r>\\(\\k<r>\\.s=\\k<module>\\)\\),_N_E=\\k<r>\\.O\\(\\)\\}`,
		"\\]\\);?\\s*$",
	].join(""),
);
const WEBPACK_STUB_PATH = /^static\/chunks\/[\w@()[\]/.-]+\.js$/;

/** Evidence for a Next `--webpack` dependency-only entry stub, or undefined. */
export function nextWebpackEntryStub(
	chunk: string,
	text: string,
	bytes: number,
): string[] | undefined {
	if (
		!WEBPACK_STUB_PATH.test(chunk) ||
		chunk.includes("..") ||
		bytes > WEBPACK_STUB_MAX_BYTES
	) {
		return undefined;
	}
	const match = WEBPACK_ENTRY_STUB.exec(text);
	if (!match?.groups || syntaxErrors(text).length > 0) return undefined;
	return [
		`path static/chunks/**/*.js, ${bytes} B <= ${WEBPACK_STUB_MAX_BYTES} B, no map`,
		`whole text pushes numeric chunk ids and one empty entry module (${match.groups.module}: ()=>{}) onto webpackChunk_N_E`,
		"its runtime callback only waits for numeric chunk ids, then runs that empty module",
	];
}

// Turbopack async chunk loader (pretty and minified forms).

const ID = "[A-Za-z_$][\\w$]*";
const CHUNK = '"static\\/chunks\\/[\\w-]+\\.js"';
const REGISTRY = '(?:\\.TURBOPACK|\\["TURBOPACK"\\])';
/** Current script: `typeof document === "object" ? document.currentScript: undefined`. */
const CURRENT_SCRIPT =
	'(?:typeof document\\s*===?\\s*"object"|"object"\\s*===?\\s*typeof document)\\s*\\?\\s*document\\.currentScript\\s*:\\s*(?:undefined|void 0)';

/**
 * One `TURBOPACK` push of one module whose factory body only loads `chunk`
 * files, then imports one module. `id` and `target` carry the named groups.
 */
function loaderPattern(id: string, target: string, chunk: string): RegExp {
	return new RegExp(
		[
			`^\\(\\s*globalThis${REGISTRY}\\s*\\|\\|\\s*\\(\\s*globalThis${REGISTRY}\\s*=\\s*\\[\\s*\\]\\s*\\)\\s*\\)\\.push\\(\\s*\\[\\s*`,
			`${CURRENT_SCRIPT}\\s*,\\s*`,
			`${id}\\s*,\\s*`,
			// One module factory whose body is only the loader.
			`\\(?\\s*\\(?\\s*(?<ctx>${ID})\\s*\\)?\\s*=>\\s*\\{\\s*`,
			`\\k<ctx>\\.v\\(\\s*\\(?\\s*(?<parent>${ID})\\s*\\)?\\s*=>\\s*\\{?\\s*(?:return\\s+)?`,
			`Promise\\.all\\(\\s*\\[\\s*(?<chunks>${chunk}(?:\\s*,\\s*${chunk})*)\\s*\\]`,
			`\\.map\\(\\s*\\(?\\s*(?<each>${ID})\\s*\\)?\\s*=>\\s*\\k<ctx>\\.l\\(\\s*\\k<each>\\s*\\)\\s*\\)\\s*\\)`,
			`\\.then\\(\\s*\\(\\s*\\)\\s*=>\\s*\\{?\\s*(?:return\\s+)?\\k<parent>\\(\\s*${target}\\s*\\)\\s*;?\\s*\\}?\\s*\\)`,
			"\\s*;?\\s*\\}?\\s*\\)\\s*;?\\s*",
			"\\}\\s*\\)?\\s*,?\\s*\\]\\s*\\)\\s*;?\\s*$",
		].join(""),
	);
}

const LOADER = loaderPattern("(?<id>\\d+)", "(?<target>\\d+)", CHUNK);

const LOADER_PATH = /^static\/chunks\/[\w-]+\.js$/;

/** Evidence for a Turbopack async chunk loader, or undefined. */
export function turbopackLoader(
	chunk: string,
	text: string,
	bytes: number,
	outputFiles: ReadonlySet<string>,
): string[] | undefined {
	if (!LOADER_PATH.test(chunk) || bytes > BOOTSTRAP_MAX_BYTES) return undefined;
	const code = withoutMapComment(text);
	const match = LOADER.exec(code);
	if (!match?.groups || syntaxErrors(code).length > 0) return undefined;
	const chunks = [
		...(match.groups.chunks as string).matchAll(/"([^"]+)"/g),
	].map((entry) => entry[1] as string);
	// Each loaded file must be another emitted chunk of this output.
	if (chunks.some((path) => path === chunk || !outputFiles.has(path))) {
		return undefined;
	}
	return [
		`path static/chunks/*.js, ${bytes} B <= ${BOOTSTRAP_MAX_BYTES} B`,
		`registers one module (${match.groups.id}) that only loads chunks, then imports module ${match.groups.target}`,
		`loads ${chunks.join(", ")} (emitted by this build)`,
	];
}

// `next dev` (Turbopack development) loaders and chunk lists, Next 16.3.6.
// Fixtures: tests/package/fixtures/generated/dev-turbopack/.

/** A dev chunk name: `[turbopack]_…`, `[root-of-the-server]__…`, `0zix_@swc_…`. */
const DEV_CHUNK_NAME = "[\\w.@\\[\\]-]+";
const DEV_CHUNK = `"static\\/chunks\\/${DEV_CHUNK_NAME}\\.js"`;
const DEV_PATH = new RegExp(`^dev\\/static\\/chunks\\/${DEV_CHUNK_NAME}\\.js$`);
/** `next dev`'s Pages Router page chunk lists for its own `_app` and `_error` pages. */
const PAGE_LIST_PATH = /^dev\/static\/chunks\/pages\/(?<page>_app|_error)\.js$/;
/**
 * The whole text of such a list, exactly (whitespace aside):
 * `__turbopack_load_page_chunks__("/<page>", [<string literals>])`.
 */
const PAGE_CHUNK_LIST = new RegExp(
	`^__turbopack_load_page_chunks__\\(\\s*"(?<route>\\/_app|\\/_error)"\\s*,\\s*\\[\\s*(?<chunks>${DEV_CHUNK}(?:\\s*,\\s*${DEV_CHUNK})*)\\s*\\]\\s*\\)\\s*;?\\s*$`,
);
/** A module id string literal's content: no quote, backslash or line break. */
const STRING_BODY = '[^"\\\\\\r\\n]+';
const DEV_LOADER = loaderPattern(
	`"(?<id>${STRING_BODY})"`,
	`"(?<target>${STRING_BODY})"`,
	DEV_CHUNK,
);
const ASYNC_LOADER_SUFFIX = " [app-client] (ecmascript, async loader)";
const IMPORTED_SUFFIX = " [app-client] (ecmascript)";
/** Turbopack's own HMR client loader id (fixed, not a project path). */
export const HMR_CLIENT_LOADER_ID = `[turbopack]/browser/dev/hmr-client/hmr-client.ts${ASYNC_LOADER_SUFFIX}`;
const PROJECT_ID =
	/^\[project\]\/(?<path>.+) \[app-client\] \(ecmascript, async loader\)$/;

/**
 * `next dev`'s entry chunk list, exactly (whitespace between tokens aside):
 * `(globalThis["TURBOPACK_CHUNK_LISTS"] || (globalThis["TURBOPACK_CHUNK_LISTS"] = [])).push({ script: <current script>, chunks: [<string literals>], source: "entry" });`
 */
const CHUNK_LIST = new RegExp(
	[
		'^\\(\\s*globalThis\\["TURBOPACK_CHUNK_LISTS"\\]\\s*\\|\\|\\s*\\(\\s*globalThis\\["TURBOPACK_CHUNK_LISTS"\\]\\s*=\\s*\\[\\s*\\]\\s*\\)\\s*\\)\\.push\\(\\s*\\{\\s*',
		`script\\s*:\\s*${CURRENT_SCRIPT}\\s*,\\s*`,
		`chunks\\s*:\\s*\\[\\s*(?<chunks>${DEV_CHUNK}(?:\\s*,\\s*${DEV_CHUNK})*)\\s*\\]\\s*,\\s*`,
		'source\\s*:\\s*"entry"\\s*\\}\\s*\\)\\s*;\\s*$',
	].join(""),
);

/**
 * A project-relative file path that exists inside `root`: plain segments
 * only (no `.`/`..`, no dot directories, no `node_modules`), resolved without
 * leaving the root.
 */
export function projectFile(root: string | undefined, path: string): boolean {
	if (!root || path.startsWith("/") || path.includes("\\")) return false;
	const segments = path.split("/");
	if (
		segments.some(
			(segment) =>
				!/^[\w@.-]+$/.test(segment) ||
				segment.startsWith(".") ||
				segment === "node_modules",
		)
	) {
		return false;
	}
	const base = realpathSync(root);
	const target = join(base, ...segments);
	if (!existsSync(target)) return false;
	const real = realpathSync(target);
	return real.startsWith(`${base}${sep}`) && statSync(real).isFile();
}

/**
 * The one installed module a dev loader may name: the shipped wiring's
 * `local: () => import("./worker.js")` target, directly or through the pnpm
 * virtual store (`.pnpm/spinetab@<version-and-peers>/node_modules/…`).
 */
const SPINETAB_WORKER_MODULE =
	/^node_modules\/(?:\.pnpm\/spinetab@[^/]+\/node_modules\/)?spinetab\/dist\/auto\/worker\.js$/;

/**
 * True when the project-relative `path` is exactly that module and resolves,
 * inside `root`, to the same file as the installed `dist/auto/worker.js`.
 */
export function installedWorkerModule(
	root: string | undefined,
	path: string,
	installedDist: string | undefined,
): boolean {
	if (!root || !installedDist || !SPINETAB_WORKER_MODULE.test(path)) {
		return false;
	}
	const base = realpathSync(root);
	const target = join(base, ...path.split("/"));
	const installed = join(installedDist, "auto", "worker.js");
	if (!existsSync(target) || !existsSync(installed)) return false;
	const real = realpathSync(target);
	return real.startsWith(`${base}${sep}`) && real === realpathSync(installed);
}

/** `static/chunks/<name>.js` of a dev file → its emitted path `dev/static/chunks/<name>.js`. */
const devOutputPath = (path: string) => `dev/${path}`;

/** The text with each verified string literal (quoted) removed. */
function withoutLiterals(text: string, literals: readonly string[]): string {
	let rest = text;
	for (const literal of [...new Set(literals)]) {
		rest = rest.split(`"${literal}"`).join('""');
	}
	return rest;
}

export interface DevEvidence {
	shape: "dev-async-loader" | "chunk-list" | "page-chunk-list";
	evidence: string[];
	references: string[];
}

/**
 * Evidence for a `next dev` async loader or entry chunk list, or undefined.
 * `map` is how the inspection found the file's map: the loader needs the
 * empty index map Turbopack writes for it, the chunk list has none.
 */
export function turbopackDevFile(
	chunk: string,
	text: string,
	bytes: number,
	map: MapForm,
	options: {
		outputFiles: ReadonlySet<string>;
		projectRoot?: string;
		/** Installed Spinetab `dist`, for the wiring's worker loader. */
		installedDist?: string;
		distBasenames: ReadonlySet<string>;
	},
): DevEvidence | undefined {
	const pageList = PAGE_LIST_PATH.exec(chunk)?.groups?.page;
	if (
		(!DEV_PATH.test(chunk) && pageList === undefined) ||
		bytes > BOOTSTRAP_MAX_BYTES
	) {
		return undefined;
	}
	const emitted = (paths: readonly string[]) =>
		paths.every((path) => {
			const output = devOutputPath(path);
			return output !== chunk && options.outputFiles.has(output);
		});
	const listed = (group: string) =>
		[...group.matchAll(/"([^"]+)"/g)].map((entry) => entry[1] as string);
	const size = `path dev/static/chunks/*.js, ${bytes} B <= ${BOOTSTRAP_MAX_BYTES} B`;

	if (map === "empty-sections") {
		const match = DEV_LOADER.exec(text);
		if (!match?.groups || syntaxErrors(text).length > 0) return undefined;
		const id = match.groups.id as string;
		const target = match.groups.target as string;
		const chunks = listed(match.groups.chunks as string);
		let source: string;
		const references: string[] = [];
		if (id === HMR_CLIENT_LOADER_ID) {
			source = "module id is Turbopack's fixed HMR client loader id";
		} else {
			const path = PROJECT_ID.exec(id)?.groups?.path;
			if (!path) return undefined;
			if (projectFile(options.projectRoot, path)) {
				source = `module id names project file ${path} (exists in the consumer root)`;
			} else if (
				installedWorkerModule(options.projectRoot, path, options.installedDist)
			) {
				source = `module id names the installed spinetab/dist/auto/worker.js (${path}), the wiring's local import`;
			} else {
				return undefined;
			}
			references.push(`project:${path}`);
		}
		const expected = `${id.slice(0, -ASYNC_LOADER_SUFFIX.length)}${IMPORTED_SUFFIX}`;
		if (!id.endsWith(ASYNC_LOADER_SUFFIX) || target !== expected) {
			return undefined;
		}
		if (!emitted(chunks)) return undefined;
		const rest = withoutLiterals(text, [id, target, ...chunks]);
		if (tokenProblems(rest, options.distBasenames).length > 0) return undefined;
		const outputs = chunks.map(devOutputPath);
		return {
			shape: "dev-async-loader",
			evidence: [
				size,
				'map is exactly {"version":3,"sources":[],"sections":[]}',
				`registers one module "${id}" that only loads chunks, then imports "${target}"`,
				source,
				`loads ${outputs.join(", ")} (emitted by this dev output)`,
				"negative tokens absent outside the verified module-id and chunk-path literals",
			],
			references: [...outputs, ...references],
		};
	}

	if (map === "none" && pageList !== undefined) {
		const match = PAGE_CHUNK_LIST.exec(text);
		if (!match?.groups || syntaxErrors(text).length > 0) return undefined;
		const route = match.groups.route as string;
		if (route !== `/${pageList}`) return undefined;
		const chunks = listed(match.groups.chunks as string);
		if (!emitted(chunks)) return undefined;
		const rest = withoutLiterals(text, [route, ...chunks]);
		if (tokenProblems(rest, options.distBasenames).length > 0) return undefined;
		const outputs = chunks.map(devOutputPath);
		return {
			shape: "page-chunk-list",
			evidence: [
				`path dev/static/chunks/pages/${pageList}.js, ${bytes} B <= ${BOOTSTRAP_MAX_BYTES} B, no map`,
				`whole text is __turbopack_load_page_chunks__("${route}", [...]) for Next's own Pages Router ${pageList} page`,
				`lists ${outputs.length} chunks, each emitted by this dev output: ${outputs.join(", ")}`,
				"negative tokens absent outside the verified route and chunk-path literals",
			],
			references: outputs,
		};
	}

	if (map === "none") {
		const match = CHUNK_LIST.exec(text);
		if (!match?.groups || syntaxErrors(text).length > 0) return undefined;
		const chunks = listed(match.groups.chunks as string);
		if (!emitted(chunks)) return undefined;
		const rest = withoutLiterals(text, chunks);
		if (tokenProblems(rest, options.distBasenames).length > 0) return undefined;
		const outputs = chunks.map(devOutputPath);
		return {
			shape: "chunk-list",
			evidence: [
				`${size}, no map`,
				'whole text is the Turbopack entry chunk-list registration (source "entry")',
				`lists ${outputs.length} chunks, each emitted by this dev output: ${outputs.join(", ")}`,
				"negative tokens absent outside the verified chunk-path literals",
			],
			references: outputs,
		};
	}
	return undefined;
}

// Turbopack worker entry: exact match against reviewed, version-pinned bodies.

/**
 * sha256 of each reviewed Next 16.3.6 Turbopack worker bootstrap body, after
 * removing one trailing `//# sourceMappingURL=` comment and nothing else. The
 * seven real next-app/next-ai outputs (prod, inspect, base, CDN) contain only
 * these two bodies. Exact matching rejects any added or
 * altered code; a Next upgrade that changes the body leaves the file unmapped
 * and fails for review, after which the new body is reviewed and pinned here
 * and in `tests/package/fixtures/generated`.
 */
export const PINNED_WORKER_ENTRIES: ReadonlyMap<string, string> = new Map([
	[
		"71304cc38b22a234cfc6769d8acae26325f1acc9bc0e721c9720c5615f56f970",
		"next 16.3.6 turbopack worker entry, minified (production builds)",
	],
	[
		"e007a3d94c95c3d62814cd7fc5ef8c9637255a364bf5f826d54c90e208c88612",
		"next 16.3.6 turbopack worker entry, unminified (inspection builds)",
	],
]);
/**
 * Production name, or `next dev`'s name below `.next/dev` (observed:
 * `turbopack-worker-[client-fs]__next_static_chunks_1_hyozq._.js`). The path
 * only admits the file to the exact body check below.
 */
const WORKER_PATH =
	/^(?:static\/chunks\/turbopack-worker-[\w-]+|dev\/static\/chunks\/turbopack-worker-\[client-fs\]__[\w.-]+)\.js$/;

/** Problems with a worker-entry body; empty means it is a pinned body. */
export function workerEntryProblems(code: string): string[] {
	const digest = sha256(code);
	if (PINNED_WORKER_ENTRIES.has(digest)) return [];
	const pinned = [...PINNED_WORKER_ENTRIES.keys()]
		.map((hash) => hash.slice(0, 12))
		.join(", ");
	return [
		`body sha256 ${digest} is not a reviewed Next worker bootstrap (pinned: ${pinned})`,
	];
}

/** Evidence for a Turbopack worker entry, or undefined. */
export function turbopackWorkerEntry(
	chunk: string,
	text: string,
	bytes: number,
): string[] | undefined {
	if (!WORKER_PATH.test(chunk) || bytes > BOOTSTRAP_MAX_BYTES) return undefined;
	const body = withoutMapComment(text);
	if (workerEntryProblems(body).length > 0) return undefined;
	const digest = sha256(body);
	return [
		`path ${chunk.startsWith("dev/") ? "dev/static/chunks/turbopack-worker-[client-fs]__*.js" : "static/chunks/turbopack-worker-*.js"}, ${bytes} B <= ${BOOTSTRAP_MAX_BYTES} B`,
		`body sha256 ${digest}: ${PINNED_WORKER_ENTRIES.get(digest)}`,
		"exact match with a reviewed Next 16.3.6 bootstrap; only the trailing map comment is ignored",
	];
}

/**
 * Classifier for one output. Returns undefined for anything outside the
 * classes above; the caller keeps such a file unmapped or failing.
 */
export function createGeneratedClassifier(
	options: ClassifierOptions,
): (chunk: string, bytes: Buffer, map?: MapForm) => GeneratedFile | undefined {
	const installed = indexInstalled(options.installedFiles ?? []);
	const shapes = new Set(options.shapes ?? []);
	const outputFiles = new Set(options.outputFiles);
	const distBasenames = new Set([
		...walk(options.installedDist, /\.(m|c)?js$/).map((file) => basename(file)),
		...[...RULE_OUTPUTS.keys()].map((file) => basename(file)),
	]);
	return (chunk, bytes, map = "none") => {
		const text = bytes.toString("utf8");
		const hash = sha256(bytes);
		const entry = { chunk, bytes: bytes.length, sha256: hash };
		// `next dev` shapes run their own token check on the text without the
		// verified literals; every other class needs a clean full text.
		if (shapes.has("turbopack-dev")) {
			const dev = turbopackDevFile(chunk, text, bytes.length, map, {
				outputFiles,
				distBasenames,
				installedDist: options.installedDist,
				...(options.projectRoot === undefined
					? {}
					: { projectRoot: options.projectRoot }),
			});
			if (dev) {
				return {
					...entry,
					kind: "turbopack-bootstrap",
					provenance: {
						source: "structure",
						generator: "turbopack",
						shape: dev.shape,
						evidence: dev.evidence,
						references: dev.references,
					},
				};
			}
		}
		// Exact bytes of the shipped stub: the one file allowed to name
		// Spinetab without a map, so it runs before the token control.
		const stub = stubCopyEvidence(chunk, bytes, options.installedDist);
		if (stub) {
			return {
				...entry,
				kind: "spinetab-stub",
				provenance: {
					source: "spinetab",
					file: "dist/auto/worker.js",
					evidence: stub,
				},
			};
		}
		if (tokenProblems(text, distBasenames).length > 0) return undefined;
		const copied = installed.get(hash);
		if (copied) {
			return { ...entry, kind: "installed-file", provenance: copied };
		}
		if (shapes.has("next-manifest")) {
			const evidence = nextManifest(chunk, text, bytes.length, options.buildId);
			if (evidence) {
				return {
					...entry,
					kind: "next-manifest",
					provenance: {
						source: "structure",
						generator: "next",
						shape: /_(\w+)\.js$/.exec(chunk)?.[1] ?? "manifest",
						evidence: [...evidence, "negative tokens absent"],
					},
				};
			}
		}
		if (shapes.has("next-webpack")) {
			const manifest = nextWebpackManifest(
				chunk,
				text,
				bytes.length,
				options.buildId,
			);
			if (manifest) {
				return {
					...entry,
					kind: "next-manifest",
					provenance: {
						source: "structure",
						generator: "next",
						shape: "webpack-buildManifest",
						evidence: [...manifest, "negative tokens absent"],
					},
				};
			}
			const stub =
				map === "none"
					? nextWebpackEntryStub(chunk, text, bytes.length)
					: undefined;
			if (stub) {
				return {
					...entry,
					kind: "webpack-bootstrap",
					provenance: {
						source: "structure",
						generator: "webpack",
						shape: "entry-stub",
						evidence: [...stub, "negative tokens absent"],
					},
				};
			}
		}
		if (shapes.has("turbopack-bootstrap")) {
			for (const [shape, evidence] of [
				["worker-entry", turbopackWorkerEntry(chunk, text, bytes.length)],
				[
					"async-loader",
					turbopackLoader(chunk, text, bytes.length, outputFiles),
				],
			] as const) {
				if (!evidence) continue;
				return {
					...entry,
					kind: "turbopack-bootstrap",
					provenance: {
						source: "structure",
						generator: "turbopack",
						shape,
						evidence: [...evidence, "negative tokens absent"],
					},
				};
			}
		}
		return undefined;
	};
}

/**
 * How a map attributes nothing, or undefined: `empty` is version 3, no
 * sources and empty mappings; `empty-sections` is exactly the index map
 * `next dev` writes for its async loaders, `{"version":3,"sources":[],"sections":[]}`
 * (these three keys only, no `mappings`). Anything else, including non-empty
 * sections, non-array sources or `mappings` beside `sections`, is not empty
 * and keeps the decoder's problems.
 */
export function emptyMapForm(
	json: unknown,
): Exclude<MapForm, "none"> | undefined {
	if (typeof json !== "object" || json === null || Array.isArray(json)) {
		return undefined;
	}
	const map = json as Record<string, unknown>;
	if (map.version !== 3) return undefined;
	const noSources = Array.isArray(map.sources) && map.sources.length === 0;
	if ("sections" in map) {
		const keys = Object.keys(map).sort().join(",");
		return keys === "sections,sources,version" &&
			noSources &&
			Array.isArray(map.sections) &&
			map.sections.length === 0
			? "empty-sections"
			: undefined;
	}
	return noSources && map.mappings === "" ? "empty" : undefined;
}

/** A map that attributes nothing (`emptyMapForm`). */
export const isEmptyMap = (json: unknown): boolean =>
	emptyMapForm(json) !== undefined;

// Plugin output. The matrix keeps its
// own copy of the adapter table so the generator is checked against an
// independent oracle, not against itself.

/** Adapter kind → factory export and runtime specifier. */
export const GENERATED_ADAPTERS: Readonly<
	Record<string, { factory: string; runtime: string }>
> = {
	"ai-sdk": { factory: "aiSdkAdapter", runtime: "spinetab/ai-sdk/runtime" },
	"graphql-sse": {
		factory: "graphqlSseAdapter",
		runtime: "spinetab/graphql-sse/runtime",
	},
	"graphql-ws": {
		factory: "graphqlWsAdapter",
		runtime: "spinetab/graphql-ws/runtime",
	},
	polling: { factory: "pollingAdapter", runtime: "spinetab/polling/runtime" },
	"socket-io": {
		factory: "socketIoAdapter",
		runtime: "spinetab/socket-io/runtime",
	},
	sse: { factory: "sseAdapter", runtime: "spinetab/sse/runtime" },
	stream: { factory: "streamAdapter", runtime: "spinetab/stream/runtime" },
	"trpc-sse": { factory: "trpcSseAdapter", runtime: "spinetab/trpc/runtime" },
	"trpc-ws": { factory: "trpcWsAdapter", runtime: "spinetab/trpc/runtime" },
	websocket: {
		factory: "websocketAdapter",
		runtime: "spinetab/websocket/runtime",
	},
};

export const GENERATED_HEADER = "// Generated by spinetab. Do not edit.";

/** An exact `credentialOrigins` entry after normalisation. */
function canonicalOrigin(value: unknown): boolean {
	if (typeof value !== "string") return false;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	// Allowed loopback hosts (`isLoopbackHost` in src/core/origins.ts), restated
	// so the oracle stays independent of the code it checks.
	const host = url.hostname;
	const loopback =
		host === "localhost" ||
		host.endsWith(".localhost") ||
		host === "[::1]" ||
		/^127\.\d+\.\d+\.\d+$/.test(host);
	return (
		url.origin === value &&
		(url.protocol === "https:" || (url.protocol === "http:" && loopback))
	);
}

/** The one text allows for an adapter set and origins, or undefined. */
export function canonicalWorker(
	kinds: readonly string[],
	origins: readonly string[] = [],
): string | undefined {
	const sorted = [...new Set(kinds)].sort();
	if (sorted.some((kind) => !GENERATED_ADAPTERS[kind])) return undefined;
	const byRuntime = new Map<string, string[]>();
	for (const kind of sorted) {
		const { factory, runtime } = GENERATED_ADAPTERS[kind] as {
			factory: string;
			runtime: string;
		};
		byRuntime.set(runtime, [...(byRuntime.get(runtime) ?? []), factory]);
	}
	const imports = [...byRuntime.keys()]
		.sort()
		.map(
			(runtime) =>
				`import { ${(byRuntime.get(runtime) as string[]).sort().join(", ")} } from "${runtime}";`,
		);
	const calls = sorted
		.map((kind) => `${GENERATED_ADAPTERS[kind]?.factory}()`)
		.join(", ");
	const options =
		origins.length > 0
			? `, { credentialOrigins: ${JSON.stringify(origins)} }`
			: "";
	return [
		GENERATED_HEADER,
		...imports,
		'import { defineWorker } from "spinetab/worker";',
		`export default defineWorker(() => [${calls}]${options});`,
	].join("\n");
}

export interface GeneratedWorker {
	kinds: string[];
	credentialOrigins: string[];
	/** Runtime specifiers it imports, for the inspection's `exercised`. */
	specifiers: string[];
	/** First 12 hex of its SHA-256 (the development worker `name`). */
	hash12: string;
}

const CALL =
	/^export default defineWorker\(\(\) => \[(?<calls>[^\]]*)\](?:, \{ credentialOrigins: (?<origins>\[[^\n]*\]) \})?\);$/;

/**
 * Parse loader or `load` output against the strict grammar: recover the
 * adapter set and origins from the last line, rebuild the one canonical text
 * for them and require byte equality (one optional trailing `\n`). Anything
 * else (a comment, a path, `process.env`, another import, unsorted or
 * duplicated entries, non-canonical origins) is a problem.
 */
export function parseGeneratedWorker(
	text: string,
): { worker: GeneratedWorker } | { problems: string[] } {
	const body = text.endsWith("\n") ? text.slice(0, -1) : text;
	if (body.includes("\r")) return { problems: ["has \\r line ends"] };
	const last = body.split("\n").at(-1) ?? "";
	const match = CALL.exec(last);
	if (!match?.groups) {
		return { problems: ["last line is not the defineWorker export"] };
	}
	const byFactory = new Map(
		Object.entries(GENERATED_ADAPTERS).map(([kind, row]) => [
			row.factory,
			kind,
		]),
	);
	const calls = (match.groups.calls ?? "").trim();
	const kinds: string[] = [];
	for (const call of calls === "" ? [] : calls.split(", ")) {
		const kind = byFactory.get(call.replace(/\(\)$/, ""));
		if (!kind || !call.endsWith("()")) {
			return { problems: [`unknown adapter call ${call}`] };
		}
		kinds.push(kind);
	}
	let origins: string[] = [];
	if (match.groups.origins !== undefined) {
		try {
			origins = JSON.parse(match.groups.origins) as string[];
		} catch {
			return { problems: ["credentialOrigins is not a JSON array"] };
		}
		if (
			!Array.isArray(origins) ||
			origins.length === 0 ||
			!origins.every(canonicalOrigin) ||
			JSON.stringify([...new Set(origins)].sort()) !== JSON.stringify(origins)
		) {
			return {
				problems: [
					"credentialOrigins is not a non-empty, normalised, de-duplicated, sorted origin list",
				],
			};
		}
	}
	const canonical = canonicalWorker(kinds, origins);
	if (canonical === undefined || canonical !== body) {
		return {
			problems: [
				"text differs from the canonical generated worker for its own adapter set",
			],
		};
	}
	const sortedKinds = [...kinds].sort();
	return {
		worker: {
			kinds: sortedKinds,
			credentialOrigins: origins,
			specifiers: [
				...new Set(
					sortedKinds.map(
						(kind) => GENERATED_ADAPTERS[kind]?.runtime as string,
					),
				),
				"spinetab/worker",
			].sort(),
			hash12: sha256(text).slice(0, 12),
		},
	};
}

/** The shipped production literal and the development `name` variant. */
const WIRING_OPTIONS = '{ type: "module" }';
const DEV_NAME = /\{ type: "module", name: "spinetab-(?<hash>[0-9a-f]{12})" \}/;

/**
 * Check a bundled copy of `spinetab/dist/auto/wiring.js` against the
 * installed file: byte-equal (map comment aside) in every output, or, in
 * development only, equal after replacing the one development `name` option
 * back. Returns the development hash when present.
 */
export function wiringCopyProblems(
	content: string,
	installed: string,
	development: boolean,
): { problems: string[]; hash?: string } {
	const strip = (text: string) => withoutMapComment(text).trimEnd();
	const shipped = strip(installed);
	const copy = strip(content);
	if (!shipped.includes(WIRING_OPTIONS)) {
		return {
			problems: ["installed auto/wiring.js lacks the pinned literal"],
		};
	}
	if (copy === shipped) return { problems: [] };
	const hash = DEV_NAME.exec(copy)?.groups?.hash;
	if (hash === undefined) {
		return {
			problems: ["bundled auto/wiring.js differs from the shipped file"],
		};
	}
	if (!development) {
		return {
			problems: ["a development worker name in a production build"],
		};
	}
	if (copy.replace(DEV_NAME, WIRING_OPTIONS) !== shipped) {
		return {
			problems: [
				"bundled auto/wiring.js differs from the shipped file beyond the development name",
			],
		};
	}
	return { problems: [], hash };
}

/**
 * Local paths that never belong in emitted production or development
 * output, including source maps.
 */
export const LOCAL_PATH =
	/^(\/|file:|\\|[a-z]:)|\/Users\/|\/home\/|\/tmp\/|\/private\/|\\Users\\/i;

/** Absolute-path fragments inside a text (not anchored: any occurrence). */
export function localPathsIn(text: string, roots: readonly string[]): string[] {
	const found = new Set<string>();
	for (const root of roots) {
		if (root && text.includes(root)) found.add(root);
	}
	for (const match of text.matchAll(
		/(?:\/Users\/|\/home\/|\/private\/|[A-Z]:\\Users\\)[^\s"'`)]+/g,
	)) {
		found.add(match[0]);
	}
	return [...found].sort();
}

/**
 * The one map source Next 16.3.6 `--webpack` builds name with an absolute
 * path, with or without Spinetab: its empty `private-next-instrumentation-client`
 * module, labelled `ignored|<next>/dist/build/webpack/loaders|<request>`. Only
 * this exact label, inside the installed `next` package, is exempt from the path scan.
 */
export const NEXT_IGNORED_MODULE =
	/^webpack:\/\/_N_E\/ignored\|[^|]*\/node_modules\/next\/dist\/build\/webpack\/loaders\|private-next-instrumentation-client-user$/;

const INLINE_MAP =
	/sourceMappingURL=data:application\/json[^,\s"'\\]*;base64,([A-Za-z0-9+/=]+)/g;

/**
 * Sources of every inline `data:` sourcemap in a text, including maps inside
 * webpack's development `eval` strings, with `sourceRoot` prepended. An
 * undecodable map yields `null`, which callers treat as a problem.
 */
export function inlineMapSources(text: string): Array<string | null> {
	const sources: Array<string | null> = [];
	for (const match of text.matchAll(INLINE_MAP)) {
		let json: { sourceRoot?: unknown; sources?: unknown };
		try {
			json = JSON.parse(
				Buffer.from(match[1] as string, "base64").toString("utf8"),
			) as typeof json;
		} catch {
			sources.push(null);
			continue;
		}
		const root =
			typeof json.sourceRoot === "string" && json.sourceRoot !== ""
				? json.sourceRoot.replace(/\/?$/, "/")
				: "";
		for (const source of Array.isArray(json.sources) ? json.sources : []) {
			if (typeof source === "string") sources.push(`${root}${source}`);
		}
	}
	return sources;
}

/**
 * Source-map metadata in code text: `sourceMappingURL` (inline `data:` maps
 * included) and `sourceURL` comments, up to the end of the URL (whitespace,
 * a quote or the backslash of an escaped line end inside an `eval` string).
 */
const MAP_METADATA = /([#@])\s*source(?:MappingURL|URL)=[^\s"'`\\]*/g;

/** The text with its source-map metadata comments emptied (`MAP_METADATA`). */
export const withoutMapMetadata = (text: string): string =>
	text.replace(MAP_METADATA, "$1");

/**
 * Scan one piece of development output (a dev-server response, or a
 * module of a development chunk): local paths in the text and, with
 * `mapSources` (the default), in the sources of its inline maps
 * (`LOCAL_PATH`), Next's ignored-module label aside. Without `mapSources`
 * the map metadata is the bundler's, not generated text: webpack's
 * development `eval` maps and Turbopack's dev maps name every module by its
 * absolute path, with or without Spinetab. The code is then scanned with the
 * metadata removed, and an undecodable inline map still counts.
 */
export function devTextLocalPaths(
	text: string,
	roots: readonly string[],
	options: { mapSources?: boolean } = {},
): string[] {
	const mapSources = options.mapSources ?? true;
	const found = new Set(
		localPathsIn(mapSources ? text : withoutMapMetadata(text), roots),
	);
	for (const source of inlineMapSources(text)) {
		if (source === null) found.add("an undecodable inline sourcemap");
		else if (
			mapSources &&
			LOCAL_PATH.test(source) &&
			!NEXT_IGNORED_MODULE.test(source)
		) {
			found.add(source);
		}
	}
	return [...found].sort();
}

/** webpack's development module header: `/***\/ "<id>":`. */
const WEBPACK_DEV_MODULE = /\/\*{3}\/ "([^"]+)":/g;
/**
 * Turbopack's development module entry at the start of a line:
 * `"[project]/<path> [app-client] (ecmascript)", ((__turbopack_context__) => {`
 * or `"<id> (raw)", (function(__turbopack_context__) {`.
 */
const TURBOPACK_DEV_MODULE =
	/^"(\[[\w-]+\]\/[^"\n]+)",\s*\(\s*(?:function\s*)?\(?\s*__turbopack_context__\b/gm;

/**
 * The modules of a webpack or Turbopack development chunk whose id names
 * Spinetab (the seams, the loader's generated worker, the runtime entries),
 * each as its own text from its header to the next. A chunk that names
 * Spinetab but has no such header is returned whole, so nothing goes
 * unscanned.
 */
export function spinetabDevModules(
	text: string,
): Array<{ id: string; text: string }> {
	if (!/spinetab/i.test(text)) return [];
	const starts = [
		...text.matchAll(WEBPACK_DEV_MODULE),
		...text.matchAll(TURBOPACK_DEV_MODULE),
	].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
	if (starts.length === 0) return [{ id: "(whole chunk)", text }];
	return starts.flatMap((match, index) => {
		const id = match[1] as string;
		if (!/spinetab/i.test(id)) return [];
		const end = starts[index + 1]?.index ?? text.length;
		return [{ id, text: text.slice(match.index, end) }];
	});
}

export const STUB_MEDIA_PATH = /^(?:dev\/)?static\/media\/[\w.-]+\.js$/;

export function stubCopyEvidence(
	chunk: string,
	bytes: Buffer,
	installedDist: string,
): string[] | undefined {
	if (!STUB_MEDIA_PATH.test(chunk)) return undefined;
	const stub = join(installedDist, "auto/worker.js");
	if (!existsSync(stub)) return undefined;
	const shipped = readFileSync(stub);
	if (sha256(bytes) !== sha256(shipped)) return undefined;
	return [
		"path static/media/*.js (Turbopack's copy of the worker URL target)",
		`sha256 ${sha256(bytes)} equals the installed spinetab dist/auto/worker.js`,
		"exact bytes: the keep stub, never application or generated source",
	];
}
