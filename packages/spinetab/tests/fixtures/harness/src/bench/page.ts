// Instrumentation first: every later page timer and listener is counted.

import {
	type ClientStatus,
	createSpinetab,
	type DiagnosticEvent,
	type SpinetabClient,
	type Subscription,
	type SubscriptionStatus,
} from "spinetab";
import { graphqlWs } from "spinetab/graphql-ws";
import { websocket } from "spinetab/websocket";
import {
	busy,
	type ChannelMessage,
	type RealmOp,
	type RingCopy,
	timerResolution,
} from "./channel";
import { type BenchEvent, CHANNEL, FEED_QUERY, TOPICS } from "./event";
import { handleCounts, untracked } from "./instrument";
import { Recorder, serverClockSamples } from "./recorder";
import type {
	BenchApi,
	ClockSamples,
	CommandResult,
	PageInfo,
	RealmReply,
	StartOptions,
	StatsSample,
} from "./types";

/**
 * Spinetab bench page. One client per tab with the
 * application-owned literal worker factory and the lazy local module; every
 * measurement control lives here, outside the library.
 */

const pageId = crypto.randomUUID();
(globalThis as { __spinetabBenchPage?: string }).__spinetabBenchPage = pageId;

const recorder = new Recorder();
const stamp = () => performance.timeOrigin + performance.now();
const resolution = timerResolution();
const wait = (ms: number) =>
	new Promise<void>((resolve) => untracked(() => setTimeout(resolve, ms)));

let client: SpinetabClient | undefined;
let options: StartOptions | undefined;
const subscriptions = new Map<number, Subscription<unknown>>();
const diagnosticLog: DiagnosticEvent[] = [];
const statusLog: ClientStatus[] = [];
let commandResults: Array<CommandResult | null> = [];
const pageErrors: string[] = [];
let holding = false;
const held: Array<() => void> = [];
let sampler: ReturnType<typeof setInterval> | undefined;
const sizes = new Array<number>(TOPICS).fill(0);
const prefixes = new Array<string>(TOPICS).fill("");

/** Opt-in (limits, privacy): size and body prefix of the delivered event. */
function inspectEvent(value: unknown): void {
	const event = ((value as { data?: { feed?: BenchEvent } } | null)?.data
		?.feed ?? value) as BenchEvent | undefined;
	if (!event || typeof event.topic !== "number" || event.topic >= TOPICS)
		return;
	sizes[event.topic] = JSON.stringify(event).length;
	prefixes[event.topic] = String(event.body).slice(0, 32);
}
let samples: StatsSample[] = [];

untracked(() => {
	addEventListener("error", (event) => pageErrors.push(String(event.message)));
	addEventListener("unhandledrejection", (event) =>
		pageErrors.push(String((event as PromiseRejectionEvent).reason)),
	);
});

const pending = new Map<string, (message: ChannelMessage) => void>();
const channel = untracked(() => {
	const created = new BroadcastChannel(CHANNEL);
	created.addEventListener("message", (event) => {
		const message = event.data as ChannelMessage;
		if (message.kind !== "pong" && message.kind !== "res") return;
		pending.get(message.id)?.(message);
	});
	return created;
});

function realmTarget(): string {
	return current().status.get().mode === "local" ? `local:${pageId}` : "worker";
}

function request(
	message: ChannelMessage & { id: string },
	timeoutMs = 10_000,
): Promise<ChannelMessage> {
	return new Promise((resolve, reject) => {
		const timer = untracked(() =>
			setTimeout(() => {
				pending.delete(message.id);
				reject(new Error(`bench channel timeout (${message.kind})`));
			}, timeoutMs),
		);
		pending.set(message.id, (reply) => {
			untracked(() => clearTimeout(timer));
			pending.delete(message.id);
			resolve(reply);
		});
		channel.postMessage(message);
	});
}

function current(): SpinetabClient {
	if (!client) throw new Error("call bench.start() first");
	return client;
}

/** Test-only ack control (stall scenario fallback): hold `ack` envelopes. */
function wrapWorker(worker: SharedWorker): SharedWorker {
	const port = worker.port;
	const wrapped = {
		postMessage(message: unknown) {
			if (holding && (message as { t?: string } | null)?.t === "ack") {
				held.push(() => port.postMessage(message));
				return;
			}
			port.postMessage(message);
		},
		addEventListener: port.addEventListener.bind(port),
		removeEventListener: port.removeEventListener.bind(port),
		start: () => port.start(),
		close: () => port.close(),
	};
	return {
		port: wrapped,
		addEventListener: worker.addEventListener.bind(worker),
		removeEventListener: worker.removeEventListener.bind(worker),
	} as unknown as SharedWorker;
}

function plainStatus(status: ClientStatus): ClientStatus {
	if (!status.error) return status;
	const { code, message } = status.error;
	return { ...status, error: { code, message } as ClientStatus["error"] };
}

function feedFor(connectionQuery?: string) {
	const suffix = connectionQuery ? `?${connectionQuery}` : "";
	const variant = options?.variant ?? "ws";
	if (variant === "graphql-ws") {
		return {
			variant,
			endpoint: graphqlWs({
				url: `/bench/graphql-ws${suffix}`,
				anonymous: !options?.secret,
				...(options?.pongTimeoutMs === undefined
					? {}
					: { pongTimeoutMs: options.pongTimeoutMs }),
			}),
		};
	}
	return {
		variant,
		endpoint: websocket<number>({
			url: `/bench/ws${suffix}`,
			protocol: options?.secret ? "bench-auth" : "bench",
		}),
	};
}

function info(): PageInfo {
	const status = client?.status.get();
	return {
		kind: "spinetab",
		pageId,
		...(options ? { variant: options.variant } : {}),
		...(status
			? {
					mode: status.mode,
					...(status.reason ? { reason: status.reason } : {}),
					...(status.runtimeId ? { runtimeId: status.runtimeId } : {}),
					health: status.health,
					generation: status.generation,
				}
			: {}),
		visibility: document.visibilityState,
		resolution,
		timeOrigin: performance.timeOrigin,
	};
}

function subscribe(topics: number[], connectionQuery?: string): number {
	const spinetab = current();
	const { variant, endpoint } = feedFor(connectionQuery);
	for (const topic of topics) {
		if (subscriptions.has(topic)) continue;
		const state = recorder.state[topic];
		const request =
			variant === "graphql-ws"
				? (endpoint as ReturnType<typeof graphqlWs>).subscription({
						query: FEED_QUERY,
						variables: { topic },
					})
				: (endpoint as ReturnType<typeof websocket<number>>).subscription(
						topic,
					);
		const inspecting = options?.inspect === true;
		const handle = spinetab.subscribe(request as never, {
			next: (event: unknown) => {
				recorder.record(event);
				if (inspecting) inspectEvent(event);
			},
			error: (error) => {
				if (state) state.error = error.code;
			},
			status: (status: SubscriptionStatus) => {
				if (!state) return;
				const { continuity, connection } = status;
				state.continuity = {
					state: continuity.state,
					...(continuity.reason ? { reason: continuity.reason } : {}),
					...(continuity.missed === undefined
						? {}
						: { missed: continuity.missed }),
				};
				state.connection = connection.state;
				if (continuity.state !== "continuous") state.lossReports += 1;
			},
		});
		subscriptions.set(topic, handle as Subscription<unknown>);
	}
	return subscriptions.size;
}

function selected(topics?: number[]): number[] {
	return topics ?? [...subscriptions.keys()];
}

const api: BenchApi = {
	ready: true,
	async start(startOptions) {
		if (client) throw new Error("bench already started");
		options = startOptions;
		const spinetab = createSpinetab({
			worker: () => {
				const worker = new SharedWorker(
					new URL("./bench.worker.ts", import.meta.url),
					{ type: "module", name: "spinetab-bench" },
				);
				return startOptions.ackControl ? wrapWorker(worker) : worker;
			},
			local: () => import("./local"),
			...(startOptions.sharing ? { sharing: startOptions.sharing } : {}),
			...(startOptions.secret
				? {
						credentials: () => ({
							connectionParams: { token: startOptions.secret ?? "" },
						}),
					}
				: {}),
			...(startOptions.diagnostics
				? {
						diagnostics: (event: DiagnosticEvent) => {
							diagnosticLog.push(event);
							if (diagnosticLog.length > 5_000) diagnosticLog.shift();
						},
					}
				: {}),
		});
		client = spinetab;
		spinetab.status.subscribe((status) => {
			statusLog.push(plainStatus(status));
			if (statusLog.length > 1_000) statusLog.shift();
		});
		spinetab.start();
		// Resolve once the mode settles (shared, local or failed).
		for (let index = 0; index < 400; index += 1) {
			const { mode } = spinetab.status.get();
			if (mode !== "inactive" && mode !== "starting") break;
			await wait(25);
		}
		return info();
	},
	info,
	subscribe,
	unsubscribe(topics) {
		for (const topic of selected(topics)) {
			subscriptions.get(topic)?.unsubscribe();
			subscriptions.delete(topic);
		}
		return subscriptions.size;
	},
	markReconciled(topics) {
		let count = 0;
		for (const topic of selected(topics)) {
			const handle = subscriptions.get(topic);
			if (!handle) continue;
			handle.markReconciled();
			count += 1;
		}
		return count;
	},
	summary: (topics) => recorder.summary(topics ?? [...subscriptions.keys()]),
	arm(at = stamp()) {
		recorder.arm(at);
		return at;
	},
	firstAfter: (topics) => recorder.firstAfter(topics),
	lastEventAt: () => recorder.lastAt,
	commands(count, payload = "bench") {
		const spinetab = current();
		const { endpoint, variant } = feedFor();
		if (variant !== "ws") throw new Error("commands need the ws variant");
		commandResults = Array.from({ length: count }, () => null);
		for (let index = 0; index < count; index += 1) {
			const request = (
				endpoint as ReturnType<typeof websocket<number>>
			).command({ payload, index });
			spinetab.command(request).then(
				(outcome) => {
					commandResults[index] = {
						status: outcome.status,
						...("error" in outcome ? { code: outcome.error.code } : {}),
						at: stamp(),
					};
				},
				(error: unknown) => {
					commandResults[index] = {
						status: "threw",
						code: (error as { code?: string }).code ?? String(error),
						at: stamp(),
					};
				},
			);
		}
	},
	commandResults: () => [...commandResults],
	async checkHealth(reason) {
		const at = stamp();
		const status = await current().checkHealth(reason);
		return { at, done: stamp(), health: status.health };
	},
	online() {
		const at = stamp();
		dispatchEvent(new Event("online"));
		return at;
	},
	busy: (ms) => busy(ms),
	holdAcks(hold) {
		holding = hold;
		if (!hold) {
			for (const release of held.splice(0)) release();
		}
		return held.length;
	},
	diagnostics: () => [...diagnosticLog],
	statusHistory: () => [...statusLog],
	handles: () => handleCounts(),
	async calibrate(count = 200, spacingMs = 5) {
		const target = realmTarget();
		const result: ClockSamples = [];
		for (let index = 0; index < count; index += 1) {
			const id = crypto.randomUUID();
			const t0 = stamp();
			const reply = await request({ kind: "ping", id, target });
			const t1 = stamp();
			if (reply.kind === "pong") result.push([t0, reply.at, t1]);
			await wait(spacingMs);
		}
		return result;
	},
	calibrateServer: (count = 50, spacingMs = 5) =>
		serverClockSamples(count, spacingMs, wait),
	async latency(from, to, crossOffset, serverOffset, includeHidden = false) {
		const ring =
			crossOffset === null
				? undefined
				: (await api.realm<RingCopy>("ring")).value;
		return recorder.latencies(
			from,
			to,
			ring,
			crossOffset,
			serverOffset,
			includeHidden,
		);
	},
	async realm<T>(op: RealmOp, args?: Record<string, number>) {
		const reply = await request({
			kind: "req",
			id: crypto.randomUUID(),
			target: realmTarget(),
			op,
			...(args ? { args } : {}),
		});
		if (reply.kind !== "res") throw new Error("unexpected bench reply");
		if (!reply.ok) throw new Error(reply.error ?? "realm request failed");
		const result: RealmReply<T> = {
			realm: reply.realm,
			runtimeId: reply.runtimeId,
			value: reply.value as T,
		};
		return result;
	},
	sampleStats(action, intervalMs = 250) {
		if (action === "start") {
			samples = [];
			untracked(() => {
				if (sampler !== undefined) clearInterval(sampler);
				sampler = setInterval(() => {
					const at = stamp();
					api.realm("stats").then(
						(reply) => samples.push({ at, value: reply.value }),
						(error: unknown) =>
							samples.push({ at, value: { error: String(error) } }),
					);
				}, intervalMs);
			});
			return [];
		}
		untracked(() => {
			if (sampler !== undefined) clearInterval(sampler);
		});
		sampler = undefined;
		return [...samples];
	},
	inspect: () => ({ sizes: [...sizes], prefixes: [...prefixes] }),
	pageErrors: () => [...pageErrors],
	dispose() {
		for (const handle of subscriptions.values()) handle.unsubscribe();
		subscriptions.clear();
		client?.dispose();
		client = undefined;
	},
};

(window as unknown as { bench: BenchApi }).bench = api;
