import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { decode } from "@jridgewell/sourcemap-codec";
import { describe, expect, it } from "vitest";
import { distDir, packageRoot } from "./dist.ts";
import { walk } from "./graph.ts";
import {
	inlineMap,
	LOCAL,
	localEntries,
	localEntriesOfText,
	localPathsInText,
	scanLocalPaths,
} from "./sourcemap-scan.ts";

/**
 * Sourcemaps. Every emitted JS file references a map that exists
 * and is valid: version 3, one `sourcesContent` per source, every mapping
 * segment inside the source list, no absolute or local path. Any other
 * `sourceMappingURL` (declarations) must resolve too: a dangling reference is
 * a broken map. No exemption for empty files.
 */
interface SourceMap {
	version: number;
	file?: string;
	sources: Array<string | null>;
	sourcesContent?: Array<string | null>;
	names?: string[];
	mappings: string;
}

const files = walk(distDir);
const reference = (text: string) =>
	[...text.matchAll(/\/\/# sourceMappingURL=(\S+)\s*$/gm)].at(-1)?.[1];

describe("dist sourcemaps", () => {
	for (const file of files.filter((name) => /\.c?js$/.test(name))) {
		it(`${file} has a valid, resolvable map`, () => {
			const text = readFileSync(join(distDir, file), "utf8");
			const url = reference(text);
			expect(url, "sourceMappingURL comment").toBeDefined();
			const mapPath = join(distDir, dirname(file), url as string);
			expect(existsSync(mapPath), mapPath).toBe(true);
			const map = JSON.parse(readFileSync(mapPath, "utf8")) as SourceMap;
			expect(map.version).toBe(3);
			if (map.file !== undefined) expect(map.file).toBe(basename(file));
			expect(map.sources.length).toBeGreaterThan(0);
			expect(map.sourcesContent?.length).toBe(map.sources.length);
			const local = map.sources.filter(
				(source) => typeof source !== "string" || LOCAL.test(source),
			);
			expect(local).toEqual([]);
			const invalid: string[] = [];
			decode(map.mappings).forEach((line, lineIndex) => {
				for (const segment of line) {
					if (segment.length === 1) continue;
					const [, source, , , name] = segment;
					if (source === undefined || source >= map.sources.length) {
						invalid.push(`line ${lineIndex}: source ${source}`);
					}
					if (name !== undefined && name >= (map.names?.length ?? 0)) {
						invalid.push(`line ${lineIndex}: name ${name}`);
					}
				}
			});
			expect(invalid).toEqual([]);
		});
	}

	it("has no dangling sourceMappingURL in any emitted file", () => {
		const dangling = files
			.filter((name) => !name.endsWith(".map"))
			.flatMap((name) => {
				const url = reference(readFileSync(join(distDir, name), "utf8"));
				if (!url || url.startsWith("data:")) return [];
				return existsSync(join(distDir, dirname(name), url))
					? []
					: [`${name} → ${url}`];
			});
		expect(dangling).toEqual([]);
	});

	it("has no local path in any map (sources, sourceRoot, file, sourcesContent) or emitted text", () => {
		// The checkout itself is a needle too, so a CI path such as `/__w/…`
		// counts even where the generic pattern does not know it.
		const checkout = resolve(packageRoot, "../..");
		expect(scanLocalPaths(distDir, [checkout])).toEqual([]);
	});

	it("has no orphaned map files", () => {
		const orphans = files
			.filter((name) => name.endsWith(".map"))
			.filter((name) => !files.includes(name.slice(0, -".map".length)));
		expect(orphans).toEqual([]);
	});
});

describe("the LOCAL scan (shared with the consumer matrix's development output)", () => {
	const encode = (map: object) =>
		`data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString("base64")}`;

	it("flags absolute, file-URL, Windows and home paths, and passes relative ones", () => {
		for (const path of [
			"/Users/dev/app/src/spinetab.worker.ts",
			"file:///home/dev/app/x.ts",
			"C:\\app\\x.ts",
			"\\\\server\\x.ts",
			"../../private/var/folders/x.ts",
			"webpack:///Users/dev/app/x.ts",
		]) {
			expect(LOCAL.test(path), path).toBe(true);
		}
		for (const path of [
			"../src/index.ts",
			"webpack://app/./src/main.ts",
			"spinetab/dist/worker-config.js",
		]) {
			expect(LOCAL.test(path), path).toBe(false);
		}
	});

	it("reads sources, sourceRoot, file and index-map sections", () => {
		expect(
			localEntries({
				file: "/tmp/out.js",
				sourceRoot: "/Users/dev/",
				sources: ["a.ts", null],
				sections: [{ map: { sources: ["/home/dev/b.ts"] } }],
			}),
		).toEqual([
			"sources: null",
			"sourceRoot: /Users/dev/",
			"file: /tmp/out.js",
			"sources: /home/dev/b.ts",
		]);
	});

	it("reads sourcesContent: the E4 development leak", () => {
		expect(
			localEntries({
				sources: ["webpack://app/./src/live.ts"],
				sourcesContent: [
					'export { default } from "/private/tmp/fixture-501/app/src/live.worker.js";\n',
					null,
				],
			}),
		).toEqual([
			"sourcesContent[0]: /private/tmp/fixture-501/app/src/live.worker.js",
		]);
	});

	it("finds paths anywhere in a text, but not in URLs or relative paths", () => {
		expect(
			localPathsInText(
				[
					'import w from "/Users/dev/app/src/spinetab.worker.ts";',
					'new URL("file:///home/dev/app/x.js");',
					'require("C:\\\\Users\\\\dev\\\\x.js");',
					'const y = "D:/home/dev/y.js";',
					'fetch("https://example.com/home/feed");',
					'import z from "../private/z.js";',
					"const t = a /tmp/ b;",
				].join("\n"),
			),
		).toEqual([
			"/Users/dev/app/src/spinetab.worker.ts",
			"/tmp/",
			"C:\\\\Users\\\\dev\\\\x.js",
			"D:/home/dev/y.js",
			"file:///home/dev/app/x.js",
		]);
		expect(
			localPathsInText("at /__w/spinetab/spinetab/x.js", ["/__w/spinetab"]),
		).toEqual(["/__w/spinetab"]);
	});

	it("scans emitted text and every map field in an output directory", () => {
		const dir = join(packageRoot, "test-results/sourcemap-scan");
		rmSync(dir, { recursive: true, force: true });
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "chunk.js"),
			'import w from "/Users/dev/app/w.js";\n//# sourceMappingURL=chunk.js.map\n',
		);
		writeFileSync(
			join(dir, "chunk.js.map"),
			JSON.stringify({
				version: 3,
				sources: ["../src/w.ts"],
				sourcesContent: ['export { default } from "/home/dev/w.ts";'],
				mappings: "",
			}),
		);
		writeFileSync(join(dir, "clean.js"), 'import "./chunk.js";\n');
		expect(scanLocalPaths(dir)).toEqual([
			"chunk.js: text: /Users/dev/app/w.js",
			"chunk.js.map: sourcesContent[0]: /home/dev/w.ts",
		]);
	});

	it("decodes inline maps in emitted text", () => {
		const url = encode({ version: 3, sources: ["/Users/dev/app/x.ts"] });
		expect(inlineMap(url)?.sources).toEqual(["/Users/dev/app/x.ts"]);
		const text = `console.log(1);\n//# sourceMappingURL=${url}\n`;
		expect(localEntriesOfText(text, () => undefined)).toEqual([
			"sources: /Users/dev/app/x.ts",
		]);
		expect(
			localEntriesOfText("x;\n//# sourceMappingURL=x.js.map\n", () => ({
				sources: ["../src/x.ts"],
			})),
		).toEqual([]);
	});
});
