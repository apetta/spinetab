"use client";

import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { deserialiseError, type SpinetabError } from "../../core/errors.ts";
import type { ReconcileContext } from "../../core/reconcile.ts";
import { toObserver, toRequest } from "../../core/source.ts";
import {
	SERVER_SUBSCRIPTION_STATUS as INACTIVE_STATUS,
	SERVER_STATUS,
} from "../../core/status.ts";
import type {
	ClientStatus,
	Observer,
	Source,
	SpinetabClient,
	Subscription,
	SubscriptionObserver,
	SubscriptionRequest,
	SubscriptionStatus,
} from "../../core/types.ts";
import {
	type Attached,
	assertClient,
	assertOptions,
	attach,
	connectionError,
	consumerKey,
	type Disabled,
	fold,
	forwardError,
	hasPolicy,
	isDisabled,
	type LiveOptions,
	type LiveSnapshot,
	lossError,
	needsReconcile,
	pendingOnly,
	requestKey,
	type SubscriptionOptions,
} from "../shared/live.ts";

export type {
	BindingReconcile,
	LiveOptions,
	SubscriptionOptions,
} from "../shared/live.ts";

/**
 * Referentially constant snapshots shared with the core client:
 * `SERVER_STATUS` for SSR and hydration, `INACTIVE_STATUS` for a
 * disabled (`null` or `false`) source on the server and before start.
 */
export { INACTIVE_STATUS, SERVER_STATUS };

/**
 * React bindings (React 19). Subscriptions are created in effects only, keyed
 * by the client and the canonical identity of the normalised request, so an
 * inline feed rebuilt on every render never resubscribes; callbacks and
 * options are read through a latest ref, so new closures never resubscribe
 * either, and a structurally equal `consumer` never updates. Status comes
 * from `useSyncExternalStore` with a constant server snapshot. `useLive`
 * holds the value of the committed subscription only, never across
 * subscriptions or mounts.
 */

export type UseSubscriptionOptions = SubscriptionOptions;

export interface UseSubscriptionResult<E> {
	status: SubscriptionStatus;
	/** The live handle, or `null` while disabled, on the server or before the effect ran. */
	subscription: Subscription<E> | null;
	/** Stable: `markReconciled(options?)` on the committed handle; a no-op after unmount. */
	markReconciled(options?: { pending?: boolean }): void;
	/** Stable: retries this subscription's connection only (`subscription.retry()`). */
	retry(): void;
}

export interface UseLiveResult<E, T = E>
	extends LiveSnapshot<T>,
		UseSubscriptionResult<E> {}

/**
 * Subscribe while mounted. `source` is a request or a feed (`null` or `false`
 * disables); `observer` is an observer object or a function that receives
 * each event. Without an `error` hook (and without `throwOnError`) a terminal
 * error is rethrown into the client's callback guard.
 */
export function useSubscription<E>(
	client: SpinetabClient,
	source: Source<E> | Disabled,
	observer: Observer<NoInfer<E>>,
	options?: UseSubscriptionOptions,
): UseSubscriptionResult<E> {
	assertClient(client, "useSubscription");
	assertOptions(options, "useSubscription");
	const target = toObserver(observer, "observer");
	const { request, key } = normalise(source);
	return useCore(client, request, key, target, options).result;
}

/**
 * The value of the committed subscription: `data` starts at `initial`
 * and follows `map` or `reduce`. A render with a new source or client, a
 * return to an earlier source, or a subscription re-created within one mount
 * (`<Activity>`, back-navigation, Fast Refresh) returns `initial` in that same
 * render, with no error, until the new subscription emits. A principal change
 * (`setScope`) also restarts at `initial`. The value is never seeded, shared
 * or kept after unmount. An unreconciled loss without `reconcile` is `error`
 * `continuity-lost`; whether a policy applies is fixed per identity.
 */
export function useLive<E, T = E>(
	client: SpinetabClient,
	source: Source<E> | Disabled,
	options?: LiveOptions<NoInfer<E>, T>,
): UseLiveResult<E, T> {
	assertClient(client, "useLive");
	assertOptions(options as LiveOptions<unknown, unknown>, "useLive");
	const { request, key } = normalise(source);
	const fresh = (owner: object | null): LiveState<T> => ({
		owner,
		data: options?.initial,
		error: undefined,
	});
	const [state, setState] = useState<LiveState<T>>(() => fresh(null));
	// The attachment whose events are delivered now (one per mount at a time).
	const delivering = useRef<object | null>(null);
	const target: SubscriptionObserver<E> = {
		next(event, meta) {
			const owner = delivering.current;
			setState((previous) => {
				const base = previous.owner === owner ? previous : fresh(owner);
				return { ...base, data: fold(options, base.data, event, meta) };
			});
		},
		error(record) {
			const owner = delivering.current;
			setState((previous) => ({
				...(previous.owner === owner ? previous : fresh(owner)),
				error: deserialiseError(record),
			}));
		},
	};
	const { result, owner } = useCore(client, request, key, target, options, {
		delivering,
		restart: (entry) => setState(fresh(entry)),
	});
	// Shown only while its attachment is the committed one for this render's
	// client and key: never after a switch, a return, a new client or a re-attach.
	const view =
		state.owner !== null && state.owner === owner ? state : fresh(null);
	const policy = hasPolicy(owner?.attached, options);
	const lost = useMemo(
		() => lossError(result.status.continuity, policy),
		[result.status.continuity, policy],
	);
	const failed = useMemo(
		() => connectionError(result.status.connection),
		[result.status.connection],
	);
	return {
		...result,
		data: view.data,
		error: view.error ?? failed ?? lost,
		needsReconcile: needsReconcile(result.status),
	};
}

export function useSubscriptionStatus(
	subscription: Subscription<unknown> | null | undefined,
): SubscriptionStatus {
	const subscribe = useCallback(
		(onChange: () => void) =>
			subscription ? subscription.status.subscribe(() => onChange()) : noop,
		[subscription],
	);
	const getSnapshot = useCallback(
		() => (subscription ? subscription.status.get() : INACTIVE_STATUS),
		[subscription],
	);
	return useSyncExternalStore(subscribe, getSnapshot, getInactive);
}

export function useSpinetabStatus(client: SpinetabClient): ClientStatus {
	assertClient(client, "useSpinetabStatus");
	const subscribe = useCallback(
		(onChange: () => void) => client.status.subscribe(() => onChange()),
		[client],
	);
	const getSnapshot = useCallback(() => client.status.get(), [client]);
	return useSyncExternalStore(subscribe, getSnapshot, getServerStatus);
}

export interface BoundReact {
	useSubscription<E>(
		source: Source<E> | Disabled,
		observer: Observer<NoInfer<E>>,
		options?: UseSubscriptionOptions,
	): UseSubscriptionResult<E>;
	useSubscriptionStatus: typeof useSubscriptionStatus;
	useSpinetabStatus(): ClientStatus;
	useLive<E, T = E>(
		source: Source<E> | Disabled,
		options?: LiveOptions<NoInfer<E>, T>,
	): UseLiveResult<E, T>;
}

/**
 * The hooks with the application's client applied: no provider and no
 * module-level state; the client stays in the application's module. Call it
 * in a client module (`live.ts`); it starts nothing.
 */
export function bindClient(client: SpinetabClient): BoundReact {
	assertClient(client, "bindClient");
	return {
		useSubscription: (source, observer, options) =>
			useSubscription(client, source, observer, options),
		useSubscriptionStatus,
		useSpinetabStatus: () => useSpinetabStatus(client),
		useLive: (source, options) => useLive(client, source, options),
	};
}

interface LiveState<T> {
	/** The attachment whose events produced this value. */
	owner: object | null;
	data: T | undefined;
	error: SpinetabError | undefined;
}

/** One subscribe-effect run: the attachment a render can commit to. */
interface Entry<E> {
	client: SpinetabClient;
	key: string;
	attached: Attached<E>;
	consumer: string | null;
}

interface ValueHook {
	/** Set to the new attachment before it subscribes. */
	delivering: { current: object | null };
	/** A principal change restarts the attachment's value at `initial`. */
	restart(entry: object): void;
}

function normalise<E>(source: Source<E> | Disabled): {
	request: SubscriptionRequest<E> | null;
	key: string | null;
} {
	const request = isDisabled(source) ? null : toRequest(source, "source");
	return { request, key: request === null ? null : requestKey(request) };
}

/**
 * The lifecycle shared by `useSubscription` and `useLive`: one subscription
 * per committed client and identity, per-consumer updates without
 * resubscribing, the reconcile policy, and terminal errors held for
 * `throwOnError`. `owner` is the committed attachment for this render's
 * client and key, or `null`; the value and the failure belong to it.
 */
function useCore<E>(
	client: SpinetabClient,
	request: SubscriptionRequest<E> | null,
	key: string | null,
	target: SubscriptionObserver<E>,
	options: SubscriptionOptions | undefined,
	valueHook?: ValueHook,
): { result: UseSubscriptionResult<E>; owner: Entry<E> | null } {
	const consumer = consumerKey(options);
	const latest = useRef({ client, key, request, target, options, valueHook });
	useLayoutEffect(() => {
		latest.current = { client, key, request, target, options, valueHook };
	});
	const [current, setCurrent] = useState<Entry<E> | null>(null);
	const [failure, setFailure] = useState<{
		owner: Entry<E>;
		error: SpinetabError;
	} | null>(null);

	useEffect(() => {
		if (key === null) {
			setCurrent(null);
			return;
		}
		const {
			request: live,
			options: liveOptions,
			valueHook: hook,
		} = latest.current;
		if (!live) return;
		// Deliver only while this client and identity are the rendered ones.
		const own = () =>
			latest.current.client === client && latest.current.key === key
				? latest.current
				: undefined;
		const entry = {
			client,
			key,
			consumer: consumerKey(liveOptions),
		} as Entry<E>;
		// Before subscribing: core may deliver inside `subscribe()`.
		if (hook) hook.delivering.current = entry;
		const policy = liveOptions?.reconcile;
		entry.attached = attach(
			client,
			live,
			{
				...liveOptions,
				// The newest refresh function runs, else the one attached with the handle;
				// the policy kind is fixed per identity.
				...(typeof policy === "function"
					? {
							reconcile: (context: ReconcileContext) => {
								const refresh = own()?.options?.reconcile;
								return typeof refresh === "function"
									? refresh(context)
									: policy(context);
							},
						}
					: {}),
			},
			() => own()?.target,
			(record) => {
				const mine = own();
				if (!mine) return;
				if (mine.options?.throwOnError) {
					mine.target.error?.(record);
					setFailure({ owner: entry, error: deserialiseError(record) });
					return;
				}
				forwardError(mine.target, record);
			},
			{
				// Only when the application gave one; the newest closure runs.
				resume:
					liveOptions?.resume && ((state) => own()?.options?.resume?.(state)),
				// A value hook reports stopped delivery itself and restarts
				// at `initial` on a principal change.
				handlesStatus: hook !== undefined,
				onScopeChange: () => own()?.valueHook?.restart(entry),
			},
		);
		setCurrent(entry);
		return () => {
			entry.attached.release();
			// A released attachment is never the committed one: a subscription
			// re-created within one mount (Activity, Strict Mode) starts afresh.
			setCurrent((committed) => (committed === entry ? null : committed));
		};
	}, [client, key]);

	// Per-consumer option changes update the consumer without resubscribing.
	useEffect(() => {
		if (!current || current.client !== client || current.key !== key) return;
		if (consumer === current.consumer) return;
		current.consumer = consumer;
		// Removing the option is a change too: `{}` restores the defaults.
		current.attached.handle.update(latest.current.options?.consumer ?? {});
	}, [current, client, key, consumer]);

	const owner =
		current && current.client === client && current.key === key
			? current
			: null;
	const handle = owner ? owner.attached.handle : null;
	const status = useSubscriptionStatus(handle);
	// Imperative actions reach only the committed handle: an uncommitted
	// (suspended or discarded) render must not redirect the visible UI's
	// callbacks, and nothing reaches a handle after its commit is torn down.
	const handleRef = useRef<Subscription<E> | null>(null);
	useLayoutEffect(() => {
		handleRef.current = handle;
		return () => {
			handleRef.current = null;
		};
	}, [handle]);
	// Arguments are read, never forwarded: `onClick={markReconciled}` passes an event.
	const markReconciled = useCallback((value?: { pending?: boolean }) => {
		handleRef.current?.markReconciled(pendingOnly(value));
	}, []);
	const retry = useCallback(() => {
		handleRef.current?.retry();
	}, []);
	// Set only by a browser effect's subscription; thrown to the nearest
	// error boundary on the render that follows (IB:112), only while the
	// attachment that raised it is the committed one.
	if (failure && failure.owner === owner && options?.throwOnError) {
		throw failure.error;
	}
	if (options?.throwOnError && status.connection.state === "failed") {
		throw connectionError(status.connection);
	}
	return {
		result: { status, subscription: handle, markReconciled, retry },
		owner,
	};
}

function noop(): void {}
function getInactive(): SubscriptionStatus {
	return INACTIVE_STATUS;
}
function getServerStatus(): ClientStatus {
	return SERVER_STATUS;
}
