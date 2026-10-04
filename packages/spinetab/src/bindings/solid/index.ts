import {
	type Accessor,
	createEffect,
	createMemo,
	createRoot,
	createSignal,
	getOwner,
	onCleanup,
	untrack,
} from "solid-js";
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
 * Solid 1.9 primitives. Work starts in `createEffect` (never during SSR or the
 * initial hydration pass), tracks only the canonical identity of the
 * normalised request, so an accessor that rebuilds its feed never
 * resubscribes, and releases on re-run and owner disposal through `onCleanup`.
 * Sources and options are values or accessors; a changed `consumer` updates
 * the consumer without resubscribing. Without an owner they warn and the
 * caller must call `dispose()`. Observer methods are read at delivery time.
 * `status` and `subscription` describe the rendered identity or none: a
 * render effect that runs after a source change, before the effect that
 * subscribes it, sees them inactive and `null`, and `markReconciled` and
 * `retry` reach no handle.
 */

/** A value, or an accessor of one. */
export type MaybeAccessor<T> = T | Accessor<T>;

export interface SubscriptionResource<E> {
	status: Accessor<SubscriptionStatus>;
	subscription: Accessor<Subscription<E> | null>;
	markReconciled(options?: { pending?: boolean }): void;
	/** Retries this subscription's connection only (`subscription.retry()`). */
	retry(): void;
	/** Idempotent; also runs when the owner is disposed. */
	dispose(): void;
}

export interface LiveResource<E, T = E> extends SubscriptionResource<E> {
	/** Held for this owner only; read it with `needsReconcile`. */
	data: Accessor<T | undefined>;
	/** A terminal error, or `continuity-lost` while a loss without a policy is unreconciled. */
	error: Accessor<SpinetabError | undefined>;
	needsReconcile: Accessor<boolean>;
}

/**
 * `source` is a request or a feed, or an accessor of one (`null` or `false`
 * disables); `observer` is an observer object or a function that receives
 * each event. Without an `error` hook (and without `throwOnError`) a
 * terminal error is rethrown into the client's callback guard.
 * `throwOnError` throws it from an effect, so `ErrorBoundary` receives it.
 */
export function createSubscription<E>(
	client: SpinetabClient,
	source: MaybeAccessor<Source<E> | Disabled>,
	observer: Observer<NoInfer<E>>,
	options?: MaybeAccessor<SubscriptionOptions | undefined>,
): SubscriptionResource<E> {
	assertClient(client, "createSubscription");
	assertOptions(read(options), "createSubscription");
	const target = toObserver(observer, "observer");
	return createCore(
		client,
		source,
		target,
		options,
		"createSubscription",
		() => ({}),
	);
}

/**
 * The value of a subscription for this owner: `data` starts at
 * `initial`, follows `map` or `reduce`, resets as soon as the identity
 * changes, restarts at `initial` on a principal change (`setScope`), and is
 * never seeded, shared or kept after disposal. An unreconciled loss without
 * `reconcile` is `error` `continuity-lost`; whether a policy applies is fixed
 * per identity.
 */
export function createLive<E, T = E>(
	client: SpinetabClient,
	source: MaybeAccessor<Source<E> | Disabled>,
	options?: MaybeAccessor<LiveOptions<NoInfer<E>, T> | undefined>,
): LiveResource<E, T> {
	assertClient(client, "createLive");
	assertOptions(
		read(options) as LiveOptions<unknown, unknown> | undefined,
		"createLive",
	);
	const initial = () => read(options)?.initial;
	const fresh = (key: string | null) => ({
		key,
		data: initial(),
		error: undefined as SpinetabError | undefined,
	});
	let live: string | null = null;
	let setState: ((next: ReturnType<typeof fresh>) => void) | undefined;
	let getState: Accessor<ReturnType<typeof fresh>> | undefined;
	const target: SubscriptionObserver<E> = {
		next(event, meta) {
			const current = getState?.();
			if (!current || !setState) return;
			const base = current.key === live ? current : fresh(live);
			setState({
				...base,
				data: fold(read(options), base.data, event, meta),
			});
		},
		error(record) {
			const current = getState?.();
			if (!current || !setState) return;
			const base = current.key === live ? current : fresh(live);
			setState({ ...base, error: deserialiseError(record) });
		},
	};
	return createCore(
		client,
		source,
		target,
		options,
		"createLive",
		({ key, status, attached, disposed }) => {
			const [state, set] = createSignal(fresh(null));
			getState = state;
			setState = (next) => set(() => next);
			const view = createMemo(() =>
				state().key === key() ? state() : fresh(key()),
			);
			const continuity = createMemo(() => status().continuity);
			const failed = createMemo(() => connectionError(status().connection));
			const lost = createMemo(() =>
				lossError(continuity(), hasPolicy(attached(), read(options))),
			);
			return {
				// Its computations are gone after disposal: read the flag first.
				data: () => (disposed() ? initial() : view().data),
				error: () =>
					disposed() ? undefined : (view().error ?? failed() ?? lost()),
				needsReconcile: () => needsReconcile(status()),
			};
		},
		{
			onIdentity(next) {
				live = next;
				setState?.(fresh(next));
			},
			restart() {
				setState?.(fresh(live));
			},
		},
	);
}

export function createSpinetabStatus(client: SpinetabClient): {
	status: Accessor<ClientStatus>;
	dispose(): void;
} {
	assertClient(client, "createSpinetabStatus");
	const owner = getOwner();
	if (!owner) {
		warnUnowned("createSpinetabStatus", "solid");
	}
	const resource = createRoot((dispose) => {
		let disposed = false;
		onCleanup(() => {
			disposed = true;
		});
		// SSR and hydration agree on SERVER_STATUS; the effect switches to live.
		const [status, setStatus] = createSignal<ClientStatus>(SERVER_STATUS);
		createEffect(() => {
			if (disposed) return;
			setStatus(() => client.status.get());
			const off = client.status.subscribe((value) => setStatus(() => value));
			onCleanup(off);
		});
		return { status, dispose };
	}, owner ?? undefined);
	if (owner) onCleanup(resource.dispose);
	return resource;
}

export interface BoundSolid {
	createSubscription<E>(
		source: MaybeAccessor<Source<E> | Disabled>,
		observer: Observer<NoInfer<E>>,
		options?: MaybeAccessor<SubscriptionOptions | undefined>,
	): SubscriptionResource<E>;
	createSpinetabStatus(): ReturnType<typeof createSpinetabStatus>;
	createLive<E, T = E>(
		source: MaybeAccessor<Source<E> | Disabled>,
		options?: MaybeAccessor<LiveOptions<NoInfer<E>, T> | undefined>,
	): LiveResource<E, T>;
}

/**
 * The primitives with the application's client applied: no context provider
 * and no module-level state. Call it in a client module (`live.ts`); it
 * starts nothing.
 */
export function bindClient(client: SpinetabClient): BoundSolid {
	assertClient(client, "bindClient");
	return {
		createSubscription: (source, observer, options) =>
			createSubscription(client, source, observer, options),
		createSpinetabStatus: () => createSpinetabStatus(client),
		createLive: (source, options) => createLive(client, source, options),
	};
}

function read<T>(value: MaybeAccessor<T>): T {
	return typeof value === "function" ? (value as Accessor<T>)() : value;
}

interface ValueHook {
	/** Runs before each subscribe with the new identity (or `null` when disabled). */
	onIdentity(key: string | null): void;
	/** A principal change restarts the value at `initial`. */
	restart(): void;
}

/**
 * The lifecycle shared by `createSubscription` and `createLive`. `extend`
 * runs inside the root, so its computations are disposed with it; it gets
 * the applied attachment, whose policy kind is fixed for its identity, and a
 * `disposed` flag that stays readable after disposal.
 */
function createCore<E, X extends object>(
	client: SpinetabClient,
	source: MaybeAccessor<Source<E> | Disabled>,
	target: SubscriptionObserver<E>,
	options: MaybeAccessor<SubscriptionOptions | undefined> | undefined,
	name: string,
	extend: (parts: {
		key: Accessor<string | null>;
		status: Accessor<SubscriptionStatus>;
		attached: () => Attached<E> | undefined;
		disposed: Accessor<boolean>;
	}) => X,
	hook?: ValueHook,
): SubscriptionResource<E> & X {
	const owner = getOwner();
	if (!owner) {
		warnUnowned(name, "solid");
	}
	const resource = createRoot((dispose) => {
		// Suspense can resume an already queued effect after a transition has
		// disposed this owner. Use a synchronous lifetime flag: signal writes
		// themselves may still be staged in that transition.
		let stopped = false;
		const [latest, setStatus] =
			createSignal<SubscriptionStatus>(INACTIVE_STATUS);
		const [failure, setFailure] = createSignal<SpinetabError | null>(null);
		const [disposed, setDisposed] = createSignal(false);
		// The attachment the key effect applied. A render effect in the same
		// update as a source change runs before that effect, so the result
		// shows it only while its key is the rendered one.
		const [live, setLive] = createSignal<
			| { key: string; attached: Attached<E>; consumer: string | null }
			| undefined
		>();
		// The request normalised by the latest key run; the effect subscribes it.
		let request: SubscriptionRequest<E> | null = null;
		const key = createMemo(() => {
			const value = read(source);
			request = isDisabled(value) ? null : toRequest(value, "source");
			return request === null ? null : requestKey(request);
		});
		const shown = createMemo(() => {
			const entry = live();
			return entry?.key === key() ? entry : undefined;
		});
		const status = createMemo(() => (shown() ? latest() : INACTIVE_STATUS));
		const subscription = createMemo(
			(): Subscription<E> | null => shown()?.attached.handle ?? null,
		);
		const extra = extend({
			key,
			status,
			attached: () => live()?.attached,
			disposed,
		});
		createEffect(() => {
			if (stopped) return;
			const next = key();
			untrack(() => {
				setFailure(null);
				hook?.onIdentity(next);
			});
			if (next === null) return;
			const pending = request;
			if (!pending) return;
			const attached = untrack(() => {
				const settings = read(options);
				const policy = settings?.reconcile;
				return attach(
					client,
					pending,
					{
						...settings,
						...(typeof policy === "function"
							? {
									reconcile: (context: ReconcileContext) => {
										const refresh = read(options)?.reconcile;
										return typeof refresh === "function"
											? refresh(context)
											: policy(context);
									},
								}
							: {}),
					},
					() => target,
					(record) => {
						if (read(options)?.throwOnError) {
							target.error?.(record);
							setFailure(() => deserialiseError(record));
							return;
						}
						forwardError(target, record);
					},
					// A value hook reports stopped delivery itself and
					// restarts at `initial` on a principal change.
					hook && { handlesStatus: true, onScopeChange: hook.restart },
				);
			});
			const entry = {
				key: next,
				attached,
				consumer: untrack(() => consumerKey(read(options))),
			};
			setLive(entry);
			setStatus(() => attached.handle.status.get());
			const off = attached.handle.status.subscribe((value) => {
				if (untrack(live) === entry) setStatus(() => value);
			});
			onCleanup(() => {
				off();
				attached.release();
				setLive(undefined);
				setStatus(INACTIVE_STATUS);
			});
		});
		// Per-consumer option changes update without resubscribing.
		createEffect(() => {
			const next = consumerKey(read(options));
			untrack(() => {
				const applied = live();
				if (!applied || next === applied.consumer) return;
				applied.consumer = next;
				// Removing the option is a change too: `{}` restores the defaults.
				applied.attached.handle.update(read(options)?.consumer ?? {});
			});
		});
		// Thrown from an effect: the nearest ErrorBoundary receives it.
		createEffect(() => {
			if (stopped) return;
			const error = failure() ?? connectionError(status().connection);
			if (error && untrack(() => read(options)?.throwOnError)) throw error;
		});
		// The root's own cleanup runs after its computations are disposed; the
		// value hook reads this flag, so nothing is kept after disposal.
		onCleanup(() => {
			stopped = true;
			setDisposed(true);
		});
		return {
			...extra,
			status,
			subscription,
			markReconciled: (value?: { pending?: boolean }) =>
				untrack(shown)?.attached.handle.markReconciled(pendingOnly(value)),
			retry: () => untrack(shown)?.attached.handle.retry(),
			dispose,
		};
	}, owner ?? undefined);
	if (owner) onCleanup(resource.dispose);
	return resource;
}
