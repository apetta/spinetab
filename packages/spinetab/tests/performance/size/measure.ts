import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	cpSync,
	createWriteStream,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";
import { evidenceDir, packageRoot, runId, writeJson } from "../lib/evidence.ts";
import { dependencyClosure, spinetabClosure } from "./attribute.ts";
import {
	isPluginScenario,
	PLUGIN_ALIASES,
	PLUGIN_BUNDLERS_NOT_MEASURED,
	PLUGIN_SCENARIOS,
	type PluginScenario,
	SCENARIOS,
	type SizeScenario,
	selectRun,
	TOOLCHAIN,
} from "./catalogue.ts";
import {
	derivePluginRows,
	deriveRows,
	type ExpectedModes,
	fallbackDownloads,
	gateLoads,
	isMeasured,
	isNotSelected,
	type LoadObservation,
	type Observed,
	READY_TIMEOUT_MS,
	type ScenarioFailure,
	type ScenarioOutcome,
	SETTLE_MS,
	unselectedBundlerRows,
	unselectedPluginBundlerRows,
} from "./guard.ts";
import {
	type Bundler,
	checkNextExport,
	type Mode,
	nextScenarioPaths,
	PLUGIN_NEXT_LAYOUT,
	pluginRoot,
	prepareNextBuild,
	settleNextBuild,
	toolchainFingerprint,
	toolchainMutations,
	writePluginProject,
	writeProject,
} from "./project.ts";
import {
	createProvenanceResolver,
	type ProvenanceResolver,
} from "./provenance.ts";
import { destinations, realmOf } from "./realm.ts";
import { type LoggedRequest, serveStatic } from "./static-server.ts";
import {
	type AttributedChunk,
	attributeFile,
	type Chunk,
	type GeneratedSummary,
	HELPER_DELTA_LIMITATION,
	type HelperOwn,
	helperOwnFiles,
	informationalRows,
	listJs,
	type OutputSummary,
	PLUGIN_LIMITATION,
	type PluginComparison,
	pluginComparison,
	type RealmTotals,
	SPINETAB_GZIP_NOTE,
	summarise,
} from "./summary.ts";

/**
 * Bundle sizes from packed consumer builds. Consumes the tarball produced by the packaging pipeline and never
 * the moving `dist/`:
 *
 * node tests/performance/size/measure.ts --run <RUN> [--tarball <tgz>]
 * [--work <dir>] [--only baseline-empty,core,websocket] [--bundlers vite,next]
 *
 * Steps: copy the scenario templates into an out-of-tree work root; install
 * the tarball with pinned peers (`pnpm install --ignore-workspace`); build
 * each scenario with Vite (minified and `minify: false`) and Next (App Router,
 * default bundler, static export; minified and `turbopackMinify: false`).
 * Next exports each build to its own `outputs/<scenario>-<mode>` (a custom
 * `distDir` is the export destination) and keeps its `.next` build state
 * under `build-state/<scenario>-<mode>` (project.ts). No build may install
 * packages or rewrite package.json, the lockfile or tsconfig. Load each
 * output in Chromium with `sharing=prefer` and `sharing=off` behind a logging
 * static server to classify chunks by realm (realm.ts: destination plus a
 * worker `Referer` for `importScripts`); attribute bytes with sourcemaps
 * (composed peer sources need installed input-map provenance, provenance.ts);
 * write docs/evidence/perf/<run>/sizes.json. `reattribute.ts` re-processes a
 * preserved run's outputs with the same summary (summary.ts), without builds.
 *
 * Every load of both builds must report its scenario's expected
 * `__sizeReady` mode (guard.ts) before any size is computed; a timeout or a
 * wrong mode keeps its diagnostics and marks the scenario, the rows based on
 * it and the fallback row not measured, and the CLI exits 1.
 *
 * Every size row is accounted for: the rows of scenarios left out by
 * `--only` and of bundlers left out by `--bundlers` are recorded in
 * `notMeasured` as "not selected", so a partial run also exits 1, and the
 * report records its `selection` and the `catalogue` it was derived from
 * (reattribute.ts reproduces a report by the rule it was written under).
 *
 * Generated-path scenarios build with the Spinetab plugin from their own roots
 * (`<bundler>/l3/<id>`, project.ts), attribute the generated worker as its
 * own category, allow the Spinetab sources the plugin's aliases reach, and
 * add informational `size.<id>.l3.*` rows plus an L3-against-L1
 * `sideBySide` per realm; L1 rows are derived exactly as before. They run by
 * default and with `--only` (L1 and plugin ids mix). webpack, Rspack and
 * Astro are recorded in `pluginBundlersNotMeasured`.
 *
 * `--control block-worker` is a negative control: the static server refuses
 * `sharedworker`/`worker` requests, so Spinetab scenarios cannot reach shared
 * mode and the SharedWorker baseline never becomes ready. The run records
 * `size.control` as not measured and always exits 1.
 */

interface ScenarioResult {
	bundler: Bundler;
	minified: {
		chunks: Chunk[];
		realms: Record<"page" | "worker" | "lazy", RealmTotals>;
	};
	rawBytes: Record<"page" | "worker" | "lazy", number>;
	requests: { shared: LoggedRequest[]; local: LoggedRequest[] };
	/** Minified build's first `__sizeReady` per load (all loads: `modeCheck`). */
	modes: { shared: string | null; local: string | null };
	modeCheck: { expected: ExpectedModes; observed: Observed };
	spinetabFiles: Record<string, number>;
	peers: Record<string, number>;
	offending: string[];
	/** Composed peer sources: resolved count and every unresolved one (provenance.ts). */
	composed: OutputSummary["composed"];
	/** Helpers only: the helper's own attributable page code (summary.ts). */
	helperOwn?: HelperOwn;
	/** Plugin scenarios only: the generated worker (summary.ts). */
	generated?: GeneratedSummary;
	/** Plugin scenarios only: each realm against the L1 counterpart. */
	sideBySide?: PluginComparison;
	fallbackInShared: string[];
	unexpectedRequests: string[];
}

const { values: args } = parseArgs({
	options: {
		run: { type: "string" },
		tarball: { type: "string" },
		work: { type: "string" },
		only: { type: "string" },
		bundlers: { type: "string", default: "vite,next" },
		"skip-install": { type: "boolean", default: false },
		control: { type: "string" },
	},
});

const CONTROLS = new Set(["block-worker"]);
if (args.control !== undefined && !CONTROLS.has(args.control)) {
	throw new Error(
		`--control: unknown negative control ${args.control}; choose from ${[...CONTROLS].join(", ")}`,
	);
}
const blockWorker = args.control === "block-worker";

const run = args.run ?? runId();
const bundlers = (args.bundlers ?? "vite,next").split(",") as Bundler[];
const { scenarios, plugin: pluginScenarios } = selectRun(args.only);
const templates = join(packageRoot, "tests/performance/size/scenarios");

function tarballPath(): string {
	const consumers =
		process.env.SPINETAB_CONSUMERS_DIR ?? join(tmpdir(), "spinetab-consumers");
	const path = resolve(
		args.tarball ??
			process.env.SPINETAB_PERF_TARBALL ??
			join(consumers, "pack", "spinetab-0.1.0.tgz"),
	);
	if (!existsSync(path)) {
		throw new Error(
			`No packed Spinetab tarball at ${path}. Build and pack first (pnpm --filter spinetab build, then pnpm --filter spinetab consumers:prepare), or pass --tarball <path>. Sizes are never measured from the moving dist/.`,
		);
	}
	return path;
}

function workRoot(): string {
	const root = resolve(
		args.work ??
			process.env.SPINETAB_SIZE_DIR ??
			join(tmpdir(), `spinetab-size-${run}`),
	);
	// A consumer must never resolve packages from an ancestor project.
	let current = dirname(root);
	for (;;) {
		for (const marker of [
			"node_modules",
			"package.json",
			"pnpm-workspace.yaml",
		]) {
			if (existsSync(join(current, marker))) {
				throw new Error(
					`Work root ${root} has an ancestor project marker ${join(current, marker)}; choose an out-of-tree --work directory.`,
				);
			}
		}
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return root;
}

/** Child environment without the workspace's npm/pnpm settings. */
function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (/^(npm_config_|npm_package_|npm_lifecycle_|pnpm_)/i.test(key)) continue;
		env[key] = value;
	}
	return { ...env, ...extra };
}

function exec(
	command: string,
	argv: string[],
	cwd: string,
	logFile: string,
	extra: Record<string, string> = {},
): Promise<void> {
	mkdirSync(dirname(logFile), { recursive: true });
	const log = createWriteStream(logFile, { flags: "a" });
	log.write(`$ ${command} ${argv.join(" ")} (cwd ${cwd})\n`);
	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, argv, { cwd, env: childEnv(extra) });
		child.stdout.pipe(log, { end: false });
		child.stderr.pipe(log, { end: false });
		child.once("error", reject);
		child.once("close", (code) => {
			log.end();
			if (code === 0) resolvePromise();
			else {
				const tail = existsSync(logFile)
					? readFileSync(logFile, "utf8").slice(-4_000)
					: "";
				reject(
					new Error(`${command} ${argv.join(" ")} exited ${code}\n${tail}`),
				);
			}
		});
	});
}

function versions(): Record<string, string> {
	const manifest = JSON.parse(
		readFileSync(join(packageRoot, "package.json"), "utf8"),
	) as {
		devDependencies: Record<string, string>;
	};
	const peers = [
		"graphql-ws",
		"graphql",
		"graphql-sse",
		"socket.io-client",
		"@trpc/client",
		"@trpc/server",
		"ai",
		"@apollo/client",
		"rxjs",
		"@tanstack/query-core",
		"swr",
		"react",
		"react-dom",
		"vue",
		"svelte",
		"solid-js",
	];
	return Object.fromEntries(
		peers.map((name) => {
			const version = manifest.devDependencies[name];
			if (!version)
				throw new Error(`No pinned version for ${name} in package.json`);
			return [name, version];
		}),
	);
}

function nextPage(dir: string, scenario: SizeScenario): void {
	writeFileSync(
		join(dir, "app/page.tsx"),
		`"use client";\nimport { useEffect, useRef } from "react";\nimport { start } from "../src/scenarios/${scenario.id}/page";\n\nexport default function Page() {\n\tconst root = useRef<HTMLDivElement>(null);\n\tuseEffect(() => {\n\t\tif (root.current) start(root.current);\n\t}, []);\n\treturn <div id="app" ref={root} />;\n}\n`,
	);
}

/**
 * A plugin scenario's build from its own root. Vite: the root's
 * config (its `root`) run from the bundler project. Next: `next build` with
 * the root as the invocation directory, the project directory the plugin
 * plans from; `pnpm exec` would run in the nearest package directory
 * instead, so the installed binary is called directly.
 */
async function buildPlugin(
	dir: string,
	bundler: Bundler,
	scenario: PluginScenario,
	mode: Mode,
	log: string,
	raw: string,
): Promise<{ output: string; entry: string }> {
	const root = pluginRoot(dir, scenario.id);
	if (bundler === "vite") {
		await exec(
			"pnpm",
			["exec", "vite", "build", "--config", join(root, "vite.config.mjs")],
			dir,
			log,
			{ SIZE_RAW: raw },
		);
		return {
			output: join(dir, "dist", `${scenario.id}-${mode}`),
			entry: "/index.html",
		};
	}
	const paths = nextScenarioPaths(root, scenario.id, mode, PLUGIN_NEXT_LAYOUT);
	const stale = prepareNextBuild(root, paths);
	if (stale) {
		mkdirSync(dirname(log), { recursive: true });
		appendFileSync(log, `[size] moved an unowned .next aside to ${stale}\n`);
	}
	try {
		await exec(
			join(dir, "node_modules", ".bin", "next"),
			["build"],
			root,
			log,
			{
				SIZE_RAW: raw,
				SIZE_NEXT_EXPORT_DIR: paths.distDir,
				NEXT_TELEMETRY_DISABLED: "1",
			},
		);
		const problem = checkNextExport(paths.buildDir, paths.exportDir);
		if (problem) throw new Error(`Next export check failed: ${problem}`);
	} finally {
		settleNextBuild(paths);
	}
	return { output: paths.exportDir, entry: "/" };
}

async function build(
	dir: string,
	bundler: Bundler,
	scenario: SizeScenario,
	mode: Mode,
): Promise<{ output: string; entry: string }> {
	const log = join(dir, "logs", `${scenario.id}-${mode}.log`);
	const raw = mode === "raw" ? "1" : "0";
	if (isPluginScenario(scenario)) {
		return buildPlugin(dir, bundler, scenario, mode, log, raw);
	}
	if (bundler === "vite") {
		await exec(
			"pnpm",
			["exec", "vite", "build", "--config", "vite.config.mjs"],
			dir,
			log,
			{
				SIZE_SCENARIO: scenario.id,
				SIZE_RAW: raw,
			},
		);
		return {
			output: join(dir, "dist", `${scenario.id}-${mode}`),
			entry: `/html/${scenario.id}.html`,
		};
	}
	nextPage(dir, scenario);
	const paths = nextScenarioPaths(dir, scenario.id, mode);
	const stale = prepareNextBuild(dir, paths);
	if (stale) {
		mkdirSync(dirname(log), { recursive: true });
		appendFileSync(log, `[size] moved an unowned .next aside to ${stale}\n`);
	}
	try {
		await exec("pnpm", ["exec", "next", "build"], dir, log, {
			SIZE_RAW: raw,
			SIZE_NEXT_EXPORT_DIR: paths.distDir,
			NEXT_TELEMETRY_DISABLED: "1",
		});
		const problem = checkNextExport(paths.buildDir, paths.exportDir);
		if (problem) throw new Error(`Next export check failed: ${problem}`);
	} finally {
		settleNextBuild(paths);
	}
	return { output: paths.exportDir, entry: "/" };
}

/** A build changed the seeded toolchain: every later build in that project is void. */
class ToolchainMutation extends Error {}

/** Fails a build that installed packages or rewrote the seeded toolchain. */
async function guardedBuild(
	dir: string,
	bundler: Bundler,
	scenario: SizeScenario,
	mode: Mode,
): Promise<{ output: string; entry: string }> {
	const log = join(dir, "logs", `${scenario.id}-${mode}.log`);
	const offset = existsSync(log) ? statSync(log).size : 0;
	// A plugin build also must not change its own root's tsconfig (Next).
	const watched = isPluginScenario(scenario)
		? [dir, pluginRoot(dir, scenario.id)]
		: [dir];
	const fingerprint = () =>
		Object.fromEntries(
			watched.flatMap((path) =>
				Object.entries(toolchainFingerprint(path)).map(([file, hash]) => [
					relative(dir, join(path, file)),
					hash,
				]),
			),
		);
	const before = fingerprint();
	let result: { output: string; entry: string } | undefined;
	let failure: unknown;
	try {
		result = await build(dir, bundler, scenario, mode);
	} catch (error) {
		failure = error;
	}
	const after = fingerprint();
	const changed = Object.keys(before).filter(
		(file) => before[file] !== after[file],
	);
	const lines = existsSync(log)
		? toolchainMutations(readFileSync(log).subarray(offset).toString("utf8"))
		: [];
	if (changed.length > 0 || lines.length > 0) {
		throw new ToolchainMutation(
			`${bundler} ${scenario.id}-${mode} changed the pinned toolchain (files: ${changed.join(", ") || "none"}; log: ${lines.join(" | ") || "none"})${failure ? `; build error: ${(failure as Error).message}` : ""}`,
		);
	}
	if (failure || !result) throw failure;
	return result;
}

const CONSOLE_LINES = 50;

/** Current `__sizeReady` as a string, or null when unset. */
const readyValue = () => {
	const value = (globalThis as { __sizeReady?: unknown }).__sizeReady;
	return value === undefined || value === null || value === ""
		? null
		: String(value);
};

async function load(
	browser: Awaited<ReturnType<typeof chromium.launch>>,
	output: string,
	entry: string,
): Promise<{ shared: LoadObservation; local: LoadObservation }> {
	const server = await serveStatic(output, 0, {
		refuse: blockWorker
			? ({ dest }) => dest === "sharedworker" || dest === "worker"
			: undefined,
	});
	const visit = async (sharing: "prefer" | "off"): Promise<LoadObservation> => {
		server.reset();
		const context = await browser.newContext();
		const lines: string[] = [];
		const note = (line: string) => {
			if (lines.length < CONSOLE_LINES) lines.push(line.slice(0, 500));
		};
		try {
			const page = await context.newPage();
			page.on("console", (message) =>
				note(`${message.type()}: ${message.text()}`),
			);
			page.on("pageerror", (error) => note(`pageerror: ${error.message}`));
			await page.goto(`${server.origin}${entry}?sharing=${sharing}`);
			let readyError: string | undefined;
			const ready = await page
				.waitForFunction(readyValue, null, { timeout: READY_TIMEOUT_MS })
				.then((handle) => handle.jsonValue() as Promise<string>)
				.catch((error: Error) => {
					readyError = error.message.split("\n")[0]?.slice(0, 300);
					return null;
				});
			await page.waitForTimeout(SETTLE_MS);
			const settled = await page.evaluate(readyValue);
			return {
				ready,
				settled,
				...(readyError === undefined ? {} : { readyError }),
				requests: [...server.log],
				console: lines,
			};
		} finally {
			await context.close();
		}
	};
	try {
		const shared = await visit("prefer");
		const local = await visit("off");
		return { shared, local };
	} finally {
		await server.close();
	}
}

const buildLogs = (dir: string, scenario: SizeScenario) =>
	(["min", "raw"] as const).map((mode) =>
		join(dir, "logs", `${scenario.id}-${mode}.log`),
	);

async function measureScenario(
	browser: Awaited<ReturnType<typeof chromium.launch>>,
	dir: string,
	bundler: Bundler,
	scenario: SizeScenario,
	allowedSpinetab: Set<string>,
	allowedPeers: Set<string>,
	resolver: ProvenanceResolver,
	ownFiles: Set<string> | undefined,
): Promise<ScenarioResult | ScenarioFailure> {
	const minBuild = await guardedBuild(dir, bundler, scenario, "min");
	const rawBuild = await guardedBuild(dir, bundler, scenario, "raw");
	const minLoad = await load(browser, minBuild.output, minBuild.entry);
	const rawLoad = await load(browser, rawBuild.output, rawBuild.entry);
	// No size, absence or fallback data before every load is in its expected mode.
	const gate = gateLoads(
		scenario,
		bundler,
		{ min: minLoad, raw: rawLoad },
		buildLogs(dir, scenario),
	);
	if (!gate.ok) return gate.failure;

	const byLoad = new Map<LoggedRequest[], Map<string, Set<string>>>();
	const dests = (requests: LoggedRequest[], path: string) => {
		let map = byLoad.get(requests);
		if (!map) {
			map = destinations(requests);
			byLoad.set(requests, map);
		}
		return map.get(path) ?? new Set<string>();
	};
	const attributed: AttributedChunk[] = [];
	for (const file of listJs(minBuild.output)) {
		const path = `/${relative(minBuild.output, file).replaceAll("\\", "/")}`;
		const shared = dests(minLoad.shared.requests, path);
		const local = dests(minLoad.local.requests, path);
		attributed.push(
			attributeFile(
				file,
				path,
				{
					realm: realmOf(shared, local),
					dests: { shared: [...shared], local: [...local] },
				},
				{ resolver },
			),
		);
	}
	const summary = summarise(attributed, {
		scenario,
		bundler,
		allowedSpinetab,
		allowedPeers,
		...(ownFiles ? { ownFiles } : {}),
	});
	const rawBytes = { page: 0, worker: 0, lazy: 0 };
	for (const file of listJs(rawBuild.output)) {
		const path = `/${relative(rawBuild.output, file).replaceAll("\\", "/")}`;
		const realm = realmOf(
			dests(rawLoad.shared.requests, path),
			dests(rawLoad.local.requests, path),
		);
		const bytes = statSync(file).size;
		if (realm === "shared") {
			rawBytes.page += bytes;
			rawBytes.worker += bytes;
		} else if (realm !== "unused") rawBytes[realm] += bytes;
	}
	const unexpectedRequests = [
		...minLoad.shared.requests,
		...minLoad.local.requests,
	]
		.filter((request) => request.status !== 200 && request.dest !== "websocket")
		.map((request) => `${request.status} ${request.path}`);
	return {
		bundler,
		minified: { chunks: summary.chunks, realms: summary.realms },
		rawBytes,
		requests: {
			shared: minLoad.shared.requests,
			local: minLoad.local.requests,
		},
		modes: { shared: minLoad.shared.ready, local: minLoad.local.ready },
		modeCheck: gate.modeCheck,
		spinetabFiles: summary.spinetabFiles,
		peers: summary.peers,
		offending: summary.offending,
		composed: summary.composed,
		...(summary.helperOwn ? { helperOwn: summary.helperOwn } : {}),
		...(summary.generated ? { generated: summary.generated } : {}),
		fallbackInShared: fallbackDownloads(
			summary.localChunks,
			minLoad.shared.requests,
			isPluginScenario(scenario),
		),
		unexpectedRequests: [...new Set(unexpectedRequests)],
	};
}

async function main(): Promise<void> {
	const tarball = tarballPath();
	const work = workRoot();
	mkdirSync(work, { recursive: true });
	const sha256 = createHash("sha256")
		.update(readFileSync(tarball))
		.digest("hex");
	cpSync(tarball, join(work, "spinetab.tgz"));
	rmSync(join(work, "package"), { recursive: true, force: true });
	await exec(
		"tar",
		["-xzf", "spinetab.tgz"],
		work,
		join(work, "logs", "extract.log"),
	);
	const packageDir = join(work, "package");

	const results: Record<
		string,
		Partial<Record<Bundler, ScenarioResult | ScenarioFailure>>
	> = {};
	const metrics: Record<string, number> = {};
	const notMeasured: Record<string, string> = {};
	const informational: Record<string, number> = {};
	const toolVersions: Record<string, unknown> = {};
	const browser = await chromium.launch();
	try {
		for (const bundler of bundlers) {
			const dir = join(work, bundler);
			writeProject(dir, bundler, scenarios, versions(), templates);
			for (const scenario of pluginScenarios) {
				writePluginProject(dir, bundler, scenario, templates);
			}
			if (!args["skip-install"]) {
				await exec(
					"pnpm",
					[
						"install",
						"--ignore-workspace",
						"--prefer-offline",
						"--config.confirmModulesPurge=false",
					],
					dir,
					join(dir, "logs", "install.log"),
				);
			}
			toolVersions[bundler] = {
				tool: bundler === "vite" ? TOOLCHAIN.vite : TOOLCHAIN.next,
				minifier:
					bundler === "vite" ? "oxc (Vite 8 default)" : "Turbopack default",
				raw:
					bundler === "vite"
						? "build.minify false"
						: "experimental.turbopackMinify false",
				gzipLevel: 9,
				brotliQuality: 11,
				seeded: JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))
					.devDependencies,
				fingerprint: toolchainFingerprint(dir),
			};
			let mutated: string | undefined;
			const outcomes: Record<string, ScenarioOutcome> = {};
			const resolver = createProvenanceResolver(dir, { pinned: versions() });
			const record = (
				scenario: SizeScenario,
				outcome: ScenarioResult | ScenarioFailure,
			) => {
				outcomes[scenario.id] = outcome;
				results[scenario.id] = {
					...(results[scenario.id] ?? {}),
					[bundler]: outcome,
				};
			};
			const failed = (scenario: SizeScenario, error: string) =>
				record(scenario, {
					bundler,
					status: "not-measured",
					error,
					logs: buildLogs(dir, scenario),
				});
			for (const scenario of scenarios) {
				const allowedSpinetab = spinetabClosure(packageDir, scenario.subpaths);
				const allowedPeers = dependencyClosure(dir, scenario.peers);
				const ownFiles = helperOwnFiles(
					scenario,
					SCENARIOS.find((candidate) => candidate.id === scenario.base),
					(subpaths) => spinetabClosure(packageDir, subpaths),
				);
				if (mutated) {
					failed(
						scenario,
						`not built: toolchain changed by an earlier build (${mutated.slice(0, 300)})`,
					);
					continue;
				}
				try {
					record(
						scenario,
						await measureScenario(
							browser,
							dir,
							bundler,
							scenario,
							allowedSpinetab,
							allowedPeers,
							resolver,
							ownFiles,
						),
					);
				} catch (error) {
					if (error instanceof ToolchainMutation) mutated = error.message;
					failed(
						scenario,
						`build or load failed: ${(error as Error).message.slice(0, 500)}`,
					);
				}
			}
			for (const scenario of pluginScenarios) {
				if (mutated) {
					failed(
						scenario,
						`not built: toolchain changed by an earlier build (${mutated.slice(0, 300)})`,
					);
					continue;
				}
				try {
					record(
						scenario,
						await measureScenario(
							browser,
							dir,
							bundler,
							scenario,
							spinetabClosure(packageDir, scenario.subpaths, PLUGIN_ALIASES),
							dependencyClosure(dir, scenario.peers),
							resolver,
							undefined,
						),
					);
				} catch (error) {
					if (error instanceof ToolchainMutation) mutated = error.message;
					failed(
						scenario,
						`build or load failed: ${(error as Error).message.slice(0, 500)}`,
					);
				}
			}
			for (const scenario of pluginScenarios) {
				const own = results[scenario.id]?.[bundler];
				if (own && isMeasured(own) && "minified" in own) {
					own.sideBySide = pluginComparison(
						scenario,
						own,
						outcomes[scenario.counterpart],
					);
				}
			}
			const rows = deriveRows(bundler, scenarios, outcomes);
			Object.assign(metrics, rows.metrics);
			Object.assign(notMeasured, rows.notMeasured);
			const plugin = derivePluginRows(
				bundler,
				pluginScenarios,
				outcomes,
				scenarios,
			);
			Object.assign(metrics, plugin.metrics);
			Object.assign(notMeasured, plugin.notMeasured);
			Object.assign(
				informational,
				informationalRows(bundler, scenarios, outcomes),
			);
		}
	} finally {
		await browser.close();
	}
	Object.assign(notMeasured, unselectedBundlerRows(bundlers));
	Object.assign(notMeasured, unselectedPluginBundlerRows(bundlers));
	if (args.control) {
		notMeasured["size.control"] =
			`negative control run (--control ${args.control}): worker requests refused; never acceptance evidence`;
	}
	const path = join(evidenceDir(run), "sizes.json");
	writeJson(path, {
		schema: 1,
		run,
		createdAt: new Date().toISOString(),
		tarball: { path: tarball, sha256 },
		workRoot: work,
		...(args.control ? { control: args.control } : {}),
		selection: {
			scenarios: scenarios.map((scenario) => scenario.id),
			plugin: pluginScenarios.map((scenario) => scenario.id),
			bundlers,
		},
		catalogue: SCENARIOS.map((scenario) => scenario.id),
		pluginCatalogue: PLUGIN_SCENARIOS.map((scenario) => scenario.id),
		pluginBundlersNotMeasured: PLUGIN_BUNDLERS_NOT_MEASURED,
		tools: toolVersions,
		peers: versions(),
		note: SPINETAB_GZIP_NOTE,
		limitations: [HELPER_DELTA_LIMITATION, PLUGIN_LIMITATION],
		metrics,
		notMeasured,
		informational,
		scenarios: results,
	});
	const notSelected = Object.values(notMeasured).filter(isNotSelected).length;
	console.log(
		`Wrote ${path} (${Object.keys(metrics).length} metrics, ${Object.keys(notMeasured).length} not measured, ${notSelected} of them not selected)`,
	);
	if (Object.keys(notMeasured).length > 0) process.exitCode = 1;
}

await main();
