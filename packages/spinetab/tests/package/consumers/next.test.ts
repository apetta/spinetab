import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BuildReport } from "./browser.ts";
import {
	appRoot,
	type ConsumerSpec,
	consumer,
	isPluginRecipe,
	MONOREPO_WORKER,
	type NextBuildPlan,
	nextBuildPlans,
	PORTS,
	recipeOf,
} from "./catalogue.ts";
import type { ConfigKeys } from "./config-keys.ts";
import { counterTotals, ensureFixtures } from "./fixtures.ts";
import { chunksByRealm, failures, inspectOutput } from "./inspect.ts";
import { startCell } from "./launch.ts";
import { consumerDir, evidenceDir, reportsDir } from "./paths.ts";
import { assertFreshPack, type PackRecord } from "./prepare.ts";
import { childEnv, nextBuildCommand, run } from "./run.ts";
import {
	readTypeText,
	scanBuildLog,
	scanConfig,
	scanSources,
} from "./workarounds.ts";

/** Both Next bundlers must keep worker code out of server chunks; SSR must stay inert. Unmapped generated client files require positive provenance. */
const configKeysScript = fileURLToPath(
	new URL("./config-keys.ts", import.meta.url),
);
const BUILD_TIMEOUT_MS = 120_000;
let record: PackRecord;
let closeFixtures: (() => Promise<void>) | undefined;

beforeAll(async () => {
	record = assertFreshPack("consumers:next");
	closeFixtures = await ensureFixtures();
});

afterAll(async () => {
	await closeFixtures?.();
	assertFreshPack("consumers:next (end)");
});

const staticRoute = (route: string) =>
	new RegExp(`[┌├└]\\s+○\\s+${route.replace(/\//g, "\\/")}\\s*$`, "m");

function evidence(name: string): string {
	const dir = join(
		evidenceDir(
			process.env.SPINETAB_CONSUMERS_RUN_ID ?? record.distHash.slice(0, 12),
		),
		name,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

const bundlerOf = (plan: NextBuildPlan) =>
	plan.webpack ? ("next-webpack" as const) : ("next" as const);

async function nextBuild(spec: ConsumerSpec, plan: NextBuildPlan) {
	const root = appRoot(spec, consumerDir(spec.name));
	const before = await counterTotals();
	const build = nextBuildCommand(root, plan.webpack === true);
	const { command } = build;
	const fromRoot = plan.fromRoot === true && spec.appDir !== undefined;
	const args = fromRoot ? [...build.args, spec.appDir as string] : build.args;
	const result = await run(command, args, {
		cwd: fromRoot ? consumerDir(spec.name) : root,
		env: { ...plan.env, NEXT_TELEMETRY_DISABLED: "1" },
		timeoutMs: BUILD_TIMEOUT_MS,
		logFile: join(
			reportsDir(spec.name),
			`next-build-${bundlerOf(plan)}-${plan.variant}.log`,
		),
	});
	const after = await counterTotals();
	return { root, result, before, after, command: [command, ...args] };
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

for (const name of ["next-app", "next-ai", "next-monorepo"]) {
	const spec = consumer(name);
	const recipe = recipeOf(spec);
	const plugin = isPluginRecipe(recipe);
	const plans = [
		...nextBuildPlans(spec),
		...nextBuildPlans(spec, "next-webpack"),
	];
	describe(name, () => {
		const root = appRoot(spec, consumerDir(name));

		it(`uses the ${recipe} recipe and documented options only`, () => {
			const sources = scanSources(root, ["app"], recipe);
			expect(sources.violations).toEqual([]);
			expect(sources.wrappers).toEqual([]);
			if (plugin) expect(sources.workerExpressions).toEqual([]);
			else expect(sources.missingWorkerExpression).toEqual([]);
			const types = readTypeText(root, "next");
			for (const plan of plans) {
				for (const phase of [
					"phase-production-build",
					"phase-development-server",
				]) {
					const keys = JSON.parse(
						execFileSync(
							process.execPath,
							[configKeysScript, join(root, "next.config.mjs")],
							{
								cwd: root,
								env: childEnv({ ...plan.env, CONSUMER_NEXT_PHASE: phase }),
								encoding: "utf8",
							},
						),
					) as ConfigKeys;
					expect(
						scanConfig(bundlerOf(plan), keys.keys, keys.plugins, types, recipe),
						`${bundlerOf(plan)} ${plan.variant} ${phase}`,
					).toEqual({ outside: [], undeclared: [], plugins: [] });
				}
			}
		});

		for (const plan of plans) {
			const bundler = bundlerOf(plan);
			it(`${bundler === "next" ? "next build" : "next build --webpack"} ${plan.variant}: static prerender, clean log, no server connection`, async () => {
				const { result, before, after, command } = await nextBuild(spec, plan);
				expect(result.timedOut, "the build must exit promptly").toBe(false);
				expect(result.code, result.output.slice(-4000)).toBe(0);
				expect(after, "fixture counters during next build").toEqual(before);
				expect(scanBuildLog(result.output)).toEqual([]);
				expect(result.output).toMatch(staticRoute("/"));
				if (name === "next-app")
					expect(result.output).toMatch(staticRoute("/other"));
				expect(result.output).toMatch(
					/\(Static\)\s+prerendered as static content/,
				);

				const report = inspectOutput({
					spec,
					bundler,
					variant: plan.variant,
					outDir: join(root, plan.distDir),
					dirs: ["static", "server"],
					serverDirs: ["server"],
					installedDist: realpathSync(join(root, "node_modules/spinetab/dist")),
					installedFiles: [
						{
							root: realpathSync(join(root, "node_modules/next")),
							dir: "dist/build/polyfills",
						},
					],
					// `--webpack` adds its own pinned shapes, never a blanket
					// exemption of framework chunks.
					generatedShapes:
						bundler === "next"
							? ["next-manifest", "turbopack-bootstrap"]
							: ["next-manifest", "next-webpack"],
					consumerRoot: realpathSync(root),
				});
				const build: BuildReport = {
					consumer: name,
					bundler,
					variant: plan.variant,
					out: plan.distDir,
					command,
					env: plan.env,
					worker: chunksByRealm(report, "worker"),
					fallback: chunksByRealm(report, "fallback"),
					page: chunksByRealm(report, "page"),
					sizes: report.sizes,
				};
				for (const dir of [reportsDir(name), evidence(name)]) {
					mkdirSync(dir, { recursive: true });
					writeFileSync(
						join(dir, `isolation-${bundler}-${plan.variant}.json`),
						`${JSON.stringify(report, null, "\t")}\n`,
					);
					writeFileSync(
						join(dir, `build-${bundler}-${plan.variant}.json`),
						`${JSON.stringify(build, null, "\t")}\n`,
					);
				}
				expect(build.worker.length, "worker chunk emitted").toBeGreaterThan(0);
				expect(build.fallback.length, "fallback chunk emitted").toBeGreaterThan(
					0,
				);
				expect(report.unmapped, "client chunks without sourcemaps").toEqual([]);
				for (const file of report.generated) {
					expect(file.kind, file.chunk).toBeTruthy();
					expect(file.provenance, file.chunk).toBeDefined();
				}
				if (bundler === "next") {
					expect(
						report.generated.filter(
							(file) =>
								file.kind === "installed-file" &&
								file.provenance.source === "installed" &&
								file.provenance.package === "next" &&
								file.provenance.file ===
									"dist/build/polyfills/polyfill-nomodule.js",
						),
						"Next's nomodule polyfill is copied verbatim",
					).toHaveLength(1);
				}
				if (plugin && bundler === "next") {
					// `static/media` holds only the shipped keep stub, never
					// the developer's worker source.
					const media = report.generated.filter((file) =>
						file.chunk.startsWith("static/media/"),
					);
					expect(media.every((file) => file.kind === "spinetab-stub")).toBe(
						true,
					);
				}
				if (recipe === "plugin" && plan.variant !== "worker-option") {
					expect(
						report.plugin?.generated.map((worker) => worker.kinds),
						"generated worker adapter set",
					).toEqual([expectedKinds(spec)]);
				}
				if (plugin) {
					expect(report.plugin?.serverWorkerCode, "server graph").toEqual([]);
					expect(report.plugin?.localPaths, "local paths").toEqual([]);
				}
				if (name === "next-monorepo") {
					// The `worker` option wins over inference: no generated
					// worker, and the worker graph holds the named file (in the
					// worker realm, or the lazy chunk Turbopack shares with the
					// worker). Without it, the file is ignored and the worker is
					// generated.
					const workerChunks = report.chunks.filter(
						(chunk) =>
							(chunk.realm === "worker" || chunk.realm === "fallback") &&
							chunk.appFiles.includes(MONOREPO_WORKER),
					);
					const anywhere = report.chunks.filter((chunk) =>
						chunk.appFiles.includes(MONOREPO_WORKER),
					);
					if (plan.variant === "worker-option") {
						expect(
							report.plugin?.generated,
							"worker option: no generated worker",
						).toEqual([]);
						expect(
							workerChunks.length,
							`a worker or lazy chunk maps ${MONOREPO_WORKER}`,
						).toBeGreaterThan(0);
					} else {
						expect(
							anywhere.map((chunk) => chunk.chunk),
							`${MONOREPO_WORKER} is unused without the worker option`,
						).toEqual([]);
					}
				}
				expect(failures(report)).toEqual([]);
				expect(report.serverMentions).toEqual([]);
			});
		}
	});
}

describe("next-app server rendering", () => {
	it("renders the server status only, with no connection, timer or credentials call", async () => {
		const cellEvidence = join(evidence("next-app"), "ssr");
		const cell = await startCell({
			id: "next-app-ssr",
			consumer: "next-app",
			bundler: "next",
			mode: "prod",
			frontPort: PORTS.next.prod,
			distDir: ".next",
			evidence: cellEvidence,
		});
		try {
			const before = await counterTotals();
			const [first, second] = await Promise.all(
				["beta", "gamma"].map(async (scope) => {
					const response = await fetch(
						`${cell.origin}/ssr?scope=${scope}&run=ssr-${scope}`,
					);
					return {
						scope,
						status: response.status,
						html: await response.text(),
					};
				}),
			);
			const probe = (await (
				await fetch(`${cell.origin}/api/probe`)
			).json()) as {
				credCalls: number;
			};
			const after = await counterTotals();
			writeFileSync(
				join(cellEvidence, "responses.json"),
				JSON.stringify({ first, second, probe, before, after }, null, "\t"),
			);
			for (const response of [first, second]) {
				expect(response?.status).toBe(200);
				expect(response?.html).toContain("inactive/server");
				expect(response?.html).toContain(`>${response?.scope}<`);
			}
			const marker = (html = "") =>
				/data-testid="marker">([^<]+)</.exec(html)?.[1] ?? "";
			expect(marker(first?.html)).not.toBe("");
			expect(marker(first?.html)).not.toBe(marker(second?.html));
			expect(first?.html).not.toContain(">gamma<");
			expect(second?.html).not.toContain(">beta<");
			expect(probe.credCalls).toBe(0);
			expect(after).toEqual(before);
		} finally {
			await cell.stop();
		}
	});
});

describe("next-monorepo from the workspace root", () => {
	it("next dev apps/web without the dir option fails with project-directory-unknown, never a plan against the root", async () => {
		// The dev child evaluates next.config with the root as its cwd and no
		// directory argument. The positive cell, with `dir`, is
		// next-monorepo-next-dev-from-root (consumers-plugin.spec.ts).
		const cellEvidence = join(
			evidence("next-monorepo"),
			"dev-from-root-no-dir",
		);
		let failure: Error | undefined;
		try {
			const cell = await startCell({
				id: "next-monorepo-dev-from-root-no-dir",
				consumer: "next-monorepo",
				bundler: "next",
				mode: "dev",
				frontPort: PORTS.next.dev,
				fromRoot: true,
				evidence: cellEvidence,
			});
			await cell.stop();
		} catch (error) {
			failure = error as Error;
		}
		expect(failure, "the start must fail").toBeInstanceOf(Error);
		const logs = readdirSync(cellEvidence)
			.filter((file) => /^upstream-\d+\.log$/.test(file))
			.map((file) => readFileSync(join(cellEvidence, file), "utf8"))
			.join("\n");
		const text = `${failure?.message ?? ""}\n${logs}`;
		writeFileSync(join(cellEvidence, "failure.txt"), text);
		expect(text).toContain("[spinetab] project-directory-unknown: ");
		// The plugin's own line names no path.
		const root = consumerDir("next-monorepo");
		for (const line of text.split("\n")) {
			if (!line.includes("[spinetab] ")) continue;
			expect(line).not.toContain(root);
			expect(line).not.toContain(realpathSync(root));
		}
	});
});

describe("next-negative", () => {
	it("fails the build when a Server Component calls a spinetab/react hook", async () => {
		const spec = consumer("next-negative");
		const [plan] = nextBuildPlans(spec);
		if (!plan) throw new Error("next-negative has no build plan");
		const { result, before, after } = await nextBuild(spec, plan);
		writeFileSync(
			join(evidence("next-negative"), "next-build.log"),
			result.output,
		);
		expect(result.timedOut).toBe(false);
		expect(result.code).not.toBe(0);
		// React's client-reference error (next 16.3.6 compiled
		// react-server-dom-turbopack server build).
		expect(result.output).toMatch(
			/Attempted to call useSubscription\(\) from the server but useSubscription is on the client/,
		);
		expect(after, "no connection attempted").toEqual(before);
	});

	it("bound: fails the build when a Server Component imports the bindClient module", async () => {
		const spec = consumer("next-negative");
		const [plan] = nextBuildPlans(spec);
		if (!plan) throw new Error("next-negative has no build plan");
		const root = consumerDir(spec.name);
		// The variant's own L3 client module (`createSpinetab()` plus
		// `bindClient`, as next-app's) beside its page.
		const replaced = ["live.ts", "page.tsx"];
		const saved = new Map(
			replaced
				.filter((file) => existsSync(join(root, "app", file)))
				.map((file) => [file, readFileSync(join(root, "app", file))]),
		);
		try {
			for (const file of replaced) {
				writeFileSync(
					join(root, "app", file),
					readFileSync(join(root, "variants/bound", file)),
				);
			}
			const { result, before, after } = await nextBuild(spec, plan);
			writeFileSync(
				join(evidence("next-negative"), "next-build-bound.log"),
				result.output,
			);
			expect(result.timedOut).toBe(false);
			expect(result.code).not.toBe(0);
			// React's client-reference error for the module-scope `bindClient`
			// call (or for the hook, should `live.ts` itself be a client module).
			expect(result.output).toMatch(
				/Attempted to call (bindClient|useSubscription)\(\) from the server but \1 is on the client/,
			);
			expect(after, "no connection attempted").toEqual(before);
		} finally {
			for (const file of replaced) {
				const original = saved.get(file);
				if (original) writeFileSync(join(root, "app", file), original);
				else rmSync(join(root, "app", file), { force: true });
			}
		}
	});
});
