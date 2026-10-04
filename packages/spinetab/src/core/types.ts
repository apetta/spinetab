/**
 * Public vocabulary shared by the page client, the runtime and every adapter.
 * Values that cross the page/runtime bridge must be structured-cloneable plain
 * data; callbacks never cross.
 */

export type Json =
	| null
	| boolean
	| number
	| string
	| Json[]
	| { [key: string]: Json };

export type SpinetabErrorCode =
	| "unsupported-option"
	| "invalid-endpoint"
	| "not-serialisable"
	| "limit-exceeded"
	| "timeout"
	| "aborted"
	| "disposed"
	| "attachment-retired"
	| "adapter-not-registered"
	| "invalid-envelope"
	| "sharing-unavailable"
	| "incompatible-version"
	| "worker-startup-error"
	| "runtime-unavailable"
	/** No worker, no local runtime and no plugin wiring. */
	| "not-configured"
	| "overflow"
	| "message-too-large"
	| "event-not-serialisable"
	| "continuity-lost"
	| "credentials-timeout"
	/** A page's provider threw or returned no valid credentials object; transient. */
	| "credentials-failed"
	| "credentials-audience"
	| "credentials-rejected"
	| "no-credential-source"
	| "auth-blocked"
	| "scope-changed"
	| "retry-exhausted"
	| "upstream-error"
	| "protocol-error"
	| "decode-error"
	| "frame-too-large"
	| "malformed-frame"
	| "command-not-sent"
	| "command-unknown"
	| "command-rejected"
	| "subscribe-rejected"
	| "interrupted"
	| "late-join-unsupported"
	| "cannot-resume"
	| "stop-unavailable";

/** Plain, cloneable error record used on the bridge and in adapter sinks. */
export interface SerialisedError {
	code: SpinetabErrorCode;
	message: string;
	detail?: Json;
	retryable?: boolean;
}

export type ExecutionMode =
	| "inactive"
	| "starting"
	| "shared"
	| "local"
	| "failed"
	| "disposed";

export type ModeReason =
	| "server"
	| "sharing-off"
	| "unsupported"
	| "worker-construct-failed"
	| "worker-error"
	| "worker-startup-error"
	| "startup-timeout"
	| "incompatible-version"
	| "handshake-invalid"
	| "local-runtime-unavailable"
	| "local-runtime-load-failed"
	/** Neither `worker`/`local` nor plugin wiring was configured. */
	| "not-configured"
	| "sharing-required"
	/** Re-attachment budget exhausted. */
	| "runtime-unstable";

export type RuntimeHealth =
	| "unknown"
	| "checking"
	| "healthy"
	| "reattaching"
	| "unreachable";

export interface ClientStatus {
	mode: ExecutionMode;
	reason?: ModeReason;
	detail?: string;
	health: RuntimeHealth;
	runtimeId?: string;
	/** Attachment generation; 0 before the first attachment. */
	generation: number;
	error?: SerialisedError;
}

export type ConnectionState =
	| "inactive"
	| "connecting"
	| "connected"
	| "reconnecting"
	| "auth-blocked"
	| "retry-exhausted"
	| "failed"
	| "disposed";

export type ConnectionReason =
	| "network"
	| "server-closed"
	| "heartbeat-timeout"
	| "suspension-gap"
	| "credentials-missing"
	| "credentials-rejected"
	| "no-credential-source"
	| "credentials-audience"
	| "attempts-exhausted"
	| "time-limit"
	| "permanent-error"
	| "protocol-error"
	| "runtime-replaced"
	| "idle";

export interface ConnectionStatus {
	state: ConnectionState;
	reason?: ConnectionReason;
	code?: string | number;
	attempt?: number;
	retryAt?: number;
	/** Last successful read or connect (epoch ms), reported while stale. */
	lastSuccessAt?: number;
	/** Polling: intervals skipped while paused before the latest read. */
	skippedIntervals?: number;
	since: number;
}

export type ContinuityState = "continuous" | "gap" | "unknown" | "resumed";

export type ContinuityReason =
	| "runtime-replaced"
	| "lease-expired"
	| "overflow"
	| "message-too-large"
	| "event-not-serialisable"
	| "reconnected"
	| "reopened"
	| "resumed-with-cursor"
	| "recovered"
	| "reconciled"
	| "decode-error"
	/** The server's declared reset event said the replay cursor was too old. */
	| "replay-reset"
	/** The client changed auth scope; intent was re-registered in the new scope. */
	| "scope-changed";

export interface Continuity {
	state: ContinuityState;
	reason?: ContinuityReason;
	missed?: number;
	cursor?: string;
	duplicatesPossible?: boolean;
	since: number;
}

export interface SubscriptionStatus {
	active: boolean;
	connection: ConnectionStatus;
	continuity: Continuity;
}

/**
 * Application credentials. Adapters read the keys they document: `headers`
 * (HTTP-based adapters), `connectionParams` (graphql-ws, tRPC) or `auth`
 * (Socket.IO). Credentials live in memory only and never enter identity,
 * diagnostics, worker names, storage or URLs.
 */
export type Credentials = Record<string, unknown>;
/** A non-negative safe integer; revisions compare numerically only. */
export type CredentialRevision = number;

export interface CredentialRequest {
	scope: string;
	revision: CredentialRevision | null;
	reason: "connect" | "reconnect" | "rotated" | "retry";
	signal: AbortSignal;
}

export interface DeliveryLimits {
	/** Aggregate posted, unacknowledged messages per attachment (tab port). */
	maxPendingMessages: number;
	/** Aggregate estimated serialised bytes posted and unacknowledged per attachment. */
	maxPendingBytes: number;
	/** Fair share of `maxPendingMessages` one consumer may hold. */
	maxPendingMessagesPerConsumer: number;
	/** Fair share of `maxPendingBytes` one consumer may hold. */
	maxPendingBytesPerConsumer: number;
	/** Estimated serialised bytes of one event. */
	maxMessageBytes: number;
}

export interface RuntimeLimits extends DeliveryLimits {
	maxControlMessages: number;
	maxPendingCommands: number;
	commandTimeoutMs: number;
	credentialTimeoutMs: number;
	maxFrameBytes: number;
	maxConsumersPerAttachment: number;
	maxSubscriptions: number;
	maxConnections: number;
	leaseMs: number;
	idleCloseMs: number;
	lingerMs: number;
}

/** Referentially stable snapshot store; the primitive behind every binding. */
export interface Store<T> {
	get(): T;
	subscribe(listener: (value: T) => void): () => void;
}

export interface DiagnosticEvent {
	type: string;
	at: number;
	realm: "page" | "runtime";
	detail?: Json;
}

/**
 * Any selection value except a function. A request's `subscription` is data
 * cloned to the runtime, never a function, so an endpoint whose
 * `subscription(spec)` is a builder method is not a request.
 * Functions fail both object members because they have `call`. The
 * intersection admits interfaces, including those whose members are all
 * optional; the index signature admits object literals with any keys.
 */
type Selection =
	| string
	| number
	| boolean
	| bigint
	| symbol
	| null
	| undefined
	| (object & { call?: never })
	| { [key: string]: unknown; call?: never };

export interface SubscriptionRequest<E = unknown, C = unknown, S = Selection> {
	adapter: string;
	connection: C;
	subscription: S;
	/** Auth scope; defaults to the client's scope. */
	scope?: string;
	/**
	 * Whether the runtime may restart the upstream subscription after a
	 * reconnect and re-register it after runtime replacement. Adapter default.
	 * `false` excludes it from re-registered intent; an interruption is then
	 * reported as `interrupted`.
	 */
	repeatable?: boolean;
	/** `before-start` rejects joiners after the first event (stateful streams). */
	share?: "always" | "before-start";
	/** Late joiners need a resume position (for example AI SDK streams). */
	stateful?: boolean;
	/** Phantom for event type inference; never set at runtime. */
	__event?: E;
}

export interface ResumeState {
	lastEventId?: string;
	lastEvent?: unknown;
}

/**
 * Adapter-defined per-consumer options as written by applications: JSON whose
 * properties may be `undefined` (optional option types). The page strips
 * `undefined` values before validation and posting.
 */
export type ConsumerJson = { [key: string]: Json | undefined };

export interface ConsumerOptions {
	/** Adapter-defined per-consumer options (for example polling interval). */
	consumer?: ConsumerJson;
	/**
	 * Called before intent is re-registered after runtime replacement so an
	 * integration can forward a cursor. Returns a partial request override.
	 */
	resume?: (
		state: ResumeState,
	) => Partial<Pick<SubscriptionRequest, "subscription">> | undefined;
	signal?: AbortSignal;
}

export interface EventMeta {
	eventId?: string;
	/** SSE event name; undefined for other adapters. */
	event?: string;
	/** Per-consumer sequence, increasing by one per delivered event. */
	seq: number;
}

export interface SubscriptionObserver<E> {
	next(event: E, meta: EventMeta): void;
	error?(error: SerialisedError): void;
	complete?(): void;
	status?(status: SubscriptionStatus): void;
}

/**
 * A builder result whose default selection is total: `.subscription()` takes
 * no argument. A feed whose `subscription` is generic should also declare a
 * non-generic `subscription()` last, so `subscribe(feed, fn)` infers `E`.
 */
export interface Feed<E = unknown, C = unknown, S = Selection> {
	readonly connection: C;
	subscription(): SubscriptionRequest<E, C, S>;
}

export type Source<E = unknown> = SubscriptionRequest<E> | Feed<E>;

export type Observer<E> =
	| SubscriptionObserver<E>
	| ((event: E, meta: EventMeta) => void);

export interface Subscription<E = unknown> {
	readonly id: string;
	readonly status: Store<SubscriptionStatus>;
	update(consumer: ConsumerJson): void;
	/**
	 * The application declares continuity reconciled. Sets continuity to
	 * `continuous`/`reconciled` and, after an overflow, restarts delivery from
	 * now in a new delivery epoch.
	 */
	markReconciled(options?: {
		/**
		 * Restart stopped delivery now but keep continuity non-continuous; a later
		 * plain `markReconciled()` declares it reconciled.
		 */
		pending?: boolean;
	}): void;
	/** Explicit upstream retry for this subscription's connection only. */
	retry(): void;
	/** Idempotent; cancels pending intent. */
	unsubscribe(): void;
	/** Phantom for event type inference. */
	readonly __event?: E;
}

export interface CommandRequest<R = unknown, C = unknown, P = unknown> {
	adapter: string;
	connection: C;
	scope?: string;
	payload: P;
	/** Phantom for result type inference. */
	__result?: R;
}

export type CommandOutcome<R = unknown> =
	| { status: "acknowledged"; value: R }
	| { status: "rejected"; error: SerialisedError }
	| { status: "sent" }
	/** Never reached the wire; safe to retry. */
	| { status: "not-sent"; error: SerialisedError }
	/** May have reached the server; do not retry blindly. */
	| { status: "unknown"; error: SerialisedError };

export type SharingPolicy = "prefer" | "require" | "off";

/**
 * The part of a `SharedWorker` the client uses: its port and error events.
 * Structural so the declarations type-check under a `WebWorker`-only lib; a real `SharedWorker` satisfies it.
 */
export interface SharedWorkerLike {
	readonly port: MessagePort;
	addEventListener(type: "error", listener: (event: Event) => void): void;
	removeEventListener(type: "error", listener: (event: Event) => void): void;
}

export interface SpinetabOptions {
	/**
	 * Application-owned, bundler-visible SharedWorker factory. Omit both
	 * `worker` and `local` to use the Spinetab bundler plugin's wiring; passing
	 * either one opts this client out of it entirely.
	 */
	worker?: () => SharedWorkerLike;
	/**
	 * Lazy local-runtime module factory using ordinary `import()`. Omit both
	 * `worker` and `local` to use the Spinetab bundler plugin's wiring.
	 */
	local?: () => Promise<LocalRuntimeModule>;
	/** Default "prefer". */
	sharing?: SharingPolicy;
	/** Auth scope; default "". */
	scope?: string;
	credentialRevision?: CredentialRevision;
	/**
	 * This page supplies no Spinetab credentials to any endpoint; cookies still
	 * follow each endpoint's cookie mode. Cannot be combined with `credentials`.
	 */
	anonymous?: boolean;
	credentials?: (
		request: CredentialRequest,
	) => Credentials | Promise<Credentials>;
	/** Page-side delivery limits; may only tighten the runtime's limits. */
	limits?: Partial<DeliveryLimits>;
	handshakeTimeoutMs?: number;
	probeTimeoutMs?: number;
	heartbeatMs?: number;
	leaseMs?: number;
	/** Base for relative endpoints; default `document.baseURI` at start. */
	baseUrl?: string;
	/** Opt-in, payload and credential free. */
	diagnostics?: (event: DiagnosticEvent) => void;
	/** Receives application callback failures; default `reportError`. */
	onCallbackError?: (
		error: unknown,
		context: { subscriptionId: string },
	) => void;
}

/** Plugin wiring supplies both factories only when the application provides neither worker nor local. */
export interface SpinetabWiring {
	worker: () => SharedWorkerLike;
	local: () => Promise<LocalRuntimeModule>;
}

/** Shape of the module returned by `SpinetabOptions.local`. */
export type LocalRuntimeModule =
	| { default: () => RuntimeHandle }
	| { runtime: () => RuntimeHandle };

export interface RuntimeHandle {
	readonly id: string;
	accept(port: MessagePort): void;
	dispose(): void;
}

export interface SpinetabClient {
	readonly status: Store<ClientStatus>;
	readonly scope: string;
	/** Idempotent; the first subscribe or command in a browser also starts. */
	start(): void;
	subscribe<E>(
		source: Source<E>,
		/** `NoInfer`: the payload type comes from the source, never from an annotated callback. */
		observer: Observer<NoInfer<E>>,
		options?: ConsumerOptions,
	): Subscription<E>;
	command<R>(
		request: CommandRequest<R>,
		options?: { timeoutMs?: number; signal?: AbortSignal },
	): Promise<CommandOutcome<R>>;
	/** Credential rotation within the current scope. */
	setCredentialRevision(
		revision: CredentialRevision,
		options?: { restart?: boolean },
	): void;
	/** Principal change: detaches old-scope work before new-scope delivery. */
	setScope(scope: string, revision?: CredentialRevision): void;
	/** Coalesced page-to-runtime health check. */
	checkHealth(reason?: string): Promise<ClientStatus>;
	/** In failed mode one attach attempt; otherwise explicit upstream retry. */
	retry(): void;
	/** Idempotent and terminal. */
	dispose(): void;
}
