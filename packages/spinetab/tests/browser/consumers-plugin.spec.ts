import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
	describeCell,
	devOutputLocalPaths,
	devResponseLocalPaths,
	isolationReport,
	newRun,
	openProbePage,
	pageUrl,
	provePair,
	requestsFor,
	waitForMode,
	workerNameProblems,
} from "../package/consumers/browser.ts";
import {
	appRoot,
	type Bundler,
	CONTROL_CELLS,
	consumer,
	PORTS,
	STATIC_CSP,
} from "../package/consumers/catalogue.ts";
import type { FrontOptions } from "../package/consumers/front.ts";
import { consumerDir } from "../package/consumers/paths.ts";
import { namesChunk } from "../package/consumers/requests.ts";

/**
 * Plugin cells: the new Astro and Next
 * `--webpack` cells, the workspace consumer, and the control cells whose
 * builds pass. Each cell reads the build report `pnpm test:consumers`
 * wrote; the fallback chunks it names are never fetched while shared.
 * Every cell records the pages' SharedWorker calls: a `spinetab-<hash12>`
 * name in development, none in production. Development cells
 * scan their Spinetab output for local paths; production cells run
 * under a strict CSP (the static front's, or the app's own header).
 */

interface PluginCell {
	id: string;
	name: string;
	bundler: Bundler;
	mode: "prod" | "dev";
	variant: string;
	frontPort: number;
	out?: string;
	distDir?: string;
	env?: Record<string, string>;
	front?: Omit<FrontOptions, "port" | "static" | "upstream">;
	fromRoot?: boolean;
}

const CELLS: readonly PluginCell[] = [
	// (consumer cell b): CommonJS page code on webpack and Rspack; the
	// root's require of the wiring seam resolves to the plugin's wiring.
	...(["webpack", "rspack"] as const).map(
		(bundler): PluginCell => ({
			id: `vanilla-polling-${bundler}-cjs`,
			name: "vanilla-polling",
			bundler,
			mode: "prod",
			variant: "cjs",
			frontPort: PORTS[bundler].prod,
			out: `out/${bundler}-cjs`,
			front: { csp: STATIC_CSP },
		}),
	),
	{
		id: "astro-polling-astro-prod",
		name: "astro-polling",
		bundler: "astro",
		mode: "prod",
		variant: "prod",
		frontPort: PORTS.astro.prod,
		out: "dist",
		front: { csp: STATIC_CSP },
	},
	{
		id: "astro-polling-astro-dev",
		name: "astro-polling",
		bundler: "astro",
		mode: "dev",
		variant: "dev",
		frontPort: PORTS.astro.dev,
	},
	{
		id: "next-app-next-webpack-prod",
		name: "next-app",
		bundler: "next-webpack",
		mode: "prod",
		variant: "prod",
		frontPort: PORTS["next-webpack"].prod,
		distDir: ".next-webpack",
	},
	{
		id: "next-monorepo-next-prod",
		name: "next-monorepo",
		bundler: "next",
		mode: "prod",
		variant: "prod",
		frontPort: PORTS.next.prod,
		distDir: ".next",
	},
	{
		id: "next-monorepo-next-webpack-prod",
		name: "next-monorepo",
		bundler: "next-webpack",
		mode: "prod",
		variant: "prod",
		frontPort: PORTS["next-webpack"].prod,
		distDir: ".next-webpack",
	},
	{
		id: "next-monorepo-next-webpack-dev",
		name: "next-monorepo",
		bundler: "next-webpack",
		mode: "dev",
		variant: "dev",
		frontPort: PORTS["next-webpack"].dev,
	},
	{
		// (consumer cell d): `next dev apps/web` from the workspace
		// root. The dev child has neither the directory argument nor that
		// directory as its cwd, so next.config names it through the `dir`
		// option (`import.meta.dirname`); without it the start fails with
		// project-directory-unknown (consumers/next.test.ts).
		id: "next-monorepo-next-dev-from-root",
		name: "next-monorepo",
		bundler: "next",
		mode: "dev",
		variant: "dev-from-root",
		frontPort: PORTS.next.dev,
		env: { CONSUMER_PLUGIN_DIR: "1" },
		fromRoot: true,
	},
];

for (const cell of CELLS) {
	const spec = consumer(cell.name);
	describeCell(
		{
			id: cell.id,
			consumer: cell.name,
			bundler: cell.bundler,
			mode: cell.mode,
			variant: cell.variant,
			frontPort: cell.frontPort,
			...(cell.out ? { out: cell.out } : {}),
			...(cell.distDir ? { distDir: cell.distDir } : {}),
			...(cell.env ? { env: cell.env } : {}),
			...(cell.front ? { front: cell.front } : {}),
			...(cell.fromRoot ? { fromRoot: true } : {}),
			report:
				cell.mode === "prod"
					? { bundler: cell.bundler, variant: cell.variant }
					: null,
		},
		(context) => {
			test("reaches shared mode through the plugin and never fetches the fallback", async ({
				browser,
			}) => {
				const running = context.cell();
				if (cell.bundler !== "astro" && cell.mode === "prod") {
					// The Next apps send their own strict policy.
					const response = await fetch(`${running.origin}/`);
					const policy = response.headers.get("content-security-policy");
					await response.body?.cancel();
					expect(policy, "application CSP header").toContain(
						"worker-src 'self'",
					);
				}
				const browserContext = await browser.newContext();
				try {
					const result = await provePair({
						context: browserContext,
						cell: running,
						path: "/",
						run: newRun(),
						proof: spec.proof,
						mode: cell.mode,
						fallback: context.report()?.fallback ?? [],
						recordWorkers: true,
					});
					expect(result.pageErrors).toEqual([]);
					expect(
						workerNameProblems(result.sharedWorkers, cell.mode),
						"SharedWorker name",
					).toEqual([]);
					const notes: string[] = [];
					if (cell.mode === "dev") {
						const root = appRoot(spec, consumerDir(cell.name));
						const roots = [root, realpathSync(root)];
						if (cell.bundler === "astro") {
							const found = await devResponseLocalPaths(running, roots);
							expect(found, "local paths in dev responses").toEqual([]);
						} else {
							// `next dev --webpack` writes its client chunks to disk.
							const scan = devOutputLocalPaths(
								join(root, ".next/dev/static"),
								roots,
							);
							writeFileSync(
								join(context.evidence(), "g3-next-dev-webpack.json"),
								`${JSON.stringify(scan, null, "\t")}\n`,
							);
							expect(
								scan.modules,
								"Spinetab modules scanned in the dev output",
							).toBeGreaterThan(0);
							expect(scan.found, "local paths in dev output").toEqual([]);
							notes.push(`${scan.modules} Spinetab dev modules scanned`);
						}
					}
					context.note({
						counters: result.counters,
						notes: [
							...notes,
							...result.sharedWorkers.map(
								(call) => `SharedWorker ${call.url} name ${call.name}`,
							),
						],
					});
				} finally {
					await browserContext.close();
				}
			});

			test("local mode fetches the lazy worker chunk in the page and no worker script", async ({
				browser,
			}) => {
				const running = context.cell();
				const report = context.report();
				const browserContext = await browser.newContext();
				try {
					running.front.reset();
					const { page, pageErrors } = await openProbePage(
						browserContext,
						pageUrl(running.origin, "/", newRun(), { mode: "local" }),
					);
					const status = await waitForMode(page, "local");
					expect(status.reason).toBe("sharing-off");
					expect(pageErrors).toEqual([]);
					if (report) {
						// Production: the lazy chunk (the keep stub with the generated
						// worker at L3) is the page's own download; no worker script.
						expect(report.fallback.length).toBeGreaterThan(0);
						expect(
							requestsFor(running.log(), report.fallback, "page").length,
						).toBeGreaterThan(0);
						expect(requestsFor(running.log(), report.worker)).toEqual([]);
					}
				} finally {
					await browserContext.close();
				}
			});
		},
	);
}

const viteControl = (id: string) => {
	const cell = CONTROL_CELLS.find((entry) => entry.id === id);
	if (!cell) throw new Error(`Unknown control cell ${id}`);
	return cell;
};

describeCell(
	{
		id: "vanilla-polling-vite-plugin-absent",
		consumer: "vanilla-polling",
		bundler: "vite",
		mode: "prod",
		variant: "plugin-absent",
		frontPort: PORTS.vite.prod,
		out: viteControl("plugin-absent").out,
		report: { bundler: "vite", variant: "plugin-absent" },
	},
	(context) => {
		test("without the plugin the first start fails with not-configured", async ({
			browser,
		}) => {
			const browserContext = await browser.newContext();
			try {
				const { page } = await openProbePage(
					browserContext,
					pageUrl(context.cell().origin, "/", newRun()),
				);
				const status = await waitForMode(page, "failed");
				expect(status.reason).toBe("not-configured");
				expect(status.error?.code).toBe("not-configured");
				// No worker and no lazy runtime exist to fetch.
				expect(context.report()?.worker ?? []).toEqual([]);
			} finally {
				await browserContext.close();
			}
		});
	},
);

describeCell(
	{
		id: "vanilla-polling-vite-explicit-options",
		consumer: "vanilla-polling",
		bundler: "vite",
		mode: "prod",
		variant: "explicit-options",
		frontPort: PORTS.vite.prod,
		out: viteControl("explicit-options").out,
		report: { bundler: "vite", variant: "explicit-options" },
	},
	(context) => {
		test("explicit worker and local win over the plugin, all or nothing", async ({
			browser,
		}) => {
			// The build emits both workers: the explicit one maps the
			// application's live.worker.js; the plugin's maps the generated
			// worker-config.js or the keep stub.
			const isolation = isolationReport(
				"vanilla-polling",
				"vite",
				"explicit-options",
			);
			expect(isolation, "explicit-options isolation report").not.toBeNull();
			const workers = (isolation?.chunks ?? []).filter(
				(chunk) => chunk.realm === "worker",
			);
			const pluginWorkers = workers
				.filter((chunk) =>
					chunk.spinetabFiles.some(
						(file) => file === "worker-config.js" || file.startsWith("auto/"),
					),
				)
				.map((chunk) => chunk.chunk);
			const explicitWorkers = workers
				.map((chunk) => chunk.chunk)
				.filter((chunk) => !pluginWorkers.includes(chunk));
			expect(
				explicitWorkers.length,
				"the explicit worker chunk",
			).toBeGreaterThan(0);
			expect(pluginWorkers.length, "the plugin's worker chunk").toBeGreaterThan(
				0,
			);
			const browserContext = await browser.newContext();
			try {
				const cell = context.cell();
				const result = await provePair({
					context: browserContext,
					cell,
					path: "/",
					run: newRun(),
					proof: "polling",
					mode: "prod",
					fallback: context.report()?.fallback ?? [],
					recordWorkers: true,
				});
				expect(result.pageErrors).toEqual([]);
				// fallback-downloads-in-shared = 0, the plugin's chunks included.
				expect(
					requestsFor(cell.log(), context.report()?.fallback ?? [], "page"),
				).toEqual([]);
				// Every client constructed the explicit worker, never the
				// plugin's, and fetched no plugin worker script at all.
				expect(result.sharedWorkers.length).toBeGreaterThan(0);
				for (const call of result.sharedWorkers) {
					const path = new URL(call.url, cell.origin).pathname;
					expect(
						explicitWorkers.some((file) => namesChunk(path, file)),
						`${call.url} is the explicit worker`,
					).toBe(true);
					expect(call.name, "no worker name").toBeNull();
				}
				expect(requestsFor(cell.log(), pluginWorkers)).toEqual([]);
				expect(
					requestsFor(cell.log(), explicitWorkers, "worker").length,
				).toBeGreaterThan(0);
			} finally {
				await browserContext.close();
			}
		});
	},
);
