import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encode } from "@jridgewell/sourcemap-codec";
import { afterEach, describe, expect, it } from "vitest";
import { generateWorker } from "../../../src/build/generate.ts";
import { type BudgetRow, evaluateRow } from "../../performance/lib/stats.ts";
import {
	attributeChunk,
	GENERATED_KEY,
	gzipBytes,
	spinetabClosure,
	spinetabGzip,
} from "../../performance/size/attribute.ts";
import {
	PLUGIN_ALIASES,
	PLUGIN_BUNDLERS_NOT_MEASURED,
	PLUGIN_SCENARIOS,
	type PluginScenario,
	SCENARIOS,
	type SizeScenario,
	selectRun,
} from "../../performance/size/catalogue.ts";
import {
	compareSizes,
	formatComparison,
	type SizesReport,
} from "../../performance/size/compare.ts";
import {
	BUNDLERS,
	derivePluginRows,
	deriveRows,
	fallbackDownloads,
	isNotSelected,
	isPluginRow,
	type MeasuredScenario,
	pluginBudgetRows,
	pluginRowIds,
	type ScenarioOutcome,
	splitPluginRows,
	unselectedBundlerRows,
	unselectedPluginBundlerRows,
} from "../../performance/size/guard.ts";
import type { Realm } from "../../performance/size/realm.ts";
import type { LoggedRequest } from "../../performance/size/static-server.ts";
import {
	type AttributedChunk,
	attributeFile,
	generatedAdapters,
	pluginComparison,
	type RealmTotals,
	summarise,
} from "../../performance/size/summary.ts";

// Attribute the generated worker separately; plugin size rows are informational.

const pkg = fileURLToPath(new URL("../../../", import.meta.url));
const budgets = JSON.parse(
	readFileSync(
		new URL("../../performance/budgets.json", import.meta.url),
		"utf8",
	),
) as { rows: BudgetRow[] };

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
const temp = () => {
	const dir = mkdtempSync(join(tmpdir(), "spinetab-size-generated-"));
	dirs.push(dir);
	return dir;
};

const plugin = (id: string): PluginScenario => {
	const scenario = PLUGIN_SCENARIOS.find((candidate) => candidate.id === id);
	if (!scenario) throw new Error(`no plugin scenario ${id}`);
	return scenario;
};
const l1 = (id: string): SizeScenario => {
	const scenario = SCENARIOS.find((candidate) => candidate.id === id);
	if (!scenario) throw new Error(`no scenario ${id}`);
	return scenario;
};

const STORE = "node_modules/.pnpm/spinetab@file+..+spinetab.tgz/node_modules";
/** Source paths as Vite (relative) and Turbopack (`turbopack:///[project]/…`) list them. */
const vite = (file: string) => `../../${STORE}/spinetab/${file}`;
const turbopack = (file: string) =>
	`turbopack:///[project]/${STORE}/spinetab/${file}`;
const app = (file: string) => `../../l3/polling-l3/src/${file}`;

const POLLING = generateWorker(["polling"]);
const STUB = readFileSync(join(pkg, "dist/worker-config.js"), "utf8");

interface Part {
	text: string;
	source: string;
	content?: string | null;
}

/** One-line chunk whose map assigns each part to its source. */
function chunkFile(dir: string, name: string, parts: Part[]): string {
	const sources: string[] = [];
	const contents: Array<string | null> = [];
	const segments: Array<[number, number, number, number]> = [];
	let column = 0;
	for (const part of parts) {
		let index = sources.indexOf(part.source);
		if (index === -1) {
			index = sources.push(part.source) - 1;
			contents.push(part.content ?? null);
		}
		segments.push([column, index, 0, 0]);
		column += part.text.length;
	}
	const file = join(dir, name);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, parts.map((part) => part.text).join(""));
	writeFileSync(
		`${file}.map`,
		JSON.stringify({
			version: 3,
			sources,
			sourcesContent: contents,
			mappings: encode([segments]),
		}),
	);
	return file;
}

const WORKER_PARTS: Part[] = [
	{ text: "if(typeof w)", source: vite("dist/auto/worker.js"), content: "" },
	{
		text: "G(pollingAdapter())",
		source: vite("dist/worker-config.js"),
		content: POLLING,
	},
	{
		text: "function defineWorker(){}",
		source: vite("dist/worker.js"),
		content: "",
	},
	{
		text: "function pollingAdapter(){}",
		source: vite("dist/polling/runtime.js"),
		content: "",
	},
];

describe("generated worker attribution", () => {
	it("keys a worker-config source whose content is the generated worker as generated (Vite)", () => {
		const file = chunkFile(temp(), "worker.js", WORKER_PARTS);
		const result = attributeChunk(file);
		expect(GENERATED_KEY).toBe("generated");
		expect(result.bytes).toEqual({
			"spinetab:dist/auto/worker.js": 12,
			generated: 19,
			"spinetab:dist/worker.js": 25,
			"spinetab:dist/polling/runtime.js": 27,
		});
		expect(result.generatedText).toBe("G(pollingAdapter())");
		expect(result.generatedSources).toEqual([POLLING]);
		// The generated code is not Spinetab text.
		expect(result.spinetabText).toBe(
			"if(typeof w)\nfunction defineWorker(){}function pollingAdapter(){}",
		);
	});

	it("keys the Turbopack forms (dist path or composed src path) as generated too", () => {
		for (const source of [
			turbopack("dist/worker-config.js"),
			turbopack("src/worker-config.ts"),
		]) {
			const file = chunkFile(temp(), "chunk.js", [
				{ text: "G()", source, content: POLLING },
			]);
			expect(attributeChunk(file).bytes, source).toEqual({ generated: 3 });
		}
	});

	it("keeps the stub, or content it cannot see, under the stub's own key (fail closed)", () => {
		for (const content of [STUB, null, `${POLLING.slice(1)}`]) {
			const file = chunkFile(temp(), "chunk.js", [
				{ text: "S()", source: vite("dist/worker-config.js"), content },
			]);
			const result = attributeChunk(file);
			expect(result.bytes).toEqual({ "spinetab:dist/worker-config.js": 3 });
			expect(result.generatedText).toBeUndefined();
			expect(result.generatedSources).toBeUndefined();
		}
	});

	it("attributes chunks without a worker-config source exactly as before", () => {
		const file = chunkFile(temp(), "page.js", [
			{ text: "createClient()", source: vite("dist/index.js"), content: "" },
			{ text: "start()", source: app("page.ts"), content: "" },
		]);
		const result = attributeChunk(file);
		expect(result.bytes).toEqual({ "spinetab:dist/index.js": 14, app: 7 });
		expect(result.generatedText).toBeUndefined();
		expect(result.generatedSources).toBeUndefined();
	});

	it("reads the adapter kinds a generated worker holds", () => {
		expect(generatedAdapters([POLLING])).toEqual(["polling"]);
		expect(
			generatedAdapters([generateWorker(["socket-io", "polling"]), POLLING]),
		).toEqual(["polling", "socket-io"]);
		expect(
			generatedAdapters([generateWorker(["trpc-ws", "trpc-sse"])]),
		).toEqual(["trpc-sse", "trpc-ws"]);
		expect(
			generatedAdapters([
				"// Generated by spinetab. Do not edit.\nexport default defineWorker(() => [mystery()]);\n",
			]),
		).toEqual(["unknown:mystery"]);
		expect(generatedAdapters([])).toEqual([]);
	});
});

const PAGE_PARTS: Part[] = [
	{ text: "createClient()", source: vite("dist/index.js"), content: "" },
	{
		text: "new SharedWorker(u)",
		source: vite("dist/auto/wiring.js"),
		content: "",
	},
	{ text: "start()", source: app("page.ts"), content: "" },
];

function attributed(
	parts: Record<string, { realm: Realm; parts: Part[] }>,
): AttributedChunk[] {
	const dir = temp();
	return Object.entries(parts).map(([path, chunk]) =>
		attributeFile(chunkFile(dir, path.slice(1), chunk.parts), path, {
			realm: chunk.realm,
			dests: { shared: [], local: [] },
		}),
	);
}

function summary(
	scenario: PluginScenario | SizeScenario,
	worker: Part[] = WORKER_PARTS,
	page: Part[] = PAGE_PARTS,
) {
	const chunks = attributed({
		"/page.js": { realm: "page", parts: page },
		"/worker.js": { realm: "worker", parts: worker },
		"/lazy.js": { realm: "lazy", parts: worker },
	});
	return summarise(chunks, {
		scenario,
		bundler: "vite",
		allowedSpinetab: spinetabClosure(pkg, scenario.subpaths, PLUGIN_ALIASES),
		allowedPeers: new Set(),
	});
}

describe("plugin summary: generated totals, adapters and offending sources", () => {
	it("an L3 scenario with its expected generated worker has nothing offending", () => {
		const result = summary(plugin("polling-l3"));
		expect(result.offending).toEqual([]);
		expect(result.generated).toEqual({
			adapters: ["polling"],
			modules: 1,
			realms: {
				page: { bytes: 0, gzip: 0 },
				worker: { bytes: 19, gzip: gzipBytes("G(pollingAdapter())") },
				lazy: { bytes: 19, gzip: gzipBytes("G(pollingAdapter())") },
			},
		});
		// Spinetab gzip excludes the generated code; it is never bundler bytes.
		expect(result.realms.worker.spinetabGzip).toBe(
			spinetabGzip([
				"if(typeof w)\nfunction defineWorker(){}function pollingAdapter(){}",
			]),
		);
		expect(result.realms.worker.bundlerBytes).toBe(0);
		expect(result.realms.worker.spinetabBytes).toBe(12 + 25 + 27);
		expect(result.realms.page.appBytes).toBe(7);
		expect(result.localChunks).toEqual(["/worker.js", "/lazy.js"]);
	});

	it("the inference control fails when the generated set holds an adapter the page never imports", () => {
		const noisy = WORKER_PARTS.map((part) =>
			part.content === POLLING
				? { ...part, content: generateWorker(["polling", "socket-io"]) }
				: part,
		);
		const result = summary(plugin("polling-l3-control"), noisy);
		expect(result.offending).toEqual(["generated:adapters=polling,socket-io"]);
		expect(result.generated?.adapters).toEqual(["polling", "socket-io"]);
	});

	it("an L3 build without a generated worker, or holding the stub, is offending", () => {
		const withoutGenerated = WORKER_PARTS.filter(
			(part) => part.content !== POLLING,
		);
		expect(summary(plugin("polling-l3"), withoutGenerated).offending).toEqual([
			"generated:missing",
		]);
		const stub = WORKER_PARTS.map((part) =>
			part.content === POLLING ? { ...part, content: STUB } : part,
		);
		expect(summary(plugin("polling-l3"), stub).offending).toEqual([
			"generated:missing",
			"spinetab:dist/worker-config.js",
		]);
	});

	it("L2 takes the application's worker file: no generated module, and none allowed", () => {
		const own = [
			{
				text: "if(typeof w)",
				source: vite("dist/auto/worker.js"),
				content: "",
			},
			{
				text: "defineWorker(()=>adapters())",
				source: "../../l3/core-l2/src/spinetab.worker.ts",
				content: "",
			},
			{
				text: "function defineWorker(){}",
				source: vite("dist/worker.js"),
				content: "",
			},
		];
		const clean = summary(plugin("core-l2"), own);
		expect(clean.offending).toEqual([]);
		expect(clean.generated?.modules).toBe(0);
		expect(clean.realms.worker.appBytes).toBe(28);
		expect(summary(plugin("core-l2")).offending).toContain(
			"generated:unexpected-at-L2",
		);
	});

	it("generated code in the page realm is offending", () => {
		const page = [
			...PAGE_PARTS,
			{ text: "G()", source: vite("dist/worker-config.js"), content: POLLING },
		];
		expect(summary(plugin("polling-l3"), WORKER_PARTS, page).offending).toEqual(
			["page-realm:generated"],
		);
	});

	it("L1 scenarios keep their rules: no generated summary, local chunks by their own local module", () => {
		const own = summary(l1("polling"));
		expect(own.generated).toBeUndefined();
		expect(own.localChunks).toEqual([]);
	});
});

const request = (
	path: string,
	dest: string,
	referrer?: string,
): LoggedRequest => ({
	path,
	dest,
	status: 200,
	bytes: 1,
	...(referrer ? { referrer } : {}),
});

describe("fallback downloads in shared mode", () => {
	it("under the plugin a chunk counts only when the page itself fetched it", () => {
		const local = ["/worker.js", "/lazy.js", "/imported.js"];
		const shared = [
			request("/page.js", "script"),
			request("/worker.js", "sharedworker"),
			request("/imported.js", "script", "/worker.js"),
		];
		expect(fallbackDownloads(local, shared, true)).toEqual([]);
		expect(
			fallbackDownloads(
				local,
				[...shared, request("/lazy.js", "script")],
				true,
			),
		).toEqual(["/lazy.js"]);
	});

	it("L1 keeps its rule: any chunk of the local module fetched in shared mode", () => {
		const shared = [
			request("/local.js", "script"),
			request("/w.js", "sharedworker"),
		];
		expect(fallbackDownloads(["/local.js", "/w.js"], shared, false)).toEqual([
			"/local.js",
			"/w.js",
		]);
		expect(
			fallbackDownloads(
				["/local.js"],
				[{ ...request("/local.js", "script"), status: 404 }],
				false,
			),
		).toEqual([]);
	});
});

type Triple = [number, number, number];
const realms = (gzip: Triple, spinetab: Triple) => ({
	page: { gzip: gzip[0], spinetabGzip: spinetab[0] },
	worker: { gzip: gzip[1], spinetabGzip: spinetab[1] },
	lazy: { gzip: gzip[2], spinetabGzip: spinetab[2] },
});
const measured = (
	gzip: Triple,
	spinetab: Triple,
	extra: Partial<MeasuredScenario> & { generated?: unknown } = {},
): MeasuredScenario => ({
	minified: { realms: realms(gzip, spinetab) },
	offending: [],
	fallbackInShared: [],
	...extra,
});
const generatedOf = (worker: number) => ({
	adapters: ["polling"],
	modules: 1,
	realms: {
		page: { bytes: 0, gzip: 0 },
		worker: { bytes: worker * 2, gzip: worker },
		lazy: { bytes: worker * 2, gzip: worker },
	},
});

function outcomes(): Record<string, ScenarioOutcome> {
	const all: Record<string, ScenarioOutcome> = {};
	for (const scenario of SCENARIOS) {
		all[scenario.id] = measured([3_000, 4_000, 5_000], [2_000, 3_000, 4_000]);
	}
	all["core-l2"] = measured([3_100, 4_150, 5_200], [2_050, 3_100, 4_100]);
	all["polling-l3"] = measured([3_120, 4_300, 5_300], [2_060, 3_200, 4_200], {
		generated: generatedOf(110),
	});
	all["polling-l3-explicit"] = measured(
		[3_120, 4_300, 5_300],
		[2_060, 3_200, 4_200],
		{ generated: generatedOf(110) },
	);
	all["polling-l3-control"] = measured(
		[3_130, 4_300, 5_300],
		[2_060, 3_200, 4_200],
		{ generated: generatedOf(110), offending: ["x"], fallbackInShared: [] },
	);
	all["graphql-ws-l3"] = measured(
		[3_140, 4_320, 5_310],
		[2_070, 3_210, 4_210],
		{
			generated: generatedOf(115),
			fallbackInShared: ["/lazy.js"],
		},
	);
	return all;
}

describe("plugin rows: size.<id>.l3.*", () => {
	it("names the rows per level; only an L3 scenario has a generated row, only polling-l3 an inference row", () => {
		expect(pluginRowIds(plugin("core-l2"), "vite")).toEqual([
			"size.core-l2.l3.page.gzip.vite",
			"size.core-l2.l3.worker.gzip.vite",
			"size.core-l2.l3.page.delta.gzip.vite",
			"size.core-l2.l3.worker.delta.gzip.vite",
			"size.core-l2.l3.lazy.delta.gzip.vite",
			"size.core-l2.l3.absent.vite",
			"size.core-l2.l3.fallback-downloads-in-shared.vite",
		]);
		expect(pluginRowIds(plugin("polling-l3"), "next")).toEqual([
			"size.polling-l3.l3.page.gzip.next",
			"size.polling-l3.l3.worker.gzip.next",
			"size.polling-l3.l3.generated.gzip.next",
			"size.polling-l3.l3.page.delta.gzip.next",
			"size.polling-l3.l3.worker.delta.gzip.next",
			"size.polling-l3.l3.lazy.delta.gzip.next",
			"size.polling-l3.l3.inference.gzip.next",
			"size.polling-l3.l3.absent.next",
			"size.polling-l3.l3.fallback-downloads-in-shared.next",
		]);
		expect(pluginRowIds(plugin("graphql-ws-l3"), "vite")).toHaveLength(8);
		for (const scenario of PLUGIN_SCENARIOS) {
			for (const id of pluginRowIds(scenario, "vite")) {
				expect(isPluginRow(id), id).toBe(true);
			}
		}
		for (const row of budgets.rows) {
			if (row.id.startsWith("size.") && !row.id.includes(".l3.")) {
				expect(isPluginRow(row.id), row.id).toBe(false);
			}
		}
	});

	it("derives every row of a complete run with nothing not measured", () => {
		const rows = derivePluginRows(
			"vite",
			PLUGIN_SCENARIOS,
			outcomes(),
			SCENARIOS,
		);
		expect(rows.notMeasured).toEqual({});
		expect(Object.keys(rows.metrics).sort()).toEqual(
			PLUGIN_SCENARIOS.flatMap((scenario) =>
				pluginRowIds(scenario, "vite"),
			).sort(),
		);
		expect(rows.metrics).toMatchObject({
			// Spinetab-only gzip, the L1 row definition (generated excluded).
			"size.polling-l3.l3.page.gzip.vite": 2_060,
			"size.polling-l3.l3.worker.gzip.vite": 3_200,
			"size.polling-l3.l3.generated.gzip.vite": 110,
			// L3 − L1 whole-realm emitted gzip: the honest number.
			"size.polling-l3.l3.page.delta.gzip.vite": 120,
			"size.polling-l3.l3.worker.delta.gzip.vite": 300,
			"size.polling-l3.l3.lazy.delta.gzip.vite": 300,
			// Inferred minus explicit, every realm: expected 0.
			"size.polling-l3.l3.inference.gzip.vite": 0,
			"size.polling-l3.l3.absent.vite": 0,
			"size.polling-l3-control.l3.absent.vite": 1,
			"size.graphql-ws-l3.l3.fallback-downloads-in-shared.vite": 1,
			"size.core-l2.l3.worker.delta.gzip.vite": 150,
		});
	});

	it("never changes an L1 row", () => {
		const all = outcomes();
		const l1Only = Object.fromEntries(
			SCENARIOS.map((scenario) => [scenario.id, all[scenario.id]]),
		);
		for (const bundler of BUNDLERS) {
			expect(deriveRows(bundler, SCENARIOS, all)).toEqual(
				deriveRows(bundler, SCENARIOS, l1Only),
			);
		}
	});

	it("records unselected scenarios, counterparts and inference bases as not selected", () => {
		const { scenarios, plugin: chosen } = selectRun("polling-l3,core-l2,core");
		const rows = derivePluginRows("next", chosen, outcomes(), scenarios);
		// Unselected plugin scenarios: every row; like the L1 rows, a delta row
		// names each blocking scenario (here the unselected counterpart too).
		for (const id of pluginRowIds(plugin("graphql-ws-l3"), "next")) {
			expect(rows.notMeasured[id], id).toBe(
				id.includes(".delta.")
					? "graphql-ws-l3 not measured: not selected (--only); graphql-ws not measured: not selected (--only)"
					: "graphql-ws-l3 not measured: not selected (--only)",
			);
		}
		// polling-l3's counterpart and inference base are not selected.
		expect(rows.metrics["size.polling-l3.l3.page.gzip.next"]).toBe(2_060);
		expect(rows.notMeasured["size.polling-l3.l3.page.delta.gzip.next"]).toBe(
			"polling not measured: not selected (--only)",
		);
		expect(rows.notMeasured["size.polling-l3.l3.inference.gzip.next"]).toBe(
			"polling-l3-explicit not measured: not selected (--only)",
		);
		// core-l2 has its counterpart.
		expect(rows.metrics["size.core-l2.l3.page.delta.gzip.next"]).toBe(100);
		for (const reason of Object.values(rows.notMeasured)) {
			expect(isNotSelected(reason), reason).toBe(true);
		}
	});

	it("a failed plugin scenario or counterpart yields no value, citing the reason", () => {
		const all = outcomes();
		all["graphql-ws-l3"] = { error: "build or load failed: boom" };
		all["graphql-ws"] = { error: "load mode check failed: x" };
		const rows = derivePluginRows("vite", PLUGIN_SCENARIOS, all, SCENARIOS);
		expect(rows.notMeasured["size.graphql-ws-l3.l3.absent.vite"]).toBe(
			"graphql-ws-l3 not measured: build or load failed: boom",
		);
		expect(rows.notMeasured["size.graphql-ws-l3.l3.page.delta.gzip.vite"]).toBe(
			"graphql-ws-l3 not measured: build or load failed: boom; graphql-ws not measured: load mode check failed: x",
		);
		all["graphql-ws-l3"] = outcomes()["graphql-ws-l3"];
		const counterpartOnly = derivePluginRows(
			"vite",
			PLUGIN_SCENARIOS,
			all,
			SCENARIOS,
		);
		expect(
			counterpartOnly.metrics["size.graphql-ws-l3.l3.page.gzip.vite"],
		).toBe(2_070);
		expect(
			counterpartOnly.notMeasured["size.graphql-ws-l3.l3.lazy.delta.gzip.vite"],
		).toBe("graphql-ws not measured: load mode check failed: x");
		expect(
			isNotSelected(
				counterpartOnly.notMeasured[
					"size.graphql-ws-l3.l3.lazy.delta.gzip.vite"
				] as string,
			),
		).toBe(false);
	});

	it("records an unselected bundler's plugin rows and refuses a selection outside the catalogue", () => {
		const rows = unselectedPluginBundlerRows(["vite"]);
		const next = PLUGIN_SCENARIOS.flatMap((scenario) =>
			pluginRowIds(scenario, "next"),
		);
		expect(Object.keys(rows).sort()).toEqual([...next].sort());
		for (const id of next) {
			expect(rows[id]).toBe("bundler next not selected (--bundlers)");
		}
		expect(unselectedPluginBundlerRows([...BUNDLERS])).toEqual({});
		expect(() =>
			derivePluginRows("vite", PLUGIN_SCENARIOS, outcomes(), SCENARIOS, [
				plugin("core-l2"),
			]),
		).toThrow(/not in the plugin catalogue: polling-l3/);
	});

	it("splits a report's rows into L1 and plugin rows", () => {
		expect(
			splitPluginRows({
				"size.core.absent.vite": 0,
				"size.core-l2.l3.absent.vite": 1,
				"size.polling.incremental.gzip.next": 3,
			}),
		).toEqual({
			l1: {
				"size.core.absent.vite": 0,
				"size.polling.incremental.gzip.next": 3,
			},
			plugin: { "size.core-l2.l3.absent.vite": 1 },
		});
	});
});

describe("informational plugin size budgets", () => {
	const requested = pluginBudgetRows();

	it("one informational row per plugin row id and bundler, vite first", () => {
		expect(requested.map((row) => row.id)).toEqual(
			BUNDLERS.flatMap((bundler) =>
				PLUGIN_SCENARIOS.flatMap((scenario) => pluginRowIds(scenario, bundler)),
			),
		);
		expect(requested).toHaveLength(80);
		for (const row of requested) {
			expect(row, row.id).toMatchObject({
				owner: "performance",
				comparator: "report",
				target: null,
				targetState: "provisional",
				kind: "size",
				gate: "all",
			});
			expect(row.reason, row.id).toMatch(/^informational:/);
			expect(["bundle-size", "dependency-isolation"], row.id).toContain(
				row.behaviour,
			);
			expect(evaluateRow(row, [123]).status, row.id).toBe("informational");
		}
	});

	it("budgets.json contains every plugin size definition", () => {
		const present = budgets.rows.filter((row) => isPluginRow(row.id));
		expect(present).toEqual(requested);
		// L1 size rows and their targets are untouched by.
		for (const row of budgets.rows) {
			if (!row.id.startsWith("size.") || isPluginRow(row.id)) continue;
			expect(row.comparator, row.id).not.toBe("report");
		}
	});

	it("with the rows applied, every size budget row is accounted for whatever the selection", () => {
		const ids = [
			...budgets.rows
				.filter((row) => row.id.startsWith("size.") && !isPluginRow(row.id))
				.map((row) => row.id),
			...requested.map((row) => row.id),
		];
		for (const only of [
			undefined,
			"polling-l3",
			"core,polling",
			"baseline-empty",
		]) {
			const selection = selectRun(only);
			for (const bundlers of [[...BUNDLERS], ["next" as const]]) {
				const accounted = new Set<string>();
				for (const bundler of bundlers) {
					const l1Rows = deriveRows(bundler, selection.scenarios, outcomes());
					const pluginRows = derivePluginRows(
						bundler,
						selection.plugin,
						outcomes(),
						selection.scenarios,
					);
					for (const record of [l1Rows, pluginRows]) {
						for (const id of [
							...Object.keys(record.metrics),
							...Object.keys(record.notMeasured),
						]) {
							accounted.add(id);
						}
					}
				}
				for (const id of [
					...Object.keys(unselectedBundlerRows(bundlers)),
					...Object.keys(unselectedPluginBundlerRows(bundlers)),
				]) {
					accounted.add(id);
				}
				const missing = ids.filter((id) => !accounted.has(id));
				expect(missing, `${only} ${bundlers}`).toEqual([]);
			}
		}
	});
});

const totals = (
	gzip: number,
	extra: Partial<RealmTotals> = {},
): RealmTotals => ({
	bytes: gzip * 3,
	gzip,
	brotli: gzip - 10,
	spinetabBytes: gzip * 2,
	spinetabGzip: gzip - 100,
	peerBytes: 0,
	appBytes: 50,
	bundlerBytes: 20,
	...extra,
});

describe("L3 against L1, side by side", () => {
	const own = {
		minified: {
			realms: {
				page: totals(1_100),
				worker: totals(1_400),
				lazy: totals(1_500),
			},
		},
		generated: generatedOf(110),
	};
	const counterpart = {
		minified: {
			realms: {
				page: totals(1_000, { appBytes: 180 }),
				worker: totals(1_300),
				lazy: totals(1_450),
			},
		},
		offending: [],
		fallbackInShared: [],
	};

	it("reports every category per realm with the L3 − L1 delta", () => {
		const side = pluginComparison(plugin("polling-l3"), own, counterpart);
		expect(side.counterpart).toBe("polling");
		expect(side.level).toBe("L3");
		expect(side.adapters).toEqual(["polling"]);
		expect(side.realms.page.l3).toEqual({
			...totals(1_100),
			generatedBytes: 0,
			generatedGzip: 0,
		});
		expect(side.realms.worker.l3.generatedGzip).toBe(110);
		expect(side.realms.page.l1).toEqual({
			...totals(1_000, { appBytes: 180 }),
			generatedBytes: 0,
			generatedGzip: 0,
		});
		expect(side.realms.page.delta).toMatchObject({
			gzip: 100,
			appBytes: -130,
			spinetabGzip: 100,
			generatedGzip: 0,
		});
		expect(side.realms.worker.delta).toMatchObject({
			gzip: 100,
			generatedBytes: 220,
			generatedGzip: 110,
		});
		const alone = pluginComparison(plugin("polling-l3"), own, {
			error: "not measured",
		});
		expect(alone.realms.lazy.l1).toBeNull();
		expect(alone.realms.lazy.delta).toBeNull();
	});

	it("the compare lists plugin rows (informational once budgeted) and the side-by-side table", () => {
		const report: SizesReport = {
			run: "new",
			metrics: {
				"size.polling-l3.l3.page.gzip.vite": 1_000,
				"size.polling-l3.l3.absent.vite": 1,
			},
			notMeasured: {
				"size.core-l2.l3.absent.next":
					"core-l2 not measured: not selected (--only)",
			},
			pluginBundlersNotMeasured: PLUGIN_BUNDLERS_NOT_MEASURED,
			scenarios: {
				"polling-l3": {
					vite: {
						minified: { realms: { page: { gzip: 1_100 } } },
						sideBySide: pluginComparison(
							plugin("polling-l3"),
							own,
							counterpart,
						),
					},
				},
			},
		};
		const l1Rows = budgets.rows.filter(
			(row) => row.id.startsWith("size.") && !isPluginRow(row.id),
		);
		const plain = compareSizes(report, l1Rows);
		const row = (comparison: typeof plain, id: string) =>
			comparison.rows.find((entry) => entry.id === id);
		expect(row(plain, "size.polling-l3.l3.absent.vite")?.status).toBe(
			"no budget row",
		);
		const budgeted = compareSizes(report, [...l1Rows, ...pluginBudgetRows()]);
		expect(row(budgeted, "size.polling-l3.l3.absent.vite")?.status).toBe(
			"informational",
		);
		expect(budgeted.failing.filter(isPluginRow)).toEqual([]);
		expect(budgeted.notSelected).toContain("size.core-l2.l3.absent.next");
		expect(budgeted.plugin).toContainEqual({
			scenario: "polling-l3",
			bundler: "vite",
			realm: "worker",
			l1Gzip: 1_300,
			l3Gzip: 1_400,
			delta: 100,
			l1Spinetab: 1_200,
			l3Spinetab: 1_300,
			generatedGzip: 110,
		});
		const text = formatComparison(budgeted);
		expect(text).toContain("## Generated path (plugin) against L1 per realm");
		expect(text).toMatch(
			/polling-l3\s+vite\s+worker\s+1300\s+1400\s+\+100\s+1200\s+1300\s+110/,
		);
		expect(text).toContain("## Plugin bundlers not measured (3):");
		expect(text).toMatch(/- webpack: .*not measured/);
	});
});
