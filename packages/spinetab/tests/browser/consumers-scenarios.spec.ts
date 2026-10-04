import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
	describeCell,
	devResponseLocalPaths,
	downloadedBytes,
	isolationReport,
	newRun,
	openProbePage,
	pageUrl,
	provePair,
	requestsFor,
	sendAiMessage,
	waitForAiAnswer,
	waitForAiReady,
	waitForEvents,
	waitForMode,
	workerNameProblems,
} from "../package/consumers/browser.ts";
import {
	type Bundler,
	consumer,
	isPluginRecipe,
	localModule,
	PORTS,
	STATIC_CSP,
} from "../package/consumers/catalogue.ts";
import { failures, inspectOutput } from "../package/consumers/inspect.ts";
import { consumerDir } from "../package/consumers/paths.ts";

/**
 * Isolation scenarios: Vue + graphql-ws,
 * vanilla polling and React + AI SDK, each with only its own peers installed,
 * on the Vite, webpack and Rspack dev servers (every CI run) and as
 * production smokes (enabled with SPINETAB_CONSUMERS_FULL=1). Next cannot host the Vue or vanilla
 * scenarios (React is mandatory); those cells are N/A, not skipped silently.
 * Dev isolation evidence: Vite's pre-bundled dependency maps and served
 * dependency ids; the webpack/Rspack `--mode development` builds.
 * Plugin recipes: the SharedWorker carries the
 * `spinetab-<hash12>` name in development only; L1 recipes
 * never name it. Vite dev responses naming Spinetab hold no local path.
 */
const SCENARIOS = [
	"vue-graphql-ws",
	"vanilla-polling",
	"react-ai-sdk",
] as const;
const BUNDLERS = ["vite", "webpack", "rspack"] as const;
const smokes = !process.env.CI || process.env.SPINETAB_CONSUMERS_FULL === "1";

const routes = (name: string) =>
	name === "react-ai-sdk"
		? {
				routes: {
					"/api/chat": join(consumerDir(name), "server/chat.mjs"),
					"/api/counters": join(consumerDir(name), "server/chat.mjs"),
				},
			}
		: {};

/** Vite's flattened dependency id for a Spinetab subpath (`./sse/runtime` → `spinetab_sse_runtime`). */
const viteDepId = (subpath: string) =>
	`spinetab${subpath.replace(/^\./, "").replace(/\//g, "_")}`;

for (const name of SCENARIOS) {
	const spec = consumer(name);
	const plugin = isPluginRecipe(spec.recipe);
	for (const bundler of BUNDLERS as readonly Bundler[]) {
		describeCell(
			{
				id: `${name}-${bundler}-dev`,
				consumer: name,
				bundler,
				mode: "dev",
				variant: "dev",
				frontPort: PORTS[bundler as "vite" | "webpack" | "rspack"].dev,
				front: routes(name),
				report: bundler === "vite" ? null : { bundler, variant: "dev" },
			},
			(context) => {
				test("shares on the dev server and serves only selected code", async ({
					browser,
				}) => {
					const browserContext = await browser.newContext();
					try {
						const result = await provePair({
							context: browserContext,
							cell: context.cell(),
							path: "/",
							run: newRun(),
							proof: spec.proof,
							mode: "dev",
							fallback:
								bundler === "vite"
									? [localModule(spec)]
									: (context.report()?.fallback ?? []),
							recordWorkers: true,
						});
						expect(result.pageErrors).toEqual([]);
						expect(
							workerNameProblems(result.sharedWorkers, plugin ? "dev" : "prod"),
							"SharedWorker name",
						).toEqual([]);
						if (bundler === "vite") {
							const root = consumerDir(name);
							if (plugin) {
								const found = await devResponseLocalPaths(context.cell(), [
									root,
									realpathSync(root),
								]);
								expect(found, "local paths in dev responses").toEqual([]);
							}
							const report = inspectOutput({
								spec,
								bundler,
								variant: "dev",
								outDir: join(root, "node_modules/.vite/deps"),
								defaultRealm: "dev-deps",
								installedDist: realpathSync(
									join(root, "node_modules/spinetab/dist"),
								),
							});
							writeFileSync(
								join(context.evidence(), "isolation-vite-dev-deps.json"),
								`${JSON.stringify(report, null, "\t")}\n`,
							);
							expect(report.chunks.length).toBeGreaterThan(0);
							expect(failures(report)).toEqual([]);
							const allowed = new Set(spec.entries.map(viteDepId));
							const served = result.log.requests
								.map(
									(request) =>
										/\/\.vite\/deps\/(spinetab[^./?]*)\.js/.exec(
											request.path,
										)?.[1],
								)
								.filter((id): id is string => typeof id === "string");
							expect(served.filter((id) => !allowed.has(id))).toEqual([]);
						} else {
							const report = isolationReport(name, bundler, "dev");
							expect(report?.verdict, "development build isolation").toBe(
								"pass",
							);
						}
						context.note({ counters: result.counters });
					} finally {
						await browserContext.close();
					}
				});
			},
		);

		describeCell(
			{
				id: `${name}-${bundler}-prod`,
				consumer: name,
				bundler,
				mode: "prod",
				variant: "prod",
				frontPort: PORTS[bundler as "vite" | "webpack" | "rspack"].prod,
				out: `out/${bundler}-prod`,
				front: { csp: STATIC_CSP, ...routes(name) },
			},
			(context) => {
				test.skip(
					!smokes,
					"production smokes run with SPINETAB_CONSUMERS_FULL=1",
				);
				test("production smoke: two pages share one upstream under a strict CSP", async ({
					browser,
				}) => {
					const browserContext = await browser.newContext();
					try {
						const result = await provePair({
							context: browserContext,
							cell: context.cell(),
							path: "/",
							run: newRun(),
							proof: spec.proof,
							mode: "prod",
							fallback: context.report()?.fallback ?? [],
							recordWorkers: true,
						});
						expect(result.pageErrors).toEqual([]);
						expect(
							workerNameProblems(result.sharedWorkers, "prod"),
							"no SharedWorker name in production",
						).toEqual([]);
						context.note({
							counters: result.counters,
							downloaded: { shared: result.downloaded },
						});
					} finally {
						await browserContext.close();
					}
				});

				// One module is both the worker entry and the lazy local runtime in
				// the one-file recipe and on both plugin rungs.
				if (spec.recipe !== undefined && spec.recipe !== "three-file") {
					test("local mode fetches the one-file module once, as the page's own chunk, and no worker chunk", async ({
						browser,
					}) => {
						const cell = context.cell();
						const fallback = context.report()?.fallback ?? [];
						expect(fallback.length).toBeGreaterThan(0);
						const browserContext = await browser.newContext();
						try {
							cell.front.reset();
							const { page, pageErrors } = await openProbePage(
								browserContext,
								pageUrl(cell.origin, "/", newRun(), { mode: "local" }),
							);
							const status = await waitForMode(page, "local");
							expect(status.reason).toBe("sharing-off");
							if (spec.proof === "ai") {
								// The AI page streams only after a message is sent.
								await waitForAiReady(page);
								await sendAiMessage(page);
								await waitForAiAnswer(page);
								await waitForEvents(page, 1);
							} else {
								await waitForEvents(page, 2);
							}
							const log = cell.log();
							expect(requestsFor(log, fallback, "page")).toHaveLength(
								fallback.length,
							);
							expect(requestsFor(log, context.report()?.worker ?? [])).toEqual(
								[],
							);
							expect(pageErrors).toEqual([]);
							context.note({ downloaded: { local: downloadedBytes(log) } });
						} finally {
							await browserContext.close();
						}
					});
				}
			},
		);
	}
}
