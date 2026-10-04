import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
	describeCell,
	newRun,
	openProbePage,
	pageUrl,
	provePair,
	sseCounters,
	waitForEvents,
	waitForMode,
	wsCounters,
} from "../package/consumers/browser.ts";
import {
	CDN_ORIGIN,
	PORTS,
	STARTUP_REASONS,
	STATIC_CSP,
} from "../package/consumers/catalogue.ts";
import { type Front, startFront } from "../package/consumers/front.ts";
import { consumerDir } from "../package/consumers/paths.ts";

/**
 * Base paths, nested routes and CDN asset prefixes. Relative endpoints resolve against the
 * application base before crossing the bridge: the fixture sees its own
 * paths, nothing is misrouted, and shared and local pages resolve the same
 * identity. A CDN prefix without a worker prefix is a documented startup
 * failure; with `turbopackWorkerAssetPrefix: ''` the worker stays
 * same-origin and shares.
 */
const CONSUMER = "react-sse-tanstack";
const ci =
	Boolean(process.env.CI) && process.env.SPINETAB_CONSUMERS_FULL !== "1";

async function endpointOf(
	page: import("@playwright/test").Page,
): Promise<string> {
	return page.evaluate(() => window.__consumer?.endpoint ?? "");
}

describeCell(
	{
		id: `${CONSUMER}-vite-base`,
		consumer: CONSUMER,
		bundler: "vite",
		mode: "prod",
		variant: "base",
		frontPort: PORTS.vite.base,
		out: "out/vite-base",
		front: { csp: STATIC_CSP, mount: "/app/", spa: true },
		report: { bundler: "vite", variant: "base" },
	},
	(context) => {
		test("relative endpoints resolve against /app/ in shared and local mode", async ({
			browser,
		}) => {
			const browserContext = await browser.newContext();
			try {
				const cell = context.cell();
				const run = newRun();
				const result = await provePair({
					context: browserContext,
					cell,
					path: "/app/",
					mount: "/app/",
					run,
					proof: "sse",
					mode: "prod",
					fallback: context.report()?.fallback ?? [],
				});
				const shared = await endpointOf(
					result.pages[0] as import("@playwright/test").Page,
				);
				expect(shared.startsWith(`${cell.origin}/app/fx/sse/ticks?`)).toBe(
					true,
				);
				const local = await openProbePage(
					browserContext,
					pageUrl(cell.origin, "/app/", run, { mode: "local" }),
				);
				await waitForMode(local.page, "local");
				expect(await endpointOf(local.page)).toBe(shared);
				expect(cell.log().misrouted).toEqual([]);
				context.note({ counters: result.counters });
			} finally {
				await browserContext.close();
			}
		});

		test("a nested route still resolves endpoints against the base", async ({
			browser,
		}) => {
			const browserContext = await browser.newContext();
			try {
				const cell = context.cell();
				cell.front.reset();
				const run = newRun();
				const { page } = await openProbePage(
					browserContext,
					pageUrl(cell.origin, "/app/nested/", run),
				);
				await waitForMode(page, "shared");
				await waitForEvents(page, 2);
				expect(await endpointOf(page)).toContain(
					`${cell.origin}/app/fx/sse/ticks?`,
				);
				expect(cell.log().misrouted).toEqual([]);
				expect((await sseCounters(run)).streams).toBe(1);
			} finally {
				await browserContext.close();
			}
		});
	},
);

for (const bundler of ["webpack", "rspack"] as const) {
	describeCell(
		{
			id: `${CONSUMER}-${bundler}-base`,
			consumer: CONSUMER,
			bundler,
			mode: "prod",
			variant: "base",
			frontPort: PORTS[bundler].base,
			out: `out/${bundler}-prod`,
			front: { csp: STATIC_CSP, mount: "/app/" },
			report: { bundler, variant: "prod" },
		},
		(context) => {
			test("the same build mounted at /app/ shares with relative endpoints", async ({
				browser,
			}) => {
				const browserContext = await browser.newContext();
				try {
					const result = await provePair({
						context: browserContext,
						cell: context.cell(),
						path: "/app/",
						mount: "/app/",
						run: newRun(),
						proof: "sse",
						mode: "prod",
						fallback: context.report()?.fallback ?? [],
					});
					context.note({ counters: result.counters });
				} finally {
					await browserContext.close();
				}
			});
		},
	);
}

describeCell(
	{
		id: "next-app-next-base",
		consumer: "next-app",
		bundler: "next",
		mode: "prod",
		variant: "base",
		frontPort: PORTS.next.base,
		distDir: ".next-base",
		env: {
			CONSUMER_BASE_PATH: "/app",
			CONSUMER_DIST_DIR: ".next-base",
			NEXT_PUBLIC_BASE_PATH: "/app",
		},
		front: { mount: "/app/" },
		readyPath: "/app",
		report: { bundler: "next", variant: "base" },
	},
	(context) => {
		test("basePath pages share and proxy relative endpoints under /app/", async ({
			browser,
		}) => {
			const browserContext = await browser.newContext();
			try {
				const cell = context.cell();
				const run = newRun();
				const result = await provePair({
					context: browserContext,
					cell,
					path: "/app",
					mount: "/app/",
					run,
					proof: "ws",
					mode: "prod",
					scope: "alpha",
					fallback: context.report()?.fallback ?? [],
				});
				await expect.poll(async () => (await sseCounters(run)).active).toBe(1);
				expect(
					Object.keys(cell.log().proxied).some((path) =>
						path.startsWith("/app/fx/sse/ticks?"),
					),
				).toBe(true);
				expect(cell.log().misrouted).toEqual([]);
				context.note({ counters: result.counters });
			} finally {
				await browserContext.close();
			}
		});
	},
);

for (const variant of ["cdn", "cdn-worker"] as const) {
	const withWorkerPrefix = variant === "cdn-worker";
	describeCell(
		{
			id: `next-app-next-${variant}`,
			consumer: "next-app",
			bundler: "next",
			mode: "prod",
			variant,
			frontPort: PORTS.next.cdnApp,
			distDir: `.next-${variant}`,
			env: {
				CONSUMER_ASSET_PREFIX: CDN_ORIGIN,
				CONSUMER_DIST_DIR: `.next-${variant}`,
				...(withWorkerPrefix ? { CONSUMER_WORKER_ASSET_PREFIX: "" } : {}),
			},
			report: { bundler: "next", variant },
		},
		(context) => {
			test.skip(ci, "CDN prefix cells run with SPINETAB_CONSUMERS_FULL=1");
			let cdn: Front | undefined;
			test.beforeAll(async () => {
				cdn = await startFront({
					port: PORTS.next.cdnStatic,
					static: join(consumerDir("next-app"), `.next-${variant}`, "static"),
					mount: "/_next/static/",
				});
			});
			test.afterAll(async () => {
				await cdn?.close();
			});

			if (withWorkerPrefix) {
				test("a same-origin worker prefix keeps sharing under a CDN asset prefix", async ({
					browser,
				}) => {
					const browserContext = await browser.newContext();
					try {
						const run = newRun();
						const result = await provePair({
							context: browserContext,
							cell: context.cell(),
							path: "/",
							run,
							proof: "ws",
							mode: "prod",
							scope: "alpha",
							fallback: context.report()?.fallback ?? [],
						});
						expect(
							cdn
								?.log()
								.requests.some((request) =>
									request.path.includes("/_next/static/"),
								),
							"page assets came from the CDN origin",
						).toBe(true);
						context.note({ counters: result.counters });
					} finally {
						await browserContext.close();
					}
				});
				return;
			}

			test("prefer: a cross-origin worker URL falls back with a startup reason", async ({
				browser,
			}) => {
				const browserContext = await browser.newContext();
				try {
					const cell = context.cell();
					const run = newRun();
					const { page } = await openProbePage(
						browserContext,
						pageUrl(cell.origin, "/", run),
					);
					const status = await waitForMode(page, "local", 30_000);
					expect(STARTUP_REASONS).toContain(status.reason);
					await waitForEvents(page, 2);
					expect((await wsCounters(run)).opens).toBe(1);
					context.note({ notes: [`cross-origin prefer: ${status.reason}`] });
				} finally {
					await browserContext.close();
				}
			});

			test("require: a cross-origin worker URL fails with sharing-unavailable", async ({
				browser,
			}) => {
				const browserContext = await browser.newContext();
				try {
					const cell = context.cell();
					const run = newRun();
					const { page } = await openProbePage(
						browserContext,
						pageUrl(cell.origin, "/", run, { sharing: "require" }),
					);
					const status = await waitForMode(page, "failed", 30_000);
					expect(STARTUP_REASONS).toContain(status.reason);
					expect(status.error?.code).toBe("sharing-unavailable");
					await page.waitForTimeout(2_000);
					expect((await wsCounters(run)).opens).toBe(0);
					context.note({ notes: [`cross-origin require: ${status.reason}`] });
				} finally {
					await browserContext.close();
				}
			});
		},
	);
}
