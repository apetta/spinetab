import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BuildReport } from "./browser.ts";
import {
	type BuildPlan,
	buildErrorLine,
	buildPlans,
	CONSUMERS,
	CONTROL_CELLS,
	type ConsumerSpec,
	type ControlCell,
	consumer,
	recipeOf,
	SENTINEL_HOST,
} from "./catalogue.ts";
import type { ConfigKeys } from "./config-keys.ts";
import { localPathsIn } from "./generated.ts";
import {
	chunksByRealm,
	failures,
	type IsolationReport,
	inspectOutput,
	listChunks,
	serverWorkerMarkers,
	workerUrlLiterals,
} from "./inspect.ts";
import { consumerDir, evidenceDir, reportsDir, templatesDir } from "./paths.ts";
import { assertFreshPack, type PackRecord } from "./prepare.ts";
import { buildCommand, childEnv, run } from "./run.ts";
import {
	readTypeText,
	scanBuildLog,
	scanConfig,
	scanSources,
} from "./workarounds.ts";

/**
 * Packed-consumer builds.
 * Each bundler builds each consumer in production, with tree shaking
 * disabled and (webpack/Rspack) in development mode; every emitted chunk is
 * inspected through its sourcemap. Reports feed the Playwright cells.
 */
const FULL = process.env.SPINETAB_CONSUMERS_FULL === "1";
const configKeysScript = fileURLToPath(
	new URL("./config-keys.ts", import.meta.url),
);
let record: PackRecord;

beforeAll(() => {
	record = assertFreshPack("consumers:builds");
});

afterAll(() => {
	assertFreshPack("consumers:builds (end)");
});

const CONFIG_FILES: Record<string, string> = {
	vite: "vite.config.mjs",
	webpack: "webpack.config.mjs",
	rspack: "rspack.config.mjs",
	astro: "astro.config.mjs",
};

function configKeys(
	root: string,
	bundler: string,
	env: Record<string, string>,
): ConfigKeys {
	const output = execFileSync(
		process.execPath,
		[configKeysScript, join(root, CONFIG_FILES[bundler] as string)],
		{ cwd: root, env: childEnv(env), encoding: "utf8" },
	);
	return JSON.parse(output) as ConfigKeys;
}

function writeReports(
	spec: ConsumerSpec,
	plan: BuildPlan,
	report: IsolationReport,
	command: string[],
	env: Record<string, string>,
): void {
	const dir = reportsDir(spec.name);
	mkdirSync(dir, { recursive: true });
	const build: BuildReport = {
		consumer: spec.name,
		bundler: plan.bundler,
		variant: plan.variant,
		out: plan.out,
		command,
		env,
		worker: chunksByRealm(report, "worker"),
		fallback: chunksByRealm(report, "fallback"),
		page: chunksByRealm(report, "page"),
		sizes: report.sizes,
	};
	const isolationJson = `${JSON.stringify(report, null, "\t")}\n`;
	const buildJson = `${JSON.stringify(build, null, "\t")}\n`;
	const name = `${plan.bundler}-${plan.variant}`;
	writeFileSync(join(dir, `isolation-${name}.json`), isolationJson);
	writeFileSync(join(dir, `build-${name}.json`), buildJson);
	const evidence = join(
		evidenceDir(
			process.env.SPINETAB_CONSUMERS_RUN_ID ?? record.distHash.slice(0, 12),
		),
		spec.name,
	);
	mkdirSync(evidence, { recursive: true });
	writeFileSync(join(evidence, `isolation-${name}.json`), isolationJson);
	writeFileSync(join(evidence, `build-${name}.json`), buildJson);
}

async function buildAndInspect(
	spec: ConsumerSpec,
	plan: BuildPlan,
): Promise<IsolationReport> {
	const root = consumerDir(spec.name);
	const env = { ...plan.env, CONSUMER_OUT: plan.out };
	const config = configKeys(root, plan.bundler, env);
	const scan = scanConfig(
		plan.bundler,
		config.keys,
		config.plugins,
		readTypeText(root, plan.bundler),
		recipeOf(spec),
	);
	expect(scan, `${plan.bundler} ${plan.variant} config`).toEqual({
		outside: [],
		undeclared: [],
		plugins: [],
	});
	const { command, args } = buildCommand(root, plan.bundler, plan.out);
	const logFile = join(
		reportsDir(spec.name),
		`build-${plan.bundler}-${plan.variant}.log`,
	);
	const result = await run(command, args, {
		cwd: root,
		env,
		timeoutMs: 600_000,
		logFile,
	});
	expect(result.code, `${logFile}\n${result.output.slice(-3000)}`).toBe(0);
	expect(scanBuildLog(result.output), `${logFile}`).toEqual([]);
	const report = inspectOutput({
		spec,
		bundler: plan.bundler,
		variant: plan.variant,
		outDir: join(root, plan.out),
		installedDist: realpathSync(join(root, "node_modules/spinetab/dist")),
		development: plan.variant === "dev",
		consumerRoot: realpathSync(root),
	});
	writeReports(spec, plan, report, [command, ...args], env);
	return report;
}

/** The adapter kinds an L3 cell's generated worker must hold. */
function expectedKinds(spec: ConsumerSpec): string[] {
	const kinds = new Set<string>();
	for (const entry of spec.entries) {
		const name = /^\.\/([a-z-]+)\/runtime$/.exec(entry)?.[1];
		if (name && spec.entries.includes(`./${name}`)) kinds.add(name);
	}
	return [...kinds].sort();
}

/**
 * Build one control cell: its variant files replace `src/`
 * files for the build only, and are restored afterwards.
 */
async function buildControl(cell: ControlCell) {
	const spec = consumer(cell.consumer);
	const root = consumerDir(spec.name);
	// Hidden directories wait beside the consumer, outside every scan root.
	const hidden = cell.hide.map((dir) => ({
		from: join(root, dir),
		to: join(dirname(root), `.${spec.name}-${cell.id}-${dir}`),
	}));
	for (const { from, to } of hidden) {
		rmSync(to, { recursive: true, force: true });
		if (existsSync(from)) renameSync(from, to);
	}
	const saved = new Map<string, Buffer>();
	for (const file of cell.files) {
		const target = join(root, "src", file);
		if (existsSync(target)) saved.set(file, readFileSync(target));
		writeFileSync(
			target,
			readFileSync(
				join(templatesDir, spec.name, "variants", cell.id, `${file}.txt`),
			),
		);
	}
	try {
		const env = { ...cell.env, CONSUMER_OUT: cell.out };
		const config = configKeys(root, cell.bundler, env);
		const { command, args } = buildCommand(root, cell.bundler, cell.out);
		const logFile = join(
			reportsDir(spec.name),
			`build-${cell.bundler}-${cell.id}.log`,
		);
		const result = await run(command, args, {
			cwd: root,
			env,
			timeoutMs: 600_000,
			logFile,
		});
		return { spec, root, config, result, logFile };
	} finally {
		for (const file of cell.files) {
			const bytes = saved.get(file);
			if (bytes) writeFileSync(join(root, "src", file), bytes);
			else rmSync(join(root, "src", file), { force: true });
		}
		for (const { from, to } of hidden) {
			if (existsSync(to)) renameSync(to, from);
		}
	}
}

const bundled = CONSUMERS.filter((spec) => spec.kind === "bundlers");

for (const spec of bundled) {
	describe(spec.name, () => {
		const root = consumerDir(spec.name);

		const recipe = recipeOf(spec);
		const plugin = recipe === "plugin" || recipe === "plugin-worker";

		it(`uses the ${recipe} recipe and no workaround in sources`, () => {
			const scan = scanSources(root, ["src"], recipe);
			expect(scan.violations).toEqual([]);
			expect(scan.wrappers).toEqual([]);
			if (plugin) {
				// The plugin writes the literals; the application writes none.
				expect(scan.workerExpressions).toEqual([]);
			} else if (spec.proof !== "none") {
				expect(scan.missingWorkerExpression).toEqual([]);
				expect(scan.workerExpressions.length).toBeGreaterThan(0);
			}
		});

		for (const plan of buildPlans(spec, FULL)) {
			it(`${plan.bundler} ${plan.variant}: builds cleanly and keeps unselected code out`, async () => {
				const report = await buildAndInspect(spec, plan);
				if (spec.proof !== "none") {
					// The worker graph (app entry, spinetab/worker, adapters) and the
					// lazy fallback chunk are emitted.
					expect(chunksByRealm(report, "worker").length).toBeGreaterThan(0);
					expect(chunksByRealm(report, "fallback").length).toBeGreaterThan(0);
				}
				if (recipe === "plugin") {
					// The client maps carry exactly one generated worker, for
					// exactly the adapters the application imports.
					expect(
						report.plugin?.generated.map((worker) => worker.kinds),
						"generated worker adapter set",
					).toEqual([expectedKinds(spec)]);
				}
				if (spec.name === "vanilla-polling") {
					// control (cell a): src/examples.js, imported by nothing,
					// names socket-io in a comment and websocket in a string. The
					// worker holds the polling adapter alone, and the build log has
					// no [spinetab] line (no false missing-peer, no scan-fallback),
					// which buildAndInspect already asserts.
					expect(
						existsSync(join(root, "src", "examples.js")),
						"the control source",
					).toBe(true);
					expect(
						report.plugin?.generated.map((worker) => worker.kinds),
						"control: comments and strings select no adapter",
					).toEqual([["polling"]]);
				}
				if (plugin) {
					expect(report.plugin?.serverWorkerCode, "server graph").toEqual([]);
					expect(report.plugin?.localPaths, "local paths").toEqual([]);
				}
				if (plan.bundler === "astro") {
					// on Astro's static build: `astro build` prerenders, then
					// removes its server output ("Rearranging server assets"), so
					// the server graph leaves no file to scan. Assert that rather
					// than pass on an empty scan, and scan what it rendered.
					const out = join(root, plan.out);
					for (const dir of ["server", ".prerender", "chunks"]) {
						expect(existsSync(join(out, dir)), `${plan.out}/${dir}`).toBe(
							false,
						);
					}
					expect(
						listChunks(out)
							.map((file) => relative(out, file).replace(/\\/g, "/"))
							.filter((file) => !file.startsWith("_astro/")),
						"JavaScript outside the client assets",
					).toEqual([]);
					const pages = readdirSync(out).filter((file) =>
						file.endsWith(".html"),
					);
					expect(pages.length).toBeGreaterThan(0);
					for (const page of pages) {
						expect(
							serverWorkerMarkers(readFileSync(join(out, page), "utf8")),
							`${page}: prerendered by the server graph`,
						).toEqual([]);
					}
				}
				if (!spec.isolation) return;
				expect(report.unmapped, "every emitted chunk has a sourcemap").toEqual(
					[],
				);
				expect(
					failures(report),
					`unselected Spinetab areas or peers reached a chunk`,
				).toEqual([]);
				expect(report.verdict).toBe("pass");
			});
		}

		if (spec.name === "react-sse-tanstack") {
			it("vite deploy-v2: a second deployment has a different worker script", async () => {
				const deployment = join(root, "src/deployment.js");
				const original = readFileSync(deployment, "utf8");
				writeFileSync(deployment, original.replace('"v1"', '"v2"'));
				try {
					const plan: BuildPlan = {
						bundler: "vite",
						variant: "deploy-v2",
						out: "out/vite-deploy-v2",
						env: { CONSUMER_MODE: "production" },
					};
					const report = await buildAndInspect(spec, plan);
					const v1 = JSON.parse(
						readFileSync(
							join(reportsDir(spec.name), "build-vite-prod.json"),
							"utf8",
						),
					) as BuildReport;
					const v2Worker = chunksByRealm(report, "worker");
					expect(v2Worker.length).toBeGreaterThan(0);
					expect(v2Worker).not.toEqual(v1.worker);
				} finally {
					writeFileSync(deployment, original);
				}
			});
		}
	});
}

/**
 * the plugin's `credentialOrigins` reaches the output only
 * inside the generated worker, so every file carrying the sentinel is a
 * worker or lazy-local chunk (or its map), both realms carry it, and the
 * page's literal worker URLs have no query or hash.
 */
function sentinelOnlyInWorker(
	report: IsolationReport,
	out: string,
	sentinel: string,
): void {
	expect(report.verdict, "isolation verdict").toBe("pass");
	expect(
		report.plugin?.generated.map((worker) => worker.credentialOrigins),
		"generated worker audience",
	).toEqual([[`https://${SENTINEL_HOST}`]]);
	const realms = new Map(
		report.chunks.map((chunk) => [chunk.chunk, chunk.realm]),
	);
	const carriers = (readdirSync(out, { recursive: true }) as string[])
		.map((file) => file.replace(/\\/g, "/"))
		.filter((file) => statSync(join(out, file)).isFile())
		.filter((file) => readFileSync(join(out, file), "utf8").includes(sentinel))
		.sort();
	const carrierRealms = carriers.map((file) => ({
		file,
		realm: realms.get(file.replace(/\.map$/, "")) ?? "none",
	}));
	expect(
		carrierRealms.filter(
			({ realm }) => realm !== "worker" && realm !== "fallback",
		),
		"files carrying the audience outside the worker and lazy chunks",
	).toEqual([]);
	for (const realm of ["worker", "fallback"] as const) {
		expect(
			carrierRealms.some((carrier) => carrier.realm === realm),
			`a ${realm} chunk carries the generated audience`,
		).toBe(true);
	}
	const urls = chunksByRealm(report, "page").flatMap((chunk) =>
		workerUrlLiterals(readFileSync(join(out, chunk), "utf8")),
	);
	expect(urls.length, "literal worker URLs in the page").toBeGreaterThan(0);
	expect(
		urls.filter((url) => /[?#]/.test(url)),
		"worker URLs with a query or hash",
	).toEqual([]);
}

describe("plugin control cells", () => {
	for (const cell of CONTROL_CELLS) {
		it(`${cell.consumer} ${cell.id}: ${cell.expect.build === "fail" ? `fails with ${cell.expect.code}` : "builds"}`, async () => {
			const { spec, root, config, result, logFile } = await buildControl(cell);
			const scan = scanConfig(
				cell.bundler,
				config.keys,
				config.plugins,
				readTypeText(root, cell.bundler),
				recipeOf(spec),
			);
			if (cell.id === "plugin-absent") {
				expect(scan.plugins).toEqual(["missing:name:spinetab"]);
			} else {
				expect(scan).toEqual({ outside: [], undeclared: [], plugins: [] });
			}
			if (cell.sentinel !== undefined) {
				// No option value is echoed, in the collected output or the
				// whole log file.
				expect(result.output.includes(cell.sentinel), logFile).toBe(false);
				expect(
					readFileSync(logFile, "utf8").includes(cell.sentinel),
					logFile,
				).toBe(false);
			}
			if (cell.expect.build === "fail") {
				expect(result.code, logFile).not.toBe(0);
				const lines = result.output
					.split(/\r?\n/)
					.filter((line) =>
						buildErrorLine(
							cell.expect.build === "fail" ? cell.expect.code : "",
						).test(line),
					);
				expect(lines.length, `${logFile}: exactly one [spinetab] line`).toBe(1);
				if (cell.expect.line !== undefined) {
					expect(lines[0], `${logFile}: the fixed message`).toContain(
						cell.expect.line,
					);
				}
				// No option value, absolute path or environment text, in
				// either spelling of the root (the work root is below a symlinked
				// temporary directory on macOS) or any home or temporary prefix.
				expect(
					localPathsIn(result.output, [root, realpathSync(root)]),
					`${logFile}: local paths`,
				).toEqual([]);
				return;
			}
			expect(result.code, `${logFile}\n${result.output.slice(-3000)}`).toBe(0);
			expect(scanBuildLog(result.output), logFile).toEqual([]);
			const report = inspectOutput({
				spec,
				bundler: cell.bundler,
				variant: cell.id,
				outDir: join(root, cell.out),
				installedDist: realpathSync(join(root, "node_modules/spinetab/dist")),
				consumerRoot: realpathSync(root),
			});
			writeReports(
				spec,
				{
					bundler: cell.bundler,
					variant: cell.id,
					out: cell.out,
					env: cell.env,
				},
				report,
				[result.command[0] as string, ...result.command.slice(1)],
				cell.env,
			);
			if (cell.sentinel !== undefined) {
				sentinelOnlyInWorker(report, join(root, cell.out), cell.sentinel);
			}
			if (cell.id === "verbatim-type-only") {
				// (cell c): the build passed the graph check (no
				// adapter-not-generated line) and the worker holds polling alone.
				expect(
					report.plugin?.generated.map((worker) => worker.kinds),
					"a type-only importer selects no adapter",
				).toEqual([["polling"]]);
			}
			if (cell.id === "plugin-absent") {
				// The inert default: no auto seams and no worker in the output.
				expect(
					report.chunks.flatMap((chunk) =>
						chunk.spinetabFiles.filter((file) =>
							/^(auto\/|worker-config)/.test(file),
						),
					),
				).toEqual([]);
			}
		});
	}
});
