import {
	openAttachment,
	type PageAttachment,
	type PortLike,
} from "./attachment.ts";
import {
	BRIDGE_VERSION,
	type PageBody,
	type RuntimeAnnounce,
	type RuntimeMessage,
	type WireCommandRequest,
	type WireSubscriptionRequest,
} from "./bridge.ts";
import { consumerIds } from "./bridge-page.ts";
import {
	type Clock,
	gapThreshold,
	jitteredBackoff,
	MAX_TIMER_MS,
	randomId,
	systemClock,
} from "./clock.ts";
import {
	adapterNotRegistered,
	deserialiseError,
	isErrorCode,
	registerClientBase,
	registerHandleReporter,
	SpinetabError,
} from "./errors.ts";
import { estimateBytes } from "./estimate.ts";
import { watchLifecycle } from "./lifecycle.ts";
import { DEFAULT_LIMITS, resolveDeliveryLimits } from "./limits.ts";
import {
	createLocalRuntime,
	type LocalRuntime,
	runtimeFromModule,
} from "./local.ts";
import { toObserver, toRequest } from "./source.ts";
import {
	INACTIVE_STATUS,
	SERVER_STATUS,
	SERVER_SUBSCRIPTION_STATUS,
} from "./status.ts";
import { createStore, type WritableStore } from "./store.ts";
import type {
	ClientStatus,
	CommandOutcome,
	CommandRequest,
	ConnectionStatus,
	ConsumerOptions,
	Continuity,
	ContinuityReason,
	CredentialRevision,
	DeliveryLimits,
	DiagnosticEvent,
	Json,
	ModeReason,
	Observer,
	RuntimeLimits,
	SerialisedError,
	SharedWorkerLike,
	Source,
	SpinetabClient,
	SpinetabErrorCode,
	SpinetabOptions,
	Store,
	Subscription,
	SubscriptionObserver,
	SubscriptionRequest,
	SubscriptionStatus,
} from "./types.ts";
import { resolveEndpoint } from "./url.ts";
import {
	assertKnownKeys,
	assertOneOf,
	assertPositiveInteger,
	isCredentials,
	isPlainObject,
	unsupported,
} from "./validate.ts";

const HANDSHAKE_TIMEOUT_MS = 5_000;
const PROBE_TIMEOUT_MS = 5_000;
const HEARTBEAT_MS = 20_000;
const HINT_COALESCE_MS = 250;
const REATTACH_BASE_MS = 500;
const REATTACH_CAP_MS = 10_000;
const REATTACH_BUDGET = 5;
const REATTACH_WINDOW_MS = 300_000;
/** Page command timer margin over the runtime's so its outcome arrives first. */
const COMMAND_TIMEOUT_MARGIN_MS = 1_000;
/** Losses within this long after a detected gap do not count against the budget. */
const GAP_GRACE_MS = 60_000;

const STOP_REASONS = new Set<ContinuityReason>([
	"overflow",
	"message-too-large",
	"event-not-serialisable",
]);
const CONTINUITY_RANK = { continuous: 0, resumed: 1, unknown: 2, gap: 3 };

/**
 * The loud path's fixed sentences. A report carries its code and one of
 * these, never an error's message or detail, a scope, a URL or upstream text:
 * reports reach third-party error trackers through `reportError`.
 */
const REPORTS: Partial<Record<SpinetabErrorCode, string>> = {
	"no-credential-source":
		"declare credentials or anonymous: true on createSpinetab.",
	"credentials-audience":
		"add the origin to credentialOrigins in the Spinetab plugin options or your worker file, or declare anonymous: true.",
	"continuity-lost":
		"delivery stopped after a loss; reconcile, then call markReconciled().",
	"not-configured":
		"add the spinetab plugin to your bundler config, or pass worker and local to createSpinetab.",
	"adapter-not-registered":
		"add the adapter to the plugin's adapters option or to your worker file.",
};
const UNHANDLED_ERROR = "subscription ended with no error handler.";
const UNHANDLED_FAILURE =
	"client failed; watch client.status and call retry().";

const OPTION_KEYS = [
	"worker",
	"local",
	"sharing",
	"scope",
	"credentialRevision",
	"credentials",
	"anonymous",
	"limits",
	"handshakeTimeoutMs",
	"probeTimeoutMs",
	"heartbeatMs",
	"leaseMs",
	"baseUrl",
	"diagnostics",
	"onCallbackError",
] as const;

export interface ClientEnv {
	clock: Clock;
	isBrowser(): boolean;
	hasSharedWorker(): boolean;
	visible(): boolean;
	baseUri(): string | undefined;
	listen(
		target: "window" | "document",
		type: string,
		listener: (event: Event) => void,
	): () => void;
	createChannel(): MessageChannel;
	randomId(): string;
	random(): number;
	reportError(error: unknown): void;
}

/** Browser environment; every global is read lazily and guarded. */
export const browserEnv: ClientEnv = {
	clock: systemClock,
	isBrowser: () =>
		typeof window !== "undefined" && typeof document !== "undefined",
	hasSharedWorker: () => typeof SharedWorker !== "undefined",
	visible: () =>
		typeof document === "undefined" || document.visibilityState !== "hidden",
	baseUri: () =>
		typeof document === "undefined" ? undefined : document.baseURI,
	listen: (target, type, listener) => {
		const node: EventTarget = target === "window" ? window : document;
		node.addEventListener(type, listener);
		return () => node.removeEventListener(type, listener);
	},
	createChannel: () => new MessageChannel(),
	randomId,
	random: () => Math.random(),
	reportError: (error) => {
		if (typeof reportError === "function") reportError(error);
		else
			setTimeout(() => {
				throw error;
			}, 0);
	},
};

interface ResolvedOptions {
	worker?: () => SharedWorkerLike;
	local?: SpinetabOptions["local"];
	sharing: "prefer" | "require" | "off";
	scope: string;
	revision: CredentialRevision | null;
	credentials?: SpinetabOptions["credentials"];
	/** No Spinetab credentials for any endpoint of this page. */
	anonymous: boolean;
	limits?: Partial<DeliveryLimits>;
	deliveryLimits: DeliveryLimits;
	handshakeTimeoutMs: number;
	probeTimeoutMs: number;
	heartbeatMs: number;
	leaseMs?: number;
	baseUrl?: string;
	diagnostics?: (event: DiagnosticEvent) => void;
	onCallbackError?: SpinetabOptions["onCallbackError"];
}

type TargetKind = "shared" | "local";
type LossSignal =
	| "ping-timeout"
	| "attachment-expired"
	| "lease-expired"
	| "port-close"
	| "worker-error"
	| "runtime-replaced"
	/** Another runtime announced itself on a welcomed attachment's port. */
	| "runtime-announced";

interface Entry {
	att: PageAttachment;
	kind: TargetKind;
	worker?: SharedWorkerLike;
	welcomed: boolean;
	retired: boolean;
	/** The hello posted on this port (re-posted if the runtime is replaced before welcome). */
	hello?: PageBody;
	/** Runtime id from this port's latest `announce`. */
	announced?: string;
	/** Runtime id from `welcome`: the runtime that knows this attachment. */
	runtime?: string;
	limits?: RuntimeLimits;
	adapters?: Set<string>;
	/** The runtime's `welcome` advertised the subscribe replay marker. */
	replay?: boolean;
	handshakeTimer?: unknown;
	armedAt: number;
	rearmed: boolean;
	cleanup: Array<() => void>;
	credentialAborts: Set<AbortController>;
}

interface Reg {
	readonly id: string;
	readonly request: SubscriptionRequest<unknown>;
	readonly wire: WireSubscriptionRequest;
	readonly observer: SubscriptionObserver<unknown>;
	readonly options: ConsumerOptions;
	readonly store: WritableStore<SubscriptionStatus>;
	consumer: Json | undefined;
	c?: string;
	lastSeq: number;
	lastEventId?: string;
	lastEvent?: unknown;
	repeatable?: boolean;
	registered: boolean;
	stopped: boolean;
	closed: boolean;
	/** Runtime loss still owed its reconnect outcome. */
	owed?: ContinuityReason;
	/** Stopped delivery was reported on the loud path. */
	lossReported?: boolean;
	unlistenAbort?: () => void;
}

interface PendingCommand {
	readonly id: string;
	readonly wire: WireCommandRequest;
	readonly timeoutMs: number;
	/** Issue time plus `timeoutMs`: a held command posts only what remains. */
	readonly deadline: number;
	readonly resolve: (outcome: CommandOutcome) => void;
	posted: boolean;
	entry?: Entry;
	timer?: unknown;
	unlistenAbort?: () => void;
}

interface Probe {
	id: string;
	entry: Entry;
	startedAt: number;
	rearmed: boolean;
	timer?: unknown;
	waiters: Array<(status: ClientStatus) => void>;
}

/**
 * Create the page client from explicit options. Inert until `start()` or the
 * first browser subscribe. The `spinetab` root wraps this to apply a bundler
 * plugin's wiring; this core form never reads it.
 */
export function createSpinetab(options: SpinetabOptions = {}): SpinetabClient {
	return createClientWithEnv(options, browserEnv);
}

export function createClientWithEnv(
	input: SpinetabOptions,
	env: ClientEnv,
): SpinetabClient {
	const options = validateOptions(input);
	const { clock } = env;
	const server = !env.isBrowser();
	const status = createStore<ClientStatus>(
		server ? SERVER_STATUS : INACTIVE_STATUS,
	);
	// Status subscribers, counted so a failure nobody watches is reported.
	let statusListeners = 0;
	const publicStatus: Store<ClientStatus> = {
		get: status.get,
		subscribe(listener) {
			statusListeners += 1;
			const off = status.subscribe(listener);
			let on = true;
			return () => {
				if (on) {
					on = false;
					statusListeners -= 1;
					off();
				}
			};
		},
	};
	/** Client-level loud reports already made (once per client). */
	const reported = new Set<string>();
	let scope = options.scope;
	let revision = options.revision;
	let started = false;
	let disposed = false;
	let pageId = "";
	let baseUrl: string | undefined;
	let generation = 0;
	let current: Entry | undefined;
	let lastKind: TargetKind = options.sharing === "off" ? "local" : "shared";
	let lastRuntimeId: string | undefined;
	let localUsed = false;
	let localReason: ModeReason | undefined;
	let localRuntime: LocalRuntime | undefined;
	let localLoad: Promise<LocalRuntime> | undefined;
	let detachedByLifecycle = false;
	/**
	 * Hidden by pagehide or freeze: set at each one (before any detach), cleared
	 * when the page is shown again (pageshow, resume, visible). A check never
	 * re-attaches meanwhile.
	 */
	let hiddenByLifecycle = false;
	let lastGapAt = Number.NEGATIVE_INFINITY;
	let unlistenLifecycle: (() => void) | undefined;
	let hintTimer: unknown;
	let heartbeatTimer: unknown;
	let heartbeatExpected = 0;
	let reattachTimer: unknown;
	let reattachAttempt = 0;
	const lossTimes: number[] = [];
	let probe: Probe | undefined;
	let checkingTimer: unknown;
	let consumerCounter = 0;
	let subscriptionCounter = 0;
	const regs = new Map<string, Reg>();
	const byConsumer = new Map<string, Reg>();
	const commands = new Map<string, PendingCommand>();
	const pendingAcks = new Map<string, number>();
	const unacked = new Map<string, number>();
	let controlReceived = 0;
	let controlAcked = 0;
	let ackTimer: unknown;
	const counters = { stale: 0, invalid: 0, messageErrors: 0 };

	function emit(type: string, detail?: Json): void {
		if (!options.diagnostics) return;
		try {
			options.diagnostics({
				type,
				at: clock.now(),
				realm: "page",
				...(detail === undefined ? {} : { detail }),
			});
		} catch {
			// Diagnostics never break the client.
		}
	}

	function updateStatus(fields: Partial<ClientStatus>): void {
		const next: ClientStatus = { ...status.get(), ...fields };
		for (const key of Object.keys(next) as Array<keyof ClientStatus>) {
			if (next[key] === undefined) delete next[key];
		}
		const previous = status.get();
		const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
		for (const key of keys) {
			if (
				!Object.is(
					previous[key as keyof ClientStatus],
					next[key as keyof ClientStatus],
				)
			) {
				status.set(Object.freeze(next) as ClientStatus);
				return;
			}
		}
	}

	function callbackError(subscriptionId: string, error: unknown): void {
		if (options.onCallbackError) {
			try {
				options.onCallbackError(error, { subscriptionId });
				return;
			} catch (inner) {
				env.reportError(inner);
				return;
			}
		}
		env.reportError(error);
	}

	/**
	 * The loud path: a code and a fixed sentence, once per caller's rule.
	 * A code that is not a `SpinetabErrorCode` (runtime data, possibly
	 * upstream text) reports as `upstream-error`.
	 */
	function loud(
		subscriptionId: string,
		reported: SpinetabErrorCode,
		sentence?: string,
	): void {
		const code = isErrorCode(reported) ? reported : "upstream-error";
		const text = sentence ?? REPORTS[code] ?? UNHANDLED_ERROR;
		callbackError(subscriptionId, new SpinetabError(code, `${code}: ${text}`));
	}

	function invoke(reg: Reg, action: () => void): void {
		try {
			action();
		} catch (error) {
			callbackError(reg.id, error);
		}
	}

	function setRegStatus(reg: Reg, patch: Partial<SubscriptionStatus>): void {
		if (patch.connection !== undefined || patch.active === false)
			setRecoveryPending(reg.store, false);
		const previous = reg.store.get();
		const next = { ...previous, ...patch };
		if (
			next.active === previous.active &&
			next.connection === previous.connection &&
			next.continuity === previous.continuity
		) {
			return;
		}
		reg.store.set(next);
		// A store listener may already have moved the status on (for example
		// markReconciled()); the observer then got the newer snapshot, and
		// this one would end its view on a superseded status.
		if (!reg.closed && reg.store.get() === next) {
			invoke(reg, () => reg.observer.status?.(next));
		}
	}

	/** Sticky continuity: only reconciliation restores `continuous`. */
	function applyContinuity(reg: Reg, next: Continuity): void {
		// Any adapter notice after a runtime loss is that loss's outcome.
		if (next.reason !== "reconciled") reg.owed = undefined;
		const previous = reg.store.get().continuity;
		const accept =
			next.reason === "reconciled" ||
			CONTINUITY_RANK[next.state] > CONTINUITY_RANK[previous.state] ||
			(next.state === previous.state && next.state !== "continuous") ||
			(next.state === "resumed" && previous.state === "unknown");
		if (accept) setRegStatus(reg, { continuity: next });
	}

	const perConsumerWindow = () =>
		Math.min(
			options.deliveryLimits.maxPendingMessagesPerConsumer,
			current?.limits?.maxPendingMessagesPerConsumer ??
				DEFAULT_LIMITS.maxPendingMessagesPerConsumer,
		);
	const controlWindow = () =>
		current?.limits?.maxControlMessages ?? DEFAULT_LIMITS.maxControlMessages;

	function queueAck(c: string, seq: number): void {
		if ((pendingAcks.get(c) ?? 0) < seq) pendingAcks.set(c, seq);
		const count = (unacked.get(c) ?? 0) + 1;
		unacked.set(c, count);
		// Batched per task, or immediately at half the consumer's window.
		if (count >= Math.max(1, Math.floor(perConsumerWindow() / 2))) flushAcks();
		else scheduleAcks();
	}

	function controlSeen(k: number): void {
		if (k > controlReceived) controlReceived = k;
		if (controlReceived - controlAcked >= Math.max(1, controlWindow() / 2)) {
			flushAcks();
		} else scheduleAcks();
	}

	function scheduleAcks(): void {
		if (ackTimer === undefined) ackTimer = clock.setTimeout(flushAcks, 0);
	}

	function flushAcks(): void {
		if (ackTimer !== undefined) clock.clearTimeout(ackTimer);
		ackTimer = undefined;
		const entry = current;
		if (!entry?.welcomed) return;
		for (const [c, seq] of pendingAcks) entry.att.tryPost({ t: "ack", c, seq });
		pendingAcks.clear();
		unacked.clear();
		if (controlReceived > controlAcked) {
			controlAcked = controlReceived;
			entry.att.tryPost({ t: "ack", k: controlAcked });
		}
	}

	function start(): void {
		if (disposed || started || server) return;
		started = true;
		pageId = env.randomId();
		baseUrl = options.baseUrl ?? env.baseUri();
		unlistenLifecycle = watchLifecycle(env, {
			hint: (reason) => {
				if (
					reason === "pageshow" ||
					reason === "resume" ||
					reason === "visible"
				)
					hiddenByLifecycle = false;
				hint(reason);
			},
			detach: lifecycleDetach,
			visibility: (visible) => {
				if (current?.welcomed)
					current.att.tryPost({ t: "visibility", visible });
			},
		});
		updateStatus({ mode: "starting" });
		emit("start", { sharing: options.sharing });
		if (options.sharing === "off") beginLocal("sharing-off");
		else beginShared();
	}

	/**
	 * Neither `worker` nor `local`, after the root applied any plugin wiring.
	 * Fails with `not-configured` and reports whether it did.
	 */
	function unconfigured(): boolean {
		if (options.worker || options.local) return false;
		fail(
			"not-configured",
			undefined,
			new SpinetabError(
				"not-configured",
				"No worker or local runtime was configured; add the spinetab plugin to your bundler config, or pass worker and local to createSpinetab.",
				{ detail: { reason: "not-configured" } },
			),
		);
		return true;
	}

	function beginShared(): void {
		if (unconfigured()) return;
		lastKind = "shared";
		if (!env.hasSharedWorker()) {
			startupFailed("unsupported");
			return;
		}
		if (!options.worker) {
			startupFailed("unsupported", "no-worker-factory");
			return;
		}
		let worker: SharedWorkerLike;
		let port: PortLike;
		try {
			worker = options.worker();
			port = worker.port;
		} catch (error) {
			startupFailed("worker-construct-failed", errorName(error));
			return;
		}
		// A dedicated Worker or a wrapper returned by mistake is a startup
		// failure, never a wedged client.
		if (!isSharedWorkerLike(worker, port)) {
			startupFailed("worker-construct-failed", "not-a-shared-worker");
			return;
		}
		attach("shared", port, worker);
	}

	function beginLocal(reason: ModeReason): void {
		if (unconfigured()) return;
		lastKind = "local";
		localUsed = true;
		localReason = reason;
		const factory = options.local;
		if (!factory) {
			fail(
				"local-runtime-unavailable",
				reason,
				new SpinetabError(
					"runtime-unavailable",
					"Local execution is needed but no `local` runtime factory was configured.",
					{ detail: { reason } },
				),
			);
			return;
		}
		if (localRuntime) {
			connectLocal();
			return;
		}
		localLoad ??= Promise.resolve()
			.then(factory)
			.then((module) =>
				createLocalRuntime(runtimeFromModule(module), env.createChannel),
			);
		const load = localLoad;
		load.then(
			(local) => {
				if (disposed) {
					local.dispose();
					return;
				}
				if (localLoad !== load) return;
				localRuntime = local;
				if (!current && lastKind === "local") connectLocal();
			},
			(error: unknown) => {
				if (localLoad === load) localLoad = undefined;
				if (disposed) return;
				fail(
					"local-runtime-load-failed",
					errorName(error),
					new SpinetabError(
						"runtime-unavailable",
						"The local runtime module failed to load; call retry() to try again.",
						{ detail: { reason: "local-runtime-load-failed" } },
					),
				);
			},
		);
	}

	function connectLocal(): void {
		if (!localRuntime || disposed) return;
		lastKind = "local";
		attach("local", localRuntime.connect());
	}

	function attach(
		kind: TargetKind,
		port: PortLike,
		worker?: SharedWorkerLike,
	): void {
		const g = ++generation;
		const a = env.randomId();
		const entry: Entry = {
			att: undefined as unknown as PageAttachment,
			kind,
			...(worker ? { worker } : {}),
			welcomed: false,
			retired: false,
			armedAt: clock.now(),
			rearmed: false,
			cleanup: [],
			credentialAborts: new Set(),
		};
		try {
			entry.att = openAttachment(port, a, g, {
				message: (message) => {
					try {
						onMessage(entry, message);
					} catch (error) {
						emit("handler-error", { code: errorName(error) });
					}
				},
				announce: (message) => {
					try {
						onAnnounce(entry, message);
					} catch (error) {
						emit("handler-error", { code: errorName(error) });
					}
				},
				unknown: () => {
					// An additive message type from a newer runtime: ignored.
					counters.invalid += 1;
					emit("unknown-message");
				},
				foreign: (data) => {
					counters.invalid += 1;
					emit("invalid-envelope");
					if (current !== entry || entry.welcomed) return;
					const version =
						isPlainObject(data) && "v" in data ? data.v : undefined;
					if (version !== undefined && version !== BRIDGE_VERSION) {
						startupFailed(
							"incompatible-version",
							`runtime bridge ${String(version)}`,
						);
					} else startupFailed("handshake-invalid");
				},
				stale: () => {
					counters.stale += 1;
					emit("stale-message");
				},
				messageError: () => {
					counters.messageErrors += 1;
					emit("messageerror");
				},
				close: () => {
					if (current !== entry) return;
					if (entry.welcomed) loss(entry, "port-close");
					else startupFailed("worker-error", "port-closed");
				},
			});
		} catch (error) {
			// Current only once the port is open, so no entry without an
			// attachment is ever retired.
			startupFailed("worker-construct-failed", errorName(error));
			return;
		}
		current = entry;
		if (worker) {
			// Still synchronous with construction, so no `error` event is missed.
			const onError = () => {
				if (current !== entry) return;
				if (entry.welcomed) loss(entry, "worker-error");
				else startupFailed("worker-error");
			};
			worker.addEventListener("error", onError);
			entry.cleanup.push(() => worker.removeEventListener("error", onError));
		}
		const hello = {
			t: "hello" as const,
			page: pageId,
			scope,
			// An anonymous page never moves a scope's revision.
			revision: options.anonymous ? null : revision,
			heartbeatMs: options.heartbeatMs,
			visible: env.visible(),
			credentials: options.credentials !== undefined,
			...(options.anonymous ? { anonymous: true as const } : {}),
			diagnostics: options.diagnostics !== undefined,
			...(options.limits ? { limits: options.limits } : {}),
			...(options.leaseMs ? { lease: options.leaseMs } : {}),
		};
		if (!entry.att.tryPost(hello)) {
			startupFailed("handshake-invalid", "hello-not-posted");
			return;
		}
		entry.hello = hello;
		armHandshake(entry);
	}

	/**
	 * The runtime serving this port announced itself. Every accepted port hears
	 * one announce before its
	 * welcome, from the runtime that will welcome it. A welcomed attachment
	 * that hears a different runtime announce itself has been moved to a new
	 * runtime instance that does not know it (WebKit re-initialises a
	 * SharedWorker when its first client page closes and reconnects the
	 * surviving ports): retire it and reattach at once through the factory,
	 * within the re-attachment budget. Before welcome, a second runtime means
	 * the hello went to the replaced instance, so it is posted again.
	 */
	function onAnnounce(entry: Entry, message: RuntimeAnnounce): void {
		if (current !== entry || entry.retired) return;
		const previous = entry.announced;
		entry.announced = message.runtime;
		if (!entry.welcomed) {
			if (
				previous !== undefined &&
				previous !== message.runtime &&
				entry.hello
			) {
				emit("runtime-announced", {
					generation: message.generation,
					welcomed: false,
				});
				entry.att.tryPost(entry.hello);
			}
			return;
		}
		if (message.runtime === entry.runtime) return;
		emit("runtime-announced", {
			generation: message.generation,
			welcomed: true,
		});
		loss(entry, "runtime-announced");
	}

	function armHandshake(entry: Entry): void {
		entry.armedAt = clock.now();
		entry.handshakeTimer = clock.setTimeout(() => {
			if (current !== entry || entry.welcomed) return;
			const now = clock.now();
			const late =
				now - (entry.armedAt + options.handshakeTimeoutMs) >
					gapThreshold(options.handshakeTimeoutMs) ||
				lastGapAt >= entry.armedAt;
			if (late && !entry.rearmed) {
				// A suspended page is not a worker failure: re-arm once.
				entry.rearmed = true;
				armHandshake(entry);
				return;
			}
			startupFailed("startup-timeout");
		}, options.handshakeTimeoutMs);
	}

	function onMessage(entry: Entry, message: RuntimeMessage): void {
		if (current !== entry) return;
		if ("k" in message && typeof message.k === "number") controlSeen(message.k);
		switch (message.t) {
			case "welcome":
				onWelcome(entry, message);
				return;
			case "reject":
				if (!entry.welcomed) {
					startupFailed(
						"incompatible-version",
						`runtime supports bridge ${message.supported.join(",")}`,
					);
				}
				return;
			case "startupError":
				if (!entry.welcomed)
					startupFailed("worker-startup-error", message.code);
				return;
			case "detached":
				if (entry.welcomed) {
					loss(
						entry,
						message.code === "lease-expired"
							? "lease-expired"
							: message.code === "runtime-disposed"
								? "runtime-replaced"
								: "attachment-expired",
					);
				} else startupFailed("worker-startup-error", message.code);
				return;
		}
		if (!entry.welcomed) return;
		switch (message.t) {
			case "event":
				onEvent(message);
				return;
			case "status": {
				const { state, reason } = message.connection;
				for (const c of consumerIds(message.c)) {
					const reg = byConsumer.get(c);
					if (!reg || reg.closed) continue;
					if (message.repeatable !== undefined)
						reg.repeatable = message.repeatable;
					if (state === "connected") reportOwed(reg);
					setRegStatus(reg, { connection: message.connection });
					// A block the application cannot see coming is reported once per
					// client: a missing declaration, or an audience the worker refused.
					if (
						state === "auth-blocked" &&
						(reason === "credentials-audience" ||
							(reason === "no-credential-source" &&
								!options.credentials &&
								!options.anonymous)) &&
						!reported.has(reason)
					) {
						reported.add(reason);
						loud(reg.id, reason);
					}
				}
				return;
			}
			case "continuity":
				consumerIds(message.c).forEach((c, index) => {
					const reg = byConsumer.get(c);
					if (!reg || reg.closed) return;
					if (message.pending) setRecoveryPending(reg.store, true);
					// A batched gap notice carries one missed count per consumer.
					const missed = message.missed?.[index];
					const continuity =
						missed === undefined
							? message.continuity
							: { ...message.continuity, missed };
					if (
						continuity.state === "gap" &&
						continuity.reason &&
						STOP_REASONS.has(continuity.reason)
					) {
						reg.stopped = true;
					}
					applyContinuity(reg, continuity);
					// Still stopped after status listeners ran (a reconcile engine
					// restarts delivery at once) and nobody handles status: report.
					if (reg.stopped && !reg.observer.status && !reg.lossReported) {
						reg.lossReported = true;
						loud(reg.id, "continuity-lost");
					}
				});
				return;
			case "commandResult": {
				const command = commands.get(message.id);
				if (!command || command.entry !== entry) {
					counters.stale += 1;
					return;
				}
				settleCommand(command, rehydrate(message.outcome));
				return;
			}
			case "credentialsRequest":
				onCredentialsRequest(entry, message);
				return;
			case "probeResult":
				if (!probe || probe.id !== message.id) {
					counters.stale += 1;
					return;
				}
				if (message.runtime !== lastRuntimeId) {
					probeLost(entry, "runtime-replaced");
					return;
				}
				finishProbe({ health: "healthy", detail: undefined });
				return;
			case "error": {
				if (message.c === undefined) return;
				const reg = byConsumer.get(message.c);
				if (!reg || reg.closed) return;
				const c = reg.c;
				end(reg, deserialiseError(message));
				if (c) entry.att.tryPost({ t: "unsubscribe", c });
				return;
			}
			case "diagnostic":
				if (options.diagnostics) {
					try {
						options.diagnostics(message.event);
					} catch {
						// Ignore sink failures.
					}
				}
				return;
		}
	}

	function onWelcome(
		entry: Entry,
		message: Extract<RuntimeMessage, { t: "welcome" }>,
	): void {
		if (entry.welcomed) return;
		clock.clearTimeout(entry.handshakeTimer);
		entry.welcomed = true;
		entry.runtime = message.runtime;
		entry.limits = message.limits;
		entry.adapters = new Set(message.adapters.map((item) => item.kind));
		// Anything but `true` is "not advertised": the fail-closed branch.
		entry.replay = message.replay === true;
		lastRuntimeId = message.runtime;
		reattachAttempt = 0;
		const mode = entry.kind === "local" ? "local" : "shared";
		updateStatus({
			mode,
			reason: mode === "local" ? localReason : undefined,
			detail: undefined,
			error: undefined,
			health: "healthy",
			runtimeId: message.runtime,
			generation: entry.att.g,
		});
		emit("attached", { mode, generation: entry.att.g });
		for (const reg of [...regs.values()]) register(reg);
		for (const command of [...commands.values()]) {
			if (!command.posted) postCommand(command);
		}
		startHeartbeat();
	}

	/** Register intent on the current attachment; after loss, exactly once. */
	function register(reg: Reg): void {
		const entry = current;
		// Idempotent per attachment: a subscribe from a status listener during
		// welcome is not registered again by the welcome loop.
		if (!entry?.welcomed || reg.closed || reg.c !== undefined) return;
		// Re-registered intent (after runtime loss or a scope change) must never
		// restart non-repeatable work. What the page knows: the
		// runtime's first status (the adapter default), else the request's own
		// flag. Unknown intent is replayed only with the marker, which a
		// runtime that advertised it answers with `interrupted` when the adapter
		// says non-repeatable; an older runtime cannot, so it fails closed.
		const replay = reg.registered;
		const known = reg.repeatable ?? reg.wire.repeatable;
		if (
			replay &&
			(known === false || (known === undefined && entry.replay !== true))
		) {
			end(
				reg,
				new SpinetabError(
					"interrupted",
					"The runtime was replaced and this subscription cannot be restarted automatically; its outcome is unknown.",
				),
			);
			return;
		}
		if (!entry.adapters?.has(reg.wire.adapter)) {
			end(reg, adapterNotRegistered(reg.wire.adapter));
			return;
		}
		let request = reg.wire;
		if (reg.registered && reg.options.resume) {
			try {
				const override = reg.options.resume({
					...(reg.lastEventId === undefined
						? {}
						: { lastEventId: reg.lastEventId }),
					...(reg.lastEvent === undefined ? {} : { lastEvent: reg.lastEvent }),
				});
				if (override && "subscription" in override) {
					request = { ...request, subscription: override.subscription };
				}
			} catch (error) {
				callbackError(reg.id, error);
			}
		}
		consumerCounter += 1;
		const c = consumerCounter.toString(36);
		reg.c = c;
		reg.lastSeq = 0;
		reg.stopped = false;
		reg.registered = true;
		byConsumer.set(c, reg);
		try {
			entry.att.post({
				t: "subscribe",
				c,
				request,
				...(reg.consumer === undefined ? {} : { options: reg.consumer }),
				...(reg.lastEventId === undefined ? {} : { cursor: reg.lastEventId }),
				...(replay && entry.replay ? { replay: true as const } : {}),
			});
		} catch {
			byConsumer.delete(c);
			end(
				reg,
				new SpinetabError(
					"not-serialisable",
					"subscribe: the request could not be cloned to the runtime.",
					{ detail: { path: "request" } },
				),
			);
		}
	}

	function onEvent(message: Extract<RuntimeMessage, { t: "event" }>): void {
		// Every data message is acknowledged, including messages for consumers
		// already unsubscribed or overflowed, so posted debt drains.
		queueAck(message.c, message.seq);
		const reg = byConsumer.get(message.c);
		if (!reg || reg.closed || message.seq <= reg.lastSeq) return;
		if (message.seq > reg.lastSeq + 1) {
			// A message was lost in transit (messageerror): known loss.
			reg.stopped = false;
			applyContinuity(reg, {
				state: "gap",
				reason: "event-not-serialisable",
				missed: message.seq - reg.lastSeq - 1,
				since: clock.now(),
			});
		}
		reg.lastSeq = message.seq;
		if (message.kind === "next") {
			if (message.eventId !== undefined) reg.lastEventId = message.eventId;
			if (reg.options.resume) reg.lastEvent = message.data;
			const meta = {
				seq: message.seq,
				...(message.eventId === undefined ? {} : { eventId: message.eventId }),
				// The SSE event name, when the runtime sends one.
				...(message.event === undefined ? {} : { event: message.event }),
			};
			invoke(reg, () => reg.observer.next(message.data, meta));
			return;
		}
		if (message.kind === "error") {
			end(reg, deserialiseError(message.error));
			return;
		}
		finish(reg);
		invoke(reg, () => reg.observer.complete?.());
	}

	function onCredentialsRequest(
		entry: Entry,
		message: Extract<RuntimeMessage, { t: "credentialsRequest" }>,
	): void {
		// An anonymous page is never a credential source: it does not answer.
		if (options.anonymous) return;
		const provider = options.credentials;
		// The provider is called with this revision and the reply carries it,
		// never the revision current when the provider answers: credentials
		// minted before a rotation must not be labelled as the new revision.
		const asked = revision;
		const reply = (fields: {
			ok: boolean;
			credentials?: Record<string, unknown>;
			error?: SerialisedError;
		}) => {
			if (current !== entry || entry.retired) return;
			if (
				!entry.att.tryPost({
					t: "credentials",
					id: message.id,
					revision: asked,
					...fields,
				})
			) {
				entry.att.tryPost({
					t: "credentials",
					id: message.id,
					revision: asked,
					ok: false,
					error: {
						code: "not-serialisable",
						message: "The credentials could not be cloned to the runtime.",
					},
				});
			}
		};
		if (!provider) {
			reply({
				ok: false,
				error: {
					code: "no-credential-source",
					message: "No credentials provider.",
				},
			});
			return;
		}
		const controller = new AbortController();
		entry.credentialAborts.add(controller);
		const timer = clock.setTimeout(
			() => controller.abort(),
			entry.limits?.credentialTimeoutMs ?? DEFAULT_LIMITS.credentialTimeoutMs,
		);
		Promise.resolve()
			.then(() =>
				provider({
					scope: message.scope,
					revision: asked,
					reason: message.reason,
					signal: controller.signal,
				}),
			)
			.then(
				(credentials) => {
					if (controller.signal.aborted) return;
					if (!isCredentials(credentials)) {
						// A provider that answers without the closed credentials shape
						// failed. It is never "no source", which polling reads as
						// anonymous, and its value never crosses the bridge.
						reply({
							ok: false,
							error: {
								code: "credentials-failed",
								message:
									"The credentials provider must return { headers?, connectionParams?, auth? } with valid header names and string values.",
							},
						});
						return;
					}
					reply({ ok: true, credentials });
				},
				() => {
					if (controller.signal.aborted) return;
					reply({
						ok: false,
						error: {
							code: "credentials-failed",
							message: "The credentials provider failed.",
						},
					});
				},
			)
			.finally(() => {
				clock.clearTimeout(timer);
				entry.credentialAborts.delete(controller);
			});
	}

	function retire(
		entry: Entry,
		reason: "worker-lost" | "scope-changed" | "aborted",
	): void {
		if (entry.retired) return;
		entry.retired = true;
		if (current === entry) current = undefined;
		clock.clearTimeout(entry.handshakeTimer);
		stopHeartbeat();
		if (probe?.entry === entry) {
			// Every caller sets the status that follows a retirement (loss,
			// pagehide, scope change, dispose) synchronously after this, so a
			// pending check resolves once it has, as client.status reads.
			const waiters = probe.waiters.splice(0);
			finishProbe();
			queueMicrotask(() => {
				for (const resolve of waiters) resolve(status.get());
			});
		}
		// Retire before activate: posted commands become unknown,
		// credential calls are cancelled, then detach and close the port.
		for (const command of [...commands.values()]) {
			if (command.posted && command.entry === entry) {
				settleCommand(command, unknownOutcome(reason));
			}
		}
		for (const controller of entry.credentialAborts) controller.abort();
		entry.credentialAborts.clear();
		if (ackTimer !== undefined) clock.clearTimeout(ackTimer);
		ackTimer = undefined;
		pendingAcks.clear();
		unacked.clear();
		controlReceived = 0;
		controlAcked = 0;
		byConsumer.clear();
		for (const reg of regs.values()) reg.c = undefined;
		for (const cleanup of entry.cleanup) cleanup();
		if (entry.att) entry.att.retire(true);
	}

	function markIntentsUnknown(reason: ContinuityReason): void {
		const since = clock.now();
		for (const reg of regs.values()) {
			setRecoveryPending(reg.store, true);
			applyContinuity(reg, { state: "unknown", reason, since });
			reg.owed = reason;
			setRegStatus(reg, {
				connection: { state: "connecting", reason: "runtime-replaced", since },
			});
		}
	}

	/**
	 * The outcome of a runtime loss precedes the first `connected` on the new
	 * runtime, unless an adapter notice reported it first: a consumer that
	 * reconciled during the outage reconciles again.
	 */
	function reportOwed(reg: Reg): void {
		const reason = reg.owed;
		if (reason === undefined) return;
		applyContinuity(reg, { state: "unknown", reason, since: clock.now() });
	}

	function loss(entry: Entry, signal: LossSignal): void {
		if (disposed || current !== entry || !entry.welcomed) return;
		emit("runtime-lost", { reason: signal });
		retire(entry, "worker-lost");
		markIntentsUnknown(
			signal === "lease-expired" || signal === "attachment-expired"
				? "lease-expired"
				: "runtime-replaced",
		);
		updateStatus({ health: "reattaching", detail: signal });
		const now = clock.now();
		if (signal !== "lease-expired" && now - lastGapAt > GAP_GRACE_MS) {
			lossTimes.push(now);
			while (
				lossTimes.length &&
				now - (lossTimes[0] as number) > REATTACH_WINDOW_MS
			) {
				lossTimes.shift();
			}
			if (lossTimes.length > REATTACH_BUDGET) {
				emit("runtime-unstable");
				if (
					entry.kind === "shared" &&
					options.sharing === "prefer" &&
					options.local &&
					!localUsed
				) {
					beginLocal("runtime-unstable");
				} else {
					fail(
						"runtime-unstable",
						signal,
						new SpinetabError(
							options.sharing === "require"
								? "sharing-unavailable"
								: "runtime-unavailable",
							"The runtime was lost repeatedly; call retry() to try again.",
							{ detail: { reason: "runtime-unstable" } },
						),
					);
				}
				return;
			}
		}
		reattachAttempt += 1;
		// A runtime that announced itself is known to be serving already, so
		// the first re-attachment after a welcome goes at once; the loss budget
		// above bounds a flapping engine (at most 5 per 5 minutes, then policy).
		const delay =
			signal === "runtime-announced" && reattachAttempt === 1
				? 0
				: jitteredBackoff(
						reattachAttempt,
						REATTACH_BASE_MS,
						REATTACH_CAP_MS,
						env.random,
					);
		clock.clearTimeout(reattachTimer);
		reattachTimer = clock.setTimeout(() => {
			reattachTimer = undefined;
			if (disposed || current) return;
			if (entry.kind === "local") connectLocal();
			else beginShared();
		}, delay);
	}

	/** A startup outcome from the closed fallback list. */
	function startupFailed(reason: ModeReason, detail?: string): void {
		const entry = current;
		const kind = entry?.kind ?? lastKind;
		if (entry) retire(entry, "worker-lost");
		emit("startup-failed", { reason });
		if (kind === "local") {
			fail(
				"local-runtime-load-failed",
				detail ?? reason,
				new SpinetabError(
					"runtime-unavailable",
					"The local runtime did not start.",
					{
						detail: { reason },
					},
				),
			);
			return;
		}
		const sharingError = new SpinetabError(
			"sharing-unavailable",
			`Sharing is unavailable (${reason}).`,
			{ detail: { reason } },
		);
		if (options.sharing === "require") {
			fail(reason, detail, sharingError);
			return;
		}
		if (options.local && !localUsed) {
			beginLocal(reason);
			return;
		}
		fail(
			options.local ? reason : "local-runtime-unavailable",
			options.local ? detail : reason,
			sharingError,
		);
	}

	function fail(
		reason: ModeReason,
		detail: string | undefined,
		error: SpinetabError,
	): void {
		if (current) retire(current, "worker-lost");
		clock.clearTimeout(reattachTimer);
		reattachTimer = undefined;
		stopHeartbeat();
		updateStatus({
			mode: "failed",
			reason,
			detail,
			error,
			health: "unreachable",
		});
		emit("mode-failed", { reason });
		if (reason === "not-configured") {
			// A programming error, not a run-time condition: reported once per
			// client even when a status subscriber exists.
			if (!reported.has(reason)) {
				reported.add(reason);
				loud("", reason);
			}
		} else if (!statusListeners && !reported.has("failed")) {
			reported.add("failed");
			loud("", error.code, UNHANDLED_FAILURE);
		}
		// Pending and new work settles with the mode error rather than hang.
		for (const reg of [...regs.values()]) end(reg, error);
		for (const command of [...commands.values()]) {
			settleCommand(command, { status: "not-sent", error });
		}
	}

	function startHeartbeat(): void {
		stopHeartbeat();
		heartbeatExpected = clock.now() + options.heartbeatMs;
		heartbeatTimer = clock.setTimeout(beat, options.heartbeatMs);
	}

	function stopHeartbeat(): void {
		if (heartbeatTimer !== undefined) clock.clearTimeout(heartbeatTimer);
		heartbeatTimer = undefined;
	}

	function beat(): void {
		heartbeatTimer = undefined;
		const entry = current;
		if (disposed || !entry?.welcomed) return;
		const now = clock.now();
		const lateness = now - heartbeatExpected;
		if (lateness > gapThreshold(options.heartbeatMs)) {
			lastGapAt = now;
			emit("scheduling-gap", { ms: lateness });
			hint("gap");
		}
		// Probe while visible (hung or dead runtime detection); renew otherwise.
		if (env.visible()) {
			if (!probe) void runProbe(false);
		} else entry.att.tryPost({ t: "renew" });
		startHeartbeat();
	}

	function runProbe(isHint: boolean): Promise<ClientStatus> {
		const entry = current;
		if (!entry?.welcomed) {
			// Never while hidden: not during or after a pagehide or freeze
			// detach until the page is shown again, nor while the document is
			// hidden. The return hints re-attach; this check resolves detached.
			if (detachedByLifecycle && !hiddenByLifecycle && env.visible())
				reattachAfterLifecycle();
			// A check made during a retirement (from a subscription observer,
			// before the loss, scope change or pagehide sets its status) resolves
			// once the transition has completed, as client.status reads.
			return new Promise((resolve) => {
				queueMicrotask(() => resolve(status.get()));
			});
		}
		if (probe) {
			if (isHint) entry.att.tryPost({ t: "probe", id: probe.id, hint: true });
			const pending = probe;
			return new Promise((resolve) => pending.waiters.push(resolve));
		}
		const id = env.randomId();
		const pending: Probe = {
			id,
			entry,
			startedAt: clock.now(),
			rearmed: false,
			waiters: [],
		};
		probe = pending;
		entry.att.tryPost({ t: "probe", id, ...(isHint ? { hint: true } : {}) });
		// Only a check outlasting one task is shown as `checking`.
		checkingTimer = clock.setTimeout(() => {
			checkingTimer = undefined;
			if (probe === pending) updateStatus({ health: "checking" });
		}, 0);
		armProbe(pending);
		return new Promise((resolve) => pending.waiters.push(resolve));
	}

	function armProbe(pending: Probe): void {
		pending.startedAt = clock.now();
		pending.timer = clock.setTimeout(() => {
			if (probe !== pending) return;
			const late =
				clock.now() - (pending.startedAt + options.probeTimeoutMs) >
				gapThreshold(options.probeTimeoutMs);
			if (late && !pending.rearmed) {
				pending.rearmed = true;
				armProbe(pending);
				return;
			}
			probeLost(pending.entry, "ping-timeout");
		}, options.probeTimeoutMs);
	}

	/** A failed check: its callers see the status after the loss. */
	function probeLost(entry: Entry, signal: LossSignal): void {
		const waiters = probe ? probe.waiters.splice(0) : [];
		finishProbe();
		loss(entry, signal);
		for (const resolve of waiters) resolve(status.get());
	}

	function finishProbe(fields?: Partial<ClientStatus>): void {
		const pending = probe;
		if (!pending) return;
		probe = undefined;
		clock.clearTimeout(pending.timer);
		clock.clearTimeout(checkingTimer);
		checkingTimer = undefined;
		if (fields) updateStatus(fields);
		for (const resolve of pending.waiters) resolve(status.get());
	}

	function hint(reason: string): void {
		if (disposed || !started || hintTimer !== undefined) return;
		hintTimer = clock.setTimeout(() => {
			hintTimer = undefined;
			onHint(reason);
		}, HINT_COALESCE_MS);
	}

	function onHint(reason: string): void {
		if (disposed) return;
		emit("hint", { reason });
		const snapshot = status.get();
		if (snapshot.mode === "failed") {
			// Under `require`, one coalesced return hint may retry.
			if (
				options.sharing === "require" &&
				snapshot.reason !== "unsupported" &&
				snapshot.reason !== "worker-construct-failed" &&
				snapshot.reason !== "not-configured"
			) {
				retry();
			}
			return;
		}
		if (detachedByLifecycle) {
			reattachAfterLifecycle();
			return;
		}
		void runProbe(true);
	}

	function lifecycleDetach(reason: string): void {
		if (disposed) return;
		// Before the retirement, so a check from a callback it runs sees it; and
		// with nothing attached (a return's re-attachment still pending), so a
		// second pagehide or freeze hides the page again.
		hiddenByLifecycle = true;
		if (!current) return;
		emit("lifecycle-detach", { reason });
		detachedByLifecycle = true;
		retire(current, "worker-lost");
		markIntentsUnknown("lease-expired");
		updateStatus({ health: "unknown" });
	}

	function reattachAfterLifecycle(): void {
		if (!detachedByLifecycle || disposed) return;
		detachedByLifecycle = false;
		updateStatus({ health: "reattaching" });
		if (lastKind === "local" && localRuntime) connectLocal();
		else beginShared();
	}

	function finish(reg: Reg): void {
		if (reg.closed) return;
		reg.closed = true;
		regs.delete(reg.id);
		if (reg.c) byConsumer.delete(reg.c);
		reg.unlistenAbort?.();
		setRegStatus(reg, { active: false });
	}

	/**
	 * Terminal error. Without an error handler, or when the handler rethrows
	 * the same error (a binding given no hook), it takes the loud path once
	 * per subscription; `aborted` is exempt.
	 */
	function end(reg: Reg, error: SpinetabError): void {
		if (reg.closed) return;
		finish(reg);
		const unhandled = () => {
			// `not-configured` was already reported once for the whole client.
			if (error.code !== "aborted" && error.code !== "not-configured") {
				loud(reg.id, error.code);
			}
		};
		if (!reg.observer.error) {
			unhandled();
			return;
		}
		try {
			reg.observer.error(error);
		} catch (thrown) {
			if (thrown === error) unhandled();
			else callbackError(reg.id, thrown);
		}
	}

	function toWire(
		request: SubscriptionRequest<unknown>,
	): WireSubscriptionRequest {
		return {
			adapter: request.adapter,
			connection: resolveConnection(request.connection),
			subscription: request.subscription,
			...(request.scope === undefined ? {} : { scope: request.scope }),
			...(request.repeatable === undefined
				? {}
				: { repeatable: request.repeatable }),
			...(request.share === undefined ? {} : { share: request.share }),
			...(request.stateful === undefined ? {} : { stateful: request.stateful }),
		};
	}

	function resolveConnection(connection: unknown): unknown {
		if (isPlainObject(connection) && typeof connection.url === "string") {
			return { ...connection, url: resolveEndpoint(connection.url, baseUrl) };
		}
		return connection;
	}

	function subscribe<E>(
		source: Source<E>,
		observerInput: Observer<E>,
		consumerOptions: ConsumerOptions = {},
	): Subscription<E> {
		if (disposed) throw disposedError();
		const request = toRequest(source, "source");
		validateRequest(request, "subscribe");
		const observer = toObserver(observerInput, "observer");
		const rawOptions: unknown = consumerOptions;
		if (!isPlainObject(rawOptions)) {
			throw unsupported("options", "must be a plain object.");
		}
		assertKnownKeys(rawOptions, ["consumer", "resume", "signal"], "options");
		const consumer = plainConsumer(consumerOptions.consumer);
		if (consumer !== undefined) {
			assertCloneable(consumer, "options.consumer", "subscribe");
		}
		if (request.scope !== undefined && request.scope !== scope) {
			throw unsupported(
				"request.scope",
				"must equal the client's scope; change scope with setScope().",
			);
		}
		subscriptionCounter += 1;
		const id = `s${subscriptionCounter.toString(36)}`;
		if (server) return inertSubscription(id) as Subscription<E>;
		start();
		const wire = toWire(request as SubscriptionRequest<unknown>);
		const since = clock.now();
		const reg: Reg = {
			id,
			request: request as SubscriptionRequest<unknown>,
			wire,
			observer: observer as SubscriptionObserver<unknown>,
			options: consumerOptions,
			store: createStore<SubscriptionStatus>({
				active: true,
				connection: { state: "connecting", since },
				continuity: { state: "continuous", since },
			}),
			consumer,
			lastSeq: 0,
			registered: false,
			stopped: false,
			closed: false,
		};
		const handle: Subscription<E> = {
			id,
			status: reg.store,
			update(input) {
				if (reg.closed) return;
				const consumer = plainConsumer(input);
				assertCloneable(consumer, "consumer", "update");
				reg.consumer = consumer;
				if (reg.c && current?.welcomed) {
					current.att.tryPost({ t: "update", c: reg.c, consumer });
				}
			},
			markReconciled(reconcileOptions) {
				if (reg.closed) return;
				// `pending` restarts stopped delivery but leaves continuity as it is,
				// so status stays honest while the application refreshes.
				if (reconcileOptions?.pending !== true) {
					applyContinuity(reg, {
						state: "continuous",
						reason: "reconciled",
						since: clock.now(),
					});
				}
				if (reg.stopped && reg.c && current?.welcomed) {
					// Restart delivery in a new epoch; earlier posted debt stays on
					// the runtime ledger until acknowledged.
					current.att.tryPost({ t: "reconcile", c: reg.c });
				}
				reg.stopped = false;
			},
			retry() {
				// This consumer's group only; the runtime coalesces explicit retries.
				if (!reg.closed && reg.c && current?.welcomed) {
					current.att.tryPost({ t: "retry", c: reg.c });
				}
			},
			unsubscribe() {
				if (reg.closed) return;
				const c = reg.c;
				finish(reg);
				if (c && current?.welcomed)
					current.att.tryPost({ t: "unsubscribe", c });
			},
		};
		// A reconcile engine's failed refresh with no onError goes here.
		registerHandleReporter(handle, (error) => callbackError(id, error));
		const signal = consumerOptions.signal;
		if (signal) {
			if (signal.aborted) {
				reg.closed = true;
				reg.store.set({ ...reg.store.get(), active: false });
				return handle;
			}
			const onAbort = () => handle.unsubscribe();
			signal.addEventListener("abort", onAbort, { once: true });
			reg.unlistenAbort = () => signal.removeEventListener("abort", onAbort);
		}
		regs.set(id, reg);
		const snapshot = status.get();
		if (snapshot.mode === "failed") {
			const error =
				(snapshot.error as SpinetabError | undefined) ??
				new SpinetabError("runtime-unavailable", "The client failed to start.");
			queueMicrotask(() => end(reg, error));
		} else if (current?.welcomed) register(reg);
		return handle;
	}

	function settleCommand(
		command: PendingCommand,
		outcome: CommandOutcome,
	): void {
		if (!commands.delete(command.id)) return;
		clock.clearTimeout(command.timer);
		command.unlistenAbort?.();
		command.resolve(outcome);
	}

	function armCommand(command: PendingCommand, ms: number): void {
		clock.clearTimeout(command.timer);
		command.timer = clock.setTimeout(() => {
			settleCommand(
				command,
				command.posted ? unknownOutcome("timeout") : notSentOutcome("timeout"),
			);
		}, ms);
	}

	function postCommand(command: PendingCommand): void {
		const entry = current;
		if (!entry?.welcomed) return;
		// A command held before welcome posts only what remains of its
		// issue-time deadline, and the page timer keeps its margin over the
		// runtime's, so the runtime's outcome arrives first.
		const remaining = Math.min(
			command.timeoutMs,
			Math.ceil(command.deadline - clock.now()),
		);
		if (remaining < 1) {
			settleCommand(command, notSentOutcome("timeout"));
			return;
		}
		try {
			entry.att.post({
				t: "command",
				id: command.id,
				request: command.wire,
				timeoutMs: remaining,
			});
			command.posted = true;
			command.entry = entry;
		} catch {
			settleCommand(command, notSentOutcome("not-serialisable"));
			return;
		}
		armCommand(command, remaining + COMMAND_TIMEOUT_MARGIN_MS);
	}

	function command<R>(
		request: CommandRequest<R>,
		commandOptions: { timeoutMs?: number; signal?: AbortSignal } = {},
	): Promise<CommandOutcome<R>> {
		if (disposed) return Promise.reject(disposedError());
		let wire: WireCommandRequest;
		let timeoutMs: number;
		try {
			validateRequest(request, "command");
			assertCloneable(request.payload, "request.payload", "command");
			if (request.scope !== undefined && request.scope !== scope) {
				throw unsupported("request.scope", "must equal the client's scope.");
			}
			if (commandOptions.timeoutMs !== undefined) {
				assertPositiveInteger(commandOptions.timeoutMs, "options.timeoutMs", {
					max: MAX_TIMER_MS,
				});
			}
			if (server) {
				return Promise.resolve({
					status: "not-sent",
					error: new SpinetabError(
						"runtime-unavailable",
						"Commands do not run during server rendering.",
					),
				});
			}
			start();
			wire = {
				adapter: request.adapter,
				connection: resolveConnection(request.connection),
				payload: request.payload,
				...(request.scope === undefined ? {} : { scope: request.scope }),
			};
			timeoutMs =
				commandOptions.timeoutMs ??
				current?.limits?.commandTimeoutMs ??
				DEFAULT_LIMITS.commandTimeoutMs;
		} catch (error) {
			return Promise.reject(error);
		}
		const snapshot = status.get();
		if (snapshot.mode === "failed") {
			return Promise.resolve({
				status: "not-sent",
				error:
					(snapshot.error as SpinetabError | undefined) ??
					new SpinetabError(
						"runtime-unavailable",
						"The client failed to start.",
					),
			});
		}
		const signal = commandOptions.signal;
		if (signal?.aborted) {
			return Promise.resolve(notSentOutcome("aborted") as CommandOutcome<R>);
		}
		const limit =
			current?.limits?.maxPendingCommands ?? DEFAULT_LIMITS.maxPendingCommands;
		if (commands.size >= limit) {
			return Promise.resolve(
				notSentOutcome("limit-exceeded") as CommandOutcome<R>,
			);
		}
		return new Promise<CommandOutcome>((resolve) => {
			const pending: PendingCommand = {
				id: env.randomId(),
				wire,
				timeoutMs,
				deadline: clock.now() + timeoutMs,
				resolve,
				posted: false,
			};
			commands.set(pending.id, pending);
			// Held until welcome at most until the deadline; posting re-arms it.
			armCommand(pending, timeoutMs);
			if (signal) {
				const onAbort = () => {
					if (pending.posted) {
						pending.entry?.att.tryPost({ t: "cancel", id: pending.id });
						settleCommand(pending, unknownOutcome("aborted"));
					} else settleCommand(pending, notSentOutcome("aborted"));
				};
				signal.addEventListener("abort", onAbort, { once: true });
				pending.unlistenAbort = () =>
					signal.removeEventListener("abort", onAbort);
			}
			if (current?.welcomed) postCommand(pending);
		}) as Promise<CommandOutcome<R>>;
	}

	function retry(): void {
		if (disposed) throw disposedError();
		if (server) return;
		if (!started) {
			start();
			return;
		}
		const snapshot = status.get();
		if (snapshot.mode === "failed") {
			lossTimes.length = 0;
			reattachAttempt = 0;
			updateStatus({
				mode: "starting",
				reason: undefined,
				detail: undefined,
				error: undefined,
				health: "unknown",
			});
			emit("retry", { from: snapshot.reason ?? "failed" });
			if (
				options.sharing === "off" ||
				snapshot.reason === "local-runtime-load-failed" ||
				(localUsed && lastKind === "local")
			) {
				beginLocal(localReason ?? "sharing-off");
			} else beginShared();
			return;
		}
		if (current?.welcomed) current.att.tryPost({ t: "retry" });
	}

	function setScope(next: string, nextRevision?: CredentialRevision): void {
		if (disposed) throw disposedError();
		if (typeof next !== "string")
			throw unsupported("scope", "must be a string.");
		if (nextRevision !== undefined) assertRevision(nextRevision, "revision");
		if (
			next === scope &&
			(nextRevision === undefined || nextRevision === revision)
		) {
			return;
		}
		scope = next;
		if (nextRevision !== undefined) revision = nextRevision;
		if (!started || server) return;
		emit("scope-changed");
		// Old-session work is invalidated before any new-scope delivery.
		for (const pending of [...commands.values()]) {
			if (!pending.posted)
				settleCommand(pending, notSentOutcome("scope-changed"));
		}
		const hadEntry = current;
		if (hadEntry) retire(hadEntry, "scope-changed");
		const since = clock.now();
		for (const reg of [...regs.values()]) {
			if (reg.request.scope !== undefined && reg.request.scope !== scope) {
				end(
					reg,
					new SpinetabError("scope-changed", "The client changed scope."),
				);
			} else {
				// A principal change is an identity boundary, not a continuity
				// event of the old session: it applies regardless of prior
				// continuity (even a sticky `gap`), so every re-registered
				// consumer and its integration always observe it, on every change
				// including A → B → A. Only `markReconciled()` restores
				// `continuous` afterwards.
				setRecoveryPending(reg.store, true);
				setRegStatus(reg, {
					continuity: { state: "unknown", reason: "scope-changed", since },
				});
			}
		}
		const mode = status.get().mode;
		if (mode === "failed" || mode === "disposed" || detachedByLifecycle) return;
		// A call made from a callback above (a check re-attaching a page shown
		// again, a nested setScope) already attached with this scope; a second
		// attachment would orphan it.
		if (current) return;
		if (reattachTimer !== undefined) return;
		if (!hadEntry && lastKind === "local" && !localRuntime) return;
		updateStatus({
			health: mode === "starting" ? status.get().health : "reattaching",
		});
		if (lastKind === "local") connectLocal();
		else beginShared();
	}

	function setCredentialRevision(
		next: CredentialRevision,
		revisionOptions: { restart?: boolean } = {},
	): void {
		if (disposed) throw disposedError();
		assertRevision(next, "revision");
		if (next === revision && !revisionOptions.restart) return;
		revision = next;
		if (current?.welcomed && !options.anonymous) {
			current.att.tryPost({
				t: "revision",
				revision: next,
				restart: revisionOptions.restart === true,
			});
		}
	}

	function checkHealth(_reason?: string): Promise<ClientStatus> {
		if (disposed) return Promise.reject(disposedError());
		if (server || !started) return Promise.resolve(status.get());
		return runProbe(true);
	}

	function dispose(): void {
		if (disposed) return;
		for (const pending of [...commands.values()]) {
			settleCommand(
				pending,
				pending.posted ? unknownOutcome("aborted") : notSentOutcome("disposed"),
			);
		}
		disposed = true;
		if (current) retire(current, "aborted");
		for (const timer of [
			reattachTimer,
			hintTimer,
			heartbeatTimer,
			checkingTimer,
			ackTimer,
		]) {
			if (timer !== undefined) clock.clearTimeout(timer);
		}
		reattachTimer =
			hintTimer =
			heartbeatTimer =
			checkingTimer =
			ackTimer =
				undefined;
		finishProbe();
		unlistenLifecycle?.();
		unlistenLifecycle = undefined;
		const since = clock.now();
		for (const reg of [...regs.values()]) {
			reg.closed = true;
			reg.unlistenAbort?.();
			setRecoveryPending(reg.store, false);
			reg.store.set({
				...reg.store.get(),
				active: false,
				connection: { state: "disposed", since },
			});
		}
		regs.clear();
		byConsumer.clear();
		localRuntime?.dispose();
		localRuntime = undefined;
		updateStatus({
			mode: "disposed",
			reason: undefined,
			detail: undefined,
			error: undefined,
			health: "unknown",
		});
		emit("disposed");
	}

	const client: SpinetabClient = {
		status: publicStatus,
		get scope() {
			return scope;
		},
		start,
		subscribe,
		command,
		setCredentialRevision,
		setScope,
		checkHealth,
		retry,
		dispose,
	};
	// Integrations resolve their own endpoints against this client's base,
	// the one start() fixes, even when they run before start.
	registerClientBase(client, () =>
		started ? baseUrl : (options.baseUrl ?? env.baseUri()),
	);
	return client;
}

function validateOptions(input: SpinetabOptions = {}): ResolvedOptions {
	const raw: unknown = input;
	if (!isPlainObject(raw)) {
		throw unsupported("options", "must be a plain object.");
	}
	assertKnownKeys(raw, OPTION_KEYS, "options");
	const sharing = input.sharing ?? "prefer";
	assertOneOf(sharing, ["prefer", "require", "off"], "options.sharing");
	for (const key of [
		"worker",
		"local",
		"credentials",
		"diagnostics",
		"onCallbackError",
	] as const) {
		if (input[key] !== undefined && typeof input[key] !== "function") {
			throw unsupported(`options.${key}`, "must be a function.");
		}
	}
	if (input.scope !== undefined && typeof input.scope !== "string") {
		throw unsupported("options.scope", "must be a string.");
	}
	if (input.credentialRevision !== undefined) {
		assertRevision(input.credentialRevision, "options.credentialRevision");
	}
	const anonymous = input.anonymous ?? false;
	if (typeof anonymous !== "boolean") {
		throw unsupported("options.anonymous", "must be a boolean.");
	}
	if (anonymous && input.credentials !== undefined) {
		throw unsupported(
			"options.anonymous",
			"cannot be combined with options.credentials; declare one of them.",
		);
	}
	const timing = (
		key: "handshakeTimeoutMs" | "probeTimeoutMs" | "heartbeatMs" | "leaseMs",
	) => {
		const value = input[key];
		// Host timers cannot wait longer than MAX_TIMER_MS.
		if (value !== undefined)
			assertPositiveInteger(value, `options.${key}`, { max: MAX_TIMER_MS });
		return value;
	};
	const heartbeatMs = timing("heartbeatMs") ?? HEARTBEAT_MS;
	const leaseMs = timing("leaseMs");
	if (leaseMs !== undefined && leaseMs < 2 * heartbeatMs) {
		throw unsupported(
			"options.leaseMs",
			"must be at least twice options.heartbeatMs so heartbeats renew the lease.",
		);
	}
	if (input.baseUrl !== undefined) {
		try {
			new URL(input.baseUrl);
		} catch {
			throw new SpinetabError(
				"invalid-endpoint",
				"options.baseUrl must be an absolute URL.",
				{
					detail: { path: "options.baseUrl" },
				},
			);
		}
	}
	const deliveryLimits = resolveDeliveryLimits(
		input.limits,
		DEFAULT_LIMITS,
		"options.limits",
	);
	return {
		...(input.worker ? { worker: input.worker } : {}),
		...(input.local ? { local: input.local } : {}),
		sharing,
		scope: input.scope ?? "",
		revision: input.credentialRevision ?? null,
		...(input.credentials ? { credentials: input.credentials } : {}),
		anonymous,
		...(input.limits ? { limits: { ...input.limits } } : {}),
		deliveryLimits,
		handshakeTimeoutMs: timing("handshakeTimeoutMs") ?? HANDSHAKE_TIMEOUT_MS,
		probeTimeoutMs: timing("probeTimeoutMs") ?? PROBE_TIMEOUT_MS,
		heartbeatMs,
		...(leaseMs === undefined ? {} : { leaseMs }),
		...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
		...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
		...(input.onCallbackError
			? { onCallbackError: input.onCallbackError }
			: {}),
	};
}

const SUBSCRIBE_REQUEST_KEYS = [
	"adapter",
	"connection",
	"subscription",
	"scope",
	"repeatable",
	"share",
	"stateful",
] as const;
const COMMAND_REQUEST_KEYS = ["adapter", "connection", "scope", "payload"];

/**
 * Checks for JavaScript callers: an unknown key or a wrong-typed
 * field fails here, naming its path, instead of being posted and dropped by
 * the runtime's envelope check, which would leave the handle connecting.
 */
function validateRequest(
	request: unknown,
	operation: "subscribe" | "command",
): void {
	if (!isPlainObject(request)) {
		throw unsupported("request", "must be a plain object.");
	}
	const subscribing = operation === "subscribe";
	assertKnownKeys(
		request,
		subscribing ? SUBSCRIBE_REQUEST_KEYS : COMMAND_REQUEST_KEYS,
		"request",
	);
	if (typeof request.adapter !== "string" || request.adapter.length === 0) {
		throw unsupported("request.adapter", "must be a non-empty string.");
	}
	assertCloneable(request.connection, "request.connection", operation);
	if (!subscribing) return;
	assertCloneable(request.subscription, "request.subscription", operation);
	for (const key of ["repeatable", "stateful"] as const) {
		if (request[key] !== undefined && typeof request[key] !== "boolean") {
			throw unsupported(`request.${key}`, "must be a boolean.");
		}
	}
	if (request.share !== undefined) {
		assertOneOf(request.share, ["always", "before-start"], "request.share");
	}
}

function assertCloneable(
	value: unknown,
	path: string,
	operation: string,
): void {
	if (estimateBytes(value) === undefined) {
		throw new SpinetabError(
			"not-serialisable",
			`${operation}: ${path} cannot cross the bridge; use structured-cloneable plain data (no functions, class instances or accessors).`,
			{ detail: { path, operation } },
		);
	}
}

/**
 * Consumer options as posted: top-level `undefined` values removed, so an
 * optional property typed `number | undefined` reaches the runtime and its
 * adapter as plain JSON (W6a). Anything else is returned as given.
 */
function plainConsumer(consumer: unknown): Json | undefined {
	if (!isPlainObject(consumer)) return consumer as Json | undefined;
	const json: Record<string, Json> = {};
	for (const [key, value] of Object.entries(consumer)) {
		if (value !== undefined) json[key] = value as Json;
	}
	return json;
}

/** Revisions compare numerically only: non-negative safe integers. */
function assertRevision(value: unknown, path: string): void {
	if (!(Number.isSafeInteger(value) && (value as number) >= 0)) {
		throw unsupported(path, "must be a non-negative safe integer.");
	}
}

function inertSubscription(id: string): Subscription<unknown> {
	const store: Store<SubscriptionStatus> = {
		get: () => SERVER_SUBSCRIPTION_STATUS,
		subscribe: () => () => {},
	};
	return {
		id,
		status: store,
		update() {},
		markReconciled() {},
		retry() {},
		unsubscribe() {},
	};
}

function disposedError(): SpinetabError {
	return new SpinetabError(
		"disposed",
		"This Spinetab client has been disposed; create a new client.",
	);
}

/** The SharedWorker members the client uses, on the factory's result. */
function isSharedWorkerLike(worker: unknown, port: unknown): boolean {
	const has = (value: unknown, keys: string[]) =>
		typeof value === "object" &&
		value !== null &&
		keys.every(
			(key) => typeof (value as Record<string, unknown>)[key] === "function",
		);
	return (
		has(worker, ["addEventListener", "removeEventListener"]) &&
		has(port, [
			"postMessage",
			"addEventListener",
			"removeEventListener",
			"start",
		])
	);
}

function errorName(error: unknown): string {
	return error instanceof Error ? error.name : typeof error;
}

const OUTCOME_CODES: Record<string, SpinetabErrorCode> = {
	"limit-exceeded": "limit-exceeded",
	timeout: "timeout",
	aborted: "aborted",
	disposed: "disposed",
	"scope-changed": "scope-changed",
	"not-serialisable": "not-serialisable",
};

function notSentOutcome(reason: string): CommandOutcome {
	return {
		status: "not-sent",
		error: new SpinetabError(
			OUTCOME_CODES[reason] ?? "command-not-sent",
			`The command was not sent (${reason}); it is safe to retry.`,
			{ detail: { reason } },
		),
	};
}

function unknownOutcome(reason: string): CommandOutcome {
	return {
		status: "unknown",
		error: new SpinetabError(
			"command-unknown",
			`The command may have reached the server (${reason}); do not retry blindly.`,
			{ detail: { reason } },
		),
	};
}

function rehydrate(outcome: CommandOutcome): CommandOutcome {
	if ("error" in outcome && outcome.error) {
		return {
			...outcome,
			error: deserialiseError(outcome.error),
		} as CommandOutcome;
	}
	return outcome;
}

export type { ConnectionStatus };

export { INACTIVE_STATUS, SERVER_STATUS };

import { setRecoveryPending } from "./continuity-phase.ts";
