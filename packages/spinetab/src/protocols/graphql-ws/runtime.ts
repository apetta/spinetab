import { type Client, CloseCode, createClient } from "graphql-ws/client";
import type {
	AdapterConnection,
	AdapterSubscription,
	ConnectionContext,
	RuntimeAdapter,
	SubscriptionSink,
} from "../../core/adapter.ts";
import { reportInterruption } from "../../core/continuity-phase.ts";
import { stableStringify } from "../../core/identity.ts";
import type {
	ConnectionReason,
	CredentialRequest,
	Credentials,
	Json,
} from "../../core/types.ts";
import {
	type GraphqlPayload,
	isFormattedErrors,
	normaliseOperation,
} from "../graphql/operation.ts";
import type {
	GraphqlResult,
	GraphqlSubscriptionSpec,
} from "../graphql/types.ts";
import {
	attachedGrant,
	boundedText,
	credentialChannel,
	credentialFailureReason,
	FORBIDDEN,
	parked,
} from "../shared/runtime.ts";
import {
	GRAPHQL_WS_DEFAULTS,
	type GraphqlWsConnection,
	validateGraphqlWsConnection,
} from "./spec.ts";

export type { GraphqlPayload } from "../graphql/operation.ts";
export type { GraphqlWsConnection } from "./spec.ts";

/**
 * Worker-side graphql-ws adapter. Hosts the real
 * `graphql-ws` 6.x client, one per connection identity, and lets its own retry
 * loop reconnect and resubscribe. Spinetab composes `shouldRetry` and `on`,
 * adds the missing-pong watchdog (upstream `keepAlive` only sends pings) and
 * maps close codes with the installed `CloseCode` enum:
 *
 * - 4401 Unauthorized → `auth-blocked`, `rejectCredentials(attached)`; 4403
 * Forbidden → `permanent-error` code `forbidden`, rejects nothing
 * - 4408, 4504 and 4499 (`terminate()`) → retried by the upstream loop
 * - 4400, 4004, 4005, 4406, 4409, 4429, 4500 and other 44xx → `failed`
 * - upstream budget exhausted → `retry-exhausted`, intent kept
 */
export interface GraphqlWsAdapterOptions {
	/** Upstream backoff between attempts; default graphql-ws randomised exponential. */
	retryWait?: (retries: number) => Promise<void>;
	/**
	 * Application close classifier. It can only make closes more terminal:
	 * return `"auth"` or `"terminal"`, or `undefined` to keep the default.
	 */
	classifyClose?: (
		code: number,
		reason: string,
	) => "auth" | "terminal" | undefined;
	/** WebSocket constructor for runtimes without a global `WebSocket`. */
	webSocketImpl?: unknown;
	/**
	 * Apply declared response-affecting context (for example Apollo's
	 * `context.spinetab`) to the outgoing payload. Default: context only
	 * separates identities and is not sent.
	 */
	applyContext?: (payload: GraphqlPayload, context: Json) => GraphqlPayload;
}

type Decision = "retry" | "auth" | "forbidden" | "terminal";

/** `TerminatedCloseEvent.code`: emitted by `client.terminate()`; retried upstream. */
const TERMINATED = 4499;
const INTERRUPTED =
	"The connection was interrupted; the operation is not repeatable.";
const RESTARTED = "The connection restarted; the operation is not repeatable.";
/** 401-equivalent: rejects the attached grant. 4403 is `forbidden`. */
const AUTH_CODES: ReadonlySet<number> = new Set([CloseCode.Unauthorized]);
/** Fatal list in graphql-ws 6.3.0 `shouldRetryConnectOrThrow` (dist/client.js). */
const UPSTREAM_FATAL: ReadonlySet<number> = new Set([
	CloseCode.InternalServerError,
	CloseCode.InternalClientError,
	CloseCode.BadRequest,
	CloseCode.BadResponse,
	CloseCode.Unauthorized,
	CloseCode.SubprotocolNotAcceptable,
	CloseCode.SubscriberAlreadyExists,
	CloseCode.TooManyInitialisationRequests,
]);
const RETRIED_44XX: ReadonlySet<number> = new Set([
	CloseCode.ConnectionInitialisationTimeout,
	TERMINATED,
]);
/** Non-fatal internal codes from graphql-ws `isFatalInternalCloseCode`. */
const RETRIED_INTERNAL: ReadonlySet<number> = new Set([
	1000, 1001, 1005, 1006, 1012, 1013, 1014,
]);

export function classifyGraphqlWsClose(code: number): Decision {
	if (AUTH_CODES.has(code)) return "auth";
	if (code === CloseCode.Forbidden) return "forbidden";
	if (UPSTREAM_FATAL.has(code)) return "terminal";
	if (code >= 4400 && code <= 4499 && !RETRIED_44XX.has(code)) {
		return "terminal";
	}
	if (code >= 1000 && code <= 1999 && !RETRIED_INTERNAL.has(code)) {
		return "terminal";
	}
	return "retry";
}

interface CloseLike {
	code: number;
	reason: string;
}

function isCloseLike(value: unknown): value is CloseLike {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { code?: unknown }).code === "number" &&
		"reason" in value
	);
}

/** A WebSocket `error` event (network failure), not a close or thrown error. */
function isNetworkEvent(value: unknown): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		!(value instanceof Error) &&
		(value as { type?: unknown }).type === "error"
	);
}

interface SocketLike {
	readonly readyState: number;
	send(data: string): void;
}

interface OperationRecord {
	readonly payload: GraphqlPayload;
	readonly sink: SubscriptionSink<GraphqlResult>;
	readonly repeatable: boolean;
	active: boolean;
	gen: number;
	release: (() => void) | undefined;
	everConnected: boolean;
	/**
	 * Started while the acknowledged socket was already closing (graphql-ws's
	 * own idle close): its Subscribe goes out on the next socket.
	 */
	joinedClosing: boolean;
	/** The current interruption was already reported as a continuity loss. */
	lossReported: boolean;
	started: boolean;
}

export function graphqlWsAdapter(
	options: GraphqlWsAdapterOptions = {},
): RuntimeAdapter<
	GraphqlWsConnection,
	GraphqlSubscriptionSpec,
	GraphqlResult,
	never,
	never
> {
	return {
		kind: "graphql-ws",
		version: 1,
		validateConnection(spec: unknown): asserts spec is GraphqlWsConnection {
			validateGraphqlWsConnection(spec, { absolute: true });
		},
		validateSubscription(
			spec: unknown,
		): asserts spec is GraphqlSubscriptionSpec {
			normaliseOperation(spec);
		},
		connectionKey(spec) {
			return stableStringify({
				...GRAPHQL_WS_DEFAULTS,
				...spec,
				url: webSocketUrl(spec.url),
			});
		},
		subscriptionKey(spec) {
			return normaliseOperation(spec).key;
		},
		connect(spec, ctx) {
			return new GraphqlWsConnectionHandle(spec, ctx, options);
		},
	};
}

function webSocketUrl(url: string): string {
	const parsed = new URL(url);
	if (parsed.protocol === "http:") parsed.protocol = "ws:";
	else if (parsed.protocol === "https:") parsed.protocol = "wss:";
	return parsed.toString();
}

class GraphqlWsConnectionHandle
	implements AdapterConnection<GraphqlSubscriptionSpec, GraphqlResult>
{
	readonly #spec: GraphqlWsConnection;
	readonly #ctx: ConnectionContext;
	readonly #options: GraphqlWsAdapterOptions;
	readonly #url: string;
	readonly #records = new Set<OperationRecord>();
	readonly #decisions = new WeakMap<object, Decision>();
	#gen = 0;
	#client: Client | undefined;
	#blocked: "auth" | "terminal" | "exhausted" | undefined;
	/** Blocked by the credential audience: rotation never restarts it. */
	#permanent = false;
	/** The grant whose `connectionParams` the current socket sent. */
	#attached: Credentials | undefined;
	#hintRetried = false;
	#socket: SocketLike | undefined;
	#socketGen = -1;
	#pongTimer: ReturnType<typeof setTimeout> | undefined;
	/** Generation whose ping armed the outstanding pong deadline. */
	#pongGen = -1;
	#closeReason: ConnectionReason = "network";
	#nextReason: CredentialRequest["reason"] = "connect";
	/** Close events that a live rotate() caused through terminate(). */
	readonly #deliberate = new WeakSet<object>();
	/** Generation reconnecting after a deliberate restart. */
	#rotating = -1;
	/** Generation reconnecting after a 1000 close with active subscriptions. */
	#closedLive = -1;
	#disposed = false;

	constructor(
		spec: GraphqlWsConnection,
		ctx: ConnectionContext,
		options: GraphqlWsAdapterOptions,
	) {
		this.#spec = spec;
		this.#ctx = ctx;
		this.#options = options;
		this.#url = webSocketUrl(spec.url);
	}

	subscribe(
		spec: GraphqlSubscriptionSpec,
		sink: SubscriptionSink<GraphqlResult>,
		options: { key: string; repeatable: boolean },
	): AdapterSubscription {
		const normalised = normaliseOperation(spec);
		const payload =
			this.#options.applyContext && normalised.context !== undefined
				? this.#options.applyContext(
						{ ...normalised.payload },
						normalised.context,
					)
				: normalised.payload;
		const record: OperationRecord = {
			payload,
			sink,
			repeatable: options.repeatable,
			active: true,
			gen: -1,
			release: undefined,
			everConnected: false,
			joinedClosing: false,
			lossReported: false,
			started: false,
		};
		this.#records.add(record);
		// While blocked, intent is kept but nothing is attempted: only a new
		// credential revision (rotate) or an explicit retry resumes it.
		if (!this.#blocked && !this.#disposed) this.#start(record);
		return {
			unsubscribe: () => this.#release(record),
		};
	}

	retry(): void {
		if (this.#disposed) return;
		if (!this.#blocked && this.#client) return;
		this.#restart("retry");
	}

	rotate(): void {
		if (this.#disposed || this.#permanent) return;
		if (this.#blocked || !this.#client) {
			this.#restart("rotated");
			return;
		}
		// Restart the live connection so the next attempt uses the new
		// revision; the upstream loop reconnects and resubscribes (continuity
		// unknown). The restart is deliberate: the
		// 4499 close terminate() emits is marked so it is not reported as a
		// detected interruption.
		if (this.#socket && this.#socketGen === this.#gen) {
			this.#nextReason = "rotated";
			const client = this.#client;
			const unlisten = client.on("closed", (event) => {
				if (typeof event === "object" && event !== null) {
					this.#deliberate.add(event);
				}
			});
			client.terminate();
			unlisten();
		}
	}

	probe(): void {
		if (this.#disposed) return;
		if (this.#blocked === "exhausted" && !this.#hintRetried) {
			// At most one fresh attempt per exhaustion episode.
			this.#hintRetried = true;
			this.#restart("reconnect");
			return;
		}
		const socket = this.#socket;
		if (socket && this.#socketGen === this.#gen && socket.readyState === 1) {
			// A ping already awaiting its pong answers this hint: sending another
			// adds no evidence and must not postpone the deadline.
			if (this.#pongPending(this.#gen)) return;
			// Resume-time liveness check: one protocol ping with the pong deadline.
			socket.send(JSON.stringify({ type: "ping" }));
			this.#armPongDeadline(this.#gen);
		}
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#gen += 1;
		this.#clearPongDeadline();
		for (const record of this.#records) record.active = false;
		this.#records.clear();
		this.#disposeClient();
	}

	#start(record: OperationRecord): void {
		const client = this.#client ?? this.#createClient();
		// Capture the generation this start belongs to. `#restart()` re-arms the
		// same record under a new generation while the disposed client still
		// owns the old socket; graphql-ws resolves `sink.complete()` once that
		// socket's close arrives, so comparing the mutable `record.gen` would let
		// the stale callback pass as live and end the fresh stream.
		const gen = this.#gen;
		record.gen = gen;
		const socket = this.#socketGen === gen ? this.#socket : undefined;
		// Joining an acknowledged socket: no `connected` event follows. One
		// already closing never carries the Subscribe: upstream awaits the
		// close and sends it on the next socket.
		record.joinedClosing = socket !== undefined && socket.readyState !== 1;
		if (socket?.readyState === 1) record.everConnected = true;
		record.release = client.subscribe<Record<string, unknown>>(record.payload, {
			next: (value) => {
				if (!this.#live(record, gen)) return;
				if (!record.started) {
					record.started = true;
					record.sink.started();
				}
				record.sink.next(value as GraphqlResult);
			},
			error: (error) => {
				if (!this.#live(record, gen)) return;
				this.#upstreamError(record, error);
			},
			complete: () => {
				if (!this.#live(record, gen)) return;
				// Genuine server completion; synthetic ones are fenced.
				record.active = false;
				this.#records.delete(record);
				record.sink.complete();
			},
		});
	}

	#live(record: OperationRecord, gen = record.gen): boolean {
		return record.active && gen === this.#gen && !this.#disposed;
	}

	#release(record: OperationRecord): void {
		if (!record.active) return;
		record.active = false;
		this.#records.delete(record);
		const release = record.release;
		record.release = undefined;
		// Sends Complete when the socket is open; the resulting synthetic
		// completion is ignored because the record is no longer active.
		release?.();
	}

	#createClient(): Client {
		const gen = this.#gen;
		const spec = this.#spec;
		let attempt = 0;
		let credentials: Credentials | undefined;
		const client = createClient({
			url: async () => {
				if (gen !== this.#gen) return parked<string>();
				const reason: CredentialRequest["reason"] =
					attempt === 0 || this.#rotating === gen
						? this.#nextReason
						: "reconnect";
				attempt += 1;
				this.#nextReason = "reconnect";
				if (spec.anonymous) return this.#url;
				try {
					// Resolved before the socket opens so a cross-tab request
					// never uses up the server's init deadline.
					credentials = await this.#ctx.credentials(reason, this.#url);
				} catch (error) {
					if (gen === this.#gen && !this.#disposed) {
						this.#block("auth", {
							reason: credentialFailureReason(error),
						});
					}
					return parked<string>();
				}
				if (gen !== this.#gen || this.#disposed) return parked<string>();
				return this.#url;
			},
			connectionParams: () => {
				const provided = credentialChannel(credentials, "connectionParams");
				if (gen === this.#gen) {
					this.#attached = attachedGrant(credentials, provided);
				}
				const params = { ...(spec.connectionParams ?? {}), ...provided };
				return Object.keys(params).length > 0 ? params : undefined;
			},
			lazy: true,
			lazyCloseTimeout: spec.lazyCloseTimeoutMs ?? this.#ctx.limits.idleCloseMs,
			keepAlive: spec.keepAliveMs ?? GRAPHQL_WS_DEFAULTS.keepAliveMs,
			connectionAckWaitTimeout:
				spec.connectionAckWaitTimeoutMs ??
				GRAPHQL_WS_DEFAULTS.connectionAckWaitTimeoutMs,
			retryAttempts: spec.retryAttempts ?? GRAPHQL_WS_DEFAULTS.retryAttempts,
			...(this.#options.retryWait
				? { retryWait: this.#options.retryWait }
				: {}),
			...(this.#options.webSocketImpl
				? { webSocketImpl: this.#options.webSocketImpl }
				: {}),
			shouldRetry: (error) => this.#shouldRetry(gen, error),
			on: {
				connecting: (isRetry) => {
					if (gen !== this.#gen) return;
					// A live 1000 close reconnects without `retrying`; a
					// deliberate restart retries but is not an interruption.
					const detected =
						(isRetry && this.#rotating !== gen) || this.#closedLive === gen;
					this.#ctx.setStatus(
						detected
							? {
									state: "reconnecting",
									reason: this.#closeReason,
									attempt,
								}
							: { state: "connecting", attempt },
					);
				},
				connected: (socket) => {
					if (gen !== this.#gen) return;
					this.#socket = socket as SocketLike;
					this.#socketGen = gen;
					this.#blocked = undefined;
					this.#hintRetried = false;
					this.#closeReason = "network";
					this.#rotating = -1;
					this.#closedLive = -1;
					// graphql-ws re-sends every active Subscribe itself; the
					// operation is re-executed, so the reconnect outcome is
					// unknown continuity. It is reported before `connected` even
					// when the loss was reported at detection: an application
					// that reconciled then must reconcile again.
					for (const record of this.#records) {
						if (record.gen !== gen) continue;
						if (record.everConnected) record.sink.continuity("reconnected");
						record.everConnected = true;
						record.lossReported = false;
					}
					this.#ctx.setStatus({ state: "connected" });
				},
				ping: (received) => {
					if (!received && gen === this.#gen) this.#armPongDeadline(gen);
				},
				pong: (received) => {
					if (received && gen === this.#gen) this.#clearPongDeadline();
				},
				closed: (event) => {
					if (gen !== this.#gen) return;
					this.#clearPongDeadline();
					this.#socket = undefined;
					// graphql-ws 6.3.0 reconnects after a 1000 close while
					// subscriptions are active without calling `shouldRetry`, so
					// the adapter detects that interruption here.
					const live = () =>
						[...this.#records].some((record) => record.gen === gen);
					// Subscriptions started during graphql-ws's own idle close
					// were never on this socket: they connect afresh.
					const affected = [...this.#records].some(
						(record) => record.gen === gen && !record.joinedClosing,
					);
					for (const record of this.#records) record.joinedClosing = false;
					if (isCloseLike(event) && event.code === 1000 && affected) {
						this.#detected("close:1000");
						// Upstream reconnects only while a subscription is left.
						if (live()) this.#closedLive = gen;
						return;
					}
					if (this.#records.size === 0 && !this.#blocked) {
						this.#ctx.setStatus({ state: "inactive", reason: "idle" });
					}
				},
			},
		});
		this.#client = client;
		return client;
	}

	#shouldRetry(gen: number, error: unknown): boolean {
		if (gen !== this.#gen || this.#disposed) return false;
		if (
			typeof error === "object" &&
			error !== null &&
			this.#deliberate.has(error)
		) {
			// A live rotate(): no early notice and no `reconnecting`; the
			// outcome is reported once, at the new `connected`.
			// Upstream asks once per active subscription for the same close.
			if (this.#rotating !== gen) {
				this.#rotating = gen;
				this.#ctx.setStatus({ state: "connecting" });
				this.#interruptNonRepeatable(RESTARTED);
			}
			return true;
		}
		let decision: Decision;
		let code: string | undefined;
		if (isCloseLike(error)) {
			code = `close:${error.code}`;
			decision = classifyGraphqlWsClose(error.code);
			if (decision === "retry") {
				const custom = this.#options.classifyClose?.(
					error.code,
					boundedText(error.reason),
				);
				if (custom === "auth" || custom === "terminal") decision = custom;
			}
		} else {
			// graphql-ws treats non-CloseEvent problems as fatal by default; a
			// WebSocket error event is a network failure and must be retried so
			// a server restart recovers. Thrown errors stay terminal.
			decision = isNetworkEvent(error) ? "retry" : "terminal";
		}
		if (typeof error === "object" && error !== null) {
			this.#decisions.set(error, decision);
		}
		if (decision !== "retry") return false;
		this.#detected(code);
		return true;
	}

	/**
	 * A detected interruption that upstream retries: the early notice, then
	 * `reconnecting`, then non-repeatable intent ends.
	 */
	#detected(code: string | undefined): void {
		this.#rotating = -1;
		this.#reportLoss();
		this.#ctx.setStatus({
			state: "reconnecting",
			reason: this.#closeReason,
			...(code ? { code } : {}),
		});
		this.#interruptNonRepeatable(INTERRUPTED);
	}

	/** Non-repeatable intent is never re-issued; it ends as `interrupted`. */
	#interruptNonRepeatable(message: string): void {
		for (const record of [...this.#records]) {
			if (record.repeatable || record.gen !== this.#gen) continue;
			record.active = false;
			this.#records.delete(record);
			record.release?.();
			record.sink.error({ code: "interrupted", message });
		}
	}

	/**
	 * Continuity is unknown from the moment an interruption is detected: the
	 * operation is re-executed without replay. Each connected record is told
	 * once, before any status reports the interruption.
	 */
	#reportLoss(): void {
		for (const record of this.#records) {
			if (record.gen !== this.#gen || !record.everConnected) continue;
			if (record.lossReported) continue;
			record.lossReported = true;
			reportInterruption(record.sink, "reconnected");
		}
	}

	#upstreamError(record: OperationRecord, error: unknown): void {
		if (isFormattedErrors(error)) {
			// Operation-level GraphQL errors are terminal for this operation
			// and never retried automatically.
			record.active = false;
			this.#records.delete(record);
			record.sink.error({
				code: "upstream-error",
				message: "The GraphQL operation failed.",
				detail: { errors: error },
			});
			return;
		}
		let decision = this.#decisions.get(error as object);
		let code: string | undefined;
		if (isCloseLike(error)) {
			code = `close:${error.code}`;
			// Fatal codes are thrown before `shouldRetry`; anything still
			// classified as retryable was thrown because the budget ran out.
			decision ??= classifyGraphqlWsClose(error.code);
			if (decision === "retry") decision = undefined;
		} else if (decision === "retry" || isNetworkEvent(error)) {
			decision = undefined;
		}
		const extra = code ? { code } : {};
		if (decision === "auth") this.#block("auth", extra);
		else if (decision === "forbidden") this.#block("forbidden", {});
		else if (decision === "terminal") this.#block("terminal", extra);
		else this.#block("exhausted", extra);
	}

	#block(
		kind: "auth" | "forbidden" | "terminal" | "exhausted",
		detail: { reason?: ConnectionReason; code?: string },
	): void {
		if (this.#disposed) return;
		this.#blocked = kind === "forbidden" ? "terminal" : kind;
		this.#permanent = detail.reason === "credentials-audience";
		const attached = this.#attached;
		this.#attached = undefined;
		// Fence the dead client: later callbacks from it are ignored and the
		// connection reports a single status instead of N consumer errors.
		this.#gen += 1;
		this.#clearPongDeadline();
		this.#socket = undefined;
		this.#disposeClient();
		if (kind === "auth") {
			// Only a 401-equivalent names a grant, and only one that was sent.
			if (detail.reason === undefined && attached) {
				this.#ctx.rejectCredentials(attached);
			}
			this.#ctx.setStatus({
				state: "auth-blocked",
				reason: detail.reason ?? "credentials-rejected",
				...(detail.code ? { code: detail.code } : {}),
			});
		} else if (kind === "forbidden") {
			this.#ctx.setStatus(FORBIDDEN);
		} else if (kind === "terminal") {
			this.#ctx.setStatus({
				state: "failed",
				reason: "protocol-error",
				...(detail.code ? { code: detail.code } : {}),
			});
		} else {
			this.#ctx.setStatus({
				state: "retry-exhausted",
				reason: "attempts-exhausted",
				...(detail.code ? { code: detail.code } : {}),
			});
		}
	}

	#restart(reason: CredentialRequest["reason"]): void {
		this.#gen += 1;
		this.#clearPongDeadline();
		this.#socket = undefined;
		this.#disposeClient();
		this.#blocked = undefined;
		this.#permanent = false;
		this.#attached = undefined;
		this.#nextReason = reason;
		for (const record of [...this.#records]) {
			if (!record.repeatable && record.everConnected) {
				record.active = false;
				this.#records.delete(record);
				record.sink.error({ code: "interrupted", message: RESTARTED });
				continue;
			}
			this.#start(record);
		}
	}

	#disposeClient(): void {
		const client = this.#client;
		this.#client = undefined;
		if (!client) return;
		// A parked connect never settles; a rejected one must not surface as
		// an unhandled rejection.
		Promise.resolve(client.dispose()).catch(() => {});
	}

	#pongPending(gen: number): boolean {
		return this.#pongTimer !== undefined && this.#pongGen === gen;
	}

	/**
	 * Arms the missing-pong deadline for a sent ping. A later ping is not
	 * evidence of a pong, so while a deadline is outstanding for this
	 * generation it is kept, never restarted: repeated hints and keepAlive
	 * pings cannot postpone detection. Only a received
	 * pong, a close, a generation change or disposal clears it.
	 */
	#armPongDeadline(gen: number): void {
		if (this.#pongPending(gen)) return;
		this.#clearPongDeadline();
		this.#pongGen = gen;
		const timeout =
			this.#spec.pongTimeoutMs ?? GRAPHQL_WS_DEFAULTS.pongTimeoutMs;
		const armedAt = this.#ctx.now();
		const fire = (remaining: number) => {
			this.#pongTimer = setTimeout(() => {
				this.#pongTimer = undefined;
				if (gen !== this.#gen || this.#disposed) return;
				// Deadlines count executable time: after a suspension the
				// watchdog re-arms for the time remaining from the original
				// arm instead of firing a stale timer.
				const elapsed = this.#ctx.now() - armedAt;
				if (elapsed < timeout) {
					fire(timeout - elapsed);
					return;
				}
				this.#closeReason = "heartbeat-timeout";
				this.#reportLoss();
				this.#ctx.setStatus({
					state: "reconnecting",
					reason: "heartbeat-timeout",
				});
				this.#ctx.diagnostic({ type: "graphql-ws.pong-timeout" });
				// Emits the retryable 4499 close; the upstream loop reconnects
				// and re-sends every active Subscribe.
				this.#client?.terminate();
			}, remaining);
		};
		fire(timeout);
	}

	#clearPongDeadline(): void {
		if (this.#pongTimer !== undefined) clearTimeout(this.#pongTimer);
		this.#pongTimer = undefined;
	}
}
