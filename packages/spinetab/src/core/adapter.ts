import type {
	CommandOutcome,
	ConnectionStatus,
	ContinuityReason,
	CredentialRequest,
	Credentials,
	DiagnosticEvent,
	Json,
	RuntimeLimits,
	SerialisedError,
} from "./types.ts";

/**
 * Adapter-author contract. Adapters run in
 * the runtime realm (SharedWorker or lazily loaded local runtime), never see
 * ports, and own their upstream client and retry loop. The runtime owns
 * identity, references, delivery bounds, commands and credential brokering.
 */
export interface RuntimeAdapter<
	C = unknown,
	S = unknown,
	E = unknown,
	P = unknown,
	R = unknown,
	O = Json,
> {
	readonly kind: string;
	readonly version: number;
	/** Reject unknown or unsupported options with `unsupported-option` and a path. */
	validateConnection?(spec: unknown): asserts spec is C;
	validateSubscription?(spec: unknown): asserts spec is S;
	/**
	 * Validate per-consumer options (`ConsumerOptions.consumer`) when a
	 * consumer registers or updates; throw `unsupported-option` with a path.
	 */
	validateConsumer?(options: unknown): asserts options is O;
	/** Canonical connection form; default `stableStringify(spec)`. */
	connectionKey?(spec: C): string;
	/**
	 * Canonical subscription form; default `stableStringify(spec)`. Return a
	 * `unique:` key (see `uniqueKey`) to forbid sharing for this request.
	 */
	subscriptionKey?(spec: S): string;
	/** Whether the runtime may restart this subscription; default `true`. */
	repeatable?(spec: S): boolean;
	/** Whether identical requests may share upstream work; default `true`. */
	shareable?(spec: S): boolean;
	/** Idle close for connections of this adapter; default runtime `idleCloseMs`. */
	readonly idleCloseMs?: number;
	connect(spec: C, ctx: ConnectionContext): AdapterConnection<S, E, P, R, O>;
}

export interface ConnectionContext {
	readonly scope: string;
	readonly key: string;
	readonly limits: RuntimeLimits;
	/** Aborted when the connection is disposed. */
	readonly signal: AbortSignal;
	/**
	 * Request credentials from an eligible live page in this scope. Rejects
	 * with `credentials-timeout`, `credentials-failed` (a provider failed;
	 * transient, handle it as a timeout), `no-credential-source` (no live page
	 * has a provider) or `credentials-rejected`; never spin after a rejection.
	 */
	credentials(
		reason: CredentialRequest["reason"],
		/** The URL the credentials will be attached to; defaults to the connection URL. Judged against the worker's credential audience and TLS rule; rejects with `credentials-audience`. */
		url?: string,
	): Promise<Credentials>;
	/**
	 * Mark the revision of the attached grant rejected by the upstream (a 401).
	 * Pass the credentials object that was attached; an object that carried no
	 * provider material, `{}` or no argument at all names no grant and rejects
	 * nothing. A 403 never rejects: it ends as `permanent-error`.
	 */
	rejectCredentials(credentials?: Credentials): void;
	/**
	 * Whether `url` is on the worker's own origin as the runtime judges it
	 * (loopback counts as own when the worker runs on loopback). The one
	 * origin judgement adapters make, for `authHeaders` auto mode; the
	 * credential audience itself is judged inside `credentials()`.
	 */
	ownOrigin?(url: string): boolean;
	setStatus(status: Omit<ConnectionStatus, "since">): void;
	diagnostic(event: Omit<DiagnosticEvent, "at" | "realm">): void;
	/** Executable-time clock used for deadlines; suspension gaps are excluded. */
	now(): number;
}

export interface AdapterSubscriptionOptions {
	readonly key: string;
	readonly repeatable: boolean;
	/**
	 * Last delivered cursor of the consumer whose (re-)registration created
	 * this upstream subscription, for example after runtime replacement.
	 * Consumers that re-registered with a different cursor are reported
	 * `unknown` when the adapter reports `resumed-with-cursor`.
	 */
	readonly cursor?: string;
}

export interface AdapterConnection<
	S = unknown,
	E = unknown,
	P = unknown,
	R = unknown,
	O = Json,
> {
	subscribe(
		spec: S,
		sink: SubscriptionSink<E>,
		options: AdapterSubscriptionOptions,
	): AdapterSubscription<O>;
	command?(
		payload: P,
		options: { id: string; signal: AbortSignal; timeoutMs: number },
	): Promise<CommandOutcome<R>>;
	/** Coordinated return check: liveness probe or reopen of repeatable work. */
	probe?(): void;
	/** Explicit fresh attempt series after retry-exhausted, failed or auth-blocked. */
	retry?(): void;
	/** Credentials rotated within the scope. */
	rotate?(): void;
	dispose(): void;
}

export interface ConsumerContext {
	readonly visible: boolean;
}

export interface AdapterSubscription<O = Json> {
	unsubscribe(): void;
	consumerAdded?(
		id: string,
		options: O | undefined,
		context: ConsumerContext,
	): void;
	consumerUpdated?(id: string, options: O | undefined): void;
	consumerRemoved?(id: string): void;
	consumerVisibility?(id: string, visible: boolean): void;
}

export interface SinkNextMeta {
	/** Adapter-known wire size; otherwise the runtime estimates. */
	bytes?: number;
	eventId?: string;
	/** The SSE event name; undefined for other transports. */
	event?: string;
	/** Deliver only to these consumer ids (for example eligible pollers). */
	consumers?: string[];
}

export interface ContinuityDetail {
	missed?: number;
	cursor?: string;
	duplicatesPossible?: boolean;
}

export interface SubscriptionSink<E = unknown> {
	next(event: E, meta?: SinkNextMeta): void;
	/** Terminal for every consumer of the subscription. */
	error(error: SerialisedError): void;
	complete(): void;
	continuity(reason: ContinuityReason, detail?: ContinuityDetail): void;
	/** After this, `share: "before-start"` joiners are rejected. */
	started(): void;
}

export function defineAdapter<
	C,
	S,
	E,
	P = never,
	R = never,
	O extends Json = Json,
>(adapter: RuntimeAdapter<C, S, E, P, R, O>): RuntimeAdapter<C, S, E, P, R, O> {
	return adapter;
}
