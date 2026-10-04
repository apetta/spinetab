/**
 * Size scenarios. Each scenario uses
 * its features live (subscribe, render to the DOM, command) so nothing is
 * optimised away. Templates live in `size/scenarios/<id>/`.
 *
 * - `subpaths`: Spinetab package exports the scenario imports (page and worker).
 * - `peers`: npm packages whose bytes may appear (declared peers and the
 * framework used by the scenario); their transitive dependencies are allowed.
 * - `base`: scenario subtracted for the incremental Spinetab cost.
 */

export type ScenarioKind =
	| "baseline"
	| "core"
	| "transport"
	| "helper"
	| "plugin";

export interface SizeScenario {
	id: string;
	kind: ScenarioKind;
	subpaths: string[];
	peers: string[];
	base?: string;
	/** Scenario has a Spinetab worker and lazy local module. */
	spinetab: boolean;
	/** Incremental target realm set. */
	target?: "page+worker" | "page";
}

const CORE = [".", "runtime", "worker"];

const transport = (
	id: string,
	subpath: string,
	peers: string[] = [],
	runtime = `${subpath}/runtime`,
): SizeScenario => ({
	id,
	kind: "transport",
	subpaths: [...CORE, subpath, runtime],
	peers,
	base: "core",
	spinetab: true,
	target: "page+worker",
});

const helper = (
	id: string,
	subpaths: string[],
	peers: string[],
	base: string,
): SizeScenario => ({
	id,
	kind: "helper",
	subpaths: [...CORE, ...subpaths],
	peers,
	base,
	spinetab: true,
	target: "page",
});

export const SCENARIOS: SizeScenario[] = [
	{
		id: "baseline-empty",
		kind: "baseline",
		subpaths: [],
		peers: [],
		spinetab: false,
	},
	{
		id: "baseline-graphql-ws",
		kind: "baseline",
		subpaths: [],
		peers: ["graphql-ws"],
		spinetab: false,
	},
	{
		id: "baseline-ws",
		kind: "baseline",
		subpaths: [],
		peers: [],
		spinetab: false,
	},
	{
		id: "core",
		kind: "core",
		subpaths: CORE,
		peers: [],
		base: "baseline-empty",
		spinetab: true,
	},
	transport("websocket", "websocket"),
	transport("sse", "sse"),
	transport("stream", "stream"),
	transport("polling", "polling"),
	transport("graphql-ws", "graphql-ws", ["graphql-ws", "graphql"]),
	transport("graphql-sse", "graphql-sse", ["graphql-sse", "graphql"]),
	transport("socket-io", "socket-io", ["socket.io-client"]),
	transport("trpc", "trpc", ["@trpc/client", "@trpc/server"]),
	transport("ai-sdk", "ai-sdk", ["ai"]),
	helper(
		"apollo",
		["apollo", "graphql-ws", "graphql-ws/runtime"],
		["@apollo/client", "rxjs", "graphql", "graphql-ws"],
		"graphql-ws",
	),
	helper(
		"tanstack-query",
		["tanstack-query", "websocket", "websocket/runtime"],
		["@tanstack/query-core"],
		"websocket",
	),
	helper(
		"swr",
		["swr", "websocket", "websocket/runtime"],
		["swr", "react", "react-dom"],
		"websocket",
	),
	helper(
		"react",
		["react", "websocket", "websocket/runtime"],
		["react", "react-dom"],
		"websocket",
	),
	helper(
		"vue",
		["vue", "websocket", "websocket/runtime"],
		["vue"],
		"websocket",
	),
	helper(
		"svelte",
		["svelte", "websocket", "websocket/runtime"],
		["svelte"],
		"websocket",
	),
	helper(
		"solid",
		["solid", "websocket", "websocket/runtime"],
		["solid-js"],
		"websocket",
	),
];

/**
 * Generated-path size scenarios: the Spinetab bundler
 * plugin at L2 (the application's `spinetab.worker.ts`) or L3 (the generated
 * worker, inferred or from the `adapters` option). Each builds from its own
 * project root (project.ts `pluginRoot`), so the plugin's whole-root scan
 * reads only that scenario's sources. Their rows are
 * `size.<id>.l3.*`, informational only; the L1 catalogue above, its rows and
 * their targets are unchanged. Vite and Next (Turbopack) only.
 *
 * - `counterpart`: the L1 scenario the realm deltas subtract (same run).
 * - `subpaths`: the exports the page and the worker import (the generated
 * worker imports `worker` and the adapter's runtime); the allowed closure
 * follows `PLUGIN_ALIASES`.
 * - `expectedAdapters`: L3 only, the set the generated worker must hold.
 * - `inferenceBase`: the explicit-set twin for the inference-cost row.
 */
export interface PluginScenario extends SizeScenario {
	kind: "plugin";
	level: "L2" | "L3";
	counterpart: string;
	/** Template directory under `size/scenarios/` (default: the id). */
	template?: string;
	/** Plugin options; absent means the adapters are inferred. */
	options?: { adapters: readonly string[] };
	expectedAdapters?: readonly string[];
	inferenceBase?: string;
}

const pluginScenario = (
	scenario: Omit<PluginScenario, "kind" | "spinetab">,
): PluginScenario => ({ kind: "plugin", spinetab: true, ...scenario });

const POLLING_L3 = [".", "polling", "polling/runtime", "worker"];

export const PLUGIN_SCENARIOS: PluginScenario[] = [
	pluginScenario({
		id: "core-l2",
		level: "L2",
		counterpart: "core",
		subpaths: CORE,
		peers: [],
	}),
	pluginScenario({
		id: "polling-l3",
		level: "L3",
		counterpart: "polling",
		subpaths: POLLING_L3,
		peers: [],
		expectedAdapters: ["polling"],
		inferenceBase: "polling-l3-explicit",
	}),
	pluginScenario({
		id: "polling-l3-explicit",
		level: "L3",
		counterpart: "polling",
		template: "polling-l3",
		options: { adapters: ["polling"] },
		subpaths: POLLING_L3,
		peers: [],
		expectedAdapters: ["polling"],
	}),
	// Inference control: socket.io import text in a comment and a string only.
	pluginScenario({
		id: "polling-l3-control",
		level: "L3",
		counterpart: "polling",
		subpaths: POLLING_L3,
		peers: [],
		expectedAdapters: ["polling"],
	}),
	pluginScenario({
		id: "graphql-ws-l3",
		level: "L3",
		counterpart: "graphql-ws",
		subpaths: [".", "graphql-ws", "graphql-ws/runtime", "worker"],
		peers: ["graphql-ws", "graphql"],
		expectedAdapters: ["graphql-ws"],
	}),
];

export const isPluginScenario = (
	scenario: SizeScenario,
): scenario is PluginScenario => scenario.kind === "plugin";

/**
 * The plugin's redirects as the allowed closure follows them: the page's
 * `spinetab/wiring` becomes `auto/wiring`, and
 * `spinetab/worker-config` is the generated module or the application's
 * worker file, never a package file, so its stub is never allowed.
 */
export const PLUGIN_ALIASES: Readonly<Record<string, string | null>> = {
	wiring: "auto/wiring",
	"worker-config": null,
};

/** Plugin bundlers the size harness does not build, with the reason. */
export const PLUGIN_BUNDLERS_NOT_MEASURED: Readonly<Record<string, string>> = {
	webpack:
		"not measured: the size harness builds Vite and Next (Turbopack) only",
	rspack:
		"not measured: the size harness builds Vite and Next (Turbopack) only",
	astro:
		"not measured: Astro runs the Vite plugin; the harness has no Astro project",
};

/**
 * Pinned consumer toolchain: the package's dev dependencies and the Next
 * consumer templates' pins (tests/fixtures/consumers/next-*; checked by
 * tests/unit/performance/size-project.test.ts). Every type package Next
 * would otherwise install during `next build` is listed here.
 */
export const TOOLCHAIN = {
	vite: "8.3.1",
	next: "16.3.6",
	typescript: "6.0.3",
	"@types/node": "24.13.2",
	"@types/react": "19.3.0",
	"@types/react-dom": "19.3.0",
} as const;

/** Next's own framework packages: reported as framework, never as a Spinetab dependency. */
export const NEXT_FRAMEWORK = new Set([
	"next",
	"react",
	"react-dom",
	"scheduler",
	"@swc/helpers",
	"styled-jsx",
	"client-only",
]);

/**
 * Scenarios for `--only a,b` in catalogue order; all when omitted. Unknown
 * ids fail instead of silently shrinking the run. Select a scenario's `base`
 * with it (e.g. `baseline-empty,core,websocket`) or its incremental row is
 * reported as not measured.
 */
export function selectScenarios(only?: string): SizeScenario[] {
	if (only === undefined) return [...SCENARIOS];
	const ids = only
		.split(",")
		.map((id) => id.trim())
		.filter(Boolean);
	const known = new Set(SCENARIOS.map((scenario) => scenario.id));
	const unknown = ids.filter((id) => !known.has(id));
	if (ids.length === 0 || unknown.length > 0) {
		throw new Error(
			`--only: unknown or empty scenario ids [${unknown.join(", ")}]; choose from ${[...known].join(", ")}`,
		);
	}
	const selected = new Set(ids);
	return SCENARIOS.filter((scenario) => selected.has(scenario.id));
}

/**
 * A run's selection over both catalogues: `--only` may mix L1 and plugin
 * ids; every scenario of both when omitted. Unknown ids fail.
 */
export function selectRun(only?: string): {
	scenarios: SizeScenario[];
	plugin: PluginScenario[];
} {
	if (only === undefined) {
		return { scenarios: [...SCENARIOS], plugin: [...PLUGIN_SCENARIOS] };
	}
	const ids = only
		.split(",")
		.map((id) => id.trim())
		.filter(Boolean);
	const known = new Set(
		[...SCENARIOS, ...PLUGIN_SCENARIOS].map((scenario) => scenario.id),
	);
	const unknown = ids.filter((id) => !known.has(id));
	if (ids.length === 0 || unknown.length > 0) {
		throw new Error(
			`--only: unknown or empty scenario ids [${unknown.join(", ")}]; choose from ${[...known].join(", ")}`,
		);
	}
	const selected = new Set(ids);
	return {
		scenarios: SCENARIOS.filter((scenario) => selected.has(scenario.id)),
		plugin: PLUGIN_SCENARIOS.filter((scenario) => selected.has(scenario.id)),
	};
}

/** Selected scenarios whose `base` is not selected: `id → base`. */
export function unselectedBases(
	selection: SizeScenario[],
): Record<string, string> {
	const ids = new Set(selection.map((scenario) => scenario.id));
	return Object.fromEntries(
		selection
			.filter((scenario) => scenario.base && !ids.has(scenario.base))
			.map((scenario) => [scenario.id, scenario.base as string]),
	);
}
