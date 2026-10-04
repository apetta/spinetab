import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import ts from "typescript";
import { areaOf, isBareSpecifier, isNodeBuiltin } from "./allowlist.ts";

/**
 * Import-graph helpers over emitted files. Static and
 * dynamic imports, re-exports and `require()` calls come from
 * `ts.preProcessFile(text, true, true)`; areas come from each JS file's own
 * sourcemap `sources`, or from `//#region src/…` markers in declarations.
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
 * Source areas of an emitted file. JS: its map's `sources`, relative to the
 * package root. Declarations: `//#region src/…` markers (no declaration maps
 * are emitted). Unmapped files yield `unmapped:<file>`.
 */
export function areasOf(root: string, file: string): string[] {
	const areas = new Set<string>();
	for (const source of sourcesOf(root, file)) {
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
 * `auto/worker.d.ts`). rolldown-plugin-dts writes no region marker for it,
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

/** Source paths relative to the package root (`src/…`) for an emitted file. */
export function sourcesOf(root: string, file: string): string[] {
	const packageRoot = dirname(resolve(root));
	const distName = relative(packageRoot, resolve(root)).replace(/\\/g, "/");
	if (isDeclaration(file)) {
		const text = readFileSync(join(root, file), "utf8");
		return [...text.matchAll(/\/\/#region (src\/\S+)/g)].map((match) =>
			(match[1] as string).replace(/\.d\.(c|m)?ts$/, ".ts"),
		);
	}
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
