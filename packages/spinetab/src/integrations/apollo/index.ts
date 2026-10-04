import { CombinedGraphQLErrors } from "@apollo/client/errors";
import { ApolloLink } from "@apollo/client/link";
import { print } from "@apollo/client/utilities";
import { Observable } from "rxjs";
import { deserialiseError, SpinetabError } from "../../core/errors.ts";
import {
	type ReconcileContext,
	reconcileLatest,
	reconcileOnLoss,
} from "../../core/reconcile.ts";
import type {
	Continuity,
	Json,
	SerialisedError,
	SpinetabClient,
	Subscription,
	SubscriptionStatus,
} from "../../core/types.ts";
import type {
	GraphqlEndpoint,
	GraphqlFormattedError,
	GraphqlResult,
} from "../../protocols/graphql/types.ts";

/**
 * Terminating Apollo Client 4 link for GraphQL subscriptions over Spinetab. It delegates to a `graphqlWs()` or `graphqlSse()`
 * endpoint; the protocol client runs in the worker, never in the page.
 * `spinetabSplit` routes subscriptions to it and everything else to your
 * HTTP link:
 *
 * ```ts
 * const link = spinetabSplit(spinetab, graphqlWs("/graphql"), http);
 * ```
 *
 * Results pass through unchanged, so Apollo's `errorPolicy` handles partial
 * data. The observable stays open through `reconnecting`, `retry-exhausted`
 * and `auth-blocked` (observe them with `onStatus` or the Spinetab status
 * API). With `reconcile`, recoverable gaps keep the operation open while
 * the policy restores application state. Without it, a gap ends the operation;
 * failed connections, operation errors and invalid payloads remain terminal. Unknown
 * continuity after a reconnect is reported through `onContinuity`, never
 * injected into results. Apollo deduplicates identical subscriptions by query
 * and variables but not by context or extensions: use
 * `queryDeduplication: false` for subscriptions that differ only there.
 */
export interface SpinetabLinkOptions {
	/** Auth scope; defaults to the client's scope. */
	scope?: string;
	/** Complete-state feed, or an application refresh that rejects on failure. */
	reconcile?:
		| "latest"
		| ((
				context: ReconcileContext & { operation: ApolloLink.Operation },
		  ) => void | Promise<void>);
	/** Every status change of one operation's subscription. */
	onStatus?: (
		status: SubscriptionStatus,
		operation: ApolloLink.Operation,
		controls: SpinetabControls,
	) => void;
	/**
	 * Each notice away from `continuous`, after `onStatus`. Prefer `reconcile`
	 * for automatic refresh orchestration. This callback is an observational or
	 * manual escape hatch: its returned promise is not awaited. A repeated gap
	 * with the same reason is reported once until reconciled.
	 */
	onContinuity?: (
		continuity: Continuity,
		operation: ApolloLink.Operation,
		controls: SpinetabControls,
	) => void;
}

/**
 * Levers for one operation's subscription, passed last to `onStatus` and
 * `onContinuity`. Both do nothing once the operation's observable ended.
 */
export interface SpinetabControls {
	/** `Subscription.markReconciled` for this operation (see its `pending`). */
	markReconciled(options?: { pending?: boolean }): void;
	/** `Subscription.retry` for this operation only; `client.retry()` is client-wide. */
	retry(): void;
}

declare module "@apollo/client" {
	interface DefaultContext {
		/**
		 * Response-affecting, credential-free context for Spinetab. Crosses to
		 * the worker as plain data and separates subscription identities.
		 */
		spinetab?: Json;
	}
}

export class SpinetabLink extends ApolloLink {
	readonly #client: SpinetabClient;
	readonly #endpoint: GraphqlEndpoint;
	readonly #options: SpinetabLinkOptions;

	constructor(
		client: SpinetabClient,
		endpoint: GraphqlEndpoint,
		options: SpinetabLinkOptions = {},
	) {
		super();
		if (typeof client?.subscribe !== "function") {
			throw new SpinetabError(
				"unsupported-option",
				"SpinetabLink: client must be a Spinetab client.",
				{
					detail: { path: "client" },
				},
			);
		}
		if (typeof endpoint?.subscription !== "function") {
			throw new SpinetabError(
				"unsupported-option",
				"SpinetabLink: endpoint must come from graphqlWs() or graphqlSse().",
				{ detail: { path: "endpoint" } },
			);
		}
		this.#client = client;
		this.#endpoint = endpoint;
		this.#options = options;
		if (
			options.reconcile !== undefined &&
			options.reconcile !== "latest" &&
			typeof options.reconcile !== "function"
		) {
			throw new SpinetabError(
				"unsupported-option",
				'SpinetabLink reconcile must be "latest" or a refresh function.',
				{ detail: { path: "options.reconcile" } },
			);
		}
	}

	override request(
		operation: ApolloLink.Operation,
	): Observable<ApolloLink.Result> {
		return new Observable<ApolloLink.Result>((observer) => {
			if (operation.operationType !== "subscription") {
				// A misconfigured split: queries and mutations never reach the
				// worker and the cache is untouched.
				observer.error(
					new SpinetabError(
						"unsupported-option",
						`SpinetabLink handles subscriptions only; route ${operation.operationType} operations to another link with spinetabSplit() or ApolloLink.split.`,
						{ detail: { path: "operation.operationType" } },
					),
				);
				return;
			}
			let request: ReturnType<GraphqlEndpoint["subscription"]>;
			try {
				const context = operation.getContext().spinetab;
				request = this.#endpoint.subscription(
					{
						query: print(operation.query),
						...(operation.operationName
							? { operationName: operation.operationName }
							: {}),
						variables: operation.variables,
						...(Object.keys(operation.extensions).length > 0
							? { extensions: operation.extensions as Record<string, Json> }
							: {}),
						...(context === undefined ? {} : { context }),
					},
					this.#options.scope === undefined
						? undefined
						: { scope: this.#options.scope },
				);
			} catch (error) {
				observer.error(error);
				return;
			}
			let closed = false;
			let released = false;
			let stopRecovery: (() => void) | undefined;
			let latest: ReturnType<typeof reconcileLatest> | undefined;
			// Assigned when `subscribe` returns; a client may dispatch before then.
			let subscription: Subscription<GraphqlResult> | undefined;
			// Inert once the observable ended (closed) or the consumer is gone.
			const controls: SpinetabControls = {
				markReconciled: (options) => {
					if (!closed && !released) subscription?.markReconciled(options);
				},
				retry: () => {
					if (!closed && !released) subscription?.retry();
				},
			};
			let notice = "continuous";
			// Idempotent and re-entrant: onStatus, the observer's error handler
			// or a status arriving mid-release may all reach it.
			const release = () => {
				if (released || !subscription) return;
				released = true;
				stopRecovery?.();
				subscription.unsubscribe();
			};
			subscription = this.#client.subscribe<GraphqlResult>(request, {
				next: (result) => {
					if (!closed) {
						observer.next(result as ApolloLink.Result);
						latest?.onEvent();
					}
				},
				error: (error) => {
					if (closed) return;
					closed = true;
					observer.error(toApolloError(error));
				},
				complete: () => {
					if (closed) return;
					closed = true;
					observer.complete();
				},
				status: (status) => {
					// The application sees the status first, but its exception must
					// not skip the terminal handling below. The
					// first one is rethrown afterwards, once, for the client's
					// callback-error path.
					let failure: { error: unknown } | undefined;
					const guard = (run: () => void) => {
						try {
							run();
						} catch (error) {
							failure ??= { error };
						}
					};
					const { onStatus, onContinuity } = this.#options;
					if (onStatus) guard(() => onStatus(status, operation, controls));
					const key = noticeKey(status.continuity);
					const fresh = key !== notice && key !== "continuous";
					notice = key;
					if (fresh && onContinuity) {
						guard(() => onContinuity(status.continuity, operation, controls));
					}
					const terminal = closed
						? undefined
						: terminalError(status, this.#options.reconcile !== undefined);
					if (terminal) {
						closed = true;
						try {
							observer.error(terminal);
						} finally {
							release();
						}
					}
					if (failure) throw failure.error;
				},
			});
			if (!closed) {
				const policy = this.#options.reconcile;
				if (policy === "latest") {
					latest = reconcileLatest(subscription);
					stopRecovery = latest.stop;
				} else if (policy)
					stopRecovery = reconcileOnLoss(subscription, (context) =>
						policy({ ...context, operation }),
					);
			}
			// A terminal status or error dispatched before the handle existed.
			if (closed) release();
			return () => {
				closed = true;
				release();
			};
		});
	}
}

/**
 * Build the usual Apollo split without `OperationTypeNode`: subscriptions go
 * to a terminating `SpinetabLink`, every other operation to `httpLink` (your
 * own `HttpLink` or any terminating link; this entry never imports one).
 */
export function spinetabSplit(
	spinetab: SpinetabClient,
	endpoint: GraphqlEndpoint,
	httpLink: ApolloLink,
	options?: SpinetabLinkOptions,
): ApolloLink {
	return ApolloLink.split(
		(operation) => operation.operationType === "subscription",
		new SpinetabLink(spinetab, endpoint, options),
		httpLink,
	);
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

/**
 * The coded error that ends the observable for a terminal status: a `failed`
 * connection, invalid payload, or continuity gap without a recovery policy.
 */
function terminalError(
	status: SubscriptionStatus,
	recover = false,
): SpinetabError | undefined {
	if (status.connection.state === "failed") {
		return new SpinetabError(
			"upstream-error",
			`The subscription connection failed (${status.connection.reason ?? "failed"}).`,
			{
				detail: {
					state: "failed",
					...(status.connection.code === undefined
						? {}
						: { code: status.connection.code }),
				},
			},
		);
	}
	if (status.continuity.state === "gap") {
		if (
			recover &&
			status.continuity.reason !== "message-too-large" &&
			status.continuity.reason !== "event-not-serialisable"
		)
			return undefined;
		return new SpinetabError(
			"continuity-lost",
			`Subscription delivery stopped (${status.continuity.reason ?? "gap"}); restart to resubscribe.`,
			{ detail: { reason: status.continuity.reason ?? "gap" } },
		);
	}
	return undefined;
}

/** Mirror GraphQLWsLink: GraphQL error arrays become `CombinedGraphQLErrors`. */
function toApolloError(error: SerialisedError): Error {
	const errors = (error.detail as { errors?: unknown } | undefined)?.errors;
	if (
		error.code === "upstream-error" &&
		Array.isArray(errors) &&
		errors.length > 0
	) {
		return new CombinedGraphQLErrors({
			errors: errors as GraphqlFormattedError[],
		});
	}
	return deserialiseError(error);
}
