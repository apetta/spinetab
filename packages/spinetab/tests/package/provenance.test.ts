import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	cpSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { allowedAreas } from "./allowlist.ts";
import {
	consumer,
	forbiddenPackages,
	matchesPackage,
	unselectedPeers,
} from "./consumers/catalogue.ts";
import {
	EMPTY_SSG_MANIFEST,
	emptyMapForm,
	HMR_CLIENT_LOADER_ID,
	isEmptyMap,
	PINNED_WORKER_ENTRIES,
	tokenProblems,
	workerEntryProblems,
} from "./consumers/generated.ts";
import {
	failures,
	type InspectOptions,
	inspectOutput,
	NEXT_DEV_INSPECTION,
} from "./consumers/inspect.ts";
import { lockfileDependants } from "./consumers/prepare.ts";
import { childEnv, resolveInChild, run } from "./consumers/run.ts";

/**
 * Generated-file provenance, upstream-installed peers and child-process
 * resolution. Synthetic fixtures only: the Next
 * texts under fixtures/generated are copies of real Next 16.3.6 output, kept
 * as `.txt` so formatters never touch them, and materialised per test.
 */
const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const installed = join(fixtures, "inspect/installed");
const temps: string[] = [];

afterAll(() => {
	for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	temps.push(dir);
	return dir;
}

/** Copy fixtures/generated into a temp tree: `*.js.txt` → `*.js`. */
function materialise(): { out: string; next: string } {
	const root = tempDir("spinetab-generated-");
	const out = join(root, "out");
	cpSync(join(fixtures, "generated/out"), out, { recursive: true });
	const rename = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) rename(path);
			else if (entry.name.endsWith(".js.txt")) {
				renameSync(path, path.slice(0, -".txt".length));
			}
		}
	};
	rename(out);
	const next = join(root, "next");
	mkdirSync(join(next, "dist/build/polyfills"), { recursive: true });
	copyFileSync(
		join(fixtures, "generated/next/package.json"),
		join(next, "package.json"),
	);
	copyFileSync(
		join(fixtures, "generated/next/polyfill-nomodule.js.txt"),
		join(next, "dist/build/polyfills/polyfill-nomodule.js"),
	);
	return { out, next };
}

function inspectGenerated(
	tree: { out: string; next: string },
	extra: Partial<InspectOptions> = {},
) {
	return inspectOutput({
		spec: consumer("next-app"),
		bundler: "next",
		variant: "fixture",
		outDir: tree.out,
		installedDist: installed,
		installedFiles: [{ root: tree.next, dir: "dist/build/polyfills" }],
		generatedShapes: ["next-manifest", "turbopack-bootstrap"],
		...extra,
	});
}

const CHUNKS = "static/chunks";

describe("generated-file provenance", () => {
	it("classifies Next's copied polyfill, manifests and Turbopack bootstraps with provenance", () => {
		const report = inspectGenerated(materialise());
		expect(report.unmapped).toEqual([]);
		expect(failures(report)).toEqual([]);
		expect(report.verdict).toBe("pass");
		expect(
			report.generated.map(({ chunk, kind, provenance }) => [
				chunk,
				kind,
				"shape" in provenance ? provenance.shape : provenance.file,
			]),
		).toEqual([
			["static/build-1/_buildManifest.js", "next-manifest", "buildManifest"],
			[
				"static/build-1/_clientMiddlewareManifest.js",
				"next-manifest",
				"clientMiddlewareManifest",
			],
			["static/build-1/_ssgManifest.js", "next-manifest", "ssgManifest"],
			[
				`${CHUNKS}/0cz1d0mv5g_q7.js`,
				"installed-file",
				"dist/build/polyfills/polyfill-nomodule.js",
			],
			[`${CHUNKS}/loader-min.js`, "turbopack-bootstrap", "async-loader"],
			[`${CHUNKS}/loader-pretty.js`, "turbopack-bootstrap", "async-loader"],
			[
				`${CHUNKS}/turbopack-worker-min.js`,
				"turbopack-bootstrap",
				"worker-entry",
			],
			[
				`${CHUNKS}/turbopack-worker-pretty.js`,
				"turbopack-bootstrap",
				"worker-entry",
			],
		]);
		const polyfill = report.generated.find(
			(file) => file.kind === "installed-file",
		);
		expect(polyfill?.provenance).toEqual({
			source: "installed",
			package: "next",
			version: "16.3.6",
			file: "dist/build/polyfills/polyfill-nomodule.js",
		});
		expect(polyfill?.sha256).toMatch(/^[0-9a-f]{64}$/);
		// The loaded chunks are ordinary mapped chunks, still inspected.
		expect(report.chunks.map((chunk) => chunk.chunk)).toEqual([
			`${CHUNKS}/app-a.js`,
			`${CHUNKS}/app-b.js`,
		]);
	});

	it("classifies nothing unless the output names the classes (non-Next outputs)", () => {
		const report = inspectGenerated(materialise(), {
			installedFiles: [],
			generatedShapes: [],
		});
		expect(report.generated).toEqual([]);
		expect(report.verdict).toBe("fail");
		expect(report.unmapped).toEqual([
			"static/build-1/_buildManifest.js",
			"static/build-1/_clientMiddlewareManifest.js",
			"static/build-1/_ssgManifest.js",
			`${CHUNKS}/0cz1d0mv5g_q7.js`,
			`${CHUNKS}/loader-pretty.js`,
			`${CHUNKS}/turbopack-worker-pretty.js`,
		]);
		expect(
			failures(report).map((chunk) => [chunk.chunk, chunk.problems]),
		).toEqual([
			[
				`${CHUNKS}/loader-min.js`,
				["sourcemap names no sources for non-empty code"],
			],
			[
				`${CHUNKS}/turbopack-worker-min.js`,
				["sourcemap names no sources for non-empty code"],
			],
		]);
	});

	it("counts generated files under a separate sizes key, never in a realm", () => {
		const report = inspectGenerated(materialise());
		const { generated, ...realms } = report.sizes;
		expect(generated).toEqual({
			raw: report.generated.reduce((sum, file) => sum + file.bytes, 0),
			gzip: expect.any(Number),
			files: 8,
		});
		expect(generated?.gzip).toBeGreaterThan(0);
		// Realm sizes still cover exactly the inspected chunks.
		expect(Object.keys(realms)).not.toContain("generated");
		expect(
			Object.values(realms).reduce(
				(sum, size) => ({
					raw: sum.raw + size.raw,
					files: sum.files + size.files,
				}),
				{ raw: 0, files: 0 },
			),
		).toEqual({
			raw: report.chunks.reduce((sum, chunk) => sum + chunk.bytes, 0),
			files: report.chunks.length,
		});
		const none = inspectGenerated(materialise(), {
			installedFiles: [],
			generatedShapes: [],
		});
		expect(none.sizes).not.toHaveProperty("generated");
	});

	/** Mutate one materialised file; return the report. */
	const mutated = (file: string, change: (text: string) => string) => {
		const tree = materialise();
		const path = join(tree.out, file);
		writeFileSync(path, change(readFileSync(path, "utf8")));
		return inspectGenerated(tree);
	};
	/** The file is left unmapped (no map) and fails the report. */
	const expectUnmapped = (file: string, change: (text: string) => string) => {
		const report = mutated(file, change);
		expect(report.verdict, file).toBe("fail");
		expect(report.unmapped, file).toEqual([file]);
		expect(report.generated.map((entry) => entry.chunk)).not.toContain(file);
	};
	/** The file keeps its empty-map problem and fails the report. */
	const expectEmptyMapFailure = (
		file: string,
		change: (text: string) => string,
	) => {
		const report = mutated(file, change);
		expect(report.verdict, file).toBe("fail");
		expect(report.unmapped).toEqual([]);
		expect(
			failures(report).map((chunk) => [chunk.chunk, chunk.problems]),
		).toEqual([[file, ["sourcemap names no sources for non-empty code"]]]);
	};

	it.each([
		[
			"a payload that calls a function",
			(text: string) =>
				text.replace(
					/"sortedPages": \[[^\]]*\]/,
					'"sortedPages": (function () { return ["/_app", "/_error"]; })()',
				),
		],
		[
			"a payload that is not JSON",
			(text: string) => text.replace('"/_app"', "'/_app'"),
		],
		["a statement after the callback", (text: string) => `${text};self.x=1`],
		[
			"a payload naming a Spinetab file",
			(text: string) => text.replace('"/_error"', '"/_error", "polling.js"'),
		],
	])("manifest with %s is unclassified", (_name, change) => {
		expectUnmapped("static/build-1/_buildManifest.js", change);
	});

	it("leaves a manifest text outside static/<build>/ unclassified", () => {
		const tree = materialise();
		copyFileSync(
			join(tree.out, "static/build-1/_ssgManifest.js"),
			join(tree.out, `${CHUNKS}/_ssgManifest.js`),
		);
		const report = inspectGenerated(tree);
		expect(report.unmapped).toEqual([`${CHUNKS}/_ssgManifest.js`]);
	});

	/**
	 * The real `next dev` manifests (Next 16.3.6, fixtures/generated/dev),
	 * written below `out/dev/static/<dir>/`.
	 */
	const DEV_MANIFESTS = [
		"_buildManifest",
		"_clientMiddlewareManifest",
		"_ssgManifest",
	] as const;
	function withDevManifests(
		tree: { out: string; next: string },
		dir = "dev/static/development",
	) {
		mkdirSync(join(tree.out, dir), { recursive: true });
		for (const name of DEV_MANIFESTS) {
			copyFileSync(
				join(fixtures, `generated/dev/${name}.js.txt`),
				join(tree.out, dir, `${name}.js`),
			);
		}
		return tree;
	}

	it("classifies next dev's manifests below dev/static/development/ only", () => {
		const report = inspectGenerated(withDevManifests(materialise()));
		expect(report.unmapped).toEqual([]);
		expect(report.verdict).toBe("pass");
		const dev = report.generated.filter((file) =>
			file.chunk.startsWith("dev/"),
		);
		expect(
			dev.map(({ chunk, kind, provenance }) => [
				chunk,
				kind,
				"evidence" in provenance ? provenance.evidence[0] : undefined,
			]),
		).toEqual(
			DEV_MANIFESTS.map((name) => [
				`dev/static/development/${name}.js`,
				"next-manifest",
				`path dev/static/<next dev build id development>/${name}.js`,
			]),
		);
		expect(
			readFileSync(join(fixtures, "generated/dev/_ssgManifest.js.txt"), "utf8"),
		).toBe(EMPTY_SSG_MANIFEST);
	});

	it.each([
		["the production build id under dev/", "dev/static/build-1"],
		["another directory under dev/", "dev/static/other"],
		["the dev build id without the dev/ prefix", "static/development"],
		["a deeper dev path", "dev/static/development/nested"],
	])("leaves next dev manifests in %s unclassified", (_name, dir) => {
		const report = inspectGenerated(withDevManifests(materialise(), dir));
		expect(report.verdict).toBe("fail");
		expect(report.unmapped).toEqual(
			DEV_MANIFESTS.map((name) => `${dir}/${name}.js`),
		);
	});

	it.each([
		[
			"_ssgManifest",
			"a statement after the empty set",
			(text: string) => `${text};self.x=1`,
		],
		[
			"_ssgManifest",
			"a fetch in place of the callback",
			(text: string) => text.replace("self.__SSG_MANIFEST_CB()", 'fetch("/x")'),
		],
		[
			"_ssgManifest",
			"a set built by a call",
			(text: string) => text.replace("new Set;", "new Set(f());"),
		],
		[
			"_buildManifest",
			"a payload that calls a function",
			(text: string) =>
				text.replace(
					/"sortedPages": \[[^\]]*\]/,
					'"sortedPages": (function () { return ["/_app"]; })()',
				),
		],
		[
			"_clientMiddlewareManifest",
			"a statement after the callback",
			(text: string) => `${text};self.x=1`,
		],
	])("next dev %s with %s is unclassified", (name, _change, change) => {
		const tree = withDevManifests(materialise());
		const file = `dev/static/development/${name}.js`;
		const path = join(tree.out, file);
		writeFileSync(path, change(readFileSync(path, "utf8")));
		const report = inspectGenerated(tree);
		expect(report.verdict).toBe("fail");
		expect(report.unmapped).toEqual([file]);
	});

	it("leaves a polyfill copy with one byte changed unclassified", () => {
		expectUnmapped(`${CHUNKS}/0cz1d0mv5g_q7.js`, (text) =>
			text.replace("!0", "!1"),
		);
	});

	it.each([
		[
			"an added spinetab token",
			(text: string) =>
				text.replace(
					"Missing worker bootstrap config",
					"Missing spinetab bootstrap config",
				),
		],
		[
			"an extra top-level statement",
			(text: string) => text.replace("})();", "})();\nself.x = 1;"),
		],
		[
			"an extra statement assigning a global",
			(text: string) => text.replace("})();", "self.onmessage = abort;\n})();"),
		],
		[
			"an extra call",
			(text: string) => text.replace("})();", "postMessage(chunkUrls);\n})();"),
		],
		["a fetch", (text: string) => text.replace("})();", 'fetch("/x");\n})();')],
		[
			"module registration",
			(text: string) =>
				text.replace(
					"})();",
					"globalThis.TURBOPACK = globalThis.TURBOPACK || [];\n})();",
				),
		],
	])("pretty worker entry with %s is unclassified", (_name, change) => {
		expectUnmapped(`${CHUNKS}/turbopack-worker-pretty.js`, change);
	});

	it.each([
		[
			"an added spinetab token",
			(text: string) =>
				text.replace("importScripts.apply", "importScripts.apply/*spinetab*/"),
		],
		[
			"an extra statement",
			(text: string) => text.replace("}}();", "}self.x=1}();"),
		],
		[
			"a second importScripts",
			(text: string) =>
				text.replace("s.reverse(),", 's.reverse(),importScripts("/x.js"),'),
		],
		[
			"injected application code (control)",
			(text: string) =>
				text.replace(
					"!function(){",
					"!function(){function unexpectedAppCode(x){return x+7;}unexpectedAppCode(2);",
				),
		],
	])("minified worker entry with %s keeps its empty-map problem", (_name, change) => {
		expectEmptyMapFailure(`${CHUNKS}/turbopack-worker-min.js`, change);
	});

	/** next dev's worker entry name (Next 16.3.6); its body is the pinned unminified one. */
	const DEV_WORKER =
		"dev/static/chunks/turbopack-worker-[client-fs]__next_static_chunks_1_hyozq._.js";
	/** Copy the pinned unminified body to `file`, optionally changed. */
	function withDevWorker(file: string, change = (text: string) => text) {
		const tree = materialise();
		mkdirSync(join(tree.out, "dev/static/chunks"), { recursive: true });
		writeFileSync(
			join(tree.out, file),
			change(
				readFileSync(
					join(tree.out, `${CHUNKS}/turbopack-worker-pretty.js`),
					"utf8",
				),
			),
		);
		return inspectGenerated(tree);
	}

	it("classifies the pinned worker body at next dev's worker entry path", () => {
		const report = withDevWorker(DEV_WORKER);
		expect(report.unmapped).toEqual([]);
		expect(report.verdict).toBe("pass");
		const entry = report.generated.find((file) => file.chunk === DEV_WORKER);
		expect(entry?.kind).toBe("turbopack-bootstrap");
		expect(entry?.provenance).toMatchObject({
			shape: "worker-entry",
			evidence: expect.arrayContaining([
				expect.stringMatching(/^body sha256 e007a3d94c95/),
			]),
		});
	});

	it.each([
		[
			"injected application code (control)",
			DEV_WORKER,
			(text: string) =>
				text.replace(
					"})();",
					"function unexpectedAppCode(x){return x+7;}unexpectedAppCode(2);\n})();",
				),
		],
		["a trailing statement", DEV_WORKER, (text: string) => `${text}self.x=1;`],
		[
			"the production name under dev/",
			"dev/static/chunks/turbopack-worker-abc.js",
			(text: string) => text,
		],
		[
			"a dev name without the [client-fs] marker",
			"dev/static/chunks/turbopack-worker-next_static_chunks_1_hyozq._.js",
			(text: string) => text,
		],
		[
			"the dev name without the dev/ prefix",
			"static/chunks/turbopack-worker-[client-fs]__next_static_chunks_1_hyozq._.js",
			(text: string) => text,
		],
	])("leaves a next dev worker entry with %s unclassified", (_name, file, change) => {
		const report = withDevWorker(file, change);
		expect(report.verdict).toBe("fail");
		expect(report.unmapped).toEqual([file]);
	});

	it("does not classify a worker entry text outside turbopack-worker-*.js", () => {
		const tree = materialise();
		copyFileSync(
			join(tree.out, `${CHUNKS}/turbopack-worker-pretty.js`),
			join(tree.out, `${CHUNKS}/worker-copy.js`),
		);
		expect(inspectGenerated(tree).unmapped).toEqual([
			`${CHUNKS}/worker-copy.js`,
		]);
	});

	it.each([
		[
			"a chunk this output did not emit",
			(text: string) => text.replace("app-b.js", "app-c.js"),
		],
		[
			"an extra statement in the factory",
			(text: string) =>
				text.replace(
					"__turbopack_context__.v(",
					"self.x = 1;\n__turbopack_context__.v(",
				),
		],
		[
			"a second module",
			(text: string) => text.replace("}),\n]);", "}), 1, (() => {}),\n]);"),
		],
		[
			"a dynamic import",
			(text: string) =>
				text.replace("return parentImport(64639);", 'return import("/x.js");'),
		],
	])("pretty loader with %s is unclassified", (_name, change) => {
		expectUnmapped(`${CHUNKS}/loader-pretty.js`, change);
	});

	it("keeps the empty-map problem for a minified loader with a Spinetab token", () => {
		expectEmptyMapFailure(`${CHUNKS}/loader-min.js`, (text) =>
			text.replace("app-a.js", "spinetab.js"),
		);
	});

	it("classifies only through an empty map, not a map whose sources are null", () => {
		const tree = materialise();
		writeFileSync(
			join(tree.out, `${CHUNKS}/empty.js.map`),
			JSON.stringify({ version: 3, sources: [null], mappings: "AAAA" }),
		);
		const report = inspectGenerated(tree);
		expect(failures(report).map((chunk) => chunk.chunk)).toEqual([
			`${CHUNKS}/loader-min.js`,
			`${CHUNKS}/turbopack-worker-min.js`,
		]);
	});

	it("accepts only the two reviewed worker entry bodies, by exact sha256", () => {
		const tree = materialise();
		const pretty = readFileSync(
			join(tree.out, `${CHUNKS}/turbopack-worker-pretty.js`),
			"utf8",
		);
		const minified = readFileSync(
			join(tree.out, `${CHUNKS}/turbopack-worker-min.js`),
			"utf8",
		).replace(/\n?\/\/[#@] sourceMappingURL=\S+\s*$/, "");
		expect(workerEntryProblems(pretty)).toEqual([]);
		expect(workerEntryProblems(minified)).toEqual([]);
		expect(PINNED_WORKER_ENTRIES.size).toBe(2);
		// Negative control: extra application code inside the real IIFE must be rejected.
		const injected = minified.replace(
			"!function(){",
			"!function(){function unexpectedAppCode(x){return x+7;}unexpectedAppCode(2);",
		);
		expect(injected).not.toBe(minified);
		expect(workerEntryProblems(injected)).toEqual([
			expect.stringMatching(
				/^body sha256 [0-9a-f]{64} is not a reviewed Next worker bootstrap/,
			),
		]);
		// Any other change, however small, is rejected as well.
		expect(workerEntryProblems(`${pretty} `)).toHaveLength(1);
		expect(
			workerEntryProblems(pretty.replace("Refusing", "refusing")),
		).toHaveLength(1);
		expect(workerEntryProblems(`${pretty}\nfoo();`)).toHaveLength(1);
	});

	it("names Spinetab, package paths, dynamic loading and network tokens", () => {
		const names = new Set(["polling.js", "runtime.js"]);
		expect(tokenProblems('x("static/chunks/a.js")', names)).toEqual([]);
		expect(
			tokenProblems(
				'SpineTab;"[project]/a";"node_modules/x";import("y");require ("z");fetch(u);WebSocket;EventSource;"sse/runtime.js";"xpolling.js"',
				names,
			),
		).toEqual([
			"names Spinetab",
			"names a [project] path",
			"names a node_modules/ path",
			"calls import()",
			"calls require()",
			"calls fetch()",
			"names WebSocket",
			"names EventSource",
			"names Spinetab dist file runtime.js",
		]);
	});
});

/**
 * `next dev` loaders and entry chunk lists: the five real
 * Next 16.3.6 dev texts in fixtures/generated/dev-turbopack,
 * with stub chunks for every file they reference and a project root holding
 * `app/live.local.ts`.
 */
describe("next dev loaders and chunk lists", () => {
	const DEV = join(fixtures, "generated/dev-turbopack");
	const DEV_CHUNKS = "dev/static/chunks";
	const LOADER = `${DEV_CHUNKS}/app_live_local_ts_0kxz9bf._.js`;
	const HMR_LOADER = `${DEV_CHUNKS}/[turbopack]_browser_dev_hmr-client_hmr-client_ts_1c46rx4._.js`;
	const LIST_A = `${DEV_CHUNKS}/_1anvha4._.js`;
	const LIST_B = `${DEV_CHUNKS}/_219uq1s._.js`;
	const LIST_WORKER = `${DEV_CHUNKS}/app_live_worker_ts_1gdnjqz._.js`;
	const REAL = [LIST_A, LIST_B, LOADER, HMR_LOADER, LIST_WORKER];
	/** sha256 of the original generated fixtures. */
	const REAL_SHA256: Record<string, string> = {
		[LIST_A]:
			"7101b7ce17d05f73efdbe42904ef0f91a55e40d1a966a2c0627a998001a8a17f",
		[LIST_B]:
			"e0ec07837d998a0c6103fd3deada6affdb8144512160290fb1c165518153a557",
		[LOADER]:
			"eb98ca66328dc0a5c0a18a6b9b5c97d46d2eeaf9041e033e3152a0ac045a1b44",
		[HMR_LOADER]:
			"bac4b672f8d841edbf97a68fedcb5fb2da718596996fce7374e7a0f91d875f7c",
		[LIST_WORKER]:
			"c6a0fca5b181295f27d10ed5822df725a088eb88561c5eae550de8eb8d1b4584",
	};
	const SECTIONS_EMPTY_PROBLEM = "map: sections is not a non-empty array";

	interface DevTree {
		out: string;
		next: string;
		project: string;
	}

	/** The real dev texts below `out/dev/static/chunks`, plus stubs. */
	function devTree(): DevTree {
		const tree = materialise();
		const chunks = join(tree.out, DEV_CHUNKS);
		mkdirSync(chunks, { recursive: true });
		const referenced = new Set<string>();
		for (const entry of readdirSync(DEV)) {
			if (entry.startsWith("stub-chunk.")) continue;
			const target = join(
				chunks,
				entry.endsWith(".js.txt") ? entry.slice(0, -".txt".length) : entry,
			);
			copyFileSync(join(DEV, entry), target);
			if (entry.endsWith(".js.txt")) {
				for (const match of readFileSync(target, "utf8").matchAll(
					/"static\/chunks\/([^"]+)"/g,
				)) {
					referenced.add(match[1] as string);
				}
			}
		}
		// Every referenced chunk the fixtures do not hold is an ordinary mapped
		// stub, inspected as usual.
		for (const name of referenced) {
			const target = join(chunks, name);
			try {
				readFileSync(target);
			} catch {
				copyFileSync(join(DEV, "stub-chunk.js.txt"), target);
				copyFileSync(join(DEV, "stub-chunk.js.map"), `${target}.map`);
			}
		}
		const project = join(tree.out, "..", "project");
		mkdirSync(join(project, "app"), { recursive: true });
		writeFileSync(join(project, "app/live.local.ts"), "export {};\n");
		writeFileSync(join(project, "app/page.tsx"), "export {};\n");
		return { ...tree, project };
	}

	function inspectDev(tree: DevTree, extra: Partial<InspectOptions> = {}) {
		return inspectGenerated(tree, {
			dirs: [...NEXT_DEV_INSPECTION.dirs],
			serverDirs: [...NEXT_DEV_INSPECTION.serverDirs],
			generatedShapes: [...NEXT_DEV_INSPECTION.generatedShapes],
			projectRoot: tree.project,
			...extra,
		});
	}

	/** Change one dev file of a fresh tree, then inspect it. */
	function mutatedDev(
		file: string,
		change: (text: string) => string,
		prepare: (tree: DevTree) => void = () => {},
	) {
		const tree = devTree();
		prepare(tree);
		const path = join(tree.out, file);
		writeFileSync(path, change(readFileSync(path, "utf8")));
		return inspectDev(tree);
	}

	/** A rejected loader keeps its empty index map's decoder problem. */
	function expectLoaderRejected(report: ReturnType<typeof inspectDev>) {
		expect(report.verdict).toBe("fail");
		expect(report.unmapped).toEqual([]);
		expect(report.generated.map((file) => file.chunk)).not.toContain(LOADER);
		expect(
			failures(report).map((chunk) => [chunk.chunk, chunk.problems]),
		).toEqual([[LOADER, [SECTIONS_EMPTY_PROBLEM]]]);
	}

	/** A rejected chunk list stays unmapped. */
	function expectListUnmapped(
		report: ReturnType<typeof inspectDev>,
		file: string,
	) {
		expect(report.verdict).toBe("fail");
		expect(report.unmapped).toEqual([file]);
		expect(failures(report)).toEqual([]);
	}

	it("keeps the real dev texts byte-identical to the gate evidence", () => {
		const tree = devTree();
		for (const file of REAL) {
			expect(
				createHash("sha256")
					.update(readFileSync(join(tree.out, file)))
					.digest("hex"),
				file,
			).toBe(REAL_SHA256[file]);
		}
	});

	it("classifies the two dev async loaders and three chunk lists with referenced files", () => {
		const report = inspectDev(devTree());
		expect(report.unmapped).toEqual([]);
		expect(failures(report)).toEqual([]);
		expect(report.verdict).toBe("pass");
		const dev = new Map(
			report.generated.map((file) => [file.chunk, file] as const),
		);
		expect([...dev.keys()].sort()).toEqual([...REAL].sort());
		const shape = (file: string) => {
			const provenance = dev.get(file)?.provenance;
			return provenance && "shape" in provenance ? provenance : undefined;
		};
		expect(shape(LOADER)).toMatchObject({
			generator: "turbopack",
			shape: "dev-async-loader",
			references: [
				`${DEV_CHUNKS}/1o1h_spinetab_dist_0h_ryc0._.js`,
				`${DEV_CHUNKS}/app_1rq13sl._.js`,
				"project:app/live.local.ts",
			],
		});
		expect(shape(HMR_LOADER)).toMatchObject({
			shape: "dev-async-loader",
			references: [
				`${DEV_CHUNKS}/[turbopack]_browser_dev_hmr-client_hmr-client_ts_1mojsay._.js`,
			],
		});
		expect(shape(LIST_WORKER)).toMatchObject({
			shape: "chunk-list",
			references: [
				`${DEV_CHUNKS}/1o1h_spinetab_dist_1gyhc8s._.js`,
				`${DEV_CHUNKS}/app_1neo7il._.js`,
			],
		});
		expect(shape(LIST_A)?.references).toHaveLength(9);
		expect(shape(LIST_B)?.references).toContain(LOADER);
		for (const file of REAL)
			expect(dev.get(file)?.kind).toBe("turbopack-bootstrap");
		// The referenced chunks are ordinary mapped chunks, still inspected.
		expect(report.chunks.map((chunk) => chunk.chunk)).toContain(
			`${DEV_CHUNKS}/1o1h_spinetab_dist_0h_ryc0._.js`,
		);
		// The dev walk never reaches the production output of the same tree.
		expect(
			[...report.chunks, ...report.generated].filter(
				(file) => !file.chunk.startsWith("dev/"),
			),
		).toEqual([]);
	});

	describe("Pages Router page chunk lists (next dev's own _app and _error pages)", () => {
		const PAGES = `${DEV_CHUNKS}/pages`;
		const list = (route: string, chunks: readonly string[]) =>
			`__turbopack_load_page_chunks__("${route}", [\n${chunks
				.map((chunk) => `  "static/chunks/${chunk}"`)
				.join(",\n")}\n])\n`;
		const emittedTwo = [
			"1o1h_spinetab_dist_0h_ryc0._.js",
			"app_1rq13sl._.js",
		] as const;
		function withPageList(file: string, text: string) {
			const tree = devTree();
			mkdirSync(join(tree.out, PAGES), { recursive: true });
			writeFileSync(join(tree.out, `${PAGES}/${file}`), text);
			return inspectDev(tree);
		}

		it("classifies _app.js and _error.js lists whose chunks are emitted by the same output", () => {
			const tree = devTree();
			mkdirSync(join(tree.out, PAGES), { recursive: true });
			writeFileSync(
				join(tree.out, `${PAGES}/_app.js`),
				list("/_app", emittedTwo),
			);
			writeFileSync(
				join(tree.out, `${PAGES}/_error.js`),
				list("/_error", [emittedTwo[1]]),
			);
			const report = inspectDev(tree);
			expect(report.unmapped).toEqual([]);
			expect(failures(report)).toEqual([]);
			const dev = new Map(
				report.generated.map((file) => [file.chunk, file] as const),
			);
			const app = dev.get(`${PAGES}/_app.js`);
			expect(app?.kind).toBe("turbopack-bootstrap");
			expect(app?.provenance).toMatchObject({
				generator: "turbopack",
				shape: "page-chunk-list",
				references: emittedTwo.map((chunk) => `${DEV_CHUNKS}/${chunk}`),
			});
			expect(dev.get(`${PAGES}/_error.js`)?.provenance).toMatchObject({
				shape: "page-chunk-list",
			});
		});

		it("leaves a list unmapped when its route, its page name or a chunk is not verified", () => {
			// Any other page: Next emits only _app and _error for its own pages.
			expect(
				withPageList("index.js", list("/index", emittedTwo)).unmapped,
			).toEqual([`${PAGES}/index.js`]);
			// The route must name the file's own page.
			expect(
				withPageList("_app.js", list("/_error", emittedTwo)).unmapped,
			).toEqual([`${PAGES}/_app.js`]);
			// Every listed chunk must be emitted by this output.
			expect(
				withPageList(
					"_app.js",
					list("/_app", [emittedTwo[0], "missing_0000000._.js"]),
				).unmapped,
			).toEqual([`${PAGES}/_app.js`]);
			// Nothing may follow the list.
			expect(
				withPageList(
					"_error.js",
					`${list("/_error", emittedTwo)}globalThis.x = 1;\n`,
				).unmapped,
			).toEqual([`${PAGES}/_error.js`]);
		});
	});

	it("classifies nothing of the dev shapes unless the output enables them", () => {
		const report = inspectDev(devTree(), {
			generatedShapes: ["next-manifest", "turbopack-bootstrap"],
		});
		expect(report.verdict).toBe("fail");
		expect(report.unmapped).toEqual([LIST_A, LIST_B, LIST_WORKER]);
		expect(failures(report).map((chunk) => chunk.chunk)).toEqual([
			HMR_LOADER,
			LOADER,
		]);
	});

	it("resolves [project] ids only against a project root", () => {
		const tree = devTree();
		const report = inspectGenerated(tree, {
			dirs: [...NEXT_DEV_INSPECTION.dirs],
			generatedShapes: [...NEXT_DEV_INSPECTION.generatedShapes],
		});
		expectLoaderRejected(report);
	});

	it.each([
		[
			"a chunk this dev output did not emit",
			(text: string) => text.replace("app_1rq13sl._.js", "app_missing._.js"),
		],
		[
			"a [project] path that does not exist",
			(text: string) =>
				text.replaceAll("app/live.local.ts", "app/missing.local.ts"),
		],
		[
			"a [project] path below node_modules (the file exists)",
			(text: string) =>
				text.replaceAll(
					"app/live.local.ts",
					"node_modules/spinetab/dist/index.js",
				),
		],
		[
			"a [project] path leaving the project root (the file exists)",
			(text: string) => text.replaceAll("app/live.local.ts", "../outside.ts"),
		],
		[
			"a spinetab identifier outside the verified literals",
			(text: string) => text.replaceAll("parentImport", "spinetabImport"),
		],
		[
			"a [project] string outside the verified literals",
			(text: string) =>
				text.replace(
					'parentImport("[project]/app/live.local.ts [app-client] (ecmascript)")',
					'parentImport("[project]/app/live.local.ts [app-client] (ecmascript)", "[project]/x")',
				),
		],
		[
			"an extra statement",
			(text: string) =>
				text.replace(
					"__turbopack_context__.v(",
					"self.x = 1;\n__turbopack_context__.v(",
				),
		],
		[
			"a parentImport id that differs from the loader id",
			(text: string) =>
				text.replace(
					'parentImport("[project]/app/live.local.ts [app-client] (ecmascript)")',
					'parentImport("[project]/app/page.tsx [app-client] (ecmascript)")',
				),
		],
		[
			"a parentImport of the loader id itself",
			(text: string) =>
				text.replace(
					'parentImport("[project]/app/live.local.ts [app-client] (ecmascript)")',
					'parentImport("[project]/app/live.local.ts [app-client] (ecmascript, async loader)")',
				),
		],
		[
			"a numeric module id",
			(text: string) =>
				text.replace(
					'"[project]/app/live.local.ts [app-client] (ecmascript, async loader)"',
					"84550",
				),
		],
	])("rejects a dev loader with %s", (_name, change) => {
		expectLoaderRejected(
			mutatedDev(LOADER, change, (tree) => {
				mkdirSync(join(tree.project, "node_modules/spinetab/dist"), {
					recursive: true,
				});
				writeFileSync(
					join(tree.project, "node_modules/spinetab/dist/index.js"),
					"x();\n",
				);
				writeFileSync(join(tree.project, "../outside.ts"), "x();\n");
			}),
		);
	});

	it("rejects an HMR loader id other than Turbopack's fixed one", () => {
		expect(HMR_CLIENT_LOADER_ID).toBe(
			"[turbopack]/browser/dev/hmr-client/hmr-client.ts [app-client] (ecmascript, async loader)",
		);
		const report = mutatedDev(HMR_LOADER, (text) =>
			text.replaceAll("hmr-client/hmr-client.ts", "hmr-client/other.ts"),
		);
		expect(report.verdict).toBe("fail");
		expect(failures(report).map((chunk) => chunk.chunk)).toEqual([HMR_LOADER]);
	});

	it.each([
		[
			"sections: [{}]",
			{ version: 3, sources: [], sections: [{}] },
			[
				"map.sections[0]: offset needs non-negative integer line/column",
				"map.sections[0]: no embedded map",
			],
		],
		[
			"sections: [] beside mappings",
			{ version: 3, sources: [], sections: [], mappings: "" },
			[SECTIONS_EMPTY_PROBLEM],
		],
		[
			"sections: [] with non-array sources",
			{ version: 3, sources: {}, sections: [] },
			[SECTIONS_EMPTY_PROBLEM],
		],
		[
			"sections: [] with an extra key",
			{ version: 3, sources: [], sections: [], file: "x.js" },
			[SECTIONS_EMPTY_PROBLEM],
		],
	])("keeps a dev loader whose map has %s failing", (_name, map, problems) => {
		const tree = devTree();
		writeFileSync(join(tree.out, `${LOADER}.map`), JSON.stringify(map));
		const report = inspectDev(tree);
		expect(report.verdict).toBe("fail");
		expect(
			failures(report).map((chunk) => [chunk.chunk, chunk.problems]),
		).toEqual([[LOADER, expect.arrayContaining(problems)]]);
	});

	it("rejects a dev loader without its map and a chunk list with one", () => {
		const loader = devTree();
		rmSync(join(loader.out, `${LOADER}.map`));
		expect(inspectDev(loader).unmapped).toEqual([LOADER]);
		const list = devTree();
		copyFileSync(
			join(list.out, `${LOADER}.map`),
			join(list.out, `${LIST_WORKER}.map`),
		);
		const report = inspectDev(list);
		expect(report.verdict).toBe("fail");
		expect(failures(report).map((chunk) => chunk.chunk)).toEqual([LIST_WORKER]);
		// A regular empty map does not admit a chunk list either.
		const regular = devTree();
		writeFileSync(
			join(regular.out, `${LIST_WORKER}.map`),
			JSON.stringify({ version: 3, sources: [], mappings: "" }),
		);
		const withRegular = inspectDev(regular);
		expect(withRegular.verdict).toBe("fail");
		expect(
			failures(withRegular).map((chunk) => [chunk.chunk, chunk.problems]),
		).toEqual([
			[LIST_WORKER, ["sourcemap names no sources for non-empty code"]],
		]);
	});

	it("does not classify the dev texts outside dev/static/chunks", () => {
		const tree = devTree();
		mkdirSync(join(tree.out, "dev/static/other"), { recursive: true });
		copyFileSync(
			join(tree.out, LIST_WORKER),
			join(tree.out, "dev/static/other/list.js"),
		);
		expect(inspectDev(tree).unmapped).toEqual(["dev/static/other/list.js"]);
	});

	it.each([
		[
			"a chunk this dev output did not emit",
			(text: string) => text.replace("app_1neo7il._.js", "app_missing._.js"),
		],
		["an extra statement", (text: string) => `${text}\nself.x = 1;`],
		[
			'source: "other"',
			(text: string) => text.replace('source: "entry"', 'source: "other"'),
		],
		[
			"a spinetab token outside the verified literals",
			(text: string) => text.replace("source:", "spinetab: 1,\n    source:"),
		],
		[
			"a fetch in place of the current script",
			(text: string) =>
				text.replace(
					'typeof document === "object" ? document.currentScript : undefined',
					'fetch("/x")',
				),
		],
		[
			"more than 4 KiB",
			(text: string) =>
				text.replace("chunks: [", `chunks: [${" ".repeat(4096)}`),
		],
	])("leaves a dev chunk list with %s unmapped", (_name, change) => {
		expectListUnmapped(mutatedDev(LIST_WORKER, change), LIST_WORKER);
	});

	it("reads both empty map forms and nothing else as empty", () => {
		expect(emptyMapForm({ version: 3, sources: [], mappings: "" })).toBe(
			"empty",
		);
		expect(emptyMapForm({ version: 3, sources: [], sections: [] })).toBe(
			"empty-sections",
		);
		for (const map of [
			{ version: 3, sources: [], sections: [{}] },
			{ version: 3, sources: [], sections: [], mappings: "" },
			{ version: 3, sections: [] },
			{ version: 3, sources: [null], sections: [] },
			{ version: 3, sources: "", sections: [] },
			{ version: 2, sources: [], sections: [] },
			{ version: 3, sources: [null], mappings: "" },
			{ version: 3, sources: [], mappings: "AAAA" },
			[],
			null,
		]) {
			expect(isEmptyMap(map), JSON.stringify(map)).toBe(false);
		}
	});
});

describe("upstream-installed peers", () => {
	const lock = [
		"lockfileVersion: '9.0'",
		"packages:",
		"  '@ai-sdk/react@4.0.119':",
		"    resolution: {integrity: sha512-a}",
		"  swr@2.5.1:",
		"    resolution: {integrity: sha512-b}",
		"snapshots:",
		"  '@ai-sdk/react@4.0.119(react@19.3.0)(zod@4.6.5)':",
		"    dependencies:",
		"      ai: 7.0.116(zod@4.6.5)",
		"      swr: 2.5.1(react@19.3.0)",
		"    transitivePeerDependencies:",
		"      - swr",
		"  spinetab@file:../pack/spinetab-0.0.0.tgz(swr@2.5.1(react@19.3.0)):",
		"    optionalDependencies:",
		"      swr: 2.5.1(react@19.3.0)",
		"  swr@2.5.1(react@19.3.0):",
		"    dependencies:",
		"      react: 19.3.0",
		"  vue@3.5.43: {}",
	].join("\n");

	it("finds the installed packages that depend on a peer, Spinetab's binding included", () => {
		expect(lockfileDependants(lock, "swr")).toEqual([
			{
				name: "@ai-sdk/react",
				version: "4.0.119",
				field: "dependencies",
				dependencyVersion: "2.5.1",
			},
			{
				name: "spinetab",
				version: "file:../pack/spinetab-0.0.0.tgz",
				field: "optionalDependencies",
				dependencyVersion: "2.5.1",
			},
		]);
		expect(lockfileDependants(lock, "vue")).toEqual([]);
	});

	it("permits upstream swr but still forbids Spinetab's swr integration in every realm", () => {
		for (const name of ["react-ai-sdk", "next-ai"]) {
			const spec = consumer(name);
			expect(spec.upstreamInstalled).toEqual(["swr"]);
			expect(unselectedPeers(spec)).not.toContain("swr");
			expect(matchesPackage("swr", forbiddenPackages(spec))).toBe(false);
			expect(spec.entries).not.toContain("./swr");
			for (const entry of spec.entries) {
				expect(allowedAreas(entry).has("integrations/swr"), entry).toBe(false);
			}
		}
		const out = tempDir("spinetab-swr-");
		const chunk = (name: string, sources: string[]) => {
			writeFileSync(
				join(out, `${name}.js`),
				`x();\n//# sourceMappingURL=${name}.js.map\n`,
			);
			writeFileSync(
				join(out, `${name}.js.map`),
				JSON.stringify({ version: 3, sources, mappings: "AAAA" }),
			);
		};
		chunk("upstream", [
			"../node_modules/.pnpm/swr@2.5.1/node_modules/swr/dist/index.mjs",
		]);
		chunk("leak", [
			"../node_modules/.pnpm/swr@2.5.1/node_modules/swr/dist/index.mjs",
			"../node_modules/spinetab/src/integrations/swr/index.ts",
		]);
		for (const realm of ["page", "worker", "fallback", "shared"] as const) {
			const report = inspectOutput({
				spec: consumer("react-ai-sdk"),
				bundler: "fixture",
				variant: realm,
				outDir: out,
				installedDist: installed,
				defaultRealm: realm,
			});
			expect(report.verdict).toBe("fail");
			expect(
				report.chunks.map((row) => [
					row.chunk,
					row.realm,
					row.peers,
					row.unexpected,
				]),
			).toEqual([
				[
					"leak.js",
					realm,
					["swr"],
					{ spinetab: ["integrations/swr"], peers: [] },
				],
				["upstream.js", realm, ["swr"], { spinetab: [], peers: [] }],
			]);
		}
	});
});

describe("child processes never see NODE_PATH", () => {
	it("run() and childEnv() drop an inherited or explicit NODE_PATH", async () => {
		vi.stubEnv("NODE_PATH", "/inherited/node_modules");
		try {
			expect(childEnv()).not.toHaveProperty("NODE_PATH");
			expect(childEnv({ NODE_PATH: "/explicit" })).not.toHaveProperty(
				"NODE_PATH",
			);
			expect(childEnv({ KEEP: "1" }).KEEP).toBe("1");
			const result = await run(
				process.execPath,
				["-e", "process.stdout.write(String(process.env.NODE_PATH))"],
				{
					cwd: tempDir("spinetab-run-"),
					env: { NODE_PATH: "/explicit/node_modules" },
					timeoutMs: 30_000,
				},
			);
			expect(result.code).toBe(0);
			expect(result.output).toBe("undefined");
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("resolves as a plain Node child: MODULE_NOT_FOUND although NODE_PATH holds the package", () => {
		const root = tempDir("spinetab-resolve-");
		const store = join(root, "store/node_modules");
		const peer = (dir: string, name: string) => {
			mkdirSync(join(dir, name), { recursive: true });
			writeFileSync(
				join(dir, name, "package.json"),
				JSON.stringify({ name, version: "1.0.0", main: "index.js" }),
			);
			writeFileSync(join(dir, name, "index.js"), "module.exports = 1;\n");
		};
		peer(store, "store-only-peer");
		const consumerRoot = join(root, "consumer");
		peer(join(consumerRoot, "node_modules"), "installed-peer");
		writeFileSync(
			join(consumerRoot, "package.json"),
			JSON.stringify({ name: "consumer", private: true }),
		);
		// Control: with NODE_PATH, Node itself does find the store package.
		const withNodePath = execFileSync(
			process.execPath,
			[
				"-e",
				'process.stdout.write(require("node:module").createRequire(process.argv[1]).resolve("store-only-peer"))',
				join(consumerRoot, "package.json"),
			],
			{ env: { ...process.env, NODE_PATH: store }, encoding: "utf8" },
		);
		expect(withNodePath).toBe(join(store, "store-only-peer/index.js"));
		vi.stubEnv("NODE_PATH", store);
		try {
			expect(
				resolveInChild(consumerRoot, ["store-only-peer", "installed-peer"]),
			).toEqual([
				{ name: "store-only-peer", resolved: null, code: "MODULE_NOT_FOUND" },
				{
					name: "installed-peer",
					resolved: join(consumerRoot, "node_modules/installed-peer/index.js"),
					code: null,
				},
			]);
		} finally {
			vi.unstubAllEnvs();
		}
	});
});
