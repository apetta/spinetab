import { SpinetabError } from "../../core/errors.ts";
import { stableStringify } from "../../core/identity.ts";
import {
	type ReconcileContext,
	reconcileLatest,
	reconcileOnLoss,
} from "../../core/reconcile.ts";
import { summariseStatus } from "../../core/summary.ts";
import type {
	ConnectionStatus,
	ConsumerJson,
	ConsumerOptions,
	Continuity,
	EventMeta,
	SerialisedError,
	Source,
	SpinetabClient,
	Subscription,
	SubscriptionObserver,
	SubscriptionRequest,
	SubscriptionStatus,
} from "../../core/types.ts";

/**
 * The framework-independent core of the four bindings: one
 * option vocabulary, the reconcile policy, error reporting and the per-mount
 * value fold. Nothing here holds state beyond one call; each binding owns its
 * lifecycle and its per-mount value.
 */

/** A disabled source: nothing is subscribed. */
export type Disabled = null | undefined | false;

/**
 * `"latest"` for a full-state feed (the next event is the reconciled value),
 * or the application's refresh for a delta feed, run by `reconcileOnLoss`.
 */
export type BindingReconcile =
	| "latest"
	| ((context: ReconcileContext) => void | Promise<void>);

export interface SubscriptionOptions {
	/** Adapter-defined per-consumer options, for example `...pollEvery(30_000)`; a change updates the consumer without resubscribing. */
	consumer?: ConsumerJson;
	resume?: ConsumerOptions["resume"];
	/** Opt-in reconciliation; without it a loss stays sticky and is reported. */
	reconcile?: BindingReconcile;
	/**
	 * Throw terminal errors to the framework's error boundary, from a browser
	 * effect after they arrived and only for the subscription that raised
	 * them; never during SSR, never for resumable states or continuity loss.
	 */
	throwOnError?: boolean;
}

export interface LiveOptions<E, T = E> extends SubscriptionOptions {
	/** The value before the first event, and after an identity or principal change. */
	initial?: T;
	/** Projection of each event to the value. Default: the event. */
	map?(event: E, meta: EventMeta): T;
	/** Accumulation; returning `undefined` leaves the value unchanged. */
	reduce?(current: T | undefined, event: E, meta: EventMeta): T | undefined;
}

export interface LiveSnapshot<T> {
	/** Held for this mount only; read it with `needsReconcile`. */
	data: T | undefined;
	/** A terminal error, or `continuity-lost` while a loss without a policy is unreconciled. */
	error: SpinetabError | undefined;
	status: SubscriptionStatus;
	/** `summariseStatus(status).needsReconcile`: `data` may be incomplete. */
	needsReconcile: boolean;
}

export function isDisabled<E>(
	source: Source<E> | Disabled,
): source is Disabled {
	return source === null || source === undefined || source === false;
}

/** Canonical identity of a normalised request. */
export function requestKey(request: SubscriptionRequest<unknown>): string {
	return stableStringify({
		adapter: request.adapter,
		connection: request.connection,
		subscription: request.subscription,
		scope: request.scope,
		repeatable: request.repeatable,
		share: request.share,
		stateful: request.stateful,
	});
}

/** Canonical form of the per-consumer options; `null` when there are none. */
export function consumerKey(
	options: SubscriptionOptions | undefined,
): string | null {
	return options?.consumer === undefined
		? null
		: stableStringify(stripUndefined(options.consumer));
}

export function assertClient(client: SpinetabClient, name: string): void {
	if (
		!client ||
		typeof client.subscribe !== "function" ||
		typeof client.status?.get !== "function"
	) {
		throw new SpinetabError(
			"unsupported-option",
			`${name} needs the application's Spinetab client; bindings never create one.`,
			{ detail: { path: "client", reason: "no-client" } },
		);
	}
}

export function assertOptions(
	options: LiveOptions<unknown, unknown> | undefined,
	name: string,
): void {
	if (!options) return;
	const { reconcile } = options;
	if (
		reconcile !== undefined &&
		reconcile !== "latest" &&
		typeof reconcile !== "function"
	) {
		throw new SpinetabError(
			"unsupported-option",
			`${name} reconcile must be "latest" or a refresh function.`,
			{ detail: { path: "options.reconcile" } },
		);
	}
	if (options.map && options.reduce) {
		throw new SpinetabError(
			"unsupported-option",
			`${name} takes map or reduce, not both.`,
			{ detail: { path: "options.reduce" } },
		);
	}
}

export function subscribeOptions(
	options: SubscriptionOptions | undefined,
	resume: ConsumerOptions["resume"] | undefined,
): ConsumerOptions {
	return {
		...(options?.consumer === undefined ? {} : { consumer: options.consumer }),
		...(resume === undefined ? {} : { resume }),
	};
}

/** The reconcile policy attached with a handle: `"latest"` or a refresh. */
export type PolicyKind = "latest" | "refresh";

export interface Attached<E> {
	handle: Subscription<E>;
	/** Fixed for the handle's identity; `undefined` without a policy. */
	policy: PolicyKind | undefined;
	/** Idempotent: stops the reconcile policy and unsubscribes. */
	release(): void;
}

export interface AttachExtras {
	/**
	 * Passed to core in place of `options.resume`, for example a wrapper that
	 * runs the newest closure. Give it only when the application gave a
	 * resume function: core keeps the last event of every consumer that has
	 * one.
	 */
	resume?: ConsumerOptions["resume"];
	/**
	 * Value hooks: the value reports stopped delivery itself (`error`
	 * `continuity-lost`, `needsReconcile`), so the wrapper always has a status
	 * hook and core does not report the loss again. Without it the
	 * wrapper has a status hook only while the application's observer has one.
	 */
	handlesStatus?: boolean;
	/**
	 * Value hooks: runs once per principal change (`setScope` makes
	 * the handle's continuity a new `unknown/scope-changed`), so the value
	 * restarts at `initial`. It runs from a listener on the handle's status
	 * store registered before any of the binding's, and core updates that
	 * store before it calls the status hook, so the value is reset before the
	 * binding publishes the new status.
	 */
	onScopeChange?(): void;
}

/**
 * Subscribe once for a binding. `observer()` returns the current observer at
 * delivery time; `onError` receives each terminal error, and the binding
 * decides whether to hold it, throw it to a boundary or forward it
 * (`forwardError`). Nothing is delivered after `release()`, even by a leaky
 * runtime.
 */
export function attach<E>(
	client: SpinetabClient,
	request: SubscriptionRequest<E>,
	options: SubscriptionOptions | undefined,
	observer: () => SubscriptionObserver<E> | undefined,
	onError: (record: SerialisedError) => void,
	extras: AttachExtras = {},
): Attached<E> {
	let active = true;
	let latest: { onEvent(): void; stop(): void } | undefined;
	const status = (value: SubscriptionStatus) => {
		if (active) observer()?.status?.(value);
	};
	const handle = client.subscribe<E>(
		request,
		{
			next(event, meta) {
				if (!active) return;
				observer()?.next(event, meta);
				latest?.onEvent();
			},
			error(record) {
				if (active) onError(record);
			},
			complete() {
				if (active) observer()?.complete?.();
			},
			// Core reports stopped delivery when the observer has no status
			// hook, so the wrapper has one only while the application's has,
			// or always for a value hook, which reports the loss itself.
			get status() {
				return extras.handlesStatus || typeof observer()?.status === "function"
					? status
					: undefined;
			},
		},
		subscribeOptions(options, extras.resume ?? options?.resume),
	);
	// Registered first on the handle's status store, so it runs before the
	// binding's own listener and before core calls the status hook: Solid and
	// Svelte publish at once, and no view pairs the previous principal's
	// value with the new principal's status.
	const { onScopeChange } = extras;
	let seen = handle.status.get().continuity;
	const offScope =
		onScopeChange &&
		handle.status.subscribe(({ continuity }) => {
			// A new continuity object, not a later status that carries it along.
			if (!active || continuity === seen) return;
			seen = continuity;
			if (
				continuity.state === "unknown" &&
				continuity.reason === "scope-changed"
			) {
				onScopeChange();
			}
		});
	let stop: (() => void) | undefined;
	let policy: PolicyKind | undefined;
	const reconcile = options?.reconcile;
	if (reconcile === "latest") {
		latest = reconcileLatest(handle);
		stop = latest.stop;
		policy = "latest";
	} else if (typeof reconcile === "function") {
		stop = reconcileOnLoss(handle, reconcile);
		policy = "refresh";
	}
	return {
		handle,
		policy,
		release() {
			if (!active) return;
			active = false;
			offScope?.();
			stop?.();
			handle.unsubscribe();
		},
	};
}

/**
 * A terminal error goes to the application's `error` hook when it gave
 * one; otherwise the very object core passed in is rethrown, so core's
 * callback guard reports it with its code and one fixed sentence, never its
 * message or detail. Returns normally only when a hook took it.
 */
export function forwardError<E>(
	observer: SubscriptionObserver<E> | undefined,
	record: SerialisedError,
): void {
	if (typeof observer?.error !== "function") throw record;
	observer.error(record);
}

/** The next per-mount value after one event. */
export function fold<E, T>(
	options: LiveOptions<E, T> | undefined,
	current: T | undefined,
	event: E,
	meta: EventMeta,
): T | undefined {
	if (options?.reduce) {
		const next = options.reduce(current, event, meta);
		return next === undefined ? current : next;
	}
	return options?.map ? options.map(event, meta) : (event as unknown as T);
}

/**
 * Whether a policy handles a loss: the kind attached with the handle,
 * fixed for its identity, so adding or removing `reconcile` on a live
 * identity applies at the next one; the current options only before a handle
 * is attached. Pass the result to `lossError`.
 */
export function hasPolicy(
	attached: Pick<Attached<unknown>, "policy"> | null | undefined,
	options: SubscriptionOptions | undefined,
): boolean {
	return attached
		? attached.policy !== undefined
		: options?.reconcile !== undefined;
}

/**
 * An unreconciled loss without a policy is an error of its own. Callers
 * memoise by the continuity object, which the status store keeps stable.
 */
export function lossError(
	continuity: Continuity,
	hasPolicy: boolean,
): SpinetabError | undefined {
	if (hasPolicy) return undefined;
	if (continuity.state !== "gap" && continuity.state !== "unknown") {
		return undefined;
	}
	return new SpinetabError(
		"continuity-lost",
		`Continuity was lost (${continuity.state}${continuity.reason ? `, ${continuity.reason}` : ""}); set reconcile, or reconcile the data and call markReconciled().`,
		{
			detail: {
				state: continuity.state,
				...(continuity.reason ? { reason: continuity.reason } : {}),
			},
		},
	);
}

/** A failed connection keeps intent for an explicit retry, but is not loading. */
export function connectionError(
	connection: ConnectionStatus,
): SpinetabError | undefined {
	if (connection.state !== "failed") return undefined;
	return new SpinetabError(
		"upstream-error",
		"The subscription connection failed; inspect status.connection and retry explicitly.",
		{
			detail: {
				state: "failed",
				...(connection.reason === undefined
					? {}
					: { reason: connection.reason }),
				...(connection.code === undefined ? {} : { code: connection.code }),
			},
		},
	);
}

/** `{ pending: true }` or nothing: a click event is never forwarded to core. */
export function pendingOnly(
	value: { pending?: boolean } | undefined,
): { pending: true } | undefined {
	return value?.pending === true ? { pending: true } : undefined;
}

export function needsReconcile(status: SubscriptionStatus): boolean {
	return summariseStatus(status).needsReconcile;
}

function stripUndefined(value: ConsumerJson): ConsumerJson {
	const result: ConsumerJson = {};
	for (const [key, item] of Object.entries(value)) {
		if (item !== undefined) result[key] = item;
	}
	return result;
}
