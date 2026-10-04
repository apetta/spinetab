import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Browser, CDPSession, Page } from "@playwright/test";

/**
 * Chromium DevTools Protocol helpers.
 *
 * Playwright 1.63 keeps only page and service-worker targets and detaches
 * shared workers, so the SharedWorker is reached through a browser-level CDP
 * session:
 * - primary: `Target.attachToTarget({ flatten: false })` and
 * `Target.sendMessageToTarget` / `Target.receivedMessageFromTarget`
 * - fallback: Chromium launched with `--remote-debugging-port=<port>`
 * (`SPINETAB_PERF_CDP_PORT`), a raw DevTools WebSocket and a flat session.
 * The probe (probes/shared-worker-cdp.perf.ts) records which route works.
 */

// biome-ignore lint/suspicious/noExplicitAny: CDP payloads are protocol-typed by method
type Params = Record<string, any>;

export interface CdpTarget {
	readonly label: string;
	readonly kind: "page" | "worker";
	readonly route: "page-session" | "non-flat" | "port";
	send<T = Params>(method: string, params?: Params): Promise<T>;
	on(event: string, listener: (params: Params) => void): () => void;
	detach(): Promise<void>;
}

const COMMAND_TIMEOUT_MS = 180_000;

function untyped(session: CDPSession) {
	return {
		send: session.send.bind(session) as unknown as (
			method: string,
			params?: Params,
		) => Promise<Params>,
		on: session.on.bind(session) as unknown as (
			event: string,
			listener: (params: Params) => void,
		) => void,
		off: session.off.bind(session) as unknown as (
			event: string,
			listener: (params: Params) => void,
		) => void,
	};
}

export async function pageTarget(
	page: Page,
	label: string,
): Promise<CdpTarget> {
	const session = await page.context().newCDPSession(page);
	const raw = untyped(session);
	return {
		label,
		kind: "page",
		route: "page-session",
		send: <T>(method: string, params?: Params) =>
			raw.send(method, params) as Promise<T>,
		on(event, listener) {
			raw.on(event, listener);
			return () => raw.off(event, listener);
		},
		detach: () => session.detach(),
	};
}

export interface TargetInfo {
	targetId: string;
	type: string;
	url: string;
	title: string;
	attached: boolean;
	browserContextId?: string;
}

export async function listTargets(browser: CDPSession): Promise<TargetInfo[]> {
	const { targetInfos } = (await untyped(browser).send(
		"Target.getTargets",
	)) as {
		targetInfos: TargetInfo[];
	};
	return targetInfos;
}

interface Pending {
	resolve(value: Params): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
	method: string;
}

/** Message router shared by the non-flat and port routes. */
class Router {
	readonly #pending = new Map<number, Pending>();
	readonly #listeners = new Map<string, Set<(params: Params) => void>>();
	#next = 1;

	nextId(method: string): { id: number; result: Promise<Params> } {
		const id = this.#next++;
		const result = new Promise<Params>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				reject(new Error(`CDP ${method} timed out`));
			}, COMMAND_TIMEOUT_MS);
			this.#pending.set(id, { resolve, reject, timer, method });
		});
		return { id, result };
	}

	dispatch(message: {
		id?: number;
		method?: string;
		params?: Params;
		result?: Params;
		error?: { message: string; code?: number };
	}): void {
		if (typeof message.id === "number") {
			const pending = this.#pending.get(message.id);
			if (!pending) return;
			this.#pending.delete(message.id);
			clearTimeout(pending.timer);
			if (message.error) {
				pending.reject(
					new Error(`CDP ${pending.method}: ${message.error.message}`),
				);
			} else pending.resolve(message.result ?? {});
			return;
		}
		if (message.method) {
			for (const listener of this.#listeners.get(message.method) ?? [])
				listener(message.params ?? {});
		}
	}

	on(event: string, listener: (params: Params) => void): () => void {
		let set = this.#listeners.get(event);
		if (!set) {
			set = new Set();
			this.#listeners.set(event, set);
		}
		set.add(listener);
		return () => set.delete(listener);
	}

	close(reason: string): void {
		for (const [id, pending] of this.#pending) {
			clearTimeout(pending.timer);
			pending.reject(new Error(`CDP ${pending.method}: ${reason}`));
			this.#pending.delete(id);
		}
	}
}

/** Primary route: non-flat child session through the browser session. */
export async function attachNonFlat(
	browser: CDPSession,
	targetId: string,
	label: string,
): Promise<CdpTarget> {
	const raw = untyped(browser);
	const { sessionId } = (await raw.send("Target.attachToTarget", {
		targetId,
		flatten: false,
	})) as { sessionId: string };
	const router = new Router();
	const onMessage = (params: Params) => {
		if (params.sessionId !== sessionId) return;
		router.dispatch(JSON.parse(params.message as string));
	};
	const onDetached = (params: Params) => {
		if (params.sessionId === sessionId) router.close("target detached");
	};
	raw.on("Target.receivedMessageFromTarget", onMessage);
	raw.on("Target.detachedFromTarget", onDetached);
	return {
		label,
		kind: "worker",
		route: "non-flat",
		async send<T>(method: string, params?: Params) {
			const { id, result } = router.nextId(method);
			await raw.send("Target.sendMessageToTarget", {
				sessionId,
				message: JSON.stringify({ id, method, params: params ?? {} }),
			});
			return (await result) as T;
		},
		on: (event, listener) => router.on(event, listener),
		async detach() {
			raw.off("Target.receivedMessageFromTarget", onMessage);
			raw.off("Target.detachedFromTarget", onDetached);
			router.close("detached");
			await raw.send("Target.detachFromTarget", { sessionId }).catch(() => {});
		},
	};
}

/** Fallback route: raw DevTools WebSocket on `--remote-debugging-port`. */
export async function attachViaPort(
	port: number,
	urlPart: string,
	label: string,
): Promise<CdpTarget> {
	const version = (await (
		await fetch(`http://127.0.0.1:${port}/json/version`)
	).json()) as { webSocketDebuggerUrl: string };
	const socket = new WebSocket(version.webSocketDebuggerUrl);
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("CDP port")), {
			once: true,
		});
	});
	const root = new Router();
	const child = new Router();
	let sessionId = "";
	socket.addEventListener("message", (event) => {
		const message = JSON.parse(String(event.data));
		if (message.sessionId && message.sessionId === sessionId)
			child.dispatch(message);
		else if (!message.sessionId) root.dispatch(message);
	});
	const sendRoot = async (method: string, params: Params = {}) => {
		const { id, result } = root.nextId(method);
		socket.send(JSON.stringify({ id, method, params }));
		return result;
	};
	const { targetInfos } = (await sendRoot("Target.getTargets")) as {
		targetInfos: TargetInfo[];
	};
	const target = targetInfos.find(
		(info) => info.type === "shared_worker" && info.url.includes(urlPart),
	);
	if (!target) {
		socket.close();
		throw new Error(
			`no shared_worker target matching ${urlPart} on port ${port}`,
		);
	}
	({ sessionId } = (await sendRoot("Target.attachToTarget", {
		targetId: target.targetId,
		flatten: true,
	})) as { sessionId: string });
	return {
		label,
		kind: "worker",
		route: "port",
		async send<T>(method: string, params?: Params) {
			const { id, result } = child.nextId(method);
			socket.send(
				JSON.stringify({ id, method, params: params ?? {}, sessionId }),
			);
			return (await result) as T;
		},
		on: (event, listener) => child.on(event, listener),
		async detach() {
			await sendRoot("Target.detachFromTarget", { sessionId }).catch(() => {});
			child.close("detached");
			root.close("closed");
			socket.close();
		},
	};
}

export interface WorkerAttach {
	target: CdpTarget | undefined;
	targetInfo: TargetInfo | undefined;
	errors: Record<string, string>;
}

/**
 * Find the SharedWorker whose script URL contains `urlPart` and attach, trying
 * the non-flat route and then the port route when `SPINETAB_PERF_CDP_PORT` is set.
 */
export async function attachSharedWorker(
	browser: Browser,
	urlPart: string,
	label = "worker",
): Promise<WorkerAttach & { browserSession: CDPSession }> {
	const browserSession = await browser.newBrowserCDPSession();
	const errors: Record<string, string> = {};
	const targets = await listTargets(browserSession);
	const targetInfo = targets.find(
		(info) => info.type === "shared_worker" && info.url.includes(urlPart),
	);
	if (!targetInfo) {
		errors.find = `no shared_worker target matching ${urlPart}; types seen: ${[...new Set(targets.map((info) => info.type))].join(", ")}`;
		return { target: undefined, targetInfo, errors, browserSession };
	}
	try {
		const target = await attachNonFlat(
			browserSession,
			targetInfo.targetId,
			label,
		);
		await target.send("Runtime.getIsolateId");
		return { target, targetInfo, errors, browserSession };
	} catch (error) {
		errors["non-flat"] = (error as Error).message;
	}
	const port = Number(process.env.SPINETAB_PERF_CDP_PORT);
	if (Number.isInteger(port) && port > 0) {
		try {
			const target = await attachViaPort(port, urlPart, label);
			await target.send("Runtime.getIsolateId");
			return { target, targetInfo, errors, browserSession };
		} catch (error) {
			errors.port = (error as Error).message;
		}
	} else {
		errors.port = "SPINETAB_PERF_CDP_PORT not set";
	}
	return { target: undefined, targetInfo, errors, browserSession };
}

export interface HeapUsage {
	usedSize: number;
	totalSize: number;
	embedderHeapUsedSize?: number;
	backingStorageSize?: number;
}

export async function collectGarbage(target: CdpTarget): Promise<void> {
	await target.send("HeapProfiler.collectGarbage");
	await target.send("HeapProfiler.collectGarbage");
}

export const heapUsage = (target: CdpTarget) =>
	target.send<HeapUsage>("Runtime.getHeapUsage");

export async function isolateId(target: CdpTarget): Promise<string> {
	const { id } = await target.send<{ id: string }>("Runtime.getIsolateId");
	return id;
}

export interface SettledHeap {
	usedSize: number;
	reads: number[];
	settled: boolean;
}

/** GC twice, then read until two reads differ by < 64 KiB (max 5 reads). */
export async function settledHeap(
	target: CdpTarget,
	toleranceBytes = 64 * 1024,
	maxReads = 5,
): Promise<SettledHeap> {
	await collectGarbage(target);
	const reads = [(await heapUsage(target)).usedSize];
	while (reads.length < maxReads) {
		await collectGarbage(target);
		reads.push((await heapUsage(target)).usedSize);
		const last = reads[reads.length - 1] as number;
		const previous = reads[reads.length - 2] as number;
		if (Math.abs(last - previous) < toleranceBytes) {
			return { usedSize: last, reads, settled: true };
		}
	}
	return {
		usedSize: reads[reads.length - 1] as number,
		reads,
		settled: false,
	};
}

export interface IsolateHeap {
	isolate: string;
	labels: string[];
	usedSize: number;
	settled: boolean;
}

/**
 * Settled heap per distinct isolate: `getHeapUsage` reports the whole isolate,
 * and pages in one renderer may share one, so targets are deduplicated.
 */
export async function isolateHeaps(targets: CdpTarget[]): Promise<{
	total: number;
	isolates: IsolateHeap[];
}> {
	const groups = new Map<string, CdpTarget[]>();
	for (const target of targets) {
		const id = await isolateId(target);
		const list = groups.get(id) ?? [];
		list.push(target);
		groups.set(id, list);
	}
	const isolates: IsolateHeap[] = [];
	for (const [isolate, list] of groups) {
		const heap = await settledHeap(list[0] as CdpTarget);
		isolates.push({
			isolate,
			labels: list.map((target) => target.label),
			usedSize: heap.usedSize,
			settled: heap.settled,
		});
	}
	return {
		total: isolates.reduce((sum, entry) => sum + entry.usedSize, 0),
		isolates,
	};
}

export interface ProcessCpu {
	/** Cumulative CPU seconds across all threads, per process type. */
	byType: Record<string, number>;
	total: number;
	processes: Array<{ type: string; id: number; cpuTime: number }>;
}

export async function processCpu(browser: CDPSession): Promise<ProcessCpu> {
	const { processInfo } = (await untyped(browser).send(
		"SystemInfo.getProcessInfo",
	)) as { processInfo: Array<{ type: string; id: number; cpuTime: number }> };
	const byType: Record<string, number> = {};
	for (const entry of processInfo) {
		byType[entry.type] = (byType[entry.type] ?? 0) + entry.cpuTime;
	}
	return {
		byType,
		total: processInfo.reduce((sum, entry) => sum + entry.cpuTime, 0),
		processes: processInfo,
	};
}

/** CPU seconds spent between two samples, by process id (exited processes dropped). */
export function cpuDelta(before: ProcessCpu, after: ProcessCpu) {
	const previous = new Map(before.processes.map((entry) => [entry.id, entry]));
	const byType: Record<string, number> = {};
	let total = 0;
	for (const entry of after.processes) {
		const base = previous.get(entry.id)?.cpuTime ?? 0;
		const spent = Math.max(0, entry.cpuTime - base);
		byType[entry.type] = (byType[entry.type] ?? 0) + spent;
		total += spent;
	}
	return { total, byType };
}

export async function enableMetrics(target: CdpTarget): Promise<void> {
	await target.send("Performance.enable", { timeDomain: "threadTicks" });
}

export async function metrics(
	target: CdpTarget,
): Promise<Record<string, number>> {
	const { metrics: list } = await target.send<{
		metrics: Array<{ name: string; value: number }>;
	}>("Performance.getMetrics");
	return Object.fromEntries(list.map((entry) => [entry.name, entry.value]));
}

export function metricDelta(
	before: Record<string, number>,
	after: Record<string, number>,
	names = ["TaskDuration", "ScriptDuration", "ThreadTime"],
): Record<string, number> {
	const result: Record<string, number> = {};
	for (const name of names) {
		if (name in before && name in after) {
			result[name] = (after[name] as number) - (before[name] as number);
		}
	}
	return result;
}

export async function startProfile(
	target: CdpTarget,
	intervalMicros = 1_000,
): Promise<void> {
	await target.send("Profiler.enable");
	await target.send("Profiler.setSamplingInterval", {
		interval: intervalMicros,
	});
	await target.send("Profiler.start");
}

export interface ProfileSummary {
	activeMs: number;
	idleMs: number;
	samples: number;
}

/** Stop and sum sample deltas of non-`(idle)` nodes. */
export async function stopProfile(target: CdpTarget): Promise<ProfileSummary> {
	const { profile } = await target.send<{
		profile: {
			nodes: Array<{ id: number; callFrame: { functionName: string } }>;
			samples?: number[];
			timeDeltas?: number[];
		};
	}>("Profiler.stop");
	await target.send("Profiler.disable");
	const names = new Map(
		profile.nodes.map((node) => [node.id, node.callFrame.functionName]),
	);
	let active = 0;
	let idle = 0;
	const samples = profile.samples ?? [];
	const deltas = profile.timeDeltas ?? [];
	for (let index = 0; index < samples.length; index += 1) {
		const delta = deltas[index] ?? 0;
		if (names.get(samples[index] as number) === "(idle)") idle += delta;
		else active += delta;
	}
	return {
		activeMs: active / 1_000,
		idleMs: idle / 1_000,
		samples: samples.length,
	};
}

export interface SnapshotIndex {
	path: string;
	maxId: number;
	nodes: number;
}

interface HeapSnapshotJson {
	snapshot: {
		meta: { node_fields: string[]; node_types: [string[], ...unknown[]] };
	};
	nodes: number[];
	strings: string[];
}

/** Take a heap snapshot (after the caller's GC) and save it as `.heapsnapshot`. */
export async function heapSnapshot(
	target: CdpTarget,
	path: string,
): Promise<SnapshotIndex> {
	const chunks: string[] = [];
	const off = target.on("HeapProfiler.addHeapSnapshotChunk", (params) => {
		chunks.push(params.chunk as string);
	});
	try {
		await target.send("HeapProfiler.takeHeapSnapshot", {
			reportProgress: false,
		});
	} finally {
		off();
	}
	const text = chunks.join("");
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
	const parsed = JSON.parse(text) as HeapSnapshotJson;
	let maxId = 0;
	const fields = parsed.snapshot.meta.node_fields;
	const idIndex = fields.indexOf("id");
	for (let offset = 0; offset < parsed.nodes.length; offset += fields.length) {
		const id = parsed.nodes[offset + idIndex] as number;
		if (id > maxId) maxId = id;
	}
	return { path, maxId, nodes: parsed.nodes.length / fields.length };
}

export interface SnapshotGroup {
	type: string;
	name: string;
	count: number;
	selfSize: number;
}

/**
 * New nodes in `afterText` (ids above the baseline maximum), grouped by type
 * and constructor/name, largest self size first.
 */
export function newNodeGroups(
	afterText: string,
	baselineMaxId: number,
): SnapshotGroup[] {
	const parsed = JSON.parse(afterText) as HeapSnapshotJson;
	const fields = parsed.snapshot.meta.node_fields;
	const types = parsed.snapshot.meta.node_types[0];
	const at = (name: string) => fields.indexOf(name);
	const [typeAt, nameAt, idAt, sizeAt] = [
		at("type"),
		at("name"),
		at("id"),
		at("self_size"),
	];
	const groups = new Map<string, SnapshotGroup>();
	for (let offset = 0; offset < parsed.nodes.length; offset += fields.length) {
		const id = parsed.nodes[offset + idAt] as number;
		if (id <= baselineMaxId) continue;
		const type = types[parsed.nodes[offset + typeAt] as number] ?? "unknown";
		const name = parsed.strings[parsed.nodes[offset + nameAt] as number] ?? "";
		const key = `${type}\u0000${name}`;
		const group = groups.get(key) ?? { type, name, count: 0, selfSize: 0 };
		group.count += 1;
		group.selfSize += parsed.nodes[offset + sizeAt] as number;
		groups.set(key, group);
	}
	return [...groups.values()].sort((a, b) => b.selfSize - a.selfSize);
}
