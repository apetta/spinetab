// Instrumentation first, as on the Spinetab page, so handle counts compare.

import { type Client, createClient } from "graphql-ws";
import { busy, timerResolution } from "./channel";
import { FEED_QUERY } from "./event";
import { handleCounts, untracked } from "./instrument";
import { Recorder, serverClockSamples } from "./recorder";
import type { BenchApi, PageInfo, StartOptions } from "./types";

/**
 * Independent-client baseline: each tab runs
 * its own upstream client with no Spinetab. graphql-ws uses `createClient`
 * with the same keep-alive as Spinetab's default (15 s); the native variant
 * uses `new WebSocket` with the bench frames and a 15 s application ping.
 */

const pageId = crypto.randomUUID();
const recorder = new Recorder();
const stamp = () => performance.timeOrigin + performance.now();
const resolution = timerResolution();
const wait = (ms: number) =>
	new Promise<void>((resolve) => untracked(() => setTimeout(resolve, ms)));
const pageErrors: string[] = [];

let options: StartOptions | undefined;
let graphql: Client | undefined;
let socket: WebSocket | undefined;
let ping: ReturnType<typeof setInterval> | undefined;
const opened = new Set<number>();
const disposers = new Map<number, () => void>();

untracked(() => {
	addEventListener("error", (event) => pageErrors.push(String(event.message)));
	addEventListener("unhandledrejection", (event) =>
		pageErrors.push(String((event as PromiseRejectionEvent).reason)),
	);
});

function endpoint(path: string): string {
	const url = new URL(path, location.href);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	return url.href;
}

function openSocket(): WebSocket {
	if (socket) return socket;
	const created = new WebSocket(endpoint("/bench/ws"));
	created.addEventListener("message", (event) => {
		if (typeof event.data !== "string") return;
		const message = JSON.parse(event.data) as { op?: string };
		if (message.op === undefined) recorder.record(message);
	});
	created.addEventListener("open", () => {
		for (const topic of opened)
			created.send(JSON.stringify({ op: "sub", topic }));
	});
	ping = setInterval(() => {
		if (created.readyState === WebSocket.OPEN) created.send('{"op":"ping"}');
	}, 15_000);
	socket = created;
	return created;
}

function unsupported(name: string): never {
	throw new Error(`${name} is not available on the independent baseline page`);
}

function info(): PageInfo {
	return {
		kind: "independent",
		pageId,
		...(options ? { variant: options.variant } : {}),
		visibility: document.visibilityState,
		resolution,
		timeOrigin: performance.timeOrigin,
	};
}

const api: BenchApi = {
	ready: true,
	async start(startOptions) {
		options = startOptions;
		if (startOptions.variant === "graphql-ws") {
			graphql = createClient({
				url: endpoint("/bench/graphql-ws"),
				lazy: true,
				keepAlive: 15_000,
			});
		}
		return info();
	},
	info,
	subscribe(topics) {
		for (const topic of topics) {
			if (opened.has(topic)) continue;
			opened.add(topic);
			if (graphql) {
				const dispose = graphql.subscribe(
					{ query: FEED_QUERY, variables: { topic } },
					{
						next: (value) => {
							recorder.record(value);
						},
						error: (error) => {
							const state = recorder.state[topic];
							if (state) state.error = String(error);
						},
						complete: () => {},
					},
				);
				disposers.set(topic, dispose);
			} else {
				const ws = openSocket();
				if (ws.readyState === WebSocket.OPEN) {
					ws.send(JSON.stringify({ op: "sub", topic }));
				}
			}
		}
		return opened.size;
	},
	unsubscribe(topics) {
		for (const topic of topics ?? [...opened]) {
			if (!opened.delete(topic)) continue;
			const dispose = disposers.get(topic);
			if (dispose) {
				dispose();
				disposers.delete(topic);
			} else if (socket?.readyState === WebSocket.OPEN) {
				socket.send(JSON.stringify({ op: "unsub", topic }));
			}
		}
		return opened.size;
	},
	markReconciled: () => unsupported("markReconciled"),
	summary: (topics) => recorder.summary(topics ?? [...opened]),
	arm(at = stamp()) {
		recorder.arm(at);
		return at;
	},
	firstAfter: (topics) => recorder.firstAfter(topics),
	lastEventAt: () => recorder.lastAt,
	commands: () => unsupported("commands"),
	commandResults: () => [],
	checkHealth: () => unsupported("checkHealth"),
	online() {
		const at = stamp();
		dispatchEvent(new Event("online"));
		return at;
	},
	busy: (ms) => busy(ms),
	holdAcks: () => unsupported("holdAcks"),
	diagnostics: () => [],
	statusHistory: () => [],
	handles: () => handleCounts(),
	calibrate: () => unsupported("calibrate"),
	calibrateServer: (count = 50, spacingMs = 5) =>
		serverClockSamples(count, spacingMs, wait),
	latency: async (from, to, _crossOffset, serverOffset, includeHidden) =>
		recorder.latencies(from, to, undefined, null, serverOffset, includeHidden),
	realm: () => unsupported("realm"),
	sampleStats: () => unsupported("sampleStats"),
	inspect: () => unsupported("inspect"),
	pageErrors: () => [...pageErrors],
	dispose() {
		api.unsubscribe();
		if (ping !== undefined) clearInterval(ping);
		ping = undefined;
		socket?.close();
		socket = undefined;
		void graphql?.dispose();
		graphql = undefined;
	},
};

(window as unknown as { bench: BenchApi }).bench = api;
