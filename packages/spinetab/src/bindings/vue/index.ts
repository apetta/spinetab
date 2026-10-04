import {
	type ComputedRef,
	computed,
	getCurrentInstance,
	getCurrentScope,
	type MaybeRefOrGetter,
	onMounted,
	onScopeDispose,
	type ShallowRef,
	shallowRef,
	toValue,
	watch,
} from "vue";
import { deserialiseError, type SpinetabError } from "../../core/errors.ts";
import type { ReconcileContext } from "../../core/reconcile.ts";
import { toObserver, toRequest } from "../../core/source.ts";
import {
	SERVER_SUBSCRIPTION_STATUS as INACTIVE_STATUS,
	SERVER_STATUS,
} from "../../core/status.ts";
import type {
	ClientStatus,
	Continuity,
	Observer,
	Source,
	SpinetabClient,
	Subscription,
	SubscriptionObserver,
	SubscriptionStatus,
} from "../../core/types.ts";
import { warnUnowned } from "../shared/dev.ts";
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
 * Vue 3.5 composables. In a component, live work starts in `onMounted`
 * (never during SSR); in an application `effectScope()` it starts at once in
 * the browser; cleanup is registered with `onScopeDispose`. Without an active
 * scope they warn and the caller must call `dispose()`. Inputs are watched by
 * the canonical identity of the normalised request only, so a getter that
 * rebuilds its feed never resubscribes; options may be a ref or a getter, and
 * a changed `consumer` updates the consumer without resubscribing. Observer
 * methods are read at delivery time. `status` and `subscription` describe the
 * rendered identity or none: between a source change and the pre-flush
 * watcher that applies it they are inactive and `null`, and `markReconciled`
 * and `retry` reach no handle.
 */

export interface UseSubscriptionResult<E> {
	status: ComputedRef<SubscriptionStatus>;
	subscription: Readonly<ShallowRef<Subscription<E> | null>>;
	markReconciled(options?: { pending?: boolean }): void;
	/** Retries this subscription's connection only (`subscription.retry()`). */
	retry(): void;
	/** Idempotent; also runs when the owning scope is disposed. */
	dispose(): void;
}

export interface UseLiveResult<E, T = E> extends UseSubscriptionResult<E> {
	/** Held for this mount only; read it with `needsReconcile`. */
	data: ComputedRef<T | undefined>;
	/** A terminal error, or `continuity-lost` while a loss without a policy is unreconciled. */
	error: ComputedRef<SpinetabError | undefined>;
	needsReconcile: ComputedRef<boolean>;
}

export type UseSubscriptionOptions = SubscriptionOptions;

/**
 * `source` is a request or a feed, or a ref or getter of one (`null` or
 * `false` disables); `observer` is an observer object or a function that
 * receives each event. Without an `error` hook (and without `throwOnError`)
 * a terminal error is rethrown into the client's callback guard.
 * `throwOnError` throws it from a watcher, so `onErrorCaptured` and
 * `app.config.errorHandler` receive it.
 */
export function useSubscription<E>(
	client: SpinetabClient,
	source: MaybeRefOrGetter<Source<E> | Disabled>,
	observer: Observer<NoInfer<E>>,
	options?: MaybeRefOrGetter<UseSubscriptionOptions | undefined>,
): UseSubscriptionResult<E> {
	assertClient(client, "useSubscription");
	assertOptions(toValue(options), "useSubscription");
	const target = toObserver(observer, "observer");
	const { result } = useCore(
		client,
		source,
		target,
		options,
		"useSubscription",
	);
	return result;
}

/**
 * The value of a subscription for this component: `data` starts at
 * `initial`, follows `map` or `reduce`, resets as soon as the identity
 * changes, restarts at `initial` on a principal change (`setScope`), and is
 * never seeded, shared or kept after disposal. An unreconciled loss without
 * `reconcile` is `error` `continuity-lost`; whether a policy applies is fixed
 * per identity.
 */
export function useLive<E, T = E>(
	client: SpinetabClient,
	source: MaybeRefOrGetter<Source<E> | Disabled>,
	options?: MaybeRefOrGetter<LiveOptions<NoInfer<E>, T> | undefined>,
): UseLiveResult<E, T> {
	assertClient(client, "useLive");
	assertOptions(
		toValue(options) as LiveOptions<unknown, unknown> | undefined,
		"useLive",
	);
	const initial = () => toValue(options)?.initial;
	const state = shallowRef<{
		key: string | null;
		data: T | undefined;
		error: SpinetabError | undefined;
	}>({ key: null, data: initial(), error: undefined });
	const fresh = (key: string | null) => ({
		key,
		data: initial(),
		error: undefined,
	});
	let live: string | null = null;
	const target: SubscriptionObserver<E> = {
		next(event, meta) {
			const base = state.value.key === live ? state.value : fresh(live);
			state.value = {
				...base,
				data: fold(toValue(options), base.data, event, meta),
			};
		},
		error(record) {
			const base = state.value.key === live ? state.value : fresh(live);
			state.value = { ...base, error: deserialiseError(record) };
		},
	};
	const { result, key, attached } = useCore(
		client,
		source,
		target,
		options,
		"useLive",
		{
			onIdentity(next) {
				live = next;
				state.value = fresh(next);
			},
			restart() {
				state.value = fresh(live);
			},
		},
	);
	const view = computed(() =>
		state.value.key === key.value ? state.value : fresh(key.value),
	);
	const lost = memoLoss(() => hasPolicy(attached(), toValue(options)));
	const failed = computed(() =>
		connectionError(result.status.value.connection),
	);
	return {
		...result,
		data: computed(() => view.value.data),
		error: computed(
			() =>
				view.value.error ??
				failed.value ??
				lost(result.status.value.continuity),
		),
		needsReconcile: computed(() => needsReconcile(result.status.value)),
	};
}

export interface UseSpinetabStatusResult {
	status: ComputedRef<ClientStatus>;
	dispose(): void;
}

export function useSpinetabStatus(
	client: SpinetabClient,
): UseSpinetabStatusResult {
	assertClient(client, "useSpinetabStatus");
	// SSR and the first client render agree on SERVER_STATUS.
	const status = shallowRef<ClientStatus>(SERVER_STATUS);
	let off: (() => void) | undefined;
	let disposed = false;
	const start = () => {
		if (disposed || off || !isBrowser()) return;
		status.value = client.status.get();
		off = client.status.subscribe((value) => {
			status.value = value;
		});
	};
	const dispose = () => {
		disposed = true;
		off?.();
		off = undefined;
	};
	bindLifecycle(start, dispose, "useSpinetabStatus");
	return { status: computed(() => status.value), dispose };
}

export interface BoundVue {
	useSubscription<E>(
		source: MaybeRefOrGetter<Source<E> | Disabled>,
		observer: Observer<NoInfer<E>>,
		options?: MaybeRefOrGetter<UseSubscriptionOptions | undefined>,
	): UseSubscriptionResult<E>;
	useSpinetabStatus(): UseSpinetabStatusResult;
	useLive<E, T = E>(
		source: MaybeRefOrGetter<Source<E> | Disabled>,
		options?: MaybeRefOrGetter<LiveOptions<NoInfer<E>, T> | undefined>,
	): UseLiveResult<E, T>;
}

/**
 * The composables with the application's client applied: no provide/inject
 * and no module-level state. Call it in a client module (`live.ts`); it
 * starts nothing.
 */
export function bindClient(client: SpinetabClient): BoundVue {
	assertClient(client, "bindClient");
	return {
		useSubscription: (source, observer, options) =>
			useSubscription(client, source, observer, options),
		useSpinetabStatus: () => useSpinetabStatus(client),
		useLive: (source, options) => useLive(client, source, options),
	};
}

interface ValueHook {
	/** Runs before each subscribe with the new identity, and with `null` when disabled or disposed. */
	onIdentity(key: string | null): void;
	/** A principal change restarts the value at `initial`. */
	restart(): void;
}

/**
 * The lifecycle shared by `useSubscription` and `useLive`. `attached()` is the
 * applied attachment, whose policy kind is fixed for its identity.
 */
function useCore<E>(
	client: SpinetabClient,
	source: MaybeRefOrGetter<Source<E> | Disabled>,
	target: SubscriptionObserver<E>,
	options: MaybeRefOrGetter<SubscriptionOptions | undefined> | undefined,
	name: string,
	hook?: ValueHook,
): {
	result: UseSubscriptionResult<E>;
	key: ComputedRef<string | null>;
	attached(): Attached<E> | undefined;
} {
	const normalised = computed(() => {
		const value = toValue(source);
		const request = isDisabled(value) ? null : toRequest(value, "source");
		return { request, key: request === null ? null : requestKey(request) };
	});
	const key = computed(() => normalised.value.key);
	const current = () => toValue(options);
	const status = shallowRef<SubscriptionStatus>(INACTIVE_STATUS);
	const failure = shallowRef<SpinetabError | null>(null);
	// The attachment the watcher applied. Until the pre-flush watcher runs
	// after a source change it is the previous identity's, so the result
	// shows it only while its key is the rendered one.
	const live = shallowRef<
		| {
				key: string;
				attached: Attached<E>;
				consumer: string | null;
				off(): void;
		  }
		| undefined
	>();
	const shown = computed(() =>
		live.value?.key === key.value ? live.value : undefined,
	);
	let stops: Array<() => void> = [];
	let disposed = false;

	const release = () => {
		live.value?.off();
		live.value?.attached.release();
		live.value = undefined;
		status.value = INACTIVE_STATUS;
	};

	const apply = (next: string | null) => {
		if (disposed || live.value?.key === next) return;
		release();
		failure.value = null;
		hook?.onIdentity(next);
		const request = normalised.value.request;
		if (next === null || !request) return;
		const settings = current();
		const policy = settings?.reconcile;
		const attached = attach(
			client,
			request,
			{
				...settings,
				...(typeof policy === "function"
					? {
							reconcile: (context: ReconcileContext) => {
								const refresh = current()?.reconcile;
								return typeof refresh === "function"
									? refresh(context)
									: policy(context);
							},
						}
					: {}),
			},
			() => target,
			(record) => {
				if (current()?.throwOnError) {
					target.error?.(record);
					failure.value = deserialiseError(record);
					return;
				}
				forwardError(target, record);
			},
			// A value hook reports stopped delivery itself and
			// restarts at `initial` on a principal change.
			hook && { handlesStatus: true, onScopeChange: hook.restart },
		);
		const off = attached.handle.status.subscribe((value) => {
			if (live.value?.attached === attached) status.value = value;
		});
		live.value = { key: next, attached, consumer: consumerKey(settings), off };
		status.value = attached.handle.status.get();
	};

	const start = () => {
		if (disposed || stops.length > 0 || !isBrowser()) return;
		stops = [
			watch(key, apply, { immediate: true }),
			// Per-consumer option changes update without resubscribing.
			watch(
				() => consumerKey(current()),
				(next) => {
					const applied = live.value;
					if (!applied || next === applied.consumer) return;
					applied.consumer = next;
					// Removing the option is a change too: `{}` restores the defaults.
					applied.attached.handle.update(current()?.consumer ?? {});
				},
			),
			// Thrown from a watcher: Vue routes it to onErrorCaptured.
			watch(
				() =>
					failure.value ??
					(shown.value && connectionError(status.value.connection)),
				(error) => {
					if (error && current()?.throwOnError) throw error;
				},
			),
		];
	};

	const dispose = () => {
		if (disposed) return;
		for (const stop of stops) stop();
		stops = [];
		release();
		// The value is never kept after disposal.
		hook?.onIdentity(null);
		disposed = true;
	};

	bindLifecycle(start, dispose, name);

	return {
		key,
		attached: () => live.value?.attached,
		result: {
			status: computed(() => (shown.value ? status.value : INACTIVE_STATUS)),
			subscription: computed(() => shown.value?.attached.handle ?? null),
			markReconciled: (value) =>
				shown.value?.attached.handle.markReconciled(pendingOnly(value)),
			retry: () => shown.value?.attached.handle.retry(),
			dispose,
		},
	};
}

/** One `continuity-lost` error per continuity object, so reads stay stable. */
function memoLoss(hasPolicy: () => boolean) {
	let last: Continuity | undefined;
	let policy = false;
	let error: SpinetabError | undefined;
	return (continuity: Continuity) => {
		const now = hasPolicy();
		if (continuity !== last || now !== policy) {
			last = continuity;
			policy = now;
			error = lossError(continuity, now);
		}
		return error;
	};
}

function bindLifecycle(start: () => void, dispose: () => void, name: string) {
	const scope = getCurrentScope();
	if (scope) onScopeDispose(dispose);
	if (getCurrentInstance()) {
		onMounted(start);
		return;
	}
	if (!scope) warnUnowned(name, "vue");
	start();
}

function isBrowser(): boolean {
	return typeof window !== "undefined" && typeof document !== "undefined";
}
