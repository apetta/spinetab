import {
	type Client,
	createClient,
	NetworkError,
	TOKEN_HEADER_KEY,
} from "graphql-sse";
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
	ConnectionStatus,
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
	credentialChannel,
	credentialFailureReason,
	FORBIDDEN,
	isRefusedRedirect,
	stringHeaders,
} from "../shared/runtime.ts";
import {
	type GraphqlSseConnection,
	validateGraphqlSseConnection,
} from "./spec.ts";

export type { GraphqlSseConnection } from "./spec.ts";

/**
 * Worker-side graphql-sse adapter. Hosts the real
 * `graphql-sse` 2.x client in the connection's mode (default `distinct`).
 * The upstream client owns backoff and `retryAttempts`; Spinetab supplies a
 * classifying `fetchFn`:
 *
 * - 401 → `auth-blocked` after that single request; the grant that request
 * carried is rejected
 * - 403 → `failed` / `permanent-error` with code `forbidden`; nothing is
 * rejected
 * - 400, 404, 405, 406, 409, 413, 415, 422 → `failed` (single-mode
 * reservations answered 404/405/415 → `unsupported-mode`)
 * - 408, 425, 429, 5xx and network failures → left to upstream `NetworkError`
 *
 * `Retry-After` is not honoured upstream and is not emulated.
 */
export interface GraphqlSseAdapterOptions {
	/** Upstream backoff between attempts; default graphql-sse randomised exponential. */
	retry?: (retries: number) => Promise<void>;
	/** Fetch implementation; default the realm's `fetch`. */
	fetchFn?: typeof fetch;
}

const PERMANENT_STATUSES: ReadonlySet<number> = new Set([
	400, 404, 405, 406, 409, 413, 415, 422,
]);
const UNSUPPORTED_MODE_STATUSES: ReadonlySet<number> = new Set([404, 405, 415]);
const HEARTBEAT_FACTOR = 2.5;

/**
 * Carries the grant from `headers()` to `#fetch` for one request. graphql-sse
 * spreads the headers object into each request's init, which keeps enumerable
 * symbol keys; `#fetch` removes it before the real fetch sees the headers.
 */
const GRANT: unique symbol = Symbol("spinetab.grant");
type GrantHeaders = Record<string, string> & { [GRANT]?: Credentials };

/** Thrown into the upstream client after Spinetab stopped the connection. */
class StoppedError extends Error {
	constructor() {
		super("Stopped by Spinetab");
		this.name = "StoppedError";
	}
}

const INTERRUPTED =
	"The connection was interrupted; the operation is not repeatable.";

interface Reservation {
	/** Spinetab's signal for the event stream, aborted with upstream's. */
	readonly controller: AbortController;
	/** Operations whose latest POST used this reservation's token. */
	readonly operations: Set<string>;
	/** Upstream no longer reuses it: replaced, or an operation POST failed. */
	stale: boolean;
	/** Its event stream answered; operations awaiting it have POSTed. */
	established: boolean;
}

/**
 * Single mode: every reservation event stream (the GET after a PUT) one
 * upstream client opened, keyed by its token. graphql-sse 2.6.1 drops its
 * connection on any operation's NetworkError without aborting it, and its
 * lazy close and `dispose()` abort only the newest one; concurrent
 * reconnects may even share one connection signal. Each stream therefore runs
 * on Spinetab's own signal, aborted with upstream's, and a stale one is closed
 * once no operation runs on it. Closing waits for a later task, so an
 * operation that obtained the reservation has POSTed by then.
 */
class Reservations {
	readonly #open = new Map<string, Reservation>();
	#timer: ReturnType<typeof setTimeout> | undefined;
	#closed = false;

	/** The signal for a reservation's event stream; it replaces the others. */
	stream(upstream: AbortSignal | undefined, token: string): AbortSignal {
		if (this.#closed) return AbortSignal.abort();
		for (const other of this.#open.values()) other.stale = true;
		this.#drop(token);
		const reservation: Reservation = {
			controller: new AbortController(),
			operations: new Set(),
			stale: false,
			established: false,
		};
		this.#open.set(token, reservation);
		if (upstream?.aborted) this.#drop(token, upstream.reason);
		else {
			upstream?.addEventListener(
				"abort",
				() => {
					if (this.#open.get(token) === reservation) {
						this.#drop(token, upstream.reason);
					}
				},
				{ once: true },
			);
		}
		return reservation.controller.signal;
	}

	/** An operation POST is about to use the reservation holding `token`. */
	attach(token: string | undefined, operation: string): void {
		this.detach(operation);
		if (token !== undefined) this.#open.get(token)?.operations.add(operation);
	}

	detach(operation: string | undefined): void {
		if (operation === undefined) return;
		for (const reservation of this.#open.values()) {
			reservation.operations.delete(operation);
		}
		this.#schedule();
	}

	/** Records how a tracked request settled (`ok` per upstream's own test). */
	settle(
		method: string,
		upstream: AbortSignal | undefined,
		token: string | undefined,
		operation: string | undefined,
		ok: boolean,
	): void {
		if (this.#closed || token === undefined) return;
		if (method === "GET") {
			const reservation = this.#open.get(token);
			if (!reservation) return;
			if (!ok) this.#drop(token);
			else {
				reservation.established = true;
				this.#schedule();
			}
			return;
		}
		if (method === "DELETE" || (method === "POST" && !ok)) {
			// A failed POST makes upstream drop its connection (lazy mode),
			// unless the operation itself was stopped.
			const reservation = this.#open.get(token);
			if (reservation && method === "POST" && !upstream?.aborted) {
				reservation.stale = true;
			}
			this.detach(operation);
		}
	}

	closeAll(): void {
		this.#closed = true;
		if (this.#timer !== undefined) clearTimeout(this.#timer);
		this.#timer = undefined;
		for (const token of [...this.#open.keys()]) this.#drop(token);
	}

	#schedule(): void {
		if (this.#closed || this.#timer !== undefined) return;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			for (const [token, reservation] of [...this.#open]) {
				if (
					reservation.stale &&
					reservation.established &&
					reservation.operations.size === 0
				) {
					this.#drop(token);
				}
			}
		}, 0);
	}

	#drop(token: string, reason?: unknown): void {
		const reservation = this.#open.get(token);
		if (!reservation) return;
		this.#open.delete(token);
		reservation.controller.abort(reason);
	}
}

interface SseRecord {
	readonly payload: GraphqlPayload;
	readonly sink: SubscriptionSink<GraphqlResult>;
	readonly repeatable: boolean;
	active: boolean;
	gen: number;
	release: (() => void) | undefined;
	attempts: number;
	everConnected: boolean;
	/** The current interruption was already reported as a continuity loss. */
	lossReported: boolean;
	/** Single mode: the operation was accepted on the current reservation. */
	accepted: boolean;
	started: boolean;
	operationId: string | undefined;
}

export function graphqlSseAdapter(
	options: GraphqlSseAdapterOptions = {},
): RuntimeAdapter<
	GraphqlSseConnection,
	GraphqlSubscriptionSpec,
	GraphqlResult,
	never,
	never
> {
	return {
		kind: "graphql-sse",
		version: 1,
		validateConnection(spec: unknown): asserts spec is GraphqlSseConnection {
			validateGraphqlSseConnection(spec, { absolute: true });
		},
		validateSubscription(
			spec: unknown,
		): asserts spec is GraphqlSubscriptionSpec {
			normaliseOperation(spec);
		},
		connectionKey(spec) {
			return stableStringify({
				credentials: "same-origin",
				retryAttempts: 5,
				...spec,
				// Omitted and default share one connection.
				mode: spec.mode ?? "distinct",
				url: new URL(spec.url).toString(),
			});
		},
		subscriptionKey(spec) {
			// Single mode injects `extensions.operationId` itself after
			// identity is computed, so a caller-supplied one is not identity.
			return normaliseOperation(spec, "subscription", {
				omitExtensions: ["operationId"],
			}).key;
		},
		connect(spec, ctx) {
			return new GraphqlSseConnectionHandle(spec, ctx, options);
		},
	};
}

class GraphqlSseConnectionHandle
	implements AdapterConnection<GraphqlSubscriptionSpec, GraphqlResult>
{
	readonly #spec: GraphqlSseConnection;
	readonly #ctx: ConnectionContext;
	readonly #options: GraphqlSseAdapterOptions;
	readonly #records = new Set<SseRecord>();
	readonly #byPayload = new WeakMap<object, SseRecord>();
	readonly #byOperation = new Map<string, SseRecord>();
	/** Liveness checks for stream requests whose response is still pending. */
	readonly #opening = new Set<() => void>();
	/** Single mode: operations awaiting a successful POST on their reservation. */
	#unaccepted = 0;
	#gen = 0;
	#client: Client | undefined;
	/** Single mode: the current client's reservations. */
	#reservations: Reservations | undefined;
	#blocked: "auth" | "terminal" | "exhausted" | undefined;
	/** Blocked by the credential audience: rotation never restarts it. */
	#permanent = false;
	#hintRetried = false;
	#state: ConnectionStatus["state"] = "inactive";
	#pending: SseRecord | undefined;
	#nextReason: CredentialRequest["reason"] = "connect";
	#closeReason: ConnectionReason = "network";
	#disposed = false;

	constructor(
		spec: GraphqlSseConnection,
		ctx: ConnectionContext,
		options: GraphqlSseAdapterOptions,
	) {
		this.#spec = spec;
		this.#ctx = ctx;
		this.#options = options;
	}

	get #single(): boolean {
		return this.#spec.mode === "single";
	}

	subscribe(
		spec: GraphqlSubscriptionSpec,
		sink: SubscriptionSink<GraphqlResult>,
		options: { key: string; repeatable: boolean },
	): AdapterSubscription {
		const { payload } = normaliseOperation(spec, "subscription", {
			omitExtensions: this.#single ? ["operationId"] : [],
		});
		const record: SseRecord = {
			payload,
			sink,
			repeatable: options.repeatable,
			active: true,
			gen: -1,
			release: undefined,
			attempts: 0,
			everConnected: false,
			lossReported: false,
			accepted: false,
			started: false,
			operationId: undefined,
		};
		this.#records.add(record);
		if (this.#single) this.#unaccepted += 1;
		if (!this.#blocked && !this.#disposed) this.#start(record);
		return { unsubscribe: () => this.#release(record) };
	}

	retry(): void {
		if (this.#disposed) return;
		if (!this.#blocked && this.#client) return;
		this.#restart("retry");
	}

	rotate(): void {
		if (this.#disposed || this.#permanent) return;
		// Streams carry the headers captured when they opened; a rotation
		// restarts them so the new revision is used (continuity unknown).
		this.#restart("rotated");
	}

	probe(): void {
		if (this.#disposed || this.#records.size === 0) return;
		if (this.#blocked === "exhausted") {
			if (this.#hintRetried) return;
			this.#hintRetried = true;
			this.#restart("reconnect");
			return;
		}
		if (this.#blocked) return;
		for (const check of this.#opening) check();
		// With a declared heartbeat the byte watchdog is the liveness check.
		// Otherwise reopen repeatable streams after a detected gap.
		if (this.#spec.heartbeatMs === undefined) this.#restart("reconnect");
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#gen += 1;
		for (const record of this.#records) record.active = false;
		this.#records.clear();
		this.#byOperation.clear();
		this.#disposeClient();
	}

	#start(record: SseRecord): void {
		const client = this.#client ?? this.#createClient();
		// Capture the generation this start belongs to. `#restart()` re-arms the
		// same record under a new generation while the disposed client's late
		// `complete`/`error` (graphql-sse resolves `sink.complete()` after an
		// abort) is still in flight; comparing the mutable `record.gen` would
		// let that stale callback pass as live and end the fresh stream.
		const gen = this.#gen;
		record.gen = gen;
		record.attempts = 0;
		this.#byPayload.set(record.payload, record);
		this.#pending = record;
		record.release = client.subscribe<Record<string, unknown>>(
			record.payload,
			{
				next: (value) => {
					if (!this.#live(record, gen)) return;
					// A distinct stream that delivers is live: a loss flagged by a
					// twin's stall (byte-identical payload) no longer applies, so
					// this stream's own interruption is still reported. Single
					// mode clears it when its operation POST is accepted.
					if (!this.#single) record.lossReported = false;
					if (!record.started) {
						record.started = true;
						record.sink.started();
					}
					record.sink.next(value as GraphqlResult);
				},
				error: (error) => {
					if (!this.#live(record, gen)) return;
					this.#upstreamError(error);
				},
				complete: () => {
					if (!this.#live(record, gen)) return;
					// The server completed the operation (`complete` event);
					// Spinetab-initiated aborts are fenced above. No DELETE follows.
					this.#reservations?.detach(record.operationId);
					this.#forget(record);
					record.sink.complete();
				},
			},
			// Distinct streams are independent: upstream reports each one to the
			// client-level callbacks first, so status follows the stream here,
			// after its own continuity.
			this.#single
				? undefined
				: {
						connecting: (reconnecting) => {
							if (!this.#live(record, gen)) return;
							this.#connecting(reconnecting, record);
							// Upstream is about to re-send an accepted operation.
							if (reconnecting && !record.repeatable && record.everConnected) {
								this.#interrupt(record);
							}
						},
						connected: () => {
							if (!this.#live(record, gen)) return;
							this.#streamOpened(record);
							this.#connected();
						},
					},
		);
		this.#pending = undefined;
	}

	#live(record: SseRecord, gen = record.gen): boolean {
		return record.active && gen === this.#gen && !this.#disposed;
	}

	#forget(record: SseRecord): void {
		if (this.#single && !record.accepted) this.#unaccepted -= 1;
		record.active = false;
		this.#records.delete(record);
		if (record.operationId) this.#byOperation.delete(record.operationId);
		// A pending operation no longer holds back an accepted sibling.
		if (
			this.#single &&
			this.#records.size > 0 &&
			!this.#blocked &&
			!this.#disposed &&
			this.#state !== "connected"
		)
			this.#connected();
	}

	#release(record: SseRecord): void {
		if (!record.active) return;
		this.#forget(record);
		const release = record.release;
		record.release = undefined;
		// Distinct: aborts the stream. Single: aborts and sends one DELETE.
		release?.();
		if (this.#records.size === 0 && !this.#blocked)
			this.#setState({ state: "inactive", reason: "idle" });
	}

	/**
	 * Non-repeatable intent is never re-sent after the server accepted it: it ends as `interrupted` after the early notice,
	 * and the upstream subscription is stopped before it re-sends.
	 */
	#interrupt(record: SseRecord): void {
		this.#forget(record);
		const release = record.release;
		record.release = undefined;
		release?.();
		record.sink.error({ code: "interrupted", message: INTERRUPTED });
		if (this.#records.size === 0 && !this.#blocked)
			this.#setState({ state: "inactive", reason: "idle" });
	}

	/** A stream (distinct) or operation POST (single) was accepted. */
	#streamOpened(record: SseRecord): void {
		// Single-mode GET readiness does not establish the operation. Report
		// restoration at its accepted POST, so an application refetch cannot
		// run before the replacement subscription has been registered.
		const restored = record.everConnected;
		if (this.#single && !record.accepted) this.#unaccepted -= 1;
		record.accepted = true;
		record.everConnected = true;
		record.lossReported = false;
		if (restored) record.sink.continuity("reconnected");
		if (this.#single) this.#connected();
	}

	/**
	 * Continuity is unknown from the moment an interruption is detected: the
	 * operation is re-executed without replay. Each connected record is told
	 * once, before any status reports the interruption.
	 */
	#reportLoss(affected?: (record: SseRecord) => boolean): void {
		for (const record of this.#records) {
			if (!this.#live(record) || !record.everConnected) continue;
			if (record.lossReported || (affected && !affected(record))) continue;
			record.lossReported = true;
			reportInterruption(record.sink, "reconnected");
		}
	}

	/** Upstream starts an attempt: for one distinct stream, or the reservation. */
	#connecting(reconnecting: boolean, record?: SseRecord): void {
		// Single mode shares upstream's retry flag: results from a retained
		// sibling can clear it while another operation waits to retry. A new
		// reservation with an established operation is still recovery.
		if (this.#single && !reconnecting) {
			for (const operation of this.#records) {
				if (this.#live(operation) && operation.accepted) {
					reconnecting = true;
					break;
				}
			}
		}
		if (reconnecting) {
			this.#reportLoss(record && ((other) => other === record));
			this.#setState({ state: "reconnecting", reason: this.#closeReason });
		} else if (this.#state !== "connected") {
			this.#setState({ state: "connecting" });
		}
	}

	#connected(): void {
		if (this.#single) {
			const gen = this.#gen;
			// Each live operation must be accepted, including a quiet feed.
			// Failed, cancelled and stale POSTs cannot establish readiness.
			if (
				this.#records.size === 0 ||
				this.#state === "connected" ||
				this.#unaccepted !== 0
			)
				return;
			// Upstream may retain an accepted sibling on an older reservation
			// while another POST retries. Its recovery phase also settles once
			// every pending operation is accepted; it is never re-POSTed here.
			for (const record of this.#records) {
				if (!record.lossReported) continue;
				record.lossReported = false;
				record.sink.continuity("reconnected");
				if (gen !== this.#gen) return;
			}
			// A callback can rotate, dispose, remove or add a subscription.
			if (
				gen !== this.#gen ||
				this.#disposed ||
				this.#blocked ||
				this.#records.size === 0 ||
				(this.#state as ConnectionStatus["state"]) === "connected" ||
				this.#unaccepted !== 0
			)
				return;
		}
		this.#blocked = undefined;
		this.#hintRetried = false;
		this.#closeReason = "network";
		this.#setState({ state: "connected" });
	}

	#createClient(): Client {
		const gen = this.#gen;
		const spec = this.#spec;
		const tracked = this.#single ? new Reservations() : undefined;
		this.#reservations = tracked;
		let reservations = 0;
		const client = createClient<boolean>({
			url: spec.url,
			singleConnection: this.#single,
			lazy: true,
			lazyCloseTimeout: spec.lazyCloseTimeoutMs ?? this.#ctx.limits.idleCloseMs,
			retryAttempts: spec.retryAttempts ?? 5,
			...(this.#options.retry ? { retry: this.#options.retry } : {}),
			credentials: spec.credentials ?? "same-origin",
			generateID: () => {
				const id = randomId();
				const record = this.#pending;
				if (record) {
					record.operationId = id;
					this.#byOperation.set(id, record);
				}
				return id;
			},
			headers: async (request?: unknown) => {
				if (gen !== this.#gen) throw new StoppedError();
				let first: boolean;
				if (request) {
					const record = this.#byPayload.get(request as object);
					first = (record ? record.attempts++ : 1) === 0;
				} else {
					first = reservations++ === 0;
				}
				const reason = first ? this.#nextReason : "reconnect";
				// A restart's reason (`rotated`, `retry`) is used by the first
				// request after it; later first attempts are ordinary connects.
				if (first) this.#nextReason = "connect";
				let credentials: Credentials | undefined;
				if (!spec.anonymous) {
					try {
						credentials = await this.#ctx.credentials(reason, spec.url);
					} catch (error) {
						if (gen === this.#gen) {
							this.#block("auth", { reason: credentialFailureReason(error) });
						}
						// A non-network error is reported at once; no request is sent.
						throw new StoppedError();
					}
					if (gen !== this.#gen) throw new StoppedError();
				}
				const provided = stringHeaders(
					credentialChannel(credentials, "headers"),
				);
				const headers: GrantHeaders = stringHeaders(spec.headers, provided);
				const grant = attachedGrant(credentials, provided);
				if (grant) headers[GRANT] = grant;
				return headers;
			},
			fetchFn: (input: RequestInfo | URL, init?: RequestInit) =>
				this.#fetch(gen, tracked, input, init),
			// Single mode only; distinct streams report through `#start`.
			on: {
				connecting: (reconnecting) => {
					if (gen === this.#gen && this.#single) this.#connecting(reconnecting);
				},
				// Single-mode GET readiness precedes operation registration. Its
				// accepted POST establishes readiness in #streamOpened instead.
			},
		});
		this.#client = client;
		return client;
	}

	async #fetch(
		gen: number,
		tracked: Reservations | undefined,
		input: RequestInfo | URL,
		init: RequestInit | undefined,
	): Promise<Response> {
		const fetchFn = this.#options.fetchFn ?? fetch;
		const { [GRANT]: grant, ...headers } = (init?.headers ??
			{}) as GrantHeaders;
		const method = (init?.method ?? "GET").toUpperCase();
		const upstream = init?.signal ?? undefined;
		const token = headers[TOKEN_HEADER_KEY];
		const operation = !tracked
			? undefined
			: method === "POST"
				? operationIdOf(init?.body)
				: method === "DELETE"
					? operationIdOfUrl(input)
					: undefined;
		let signal = upstream;
		if (tracked && method === "GET" && token !== undefined) {
			signal = tracked.stream(upstream, token);
		} else if (tracked && method === "POST" && operation !== undefined) {
			const record = this.#byOperation.get(operation);
			if (
				gen === this.#gen &&
				record &&
				this.#live(record) &&
				record.everConnected &&
				!record.repeatable
			) {
				// Upstream re-sends an operation the server accepted.
				tracked.detach(operation);
				this.#interrupt(record);
				throw new StoppedError();
			}
			if (
				gen === this.#gen &&
				record &&
				this.#live(record) &&
				record.accepted
			) {
				this.#unaccepted += 1;
				record.accepted = false;
			}
			tracked.attach(token, operation);
		}
		// Provider headers never follow a redirect. `manual` rather than
		// `error`, because the platform reports `error`'s refusal as a network
		// failure that upstream would retry; a manual redirect is visible below.
		const request: RequestInit = {
			...init,
			headers,
			...(signal ? { signal } : {}),
			...(grant ? { redirect: "manual" as const } : {}),
		};
		let response: Response;
		try {
			// Network failures reject here and become upstream `NetworkError`s.
			response = await this.#fetchResponse(gen, fetchFn, input, request);
		} catch (error) {
			tracked?.settle(method, upstream, token, operation, false);
			throw error;
		}
		const status = response.status;
		// A single-mode POST registers one operation on an existing stream.
		// A GraphQL validation rejection belongs to that operation, whereas
		// reservation, authentication and malformed HTTP failures retain the
		// connection-wide policy below. Abort before upstream can retry the POST.
		if (
			this.#single &&
			method === "POST" &&
			(status === 400 || status === 422)
		) {
			const record = this.#byOperation.get(operation ?? "");
			if (gen !== this.#gen || !record || !this.#live(record)) return response;
			const errors = await rejectionErrors(
				response,
				upstream,
				this.#ctx.limits.maxFrameBytes,
				this.#ctx.limits.commandTimeoutMs,
			);
			if (gen !== this.#gen || !this.#live(record)) return response;
			if (errors) {
				tracked?.detach(operation);
				this.#release(record);
				record.sink.error({
					code: "upstream-error",
					message: "The GraphQL operation failed.",
					detail: { errors },
				});
				return response;
			}
		}
		// Upstream's own success tests: 201 reservation, 202 operation.
		tracked?.settle(
			method,
			upstream,
			token,
			operation,
			method === "PUT"
				? status === 201
				: method === "POST"
					? status === 202
					: response.ok,
		);
		if (gen !== this.#gen || this.#disposed) return response;
		if (method === "DELETE") {
			// A failed stop is a diagnostic only and is never retried.
			if (status !== 200) {
				this.#ctx.diagnostic({
					type: "graphql-sse.complete-failed",
					detail: { status },
				});
			}
			return response;
		}
		if (grant && isRefusedRedirect(status)) {
			this.#block("terminal", { code: "redirect" });
			return response;
		}
		if (status === 401) {
			this.#block("auth", { code: "http:401" }, grant);
			return response;
		}
		if (status === 403) {
			this.#block("forbidden", {});
			return response;
		}
		if (PERMANENT_STATUSES.has(status)) {
			const unsupportedMode =
				this.#single &&
				method === "PUT" &&
				UNSUPPORTED_MODE_STATUSES.has(status);
			this.#block("terminal", {
				code: unsupportedMode ? `unsupported-mode:${status}` : `http:${status}`,
			});
			return response;
		}
		if (this.#single && method === "POST" && status === 202) {
			const record = this.#byOperation.get(operationIdOf(init?.body) ?? "");
			if (record && this.#live(record)) this.#streamOpened(record);
		}
		if (
			response.ok &&
			this.#spec.heartbeatMs !== undefined &&
			response.body &&
			(response.headers.get("content-type") ?? "").includes("text/event-stream")
		) {
			return this.#watch(
				gen,
				response,
				this.#spec.heartbeatMs,
				init?.body,
				signal,
			);
		}
		return response;
	}

	/** A browser may keep fetch pending until the first response body bytes. */
	#fetchResponse(
		gen: number,
		fetchFn: typeof fetch,
		input: RequestInfo | URL,
		request: RequestInit,
	): Promise<Response> {
		const heartbeat = this.#spec.heartbeatMs;
		const streaming = this.#single
			? request.method === "GET"
			: request.method === "POST";
		if (heartbeat === undefined || !streaming) return fetchFn(input, request);
		const control = new AbortController();
		const upstream = request.signal;
		// Keep upstream cancellation attached for the response body's lifetime,
		// even after the temporary opening listener and timer are removed.
		const signal = upstream
			? AbortSignal.any([upstream, control.signal])
			: control.signal;
		const limit = Math.round(heartbeat * HEARTBEAT_FACTOR);
		const started = this.#ctx.now();
		return new Promise<Response>((resolve, reject) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			let settled = false;
			const clear = () => {
				if (timer !== undefined) clearTimeout(timer);
				timer = undefined;
				this.#opening.delete(check);
				signal.removeEventListener("abort", abort);
			};
			const abort = () => {
				if (settled) return;
				settled = true;
				clear();
				reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
			};
			const check = () => {
				if (settled) return;
				const remaining = limit - (this.#ctx.now() - started);
				if (remaining > 0) {
					if (timer !== undefined) clearTimeout(timer);
					timer = setTimeout(check, remaining);
					return;
				}
				settled = true;
				clear();
				if (gen === this.#gen && !this.#disposed) {
					const affected = (record: SseRecord) =>
						this.#single || JSON.stringify(record.payload) === request.body;
					this.#closeReason = "heartbeat-timeout";
					this.#reportLoss(affected);
					if (gen === this.#gen && !this.#disposed) {
						this.#setState({
							state: "reconnecting",
							reason: "heartbeat-timeout",
						});
						this.#ctx.diagnostic({ type: "graphql-sse.heartbeat-timeout" });
						// An unacknowledged operation may already have executed.
						if (!this.#single) {
							for (const record of this.#records) {
								if (affected(record) && !record.repeatable)
									this.#interrupt(record);
							}
						}
					}
				}
				const error = new NetworkError(
					`No response for ${limit} ms (declared heartbeat)`,
				);
				control.abort(error);
				reject(error);
			};
			if (signal.aborted) {
				abort();
				return;
			}
			signal.addEventListener("abort", abort, { once: true });
			this.#opening.add(check);
			timer = setTimeout(check, limit);
			Promise.resolve()
				.then(() => fetchFn(input, { ...request, signal }))
				.then(
					(response) => {
						if (settled) {
							response.body?.cancel().catch(() => {});
							return;
						}
						settled = true;
						clear();
						resolve(response);
					},
					(error: unknown) => {
						if (settled) return;
						settled = true;
						clear();
						reject(error);
					},
				);
		});
	}

	/**
	 * Byte watchdog for a declared server heartbeat: comment lines count, so a
	 * quiet feed that still sends heartbeats stays open; a silent half-open
	 * stream is failed with `NetworkError`, which upstream retries.
	 */
	#watch(
		gen: number,
		response: Response,
		heartbeatMs: number,
		requestBody: unknown,
		signal: AbortSignal | undefined,
	): Response {
		const source = response.body as ReadableStream<Uint8Array>;
		const reader = source.getReader();
		const limit = Math.round(heartbeatMs * HEARTBEAT_FACTOR);
		let timer: ReturnType<typeof setTimeout> | undefined;
		let settled = false;
		let abort: () => void;
		const clearTimer = () => {
			if (timer !== undefined) clearTimeout(timer);
			timer = undefined;
		};
		const clear = () => {
			clearTimer();
			signal?.removeEventListener("abort", abort);
		};
		const cancelReader = (reason?: unknown) =>
			reader
				.cancel(reason)
				.catch(() => {})
				.finally(() => reader.releaseLock());
		const body = new ReadableStream<Uint8Array>({
			start: (controller) => {
				const fail = (error: unknown) => {
					if (settled) return;
					settled = true;
					clear();
					controller.error(error);
					void cancelReader(error);
				};
				// Own cancellation of the wrapped reader, not just fetch's signal.
				// This also clears the watchdog when a browser does not reject the
				// pending body read after the upstream operation is aborted.
				abort = () =>
					fail(signal?.reason ?? new DOMException("Aborted", "AbortError"));
				if (signal?.aborted) {
					abort();
					return;
				}
				signal?.addEventListener("abort", abort, { once: true });
				const arm = (remaining: number, armedAt: number) => {
					clearTimer();
					timer = setTimeout(() => {
						const elapsed = this.#ctx.now() - armedAt;
						if (elapsed < limit) {
							arm(limit - elapsed, armedAt);
							return;
						}
						if (gen === this.#gen && !this.#disposed) {
							this.#closeReason = "heartbeat-timeout";
							this.#reportLoss(
								requestBody === undefined
									? undefined
									: (record) => JSON.stringify(record.payload) === requestBody,
							);
							this.#setState({
								state: "reconnecting",
								reason: "heartbeat-timeout",
							});
							this.#ctx.diagnostic({ type: "graphql-sse.heartbeat-timeout" });
						}
						fail(
							new NetworkError(`No bytes for ${limit} ms (declared heartbeat)`),
						);
					}, remaining);
				};
				arm(limit, this.#ctx.now());
				const pump = (): void => {
					reader.read().then(({ done, value }) => {
						if (settled) return;
						if (done) {
							settled = true;
							clear();
							reader.releaseLock();
							controller.close();
							return;
						}
						arm(limit, this.#ctx.now());
						controller.enqueue(value);
						pump();
					}, fail);
				};
				pump();
			},
			cancel: (reason) => {
				if (settled) return;
				settled = true;
				clear();
				return cancelReader(reason);
			},
		});
		return new Response(body, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	}

	#upstreamError(error: unknown): void {
		if (error instanceof StoppedError) return;
		if (error instanceof NetworkError) {
			// Upstream gave up after `retryAttempts` network failures.
			const status = (error as { response?: { status?: number } }).response
				?.status;
			this.#block("exhausted", status ? { code: `http:${status}` } : {});
			return;
		}
		// Malformed streams and other non-network failures are reported at
		// once by upstream and are not retried. The diagnostic is a fixed type:
		// upstream text never reaches it.
		this.#ctx.diagnostic({ type: "graphql-sse.protocol-error" });
		this.#block("terminal", {});
	}

	#block(
		kind: "auth" | "forbidden" | "terminal" | "exhausted",
		detail: { reason?: ConnectionReason; code?: string },
		/** The grant the failing request carried; only a 401 passes it. */
		grant?: Credentials,
	): void {
		if (this.#disposed) return;
		this.#blocked = kind === "forbidden" ? "terminal" : kind;
		this.#permanent = detail.reason === "credentials-audience";
		// Fence and stop the whole client: every stream ends quietly and the
		// connection reports one status instead of per-stream errors.
		this.#gen += 1;
		this.#disposeClient();
		const code = detail.code ? { code: detail.code } : {};
		if (kind === "auth") {
			if (grant) this.#ctx.rejectCredentials(grant);
			this.#setState({
				state: "auth-blocked",
				reason: detail.reason ?? "credentials-rejected",
				...code,
			});
		} else if (kind === "forbidden") {
			this.#setState(FORBIDDEN);
		} else if (kind === "terminal") {
			this.#setState({ state: "failed", reason: "permanent-error", ...code });
		} else {
			this.#setState({
				state: "retry-exhausted",
				reason: "attempts-exhausted",
				...code,
			});
		}
	}

	#restart(reason: CredentialRequest["reason"]): void {
		this.#gen += 1;
		this.#disposeClient();
		this.#blocked = undefined;
		this.#permanent = false;
		this.#nextReason = reason;
		this.#byOperation.clear();
		for (const record of [...this.#records]) {
			if (!record.repeatable && record.everConnected) {
				this.#forget(record);
				record.sink.error({
					code: "interrupted",
					message: "The stream restarted; the operation is not repeatable.",
				});
				continue;
			}
			this.#start(record);
		}
	}

	#disposeClient(): void {
		this.#unaccepted = this.#single ? this.#records.size : 0;
		for (const record of this.#records) record.accepted = false;
		const client = this.#client;
		this.#client = undefined;
		client?.dispose();
		// Upstream aborts only its newest reservation.
		this.#reservations?.closeAll();
		this.#reservations = undefined;
	}

	#setState(status: Omit<ConnectionStatus, "since">): void {
		this.#state = status.state;
		this.#ctx.setStatus(status);
	}
}

/** Inspect only bounded, complete GraphQL error responses; never retain a tee. */
async function rejectionErrors(
	response: Response,
	signal: AbortSignal | undefined,
	maxBytes: number,
	timeoutMs: number,
): Promise<Json[] | undefined> {
	const type = response.headers
		.get("content-type")
		?.split(";")[0]
		?.trim()
		.toLowerCase();
	if (
		!response.body ||
		(type !== "application/json" &&
			type !== "application/graphql-response+json")
	)
		return;
	const reader = response.body.getReader();
	let cancelled = false;
	const cancel = () => {
		cancelled = true;
		void reader.cancel().catch(() => {});
	};
	const timer = setTimeout(cancel, timeoutMs);
	signal?.addEventListener("abort", cancel, { once: true });
	if (signal?.aborted) cancel();
	try {
		const decoder = new TextDecoder();
		let bytes = 0;
		let text = "";
		while (!cancelled) {
			const { done, value } = await reader.read();
			if (cancelled) return;
			if (done) break;
			bytes += value.byteLength;
			if (bytes > maxBytes) {
				cancel();
				return;
			}
			text += decoder.decode(value, { stream: true });
		}
		if (cancelled) return;
		const result = JSON.parse(text + decoder.decode()) as {
			errors?: unknown;
			data?: unknown;
		} | null;
		if (result && result.data === undefined && isFormattedErrors(result.errors))
			return result.errors;
	} catch {
		// Invalid JSON and interrupted bodies are not operation-error evidence.
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", cancel);
		reader.releaseLock();
	}
}

function operationIdOf(body: unknown): string | undefined {
	if (typeof body !== "string") return undefined;
	try {
		const parsed = JSON.parse(body) as {
			extensions?: { operationId?: unknown };
		};
		const id = parsed.extensions?.operationId;
		return typeof id === "string" ? id : undefined;
	} catch {
		return undefined;
	}
}

/** Single-mode DELETE URLs are `url + "?operationId=" + id` (graphql-sse 2.6.1). */
function operationIdOfUrl(input: RequestInfo | URL): string | undefined {
	const url =
		typeof input === "object" && "url" in input ? input.url : String(input);
	return /[?&]operationId=([^&#]*)/.exec(url)?.[1];
}

function randomId(): string {
	return globalThis.crypto.randomUUID();
}
