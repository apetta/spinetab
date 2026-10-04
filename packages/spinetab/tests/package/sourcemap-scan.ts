import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { walk } from "./graph.ts";

/** Scan emitted code and every sourcemap field, including sourcesContent, for machine-local paths. */

/** A whole source entry that is absolute, a file URL, a drive letter or a home/temp path. */
export const LOCAL =
	/^(\/|file:|\\|[a-z]:)|\/Users\/|\/home\/|\/tmp\/|\/private\/|\\Users\\/i;

/**
 * Machine-local paths anywhere in a text (not anchored). A POSIX match must
 * start the path, so `https://example.com/home/feed` is not one; a Windows
 * one may use `/`, `\` or, inside an emitted string literal, `\\`.
 */
export const LOCAL_IN_TEXT =
	/(?:file:\/\/|(?<![\w.:/~-])\/(?:Users|home|private|tmp|root|var\/folders)\/|\b[A-Za-z]:(?:\\{1,2}|\/)(?:Users|home)(?:\\|\/))[^\s"'`)]*/g;

/**
 * Local paths in a text: each `LOCAL_IN_TEXT` match, and each of `roots`
 * (for example the checkout or the consumer's directory) that occurs
 * verbatim. Sorted and de-duplicated.
 */
export function localPathsInText(
	text: string,
	roots: readonly string[] = [],
): string[] {
	const found = new Set<string>();
	for (const match of text.matchAll(LOCAL_IN_TEXT)) found.add(match[0]);
	for (const root of roots) {
		if (root && text.includes(root)) found.add(root);
	}
	return [...found].sort();
}

export interface SourceMapLike {
	version?: number;
	file?: string;
	sourceRoot?: string;
	sources?: Array<string | null>;
	sourcesContent?: Array<string | null>;
	sections?: Array<{ map?: SourceMapLike }>;
}

/**
 * Local entries of one map: `sources`, `sourceRoot`, `file`, every
 * `sourcesContent` text and index-map sections.
 */
export function localEntries(
	map: SourceMapLike,
	roots: readonly string[] = [],
): string[] {
	const found: string[] = [];
	for (const source of map.sources ?? []) {
		if (typeof source !== "string") found.push(`sources: ${String(source)}`);
		else if (LOCAL.test(source)) found.push(`sources: ${source}`);
	}
	if (map.sourceRoot && LOCAL.test(map.sourceRoot)) {
		found.push(`sourceRoot: ${map.sourceRoot}`);
	}
	if (map.file && LOCAL.test(map.file)) found.push(`file: ${map.file}`);
	(map.sourcesContent ?? []).forEach((content, index) => {
		if (typeof content !== "string") return;
		for (const path of localPathsInText(content, roots)) {
			found.push(`sourcesContent[${index}]: ${path}`);
		}
	});
	for (const section of map.sections ?? []) {
		if (section.map) found.push(...localEntries(section.map, roots));
	}
	return found;
}

/** The last `sourceMappingURL` of a JS or CSS text. */
export function mapReference(text: string): string | undefined {
	return [
		...text.matchAll(/\/[/*][#@] sourceMappingURL=([^\s*]+)\s*(?:\*\/)?\s*$/gm),
	].at(-1)?.[1];
}

/** Decode an inline `data:` map, or undefined when the URL is not one. */
export function inlineMap(url: string): SourceMapLike | undefined {
	const match = /^data:application\/json;(?:charset=[^;,]+;)?base64,(.+)$/.exec(
		url,
	);
	if (!match) return undefined;
	return JSON.parse(
		Buffer.from(match[1] as string, "base64").toString("utf8"),
	) as SourceMapLike;
}

/** The code of an emitted text, without its `sourceMappingURL` comment. */
const codeOf = (text: string) =>
	text.replace(/\/[/*][#@] sourceMappingURL=[^\s*]+\s*(?:\*\/)?\s*$/gm, "");

/**
 * Local entries for one emitted text (a fetched dev-server response, say):
 * paths in the code itself, then its inline map, or the external map
 * `readMap` returns for its reference (undefined when absent).
 */
export function localEntriesOfText(
	text: string,
	readMap: (url: string) => SourceMapLike | undefined,
	roots: readonly string[] = [],
): string[] {
	const found = localPathsInText(codeOf(text), roots).map(
		(path) => `text: ${path}`,
	);
	const url = mapReference(text);
	const map = url ? (inlineMap(url) ?? readMap(url)) : undefined;
	return map ? [...found, ...localEntries(map, roots)] : found;
}

/**
 * Every local entry under an output directory: each `.map` file, and each
 * JS/CSS file's own text and inline map. Keys are `<file>: <entry>`,
 * relative to `dir`.
 */
export function scanLocalPaths(
	dir: string,
	roots: readonly string[] = [],
): string[] {
	const found: string[] = [];
	for (const file of walk(dir)) {
		if (file.endsWith(".map")) {
			const map = JSON.parse(
				readFileSync(join(dir, file), "utf8"),
			) as SourceMapLike;
			found.push(
				...localEntries(map, roots).map((entry) => `${file}: ${entry}`),
			);
		} else if (/\.(c|m)?js$|\.css$/.test(file)) {
			// External maps are read as `.map` files above; only inline ones here.
			const text = readFileSync(join(dir, file), "utf8");
			found.push(
				...localEntriesOfText(text, () => undefined, roots).map(
					(entry) => `${file}: ${entry}`,
				),
			);
		}
	}
	return found;
}

/** Read an external map relative to the file that references it. */
export const mapReader =
	(root: string, file: string) =>
	(url: string): SourceMapLike | undefined => {
		const path = join(root, dirname(file), url);
		return existsSync(path)
			? (JSON.parse(readFileSync(path, "utf8")) as SourceMapLike)
			: undefined;
	};
