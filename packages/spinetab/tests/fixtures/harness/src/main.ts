import {
	type ClientStatus,
	type CommandRequest,
	type ConsumerJson,
	type CredentialRequest,
	createSpinetab,
	type DeliveryLimits,
	type DiagnosticEvent,
	type Json,
	type SpinetabClient,
	type SpinetabOptions,
	type Subscription,
	type SubscriptionRequest,
	type SubscriptionStatus,
} from "spinetab";
import { SpinetabChatTransport } from "spinetab/ai-sdk";
import {
	type PollingConsumerOptions,
	type PollingOptions,
	polling,
} from "spinetab/polling";
import { installAiHarness, type TransportClass } from "./adapters/ai-sdk";

/**
 * Browser test harness. Configuration
 * comes from the URL query and `create(options)`. Test-only controls
 * (holding acknowledgements, suppressing detach, crashing or hanging the
 * worker, forcing visibility) live here, outside the library.
 */
type CredentialMode = "none" | "valid" | "revoked" | "hang" | "throw";
type WorkerVariant = "default" | "v0" | "cross-origin" | "missing";

interface HarnessOptions {
	sharing?: "prefer" | "require" | "off";
	scope?: string;
	worker?: WorkerVariant;
	local?: boolean;
	limits?: Partial<DeliveryLimits>;
	lease?: number;
	heartbeat?: number;
	handshake?: number;
	probe?: number;
	credentials?: CredentialMode;
	/** `anonymous: true` on createSpinetab; `?anonymous` in the query. */
	anonymous?: boolean;
	revision?: number;
}

/** A plain request for any registered adapter (protocol and transport suites). */
type RawRequest = SubscriptionRequest<unknown> & { adapter: string };

interface Entry {
	handle: Subscription<unknown>;
	/**
	 * `runtimeId` and `generation` are the client's at delivery time, so a
	 * spec can tell which runtime instance and attachment served each event.
	 */
	events: Array<{
		data: unknown;
		seq: number;
		eventId?: string;
		at: number;
		runtimeId?: string;
		generation: number;
	}>;
	statuses: SubscriptionStatus[];
	errors: Array<{ code: string; message: string }>;
	completed: number;
}

const log = document.getElementById("log");
const note = (text: string) => {
	if (log) log.textContent = text;
};

function fromQuery(): HarnessOptions {
	const params = new URLSearchParams(location.search);
	const options: HarnessOptions = {};
	const text = (key: string) => params.get(key) ?? undefined;
	const number = (key: string) =>
		params.has(key) ? Number(params.get(key)) : undefined;
	const sharing = text("sharing");
	if (sharing) options.sharing = sharing as HarnessOptions["sharing"];
	if (params.has("scope")) options.scope = params.get("scope") ?? "";
	const worker = text("worker");
	if (worker) options.worker = worker as WorkerVariant;
	if (params.has("local")) options.local = params.get("local") !== "no";
	const limits = text("limits");
	if (limits) options.limits = JSON.parse(limits) as Partial<DeliveryLimits>;
	for (const key of [
		"lease",
		"heartbeat",
		"handshake",
		"probe",
		"revision",
	] as const) {
		const value = number(key);
		if (value !== undefined) options[key] = value;
	}
	const credentials = text("credentials");
	if (credentials) options.credentials = credentials as CredentialMode;
	if (params.has("anonymous")) {
		options.anonymous = params.get("anonymous") !== "no";
	}
	return options;
}

let client: SpinetabClient | undefined;
let workers: SharedWorker[] = [];
let holdAcks = false;
let suppressDetach = false;
let credentialMode: CredentialMode = "none";
const heldAcks = new Map<string, unknown>();
const records = new Map<string, Entry>();
const statusHistory: ClientStatus[] = [];
const diagnosticLog: DiagnosticEvent[] = [];

/** Wrap the worker's port so tests can stall acknowledgements or detach. */
function wrap(worker: SharedWorker): SharedWorker {
	workers.push(worker);
	const port = worker.port;
	const wrappedPort = {
		postMessage(message: unknown) {
			const envelope = message as { t?: string; a?: string; c?: string } | null;
			if (holdAcks && envelope?.t === "ack" && envelope.c !== undefined) {
				heldAcks.set(`${envelope.a}:${envelope.c}`, message);
				return;
			}
			if (suppressDetach && envelope?.t === "detach") return;
			port.postMessage(message);
		},
		addEventListener: port.addEventListener.bind(port),
		removeEventListener: port.removeEventListener.bind(port),
		start: () => port.start(),
		close: () => port.close(),
	};
	return {
		port: wrappedPort,
		addEventListener: worker.addEventListener.bind(worker),
		removeEventListener: worker.removeEventListener.bind(worker),
	} as unknown as SharedWorker;
}

function workerFactory(variant: WorkerVariant): () => SharedWorker {
	switch (variant) {
		case "v0":
			return () =>
				wrap(
					new SharedWorker(new URL("./live.worker.v0.ts", import.meta.url), {
						type: "module",
						name: "spinetab-harness-v0",
					}),
				);
		case "cross-origin":
			return () =>
				wrap(
					new SharedWorker(
						"http://127.0.0.1:4501/harness/cross-origin-worker.js",
						{
							type: "module",
							name: "spinetab-harness-cross-origin",
						},
					),
				);
		case "missing":
			return () =>
				wrap(
					new SharedWorker("/harness/missing-worker.js", {
						type: "module",
						name: "spinetab-harness-missing",
					}),
				);
		default:
			return () =>
				wrap(
					new SharedWorker(new URL("./live.worker.ts", import.meta.url), {
						type: "module",
						name: "spinetab-harness",
					}),
				);
	}
}

/**
 * One bearer token in every documented credential key, the closed provider shape.
 * The WebSocket `topics-auth` first-message recipe reads
 * `connectionParams.token`. Tokens follow the fixture's `authorise()`:
 * `valid-<scope>-<n>` is accepted, `revoked-*` rejected.
 */
function credentialsFor(token: string) {
	return {
		headers: { authorization: `Bearer ${token}` },
		connectionParams: { token },
		auth: { token },
	};
}

function provider(request: CredentialRequest) {
	const revision = request.revision ?? 1;
	switch (credentialMode) {
		case "valid":
			return credentialsFor(`valid-${request.scope}-${revision}`);
		case "revoked":
			return credentialsFor(`revoked-${request.scope}-${revision}`);
		case "hang":
			return new Promise<Record<string, never>>((_resolve, reject) => {
				request.signal.addEventListener("abort", () =>
					reject(new Error("aborted")),
				);
			});
		default:
			throw new Error("no session");
	}
}

/** Plain snapshot: Error instances lose `code` when serialised to the test runner. */
function plain(status: ClientStatus): ClientStatus {
	if (!status.error) return status;
	const { code, message, detail } = status.error;
	return {
		...status,
		error: { code, message, ...(detail === undefined ? {} : { detail }) },
	};
}

function current(): SpinetabClient {
	if (!client) throw new Error("call harness.create() first");
	return client;
}

function record(name: string): Entry {
	const found = records.get(name);
	if (!found) throw new Error(`no subscription named ${name}`);
	return found;
}

const harness = {
	create(overrides: HarnessOptions = {}): ClientStatus {
		client?.dispose();
		records.clear();
		statusHistory.length = 0;
		diagnosticLog.length = 0;
		workers = [];
		const options = { ...fromQuery(), ...overrides };
		credentialMode = options.credentials ?? "none";
		const spinetabOptions: SpinetabOptions = {
			worker: workerFactory(options.worker ?? "default"),
			sharing: options.sharing ?? "prefer",
			scope: options.scope ?? "",
			diagnostics: (event) => {
				diagnosticLog.push(event);
				if (diagnosticLog.length > 500) diagnosticLog.shift();
			},
			...(options.local === false
				? {}
				: { local: () => import("./live.local") }),
			...(options.credentials && options.credentials !== "none"
				? { credentials: provider }
				: {}),
			...(options.anonymous ? { anonymous: true } : {}),
			...(options.revision === undefined
				? {}
				: { credentialRevision: options.revision }),
			...(options.limits ? { limits: options.limits } : {}),
			...(options.lease === undefined ? {} : { leaseMs: options.lease }),
			...(options.heartbeat === undefined
				? {}
				: { heartbeatMs: options.heartbeat }),
			...(options.handshake === undefined
				? {}
				: { handshakeTimeoutMs: options.handshake }),
			...(options.probe === undefined ? {} : { probeTimeoutMs: options.probe }),
		};
		client = createSpinetab(spinetabOptions);
		// AI SDK helper (window.harnessAi) bound to this client. The helper types
		// the transport structurally (the harness has no `ai` dependency), so
		// the class is cast once at this boundary.
		installAiHarness({
			client,
			SpinetabChatTransport:
				SpinetabChatTransport as unknown as TransportClass<SpinetabClient>,
		});
		statusHistory.push(client.status.get());
		client.status.subscribe((status) => {
			statusHistory.push(status);
			note(`${status.mode} ${status.health}`);
		});
		client.start();
		return client.status.get();
	},
	/**
	 * Subscribe under `name`. A request with an `adapter` is used as given
	 * (any registered adapter; `consumer` passed only when supplied); anything
	 * else is polling options with a 1 s default interval.
	 */
	subscribe(
		name: string,
		request: PollingOptions | RawRequest,
		consumer?: Partial<PollingConsumerOptions> | Json,
		extra: { repeatable?: boolean } = {},
	): string {
		const entry: Entry = {
			handle: undefined as unknown as Subscription<unknown>,
			events: [],
			statuses: [],
			errors: [],
			completed: 0,
		};
		records.set(name, entry);
		const raw = "adapter" in request && typeof request.adapter === "string";
		const feed = raw
			? { ...(request as RawRequest), ...extra }
			: {
					...polling(request as PollingOptions).subscription(),
					...extra,
				};
		const consumerOptions = raw
			? consumer === undefined
				? {}
				: { consumer: consumer as ConsumerJson }
			: {
					consumer: {
						intervalMs: 1_000,
						...(consumer as Partial<PollingConsumerOptions> | undefined),
					},
				};
		entry.handle = current().subscribe(
			feed,
			{
				next: (data, meta) => {
					const { runtimeId, generation } = current().status.get();
					entry.events.push({
						data,
						seq: meta.seq,
						...(meta.eventId ? { eventId: meta.eventId } : {}),
						at: Date.now(),
						...(runtimeId === undefined ? {} : { runtimeId }),
						generation,
					});
				},
				error: (error) =>
					entry.errors.push({ code: error.code, message: error.message }),
				complete: () => {
					entry.completed += 1;
				},
				status: (status) => entry.statuses.push(status),
			},
			consumerOptions,
		);
		return entry.handle.id;
	},
	events: (name: string) => record(name).events,
	statuses: (name: string) => record(name).statuses,
	status: () => plain(current().status.get()),
	statusHistory: () => statusHistory.map(plain),
	subscriptionStatus: (name: string) => record(name).handle.status.get(),
	continuity: (name: string) => record(name).handle.status.get().continuity,
	errors: (name: string) => record(name).errors,
	unsubscribe: (name: string) => record(name).handle.unsubscribe(),
	update: (name: string, consumer: PollingConsumerOptions) =>
		record(name).handle.update({ ...consumer }),
	reconcile: (name: string) => record(name).handle.markReconciled(),
	command: (request: CommandRequest) => current().command(request),
	setScope: (scope: string, revision?: number) =>
		current().setScope(scope, revision),
	setRevision: (revision: number, restart = false) =>
		current().setCredentialRevision(revision, { restart }),
	setCredentialMode: (mode: CredentialMode) => {
		credentialMode = mode;
	},
	retry: () => current().retry(),
	checkHealth: async () => plain(await current().checkHealth("harness")),
	dispose: () => current().dispose(),
	holdAcks(on: boolean) {
		holdAcks = on;
		if (!on) {
			const port = workers[workers.length - 1]?.port;
			for (const message of heldAcks.values()) port?.postMessage(message);
			heldAcks.clear();
		}
	},
	suppressDetach(on: boolean) {
		suppressDetach = on;
	},
	diagnostics: () => [...diagnosticLog],
	workerConstructions: () => workers.length,
	crashWorker() {
		workers[workers.length - 1]?.port.postMessage({ harness: "crash" });
	},
	hangWorker(ms: number) {
		workers[workers.length - 1]?.port.postMessage({ harness: "hang", ms });
	},
	setVisibility(state: "visible" | "hidden") {
		Object.defineProperty(document, "visibilityState", {
			configurable: true,
			get: () => state,
		});
		Object.defineProperty(document, "hidden", {
			configurable: true,
			get: () => state === "hidden",
		});
		document.dispatchEvent(new Event("visibilitychange"));
	},
};

/** The harness API; browser specs import this type (type-only). */
export type Harness = typeof harness;

// Assigned without a global `Window` augmentation so browser specs can declare
// their own typed view without conflicting declarations.
(window as unknown as { harness: Harness }).harness = harness;
note("harness ready");
