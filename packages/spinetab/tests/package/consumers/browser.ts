import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
	type Browser,
	type BrowserContext,
	expect,
	type Page,
	type TestInfo,
	test,
} from "@playwright/test";
import {
	appRoot,
	type Bundler,
	consumer,
	type Mode,
	type Proof,
	SPINETAB_PEERS,
} from "./catalogue.ts";
import type { FrontLog, FrontOptions } from "./front.ts";
import {
	devTextLocalPaths,
	localPathsIn,
	spinetabDevModules,
} from "./generated.ts";
import { type IsolationReport, listChunks } from "./inspect.ts";
import { type RunningCell, startCell } from "./launch.ts";
import type { MatrixRecord } from "./matrix.ts";
import {
	consumerDir,
	consumerRunId,
	evidenceDir,
	matrixDir,
	reportsDir,
} from "./paths.ts";
import { assertFreshPack, type PackRecord } from "./prepare.ts";
import { namesChunk, requestsFor } from "./requests.ts";
import { installedVersion } from "./run.ts";

/**
 * Shared driving for the packed-consumer Playwright cells. Every cell opens two pages in one context, reads `window.__consumer`,
 * the fixture's per-run counters and the front log, and writes one matrix
 * record.
 */

export const FIXTURE = "http://127.0.0.1:4500";

export interface ConsumerStatus {
	mode: string;
	reason?: string;
	health: string;
	runtimeId?: string;
	generation: number;
	error?: { code: string; message: string; detail?: unknown };
}

export interface ConsumerProbe {
	status(): ConsumerStatus;
	events: unknown[];
	clients: number;
	endpoint: string;
	run: string;
	errors: Array<{ code: string; message: string }>;
	firstRender?: string;
	extra?: Record<string, unknown>;
}

declare global {
	interface Window {
		__consumer?: ConsumerProbe;
		__violations?: Array<{ directive: string; blocked: string }>;
	}
}

export {
	chunkRequests,
	namesChunk,
	type RequestRealm,
	requestRealm,
	requestsFor,
} from "./requests.ts";

export const newRun = () => randomUUID();

/** The candidate, checked against the current dist (stale-pack guard). */
export function candidate(stage: string): PackRecord {
	return assertFreshPack(stage);
}

export function runId(record: PackRecord): string {
	return process.env.SPINETAB_CONSUMERS_RUN_ID ?? record.distHash.slice(0, 12);
}

export function cellEvidence(
	record: PackRecord,
	cell: string,
	project?: string,
): string {
	const dir = join(evidenceDir(runId(record)), cell, project ?? "");
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** Counts CSP violations and page errors from the first script onwards. */
export async function openProbePage(
	context: BrowserContext,
	url: string,
): Promise<{ page: Page; pageErrors: string[]; consoleErrors: string[] }> {
	const page = await context.newPage();
	const pageErrors: string[] = [];
	const consoleErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") consoleErrors.push(message.text());
	});
	await page.addInitScript(() => {
		window.__violations = [];
		document.addEventListener("securitypolicyviolation", (event) => {
			window.__violations?.push({
				directive: event.effectiveDirective,
				blocked: event.blockedURI,
			});
		});
	});
	await page.goto(url);
	return { page, pageErrors, consoleErrors };
}

export async function status(page: Page): Promise<ConsumerStatus | null> {
	return page.evaluate(() => window.__consumer?.status() ?? null);
}

export async function eventCount(page: Page): Promise<number> {
	return page.evaluate(() => window.__consumer?.events.length ?? 0);
}

export async function violations(page: Page) {
	return page.evaluate(() => window.__violations ?? []);
}

export async function waitForMode(
	page: Page,
	mode: string,
	timeout = 30_000,
): Promise<ConsumerStatus> {
	await expect
		.poll(async () => (await status(page))?.mode, { timeout })
		.toBe(mode);
	return (await status(page)) as ConsumerStatus;
}

export async function waitForEvents(
	page: Page,
	count: number,
	timeout = 30_000,
): Promise<void> {
	await expect
		.poll(() => eventCount(page), { timeout })
		.toBeGreaterThanOrEqual(count);
}

export async function fixtureJson<T>(path: string): Promise<T> {
	const response = await fetch(`${FIXTURE}${path}`);
	if (!response.ok) throw new Error(`${path}: ${response.status}`);
	return (await response.json()) as T;
}

export interface SseCounters {
	streams: number;
	active: number;
	/** Per request: `Last-Event-ID` header and `?lastEventId=` query cursor. */
	requests: Array<{
		method: string;
		lastEventId: string | null;
		lastEventIdQuery?: string | null;
	}>;
}
export interface WsCounters {
	opens: number;
	active: number;
	byScope: Record<string, number>;
	urls: string[];
}
export interface GraphqlWsCounters {
	connections: number;
	active: number;
	subscriptions: number;
	activeSubscriptions: number;
}
export interface PollingCounters {
	requests: number;
	inFlight: number;
	maxInFlight: number;
}

export const sseCounters = (run: string) =>
	fixtureJson<SseCounters>(`/sse/counters?run=${encodeURIComponent(run)}`);
export const wsCounters = (run: string) =>
	fixtureJson<WsCounters>(`/ws/counters?run=${encodeURIComponent(run)}`);
export const streamCounters = (run: string) =>
	fixtureJson<{
		requests: Record<string, number>;
		starts: number;
		active: number;
		completed: number;
	}>(`/stream/counters?run=${encodeURIComponent(run)}`);

export async function graphqlWsCounters(
	tag: string,
): Promise<GraphqlWsCounters> {
	const all = await fixtureJson<{
		"graphql-ws"?: { tags?: Record<string, GraphqlWsCounters> };
	}>("/__fixture/counters");
	return (
		all["graphql-ws"]?.tags?.[tag] ?? {
			connections: 0,
			active: 0,
			subscriptions: 0,
			activeSubscriptions: 0,
		}
	);
}

export async function pollingCounters(id: string): Promise<PollingCounters> {
	const all = await fixtureJson<{
		polling?: { byId?: Record<string, PollingCounters> };
	}>("/__fixture/counters");
	return (
		all.polling?.byId?.[id] ?? { requests: 0, inFlight: 0, maxInFlight: 0 }
	);
}

/** Proxied requests whose path contains `fragment` (e.g. `sse/ticks?run=<id>`). */
export function proxiedCount(log: FrontLog, fragment: string): number {
	return Object.entries(log.proxied)
		.filter(([path]) => path.includes(fragment))
		.reduce((sum, [, count]) => sum + count, 0);
}

/** Base names of emitted files, as the front server matches them. */
export const baseNames = (files: readonly string[]) =>
	files.map((file) => file.split("/").pop() as string);

/** Bytes of application assets served (not proxied data, not controls). */
export function downloadedBytes(log: FrontLog): number {
	return log.requests
		.filter(
			(request) =>
				!request.path.includes("/fx/") &&
				!request.path.startsWith("/__front") &&
				request.method !== "UPGRADE",
		)
		.reduce((sum, request) => sum + request.bytes, 0);
}

/** `modulepreload`/`prefetch`/`preload` links naming any of the files. */
export async function preloadsFor(
	page: Page,
	files: readonly string[],
): Promise<string[]> {
	const hrefs = await page.evaluate(() =>
		[
			...document.querySelectorAll(
				'link[rel="modulepreload"], link[rel="prefetch"], link[rel="preload"]',
			),
		].map((link) => (link as HTMLLinkElement).href),
	);
	return hrefs.filter((href) =>
		files.some((file) => namesChunk(new URL(href).pathname, file)),
	);
}

export function isolationReport(
	name: string,
	bundler: string,
	variant: string,
): IsolationReport | null {
	const path = join(reportsDir(name), `isolation-${bundler}-${variant}.json`);
	return existsSync(path)
		? (JSON.parse(readFileSync(path, "utf8")) as IsolationReport)
		: null;
}

export interface BuildReport {
	consumer: string;
	bundler: string;
	variant: string;
	out: string;
	command: string[];
	env: Record<string, string>;
	worker: string[];
	fallback: string[];
	page: string[];
	sizes: IsolationReport["sizes"];
}

export function buildReport(
	name: string,
	bundler: string,
	variant: string,
): BuildReport {
	const path = join(reportsDir(name), `build-${bundler}-${variant}.json`);
	if (!existsSync(path)) {
		throw new Error(
			`${path} is missing: run the consumers Vitest stage (pnpm test:consumers) first.`,
		);
	}
	return JSON.parse(readFileSync(path, "utf8")) as BuildReport;
}

/** Installed peer versions for the matrix (`absent` when not installed). */
export function peerVersions(name: string): MatrixRecord["peers"] {
	const spec = consumer(name);
	return SPINETAB_PEERS.filter(
		(peer) =>
			spec.peers.includes(peer) || spec.upstreamInstalled.includes(peer),
	).map((peer) => ({
		name: peer,
		version: installedVersion(appRoot(spec, consumerDir(name)), peer) ?? null,
		// Every manifest range is `^<pinned>`, so the pinned cell is the minimum.
		min: true,
	}));
}

const BUNDLER_PACKAGES: Record<Bundler, string> = {
	vite: "vite",
	webpack: "webpack",
	rspack: "@rspack/core",
	next: "next",
	"next-webpack": "next",
	astro: "astro",
};

export interface MatrixInput {
	testInfo: TestInfo;
	browser: Browser;
	record: PackRecord;
	cell: string;
	consumer: string;
	bundler: Bundler;
	mode: Mode;
	variant: string;
	build: string[] | null;
	serve: string[];
	env: Record<string, string>;
	emitted: IsolationReport["sizes"];
	downloaded: Record<string, number>;
	pass: boolean;
	blocked?: string | null;
	counters: unknown;
	notes?: string[];
}

export function writeMatrixRecord(input: MatrixInput): MatrixRecord {
	const dir = matrixDir();
	mkdirSync(dir, { recursive: true });
	const treeShaking: MatrixRecord["treeShaking"] =
		(input.bundler === "next" || input.bundler === "next-webpack") &&
		input.mode === "prod"
			? "not-disableable"
			: input.variant === "no-treeshake" || input.mode === "dev"
				? "off"
				: "on";
	const matrix: MatrixRecord = {
		runId: consumerRunId(),
		cell: input.cell,
		project: input.testInfo.project.name,
		consumer: input.consumer,
		bundler: {
			name: input.bundler,
			version:
				installedVersion(
					appRoot(consumer(input.consumer), consumerDir(input.consumer)),
					BUNDLER_PACKAGES[input.bundler],
				) ?? null,
		},
		mode: input.mode,
		variant: input.variant,
		browser: {
			name: input.browser.browserType().name(),
			version: input.browser.version(),
		},
		peers: peerVersions(input.consumer),
		candidate: {
			sha256: input.record.sha256,
			distHash: input.record.distHash,
			gitHead: input.record.gitHead,
			dirty: input.record.dirty,
			sourceHash: input.record.sourceHash,
		},
		command: { build: input.build, serve: input.serve, env: input.env },
		evidence: cellEvidence(
			input.record,
			input.cell,
			input.testInfo.project.name,
		),
		sizes: { emitted: input.emitted, downloaded: input.downloaded },
		treeShaking,
		pass: input.pass,
		blocked: input.blocked ?? null,
		counters: input.counters,
		notes: input.notes ?? [],
	};
	writeFileSync(
		join(dir, `${input.testInfo.project.name}-${input.cell}.json`),
		`${JSON.stringify(matrix, null, "\t")}\n`,
	);
	return matrix;
}

export function writeEvidence(
	record: PackRecord,
	cell: string,
	name: string,
	value: unknown,
): void {
	writeFileSync(
		join(cellEvidence(record, cell), name),
		typeof value === "string"
			? value
			: `${JSON.stringify(value, null, "\t")}\n`,
	);
}

/* Cells */

export interface CellDefinition {
	id: string;
	consumer: string;
	bundler: Bundler;
	mode: Mode;
	variant: string;
	frontPort: number;
	upstreamPort?: number;
	/** Production output relative to the consumer (static cells). */
	out?: string;
	/** Next build directory for `next start`. */
	distDir?: string;
	env?: Record<string, string>;
	front?: Omit<FrontOptions, "port" | "static" | "upstream">;
	/** Build report used for fallback and worker file names and sizes. */
	report?: { bundler: string; variant: string } | null;
	readyPath?: string;
	/** Skip reason (recorded as a blocked matrix cell). */
	blocked?: string;
	/** Worker files get the worker CSP by name when `Sec-Fetch-Dest` is absent. */
	workerCspByName?: boolean;
	/** Run the Next CLI from the workspace root: `next dev apps/web`. */
	fromRoot?: boolean;
	/** Front options that need the build report (faults on emitted files). */
	frontFromReport?: (
		report: BuildReport,
	) => Omit<FrontOptions, "port" | "static" | "upstream">;
}

export interface CellContext {
	cell(): RunningCell;
	record(): PackRecord;
	report(): BuildReport | null;
	evidence(): string;
	/** Merge counters, downloaded bytes and notes into the matrix record. */
	note(update: {
		counters?: unknown;
		downloaded?: Record<string, number>;
		notes?: string[];
	}): void;
}

/**
 * One serial cell: `beforeAll` starts it, `afterAll` stops it, and every test
 * writes its matrix record (pass or fail) in `afterEach`.
 */
export function describeCell(
	definition: CellDefinition,
	body: (context: CellContext) => void,
): void {
	test.describe
		.serial(definition.id, {
			annotation: { type: "consumer-cell", description: definition.id },
		}, () => {
			let running: RunningCell | undefined;
			let pack: PackRecord | undefined;
			let build: BuildReport | null = null;
			let project: string | undefined;
			let pass = true;
			const collected: {
				counters: Record<string, unknown>;
				downloaded: Record<string, number>;
				notes: string[];
			} = { counters: {}, downloaded: {}, notes: [] };

			test.beforeAll(async ({ browser }, testInfo) => {
				if (process.env.SPINETAB_CONSUMERS_EXECUTION_ERROR)
					throw new Error(process.env.SPINETAB_CONSUMERS_EXECUTION_ERROR);
				project = testInfo.project.name;
				// Dev servers and `next dev` compile on first request.
				testInfo.setTimeout(300_000);
				pack = candidate(`e2e:${definition.id}`);
				if (definition.blocked) {
					writeMatrixRecord({
						testInfo,
						browser,
						record: pack,
						cell: definition.id,
						consumer: definition.consumer,
						bundler: definition.bundler,
						mode: definition.mode,
						variant: definition.variant,
						build: null,
						serve: [],
						env: definition.env ?? {},
						emitted: {},
						downloaded: {},
						pass: false,
						blocked: definition.blocked,
						counters: {},
					});
				}
				test.skip(Boolean(definition.blocked), definition.blocked);
				build =
					definition.report === null
						? null
						: buildReport(
								definition.consumer,
								definition.report?.bundler ?? definition.bundler,
								definition.report?.variant ?? definition.variant,
							);
				const workerFiles =
					definition.workerCspByName === false ? [] : (build?.worker ?? []);
				running = await startCell({
					id: definition.id,
					consumer: definition.consumer,
					bundler: definition.bundler,
					mode: definition.mode,
					frontPort: definition.frontPort,
					...(definition.upstreamPort === undefined
						? {}
						: { upstreamPort: definition.upstreamPort }),
					...(definition.out === undefined ? {} : { out: definition.out }),
					...(definition.distDir === undefined
						? {}
						: { distDir: definition.distDir }),
					...(definition.env === undefined ? {} : { env: definition.env }),
					...(definition.readyPath === undefined
						? {}
						: { readyPath: definition.readyPath }),
					...(definition.fromRoot ? { fromRoot: true } : {}),
					front: {
						...definition.front,
						...(build && definition.frontFromReport
							? definition.frontFromReport(build)
							: {}),
						workerFiles: [
							...(definition.front?.workerFiles ?? []),
							...workerFiles.map((file) => file.split("/").pop() as string),
						],
					},
					evidence: cellEvidence(pack, definition.id, project),
				});
			});

			test.afterEach(async ({ browser }, testInfo) => {
				if (!pack || testInfo.status === "skipped") return;
				pass &&= Boolean(running) && testInfo.status === "passed";
				writeEvidence(
					pack,
					`${definition.id}/${testInfo.project.name}`,
					`front-log-${testInfo.testId}-${testInfo.retry}.json`,
					running?.log() ?? [],
				);
				writeMatrixRecord({
					testInfo,
					browser,
					record: pack,
					cell: definition.id,
					consumer: definition.consumer,
					bundler: definition.bundler,
					mode: definition.mode,
					variant: definition.variant,
					build: build?.command ?? null,
					serve: running?.command ?? [],
					env: { ...definition.env, ...running?.env },
					emitted: build?.sizes ?? {},
					downloaded: collected.downloaded,
					pass,
					blocked: definition.blocked ?? null,
					counters: collected.counters,
					notes: collected.notes,
				});
			});

			test.afterAll(async () => {
				await running?.stop();
			});

			body({
				cell: () => {
					if (!running) throw new Error(`${definition.id} is not running`);
					return running;
				},
				record: () => {
					if (!pack) throw new Error("no candidate");
					return pack;
				},
				report: () => build,
				evidence: () =>
					cellEvidence(
						candidate(`e2e:${definition.id}`),
						definition.id,
						project,
					),
				note: (update) => {
					if (update.counters) {
						Object.assign(collected.counters, update.counters as object);
					}
					if (update.downloaded)
						Object.assign(collected.downloaded, update.downloaded);
					if (update.notes) collected.notes.push(...update.notes);
				},
			});
		});
}

/* Proof of shared mode */

export interface PairOptions {
	context: BrowserContext;
	cell: RunningCell;
	/** Page path below the origin, e.g. `/` or `/app/`. */
	path: string;
	run: string;
	proof: Proof;
	mode: Mode;
	/** Fallback chunk names from the build report (never fetched when shared). */
	fallback: readonly string[];
	/** Extra query parameters. */
	query?: Record<string, string>;
	/** WebSocket `scope` query value (ws proof). */
	scope?: string;
	/** Front mount for proxied endpoint keys (default `/`). */
	mount?: string;
	/** Record each page's `new SharedWorker(…)` calls (`recordSharedWorkers`). */
	recordWorkers?: boolean;
}

export interface PairResult {
	pages: Page[];
	statuses: ConsumerStatus[];
	/** Both pages' SharedWorker constructions, when `recordWorkers` is set. */
	sharedWorkers: SharedWorkerCall[];
	counters: unknown;
	log: FrontLog;
	downloaded: number;
	pageErrors: string[];
	consoleErrors: string[];
}

/** One `new SharedWorker(url, options)` call a page made. */
export interface SharedWorkerCall {
	url: string;
	/** The `name` option (or string argument), else null. */
	name: string | null;
	/** The requested worker type; bundlers may rewrite the constructor. */
	type: WorkerType | null;
}

/**
 * Record every SharedWorker a context's pages construct, before their
 * scripts run: the URL tells which worker script a client chose
 * and the `name` whether it is the development variant or the pinned
 * production literal without a name. The subclass passes every
 * argument through, so construction errors surface unchanged.
 */
export async function recordSharedWorkers(
	context: BrowserContext,
): Promise<void> {
	await context.addInitScript(() => {
		const Native = globalThis.SharedWorker;
		if (typeof Native !== "function") return;
		const calls: Array<{
			url: string;
			name: string | null;
			type: WorkerType | null;
		}> = [];
		Object.defineProperty(globalThis, "__spinetabSharedWorkers", {
			value: calls,
		});
		globalThis.SharedWorker = class extends Native {
			constructor(url: string | URL, options?: string | WorkerOptions) {
				calls.push({
					url: String(url),
					name: typeof options === "string" ? options : (options?.name ?? null),
					type: typeof options === "string" ? null : (options?.type ?? null),
				});
				super(url, options);
			}
		};
	});
}

export async function sharedWorkersOf(page: Page): Promise<SharedWorkerCall[]> {
	return page.evaluate(
		() =>
			(
				globalThis as {
					__spinetabSharedWorkers?: SharedWorkerCall[];
				}
			).__spinetabSharedWorkers ?? [],
	);
}

/** The development worker name: `spinetab-<12 lowercase hex>`. */
export const DEV_WORKER_NAME = /^spinetab-[0-9a-f]{12}$/;

/**
 * Check a plugin cell's recorded SharedWorkers: at least one, a
 * `spinetab-<hash12>` name in development and no name in production.
 */
export function workerNameProblems(
	calls: readonly SharedWorkerCall[],
	mode: Mode,
): string[] {
	if (calls.length === 0) return ["no SharedWorker was constructed"];
	return calls.flatMap((call) => {
		if (mode === "dev") {
			return call.name !== null && DEV_WORKER_NAME.test(call.name)
				? []
				: [`${call.url}: development name ${call.name}`];
		}
		return call.name === null
			? []
			: [`${call.url}: named ${call.name} in production`];
	});
}

/**
 * Scan a dev server's responses: re-fetch every logged response whose path names Spinetab
 * (the redirected wiring, the generated worker, the keep stub, pre-bundled
 * Spinetab dependencies, a `spinetab.worker.*` file) and report local paths
 * in its text, in its inline map sources, or in the request path itself.
 * The scan covers text the plugin generates or redirects; framework modules
 * (`/@vite/client`, Astro's toolbar) are outside it.
 */
export async function devResponseLocalPaths(
	cell: RunningCell,
	roots: readonly string[],
): Promise<Array<{ path: string; paths: string[] }>> {
	const paths = [
		...new Set(
			cell
				.log()
				.requests.filter(
					(request) =>
						request.method === "GET" &&
						request.status === 200 &&
						/spinetab/i.test(request.path),
				)
				.map((request) => request.path),
		),
	];
	const found: Array<{ path: string; paths: string[] }> = [];
	for (const path of paths) {
		const response = await fetch(`${cell.origin}${path}`);
		const hits = devTextLocalPaths(await response.text(), roots);
		if (path.includes("/@fs/") || localPathsIn(path, roots).length > 0) {
			hits.push(`request path ${path}`);
		}
		if (hits.length > 0) found.push({ path, paths: hits });
	}
	return found;
}

/**
 * Scan a webpack development build on disk (`next dev --webpack`'s
 * `<distDir>/dev/static`): the code of every Spinetab module of every chunk
 * (`spinetabDevModules`). The scan covers text the plugin generates; webpack's
 * development wrappers carry inline `eval` maps and `sourceURL` comments
 * whose sources are absolute for every module, with or without Spinetab, so
 * that metadata is removed before the scan (`devTextLocalPaths` without
 * `mapSources`). Returns the modules scanned too, so an empty scan is
 * visible rather than a silent pass.
 */
export function devOutputLocalPaths(
	dir: string,
	roots: readonly string[],
): {
	modules: number;
	found: Array<{ chunk: string; id: string; paths: string[] }>;
} {
	const found: Array<{ chunk: string; id: string; paths: string[] }> = [];
	let modules = 0;
	for (const file of listChunks(dir)) {
		const chunk = relative(dir, file).replace(/\\/g, "/");
		for (const module of spinetabDevModules(readFileSync(file, "utf8"))) {
			modules += 1;
			const paths = devTextLocalPaths(module.text, roots, {
				mapSources: false,
			});
			if (paths.length > 0) found.push({ chunk, id: module.id, paths });
		}
	}
	return { modules, found };
}

export function pageUrl(
	origin: string,
	path: string,
	run: string,
	query: Record<string, string> = {},
): string {
	const params = new URLSearchParams({ run, ...query });
	return `${origin}${path}?${params}`;
}

/** The expected answer of the AI routes (server/chat.mjs, app/api/chat/route.ts). */
export const AI_ANSWER = "Shared across tabs by Spinetab.";

export interface AiCounters {
	generations: number;
	generationIds: string[];
	byChat: Record<string, number>;
}

export async function aiCounters(
	origin: string,
	path = "/",
): Promise<AiCounters> {
	const response = await fetch(`${origin}${path}api/counters`);
	return (await response.json()) as AiCounters;
}

async function aiText(page: Page): Promise<string> {
	return page.evaluate(
		() => (window.__consumer?.extra?.text as string | undefined) ?? "",
	);
}

/**
 * The AI fixtures stream only after a message is sent: wait until the page
 * observes its chat and exposes `send`.
 */
export async function waitForAiReady(page: Page): Promise<void> {
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					typeof window.__consumer?.extra?.send === "function" &&
					window.__consumer?.extra?.observing === true,
			),
		)
		.toBe(true);
}

export async function sendAiMessage(page: Page): Promise<void> {
	await page.evaluate(() => {
		(window.__consumer?.extra?.send as (() => unknown) | undefined)?.();
	});
}

/** The streamed answer reached the page (`AI_ANSWER`). */
export async function waitForAiAnswer(
	page: Page,
	timeout = 30_000,
): Promise<void> {
	await expect.poll(() => aiText(page), { timeout }).toBe(AI_ANSWER);
}

/**
 * First visit to a development server. Vite discovers the worker's
 * dependencies only when the browser requests the worker module, then
 * re-optimises and sends a full reload ("optimized dependencies changed.
 * reloading"), which would destroy a measured page mid-assertion. One visit in
 * its own context with its own run id, tolerant of that reload, settles the
 * server: the page must be shared with no main-frame navigation for 1.5 s. The
 * reload is sent when the worker's dependency is served, which precedes shared
 * mode. Measured pages, per-run counters and the front log are untouched.
 */
async function warmDevServer(
	context: BrowserContext,
	url: string,
): Promise<void> {
	const browser = context.browser();
	if (!browser) throw new Error("the dev warm-up needs the context's browser");
	const warm = await browser.newContext();
	try {
		const page = await warm.newPage();
		let navigated = Date.now();
		page.on("framenavigated", (frame) => {
			if (frame === page.mainFrame()) navigated = Date.now();
		});
		await page.goto(url);
		await expect
			.poll(
				async () => {
					// A reload destroys the execution context mid-evaluate.
					const mode = await status(page).then(
						(value) => value?.mode,
						() => undefined,
					);
					return mode === "shared" && Date.now() - navigated >= 1_500;
				},
				{ timeout: 60_000 },
			)
			.toBe(true);
	} finally {
		await warm.close();
	}
}

/**
 * Open two pages of one context and assert one shared upstream: both pages
 * `shared`, events on both, one proxied upstream request per run, fixture
 * counters at one, no CSP violation, and no fallback chunk request or preload.
 */
export async function provePair(options: PairOptions): Promise<PairResult> {
	const { context, cell, run, proof } = options;
	const mount = options.mount ?? "/";
	const dev = options.mode === "dev";
	if (dev) {
		await warmDevServer(
			context,
			pageUrl(cell.origin, options.path, newRun(), options.query),
		);
	}
	if (options.recordWorkers) await recordSharedWorkers(context);
	cell.front.reset();
	const url = pageUrl(cell.origin, options.path, run, options.query);
	const first = await openProbePage(context, url);
	const second = await openProbePage(context, url);
	const pages = [first.page, second.page];
	const statuses: ConsumerStatus[] = [];
	for (const page of pages)
		statuses.push(await waitForMode(page, "shared", 60_000));
	// Both tabs report the same runtime, in development as well, where
	// the upstream counters below are not exact.
	const runtimeIds = statuses.map((status) => status.runtimeId);
	expect(
		runtimeIds.every((id) => typeof id === "string" && id !== ""),
		`every shared tab reports a runtimeId: ${JSON.stringify(runtimeIds)}`,
	).toBe(true);
	expect(new Set(runtimeIds).size, "one runtime across the tabs").toBe(1);
	let counters: unknown;
	switch (proof) {
		case "ai": {
			for (const page of pages) await waitForAiReady(page);
			await sendAiMessage(first.page);
			for (const page of pages) await waitForAiAnswer(page);
			const ai = await aiCounters(cell.origin, mount);
			const chat = `chat-${run}`;
			expect(ai.byChat[chat], "one generation for two tabs").toBe(1);
			counters = { generations: ai.byChat[chat] };
			break;
		}
		case "sse": {
			for (const page of pages) await waitForEvents(page, 2);
			await expect.poll(async () => (await sseCounters(run)).active).toBe(1);
			const sse = await sseCounters(run);
			if (!dev) expect(sse.streams, "one upstream stream per run").toBe(1);
			expect(
				proxiedCount(
					cell.log(),
					`${mount}fx/sse/ticks?run=${encodeURIComponent(run)}`,
				),
			).toBe(dev ? sse.streams : 1);
			counters = { streams: sse.streams, active: sse.active };
			break;
		}
		case "ws": {
			for (const page of pages) await waitForEvents(page, 2);
			await expect.poll(async () => (await wsCounters(run)).active).toBe(1);
			const ws = await wsCounters(run);
			if (!dev) expect(ws.opens, "one socket per run").toBe(1);
			expect(ws.byScope[options.scope ?? "alpha"]).toBe(dev ? ws.opens : 1);
			counters = { opens: ws.opens, active: ws.active, byScope: ws.byScope };
			break;
		}
		case "graphql-ws": {
			for (const page of pages) await waitForEvents(page, 2);
			await expect
				.poll(async () => (await graphqlWsCounters(run)).active)
				.toBe(1);
			const graphql = await graphqlWsCounters(run);
			expect(graphql.activeSubscriptions).toBe(1);
			if (!dev) expect(graphql.connections, "one socket per run").toBe(1);
			counters = graphql;
			break;
		}
		case "polling": {
			const started = Date.now();
			for (const page of pages) await waitForEvents(page, 2, 30_000);
			const polled = await pollingCounters(run);
			const elapsed = Date.now() - started;
			expect(polled.maxInFlight, "one read in flight per identity").toBe(1);
			// One schedule at the shortest interval (1 s), plus at most one
			// coalesced read per joining page.
			expect(polled.requests).toBeLessThanOrEqual(
				Math.ceil(elapsed / 1_000) + 3,
			);
			counters = { ...polled, elapsedMs: elapsed };
			break;
		}
		case "none":
			break;
	}
	for (const page of pages) {
		expect(await violations(page), "securitypolicyviolation events").toEqual(
			[],
		);
		expect(
			await preloadsFor(page, options.fallback),
			"fallback preload",
		).toEqual([]);
	}
	const log = cell.log();
	expect(
		requestsFor(log, options.fallback, "page"),
		"fallback chunk requested in shared mode",
	).toEqual([]);
	expect(log.misrouted).toEqual([]);
	const sharedWorkers = options.recordWorkers
		? (await Promise.all(pages.map(sharedWorkersOf))).flat()
		: [];
	return {
		pages,
		statuses,
		sharedWorkers,
		counters,
		log,
		downloaded: downloadedBytes(log),
		pageErrors: [...first.pageErrors, ...second.pageErrors],
		consoleErrors: [...first.consoleErrors, ...second.consoleErrors],
	};
}
