import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { encode } from "@jridgewell/sourcemap-codec";
import { afterEach, describe, expect, it } from "vitest";
import {
	attributeChunk,
	gzipBytes,
	joinSpans,
	type SpinetabSpan,
} from "../../performance/size/attribute.ts";
import type { SizeScenario } from "../../performance/size/catalogue.ts";
import { deriveRows } from "../../performance/size/guard.ts";
import {
	createProvenanceResolver,
	isComposedEscape,
	parseStoreEntry,
	sha256,
	storeLocation,
} from "../../performance/size/provenance.ts";
import { diffMetrics, sameJson } from "../../performance/size/reattribute.ts";
import {
	attributeFile,
	CURRENT_VIEW,
	helperOwnFiles,
	informationalRows,
	summarise,
} from "../../performance/size/summary.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
const temp = () => {
	const dir = mkdtempSync(join(tmpdir(), "spinetab-size-attribution-"));
	dirs.push(dir);
	return dir;
};
const write = (path: string, text: string) => {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
};

const LOCATION = "export function getLocation(source) { return source; }\n";
const CHECK = "export function checkDocument(doc) { return doc; }\n";
const SHARED = "export const shared = 1;\n";
const APOLLO_ENTRY =
	"@apollo+client@4.3.1_graphql@17.0.2_react-do_c29a456796c0aa2837154ad9cfa30361";
const GRAPHQL_SOURCE =
	"turbopack:///[project]/node_modules/.pnpm/graphql@17.0.2/node_modules/src/language/location.ts";
const APOLLO_SOURCE = `turbopack:///[project]/node_modules/.pnpm/${APOLLO_ENTRY}/node_modules/@apollo/src/utilities/internal/checkDocument.ts`;

/** Input map as graphql 17.0.2 / @apollo/client 4.3.1 publish them. */
const inputMap = (sources: string[], contents: string[]) =>
	JSON.stringify({
		version: 3,
		sourceRoot: "",
		sources,
		sourcesContent: contents,
		mappings: "",
	});

/** A consumer project with a pnpm store shaped like the root full-1 run's. */
function project(): string {
	const dir = temp();
	const store = join(dir, "node_modules", ".pnpm");
	const graphql = join(store, "graphql@17.0.2", "node_modules", "graphql");
	write(join(graphql, "package.json"), '{"name":"graphql","version":"17.0.2"}');
	for (const map of ["language/location.mjs.map", "language/location.js.map"]) {
		write(
			join(graphql, map),
			inputMap(["../../src/language/location.ts"], [LOCATION]),
		);
	}
	const apolloModules = join(store, APOLLO_ENTRY, "node_modules");
	const apollo = join(apolloModules, "@apollo", "client");
	write(
		join(apollo, "package.json"),
		'{"name":"@apollo/client","version":"4.3.1"}',
	);
	write(
		join(apollo, "utilities/internal/checkDocument.js.map"),
		inputMap(["../../../src/utilities/internal/checkDocument.ts"], [CHECK]),
	);
	write(
		join(apollo, "__cjs/utilities/internal/checkDocument.cjs.map"),
		inputMap(["../../../../src/utilities/internal/checkDocument.ts"], [CHECK]),
	);
	// A symlinked dependency inside the entry is another store entry: skipped.
	symlinkSync(
		"../../graphql@17.0.2/node_modules/graphql",
		join(apolloModules, "graphql"),
	);
	// Two real packages in one entry listing the same composed body: ambiguous.
	const twin = join(store, "twin@1.0.0", "node_modules");
	for (const name of ["twin", "bundled"]) {
		write(
			join(twin, name, "package.json"),
			`{"name":"${name}","version":"1.0.0"}`,
		);
		write(
			join(twin, name, "index.js.map"),
			inputMap(["../src/x.ts"], [SHARED]),
		);
	}
	// Only a foreign real package lists the body: not the entry's own package.
	const host = join(store, "host@2.0.0", "node_modules");
	write(
		join(host, "host", "package.json"),
		'{"name":"host","version":"2.0.0"}',
	);
	write(
		join(host, "guest", "package.json"),
		'{"name":"guest","version":"9.9.9"}',
	);
	write(
		join(host, "guest", "index.js.map"),
		inputMap(["../src/y.ts"], [SHARED]),
	);
	return dir;
}

describe("store paths", () => {
	it("parses pnpm virtual-store entry names, including peer-suffixed and scoped", () => {
		expect(parseStoreEntry("graphql@17.0.2")).toMatchObject({
			name: "graphql",
			version: "17.0.2",
		});
		expect(parseStoreEntry(APOLLO_ENTRY)).toMatchObject({
			name: "@apollo/client",
			version: "4.3.1",
		});
		expect(
			parseStoreEntry("graphql-ws@6.3.0_graphql@17.0.2_ws@8.21.3"),
		).toMatchObject({ name: "graphql-ws", version: "6.3.0" });
		expect(parseStoreEntry("no-version")).toBeUndefined();
		expect(parseStoreEntry("@scope@1.0.0")).toBeUndefined();
	});

	it("locates the store entry from Turbopack and Vite source forms, never through ..", () => {
		expect(storeLocation(GRAPHQL_SOURCE)).toEqual({
			entry: "graphql@17.0.2",
			rest: "src/language/location.ts",
		});
		expect(
			storeLocation(
				"../../node_modules/.pnpm/graphql@17.0.2/node_modules/src/language/location.ts?x",
			),
		).toEqual({ entry: "graphql@17.0.2", rest: "src/language/location.ts" });
		expect(
			storeLocation(
				"node_modules/.pnpm/graphql@17.0.2/node_modules/graphql/../src/a.ts",
			),
		).toBeUndefined();
		expect(storeLocation("node_modules/src/a.ts")).toBeUndefined();
	});

	it("asks for provenance only outside the store entry's own package", () => {
		expect(isComposedEscape(GRAPHQL_SOURCE)).toBe(true);
		expect(isComposedEscape(APOLLO_SOURCE)).toBe(true);
		expect(
			isComposedEscape(
				"turbopack:///[project]/node_modules/.pnpm/graphql@17.0.2/node_modules/graphql/language/location.mjs",
			),
		).toBe(false);
		expect(
			isComposedEscape(
				"turbopack:///[project]/node_modules/.pnpm/spinetab@file+..+spinetab.tgz_x/node_modules/spinetab/src/core/client.ts",
			),
		).toBe(false);
		// Not a pnpm store path: never resolved, classified by path as before.
		expect(isComposedEscape("node_modules/src/language/location.ts")).toBe(
			false,
		);
	});
});

describe("composed peer provenance", () => {
	it("resolves graphql and @apollo/client composed bodies with input-map provenance", () => {
		const dir = project();
		const resolver = createProvenanceResolver(dir, {
			pinned: { graphql: "17.0.2", "@apollo/client": "4.3.1" },
		});
		const graphql = resolver.resolve(GRAPHQL_SOURCE, LOCATION);
		expect(graphql).toEqual({
			ok: true,
			provenance: {
				package: "graphql",
				version: "17.0.2",
				storeEntry: "graphql@17.0.2",
				bodySha256: sha256(LOCATION),
				inputMaps: [
					{
						path: "node_modules/.pnpm/graphql@17.0.2/node_modules/graphql/language/location.js.map",
						source: "../../src/language/location.ts",
						mapSha256: sha256(
							inputMap(["../../src/language/location.ts"], [LOCATION]),
						),
					},
					{
						path: "node_modules/.pnpm/graphql@17.0.2/node_modules/graphql/language/location.mjs.map",
						source: "../../src/language/location.ts",
						mapSha256: sha256(
							inputMap(["../../src/language/location.ts"], [LOCATION]),
						),
					},
				],
			},
		});
		const apollo = resolver.resolve(APOLLO_SOURCE, CHECK);
		expect(apollo.ok && apollo.provenance.package).toBe("@apollo/client");
		expect(apollo.ok && apollo.provenance.inputMaps).toHaveLength(2);
		// Vite-style relative source form resolves the same way.
		expect(
			resolver.resolve(
				"../../node_modules/.pnpm/graphql@17.0.2/node_modules/src/language/location.ts",
				LOCATION,
			).ok,
		).toBe(true);
	});

	it("fails closed: unknown body, unlisted path, no body, ambiguity, foreign package, pin, missing entry", () => {
		const resolver = createProvenanceResolver(project(), {
			pinned: { graphql: "17.0.2" },
		});
		const reason = (source: string, body: string | null) => {
			const result = resolver.resolve(source, body);
			return result.ok ? "resolved" : result.reason;
		};
		expect(reason(GRAPHQL_SOURCE, "tampered")).toMatch(
			/differs from every input map/,
		);
		expect(
			reason(
				"turbopack:///[project]/node_modules/.pnpm/graphql@17.0.2/node_modules/src/unknown.ts",
				LOCATION,
			),
		).toMatch(/no input map in graphql@17.0.2 lists src\/unknown.ts/);
		expect(reason(GRAPHQL_SOURCE, null)).toMatch(/no sourcesContent/);
		expect(
			reason("node_modules/.pnpm/twin@1.0.0/node_modules/src/x.ts", SHARED),
		).toMatch(
			/ambiguous: the body is in 2 packages \(bundled@1.0.0, twin@1.0.0\)/,
		);
		expect(
			reason("node_modules/.pnpm/host@2.0.0/node_modules/src/y.ts", SHARED),
		).toMatch(/belongs to guest@9.9.9, not the store entry's own host@2.0.0/);
		expect(
			reason(
				"node_modules/.pnpm/graphql@16.0.0/node_modules/src/a.ts",
				LOCATION,
			),
		).toMatch(/not installed/);
		const pinned = createProvenanceResolver(project(), {
			pinned: { graphql: "16.8.1" },
		});
		const result = pinned.resolve(GRAPHQL_SOURCE, LOCATION);
		expect(result.ok ? "resolved" : result.reason).toMatch(
			/not the pinned 16.8.1/,
		);
	});
});

/** One-line chunk whose segments map consecutive 4-character spans to `sources`. */
function chunk(
	dir: string,
	name: string,
	sources: Array<{ source: string; content: string | null }>,
	code = "A".repeat(4 * sources.length),
): string {
	const file = join(dir, "out", name);
	write(file, code);
	write(
		`${file}.map`,
		JSON.stringify({
			version: 3,
			sources: sources.map((entry) => entry.source),
			sourcesContent: sources.map((entry) => entry.content),
			names: [],
			mappings: encode([
				sources.map(
					(_, index) =>
						[index * 4, index, 0, 0] as [number, number, number, number],
				),
			]),
		}),
	);
	return file;
}

const SPINETAB_SOURCE =
	"turbopack:///[project]/node_modules/.pnpm/spinetab@file+..+spinetab.tgz_x/node_modules/spinetab/src/core/client.ts";

describe("chunk attribution with provenance", () => {
	const sources = [
		{ source: GRAPHQL_SOURCE, content: LOCATION },
		{ source: SPINETAB_SOURCE, content: "client" },
		{
			source:
				"turbopack:///[project]/node_modules/.pnpm/ws@8.21.3/node_modules/ws/browser.js",
			content: "ws",
		},
		{
			source:
				"turbopack:///[project]/node_modules/.pnpm/graphql@17.0.2/node_modules/src/unknown.ts",
			content: "not published by graphql",
		},
		{ source: APOLLO_SOURCE, content: CHECK },
	];

	it("re-keys verified bodies, keeps Spinetab, unrelated peers and unresolved paths", () => {
		const dir = project();
		const file = chunk(dir, "a.js", sources);
		const resolver = createProvenanceResolver(dir);
		const result = attributeChunk(file, { resolver, compare: true });
		expect(result.bytes).toEqual({
			"peer:graphql": 4,
			"spinetab:src/core/client.ts": 4,
			"peer:ws": 4,
			"peer:src": 4,
			"peer:@apollo/client": 4,
		});
		// The path-only view is the newline-per-segment attribution.
		expect(result.pathBytes).toEqual({
			"peer:src": 8,
			"spinetab:src/core/client.ts": 4,
			"peer:ws": 4,
			"peer:@apollo/src": 4,
		});
		expect(attributeChunk(file).bytes).toEqual(result.pathBytes);
		expect(
			result.composed.map((entry) => [entry.status, entry.key, entry.source]),
		).toEqual([
			["resolved", "peer:graphql", GRAPHQL_SOURCE],
			["unresolved", "peer:src", sources[3]?.source],
			["resolved", "peer:@apollo/client", APOLLO_SOURCE],
		]);
		expect(result.mapFile?.sha256).toMatch(/^[0-9a-f]{64}$/);
	});

	it("keeps an unresolved composed body offending while verified peers pass", () => {
		const dir = project();
		const file = chunk(dir, "a.js", sources);
		const scenario: SizeScenario = {
			id: "apollo",
			kind: "helper",
			subpaths: [],
			peers: [],
			spinetab: true,
		};
		const summary = summarise(
			[
				attributeFile(
					file,
					"/a.js",
					{ realm: "page", dests: { shared: ["script"], local: ["script"] } },
					{ resolver: createProvenanceResolver(dir) },
				),
			],
			{
				scenario,
				bundler: "next",
				allowedSpinetab: new Set(["src/core/client.ts"]),
				allowedPeers: new Set(["graphql", "@apollo/client", "ws"]),
			},
		);
		expect(summary.offending).toEqual(["peer:src"]);
		expect(summary.composed.resolved).toBe(2);
		expect(summary.composed.unresolved).toHaveLength(1);
		expect(summary.chunks[0]?.mapFile).toBe("a.js.map");
		// Never an allowlist: without a resolver both composed names offend.
		const plain = summarise(
			[
				attributeFile(file, "/a.js", {
					realm: "page",
					dests: { shared: ["script"], local: ["script"] },
				}),
			],
			{
				scenario,
				bundler: "next",
				allowedSpinetab: new Set(["src/core/client.ts"]),
				allowedPeers: new Set(["graphql", "@apollo/client", "ws"]),
			},
		);
		expect(plain.offending).toEqual(["peer:@apollo/src", "peer:src"]);
	});
});

describe("exact Spinetab reconstruction", () => {
	it("joins contiguous spans as emitted and separates runs with one newline", () => {
		const span = (line: number, start: number, text: string): SpinetabSpan => ({
			file: "f.js",
			line,
			start,
			text,
		});
		expect(joinSpans([span(0, 0, "ab"), span(0, 2, "cd")])).toBe("abcd");
		expect(joinSpans([span(0, 0, "ab"), span(0, 5, "cd")])).toBe("ab\ncd");
		expect(joinSpans([span(0, 0, "ab"), span(1, 0, "cd")])).toBe("ab\ncd");
		expect(joinSpans([])).toBe("");
	});

	it("reproduces a minified Spinetab line exactly instead of one newline per segment", () => {
		const dir = temp();
		const code =
			"function a(b){return b+1}function c(d){return a(d)*2}const e=c(3);";
		// One segment per token-sized piece, all from one Spinetab file.
		const columns = [0, 9, 11, 14, 21, 23, 25, 34, 36, 39, 46, 51, 54, 59];
		const file = join(dir, "out", "s.js");
		write(file, code);
		write(
			`${file}.map`,
			JSON.stringify({
				version: 3,
				sources: ["../node_modules/spinetab/dist/client.js"],
				names: [],
				mappings: encode([
					columns.map(
						(column) =>
							[column, 0, 0, column] as [number, number, number, number],
					),
				]),
			}),
		);
		const result = attributeChunk(file, { compare: true });
		expect(result.spinetabText).toBe(code);
		expect(result.legacySpinetabText?.split("\n")).toHaveLength(columns.length);
		expect(result.bytes).toEqual({ "spinetab:dist/client.js": code.length });
		expect(gzipBytes(result.spinetabText)).toBeLessThanOrEqual(
			gzipBytes(result.legacySpinetabText ?? ""),
		);
	});

	it("skips empty spans and keeps separated runs apart", () => {
		const dir = temp();
		const file = join(dir, "out", "m.js");
		// Spinetab 0–3, app 4–7, Spinetab 8–11; a zero-length Spinetab segment at 12.
		write(file, "AAAABBBBCCCC");
		write(
			`${file}.map`,
			JSON.stringify({
				version: 3,
				sources: [
					"../node_modules/spinetab/dist/a.js",
					"../src/scenarios/core/page.ts",
				],
				names: [],
				mappings: encode([
					[
						[0, 0, 0, 0],
						[4, 1, 0, 0],
						[8, 0, 0, 4],
						[12, 0, 0, 8],
					],
				]),
			}),
		);
		const result = attributeChunk(file, { compare: true });
		expect(result.spinetabText).toBe("AAAA\nCCCC");
		expect(result.spinetabSpans).toHaveLength(2);
		expect(result.legacySpinetabText).toBe("AAAA\nCCCC\n");
	});
});

describe("helper own bytes beside the comparative delta", () => {
	const base: SizeScenario = {
		id: "websocket",
		kind: "transport",
		subpaths: [".", "websocket"],
		peers: [],
		base: "core",
		spinetab: true,
		target: "page+worker",
	};
	const helper: SizeScenario = {
		id: "swr",
		kind: "helper",
		subpaths: [".", "websocket", "swr"],
		peers: [],
		base: "websocket",
		spinetab: true,
		target: "page",
	};
	const closure = (subpaths: string[]) =>
		new Set(
			subpaths.flatMap((subpath) =>
				subpath === "."
					? ["dist/index.js", "src/core/client.ts"]
					: subpath === "websocket"
						? ["dist/websocket.js", "dist/client.js"]
						: [
								"dist/swr.js",
								"src/integrations/swr/index.ts",
								"dist/client.js",
							],
			),
		);

	it("selects the files only the helper's own subpaths reach", () => {
		expect([...(helperOwnFiles(helper, base, closure) ?? [])].sort()).toEqual([
			"dist/swr.js",
			"src/integrations/swr/index.ts",
		]);
		expect(helperOwnFiles(base, undefined, closure)).toBeUndefined();
	});

	it("reports non-negative own bytes while the whole-page delta is negative", () => {
		const dir = temp();
		const map = (file: string, sources: string[], segments: number[][]) => {
			write(
				`${file}.map`,
				JSON.stringify({
					version: 3,
					sources,
					names: [],
					mappings: encode([segments as [number, number, number, number][]]),
				}),
			);
		};
		// Base page: 32 B of shared client code. Helper page: 8 B of client
		// code (different call sites shake more away) plus 4 B of swr.
		const baseFile = join(dir, "out", "base.js");
		write(baseFile, "CCCCCCCCqwertyuiopasdfghjklzxcvb");
		map(baseFile, ["../node_modules/spinetab/dist/client.js"], [[0, 0, 0, 0]]);
		const helperFile = join(dir, "out", "helper.js");
		write(helperFile, "CCCCCCCCSSSS");
		map(
			helperFile,
			[
				"../node_modules/spinetab/dist/client.js",
				"../node_modules/spinetab/dist/swr.js",
			],
			[
				[0, 0, 0, 0],
				[8, 1, 0, 0],
			],
		);
		const page = {
			realm: "page" as const,
			dests: { shared: ["script"], local: [] },
		};
		const allowed = new Set([...closure(helper.subpaths)]);
		const context = (scenario: SizeScenario) => ({
			scenario,
			bundler: "vite" as const,
			allowedSpinetab: allowed,
			allowedPeers: new Set<string>(),
		});
		const baseSummary = summarise(
			[attributeFile(baseFile, "/base.js", page)],
			context(base),
			CURRENT_VIEW,
		);
		const ownFiles = helperOwnFiles(helper, base, closure);
		const helperSummary = summarise(
			[attributeFile(helperFile, "/helper.js", page)],
			{ ...context(helper), ...(ownFiles ? { ownFiles } : {}) },
			CURRENT_VIEW,
		);
		expect(helperSummary.helperOwn).toEqual({
			realm: "page",
			files: ["dist/swr.js", "src/integrations/swr/index.ts"],
			bytes: 4,
			gzip: gzipBytes("SSSS"),
		});
		const outcome = (summary: typeof baseSummary) => ({
			minified: { realms: summary.realms },
			offending: summary.offending,
			fallbackInShared: [],
			...(summary.helperOwn ? { helperOwn: summary.helperOwn } : {}),
		});
		const outcomes = {
			websocket: outcome(baseSummary),
			swr: outcome(helperSummary),
		};
		const rows = deriveRows("vite", [base, helper], outcomes);
		const delta = rows.metrics["size.swr.incremental.gzip.vite"] as number;
		expect(delta).toBe(
			helperSummary.realms.page.spinetabGzip -
				baseSummary.realms.page.spinetabGzip,
		);
		expect(delta).toBeLessThan(0);
		const info = informationalRows("vite", [base, helper], outcomes);
		expect(info["size.swr.own.bytes.vite"]).toBe(4);
		expect(info["size.swr.own.gzip.vite"]).toBeGreaterThan(0);
		expect(info["size.swr.differential.gzip.vite"]).toBe(
			helperSummary.realms.page.gzip - baseSummary.realms.page.gzip,
		);
		// The own value never turns negative, whatever the delta does.
		expect(info["size.swr.own.gzip.vite"]).toBeGreaterThanOrEqual(0);
	});
});

describe("re-attribution comparisons", () => {
	it("diffs metrics id by id, including added and removed ids", () => {
		expect(diffMetrics({ a: 1, b: 2, c: 3 }, { a: 1, b: 0, d: 4 })).toEqual({
			unchanged: 1,
			changes: [
				{ id: "b", original: 2, value: 0, delta: -2 },
				{ id: "c", original: 3, value: null, delta: null },
				{ id: "d", original: null, value: 4, delta: null },
			],
		});
	});

	it("compares records regardless of key order but not array order", () => {
		expect(
			sameJson({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 }),
		).toBe(true);
		expect(sameJson(["a", "b"], ["b", "a"])).toBe(false);
		expect(sameJson({ a: 1 }, { a: 1, b: 0 })).toBe(false);
	});
});
