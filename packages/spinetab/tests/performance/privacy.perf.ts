import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { BenchWindow } from "../fixtures/harness/src/bench/types.ts";
import {
	ALL_TOPICS,
	benchRequests,
	benchState,
	ORIGIN,
	openPage,
	recordEnvironment,
	resetFixture,
	setFault,
	sleep,
	startPage,
	VARIANTS,
	waitForCounts,
} from "./lib/bench.ts";
import { attachSharedWorker, type CdpTarget, listTargets } from "./lib/cdp.ts";
import { packageRoot } from "./lib/evidence.ts";
import { withRecord } from "./lib/record.ts";
import {
	assertPositiveControl,
	type Capture,
	emptyCapture,
	noWorkerCapture,
	requireWorkerCapture,
	skipWorkerRows,
	type WorkerCapability,
	watchWorker,
	workerKeys,
	workerPositiveControl,
} from "./lib/worker-capture.ts";

// No telemetry; opt-in, payload-free diagnostics. A payload marker is seeded into every event body and a secret
// marker is the page's credentials result, sent by native `bench-auth` or
// GraphQL ConnectionInit; the fixture positively confirms both are live. Every
// diagnostic, console line, status, error, `stats()` output, SharedWorker
// target title/URL and request URL is scanned for either marker.
// Worker observation: on Chromium the
// row requires a SharedWorker CDP attach with Runtime and Network enabled and
// a positive control (the worker's own upstream WebSocket and a seeded console
// line) before any worker zero counts. Firefox and WebKit have no CDP worker
// capture: their worker rows are not measured; page-level captures still are.

type W = BenchWindow;
const harnessDist = join(packageRoot, "tests/fixtures/harness/dist");

function hits(text: string, markers: string[]): number {
	let count = 0;
	for (const marker of markers) count += text.split(marker).length - 1;
	return count;
}

/** Requests Spinetab may make: configured endpoints and harness build assets. */
function unexpectedUrl(raw: string): string | undefined {
	let url: URL;
	try {
		url = new URL(raw, ORIGIN);
	} catch {
		return raw;
	}
	if (url.protocol === "data:" || url.protocol === "blob:") return undefined;
	const origin = url.origin.replace(/^ws:/, "http:");
	if (origin !== ORIGIN) return raw;
	if (url.pathname === "/bench/ws" || url.pathname === "/bench/graphql-ws")
		return undefined;
	if (url.pathname === "/__fixture/bench/clock") return undefined;
	if (url.pathname.startsWith("/harness/")) {
		const file = url.pathname.slice("/harness/".length) || "index.html";
		return existsSync(join(harnessDist, file)) ? undefined : raw;
	}
	return raw;
}

function capture(page: Page): Capture {
	const captured = emptyCapture();
	page.on("console", (message) => {
		const location = message.location().url;
		// Ignore only the native resource error at the browser's exact icon URL.
		// Scripted console lines mentioning a favicon still count as output.
		if (
			message.type() === "error" &&
			location === `${ORIGIN}/favicon.ico` &&
			message.text().startsWith("Failed to load resource:")
		)
			return;
		captured.console.push(`${message.type()}: ${message.text()}`);
	});
	page.on("pageerror", (error) =>
		captured.console.push(`pageerror: ${error.message}`),
	);
	page.on("request", (request) => captured.requests.push(request.url()));
	page.on("websocket", (socket) => captured.requests.push(socket.url()));
	return captured;
}

for (const variant of VARIANTS) {
	for (const diagnostics of [false, true]) {
		const name = `${variant}.${diagnostics ? "on" : "off"}`;
		test(
			`privacy ${name}`,
			{
				tag: variant === "ws" ? ["@limits", "@smoke"] : ["@limits"],
			},
			async ({ browser, browserName, request }, testInfo) => {
				test.setTimeout(120_000);
				await recordEnvironment(browser, testInfo);
				await resetFixture(request);
				const run = randomUUID().slice(0, 8);
				const payload = `STPAYLOAD-${run}`;
				const secret = `STSECRET-${run}`;
				const markers = [payload, secret];
				const key = `privacy.${name}`;
				const chromium = browserName === "chromium";
				// Seeded worker console line; carries no marker.
				const control = `spinetab-privacy-control-${run}`;
				await withRecord(
					testInfo,
					{
						scenario: "privacy",
						config: name,
						expected: [
							`${key}.markers`,
							`${key}.console`,
							`${key}.network-unexpected`,
							`${key}.seed-live`,
							// Chromium only; elsewhere they stay not measured, even on failure.
							...(chromium ? workerKeys(key) : []),
						],
					},
					async (out, detail) => {
						if (!chromium) {
							skipWorkerRows(out, key, browserName);
							detail.workerCapture = {
								measured: false,
								reason: noWorkerCapture(browserName),
							};
						}
						await setFault(request, "marker", payload);
						const context = await browser.newContext();
						let worker: CdpTarget | undefined;
						let attach:
							| Awaited<ReturnType<typeof attachSharedWorker>>
							| undefined;
						try {
							const page = await openPage(context, "spinetab");
							const captured = capture(page);
							const info = await startPage(page, {
								variant,
								diagnostics,
								inspect: true,
								secret,
							});
							expect(info.mode).toBe("shared");
							if (chromium) {
								attach = await attachSharedWorker(browser, "bench.worker");
								worker = attach.target;
								const workerCapture: Record<string, unknown> = {
									measured: true,
									route: worker?.route ?? null,
									targetUrl: attach.targetInfo?.url ?? null,
									attachErrors: attach.errors,
								};
								detail.workerCapture = workerCapture;
								// Runtime.enable failure propagates and fails the row.
								let capability: WorkerCapability | undefined;
								if (worker) {
									capability = await watchWorker(worker, captured, control);
								}
								workerCapture.capability = capability ?? null;
								requireWorkerCapture(attach, capability);
								await (worker as CdpTarget).send("Runtime.evaluate", {
									expression: `console.debug(${JSON.stringify(control)})`,
								});
							}
							await page.evaluate(
								(topics) => (window as unknown as W).bench.subscribe(topics),
								ALL_TOPICS,
							);
							await waitForCounts(request, variant, 1, 100);
							await sleep(2_000);
							if (diagnostics) {
								// Error paths: hard-close the socket and let it reconnect.
								await setFault(request, "terminate");
								await waitForCounts(request, variant, 1, 100, 60_000);
								await sleep(2_000);
							}

							// The seeds must be live, or the scan proves nothing.
							const state = await benchState(request);
							const inspection = await page.evaluate(() =>
								(window as unknown as W).bench.inspect(),
							);
							const payloadLive = inspection.prefixes.some((prefix) =>
								prefix.startsWith(payload),
							);
							const secretLive = state.counters.authTokens.includes(secret);
							out.put(`${key}.seed-live`, payloadLive && secretLive ? 1 : 0);

							const pageDiagnostics = await page.evaluate(() =>
								(window as unknown as W).bench.diagnostics(),
							);
							const texts: Record<string, string> = {
								diagnostics: JSON.stringify(pageDiagnostics),
								console: captured.console.join("\n"),
								statuses: JSON.stringify(
									await page.evaluate(() =>
										(window as unknown as W).bench.statusHistory(),
									),
								),
								subscriptions: JSON.stringify(
									await page.evaluate(() => {
										const summary = (window as unknown as W).bench.summary();
										return {
											continuity: summary.continuity,
											errors: summary.errors,
											connection: summary.connection,
										};
									}),
								),
								errors: JSON.stringify(
									await page.evaluate(() =>
										(window as unknown as W).bench.pageErrors(),
									),
								),
								stats: JSON.stringify(
									(
										await page.evaluate(() =>
											(window as unknown as W).bench.realm("stats"),
										)
									).value,
								),
								urls: captured.requests.join("\n"),
							};
							// Worker sources exist only where the worker is observable.
							const workerTexts: Record<string, string> = {};
							if (chromium) {
								// Before any worker zero is trusted.
								const positive = workerPositiveControl(
									variant,
									captured,
									ORIGIN,
									true,
								);
								detail.workerPositiveControl = positive;
								assertPositiveControl(positive);
								workerTexts.workerConsole = captured.workerConsole.join("\n");
								workerTexts.workerUrls = captured.workerRequests.join("\n");
								const session = await browser.newBrowserCDPSession();
								const targets = await listTargets(session);
								await session.detach();
								workerTexts.workerTargets = JSON.stringify(
									targets
										.filter((target) => target.type === "shared_worker")
										.map((target) => ({
											title: target.title,
											url: target.url,
										})),
								);
							}
							const perSource: Record<string, number> = {};
							let total = 0;
							let workerHits = 0;
							for (const [source, text] of Object.entries(texts)) {
								perSource[source] = hits(text, markers);
								total += perSource[source];
							}
							for (const [source, text] of Object.entries(workerTexts)) {
								perSource[source] = hits(text, markers);
								total += perSource[source];
								workerHits += perSource[source];
							}
							detail.markerHits = perSource;
							detail.coverage = chromium
								? "page and worker"
								: `page only; worker ${noWorkerCapture(browserName)}`;
							detail.diagnosticEvents = pageDiagnostics.length;
							detail.diagnosticTypes = [
								...new Set(
									(pageDiagnostics as Array<{ type?: string }>).map(
										(event) => event.type,
									),
								),
							];
							out.put(`${key}.markers`, total);
							out.put(
								`${key}.console`,
								captured.console.length + captured.workerConsole.length,
							);
							out.put(`${key}.events`, pageDiagnostics.length);
							if (chromium) {
								out.put(`${key}.worker-markers`, workerHits);
								out.put(`${key}.worker-console`, captured.workerConsole.length);
							}

							// Network: page, worker (CDP) and fixture-observed requests.
							const fixtureRequests = await benchRequests(request);
							// Plain HTML also triggers this browser-owned icon request.
							// Keep scripted fetches (dest: "empty") and worker requests strict.
							const browserIcons = fixtureRequests.filter(
								(entry) =>
									entry.url === "/favicon.ico" && entry.dest === "image",
							);
							detail.browserIconRequests = browserIcons;
							const fixture = fixtureRequests
								.filter((entry) => !browserIcons.includes(entry))
								.filter(
									(entry) =>
										!(
											entry.url.startsWith("/__fixture/") && entry.dest === null
										),
								)
								.map((entry) => entry.url);
							const unexpected = [
								...captured.requests,
								...captured.workerRequests,
								...fixture,
							]
								.map(unexpectedUrl)
								.filter((url): url is string => url !== undefined);
							detail.unexpectedUrls = [...new Set(unexpected)];
							out.put(`${key}.network-unexpected`, unexpected.length);
							if (chromium) {
								const workerUnexpected = captured.workerRequests
									.map(unexpectedUrl)
									.filter((url): url is string => url !== undefined);
								detail.workerNetworkEvents = captured.workerNetwork;
								out.put(
									`${key}.worker-network-unexpected`,
									workerUnexpected.length,
								);
							}
							detail.console = captured.console;

							expect(payloadLive && secretLive, "seeded markers are live").toBe(
								true,
							);
							expect(total, `marker hits ${JSON.stringify(perSource)}`).toBe(0);
							expect(
								unexpected,
								"no request beyond configured endpoints",
							).toEqual([]);
							if (!diagnostics) {
								expect(
									pageDiagnostics.length,
									"diagnostics are off by default",
								).toBe(0);
								expect(captured.console, "no console output").toEqual([]);
							} else {
								expect(
									pageDiagnostics.length,
									"diagnostics were produced",
								).toBeGreaterThan(0);
							}
						} finally {
							await worker?.detach().catch(() => {});
							await attach?.browserSession.detach().catch(() => {});
							await context.close();
							await setFault(request, "marker", false);
						}
					},
				);
			},
		);
	}
}
