import type {
	AdapterConnection,
	AdapterSubscription,
	ConnectionContext,
	ContinuityDetail,
	RuntimeAdapter,
	SinkNextMeta,
	SubscriptionSink,
} from "./adapter.ts";
import {
	boundContinuity,
	boundDiagnostic,
	boundError,
	boundOutcome,
	contentBytes,
} from "./bounds.ts";
import {
	type AdapterInfo,
	BRIDGE_VERSION,
	type DetachCode,
	type PageMessage,
	type RuntimeBody,
	type WithoutEnvelope,
} from "./bridge.ts";
import { foreignHello, parsePageMessage } from "./bridge-runtime.ts";
import { type Broker, type CredentialTarget, createBroker } from "./broker.ts";
import {
	type Clock,
	gapThreshold,
	MAX_TIMER_MS,
	randomId,
	systemClock,
} from "./clock.ts";
import { isInterruption } from "./continuity-phase.ts";
import {
	adapterNotRegistered,
	isSpinetabError,
	SpinetabError,
	serialiseError,
	toSerialisedError,
} from "./errors.ts";
import { estimateBytes } from "./estimate.ts";
import {
	connectionKey,
	stableStringify,
	subscriptionKey,
	uniqueKey,
} from "./identity.ts";
import { LIMIT_CAPS, resolveDeliveryLimits, resolveLimits } from "./limits.ts";
import {
	CREDENTIAL_ORIGIN_SENTENCE,
	checkCredentialOrigin,
	isLoopbackHost,
} from "./origins.ts";
import { isPlainObject } from "./plain-object.ts";
import type {
	CommandOutcome,
	ConnectionStatus,
	Continuity,
	ContinuityReason,
	ContinuityState,
	CredentialRevision,
	Credentials,
	DeliveryLimits,
	DiagnosticEvent,
	Json,
	RuntimeHandle,
	RuntimeLimits,
	SerialisedError,
} from "./types.ts";
import { assertAbsoluteEndpoint } from "./url.ts";

// biome-ignore lint/suspicious/noExplicitAny: adapters are heterogeneous by design
export type AnyRuntimeAdapter = RuntimeAdapter<any, any, any, any, any, any>;

export interface RuntimeOptions {
	/** Explicitly selected adapters; duplicate kinds are rejected. */
	adapters: readonly AnyRuntimeAdapter[];
	limits?: Partial<RuntimeLimits>;
	/**
	 * Exact `https:` origins, besides the worker's own origin, that may receive
	 * provider credentials. Nothing a page supplies can widen it.
	 */
	credentialOrigins?: readonly string[];
	/** Opt-in, payload-free runtime diagnostics sink. */
	diagnostics?: (event: DiagnosticEvent) => void;
	/** Injectable time source; defaults to the system timers. */
	clock?: Clock;
}

export interface AttachmentStats {
	a: string;
	g: number;
	scope: string;
	consumers: number;
	ledgers: number;
	pendingMessages: number;
	pendingBytes: number;
	/** Control messages posted and unacknowledged (at most `maxControlMessages`). */
	pendingControl: number;
	/** Control messages waiting in the attachment's outbox. */
	queuedControl: number;
	/**
	 * Estimated bytes of the control snapshots retained in the outbox (at most
	 * `maxControlMessages × maxMessageBytes`).
	 */
	queuedControlBytes: number;
	/**
	 * Data events waiting in the outbox behind queued control. They are
	 * already charged, so they are included in `pendingMessages`.
	 */
	queuedData: number;
	/**
	 * Charged bytes of those retained data snapshots (included in
	 * `pendingBytes`).
	 */
	queuedDataBytes: number;
}

/**
 * High-water marks since runtime start or the last `stats({ resetHwm: true })`. Per-attachment and per-consumer values
 * are the largest seen on any one attachment or consumer, so each compares
 * directly with its limit.
 */
export interface RuntimeHighWaterMarks {
	/** Posted-but-unacknowledged data messages on one attachment. */
	pendingMessages: number;
	/** Charged bytes of those messages on one attachment. */
	pendingBytes: number;
	/** Posted-but-unacknowledged data messages of one consumer. */
	perConsumerMessages: number;
	perConsumerBytes: number;
	/** Pending commands on one attachment or one connection (the limit applies to both). */
	pendingCommands: number;
	/** Posted, unacknowledged control messages on one attachment. */
	controlMessages: number;
	/** Control messages waiting in one attachment's outbox. */
	controlQueued: number;
	/** Estimated bytes of control snapshots retained in one outbox. */
	controlQueuedBytes: number;
	/** Data events retained in one outbox. */
	dataQueued: number;
	/** Charged bytes of data snapshots retained in one outbox. */
	dataQueuedBytes: number;
	/** Upstream subscriptions in the runtime. */
	subscriptions: number;
	consumersPerAttachment: number;
	/** Connection groups in the runtime. */
	connections: number;
}

export interface RuntimeStatsOptions {
	/** Return the marks, then restart them from the current levels. */
	resetHwm?: boolean;
}

export interface RuntimeStats {
	id: string;
	attachments: number;
	consumers: number;
	ledgers: number;
	pendingMessages: number;
	pendingBytes: number;
	connections: number;
	subscriptions: number;
	pendingCommands: number;
	pendingCredentialRequests: number;
	invalidEnvelopes: number;
	staleMessages: number;
	messageErrors: number;
	dataCloneErrors: number;
	expired: number;
	handlerErrors: number;
	perAttachment: AttachmentStats[];
	/**
	 * Retained diagnostic history: the last DIAGNOSTICS_RING events, kept only
	 * when the runtime was created with a `diagnostics` sink;
	 * empty otherwise. Pages that opted in receive live events either way.
	 */
	diagnostics: DiagnosticEvent[];
	hwm: RuntimeHighWaterMarks;
}

export interface Runtime extends RuntimeHandle {
	stats(options?: RuntimeStatsOptions): RuntimeStats;
}

/**
 * Size of the diagnostic history retained for a runtime that configured a
 * `diagnostics` sink.
 */
const DIAGNOSTICS_RING = 100;
/** Default limits: hint-triggered checks per connection. */
const HINT_PROBE_SPACING_MS = 5_000;
const HINT_SERIES_SPACING_MS = 30_000;
const EXPLICIT_RETRY_COALESCE_MS = 1_000;
/**
 * An attachment with control messages queued behind a full
 * window must acknowledge something within this time, or it is expired.
 */
const CONTROL_STALL_MS = 30_000;

interface Ledger {
	seqs: number[];
	sizes: number[];
	count: number;
	bytes: number;
	/**
	 * Highest sequence handed to the port. An acknowledgement never releases
	 * debt beyond it: queued data has not been posted yet.
	 */
	posted: number;
}

interface Holder {
	port: MessagePort;
	att?: Att;
	told: Set<string>;
}

interface Att extends CredentialTarget {
	readonly a: string;
	readonly g: number;
	readonly holder: Holder;
	readonly page: string;
	readonly limits: DeliveryLimits;
	readonly leaseMs: number;
	readonly hasCredentials: boolean;
	/** The page declared `anonymous: true`: never asked, never keyed with provider pages. */
	readonly anonymous: boolean;
	readonly diagnostics: boolean;
	lastActive: number;
	deadline: number;
	visible: boolean;
	consumers: Map<string, Consumer>;
	ledgers: Map<string, Ledger>;
	count: number;
	bytes: number;
	/** Last control sequence produced (posted or queued). */
	k: number;
	/** Last control sequence handed to the port. */
	kPosted: number;
	kAcked: number;
	/**
	 * Messages waiting behind a full control window, in production order: control entries carry their `k`; data entries were
	 * admitted and charged when produced. Every entry is a structured-clone
	 * snapshot taken when it was queued, so later mutation by the producer
	 * never changes what the page receives.
	 */
	outbox: Outgoing[];
	queuedControl: number;
	queuedControlBytes: number;
	queuedData: number;
	queuedDataBytes: number;
	/** Expiry time while control is queued without acknowledgement progress. */
	controlDeadline: number;
	commands: Map<string, PendingCommand>;
	/** Stopped consumers whose gap notice (first or updated count) is due. */
	gapDue: Set<Consumer>;
	closed: boolean;
}

interface Consumer {
	readonly c: string;
	readonly id: string;
	readonly att: Att;
	readonly sub: Upstream;
	options: Json | undefined;
	seq: number;
	stopped?: ContinuityReason;
	missed: number;
	reported: number;
	noticeK: number;
	/** Cursor this consumer re-registered with; cleared once reported. */
	cursor?: string;
}

interface Group {
	readonly key: string;
	readonly adapter: AnyRuntimeAdapter;
	readonly scope: string;
	/** Opened for anonymous pages: credentials resolve to `{}`. */
	readonly anonymous: boolean;
	/** The connection spec's URL, judged by `ctx.credentials` when no URL is given. */
	readonly url: string | undefined;
	readonly abort: AbortController;
	// biome-ignore lint/suspicious/noExplicitAny: adapter-defined types
	conn?: AdapterConnection<any, any, any, any, any>;
	status: ConnectionStatus;
	/** Estimated size of `status.code`, measured once per status change. */
	codeBytes: number;
	subs: Map<string, Upstream>;
	idle?: unknown;
	commands: number;
	credentialWaits: number;
	lastProbe: number;
	lastSeries: number;
	closed: boolean;
}

interface Upstream {
	readonly key: string;
	readonly group: Group;
	// biome-ignore lint/suspicious/noExplicitAny: adapter-defined options
	handle?: AdapterSubscription<any>;
	consumers: Map<string, Consumer>;
	started: boolean;
	closed: boolean;
	linger?: unknown;
}

interface PendingCommand {
	readonly group: Group;
	readonly controller: AbortController;
	timer?: unknown;
	settled: boolean;
}

type ControlBody = WithoutK<Extract<RuntimeBody, { k: number }>>;
/** Control bodies that carry an error record (terminal serialisation). */
type ErrorBody =
	| Extract<ControlBody, { t: "event"; kind: "error" }>
	| Extract<ControlBody, { t: "error" }>;
type DataBody = Extract<RuntimeBody, { t: "event"; kind: "next" }>;
type Outgoing =
	| {
			readonly kind: "control";
			readonly k: number;
			readonly body: ControlBody;
			readonly bytes: number;
	  }
	| {
			readonly kind: "data";
			readonly body: DataBody;
			readonly consumer: Consumer;
			readonly charge: number;
	  };
type WithoutK<T> = T extends unknown ? Omit<T, "k"> : never;
type Terminal =
	| { kind: "complete" }
	| { kind: "error"; error: SerialisedError };

const CONTINUITY_STATE: Record<ContinuityReason, ContinuityState> = {
	"runtime-replaced": "unknown",
	"lease-expired": "unknown",
	reconnected: "unknown",
	reopened: "unknown",
	"scope-changed": "unknown",
	"resumed-with-cursor": "resumed",
	recovered: "resumed",
	reconciled: "continuous",
	overflow: "gap",
	"message-too-large": "gap",
	"event-not-serialisable": "gap",
	"decode-error": "gap",
	"replay-reset": "gap",
};

/**
 * The runtime engine shared by the SharedWorker host and the lazily loaded
 * local runtime. Adapters never see ports.
 */
export function createRuntime(options: RuntimeOptions): Runtime {
	const clock = options.clock ?? systemClock;
	const limits = resolveLimits(options.limits, undefined, "runtime.limits");
	const audience = resolveCredentialOrigins(options.credentialOrigins);
	/** Grants handed to adapters, so a rejection names its revision. */
	const handed = new WeakMap<
		object,
		{ scope: string; revision: CredentialRevision | null }
	>();
	const adapters = registerAdapters(options.adapters);
	const adapterInfo: AdapterInfo[] = [...adapters.values()].map((adapter) => ({
		kind: adapter.kind,
		version: adapter.version,
	}));
	const id = randomId();
	const holders = new Set<Holder>();
	const attachments = new Map<string, Att>();
	const groups = new Map<string, Group>();
	/** Diagnostic history; only ever filled when `history` is true. */
	const ring: DiagnosticEvent[] = [];
	const counters = {
		invalidEnvelopes: 0,
		staleMessages: 0,
		messageErrors: 0,
		dataCloneErrors: 0,
		expired: 0,
		handlerErrors: 0,
	};
	let disposed = false;
	let accepted = 0;
	const hwm: RuntimeHighWaterMarks = zeroMarks();
	let gapTotal = 0;
	let leaseTimer: unknown;
	let leaseDue = Number.POSITIVE_INFINITY;
	let leaseArmedAt = 0;
	let leaseDelay = 0;
	let inDiagnostic = false;
	/**
	 * Diagnostics are genuinely opt-in: history
	 * is retained only when the runtime has a sink, and an event is constructed
	 * only when that sink or a live attachment opted in through
	 * `hello.diagnostics` can receive it.
	 */
	const history = options.diagnostics !== undefined;
	/** Live attachments that opted in through `hello.diagnostics`. */
	let diagnosticAttachments = 0;

	const execNow = () => clock.now() - gapTotal;
	/**
	 * Whether `spacingMs` of executable time passed since `since`. A negative
	 * elapsed time means the wall clock stepped back, so the spacing counts as
	 * satisfied rather than holding every retry and hint back until the clock
	 * catches up.
	 */
	const spaced = (now: number, since: number, spacingMs: number) =>
		now < since || now - since >= spacingMs;

	const broker: Broker = createBroker({
		clock,
		timeoutMs: () => limits.credentialTimeoutMs,
		targets: (scope) =>
			[...attachments.values()].filter(
				(att) => att.scope === scope && att.hasCredentials && !att.closed,
			),
		onRevision: (scope, restart) => {
			for (const group of groups.values()) {
				// Anonymous groups attach no grant: a provider tab's revision
				// changes nothing they send, blocked or not.
				if (group.scope !== scope || group.closed || group.anonymous) continue;
				if (restart || group.status.state === "auth-blocked") {
					call(() => group.conn?.rotate?.());
				}
			}
		},
		onStale: () => {
			counters.staleMessages += 1;
		},
	});

	function send(att: Att, body: RuntimeBody): boolean {
		try {
			att.holder.port.postMessage({
				v: BRIDGE_VERSION,
				a: att.a,
				g: att.g,
				...body,
			});
			return true;
		} catch {
			counters.dataCloneErrors += 1;
			return false;
		}
	}

	/**
	 * Produce a control message: not blocked by data credits, and
	 * at most `maxControlMessages` posted and unacknowledged per attachment.
	 * Beyond that window it waits in the attachment's bounded outbox and is
	 * posted, in order, as acknowledgements arrive. Only an
	 * overflowing outbox, or one left unacknowledged for CONTROL_STALL_MS,
	 * expires the attachment; the page reattaches with `unknown`.
	 * A queued message is a structured-clone snapshot taken now, as
	 * `postMessage` would take it, and is measured by that snapshot; a direct
	 * post is not cloned twice.
	 * An error-bearing message (a terminal `event{kind:"error"}` or an
	 * `error`) whose error cannot be cloned is replaced, in the same position
	 * and with the same `k` and `seq`, by its not-serialisable fallback, so a
	 * terminal or registration error is never swallowed. The fallback runs only
	 * after a clone failure.
	 * Returns the control sequence (posted or queued), 0 when dropped because
	 * the attachment is closed or was expired, -1 when uncloneable (at the
	 * direct post or at the snapshot) and no fallback applies.
	 */
	function control(att: Att, body: ControlBody): number {
		const k = produce(att, body);
		if (k !== -1) return k;
		const fallback = errorFallback(body, att.limits.maxMessageBytes);
		if (fallback === undefined) return -1;
		const replaced = produce(att, fallback);
		diag("error-not-serialisable", {
			message: fallback.t === "event" ? "terminal" : "error",
			code: fallback.t === "event" ? fallback.error.code : fallback.code,
		});
		return replaced;
	}

	/** Post or queue one control message (see `control`). */
	function produce(att: Att, body: ControlBody): number {
		if (att.closed) return 0;
		if (
			att.outbox.length === 0 &&
			att.kPosted - att.kAcked < limits.maxControlMessages
		) {
			const k = att.k + 1;
			if (!send(att, { ...body, k } as RuntimeBody)) return -1;
			att.k = k;
			att.kPosted = k;
			raise("controlMessages", k - att.kAcked);
			return k;
		}
		const snapshot = clone(body);
		if (snapshot === undefined) return -1;
		const bytes = estimateBytes(snapshot.value) ?? att.limits.maxMessageBytes;
		if (
			att.queuedControl + 1 > queuedControlCap() ||
			att.queuedControlBytes + bytes >
				limits.maxControlMessages * att.limits.maxMessageBytes
		) {
			expire(att, "attachment-expired", "control-queue");
			return 0;
		}
		const k = att.k + 1;
		att.k = k;
		att.outbox.push({ kind: "control", k, body: snapshot.value, bytes });
		att.queuedControl += 1;
		att.queuedControlBytes += bytes;
		raise("controlQueued", att.queuedControl);
		raise("controlQueuedBytes", att.queuedControlBytes);
		if (att.controlDeadline === Number.POSITIVE_INFINITY) {
			att.controlDeadline = clock.now() + CONTROL_STALL_MS;
			armLease();
		}
		return k;
	}

	/**
	 * Queued control per attachment: every consumer may owe its status
	 * snapshot plus one terminal, error or forced gap notice in one burst, and
	 * every pending command one reply.
	 */
	const queuedControlCap = () =>
		2 * (limits.maxConsumersPerAttachment + limits.maxPendingCommands);

	/**
	 * A structured-clone snapshot for a message that is retained before it is
	 * posted, or undefined (counted as a DataCloneError) when it cannot be
	 * cloned. `postMessage` copies and never transfers, so a snapshot copies
	 * binary data exactly as the post would; the producer keeps its buffers.
	 */
	function clone<T>(value: T): { value: T } | undefined {
		try {
			return { value: structuredClone(value) };
		} catch {
			counters.dataCloneErrors += 1;
			return undefined;
		}
	}

	/** Drain the outbox in order while the control window has room. */
	function pump(att: Att): void {
		let failed = false;
		while (!att.closed && att.outbox.length > 0) {
			const next = att.outbox[0] as Outgoing;
			if (next.kind === "data") {
				att.outbox.shift();
				att.queuedData -= 1;
				att.queuedDataBytes -= next.charge;
				if (send(att, next.body)) {
					const ledger = att.ledgers.get(next.consumer.c);
					if (ledger && ledger.posted < next.body.seq) {
						ledger.posted = next.body.seq;
					}
				} else {
					// Snapshots are clone output, so this is a defensive path: the
					// sequence is spent, so a queued terminal after it arrives as a
					// sequence jump the page reports as a gap.
					uncharge(att, next.consumer, next.body.seq, next.charge);
					failed = true;
				}
				continue;
			}
			if (att.kPosted - att.kAcked >= limits.maxControlMessages) break;
			att.outbox.shift();
			att.queuedControl -= 1;
			att.queuedControlBytes -= next.bytes;
			att.kPosted = next.k;
			if (!send(att, { ...next.body, k: next.k } as RuntimeBody)) {
				const fallback =
					next.body.t === "commandResult"
						? { ...next.body, outcome: notSerialisableOutcome() }
						: errorFallback(next.body, att.limits.maxMessageBytes);
				if (fallback) send(att, { ...fallback, k: next.k } as RuntimeBody);
			}
			raise("controlMessages", att.kPosted - att.kAcked);
		}
		att.controlDeadline =
			att.outbox.length === 0
				? Number.POSITIVE_INFINITY
				: clock.now() + CONTROL_STALL_MS;
		if (failed) flushGaps(att);
	}

	/**
	 * A queued event that failed to clone when posted: release its charge and
	 * stop its consumer, as the direct path does for a DataCloneError.
	 */
	function uncharge(
		att: Att,
		consumer: Consumer,
		seq: number,
		charge: number,
	): void {
		const ledger = att.ledgers.get(consumer.c);
		const index = ledger ? ledger.seqs.indexOf(seq) : -1;
		if (ledger && index !== -1) {
			ledger.seqs.splice(index, 1);
			ledger.sizes.splice(index, 1);
			ledger.count -= 1;
			ledger.bytes -= charge;
			att.count -= 1;
			att.bytes -= charge;
			dropEmptyLedger(att, consumer.c);
		}
		if (att.consumers.get(consumer.c) === consumer && !consumer.stopped) {
			stop(consumer, "event-not-serialisable");
		}
	}

	function raise(key: keyof RuntimeHighWaterMarks, value: number): void {
		if (value > hwm[key]) hwm[key] = value;
	}

	/**
	 * Record a payload-free diagnostic. An adapter's diagnostic
	 * passes its group's `scope` and reaches only that scope's tabs; the
	 * runtime's own reach every opted-in tab. With no runtime sink and
	 * no live opted-in attachment nothing is constructed or retained; callers
	 * increment their safety counters before calling, so counting never
	 * depends on diagnostics being enabled.
	 */
	function diag(type: string, detail?: Json, scope?: string): void {
		if (inDiagnostic) return;
		if (!history && diagnosticAttachments === 0) return;
		inDiagnostic = true;
		try {
			const event: DiagnosticEvent = {
				type,
				at: clock.now(),
				realm: "runtime",
				...(detail === undefined ? {} : { detail }),
			};
			if (history) {
				ring.push(event);
				if (ring.length > DIAGNOSTICS_RING) ring.shift();
				try {
					options.diagnostics?.(event);
				} catch {
					// A diagnostics sink must never break the runtime.
				}
			}
			if (diagnosticAttachments > 0) {
				for (const att of attachments.values()) {
					if (
						att.diagnostics &&
						(scope === undefined || att.scope === scope) &&
						att.k - att.kAcked < limits.maxControlMessages / 2
					) {
						control(att, { t: "diagnostic", event });
					}
				}
			}
		} finally {
			inDiagnostic = false;
		}
	}

	function call(action: () => void): void {
		try {
			action();
		} catch (error) {
			counters.handlerErrors += 1;
			diag("adapter-hook-error", { code: errorCode(error) });
		}
	}

	/** A per-consumer error record bounded by the recipient's maxMessageBytes. */
	function errorFor(att: Att, error: unknown): SerialisedError {
		return boundError(errorFields(error), att.limits.maxMessageBytes);
	}

	function armLease(): void {
		let earliest = Number.POSITIVE_INFINITY;
		for (const att of attachments.values()) {
			earliest = Math.min(earliest, att.deadline, att.controlDeadline);
		}
		if (earliest === Number.POSITIVE_INFINITY) {
			if (leaseTimer !== undefined) clock.clearTimeout(leaseTimer);
			leaseTimer = undefined;
			leaseDue = Number.POSITIVE_INFINITY;
			return;
		}
		if (leaseTimer !== undefined && leaseDue <= earliest) return;
		if (leaseTimer !== undefined) clock.clearTimeout(leaseTimer);
		const now = clock.now();
		leaseDelay = Math.max(0, earliest - now);
		leaseArmedAt = now;
		leaseDue = earliest;
		leaseTimer = clock.setTimeout(checkLeases, leaseDelay);
	}

	function checkLeases(): void {
		leaseTimer = undefined;
		leaseDue = Number.POSITIVE_INFINITY;
		const now = clock.now();
		const lateness = now - (leaseArmedAt + leaseDelay);
		if (lateness > gapThreshold(leaseDelay)) {
			// A scheduling gap (suspension) is not an absence: extend every lease
			// and exclude the gap from executable time.
			gapTotal += lateness;
			for (const att of attachments.values()) {
				// Pages were suspended too: give each a full lease to renew.
				att.deadline = Math.max(att.deadline + lateness, now + att.leaseMs);
				if (att.controlDeadline !== Number.POSITIVE_INFINITY) {
					att.controlDeadline = Math.max(
						att.controlDeadline + lateness,
						now + CONTROL_STALL_MS,
					);
				}
			}
			// Resuming from a detected suspension permits one fresh series and
			// one check per connection: the page's gap hint is never held back
			// by spacing measured before the gap.
			for (const group of groups.values()) {
				group.lastSeries = Number.NEGATIVE_INFINITY;
				group.lastProbe = Number.NEGATIVE_INFINITY;
			}
			diag("scheduling-gap", { ms: lateness });
		}
		for (const att of [...attachments.values()]) {
			if (att.deadline <= now) expire(att, "lease-expired");
			else if (att.controlDeadline <= now) {
				expire(att, "attachment-expired", "control-stalled");
			}
		}
		armLease();
	}

	function expire(
		att: Att,
		code: DetachCode,
		cause?: "control-queue" | "control-stalled",
	): void {
		if (att.closed) return;
		counters.expired += 1;
		diag(
			"attachment-expired",
			cause === undefined ? { reason: code } : { reason: code, cause },
		);
		release(att, code);
	}

	/** Retire an attachment: consumers, ledger, commands and asks are released. */
	function release(att: Att, code?: DetachCode, closePort = true): void {
		if (att.closed) return;
		att.closed = true;
		attachments.delete(att.a);
		if (att.diagnostics) diagnosticAttachments -= 1;
		for (const consumer of [...att.consumers.values()])
			removeConsumer(consumer);
		// Retiring the whole attachment is the only bookkeeping that releases
		// posted-but-unacknowledged debt.
		att.ledgers.clear();
		att.count = 0;
		att.bytes = 0;
		att.gapDue.clear();
		att.outbox.length = 0;
		att.queuedControl = 0;
		att.queuedControlBytes = 0;
		att.queuedData = 0;
		att.queuedDataBytes = 0;
		att.controlDeadline = Number.POSITIVE_INFINITY;
		for (const pending of att.commands.values()) {
			pending.settled = true;
			clock.clearTimeout(pending.timer);
			pending.controller.abort();
			pending.group.commands -= 1;
			maybeIdle(pending.group);
		}
		att.commands.clear();
		broker.retire(att);
		if (code) send(att, { t: "detached", code });
		att.holder.att = undefined;
		if (closePort) {
			try {
				att.holder.port.close();
			} catch {
				// Closing an already closed port is harmless.
			}
			holders.delete(att.holder);
		}
		if (!scopeIsLive(att.scope)) {
			broker.drop(att.scope);
			for (const group of [...groups.values()]) {
				if (group.scope === att.scope && group.idle !== undefined) {
					closeGroup(group);
				}
			}
		}
		armLease();
	}

	/** Whether the scope still has a group that could use its grant. */
	const scopeHasGrantUsers = (scope: string) => {
		for (const group of groups.values()) {
			// Anonymous groups never use the grant, so they do not keep it.
			if (group.scope === scope && !group.anonymous) return true;
		}
		return false;
	};

	const scopeIsLive = (scope: string) => {
		for (const att of attachments.values()) {
			if (att.scope === scope) return true;
		}
		return false;
	};

	function openGroup(
		adapter: AnyRuntimeAdapter,
		att: Att,
		scope: string,
		spec: unknown,
	): Group {
		if (att.anonymous && isPlainObject(spec) && spec.authHeaders === true) {
			throw new SpinetabError(
				"unsupported-option",
				"request.connection.authHeaders: true needs a credentials provider, but this page declared anonymous: true on createSpinetab; remove one of the two.",
				{ detail: { path: "request.connection.authHeaders" } },
			);
		}
		adapter.validateConnection?.(spec);
		if (isPlainObject(spec) && "url" in spec) {
			assertAbsoluteEndpoint(spec.url, "request.connection.url");
		}
		if (isPlainObject(spec) && spec.authHeaders === true) {
			// Requiring provider headers for a URL outside the credential
			// audience fails now, not at the first credentials call.
			try {
				judgeAudience(spec.url, audience);
			} catch {
				throw new SpinetabError(
					"unsupported-option",
					"request.connection.authHeaders: true sends provider credentials, but the URL is neither the worker's origin nor listed in credentialOrigins, or is not https:; add the origin to credentialOrigins in the Spinetab plugin options or your worker file, or remove authHeaders.",
					{ detail: { path: "request.connection.authHeaders" } },
				);
			}
		}
		const canonical =
			adapter.connectionKey?.(spec) ??
			stableStringify(spec, "request.connection");
		const key = connectionKey(adapter.kind, scope, canonical, att.anonymous);
		const existing = groups.get(key);
		if (existing) {
			cancelIdle(existing);
			return existing;
		}
		if (groups.size >= limits.maxConnections) {
			throw limitExceeded("maxConnections", limits.maxConnections);
		}
		const group: Group = {
			key,
			adapter,
			scope,
			anonymous: att.anonymous,
			url:
				isPlainObject(spec) && typeof spec.url === "string"
					? spec.url
					: undefined,
			abort: new AbortController(),
			status: { state: "connecting", since: clock.now() },
			codeBytes: 0,
			subs: new Map(),
			commands: 0,
			credentialWaits: 0,
			lastProbe: Number.NEGATIVE_INFINITY,
			lastSeries: Number.NEGATIVE_INFINITY,
			closed: false,
		};
		groups.set(key, group);
		const ctx: ConnectionContext = {
			scope,
			key,
			limits,
			signal: group.abort.signal,
			credentials: async (reason, url) => {
				if (group.closed) throw aborted();
				// An anonymous page supplies no credentials: nobody is asked and
				// nothing carries a revision, so rejecting it is a no-op.
				if (group.anonymous) return {};
				// Nothing would be attached when nobody can supply credentials, so
				// that outcome comes first; the audience is judged only when a grant
				// could be handed out.
				if (!broker.canSupply(scope)) throw noCredentialSource();
				judgeAudience(url ?? group.url, audience);
				group.credentialWaits += 1;
				try {
					const grant = await broker.request(scope, reason);
					if (group.closed) throw aborted();
					handed.set(grant.credentials, {
						scope,
						revision: grant.revision,
					});
					return grant.credentials;
				} finally {
					group.credentialWaits -= 1;
					maybeIdle(group);
				}
			},
			ownOrigin: (url) => isOwnOrigin(url),
			rejectCredentials: (credentials) => {
				// Only the grant attached to the failing request is rejected; no
				// argument, {} or an object the runtime never handed out names no
				// grant and rejects nothing.
				const grant =
					typeof credentials === "object" && credentials !== null
						? handed.get(credentials)
						: undefined;
				if (grant && hasProviderMaterial(credentials as Credentials)) {
					broker.reject(grant.scope, grant.revision);
				}
			},
			setStatus: (status) => setGroupStatus(group, status),
			diagnostic: (event) => {
				// Adapter-supplied diagnostics are bounded like other control
				// content.
				const bounded = boundDiagnostic(event, limits.maxMessageBytes);
				diag(bounded.type, bounded.detail, scope);
			},
			now: execNow,
		};
		try {
			group.conn = adapter.connect(spec, ctx);
		} catch (error) {
			group.closed = true;
			groups.delete(key);
			group.abort.abort();
			throw error;
		}
		raise("connections", groups.size);
		return group;
	}

	function cancelIdle(group: Group): void {
		if (group.idle !== undefined) clock.clearTimeout(group.idle);
		group.idle = undefined;
	}

	function maybeIdle(group: Group): void {
		if (
			group.closed ||
			group.subs.size > 0 ||
			group.commands > 0 ||
			group.credentialWaits > 0 ||
			group.idle !== undefined
		) {
			return;
		}
		if (!scopeIsLive(group.scope)) {
			// A scope end closes its unused connections immediately.
			closeGroup(group);
			return;
		}
		const idleMs = Math.min(
			group.adapter.idleCloseMs ?? limits.idleCloseMs,
			LIMIT_CAPS.idleCloseMs ?? 60_000,
		);
		group.idle = clock.setTimeout(() => {
			group.idle = undefined;
			if (
				group.subs.size === 0 &&
				group.commands === 0 &&
				group.credentialWaits === 0
			) {
				closeGroup(group);
			}
		}, idleMs);
	}

	function closeGroup(group: Group): void {
		if (group.closed) return;
		group.closed = true;
		cancelIdle(group);
		groups.delete(group.key);
		for (const sub of group.subs.values()) {
			sub.closed = true;
			clearLinger(sub);
		}
		group.subs.clear();
		group.abort.abort();
		call(() => group.conn?.dispose());
		// A connection that outlived its scope's last page must not leave
		// credential state behind, and the
		// scope's last connection takes its cached grant with it.
		if (!scopeIsLive(group.scope)) broker.drop(group.scope);
		else if (!scopeHasGrantUsers(group.scope)) broker.forget(group.scope);
		diag("connection-closed", { adapter: group.adapter.kind });
	}

	function setGroupStatus(
		group: Group,
		status: Omit<ConnectionStatus, "since">,
	): void {
		if (group.closed) return;
		const next = compactStatus(status, clock.now());
		if (sameStatus(group.status, next)) return;
		group.status = next;
		group.codeBytes =
			typeof next.code === "string" ? contentBytes(next.code) : 0;
		for (const [att, ids] of consumersByAttachment(group.subs.values())) {
			control(att, {
				t: "status",
				c: ids.length === 1 ? (ids[0] as string) : ids,
				connection: statusFor(att, group),
			});
		}
	}

	/** The group's status with an oversized adapter `code` omitted for `att`. */
	function statusFor(att: Att, group: Group): ConnectionStatus {
		if (group.codeBytes <= att.limits.maxMessageBytes) return group.status;
		const { code: _omitted, ...rest } = group.status;
		return rest;
	}

	function consumersByAttachment(
		subs: Iterable<Upstream>,
		filter?: (consumer: Consumer) => boolean,
	): Map<Att, string[]> {
		const byAtt = new Map<Att, string[]>();
		for (const sub of subs) {
			for (const consumer of sub.consumers.values()) {
				if (filter && !filter(consumer)) continue;
				const ids = byAtt.get(consumer.att);
				if (ids) ids.push(consumer.c);
				else byAtt.set(consumer.att, [consumer.c]);
			}
		}
		return byAtt;
	}

	function scheduleLinger(sub: Upstream): void {
		clearLinger(sub);
		sub.linger = clock.setTimeout(() => {
			sub.linger = undefined;
			if (sub.consumers.size === 0 && !sub.closed) closeUpstream(sub);
		}, limits.lingerMs);
	}

	function clearLinger(sub: Upstream): void {
		if (sub.linger !== undefined) clock.clearTimeout(sub.linger);
		sub.linger = undefined;
	}

	function closeUpstream(sub: Upstream): void {
		if (sub.closed) return;
		sub.closed = true;
		clearLinger(sub);
		sub.group.subs.delete(sub.key);
		call(() => sub.handle?.unsubscribe());
		maybeIdle(sub.group);
	}

	function sinkFor(sub: Upstream): SubscriptionSink {
		const sink: SubscriptionSink = {
			next: (event, meta) => {
				if (!sub.closed) deliver(sub, event, meta);
			},
			error: (error) =>
				terminal(sub, {
					kind: "error",
					error: serialiseError(error),
				}),
			complete: () => terminal(sub, { kind: "complete" }),
			continuity: (reason, detail) => {
				if (!sub.closed)
					broadcastContinuity(sub, reason, detail, isInterruption(sink));
			},
			started: () => {
				sub.started = true;
			},
		};
		return sink;
	}

	function broadcastContinuity(
		sub: Upstream,
		reason: ContinuityReason,
		detail: ContinuityDetail | undefined,
		pending = false,
	): void {
		const state = CONTINUITY_STATE[reason];
		if (!state) return;
		const since = clock.now();
		const continuity: Continuity = {
			state,
			reason,
			since,
			...pickContinuityDetail(detail),
		};
		// A resume used one cursor; consumers that re-registered with a
		// different cursor cannot claim it, so they are told `unknown`.
		const diverged = (consumer: Consumer) =>
			state === "resumed" &&
			consumer.cursor !== undefined &&
			consumer.cursor !== detail?.cursor;
		const unknown: Continuity = {
			state: "unknown",
			reason: "reconnected",
			since,
		};
		// An adapter cursor is never truncated: one larger than the recipient's
		// maxMessageBytes is omitted. Measured once.
		const cursorBytes =
			continuity.cursor === undefined ? 0 : contentBytes(continuity.cursor);
		for (const variant of [false, true]) {
			for (const [att, ids] of consumersByAttachment(
				[sub],
				(consumer) =>
					consumer.stopped === undefined && diverged(consumer) === variant,
			)) {
				control(att, {
					t: "continuity",
					c: ids.length === 1 ? (ids[0] as string) : ids,
					...(pending ? { pending: true } : {}),
					continuity: variant
						? unknown
						: boundContinuity(
								continuity,
								att.limits.maxMessageBytes,
								cursorBytes,
							),
				});
			}
		}
		for (const consumer of sub.consumers.values()) consumer.cursor = undefined;
	}

	function terminal(sub: Upstream, outcome: Terminal): void {
		if (sub.closed) return;
		sub.closed = true;
		clearLinger(sub);
		sub.group.subs.delete(sub.key);
		// Terminal messages follow all prior data in the consumer's sequence and
		// are control messages, so exhausted data credits never block them. An
		// adapter error's size is measured once and bounded per recipient.
		const errorBytes =
			outcome.kind === "error" ? contentBytes(outcome.error) : 0;
		// A withheld gap notice or final missed count must never be overtaken by
		// the terminal event: the page would see the end without learning what
		// it missed.
		for (const [att, ids] of consumersByAttachment([sub])) {
			const members = new Set(ids);
			flushGaps(att, (consumer) => members.has(consumer.c));
		}
		for (const consumer of [...sub.consumers.values()]) {
			const { att } = consumer;
			if (att.closed) continue;
			consumer.seq += 1;
			control(att, {
				t: "event",
				c: consumer.c,
				seq: consumer.seq,
				...(outcome.kind === "error"
					? {
							kind: "error",
							error: boundError(
								outcome.error,
								att.limits.maxMessageBytes,
								errorBytes,
							),
						}
					: outcome),
			});
			if (att.consumers.get(consumer.c) === consumer) {
				att.consumers.delete(consumer.c);
			}
			dropEmptyLedger(att, consumer.c);
		}
		sub.consumers.clear();
		call(() => sub.handle?.unsubscribe());
		maybeIdle(sub.group);
	}

	function deliver(sub: Upstream, event: unknown, meta?: SinkNextMeta): void {
		// Estimated once per upstream event and shared across consumers. The
		// estimate doubles as the cloneability pre-check; `postMessage` is
		// still guarded because estimation is not proof of cloneability.
		const estimate = estimateBytes(event);
		// Variable-sized envelope metadata (the event cursor) is charged with
		// the content; it is never truncated, so an oversized cursor makes the
		// event `message-too-large`. The fixed envelope
		// fields (short ids and integers) are not charged.
		const idBytes = sumBytes(
			meta?.eventId === undefined ? 0 : estimateBytes(meta.eventId),
			meta?.event === undefined ? 0 : estimateBytes(meta.event),
		);
		const chargeOf = (bytes: number | undefined) =>
			bytes === undefined || idBytes === undefined
				? undefined
				: Math.max(bytes, meta?.bytes !== undefined ? meta.bytes : 0) + idBytes;
		const charge = chargeOf(estimate);
		// Consumers whose attachment has an outbox get the event queued, so it
		// is retained: one structured-clone snapshot per event, taken lazily and
		// shared (the runtime never mutates it; each post copies it again), and
		// charged by its own estimate, the content actually retained and later
		// delivered. Direct posts are not cloned.
		let retained: { data: unknown; charge: number | undefined } | undefined;
		const snapshot = () => {
			if (retained === undefined) {
				const copy = clone(event);
				retained = copy
					? { data: copy.value, charge: chargeOf(estimateBytes(copy.value)) }
					: { data: undefined, charge: undefined };
			}
			return retained;
		};
		const only = meta?.consumers ? new Set(meta.consumers) : undefined;
		let uncloneable = charge === undefined;
		// Attachments with gap notices due from this event, flushed once below.
		const noticed = new Set<Att>();
		for (const consumer of [...sub.consumers.values()]) {
			if (only && !only.has(consumer.id)) continue;
			if (consumer.stopped) {
				noteMissed(consumer);
				noticed.add(consumer.att);
				continue;
			}
			if (uncloneable || charge === undefined) {
				stop(consumer, "event-not-serialisable");
				noticed.add(consumer.att);
				continue;
			}
			const { att } = consumer;
			const held = att.outbox.length > 0 ? snapshot() : undefined;
			const cost = held ? held.charge : charge;
			if (cost === undefined) {
				// The snapshot failed to clone: the direct path's DataCloneError.
				uncloneable = true;
				stop(consumer, "event-not-serialisable");
				noticed.add(att);
				continue;
			}
			if (cost > att.limits.maxMessageBytes) {
				stop(consumer, "message-too-large");
				noticed.add(att);
				continue;
			}
			const ledger = att.ledgers.get(consumer.c);
			if (!ledger || !admits(att, ledger, cost)) {
				stop(consumer, "overflow");
				noticed.add(att);
				continue;
			}
			const seq = consumer.seq + 1;
			const body: DataBody = {
				t: "event",
				c: consumer.c,
				seq,
				kind: "next",
				data: held ? held.data : event,
				...(meta?.eventId === undefined ? {} : { eventId: meta.eventId }),
				...(meta?.event === undefined ? {} : { event: meta.event }),
			};
			if (held) {
				// Queued behind control so the attachment keeps production order.
				att.outbox.push({ kind: "data", body, consumer, charge: cost });
				att.queuedData += 1;
				att.queuedDataBytes += cost;
				raise("dataQueued", att.queuedData);
				raise("dataQueuedBytes", att.queuedDataBytes);
			} else if (send(att, body)) {
				ledger.posted = seq;
			} else {
				// DataCloneError: nothing was posted, so nothing is charged.
				uncloneable = true;
				stop(consumer, "event-not-serialisable");
				noticed.add(att);
				continue;
			}
			consumer.seq = seq;
			ledger.seqs.push(seq);
			ledger.sizes.push(cost);
			ledger.count += 1;
			ledger.bytes += cost;
			att.count += 1;
			att.bytes += cost;
			raise("perConsumerMessages", ledger.count);
			raise("perConsumerBytes", ledger.bytes);
			raise("pendingMessages", att.count);
			raise("pendingBytes", att.bytes);
		}
		for (const att of noticed) flushGaps(att);
	}

	/** Projected admission against the per-consumer caps and the aggregate. */
	function admits(att: Att, ledger: Ledger, charge: number): boolean {
		const { limits: bounds } = att;
		return (
			ledger.count + 1 <= bounds.maxPendingMessagesPerConsumer &&
			ledger.bytes + charge <= bounds.maxPendingBytesPerConsumer &&
			att.count + 1 <= bounds.maxPendingMessages &&
			att.bytes + charge <= bounds.maxPendingBytes
		);
	}

	function stop(consumer: Consumer, reason: ContinuityReason): void {
		consumer.stopped = reason;
		consumer.missed = 1;
		consumer.reported = 0;
		diag("delivery-stopped", { reason });
		consumer.att.gapDue.add(consumer);
	}

	function noteMissed(consumer: Consumer): void {
		consumer.missed += 1;
		consumer.att.gapDue.add(consumer);
	}

	/**
	 * Post due gap notices for one attachment, batched with the existing
	 * `continuity{c: string[]}` form: one control message per stop reason,
	 * with each consumer's own missed count (`missed[i]` for `c[i]`), so a
	 * stalled page with many consumers cannot exhaust the control bound.
	 * Rules:
	 * - the first notice of a stop is due at once; a later count for the same
	 * consumer waits until its previous notice is acknowledged (coalesced);
	 * - gap notices use at most half the control window, so once a page stops
	 * acknowledging, the rest wait for its next acknowledgement and go as one
	 * batch; status, terminal and command replies keep the other half;
	 * - `force` (before a terminal event) bypasses the half-window gate for the
	 * selected consumers, so a stream's end never overtakes the first notice
	 * of what it missed. It also sends their final count update even while
	 * the previous notice is unacknowledged: the terminal
	 * event removes the consumer, so no later acknowledgement could publish
	 * it. The update is still one batched control message per stop reason,
	 * posted through `control()` and so charged to the control bound.
	 */
	function flushGaps(att: Att, force?: (consumer: Consumer) => boolean): void {
		if (att.closed || att.gapDue.size === 0) return;
		if (
			!force &&
			att.k - att.kAcked >=
				Math.max(1, Math.floor(limits.maxControlMessages / 2))
		) {
			return;
		}
		const byReason = new Map<ContinuityReason, Consumer[]>();
		for (const consumer of att.gapDue) {
			if (
				consumer.stopped === undefined ||
				att.consumers.get(consumer.c) !== consumer ||
				consumer.missed <= consumer.reported
			) {
				att.gapDue.delete(consumer);
				continue;
			}
			if (force && !force(consumer)) continue;
			if (!force && consumer.reported > 0 && consumer.noticeK > att.kAcked) {
				continue;
			}
			const list = byReason.get(consumer.stopped);
			if (list) list.push(consumer);
			else byReason.set(consumer.stopped, [consumer]);
		}
		for (const [reason, list] of byReason) {
			const since = clock.now();
			const [only] = list;
			const k = control(
				att,
				list.length === 1 && only
					? {
							t: "continuity",
							c: only.c,
							continuity: {
								state: "gap",
								reason,
								missed: only.missed,
								since,
							},
						}
					: {
							t: "continuity",
							c: list.map((consumer) => consumer.c),
							continuity: { state: "gap", reason, since },
							missed: list.map((consumer) => consumer.missed),
						},
			);
			if (k <= 0) return;
			for (const consumer of list) {
				consumer.noticeK = k;
				consumer.reported = consumer.missed;
				att.gapDue.delete(consumer);
			}
		}
	}

	function dropEmptyLedger(att: Att, c: string): void {
		const ledger = att.ledgers.get(c);
		if (ledger && ledger.count === 0 && !att.consumers.has(c)) {
			att.ledgers.delete(c);
		}
	}

	function removeConsumer(consumer: Consumer): void {
		const { att, sub } = consumer;
		if (sub.consumers.delete(consumer.id) && !sub.closed) {
			call(() => sub.handle?.consumerRemoved?.(consumer.id));
			if (sub.consumers.size === 0) scheduleLinger(sub);
		}
		if (att.consumers.get(consumer.c) === consumer) {
			att.consumers.delete(consumer.c);
		}
		att.gapDue.delete(consumer);
		// Posted debt stays on the ledger until acknowledged.
		dropEmptyLedger(att, consumer.c);
	}

	function onPortMessage(holder: Holder, data: unknown): void {
		try {
			const msg = parsePageMessage(data);
			if (!msg) {
				const foreign = foreignHello(data);
				if (foreign) {
					holder.port.postMessage({
						v: BRIDGE_VERSION,
						t: "reject",
						a: foreign.a,
						g: foreign.g,
						code: "incompatible-version",
						supported: [BRIDGE_VERSION],
						received: foreign.received,
					});
				}
				counters.invalidEnvelopes += 1;
				diag("invalid-envelope");
				return;
			}
			if (msg.t === "hello") {
				onHello(holder, msg);
				return;
			}
			const att = holder.att;
			if (!att || att.a !== msg.a || att.g !== msg.g) {
				onStale(holder, msg);
				return;
			}
			const now = clock.now();
			att.lastActive = now;
			att.deadline = now + att.leaseMs;
			dispatch(att, msg);
		} catch (error) {
			counters.handlerErrors += 1;
			diag("handler-error", { code: errorCode(error) });
		}
	}

	function onStale(holder: Holder, msg: PageMessage): void {
		counters.staleMessages += 1;
		if (msg.t === "detach" || holder.told.has(msg.a)) return;
		holder.told.add(msg.a);
		try {
			holder.port.postMessage({
				v: BRIDGE_VERSION,
				t: "detached",
				a: msg.a,
				g: msg.g,
				code: "attachment-expired",
			});
		} catch {
			// The port may already be closed.
		}
	}

	function onHello(
		holder: Holder,
		msg: Extract<PageMessage, { t: "hello" }>,
	): void {
		if (holder.att) {
			if (holder.att.a === msg.a && holder.att.g === msg.g) return;
			release(holder.att, undefined, false);
		}
		let delivery: DeliveryLimits;
		try {
			delivery = resolveDeliveryLimits(msg.limits, limits, "hello.limits");
		} catch {
			delivery = resolveDeliveryLimits(undefined, limits);
			diag("page-limits-ignored");
		}
		const leaseMs =
			msg.lease !== undefined && msg.lease > 0
				? Math.min(msg.lease, limits.leaseMs)
				: limits.leaseMs;
		const now = clock.now();
		const att: Att = {
			a: msg.a,
			g: msg.g,
			id: msg.a,
			holder,
			page: msg.page,
			scope: msg.scope,
			limits: delivery,
			leaseMs,
			hasCredentials: msg.credentials === true && msg.anonymous !== true,
			anonymous: msg.anonymous === true,
			diagnostics: msg.diagnostics === true,
			lastActive: now,
			deadline: now + leaseMs,
			visible: msg.visible !== false,
			consumers: new Map(),
			ledgers: new Map(),
			count: 0,
			bytes: 0,
			k: 0,
			kPosted: 0,
			kAcked: 0,
			outbox: [],
			queuedControl: 0,
			queuedControlBytes: 0,
			queuedData: 0,
			queuedDataBytes: 0,
			controlDeadline: Number.POSITIVE_INFINITY,
			commands: new Map(),
			gapDue: new Set(),
			closed: false,
			request: (requestId, body) =>
				control(att, { t: "credentialsRequest", id: requestId, ...body }) > 0,
		};
		attachments.set(att.a, att);
		holder.att = att;
		if (att.diagnostics) diagnosticAttachments += 1;
		send(att, {
			t: "welcome",
			runtime: id,
			limits: { ...limits },
			adapters: adapterInfo,
			lease: leaseMs,
			// This runtime honours the subscribe replay marker.
			replay: true,
		});
		diag("attached", { scopeHash: att.scope.length });
		if (att.hasCredentials) {
			// Only a page with a provider may move its scope's revision.
			broker.observe(att.scope, msg.revision, false);
			// A newly available credential source unblocks waiting connections.
			for (const group of groups.values()) {
				if (
					group.scope === att.scope &&
					group.status.state === "auth-blocked" &&
					(group.status.reason === "no-credential-source" ||
						group.status.reason === "credentials-missing")
				) {
					call(() => group.conn?.rotate?.());
				}
			}
		}
		armLease();
	}

	function dispatch(att: Att, msg: PageMessage): void {
		switch (msg.t) {
			case "subscribe":
				onSubscribe(att, msg);
				return;
			case "unsubscribe": {
				const consumer = att.consumers.get(msg.c);
				if (consumer) removeConsumer(consumer);
				return;
			}
			case "update": {
				const consumer = att.consumers.get(msg.c);
				if (!consumer || consumer.sub.closed) return;
				try {
					consumer.sub.group.adapter.validateConsumer?.(msg.consumer);
				} catch (error) {
					control(att, { t: "error", c: msg.c, ...errorFor(att, error) });
					return;
				}
				consumer.options = msg.consumer;
				call(() =>
					consumer.sub.handle?.consumerUpdated?.(consumer.id, msg.consumer),
				);
				return;
			}
			case "ack":
				onAck(att, msg);
				return;
			case "reconcile": {
				const consumer = att.consumers.get(msg.c);
				if (consumer?.stopped) {
					consumer.stopped = undefined;
					consumer.missed = 0;
					consumer.reported = 0;
					att.gapDue.delete(consumer);
				}
				return;
			}
			case "command":
				onCommand(att, msg);
				return;
			case "cancel": {
				const pending = att.commands.get(msg.id);
				if (!pending || pending.settled) return;
				pending.settled = true;
				clock.clearTimeout(pending.timer);
				att.commands.delete(msg.id);
				pending.group.commands -= 1;
				pending.controller.abort();
				maybeIdle(pending.group);
				return;
			}
			case "credentials":
				broker.reply(att, msg.id, msg);
				return;
			case "revision":
				if (att.hasCredentials) {
					broker.observe(att.scope, msg.revision, msg.restart);
				}
				return;
			case "probe":
				control(att, { t: "probeResult", id: msg.id, runtime: id });
				if (msg.hint) {
					for (const group of groupsOf(att)) hintGroup(group);
				}
				return;
			case "renew":
				return;
			case "retry": {
				const now = execNow();
				// With `c`, only that consumer's connection.
				const targets =
					msg.c === undefined
						? groupsOf(att)
						: [att.consumers.get(msg.c)?.sub.group].filter(
								(group): group is Group => group !== undefined,
							);
				for (const group of targets) {
					const state = group.status.state;
					if (
						(state === "retry-exhausted" ||
							state === "failed" ||
							state === "auth-blocked") &&
						spaced(now, group.lastSeries, EXPLICIT_RETRY_COALESCE_MS)
					) {
						group.lastSeries = now;
						call(() => group.conn?.retry?.());
					}
				}
				return;
			}
			case "visibility":
				if (att.visible === msg.visible) return;
				att.visible = msg.visible;
				for (const consumer of [...att.consumers.values()]) {
					call(() =>
						consumer.sub.handle?.consumerVisibility?.(consumer.id, msg.visible),
					);
				}
				return;
			case "detach":
				diag("detached");
				release(att);
				return;
			case "hello":
				return;
		}
	}

	function groupsOf(att: Att): Set<Group> {
		const found = new Set<Group>();
		for (const consumer of att.consumers.values())
			found.add(consumer.sub.group);
		return found;
	}

	/** Lifecycle-hint check: at most one per connection per spacing window. */
	function hintGroup(group: Group): void {
		const now = execNow();
		const state = group.status.state;
		if (state === "retry-exhausted") {
			if (spaced(now, group.lastSeries, HINT_SERIES_SPACING_MS)) {
				group.lastSeries = now;
				call(() => group.conn?.retry?.());
			}
			return;
		}
		if (state === "failed" || state === "auth-blocked") return;
		if (spaced(now, group.lastProbe, HINT_PROBE_SPACING_MS)) {
			group.lastProbe = now;
			call(() => group.conn?.probe?.());
		}
	}

	function onAck(att: Att, msg: Extract<PageMessage, { t: "ack" }>): void {
		if (msg.c !== undefined && msg.seq !== undefined) {
			const ledger = att.ledgers.get(msg.c);
			if (ledger) {
				// Only sequences already handed to the port can be acknowledged:
				// an acknowledgement ahead of them never releases queued debt.
				const seq = Math.min(msg.seq, ledger.posted);
				while (ledger.count > 0 && (ledger.seqs[0] as number) <= seq) {
					ledger.seqs.shift();
					const size = ledger.sizes.shift() as number;
					ledger.count -= 1;
					ledger.bytes -= size;
					att.count -= 1;
					att.bytes -= size;
				}
				dropEmptyLedger(att, msg.c);
			}
		}
		if (msg.k !== undefined) {
			// A page can only acknowledge what was posted, not what is queued.
			const acked = Math.min(msg.k, att.kPosted);
			if (acked > att.kAcked) {
				att.kAcked = acked;
				// Queued messages go first, in order; then withheld gap notices,
				// batched.
				pump(att);
				flushGaps(att);
			}
		}
	}

	function onSubscribe(
		att: Att,
		msg: Extract<PageMessage, { t: "subscribe" }>,
	): void {
		const { c, request } = msg;
		if (att.consumers.has(c)) return;
		if (att.ledgers.has(c)) {
			control(att, {
				t: "error",
				c,
				code: "invalid-envelope",
				message:
					"Consumer id reused while its earlier deliveries are unacknowledged.",
			});
			return;
		}
		let group: Group | undefined;
		try {
			if (att.consumers.size >= limits.maxConsumersPerAttachment) {
				throw limitExceeded(
					"maxConsumersPerAttachment",
					limits.maxConsumersPerAttachment,
				);
			}
			const scope = request.scope ?? att.scope;
			if (scope !== att.scope) {
				throw new SpinetabError(
					"unsupported-option",
					"request.scope must match the client's scope; change scope with setScope().",
					{ detail: { path: "request.scope" } },
				);
			}
			const adapter = adapterFor(request.adapter);
			adapter.validateSubscription?.(request.subscription);
			adapter.validateConsumer?.(msg.options);
			const spec = request.subscription;
			const repeatable =
				(adapter.repeatable?.(spec) ?? true) && request.repeatable !== false;
			if (msg.replay === true && !repeatable) {
				// A page re-registering intent after runtime loss: non-repeatable
				// work is never restarted, whatever the page knew. Nothing
				// upstream is touched; the page ends the handle.
				throw new SpinetabError(
					"interrupted",
					"The runtime was replaced and this subscription cannot be restarted automatically; its outcome is unknown.",
				);
			}
			group = openGroup(adapter, att, scope, request.connection);
			const share = request.share ?? "always";
			const canonical =
				(adapter.shareable?.(spec) ?? true)
					? (adapter.subscriptionKey?.(spec) ??
						stableStringify(spec, "request.subscription"))
					: uniqueKey();
			const key = subscriptionKey(
				group.key,
				`${canonical}|${repeatable ? "repeatable" : "once"}|${share}`,
			);
			let sub = group.subs.get(key);
			if (sub && share === "before-start" && sub.started) {
				throw new SpinetabError(
					"late-join-unsupported",
					"This stream has started; it can only be joined before its first event.",
				);
			}
			const isNew = !sub;
			if (!sub) {
				if (countSubscriptions() >= limits.maxSubscriptions) {
					throw limitExceeded("maxSubscriptions", limits.maxSubscriptions);
				}
				sub = {
					key,
					group,
					consumers: new Map(),
					started: false,
					closed: false,
				};
				group.subs.set(key, sub);
				cancelIdle(group);
			} else {
				clearLinger(sub);
			}
			const consumer: Consumer = {
				c,
				id: `${att.a}/${c}`,
				att,
				sub,
				options: msg.options,
				seq: 0,
				missed: 0,
				reported: 0,
				noticeK: 0,
				...(msg.cursor === undefined ? {} : { cursor: msg.cursor }),
			};
			sub.consumers.set(consumer.id, consumer);
			att.consumers.set(c, consumer);
			att.ledgers.set(c, {
				seqs: [],
				sizes: [],
				count: 0,
				bytes: 0,
				posted: 0,
			});
			raise("consumersPerAttachment", att.consumers.size);
			if (isNew) raise("subscriptions", countSubscriptions());
			// The current snapshot arrives before any event.
			control(att, {
				t: "status",
				c,
				connection: statusFor(att, group),
				repeatable,
			});
			const upstream = sub;
			if (isNew) {
				try {
					upstream.handle = group.conn?.subscribe(spec, sinkFor(upstream), {
						key,
						repeatable,
						...(msg.cursor === undefined ? {} : { cursor: msg.cursor }),
					});
				} catch (error) {
					terminal(upstream, {
						kind: "error",
						error: toSerialisedError(error, "subscribe-rejected"),
					});
					return;
				}
				if (upstream.closed) {
					call(() => upstream.handle?.unsubscribe());
					return;
				}
			}
			if (!upstream.closed && upstream.consumers.has(consumer.id)) {
				call(() =>
					upstream.handle?.consumerAdded?.(consumer.id, consumer.options, {
						visible: att.visible,
					}),
				);
			}
		} catch (error) {
			if (group) maybeIdle(group);
			control(att, { t: "error", c, ...errorFor(att, error) });
		}
	}

	function onCommand(
		att: Att,
		msg: Extract<PageMessage, { t: "command" }>,
	): void {
		if (att.commands.has(msg.id)) return;
		const reply = (result: CommandOutcome) => {
			// Application replies never cross larger than maxMessageBytes; the
			// outcome is reclassified honestly instead.
			const outcome = boundOutcome(result, att.limits.maxMessageBytes);
			if (control(att, { t: "commandResult", id: msg.id, outcome }) === -1) {
				control(att, {
					t: "commandResult",
					id: msg.id,
					outcome: notSerialisableOutcome(),
				});
			}
		};
		let group: Group | undefined;
		try {
			if (att.commands.size >= limits.maxPendingCommands) {
				throw limitExceeded("maxPendingCommands", limits.maxPendingCommands);
			}
			const scope = msg.request.scope ?? att.scope;
			if (scope !== att.scope) {
				throw new SpinetabError(
					"unsupported-option",
					"request.scope must match the client's scope.",
					{ detail: { path: "request.scope" } },
				);
			}
			const adapter = adapterFor(msg.request.adapter);
			group = openGroup(adapter, att, scope, msg.request.connection);
			const conn = group.conn;
			if (!conn?.command) {
				throw new SpinetabError(
					"command-not-sent",
					`Adapter ${adapter.kind} does not support commands.`,
					{ detail: { adapter: adapter.kind } },
				);
			}
			if (group.commands >= limits.maxPendingCommands) {
				throw limitExceeded("maxPendingCommands", limits.maxPendingCommands);
			}
			const owner = group;
			const pending: PendingCommand = {
				group: owner,
				controller: new AbortController(),
				settled: false,
			};
			const settle = (outcome: CommandOutcome) => {
				if (pending.settled) return;
				pending.settled = true;
				clock.clearTimeout(pending.timer);
				att.commands.delete(msg.id);
				owner.commands -= 1;
				if (!att.closed) reply(normaliseOutcome(outcome));
				maybeIdle(owner);
			};
			owner.commands += 1;
			att.commands.set(msg.id, pending);
			raise("pendingCommands", Math.max(owner.commands, att.commands.size));
			// Any page may send any integer: clamp it to what a host timer can
			// wait.
			const timeoutMs = Math.min(MAX_TIMER_MS, Math.max(1, msg.timeoutMs));
			pending.timer = clock.setTimeout(() => {
				settle({
					status: "unknown",
					error: {
						code: "command-unknown",
						message: "The command did not settle before its timeout.",
						detail: { reason: "timeout" },
					},
				});
				pending.controller.abort();
			}, timeoutMs);
			let result: Promise<CommandOutcome>;
			try {
				result = conn.command(msg.request.payload, {
					id: msg.id,
					signal: pending.controller.signal,
					timeoutMs,
				});
			} catch (error) {
				// A synchronous throw means nothing reached the wire.
				settle({
					status: "not-sent",
					error: toSerialisedError(error, "command-not-sent"),
				});
				return;
			}
			Promise.resolve(result).then(
				(outcome) => settle(outcome),
				(error) =>
					settle({
						status: "unknown",
						error: toSerialisedError(error, "command-unknown"),
					}),
			);
		} catch (error) {
			if (group) maybeIdle(group);
			reply({ status: "not-sent", error: errorFields(error) });
		}
	}

	function adapterFor(kind: string): AnyRuntimeAdapter {
		const adapter = adapters.get(kind);
		if (!adapter) throw adapterNotRegistered(kind);
		return adapter;
	}

	const countSubscriptions = () => {
		let total = 0;
		for (const group of groups.values()) total += group.subs.size;
		return total;
	};

	/** Restart the marks from the current levels (what is held now counts). */
	function resetMarks(): void {
		Object.assign(hwm, zeroMarks());
		raise("subscriptions", countSubscriptions());
		raise("connections", groups.size);
		for (const group of groups.values()) {
			raise("pendingCommands", group.commands);
		}
		for (const att of attachments.values()) {
			raise("pendingMessages", att.count);
			raise("pendingBytes", att.bytes);
			raise("pendingCommands", att.commands.size);
			raise("controlMessages", att.kPosted - att.kAcked);
			raise("controlQueued", att.queuedControl);
			raise("controlQueuedBytes", att.queuedControlBytes);
			raise("dataQueued", att.queuedData);
			raise("dataQueuedBytes", att.queuedDataBytes);
			raise("consumersPerAttachment", att.consumers.size);
			for (const ledger of att.ledgers.values()) {
				raise("perConsumerMessages", ledger.count);
				raise("perConsumerBytes", ledger.bytes);
			}
		}
	}

	return {
		id,
		accept(port: MessagePort): void {
			if (disposed) {
				try {
					port.close();
				} catch {
					// Nothing to release.
				}
				return;
			}
			const holder: Holder = { port, told: new Set() };
			holders.add(holder);
			port.addEventListener("message", (event) =>
				onPortMessage(holder, (event as MessageEvent).data),
			);
			port.addEventListener("messageerror", () => {
				counters.messageErrors += 1;
				diag("messageerror");
			});
			// MessagePort `close` is a hint only; leases remain the mechanism.
			port.addEventListener("close", () => {
				holders.delete(holder);
				if (!holder.att) return;
				diag("port-closed");
				release(holder.att);
			});
			port.start();
			// Announce this runtime on every accepted port before any hello, so
			// a page can reconnect promptly when an engine replaces its SharedWorker.
			accepted += 1;
			try {
				port.postMessage({
					v: BRIDGE_VERSION,
					t: "announce",
					runtime: id,
					generation: accepted,
				});
			} catch {
				// A closed port has no page to tell.
			}
		},
		dispose(): void {
			if (disposed) return;
			disposed = true;
			for (const att of [...attachments.values()]) {
				release(att, "runtime-disposed");
			}
			for (const group of [...groups.values()]) {
				for (const sub of group.subs.values()) {
					sub.closed = true;
					clearLinger(sub);
					call(() => sub.handle?.unsubscribe());
				}
				closeGroup(group);
			}
			for (const holder of holders) {
				try {
					holder.port.close();
				} catch {
					// Already closed.
				}
			}
			holders.clear();
			if (leaseTimer !== undefined) clock.clearTimeout(leaseTimer);
			leaseTimer = undefined;
		},
		stats(options?: RuntimeStatsOptions): RuntimeStats {
			const perAttachment: AttachmentStats[] = [];
			let consumers = 0;
			let ledgers = 0;
			let pendingMessages = 0;
			let pendingBytes = 0;
			let pendingCommands = 0;
			for (const att of attachments.values()) {
				consumers += att.consumers.size;
				ledgers += att.ledgers.size;
				pendingMessages += att.count;
				pendingBytes += att.bytes;
				pendingCommands += att.commands.size;
				perAttachment.push({
					a: att.a,
					g: att.g,
					scope: att.scope,
					consumers: att.consumers.size,
					ledgers: att.ledgers.size,
					pendingMessages: att.count,
					pendingBytes: att.bytes,
					pendingControl: att.kPosted - att.kAcked,
					queuedControl: att.queuedControl,
					queuedControlBytes: att.queuedControlBytes,
					queuedData: att.queuedData,
					queuedDataBytes: att.queuedDataBytes,
				});
			}
			const snapshot: RuntimeStats = {
				id,
				attachments: attachments.size,
				consumers,
				ledgers,
				pendingMessages,
				pendingBytes,
				connections: groups.size,
				subscriptions: countSubscriptions(),
				pendingCommands,
				pendingCredentialRequests: broker.pending(),
				...counters,
				perAttachment,
				diagnostics: [...ring],
				hwm: { ...hwm },
			};
			if (options?.resetHwm === true) resetMarks();
			return snapshot;
		},
	};
}

function zeroMarks(): RuntimeHighWaterMarks {
	return {
		pendingMessages: 0,
		pendingBytes: 0,
		perConsumerMessages: 0,
		perConsumerBytes: 0,
		pendingCommands: 0,
		controlMessages: 0,
		controlQueued: 0,
		controlQueuedBytes: 0,
		dataQueued: 0,
		dataQueuedBytes: 0,
		subscriptions: 0,
		consumersPerAttachment: 0,
		connections: 0,
	};
}

function registerAdapters(
	list: readonly AnyRuntimeAdapter[],
): Map<string, AnyRuntimeAdapter> {
	if (!Array.isArray(list)) {
		throw new SpinetabError(
			"unsupported-option",
			"runtime.adapters must be an array of adapter definitions.",
			{ detail: { path: "runtime.adapters" } },
		);
	}
	const adapters = new Map<string, AnyRuntimeAdapter>();
	list.forEach((adapter, index) => {
		const path = `runtime.adapters[${index}]`;
		if (
			!adapter ||
			typeof adapter.kind !== "string" ||
			adapter.kind.length === 0 ||
			typeof adapter.connect !== "function" ||
			!Number.isInteger(adapter.version)
		) {
			throw new SpinetabError(
				"unsupported-option",
				`${path} is not an adapter definition (kind, version and connect are required).`,
				{ detail: { path } },
			);
		}
		if (adapters.has(adapter.kind)) {
			throw new SpinetabError(
				"unsupported-option",
				`${path}: adapter kind ${adapter.kind} is registered twice.`,
				{ detail: { path, adapter: adapter.kind } },
			);
		}
		adapters.set(adapter.kind, adapter);
	});
	return adapters;
}

let workerOriginOverride: string | null | undefined;

/**
 * Internal test seam, never exported from a public entry: the origin the
 * credential audience is judged against when Node has no `location`. `null`
 * means "no origin"; `undefined` restores `globalThis.location?.origin`.
 */
export function setWorkerOriginForTests(
	origin: string | null | undefined,
): void {
	workerOriginOverride = origin;
}

const SECURE_SCHEME: Record<string, boolean> = {
	"https:": true,
	"wss:": true,
	"http:": false,
	"ws:": false,
};

/**
 * An http(s) or ws(s) URL without userinfo as its credential origin, `wss:`
 * compared as `https:` and `ws:` as `http:`; undefined for anything else.
 */
function endpointOf(
	url: unknown,
): { origin: string; secure: boolean; loopback: boolean } | undefined {
	let parsed: URL;
	try {
		parsed = new URL(url as string);
	} catch {
		return undefined;
	}
	const secure = SECURE_SCHEME[parsed.protocol];
	if (secure === undefined || parsed.username || parsed.password) {
		return undefined;
	}
	return {
		origin: `${secure ? "https:" : "http:"}//${parsed.host}`,
		secure,
		loopback: isLoopbackHost(parsed.hostname),
	};
}

const AUDIENCE_MESSAGE = {
	url: "Provider credentials need an absolute http(s) or ws(s) URL without userinfo to judge where they go.",
	tls: "Provider credentials go only over https: or wss:, or to a loopback host.",
	audience:
		"Provider credentials go only to the worker's own origin or an origin in credentialOrigins; add the origin to credentialOrigins in the Spinetab plugin options or your worker file, or declare anonymous: true.",
} as const;

/**
 * Provider material may go only to the worker's own origin (loopback
 * counts as its own when the worker runs on loopback) or a listed origin, and
 * only over TLS unless the host is loopback. Exact origin comparison, never a
 * hostname suffix; the message never carries the URL.
 */
/** The worker's own origin as an endpoint, honouring the test seam. */
function ownEndpoint() {
	const override = workerOriginOverride;
	return endpointOf(
		override !== undefined
			? override
			: (globalThis as { location?: { origin?: unknown } }).location?.origin,
	);
}

/** Is `url` on the worker's own origin (loopback counts when the worker is loopback)? */
function isOwnOrigin(url: unknown): boolean {
	const target = endpointOf(url);
	const own = ownEndpoint();
	return (
		target !== undefined &&
		own !== undefined &&
		(target.origin === own.origin || (target.loopback && own.loopback))
	);
}

function judgeAudience(url: unknown, listed: ReadonlySet<string>): void {
	const target = endpointOf(url);
	const reason = !target
		? "url"
		: !target.secure && !target.loopback
			? "tls"
			: undefined;
	if (target && reason === undefined) {
		const own = ownEndpoint();
		if (
			listed.has(target.origin) ||
			target.origin === own?.origin ||
			(target.loopback && own?.loopback)
		) {
			return;
		}
	}
	const key = reason ?? "audience";
	throw new SpinetabError("credentials-audience", AUDIENCE_MESSAGE[key], {
		detail: { reason: key },
	});
}

/**
 * Exact `https:` origins (http: only for loopback), validated once with
 * the rule the build plugins apply to their `credentialOrigins` option.
 */
function resolveCredentialOrigins(list: unknown): Set<string> {
	const origins = new Set<string>();
	if (list === undefined) return origins;
	if (!Array.isArray(list)) {
		throw new SpinetabError(
			"unsupported-option",
			"runtime.credentialOrigins must be an array of origins.",
			{ detail: { path: "runtime.credentialOrigins" } },
		);
	}
	list.forEach((entry: unknown, index) => {
		const check = checkCredentialOrigin(entry);
		if (!check.ok) {
			const path = `runtime.credentialOrigins[${index}]`;
			throw new SpinetabError(
				"unsupported-option",
				`${path} ${CREDENTIAL_ORIGIN_SENTENCE}`,
				{ detail: { path } },
			);
		}
		origins.add(check.origin);
	});
	return origins;
}

/** Whether a credentials object carries anything a request could attach. */
function hasProviderMaterial(credentials: Credentials): boolean {
	return Object.values(credentials).some(
		(value) => isPlainObject(value) && Object.keys(value).length > 0,
	);
}

function limitExceeded(limit: string, value: number): SpinetabError {
	return new SpinetabError(
		"limit-exceeded",
		`The ${limit} limit (${value}) was reached; release work or raise the limit.`,
		{ detail: { limit, value } },
	);
}

/** Two byte estimates, undefined when either could not be estimated. */
function sumBytes(
	a: number | undefined,
	b: number | undefined,
): number | undefined {
	return a === undefined || b === undefined ? undefined : a + b;
}

function noCredentialSource(): SpinetabError {
	return new SpinetabError(
		"no-credential-source",
		"No live page in this scope has a credentials provider.",
	);
}

function aborted(): SpinetabError {
	return new SpinetabError("aborted", "The connection was closed.");
}

function errorCode(error: unknown): string {
	return isSpinetabError(error) ? error.code : "unexpected";
}

function errorFields(error: unknown): SerialisedError {
	const record = toSerialisedError(error, "upstream-error");
	return {
		code: record.code,
		message: record.message,
		...(record.detail === undefined ? {} : { detail: record.detail }),
	};
}

/** Plain error record keeping `detail` when the adapter supplied one. */
function plainError(
	value: unknown,
	fallback: SerialisedError["code"],
): SerialisedError {
	const record = toSerialisedError(value, fallback);
	const detail = (value as { detail?: unknown } | null)?.detail;
	if (
		record.detail === undefined &&
		detail !== undefined &&
		estimateBytes(detail) !== undefined
	) {
		return { ...record, detail: detail as Json };
	}
	return record;
}

/**
 * The fallback for an error-bearing control message whose error cannot be
 * cloned (an adapter detail can pass estimation yet fail structured cloning):
 * the same envelope, code and message, the detail replaced by the
 * `not-serialisable` marker and bounded again. The original detail is never
 * kept. Other control bodies have no fallback.
 */
function errorFallback(
	body: ControlBody,
	limit: number,
): ErrorBody | undefined {
	if (body.t === "event" && body.kind === "error") {
		return {
			t: "event",
			c: body.c,
			seq: body.seq,
			kind: "error",
			error: notSerialisableError(body.error, limit),
		};
	}
	if (body.t === "error") {
		const { code, message, detail } = notSerialisableError(body, limit);
		return {
			t: "error",
			...(body.c === undefined ? {} : { c: body.c }),
			...(body.id === undefined ? {} : { id: body.id }),
			code,
			message,
			...(detail === undefined ? {} : { detail }),
		};
	}
	return undefined;
}

function notSerialisableError(
	error: Pick<SerialisedError, "code" | "message" | "retryable">,
	limit: number,
): SerialisedError {
	return boundError(
		{
			code: typeof error.code === "string" ? error.code : "upstream-error",
			message:
				typeof error.message === "string"
					? error.message
					: "The error could not be cloned to the page.",
			detail: { reason: "not-serialisable" },
			...(error.retryable === true ? { retryable: true } : {}),
		},
		limit,
	);
}

/** A command result that could not be cloned to the page. */
function notSerialisableOutcome(): CommandOutcome {
	return {
		status: "unknown",
		error: {
			code: "command-unknown",
			message: "The command result could not be cloned to the page.",
			detail: { reason: "not-serialisable" },
		},
	};
}

function normaliseOutcome(outcome: unknown): CommandOutcome {
	if (typeof outcome === "object" && outcome !== null) {
		const record = outcome as {
			status?: unknown;
			value?: unknown;
			error?: unknown;
		};
		switch (record.status) {
			case "acknowledged":
				return { status: "acknowledged", value: record.value };
			case "sent":
				return { status: "sent" };
			case "rejected":
			case "not-sent":
			case "unknown":
				return {
					status: record.status,
					error: plainError(
						record.error,
						record.status === "rejected"
							? "command-rejected"
							: record.status === "not-sent"
								? "command-not-sent"
								: "command-unknown",
					),
				};
		}
	}
	return {
		status: "unknown",
		error: {
			code: "command-unknown",
			message: "The adapter returned an invalid command outcome.",
		},
	};
}

function compactStatus(
	status: Omit<ConnectionStatus, "since">,
	since: number,
): ConnectionStatus {
	const next: ConnectionStatus = { state: status.state, since };
	if (status.reason !== undefined) next.reason = status.reason;
	if (status.code !== undefined) next.code = status.code;
	if (status.attempt !== undefined) next.attempt = status.attempt;
	if (status.retryAt !== undefined) next.retryAt = status.retryAt;
	if (status.lastSuccessAt !== undefined)
		next.lastSuccessAt = status.lastSuccessAt;
	if (status.skippedIntervals !== undefined) {
		next.skippedIntervals = status.skippedIntervals;
	}
	return next;
}

function sameStatus(a: ConnectionStatus, b: ConnectionStatus): boolean {
	return (
		a.state === b.state &&
		a.reason === b.reason &&
		a.code === b.code &&
		a.attempt === b.attempt &&
		a.retryAt === b.retryAt &&
		a.lastSuccessAt === b.lastSuccessAt &&
		a.skippedIntervals === b.skippedIntervals
	);
}

function pickContinuityDetail(
	detail: ContinuityDetail | undefined,
): Partial<Continuity> {
	if (!detail) return {};
	const picked: Partial<Continuity> = {};
	if (typeof detail.missed === "number") picked.missed = detail.missed;
	if (typeof detail.cursor === "string") picked.cursor = detail.cursor;
	if (typeof detail.duplicatesPossible === "boolean") {
		picked.duplicatesPossible = detail.duplicatesPossible;
	}
	return picked;
}

/** Page-bridge body type re-exported for tests and the worker host. */
export type RuntimeEnvelopeBody = WithoutEnvelope<RuntimeBody>;
