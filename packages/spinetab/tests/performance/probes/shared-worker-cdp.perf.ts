import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { BenchWindow } from "../../fixtures/harness/src/bench/types.ts";
import {
	openPage,
	recordEnvironment,
	resetFixture,
	sleep,
	startPage,
	waitForCounts,
} from "../lib/bench.ts";
import {
	attachNonFlat,
	attachViaPort,
	type CdpTarget,
	listTargets,
	pageTarget,
	processCpu,
} from "../lib/cdp.ts";
import { rawDir, writeJson } from "../lib/evidence.ts";
import { workerEventsObserved } from "../lib/worker-capture.ts";

// Require positive worker console and network controls before accepting zero-count privacy observations.

type W = BenchWindow;

async function attempt<T>(
	record: Record<string, unknown>,
	key: string,
	fn: () => Promise<T>,
): Promise<T | undefined> {
	try {
		const value = await fn();
		record[key] = { ok: true, value };
		return value;
	} catch (error) {
		record[key] = { ok: false, error: (error as Error).message };
		return undefined;
	}
}

async function exercise(worker: CdpTarget, record: Record<string, unknown>) {
	await attempt(record, "getIsolateId", () =>
		worker.send("Runtime.getIsolateId"),
	);
	await attempt(record, "collectGarbage", () =>
		worker.send("HeapProfiler.collectGarbage"),
	);
	await attempt(record, "getHeapUsage", () =>
		worker.send("Runtime.getHeapUsage"),
	);
	await attempt(record, "performanceMetrics", async () => {
		await worker.send("Performance.enable", { timeDomain: "threadTicks" });
		const { metrics } = await worker.send<{
			metrics: Array<{ name: string; value: number }>;
		}>("Performance.getMetrics");
		return metrics.map((metric) => metric.name);
	});
	await attempt(record, "profiler", async () => {
		await worker.send("Profiler.enable");
		await worker.send("Profiler.setSamplingInterval", { interval: 1_000 });
		await worker.send("Profiler.start");
		await sleep(500);
		const { profile } = await worker.send<{
			profile: { samples?: number[] };
		}>("Profiler.stop");
		await worker.send("Profiler.disable");
		return { samples: profile.samples?.length ?? 0 };
	});
	await attempt(record, "consoleEvents", async () => {
		const seen: string[] = [];
		const off = worker.on("Runtime.consoleAPICalled", (params) => {
			seen.push(String(params.type));
		});
		await worker.send("Runtime.enable");
		await worker.send("Runtime.evaluate", {
			expression: "console.debug('spinetab-cdp-probe')",
		});
		await sleep(250);
		off();
		return { received: seen.length };
	});
	await attempt(record, "networkEvents", async () => {
		const urls: string[] = [];
		const off = worker.on("Network.requestWillBeSent", (params) => {
			urls.push(String(params.request?.url ?? ""));
		});
		await worker.send("Network.enable");
		await worker.send("Runtime.evaluate", {
			expression: "fetch('/__fixture/bench/clock').then(() => 1)",
			awaitPromise: true,
		});
		await sleep(250);
		off();
		await worker.send("Network.disable");
		return { received: urls.length, urls };
	});
}

test(
	"SharedWorker CDP reach",
	{ tag: ["@probe", "@smoke"] },
	async ({ browser, browserName, request }, testInfo) => {
		test.skip(browserName !== "chromium", "CDP probe is Chromium-only");
		test.setTimeout(120_000);
		await recordEnvironment(browser, testInfo);
		await resetFixture(request);

		const context = await browser.newContext();
		const record: Record<string, unknown> = {
			schema: 1,
			browser: browser.version(),
		};
		try {
			const first = await openPage(context, "spinetab");
			const second = await openPage(context, "spinetab");
			for (const page of [first, second]) {
				const info = await startPage(page, { variant: "ws" });
				expect(info.mode, "bench page must run shared").toBe("shared");
			}
			await first.evaluate(
				(topics) => (window as unknown as W).bench.subscribe(topics),
				[0, 1, 2, 3, 4],
			);
			await waitForCounts(request, "ws", 1, 5);
			const infos = await Promise.all(
				[first, second].map((page) =>
					page.evaluate(() => (window as unknown as W).bench.info()),
				),
			);
			record.runtimeIds = infos.map((info) => info.runtimeId);
			expect(new Set(record.runtimeIds as string[]).size).toBe(1);
			record.pageResolution = infos.map((info) => info.resolution);

			const browserSession = await browser.newBrowserCDPSession();
			const targets = await listTargets(browserSession);
			record.targetTypes = targets.map((target) => ({
				type: target.type,
				url: target.url,
				attached: target.attached,
			}));
			const workerInfo = targets.find(
				(target) =>
					target.type === "shared_worker" &&
					target.url.includes("bench.worker"),
			);
			record.sharedWorkerFound = Boolean(workerInfo);

			await attempt(record, "systemInfoProcesses", async () => {
				const cpu = await processCpu(browserSession);
				return { types: Object.keys(cpu.byType), count: cpu.processes.length };
			});

			const routes: Record<string, Record<string, unknown>> = {};
			record.routes = routes;
			if (workerInfo) {
				const nonFlat: Record<string, unknown> = {};
				routes["non-flat"] = nonFlat;
				const worker = await attempt(nonFlat, "attach", () =>
					attachNonFlat(browserSession, workerInfo.targetId, "worker"),
				);
				if (worker) {
					nonFlat.attach = { ok: true };
					await exercise(worker, nonFlat);
					await worker.detach();
				}
				const port = Number(process.env.SPINETAB_PERF_CDP_PORT);
				const viaPort: Record<string, unknown> = {};
				routes.port = viaPort;
				if (Number.isInteger(port) && port > 0) {
					const target = await attempt(viaPort, "attach", () =>
						attachViaPort(port, "bench.worker", "worker"),
					);
					if (target) {
						viaPort.attach = { ok: true };
						await exercise(target, viaPort);
						await target.detach();
					}
				} else {
					viaPort.attach = {
						ok: false,
						error: "SPINETAB_PERF_CDP_PORT not set",
					};
				}
			}

			// Page side: metric names and whether the two tabs share an isolate.
			const pageRecord: Record<string, unknown> = {};
			record.page = pageRecord;
			const pages = [
				await pageTarget(first, "page-0"),
				await pageTarget(second, "page-1"),
			];
			await attempt(pageRecord, "metricNames", async () => {
				await pages[0]?.send("Performance.enable", {
					timeDomain: "threadTicks",
				});
				const { metrics } = await (pages[0] as CdpTarget).send<{
					metrics: Array<{ name: string }>;
				}>("Performance.getMetrics");
				return metrics.map((metric) => metric.name);
			});
			await attempt(pageRecord, "isolates", async () => {
				const ids = [];
				for (const target of pages) {
					ids.push(
						(await target.send<{ id: string }>("Runtime.getIsolateId")).id,
					);
				}
				return { ids, shared: new Set(ids).size < ids.length };
			});
			for (const target of pages) await target.detach();
			await browserSession.detach();

			// Worker observability: routes whose console and
			// network attempts succeeded, the network one including its own fetch.
			const observing = Object.entries(routes)
				.filter(([, route]) => workerEventsObserved(route))
				.map(([name]) => name);
			record.workerEventRoutes = observing;

			const path = join(rawDir(), "probe.json");
			writeJson(path, record);
			await testInfo.attach("probe.json", {
				path,
				contentType: "application/json",
			});

			// Gate: at least one route answers the three heap commands.
			const answered = Object.values(routes).some((route) =>
				["getIsolateId", "collectGarbage", "getHeapUsage"].every(
					(key) => (route[key] as { ok?: boolean } | undefined)?.ok === true,
				),
			);
			expect(record.sharedWorkerFound, "shared_worker target found").toBe(true);
			expect(
				answered,
				`no CDP route reached the SharedWorker: ${JSON.stringify(routes)}`,
			).toBe(true);
			expect(
				observing.length,
				`no CDP route delivered worker console and network events: ${JSON.stringify(
					Object.fromEntries(
						Object.entries(routes).map(([name, route]) => [
							name,
							{
								consoleEvents: route.consoleEvents,
								networkEvents: route.networkEvents,
							},
						]),
					),
				)}`,
			).toBeGreaterThan(0);
		} finally {
			await context.close();
		}
	},
);
