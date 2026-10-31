import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, posix, relative, resolve } from "node:path";
import ts from "typescript";
import { areaOf, isBareSpecifier, isNodeBuiltin } from "./allowlist.ts";

/**
 * Import-graph helpers over emitted files. Static and
 * dynamic imports, re-exports and `require()` calls come from
 * `ts.preProcessFile(text, true, true)`; areas come from each JS file's own
 * sourcemap `sources`. Declarations ship without maps, so their sources come
 * from a separate declaration-map build bound to the candidate (see
 * `DeclarationMaps`); bundler comments are never read as provenance.
 */

export interface Closure {
	/** Files reached, relative to the root, entry first. */
	files: string[];
	/** Bare specifier → files importing it. */
	bare: Map<string, Set<string>>;
	/** Relative imports that did not resolve to a file. */
	unresolved: string[];
	/** `node:` built-in → files importing it (build realm only; see allowlist). */
	builtins: Map<string, Set<string>>;
	/** Dynamic `import()` edges between emitted files, `from → to`. */
	dynamic: Array<{ from: string; to: string }>;
}

/**
 * Every module a file names: imports, re-exports, `import()` (including
 * `import("x").T` types) and `require()`, then the triple-slash directives a
 * declaration can use to pull in types: `/// <reference types>` as a bare
 * specifier and `/// <reference path>` as a relative one (it is resolved
 * from the referencing file even without `./`).
 */
export function importsOf(text: string): string[] {
	const info = ts.preProcessFile(text, true, true);
	return [
		...info.importedFiles.map((file) => file.fileName),
		...info.typeReferenceDirectives.map((reference) => reference.fileName),
		...info.referencedFiles.map(({ fileName }) =>
			/^\.{0,2}\//.test(fileName) ? fileName : `./${fileName}`,
		),
	];
}

/**
 * String-literal `import()` specifiers of an emitted file, from its AST, so a
 * dynamic edge can be told from a static one (`preProcessFile` merges them).
 */
export function dynamicImportsOf(fileName: string, text: string): string[] {
	const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest);
	const found: string[] = [];
	const visit = (node: ts.Node) => {
		if (
			ts.isCallExpression(node) &&
			node.expression.kind === ts.SyntaxKind.ImportKeyword
		) {
			const [argument] = node.arguments;
			if (argument && ts.isStringLiteralLike(argument)) {
				found.push(argument.text);
			} else {
				// A computed specifier cannot be checked; report it as such.
				found.push("<computed>");
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return found;
}

export interface ClosureOptions {
	/** Follow dynamic `import()` edges (default true). */
	dynamic?: boolean;
}

/** Resolve a relative import from a JS or declaration file. */
export function resolveRelative(
	root: string,
	from: string,
	specifier: string,
): string | undefined {
	const base = posix.join(posix.dirname(from), specifier);
	const candidates = isDeclaration(from)
		? declarationCandidates(base, from)
		: [base];
	for (const candidate of candidates) {
		if (existsSync(join(root, candidate))) return posix.normalize(candidate);
	}
	return undefined;
}

function declarationCandidates(base: string, from: string): string[] {
	const cts = from.endsWith(".d.cts");
	if (/\.d\.(c|m)?ts$/.test(base)) return [base];
	const stem = base.replace(/\.(c|m)?js$/, "");
	return cts
		? [`${stem}.d.cts`, `${stem}.d.ts`]
		: [`${stem}.d.ts`, `${stem}.d.mts`, `${stem}.d.cts`];
}

export const isDeclaration = (file: string) => /\.d\.(c|m)?ts$/.test(file);

export function closureOf(
	root: string,
	entry: string,
	options: ClosureOptions = {},
): Closure {
	const followDynamic = options.dynamic ?? true;
	const files: string[] = [];
	const bare = new Map<string, Set<string>>();
	const builtins = new Map<string, Set<string>>();
	const unresolved: string[] = [];
	const dynamic: Array<{ from: string; to: string }> = [];
	const seen = new Set<string>();
	const queue = [posix.normalize(entry)];
	const record = (
		map: Map<string, Set<string>>,
		specifier: string,
		file: string,
	) => {
		const importers = map.get(specifier) ?? new Set<string>();
		importers.add(file);
		map.set(specifier, importers);
	};
	while (queue.length > 0) {
		const file = queue.shift() as string;
		if (seen.has(file)) continue;
		seen.add(file);
		files.push(file);
		const text = readFileSync(join(root, file), "utf8");
		const dynamicSpecifiers = isDeclaration(file)
			? []
			: dynamicImportsOf(file, text);
		for (const specifier of dynamicSpecifiers) {
			if (specifier === "<computed>") {
				unresolved.push(`${file} → import(<computed>)`);
			}
		}
		for (const specifier of importsOf(text)) {
			if (isNodeBuiltin(specifier)) {
				record(builtins, specifier, file);
				continue;
			}
			if (isBareSpecifier(specifier)) {
				record(bare, specifier, file);
				continue;
			}
			const target = resolveRelative(root, file, specifier);
			if (!target) {
				unresolved.push(`${file} → ${specifier}`);
				continue;
			}
			// preProcessFile lists a specifier once per occurrence; a file that
			// imports the same target statically too keeps the static edge.
			const isDynamic =
				dynamicSpecifiers.includes(specifier) &&
				importsOf(text).filter((name) => name === specifier).length ===
					dynamicSpecifiers.filter((name) => name === specifier).length;
			if (isDynamic) {
				dynamic.push({ from: file, to: target });
				if (!followDynamic) continue;
			}
			queue.push(target);
		}
	}
	return { files, bare, unresolved, builtins, dynamic };
}

/**
 * Source areas of an emitted file, from `sourcesOf`. Unmapped files yield
 * `unmapped:<file>`.
 */
export function areasOf(
	root: string,
	file: string,
	maps?: DeclarationMaps,
): string[] {
	const areas = new Set<string>();
	for (const source of sourcesOf(root, file, maps)) {
		areas.add(areaOf(source) ?? `unknown:${source}`);
	}
	if (areas.size === 0 && !(isDeclaration(file) && reexportsOnly(root, file))) {
		areas.add(`unmapped:${file}`);
	}
	return [...areas].sort();
}

/**
 * A declaration file that declares nothing itself: only import and
 * `export … from`/`export { … }` statements (the keep stub's
 * `auto/worker.d.ts`). rolldown-plugin-dts writes no declaration map for it,
 * so it carries no area of its own; its imports are still followed.
 */
export function reexportsOnly(root: string, file: string): boolean {
	const text = readFileSync(join(root, file), "utf8");
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest);
	return (
		source.statements.length > 0 &&
		source.statements.every(
			(statement) =>
				ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement),
		)
	);
}

/**
 * Declaration maps for a candidate `dist/`, from a separate build of the same
 * sources and config (`tests/package/declaration-maps.ts`). `candidate` is the
 * absolute directory the build was checked against; `dir` holds its output.
 */
export interface DeclarationMaps {
	candidate: string;
	dir: string;
}

const MAP_REFERENCE = /\n?\/\/# sourceMappingURL=(\S+)\s*$/;

/**
 * Source paths relative to the package root (`src/…`) for an emitted file.
 * JS: its own map. Declarations: the map beside the same file in `maps`,
 * once that file is byte-identical to the candidate's apart from its own map
 * reference. Missing, stale or unbound evidence throws rather than yielding
 * no sources, so a realm check cannot pass on absent provenance.
 */
export function sourcesOf(
	root: string,
	file: string,
	maps?: DeclarationMaps,
): string[] {
	const packageRoot = dirname(resolve(root));
	const distName = relative(packageRoot, resolve(root)).replace(/\\/g, "/");
	if (isDeclaration(file)) return declarationSources(root, file, maps);
	const mapPath = join(root, `${file}.map`);
	if (!existsSync(mapPath)) return [];
	const map = JSON.parse(readFileSync(mapPath, "utf8")) as {
		sources?: Array<string | null>;
	};
	return (map.sources ?? [])
		.filter((source): source is string => typeof source === "string")
		.map((source) =>
			posix.normalize(posix.join(distName, posix.dirname(file), source)),
		);
}

/**
 * The text a declaration-map build wrote for `file`, without its own map
 * reference, or why it cannot stand for the candidate's file.
 */
export function boundDeclaration(
	root: string,
	file: string,
	maps: DeclarationMaps,
): { text: string; mapped: boolean } | { problem: string } {
	if (resolve(root) !== maps.candidate) {
		return { problem: `maps were checked against ${maps.candidate}` };
	}
	const built = join(maps.dir, file);
	if (!existsSync(built))
		return { problem: "not in the declaration-map build" };
	const text = readFileSync(built, "utf8");
	const reference = MAP_REFERENCE.exec(text);
	if (reference && reference[1] !== `${basename(file)}.map`) {
		return { problem: `references another map: ${reference[1]}` };
	}
	const body = reference ? text.slice(0, reference.index) : text;
	if (body !== readFileSync(join(root, file), "utf8")) {
		return { problem: "differs from the candidate" };
	}
	return { text: body, mapped: existsSync(`${built}.map`) };
}

function declarationSources(
	root: string,
	file: string,
	maps: DeclarationMaps | undefined,
): string[] {
	const fail = (problem: string): never => {
		throw new Error(`${file}: ${problem}`);
	};
	if (!maps) return fail("declarations need declaration-map evidence");
	const bound = boundDeclaration(root, file, maps);
	if ("problem" in bound) return fail(bound.problem);
	if (!bound.mapped) {
		return reexportsOnly(root, file) ? [] : fail("no declaration map");
	}
	const mapPath = join(maps.dir, `${file}.map`);
	let map: {
		version?: unknown;
		file?: unknown;
		sourceRoot?: unknown;
		sources?: unknown;
	};
	try {
		map = JSON.parse(readFileSync(mapPath, "utf8"));
	} catch {
		return fail("declaration map is not JSON");
	}
	const sources = map.sources;
	if (
		map.version !== 3 ||
		map.file !== basename(file) ||
		(map.sourceRoot !== undefined && map.sourceRoot !== "") ||
		!Array.isArray(sources) ||
		sources.length === 0 ||
		!sources.every((source) => typeof source === "string")
	) {
		return fail("declaration map does not describe this file");
	}
	const packageRoot = dirname(resolve(root));
	return sources.map((source: string) => {
		const path = resolve(dirname(mapPath), source);
		if (!existsSync(path)) fail(`maps to a missing source: ${source}`);
		return relative(packageRoot, path).replace(/\\/g, "/");
	});
}

/** Every file below `root`, relative and sorted. */
export function walk(root: string): string[] {
	const files: string[] = [];
	const visit = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) visit(path);
			else files.push(relative(root, path).replace(/\\/g, "/"));
		}
	};
	if (existsSync(root)) visit(root);
	return files.sort();
}

export interface ExportTargets {
	subpath: string;
	import: { types: string; default: string };
	require?: { types: string; default: string };
}

export function exportTargets(manifest: {
	exports: Record<
		string,
		{
			import: { types: string; default: string };
			require?: { types: string; default: string };
		}
	>;
}): ExportTargets[] {
	return Object.entries(manifest.exports).map(([subpath, conditions]) => ({
		subpath,
		import: conditions.import,
		...(conditions.require ? { require: conditions.require } : {}),
	}));
}

/** `./dist/x.js` → `x.js` (relative to dist). */
export const distRelative = (target: string) =>
	target.replace(/^\.\/dist\//, "");
