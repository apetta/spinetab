import {
	createWSClient,
	httpSubscriptionLink,
	type TRPCLink,
	wsLink,
} from "@trpc/client";
import type { AnyTRPCRouter } from "@trpc/server";
import type {
	AdapterConnection,
	AdapterSubscription,
	ConnectionContext,
	RuntimeAdapter,
	SubscriptionSink,
} from "../../core/adapter.ts";
import { reportInterruption } from "../../core/continuity-phase.ts";
import { SpinetabError } from "../../core/errors.ts";
import { stableStringify } from "../../core/identity.ts";
import type {
	ConnectionReason,
	ConnectionStatus,
	CredentialRequest,
	Credentials,
	Json,
	SerialisedError,
} from "../../core/types.ts";
import {
	attachedGrant,
	boundedText,
	credentialChannel,
	credentialFailureReason,
	FORBIDDEN,
	isRefusedRedirect,
	parked,
	stringHeaders,
} from "../../protocols/shared/runtime.ts";
import { isPlainObject } from "../../protocols/shared/validate.ts";
import {
	carriesCursor,
	inputWithCursor,
	TRPC_DEFAULTS,
	type TrpcEvent,
	type TrpcSseConnection,
	type TrpcSubscriptionSpec,
	type TrpcWsConnection,
	validateTrpcSseConnection,
	validateTrpcSubscription,
	validateTrpcWsConnection,
} from "./spec.ts";

export type {
	TrpcEvent,
	TrpcSseConnection,
	TrpcSubscriptionSpec,
	TrpcWsConnection,
} from "./spec.ts";

/**
 * Worker-side tRPC adapters. The worker hosts the real
 * upstream links with the application's transformer, so (de)serialisation
 * happens here and only structured-cloneable output crosses the bridge.
 */

/** A tRPC data transformer (`superjson`, or `{ input, output }`). */
export type TrpcTransformer =
	| { serialize(value: unknown): unknown; deserialize(value: unknown): unknown }
	| {
			input: {
				serialize(value: unknown): unknown;
				deserialize(value: unknown): unknown;
			};
			output: {
				serialize(value: unknown): unknown;
				deserialize(value: unknown): unknown;
			};
	  };

export interface TrpcWsAdapterOptions {
	transformer?: TrpcTransformer;
	/** Upstream reconnect delay; default tRPC's 0 s, 2 s, 4 s … capped at 30 s. */
	retryDelayMs?: (attemptIndex: number) => number;
	/** WebSocket constructor for runtimes without a global `WebSocket`. */
	WebSocket?: typeof WebSocket;
}

export interface TrpcSseAdapterOptions {
	transformer?: TrpcTransformer;
	/**
	 * EventSource implementation. A header-capable ponyfill (constructor
	 * `(url, { headers, withCredentials })`) enables `headers: true`.
	 */
	EventSource?: unknown;
	/**
	 * Send `credentials.headers` through `eventSourceOptions.headers`
	 * (requires a header-capable `EventSource`). Default: the cookie recipe;
	 * no credential request is made.
	 */
	headers?: boolean;
	/** Delay before recreating a closed EventSource; default 1 s × 2ⁿ, cap 30 s. */
	retryDelayMs?: (attemptIndex: number) => number;
}

/** 401-equivalent: rejects the attached grant. `FORBIDDEN` does not reject credentials. */
const UNAUTHORIZED = "UNAUTHORIZED";
const FORBIDDEN_CODE = "FORBIDDEN";

interface TrpcRecord {
	readonly spec: TrpcSubscriptionSpec;
	readonly sink: SubscriptionSink<TrpcEvent>;
	readonly repeatable: boolean;
	active: boolean;
	gen: number;
	release: (() => void) | undefined;
	cursor: string | undefined;
	everStarted: boolean;
	/** The current interruption was already reported as a continuity loss. */
	lossReported: boolean;
	stopped: boolean;
	failures: number;
	retryTimer: ReturnType<typeof setTimeout> | undefined;
	/** Upstream operation id of the current start (SSE: maps init to record). */
	opId: number;
	/** SSE: the grant whose headers the current EventSource carries. */
	grant: Credentials | undefined;
}

type Blocked = "auth" | "failed" | "exhausted";

interface Envelope {
	result: {
		type?: string;
		id?: string;
		data?: unknown;
		state?: string;
		error?: unknown;
	};
}

type OperationLink = ReturnType<TRPCLink<AnyTRPCRouter>>;

let operationIds = 0;

/**
 * A page marked `transformer: true` whose adapter has none would hand
 * the application undecoded transformer output without any error, so the
 * request is refused and the sentence names the worker-file lever.
 */
function refuseUnmatchedTransformer(
	spec: { transformer?: boolean },
	transformer: TrpcTransformer | undefined,
): void {
	if (spec.transformer !== true || transformer) return;
	throw new SpinetabError(
		"unsupported-option",
		"This tRPC router uses a transformer; construct trpcWsAdapter({ transformer }) or trpcSseAdapter({ transformer }) in your worker file.",
		{ detail: { path: "connection.transformer" } },
	);
}

/**
 * Connection identity without the transformer marker: it never changes what the
 * adapter does, so marked and unmarked consumers share one upstream.
 */
function withoutMarker<T extends { transformer?: boolean }>(
	spec: T,
): Omit<T, "transformer"> {
	const { transformer: _marker, ...rest } = spec;
	return rest;
}

function outputDeserialiser(transformer: TrpcTransformer | undefined) {
	if (!transformer) return (value: unknown) => value;
	if ("output" in transformer)
		return (value: unknown) => transformer.output.deserialize(value);
	return (value: unknown) => transformer.deserialize(value);
}

/** tRPC error code (`UNAUTHORIZED`, …) from a `TRPCClientError` or error shape. */
function trpcCode(error: unknown): string | undefined {
	if (!isPlainObject(error) && !(error instanceof Error)) return undefined;
	const data = (error as { data?: unknown }).data;
	if (isPlainObject(data) && typeof data.code === "string") return data.code;
	const shape = (error as { shape?: unknown }).shape;
	if (
		isPlainObject(shape) &&
		isPlainObject(shape.data) &&
		typeof shape.data.code === "string"
	) {
		return shape.data.code;
	}
	return undefined;
}

/** Largest serialised procedure-error shape passed through whole. */
const MAX_SHAPE_CHARS = 4_096;

/**
 * The procedure error's shape for its own subscriber: every string,
 * including what an `errorFormatter` adds to `data` (for example zod issues),
 * is bounded like the error's message, and a development `data.stack` is
 * dropped. A shape still larger than `MAX_SHAPE_CHARS` keeps only its codes.
 */
function errorShape(error: unknown): Json | undefined {
	const shape = (error as { shape?: unknown } | null)?.shape;
	if (!isPlainObject(shape)) return undefined;
	try {
		const copy = JSON.parse(JSON.stringify(shape), (_key, value: unknown) =>
			typeof value === "string" ? boundedText(value) : value,
		) as Record<string, Json>;
		if (isPlainObject(copy.data)) delete copy.data.stack;
		if (JSON.stringify(copy).length <= MAX_SHAPE_CHARS) return copy;
		const data = isPlainObject(copy.data) ? copy.data : {};
		return {
			code: copy.code ?? null,
			message: copy.message ?? null,
			data: { code: data.code ?? null, httpStatus: data.httpStatus ?? null },
		};
	} catch {
		return undefined;
	}
}

/**
 * The HTTP status a header-capable EventSource put on its failure event.
 * tRPC 11.19 disposes the stream after the failure and throws a
 * `SuppressedError` whose `suppressed` member is the event, wrapped again in
 * a `TRPCClientError` `cause`; native EventSource exposes no status.
 */
function httpStatusOf(error: unknown): number | undefined {
	let current = error;
	for (let depth = 0; depth < 4 && current; depth += 1) {
		const value = current as {
			status?: unknown;
			cause?: unknown;
			suppressed?: unknown;
		};
		if (typeof value.status === "number") return value.status;
		current =
			value.cause ?? (typeof value === "object" ? value.suppressed : undefined);
	}
	return undefined;
}

function subscriptionOp(record: TrpcRecord) {
	operationIds += 1;
	record.opId = operationIds;
	return {
		id: operationIds,
		type: "subscription" as const,
		path: record.spec.path,
		input: inputWithCursor(record.spec.input, record.cursor),
		context: {},
		signal: null,
	};
}

abstract class TrpcConnectionBase<
	TSpec extends { retryAttempts?: number; anonymous?: boolean },
> implements AdapterConnection<TrpcSubscriptionSpec, TrpcEvent>
{
	protected readonly spec: TSpec;
	protected readonly ctx: ConnectionContext;
	protected readonly records = new Set<TrpcRecord>();
	protected gen = 0;
	protected blocked: Blocked | undefined;
	/** Blocked by the credential audience: rotation never restarts it. */
	protected permanent = false;
	protected nextReason: CredentialRequest["reason"] = "connect";
	protected disposed = false;
	#hintRetried = false;
	#state: ConnectionStatus["state"] = "inactive";

	constructor(spec: TSpec, ctx: ConnectionContext) {
		this.spec = spec;
		this.ctx = ctx;
	}

	protected abstract link(): OperationLink;
	protected abstract teardownClient(): void;
	/** The grant whose provider material reached the upstream for `record`. */
	protected abstract attachedFor(record: TrpcRecord): Credentials | undefined;
	/** The URL the credentials are attached to. */
	protected abstract get credentialUrl(): string;

	subscribe(
		spec: TrpcSubscriptionSpec,
		sink: SubscriptionSink<TrpcEvent>,
		options: { key: string; repeatable: boolean },
	): AdapterSubscription {
		const record: TrpcRecord = {
			spec,
			sink,
			repeatable: options.repeatable,
			active: true,
			gen: -1,
			release: undefined,
			cursor: spec.lastEventId,
			everStarted: false,
			lossReported: false,
			stopped: false,
			failures: 0,
			retryTimer: undefined,
			opId: 0,
			grant: undefined,
		};
		this.records.add(record);
		if (!this.blocked && !this.disposed) this.start(record);
		return { unsubscribe: () => this.release(record) };
	}

	retry(): void {
		if (this.disposed || !this.blocked) return;
		this.restart("retry");
	}

	rotate(): void {
		if (this.disposed || this.permanent) return;
		// Recreate with the new revision; the cursor is forwarded.
		this.restart("rotated");
	}

	probe(): void {
		if (this.disposed || this.blocked !== "exhausted" || this.#hintRetried)
			return;
		this.#hintRetried = true;
		this.restart("reconnect");
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.gen += 1;
		for (const record of this.records) {
			record.active = false;
			clearTimeout(record.retryTimer);
		}
		this.records.clear();
		this.teardownClient();
	}

	protected start(record: TrpcRecord): void {
		const link = this.link();
		record.gen = this.gen;
		record.stopped = false;
		const gen = this.gen;
		const live = () =>
			record.active && record.gen === gen && this.gen === gen && !this.disposed;
		const observable = link({
			op: subscriptionOp(record) as never,
			next: () => {
				throw new Error("Spinetab tRPC links are terminating links.");
			},
		});
		const subscription = observable.subscribe({
			next: (envelope: unknown) => {
				if (!live()) return;
				this.onEnvelope(record, (envelope as Envelope).result);
			},
			error: (error: unknown) => {
				if (!live()) return;
				this.onError(record, error);
			},
			complete: () => {
				if (!live()) return;
				// Only a server `stopped` is a genuine completion; completions
				// from Spinetab's own close() or unsubscribe are fenced above.
				if (!record.stopped) return;
				this.forget(record);
				record.sink.complete();
			},
		});
		record.release = () => subscription.unsubscribe();
	}

	protected onEnvelope(record: TrpcRecord, result: Envelope["result"]): void {
		switch (result.type) {
			case "state":
				this.onState(record, result);
				return;
			case "started": {
				// The continuity outcome precedes `connected`. A
				// start is `resumed` only when the application declared replay
				// and the cursor actually reached the procedure: a non-object
				// input cannot carry `lastEventId` (upstream drops it too).
				// Otherwise a restart's continuity is unknown. It is reported
				// even when the loss was reported at detection: an application
				// that reconciled then must reconcile again.
				const cursor = record.cursor;
				if (
					cursor !== undefined &&
					record.spec.replay &&
					carriesCursor(record.spec.input)
				) {
					record.sink.continuity("resumed-with-cursor", {
						cursor,
						duplicatesPossible: true,
					});
				} else if (record.everStarted) {
					record.sink.continuity("reconnected");
				}
				record.lossReported = false;
				this.healthy(record);
				if (!record.everStarted) record.sink.started();
				record.everStarted = true;
				return;
			}
			case "stopped":
				record.stopped = true;
				return;
			default: {
				this.healthy(record);
				if (typeof result.id === "string" && result.id)
					record.cursor = result.id;
				const event: TrpcEvent =
					typeof result.id === "string" && result.id
						? { id: result.id, data: result.data }
						: { data: result.data };
				record.sink.next(event, event.id ? { eventId: event.id } : undefined);
			}
		}
	}

	protected onState(_record: TrpcRecord, _state: Envelope["result"]): void {}

	protected healthy(record: TrpcRecord): void {
		record.failures = 0;
		this.#hintRetried = false;
		if (this.#state !== "connected") this.setState({ state: "connected" });
	}

	/**
	 * Continuity is unknown from the moment an interruption is detected; a
	 * declared replay can only be confirmed at reconnect. Each started record
	 * is told once per interruption, before `reconnecting`.
	 */
	protected reportLoss(record: TrpcRecord): void {
		if (!record.active || !record.everStarted || record.lossReported) return;
		record.lossReported = true;
		reportInterruption(record.sink, "reconnected");
	}

	protected onError(record: TrpcRecord, error: unknown): void {
		const code = trpcCode(error);
		if (code === UNAUTHORIZED) {
			this.block("auth", { code: `trpc:${code}` }, this.attachedFor(record));
			return;
		}
		// Procedure errors, a procedure's FORBIDDEN included, end that
		// subscription for every consumer of it and reach nobody else: never a
		// status or a diagnostic. One denied input (a room, a
		// resource) never ends its neighbours; a connection-level FORBIDDEN
		// (WS context error, SSE HTTP 403) ends the connection instead.
		this.forget(record);
		const detail: Record<string, Json> = {};
		if (code) detail.trpcCode = code;
		const shape = errorShape(error);
		if (shape !== undefined) detail.shape = shape;
		const serialised: SerialisedError = {
			code: "upstream-error",
			message: boundedText(
				(error as { message?: unknown })?.message,
				"tRPC subscription error",
			),
		};
		if (Object.keys(detail).length > 0) serialised.detail = detail;
		record.sink.error(serialised);
	}

	protected forget(record: TrpcRecord): void {
		record.active = false;
		clearTimeout(record.retryTimer);
		this.records.delete(record);
	}

	protected release(record: TrpcRecord): void {
		if (!record.active) return;
		this.forget(record);
		const release = record.release;
		record.release = undefined;
		release?.();
		if (this.records.size === 0 && !this.blocked) {
			this.setState({ state: "inactive", reason: "idle" });
		}
	}

	/** `failed` / `permanent-error` / `forbidden`; nothing is rejected. */
	protected forbidden(): void {
		this.block("failed", { code: FORBIDDEN.code });
	}

	protected block(
		kind: Blocked,
		detail: { reason?: ConnectionReason; code?: string },
		/** The grant the failing attempt carried; only a 401 passes it. */
		grant?: Credentials,
	): void {
		if (this.disposed) return;
		this.blocked = kind;
		this.permanent = detail.reason === "credentials-audience";
		this.gen += 1;
		for (const record of this.records) clearTimeout(record.retryTimer);
		this.teardownClient();
		const code = detail.code ? { code: detail.code } : {};
		if (kind === "auth") {
			if (grant) this.ctx.rejectCredentials(grant);
			this.setState({
				state: "auth-blocked",
				reason: detail.reason ?? "credentials-rejected",
				...code,
			});
		} else if (kind === "failed") {
			this.setState({ state: "failed", reason: "permanent-error", ...code });
		} else {
			this.setState({
				state: "retry-exhausted",
				reason: "attempts-exhausted",
				...code,
			});
		}
	}

	protected restart(reason: CredentialRequest["reason"]): void {
		this.gen += 1;
		this.teardownClient();
		this.blocked = undefined;
		this.permanent = false;
		this.nextReason = reason;
		for (const record of [...this.records]) {
			clearTimeout(record.retryTimer);
			record.failures = 0;
			if (!record.repeatable && record.everStarted) {
				this.forget(record);
				record.sink.error({
					code: "interrupted",
					message: "The subscription restarted; it is not repeatable.",
				});
				continue;
			}
			this.start(record);
		}
	}

	protected setState(status: Omit<ConnectionStatus, "since">): void {
		this.#state = status.state;
		this.ctx.setStatus(status);
	}

	protected get state(): ConnectionStatus["state"] {
		return this.#state;
	}

	protected get retryAttempts(): number {
		return this.spec.retryAttempts ?? TRPC_DEFAULTS.retryAttempts;
	}

	/** Resolve credentials for one attempt; `undefined` when blocked. */
	protected async credentialsFor(
		gen: number,
	): Promise<Credentials | undefined> {
		if (this.spec.anonymous) return {};
		const reason = this.nextReason;
		this.nextReason = "reconnect";
		try {
			const credentials = await this.ctx.credentials(
				reason,
				this.credentialUrl,
			);
			return gen === this.gen && !this.disposed ? credentials : undefined;
		} catch (error) {
			if (gen === this.gen && !this.disposed) {
				this.block("auth", { reason: credentialFailureReason(error) });
			}
			return undefined;
		}
	}
}

export function trpcWsAdapter(
	options: TrpcWsAdapterOptions = {},
): RuntimeAdapter<
	TrpcWsConnection,
	TrpcSubscriptionSpec,
	TrpcEvent,
	never,
	never
> {
	return {
		kind: "trpc-ws",
		version: 1,
		validateConnection(spec: unknown): asserts spec is TrpcWsConnection {
			validateTrpcWsConnection(spec, { absolute: true });
			refuseUnmatchedTransformer(spec, options.transformer);
		},
		validateSubscription(spec: unknown): asserts spec is TrpcSubscriptionSpec {
			validateTrpcSubscription(spec);
		},
		connectionKey(spec) {
			return stableStringify({
				retryAttempts: TRPC_DEFAULTS.retryAttempts,
				keepAlive: TRPC_DEFAULTS.keepAlive,
				...withoutMarker(spec),
				url: webSocketUrl(spec.url),
			});
		},
		connect(spec, ctx) {
			return new TrpcWsConnectionHandle(spec, ctx, options);
		},
	};
}

function webSocketUrl(url: string): string {
	const parsed = new URL(url);
	if (parsed.protocol === "http:") parsed.protocol = "ws:";
	else if (parsed.protocol === "https:") parsed.protocol = "wss:";
	return parsed.toString();
}

class TrpcWsConnectionHandle extends TrpcConnectionBase<TrpcWsConnection> {
	readonly #options: TrpcWsAdapterOptions;
	readonly #deserialise: (value: unknown) => unknown;
	#client: ReturnType<typeof createWSClient> | undefined;
	#link: OperationLink | undefined;
	#unsubscribeState: (() => void) | undefined;
	#failures = 0;
	/** The grant whose `connectionParams` the current socket sent. */
	#attached: Credentials | undefined;

	constructor(
		spec: TrpcWsConnection,
		ctx: ConnectionContext,
		options: TrpcWsAdapterOptions,
	) {
		super(spec, ctx);
		this.#options = options;
		this.#deserialise = outputDeserialiser(options.transformer);
	}

	protected get credentialUrl(): string {
		return webSocketUrl(this.spec.url);
	}

	protected attachedFor(): Credentials | undefined {
		return this.#attached;
	}

	protected link(): OperationLink {
		if (this.#link) return this.#link;
		const gen = this.gen;
		const spec = this.spec;
		let credentials: Credentials | undefined;
		const Base = this.#options.WebSocket ?? globalThis.WebSocket;
		// A thin observer around the realm's WebSocket: it counts failed
		// sockets for the attempt budget and detects `id: null` context errors,
		// which upstream ignores while reconnecting forever.
		const handle = this;
		class ObservedWebSocket extends Base {
			constructor(url: string | URL, protocols?: string | string[]) {
				super(url, protocols);
				let answered = false;
				this.addEventListener("message", (event: MessageEvent) => {
					const data = event.data;
					if (typeof data !== "string" || data === "PING" || data === "PONG")
						return;
					if (gen !== handle.gen) return;
					if (data.includes('"id":null')) {
						handle.#contextError(gen, data);
						return;
					}
					answered = true;
				});
				this.addEventListener("close", () => {
					if (gen !== handle.gen || handle.disposed) return;
					if (answered) {
						handle.#failures = 0;
						return;
					}
					handle.#failures += 1;
					if (handle.#failures >= handle.retryAttempts) {
						handle.block("exhausted", { code: "websocket-closed" });
					}
				});
			}
		}
		const client = createWSClient({
			url: async () => {
				if (gen !== this.gen) return parked<string>();
				credentials = await this.credentialsFor(gen);
				if (!credentials) return parked<string>();
				return webSocketUrl(spec.url);
			},
			connectionParams: async () => {
				const provided = stringHeaders(
					credentialChannel(credentials, "connectionParams"),
				);
				if (gen === this.gen)
					this.#attached = attachedGrant(credentials, provided);
				return stringHeaders(spec.connectionParams, provided);
			},
			lazy: {
				enabled: true,
				closeMs: spec.lazyCloseMs ?? this.ctx.limits.idleCloseMs,
			},
			keepAlive: {
				enabled: true,
				...(spec.keepAlive ?? TRPC_DEFAULTS.keepAlive),
			},
			...(this.#options.retryDelayMs
				? { retryDelayMs: this.#options.retryDelayMs }
				: {}),
			WebSocket: ObservedWebSocket as typeof WebSocket,
		});
		const subscription = client.connectionState.subscribe({
			next: (state) => {
				if (gen !== this.gen || this.disposed) return;
				if (state.state === "pending") return;
				if (state.state === "idle") {
					if (this.records.size === 0)
						this.setState({ state: "inactive", reason: "idle" });
					return;
				}
				if (state.error) {
					// Every subscription shares this socket.
					for (const record of this.records) this.reportLoss(record);
					this.setState({
						state: "reconnecting",
						reason: "network",
						attempt: this.#failures,
					});
				} else if (this.state !== "connected") {
					this.setState({ state: "connecting" });
				}
			},
		});
		this.#unsubscribeState = () => subscription.unsubscribe();
		this.#client = client;
		this.#link = wsLink<AnyTRPCRouter>({
			client,
			...(this.#options.transformer
				? { transformer: this.#options.transformer }
				: {}),
		} as never)({});
		return this.#link;
	}

	#contextError(gen: number, data: string): void {
		let code: string | undefined;
		try {
			const message = JSON.parse(data) as { id: unknown; error?: unknown };
			if (message.id !== null || message.error === undefined) return;
			code = trpcCode(this.#deserialise(message.error));
		} catch {
			return;
		}
		if (gen !== this.gen) return;
		if (code === UNAUTHORIZED) {
			// createContext rejected the connection params: block instead of
			// letting upstream reconnect with the same credentials forever.
			this.block("auth", { code: `trpc:${code}` }, this.#attached);
		} else if (code === FORBIDDEN_CODE) {
			this.forbidden();
		} else {
			this.ctx.diagnostic({
				type: "trpc.connection-error",
				detail: code ? { code } : {},
			});
		}
	}

	protected teardownClient(): void {
		const client = this.#client;
		this.#client = undefined;
		this.#link = undefined;
		this.#failures = 0;
		this.#attached = undefined;
		this.#unsubscribeState?.();
		this.#unsubscribeState = undefined;
		// close() completes every subscription; those completions are fenced.
		client?.close().catch(() => {});
	}
}

export function trpcSseAdapter(
	options: TrpcSseAdapterOptions = {},
): RuntimeAdapter<
	TrpcSseConnection,
	TrpcSubscriptionSpec,
	TrpcEvent,
	never,
	never
> {
	return {
		kind: "trpc-sse",
		version: 1,
		validateConnection(spec: unknown): asserts spec is TrpcSseConnection {
			validateTrpcSseConnection(spec, { absolute: true });
			refuseUnmatchedTransformer(spec, options.transformer);
		},
		validateSubscription(spec: unknown): asserts spec is TrpcSubscriptionSpec {
			validateTrpcSubscription(spec);
		},
		connectionKey(spec) {
			return stableStringify({
				retryAttempts: TRPC_DEFAULTS.retryAttempts,
				...withoutMarker(spec),
				url: new URL(spec.url).toString(),
			});
		},
		connect(spec, ctx) {
			return new TrpcSseConnectionHandle(spec, ctx, options);
		},
	};
}

class TrpcSseConnectionHandle extends TrpcConnectionBase<TrpcSseConnection> {
	readonly #options: TrpcSseAdapterOptions;
	#link: OperationLink | undefined;

	constructor(
		spec: TrpcSseConnection,
		ctx: ConnectionContext,
		options: TrpcSseAdapterOptions,
	) {
		super(spec, ctx);
		this.#options = options;
	}

	protected get credentialUrl(): string {
		return this.spec.url;
	}

	protected attachedFor(record: TrpcRecord): Credentials | undefined {
		return record.grant;
	}

	protected link(): OperationLink {
		if (this.#link) return this.#link;
		const gen = this.gen;
		const spec = this.spec;
		const useHeaders = this.#options.headers === true && !spec.anonymous;
		this.#link = (
			httpSubscriptionLink as (options: unknown) => TRPCLink<AnyTRPCRouter>
		)({
			url: spec.url,
			// Non-secret params only; upstream puts them into the URL query.
			...(spec.connectionParams
				? { connectionParams: spec.connectionParams }
				: {}),
			...(this.#options.EventSource
				? { EventSource: this.#options.EventSource }
				: {}),
			...(this.#options.transformer
				? { transformer: this.#options.transformer }
				: {}),
			// Re-evaluated whenever upstream creates an EventSource, so a
			// recreation after rotation carries the current revision.
			eventSourceOptions: async ({ op }: { op: { id: number } }) => {
				const record = [...this.records].find((item) => item.opId === op.id);
				if (record) record.grant = undefined;
				const init: Record<string, unknown> = {};
				if (spec.withCredentials !== undefined)
					init.withCredentials = spec.withCredentials;
				if (!useHeaders) return init;
				const credentials = await this.credentialsFor(gen);
				if (!credentials) return parked<Record<string, unknown>>();
				const headers = stringHeaders(
					credentialChannel(credentials, "headers"),
				);
				init.headers = headers;
				const grant = attachedGrant(credentials, headers);
				if (grant) {
					// Provider headers never follow a redirect. The
					// EventSource ponyfill must pass `redirect` to its fetch;
					// `manual` makes the refusal visible as a status below.
					init.redirect = "manual";
					if (record) record.grant = grant;
				}
				return init;
			},
		})({});
		return this.#link;
	}

	protected override onState(
		record: TrpcRecord,
		state: Envelope["result"],
	): void {
		if (state.state === "pending") return;
		if (state.state === "connecting" && state.error) {
			// A native EventSource retry after an error (browser-owned loop).
			this.#failed(record, "network");
		} else if (state.state === "connecting" && this.state !== "connected") {
			this.setState({ state: "connecting" });
		}
	}

	protected override onError(record: TrpcRecord, error: unknown): void {
		if (trpcCode(error)) {
			super.onError(record, error);
			return;
		}
		// The EventSource closed (HTTP error status or a failed connection);
		// native EventSource never retries after that, so Spinetab recreates
		// the subscription with its cursor within the attempt budget.
		const status = httpStatusOf(error);
		if (record.grant && status !== undefined && isRefusedRedirect(status)) {
			this.block("failed", { code: "redirect" });
			return;
		}
		if (status === 401) {
			this.block("auth", { code: "http:401" }, record.grant);
			return;
		}
		if (status === 403) {
			this.forbidden();
			return;
		}
		if (
			typeof status === "number" &&
			status >= 400 &&
			status < 500 &&
			status !== 408 &&
			status !== 429
		) {
			this.block("failed", { code: `http:${status}` });
			return;
		}
		this.#failed(record, "network", true);
	}

	#failed(
		record: TrpcRecord,
		reason: ConnectionReason,
		recreate = false,
	): void {
		record.failures += 1;
		if (record.failures >= this.retryAttempts) {
			this.block("exhausted", { code: "eventsource-closed" });
			return;
		}
		this.reportLoss(record);
		this.setState({ state: "reconnecting", reason, attempt: record.failures });
		if (!recreate) return;
		record.release?.();
		record.release = undefined;
		const gen = this.gen;
		const delay =
			this.#options.retryDelayMs?.(record.failures - 1) ??
			Math.min(1_000 * 2 ** (record.failures - 1), 30_000) *
				(0.5 + Math.random() / 2);
		clearTimeout(record.retryTimer);
		record.retryTimer = setTimeout(() => {
			if (gen !== this.gen || !record.active || this.disposed) return;
			this.start(record);
		}, delay);
	}

	protected teardownClient(): void {
		for (const record of this.records) {
			const release = record.release;
			record.release = undefined;
			release?.();
		}
		this.#link = undefined;
	}
}
