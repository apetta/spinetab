import { TRPCClientError, type TRPCLink } from "@trpc/client";
import type { AnyTRPCRouter } from "@trpc/server";
import { deserialiseError } from "../../core/errors.ts";
import {
	type ReconcileContext,
	reconcileLatest,
	reconcileOnLoss,
} from "../../core/reconcile.ts";
import type {
	Continuity,
	SerialisedError,
	SpinetabClient,
	Subscription,
	SubscriptionRequest,
	SubscriptionStatus,
} from "../../core/types.ts";
import {
	assertKnownKeys,
	assertPlainObject,
	assertString,
	invalid,
	toJson,
} from "../../protocols/shared/validate.ts";
import {
	splitCursor,
	type TrpcEvent,
	type TrpcSseConnection,
	type TrpcSubscriptionSpec,
	type TrpcWsConnection,
	validateTrpcSseConnection,
	validateTrpcWsConnection,
} from "./spec.ts";

export type {
	TrpcEvent,
	TrpcSseConnection,
	TrpcSubscriptionSpec,
	TrpcWsConnection,
} from "./spec.ts";

/**
 * Page-side tRPC links. Use them as the subscription branch
 * of `splitLink`; queries and mutations stay on your existing links. The
 * worker hosts the real `wsLink`/`httpSubscriptionLink` through
 * `trpcWsAdapter()`/`trpcSseAdapter()` from `spinetab/trpc/runtime`.
 *
 * ```ts
 * splitLink({
 * condition: (op) => op.type === "subscription",
 * true: spinetabWsLink<AppRouter>({ client: spinetab, url: "/trpc-ws" }),
 * false: httpBatchLink({ url: "/trpc" }),
 * });
 * ```
 *
 * Tracked events keep upstream's `{ id, data }` shape. Each consumer's last
 * delivered id is its cursor; it is forwarded as `lastEventId` whenever the
 * subscription is re-registered, and consumers starting from different
 * cursors never share one upstream subscription. tRPC has no continuity
 * channel of its own: read `unknown` and `resumed` through `onContinuity`.
 */
interface CommonLinkOptions {
	client: SpinetabClient;
	url: string;
	/** Auth scope; defaults to the client's scope. */
	scope?: string;
	/** Complete-state feed, or a refresh for this operation that rejects on failure. */
	reconcile?:
		| "latest"
		| ((
				context: ReconcileContext & {
					path: string;
					input: unknown;
					context: Record<string, unknown>;
				},
		  ) => void | Promise<void>);
	/**
	 * Procedures whose handlers replay from `lastEventId`: `true` for every
	 * procedure, or their paths. Only these may report `resumed`, and only
	 * when a cursor reached the procedure.
	 */
	replay?: readonly string[] | true;
	/** Every status change of one subscription, with its controls. */
	onStatus?: (status: SubscriptionStatus, controls: SpinetabControls) => void;
	/**
	 * Each continuity notice away from `continuous` for one subscription
	 * (`unknown`, `resumed`, `gap`), after `onStatus`. Reconcile, then call
	 * `controls.markReconciled()` for manual handling; prefer `reconcile` for
	 * automatic orchestration. A gap ends the subscription only without a
	 * policy or when a payload cannot be delivered.
	 */
	onContinuity?: (continuity: Continuity, controls: SpinetabControls) => void;
}

/**
 * Levers for one subscription, passed last to `onStatus` and `onContinuity`.
 * Both do nothing once the subscription's observable ended.
 */
export interface SpinetabControls {
	/** `Subscription.markReconciled` for this subscription (see its `pending`). */
	markReconciled(options?: { pending?: boolean }): void;
	/** `Subscription.retry` for this subscription only; `client.retry()` is client-wide. */
	retry(): void;
}

export interface SpinetabWsLinkOptions extends CommonLinkOptions {
	connectionParams?: Record<string, string>;
	retryAttempts?: number;
	lazyCloseMs?: number;
	keepAlive?: { intervalMs: number; pongTimeoutMs: number };
	anonymous?: boolean;
	/**
	 * Set `true` when the router uses a data transformer such as superjson; the
	 * worker adapter must be constructed with the same transformer. Only this
	 * marker crosses to the worker, never the transformer itself.
	 */
	transformer?: boolean;
}

export interface SpinetabSseLinkOptions extends CommonLinkOptions {
	/**
	 * Non-secret only: upstream puts connection params into the URL query, so
	 * credentials never go here.
	 */
	connectionParams?: Record<string, string>;
	withCredentials?: boolean;
	retryAttempts?: number;
	anonymous?: boolean;
	/**
	 * Set `true` when the router uses a data transformer such as superjson; the
	 * worker adapter must be constructed with the same transformer. Only this
	 * marker crosses to the worker, never the transformer itself.
	 */
	transformer?: boolean;
}

const COMMON_KEYS = [
	"client",
	"url",
	"scope",
	"replay",
	"onStatus",
	"onContinuity",
	"reconcile",
] as const;

type Levers = Pick<
	CommonLinkOptions,
	"replay" | "onStatus" | "onContinuity" | "reconcile"
>;

export function spinetabWsLink<TRouter extends AnyTRPCRouter>(
	options: SpinetabWsLinkOptions,
): TRPCLink<TRouter> {
	const { client, scope, replay, onStatus, onContinuity, reconcile, ...rest } =
		checkCommon(options, [
			"connectionParams",
			"retryAttempts",
			"lazyCloseMs",
			"keepAlive",
			"anonymous",
			"transformer",
		]);
	const connection = toJson(rest) as TrpcWsConnection;
	validateTrpcWsConnection(connection, { absolute: false }, "spinetabWsLink");
	dropFalseMarker(connection);
	return createLink<TRouter>("trpc-ws", connection, client, scope, {
		replay,
		onStatus,
		onContinuity,
		reconcile,
	});
}

export function spinetabSseLink<TRouter extends AnyTRPCRouter>(
	options: SpinetabSseLinkOptions,
): TRPCLink<TRouter> {
	const { client, scope, replay, onStatus, onContinuity, reconcile, ...rest } =
		checkCommon(options, [
			"connectionParams",
			"withCredentials",
			"retryAttempts",
			"anonymous",
			"transformer",
		]);
	const connection = toJson(rest) as TrpcSseConnection;
	validateTrpcSseConnection(connection, { absolute: false }, "spinetabSseLink");
	dropFalseMarker(connection);
	return createLink<TRouter>("trpc-sse", connection, client, scope, {
		replay,
		onStatus,
		onContinuity,
		reconcile,
	});
}

/**
 * The request carries the marker only as `true`, so `transformer: false` and
 * an omitted option send the same request.
 */
function dropFalseMarker(connection: { transformer?: boolean }): void {
	if (connection.transformer !== true) delete connection.transformer;
}

function checkCommon<T extends CommonLinkOptions>(
	options: T,
	extra: readonly string[],
): T {
	const raw: unknown = options;
	assertPlainObject(raw, "options");
	assertKnownKeys(raw, [...COMMON_KEYS, ...extra], "options");
	const marker = (raw as { transformer?: unknown }).transformer;
	if (marker !== undefined && typeof marker !== "boolean") {
		// Other tRPC links take the transformer itself; this one never does,
		// because functions cannot cross to the worker.
		throw invalid(
			"options.transformer",
			"must be true or false; pass the transformer itself to trpcWsAdapter({ transformer }) or trpcSseAdapter({ transformer }) in your worker file.",
		);
	}
	if (typeof options.client?.subscribe !== "function") {
		throw invalid("options.client", "must be a Spinetab client.");
	}
	assertString(options.scope, "options.scope", { optional: true });
	if (
		options.reconcile !== undefined &&
		options.reconcile !== "latest" &&
		typeof options.reconcile !== "function"
	)
		throw invalid(
			"options.reconcile",
			'must be "latest" or a refresh function.',
		);
	if (
		options.replay !== undefined &&
		options.replay !== true &&
		(!Array.isArray(options.replay) ||
			options.replay.some((path) => typeof path !== "string"))
	) {
		throw invalid(
			"options.replay",
			"must be true or an array of procedure paths.",
		);
	}
	for (const key of ["onStatus", "onContinuity"] as const) {
		if (options[key] !== undefined && typeof options[key] !== "function") {
			throw invalid(`options.${key}`, "must be a function.");
		}
	}
	return options;
}

interface Observer<T, E> {
	next(value: T): void;
	error(error: E): void;
	complete(): void;
}

interface MinimalObservable<T, E> {
	subscribe(observer: Partial<Observer<T, E>>): { unsubscribe(): void };
	pipe(
		...operators: Array<(source: MinimalObservable<T, E>) => unknown>
	): unknown;
}

/** Structural tRPC observable: no runtime import from `@trpc/server`. */
function observable<T, E>(
	producer: (observer: Observer<T, E>) => () => void,
): MinimalObservable<T, E> {
	const self: MinimalObservable<T, E> = {
		subscribe(observer) {
			let closed = false;
			let teardown: (() => void) | undefined;
			const finish = () => {
				const run = teardown;
				teardown = undefined;
				run?.();
			};
			const safe: Observer<T, E> = {
				next(value) {
					if (!closed) observer.next?.(value);
				},
				error(error) {
					if (closed) return;
					closed = true;
					observer.error?.(error);
					finish();
				},
				complete() {
					if (closed) return;
					closed = true;
					observer.complete?.();
					finish();
				},
			};
			teardown = producer(safe);
			if (closed) finish();
			return {
				unsubscribe() {
					closed = true;
					finish();
				},
			};
		},
		pipe(...operators) {
			return operators.reduce<unknown>(
				(source, operator) => operator(source as MinimalObservable<T, E>),
				self,
			);
		},
	};
	return self;
}

type Envelope = {
	result:
		| { type: "started" }
		| { type: "stopped" }
		| { type: "data"; id?: string; data: unknown }
		| {
				type: "state";
				state: "idle" | "connecting" | "pending";
				error: unknown;
		  };
	context?: Record<string, unknown>;
};

function toClientError(error: SerialisedError): TRPCClientError<AnyTRPCRouter> {
	const detail = error.detail as { shape?: unknown } | undefined;
	const shape = detail?.shape as
		| { code?: unknown; message?: unknown }
		| undefined;
	if (
		shape &&
		typeof shape.code === "number" &&
		typeof shape.message === "string"
	) {
		return TRPCClientError.from({ error: shape } as never);
	}
	return TRPCClientError.from(deserialiseError(error));
}

function createLink<TRouter extends AnyTRPCRouter>(
	adapter: "trpc-ws" | "trpc-sse",
	connection: TrpcWsConnection | TrpcSseConnection,
	client: SpinetabClient,
	scope: string | undefined,
	{ replay, onStatus, onContinuity, reconcile }: Levers,
): TRPCLink<TRouter> {
	return (() =>
		({
			op,
		}: {
			op: {
				type: string;
				path: string;
				input: unknown;
				context?: Record<string, unknown>;
				signal?: AbortSignal | null;
			};
		}) =>
			observable<Envelope, TRPCClientError<AnyTRPCRouter>>((observer) => {
				if (op.type !== "subscription") {
					// A misconfigured splitLink: never send queries or mutations
					// through the worker.
					observer.error(
						TRPCClientError.from(
							new Error(
								`Spinetab tRPC links only handle subscriptions; route "${op.path}" (${op.type}) through another link with splitLink.`,
							),
						),
					);
					return () => {};
				}
				const { input, lastEventId: startCursor } = splitCursor(op.input);
				const spec: TrpcSubscriptionSpec = { path: op.path };
				if (input !== undefined) spec.input = toJson(input);
				if (startCursor !== undefined) spec.lastEventId = startCursor;
				if (replay === true || replay?.includes(op.path)) spec.replay = true;
				const request: SubscriptionRequest<
					TrpcEvent,
					typeof connection,
					TrpcSubscriptionSpec
				> = { adapter, connection, subscription: spec };
				if (scope !== undefined) request.scope = scope;
				// The consumer cursor: only ids actually delivered to this
				// consumer advance it.
				let cursor = startCursor;
				let started = false;
				// Assigned when `subscribe` returns; ended once the observable
				// errored, completed or was torn down, which makes controls inert.
				let subscription: Subscription<TrpcEvent> | undefined;
				let ended = false;
				let stopRecovery: (() => void) | undefined;
				let latest: ReturnType<typeof reconcileLatest> | undefined;
				const controls: SpinetabControls = {
					markReconciled: (options) => {
						if (!ended) subscription?.markReconciled(options);
					},
					retry: () => {
						if (!ended) subscription?.retry();
					},
				};
				let notice = "continuous";
				const start = () => {
					if (started) return;
					started = true;
					observer.next({
						result: { type: "started" },
						context: op.context ?? {},
					});
				};
				const relayStatus = (status: SubscriptionStatus) => {
					const { state } = status.connection;
					if (state === "connected") {
						start();
						observer.next({
							result: { type: "state", state: "pending", error: null },
						});
					} else if (state === "inactive") {
						observer.next({
							result: { type: "state", state: "idle", error: null },
						});
					} else if (state === "connecting") {
						observer.next({
							result: { type: "state", state: "connecting", error: null },
						});
					} else if (state === "failed") {
						// Resumable states keep the subscription open.
						ended = true;
						observer.error(
							TRPCClientError.from(
								deserialiseError({
									code: "upstream-error",
									message: `The connection failed (${status.connection.reason ?? "failed"}).`,
								}),
							),
						);
					} else if (state !== "disposed") {
						observer.next({
							result: {
								type: "state",
								state: "connecting",
								error: TRPCClientError.from(
									new Error(
										`Spinetab connection ${state} (${status.connection.reason ?? "unknown"}).`,
									),
								),
							},
						});
					}
					if (
						status.continuity.state === "gap" &&
						!(
							reconcile !== undefined &&
							status.continuity.reason !== "message-too-large" &&
							status.continuity.reason !== "event-not-serialisable"
						)
					) {
						// This consumer's delivery stopped (overflow or stall).
						ended = true;
						observer.error(
							TRPCClientError.from(
								deserialiseError({
									code: "continuity-lost",
									message: `Delivery stopped: ${status.continuity.reason ?? "gap"}.`,
								}),
							),
						);
					}
				};
				subscription = client.subscribe<TrpcEvent>(
					request,
					{
						next(event) {
							start();
							if (typeof event.id === "string" && event.id) cursor = event.id;
							observer.next({
								result:
									event.id === undefined
										? { type: "data", data: event.data }
										: { type: "data", id: event.id, data: event.data },
							});
							latest?.onEvent();
						},
						error(error) {
							ended = true;
							observer.error(toClientError(error));
						},
						complete() {
							ended = true;
							observer.next({ result: { type: "stopped" } });
							observer.complete();
						},
						status(status) {
							// The application's callbacks run first; an exception
							// never skips the relay below and the first one is
							// rethrown afterwards for the client's callback-error path.
							let failure: { error: unknown } | undefined;
							const guard = (run: () => void) => {
								try {
									run();
								} catch (error) {
									failure ??= { error };
								}
							};
							if (onStatus) guard(() => onStatus(status, controls));
							const key = noticeKey(status.continuity);
							const fresh = key !== notice && key !== "continuous";
							notice = key;
							if (fresh && onContinuity) {
								guard(() => onContinuity(status.continuity, controls));
							}
							relayStatus(status);
							if (failure) throw failure.error;
						},
					},
					{
						resume: () =>
							cursor === undefined
								? undefined
								: { subscription: { ...spec, lastEventId: cursor } },
						...(op.signal ? { signal: op.signal } : {}),
					},
				);
				if (!ended) {
					if (reconcile === "latest") {
						latest = reconcileLatest(subscription);
						stopRecovery = latest.stop;
					} else if (reconcile)
						stopRecovery = reconcileOnLoss(subscription, (value) =>
							reconcile({
								...value,
								path: op.path,
								input: op.input,
								context: op.context ?? {},
							}),
						);
				}
				return () => {
					ended = true;
					stopRecovery?.();
					subscription?.unsubscribe();
				};
			})) as unknown as TRPCLink<TRouter>;
}

/**
 * Identifies one continuity notice, as the TanStack
 * helper does. A connection-only change repeats the key; the reconnect
 * outcome after an early notice has a fresh `since` and is reported again; a
 * repeated `gap` with the same reason stays coalesced until reconciled.
 */
function noticeKey(continuity: Continuity): string {
	if (continuity.state === "continuous") return "continuous";
	const kind = `${continuity.state}:${continuity.reason ?? ""}`;
	return continuity.state === "gap" ? kind : `${kind}:${continuity.since}`;
}
