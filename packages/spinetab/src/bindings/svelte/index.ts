import type { Readable } from "svelte/store";
import { deserialiseError, type SpinetabError } from "../../core/errors.ts";
import { toObserver, toRequest } from "../../core/source.ts";
import {
	SERVER_SUBSCRIPTION_STATUS as INACTIVE_STATUS,
	SERVER_STATUS,
} from "../../core/status.ts";
import type {
	ClientStatus,
	ConnectionStatus,
	ConsumerJson,
	Continuity,
	Observer,
	Source,
	SpinetabClient,
	Subscription,
	SubscriptionObserver,
	SubscriptionRequest,
	SubscriptionStatus,
} from "../../core/types.ts";
import {
	type AttachExtras,
	type Attached,
	assertClient,
	assertOptions,
	attach,
	connectionError,
	type Disabled,
	fold,
	forwardError,
	isDisabled,
	type LiveOptions,
	type LiveSnapshot,
	lossError,
	needsReconcile,
	pendingOnly,
	type SubscriptionOptions,
} from "../shared/live.ts";

export type {
	BindingReconcile,
	LiveOptions,
	LiveSnapshot,
	SubscriptionOptions,
} from "../shared/live.ts";

/**
 * Referentially constant snapshots shared with the core client:
 * `SERVER_STATUS` for SSR and hydration, `INACTIVE_STATUS` for a
 * disabled (`null` or `false`) source on the server and before start.
 */
export { INACTIVE_STATUS, SERVER_STATUS };

/**
 * Svelte bindings as plain store-contract objects (Svelte 5 `$store`, no
 * runes). The first store subscriber starts the Spinetab subscription
 * and the last one releases it; creating a store does nothing beyond
 * normalising its source. A store is tied to one source and one set of
 * options, and stores are never compared: every re-run of the `$derived`
 * that builds a store creates a new store, which starts a new subscription
 * and a fresh value even when the source's identity is unchanged, and the
 * old store is released through its last unsubscribe. So derive the
 * identity's primitives first and read only those where the store is built:
 *
 * ```svelte
 * const room = $derived(params.room);
 * const live = $derived(liveStore(client, feed(room)));
 * ```
 *
 * Reading `params.room` inside the store's `$derived` would re-run it, and
 * restart the value, whenever any field of an inline `params={{ … }}` prop
 * changes. Per-consumer options change with `update(consumer)`, without
 * resubscribing. Outside a browser the stores yield the inactive/server
 * status and start nothing.
 *
 * `throwOnError`: after a terminal error the store's value throws that error
 * when a field is read, so a template or `$effect` reading it hands it to the
 * nearest `<svelte:boundary>`.
 */

interface StoreControls<E> {
	/** The live handle while the store has subscribers. */
	readonly subscription: Subscription<E> | null;
	markReconciled(options?: { pending?: boolean }): void;
	/** Per-consumer option change without resubscribing. */
	update(consumer: ConsumerJson): void;
	/** Retries this subscription's connection only (`subscription.retry()`). */
	retry(): void;
}

export interface SubscriptionStore<E>
	extends Readable<SubscriptionStatus>,
		StoreControls<E> {}

export interface LiveStore<E, T = E>
	extends Readable<LiveSnapshot<T>>,
		StoreControls<E> {}

/**
 * `source` is a request or a feed (`null` or `false` disables); `observer` is
 * an observer object or a function that receives each event. Without an
 * `error` hook (and without `throwOnError`) a terminal error is rethrown into
 * the client's callback guard.
 */
export function subscriptionStore<E>(
	client: SpinetabClient,
	source: Source<E> | Disabled,
	observer: Observer<NoInfer<E>>,
	options?: SubscriptionOptions,
): SubscriptionStore<E> {
	assertClient(client, "subscriptionStore");
	assertOptions(options, "subscriptionStore");
	const request = isDisabled(source) ? null : toRequest(source, "source");
	const target = toObserver(observer, "observer");
	return storeCore(client, request, target, options, STATUS_KEYS, () => ({
		view: (status) => status,
	}))[0];
}

/**
 * The value of a subscription for each store subscriber: every
 * `subscribe` call holds its own `data`, which starts at `initial` and
 * follows `map` or `reduce` from the events that arrive after it joined; it
 * is dropped when that subscriber leaves. Subscribers share the subscription
 * and its status, never a value, so a later subscriber never sees an earlier
 * one's data. A principal change (`setScope`) restarts every subscriber's
 * value at `initial`. An unreconciled loss without `reconcile` is `error`
 * `continuity-lost`.
 */
export function liveStore<E, T = E>(
	client: SpinetabClient,
	source: Source<E> | Disabled,
	options?: LiveOptions<NoInfer<E>, T>,
): LiveStore<E, T> {
	assertClient(client, "liveStore");
	assertOptions(options as LiveOptions<unknown, unknown>, "liveStore");
	const request = isDisabled(source) ? null : toRequest(source, "source");
	const policy = options?.reconcile !== undefined;
	// One fold per store subscriber; the terminal error is the subscription's.
	const folds = new Set<{ data: T | undefined }>();
	let error: SpinetabError | undefined;
	let lostFor: Continuity | undefined;
	let lost: SpinetabError | undefined;
	let connection: ConnectionStatus | undefined;
	let failedConnection: SpinetabError | undefined;
	let refresh = () => {};
	const target: SubscriptionObserver<E> = {
		next(event, meta) {
			for (const slot of folds) {
				slot.data = fold(options, slot.data, event, meta);
			}
			refresh();
		},
		error(record) {
			error = deserialiseError(record);
			refresh();
		},
	};
	const [store, notify] = storeCore<E, LiveSnapshot<T>>(
		client,
		request,
		target,
		options,
		LIVE_KEYS,
		() => {
			const slot: { data: T | undefined } = { data: options?.initial };
			folds.add(slot);
			let last: LiveSnapshot<T> | undefined;
			return {
				view(status) {
					if (status.connection !== connection) {
						connection = status.connection;
						failedConnection = connectionError(connection);
					}
					if (status.continuity !== lostFor) {
						lostFor = status.continuity;
						lost = lossError(status.continuity, policy);
					}
					const next: LiveSnapshot<T> = {
						data: slot.data,
						error: error ?? failedConnection ?? lost,
						status,
						needsReconcile: needsReconcile(status),
					};
					if (
						last &&
						last.data === next.data &&
						last.error === next.error &&
						last.status === next.status
					) {
						return last;
					}
					last = next;
					return next;
				},
				release: () => folds.delete(slot),
			};
		},
		() => {
			// Nothing survives the last unsubscribe.
			error = undefined;
			connection = undefined;
			failedConnection = undefined;
		},
		{
			// The value reports stopped delivery itself, and every
			// subscriber's value restarts at `initial` on a principal change.
			handlesStatus: true,
			onScopeChange() {
				for (const slot of folds) slot.data = options?.initial;
				error = undefined;
				refresh();
			},
		},
	);
	refresh = notify;
	return store;
}

export function statusStore(client: SpinetabClient): Readable<ClientStatus> {
	assertClient(client, "statusStore");
	return {
		subscribe(run) {
			if (!isBrowser()) {
				run(SERVER_STATUS);
				return () => {};
			}
			// Svelte reads stores synchronously while claiming the server DOM.
			// Publish the same snapshot first, then observe live status afterwards.
			run(SERVER_STATUS);
			let subscribed = true;
			let off: (() => void) | undefined;
			queueMicrotask(() => {
				if (!subscribed) return;
				off = client.status.subscribe(run);
				run(client.status.get());
			});
			return () => {
				subscribed = false;
				off?.();
			};
		},
	};
}

export interface BoundSvelte {
	subscriptionStore<E>(
		source: Source<E> | Disabled,
		observer: Observer<NoInfer<E>>,
		options?: SubscriptionOptions,
	): SubscriptionStore<E>;
	statusStore(): Readable<ClientStatus>;
	liveStore<E, T = E>(
		source: Source<E> | Disabled,
		options?: LiveOptions<NoInfer<E>, T>,
	): LiveStore<E, T>;
}

/**
 * The store factories with the application's client applied: no context and
 * no module-level state. Call it in a client module (`live.ts`); it starts
 * nothing.
 */
export function bindClient(client: SpinetabClient): BoundSvelte {
	assertClient(client, "bindClient");
	return {
		subscriptionStore: (source, observer, options) =>
			subscriptionStore(client, source, observer, options),
		statusStore: () => statusStore(client),
		liveStore: (source, options) => liveStore(client, source, options),
	};
}

const STATUS_KEYS = ["active", "connection", "continuity"] as const;
const LIVE_KEYS = ["data", "error", "status", "needsReconcile"] as const;

/** One store subscriber's view of the shared subscription. */
interface View<V> {
	/** Maps the status to the published value; returns the previous object when nothing changed. */
	view(status: SubscriptionStatus): V;
	/** Runs when this subscriber leaves. */
	release?(): void;
}

/**
 * The lifecycle shared by both stores: the first subscriber attaches, the
 * last releases. `createView` runs once per subscriber, so a value derived
 * from events is held per subscriber; `reset` runs when the last one leaves;
 * `extras` go to each `attach()`.
 */
function storeCore<E, V>(
	client: SpinetabClient,
	request: SubscriptionRequest<E> | null,
	target: SubscriptionObserver<E>,
	options: SubscriptionOptions | undefined,
	keys: readonly string[],
	createView: () => View<V>,
	reset?: () => void,
	extras?: AttachExtras,
): [Readable<V> & StoreControls<E>, () => void] {
	const listeners = new Set<{
		run: (value: V) => void;
		view: View<V>;
		value: V;
	}>();
	let live: { attached: Attached<E>; off(): void } | undefined;
	let generation = 0;
	// Set by a terminal error under `throwOnError`; published until the last
	// subscriber leaves.
	let failed: V | undefined;
	let failedConnection: { connection: ConnectionStatus; value: V } | undefined;
	const current = (view: View<V>) => {
		if (failed) return failed;
		const status = live ? live.attached.handle.status.get() : INACTIVE_STATUS;
		const connectionFailure = options?.throwOnError
			? connectionError(status.connection)
			: undefined;
		if (connectionFailure) {
			if (failedConnection?.connection !== status.connection) {
				failedConnection = {
					connection: status.connection,
					value: throwing<V>(keys, connectionFailure),
				};
			}
			return failedConnection.value;
		}
		failedConnection = undefined;
		return view.view(status);
	};
	const refresh = () => {
		for (const listener of [...listeners]) {
			if (!listeners.has(listener)) continue;
			const next = current(listener.view);
			if (next === listener.value) continue;
			listener.value = next;
			listener.run(next);
		}
	};
	const start = () => {
		if (!request || !isBrowser()) return;
		const attached = attach(
			client,
			request,
			options,
			() => target,
			(record) => {
				if (options?.throwOnError) {
					target.error?.(record);
					failed = throwing<V>(keys, deserialiseError(record));
					refresh();
					return;
				}
				forwardError(target, record);
			},
			extras,
		);
		const off = attached.handle.status.subscribe(() => {
			if (live?.attached === attached) refresh();
		});
		live = { attached, off };
	};
	const stop = () => {
		generation += 1;
		live?.off();
		live?.attached.release();
		live = undefined;
		failed = undefined;
		failedConnection = undefined;
		reset?.();
	};
	const store: Readable<V> & StoreControls<E> = {
		subscribe(run) {
			const view = createView();
			if (listeners.size === 0 && request && isBrowser()) {
				const pending = generation;
				queueMicrotask(() => {
					if (pending !== generation || listeners.size === 0) return;
					start();
					refresh();
				});
			}
			const listener = { run, view, value: current(view) };
			listeners.add(listener);
			run(listener.value);
			let subscribed = true;
			return () => {
				if (!subscribed) return;
				subscribed = false;
				listeners.delete(listener);
				view.release?.();
				if (listeners.size === 0) stop();
			};
		},
		get subscription() {
			return live?.attached.handle ?? null;
		},
		markReconciled: (markOptions) =>
			live?.attached.handle.markReconciled(pendingOnly(markOptions)),
		update: (consumer) => live?.attached.handle.update(consumer),
		retry: () => live?.attached.handle.retry(),
	};
	return [store, refresh];
}

/** A value whose every field throws `error` when read (see `throwOnError`). */
function throwing<V>(keys: readonly string[], error: SpinetabError): V {
	const value = {};
	for (const key of keys) {
		Object.defineProperty(value, key, {
			enumerable: true,
			get() {
				throw error;
			},
		});
	}
	return value as V;
}

function isBrowser(): boolean {
	return typeof window !== "undefined" && typeof document !== "undefined";
}
