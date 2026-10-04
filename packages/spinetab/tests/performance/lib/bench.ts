import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
	APIRequestContext,
	Browser,
	BrowserContext,
	Page,
	TestInfo,
} from "@playwright/test";
import type {
	BenchApi,
	BenchWindow,
	PageInfo,
	StartOptions,
	Variant,
} from "../../fixtures/harness/src/bench/types.ts";
import { calibrate, checkCalibration } from "./clock.ts";
import { ensureEnvironment } from "./environment.ts";
import { packageRoot, profile } from "./evidence.ts";

/**
 * Playwright-side helpers for the performance scenarios: fixture control,
 * page lifecycle, waiting and calibration. The fixture runs on 4500 (never
 * alongside `e2e`).
 */

export const ORIGIN = "http://127.0.0.1:4500";
export const ALL_TOPICS = Array.from({ length: 100 }, (_, index) => index);
export const VARIANTS: Variant[] = ["graphql-ws", "ws"];
export type { BenchApi, PageInfo, Variant };

export const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Profile-dependent sizes. */
export function settings() {
	const smoke = profile() === "smoke";
	return {
		smoke,
		tabs: smoke ? [1, 5] : [1, 5, 20],
		functionalTabs: [1, 5],
		warmupMs: smoke ? 3_000 : 10_000,
		windowMs: smoke ? 10_000 : 30_000,
		discardMs: 5_000,
		warmupBatches: smoke ? 2 : 10,
		cycleBatches: smoke ? 10 : 100,
		returnTrials: smoke ? 1 : 2,
		historyMs: 5 * 60_000,
		calibrationSamples: 200,
	};
}

export interface BenchCounters {
	connections: number;
	activeConnections: number;
	subscriptions: number;
	activeSubscriptions: number;
	activeTopics: number;
	byEndpoint: Record<
		Variant,
		{
			connections: number;
			activeConnections: number;
			subscriptions: number;
			activeSubscriptions: number;
			activeTopics: number;
		}
	>;
	emitted: number;
	wireMessages: number;
	wireBytes: number;
	droppedFrames: number;
	serverDrops: number;
	maxLagMs: number;
	lateTicks: number;
	stalls: number;
	terminated: number;
	commands: number;
	acksSent: number;
	heldAcks: number;
	auths: number;
	authTokens: string[];
	requests: number;
	cpuUsage: { user: number; system: number };
	schedulerRunning: boolean;
}

export interface BenchState {
	counters: BenchCounters;
	seqs: Record<string, number>;
}

async function ok(response: Awaited<ReturnType<APIRequestContext["get"]>>) {
	if (!response.ok()) {
		throw new Error(
			`fixture ${response.url()} → ${response.status()} ${await response.text()}`,
		);
	}
	return response.json();
}

export async function resetFixture(request: APIRequestContext): Promise<void> {
	await ok(await request.post(`${ORIGIN}/__fixture/reset`));
}

/** GET the bench state; this also applies pending bench faults. */
export async function benchState(
	request: APIRequestContext,
): Promise<BenchState> {
	return (await ok(
		await request.get(`${ORIGIN}/__fixture/bench/state`),
	)) as BenchState;
}

export async function setFault(
	request: APIRequestContext,
	action: string,
	value: unknown = true,
): Promise<BenchState> {
	await ok(
		await request.post(`${ORIGIN}/__fixture/fault`, {
			data: { target: "bench", action, value },
		}),
	);
	return benchState(request);
}

export const clearFault = (request: APIRequestContext, action: string) =>
	setFault(request, action, false);

export async function benchRequests(request: APIRequestContext) {
	return (
		(await ok(await request.get(`${ORIGIN}/__fixture/bench/requests`))) as {
			requests: Array<{
				method: string;
				url: string;
				dest: string | null;
				upgrade: boolean;
				at: number;
			}>;
		}
	).requests;
}

/** Poll until `predicate` holds; the error names what was awaited. */
export async function waitFor<T>(
	read: () => Promise<T>,
	predicate: (value: T) => boolean,
	message: string,
	timeoutMs = 30_000,
	intervalMs = 100,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let last: T = await read();
	while (!predicate(last)) {
		if (Date.now() > deadline) {
			throw new Error(
				`Timed out after ${timeoutMs} ms waiting for ${message}; last value ${JSON.stringify(last).slice(0, 2_000)}`,
			);
		}
		await sleep(intervalMs);
		last = await read();
	}
	return last;
}

export async function waitForCounts(
	request: APIRequestContext,
	variant: Variant,
	connections: number,
	subscriptions: number,
	timeoutMs = 60_000,
): Promise<BenchState> {
	return waitFor(
		() => benchState(request),
		(state) => {
			const endpoint = state.counters.byEndpoint[variant];
			return (
				endpoint.activeConnections === connections &&
				endpoint.activeSubscriptions === subscriptions
			);
		},
		`${variant} activeConnections=${connections}, activeSubscriptions=${subscriptions}`,
		timeoutMs,
	);
}

export type PageKind = "spinetab" | "independent" | "noop" | "empty";

const pagePath: Record<PageKind, string> = {
	spinetab: "/harness/bench.html",
	independent: "/harness/baseline.html",
	noop: "/harness/noop-worker.html?worker=1",
	empty: "/harness/noop-worker.html",
};

export async function openPage(
	context: BrowserContext,
	kind: PageKind,
): Promise<Page> {
	const page = await context.newPage();
	await page.goto(`${ORIGIN}${pagePath[kind]}`);
	await page.waitForFunction(
		() => (window as unknown as { bench?: { ready?: boolean } }).bench?.ready,
	);
	return page;
}

export const now = (page: Page) =>
	page.evaluate(() => performance.timeOrigin + performance.now());

export async function startPage(
	page: Page,
	options: StartOptions,
): Promise<PageInfo> {
	return page.evaluate(
		(value) => (window as unknown as BenchWindow).bench.start(value),
		options,
	);
}

/** Record the browser and refuse a loaded machine in the pinned profile. */
export async function recordEnvironment(
	browser: Browser,
	testInfo: TestInfo,
): Promise<void> {
	let commandLine: string[] | null = null;
	if (browser.browserType().name() === "chromium") {
		const session = await browser.newBrowserCDPSession();
		try {
			const info = (await (
				session.send as unknown as (method: string) => Promise<{
					commandLine?: string;
				}>
			)("SystemInfo.getInfo")) as { commandLine?: string };
			commandLine = info.commandLine ? info.commandLine.split(" ") : null;
		} catch {
			commandLine = null;
		} finally {
			await session.detach();
		}
	}
	ensureEnvironment(
		{
			name: browser.browserType().name(),
			version: browser.version(),
			headless: testInfo.project.use.headless !== false,
			commandLine,
		},
		testInfo.project.name,
	);
}

/** Page ↔ runtime realm calibration before/after a window. */
export async function calibrateRealm(page: Page, samples: number) {
	const raw = await page.evaluate(
		(count) => (window as unknown as BenchWindow).bench.calibrate(count, 5),
		samples,
	);
	return calibrate(raw);
}

export async function calibrateServer(page: Page, samples = 50) {
	const raw = await page.evaluate(
		(count) =>
			(window as unknown as BenchWindow).bench.calibrateServer(count, 5),
		samples,
	);
	return calibrate(raw);
}

export { calibrate, checkCalibration };

/**
 * Class names declared in the library source: heap-snapshot constructors a
 * Spinetab leak would show (the harness build is unminified).
 */
export function spinetabClassNames(): Set<string> {
	const names = new Set<string>();
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir)) {
			const path = join(dir, entry);
			if (statSync(path).isDirectory()) walk(path);
			else if (path.endsWith(".ts")) {
				for (const match of readFileSync(path, "utf8").matchAll(
					/\bclass\s+([A-Z][A-Za-z0-9_]*)/g,
				)) {
					names.add(match[1] as string);
				}
			}
		}
	};
	walk(join(packageRoot, "src"));
	return names;
}
