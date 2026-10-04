import type { SWRSubscriptionOptions } from "swr/subscription";
import { deserialiseError, SpinetabError } from "../../core/errors.ts";
import { reconcileLatest, reconcileOnLoss } from "../../core/reconcile.ts";
import { toRequest } from "../../core/source.ts";
import type {
	ConsumerJson,
	ConsumerOptions,
	Continuity,
	EventMeta,
	Source,
	SpinetabClient,
	Subscription,
	SubscriptionStatus,
} from "../../core/types.ts";

export interface SwrSubscriptionOptions<Key, E, Data> {
	/**
	 * Map an event to SWR data, or to an updater `(current) => next` for an
	 * application-owned merge. Default: the event itself.
	 */
	map?(event: E, meta: EventMeta): Data | ((current?: Data) => Data);
	/**
	 * Opt-in reconciliation: `"latest"` for a full-state feed (the
	 * next event is the reconciled value), or the application's refresh for
	 * the key, run by `reconcileOnLoss`. The refresh must resolve only after
	 * the key's data has been fetched and written, and reject on failure. An
	 * application-owned populate mutation does both, with or without a mounted
	 * `useSWR` for the key. State `throwOnError: true` (SWR's runtime default,
	 * though its types document `false`) and leave `populateCache` at `true`:
	 *
	 * ```ts
	 * reconcile: async (key) => {
	 * await mutate(snapshotKey(key), fetchSnapshot(key), {
	 * revalidate: false,
	 * throwOnError: true,
	 * });
	 * },
	 * ```
	 *
	 * A key-only `mutate(key)` is not a refresh: it resolves when the fetch
	 * fails, and fetches nothing without a mounted hook. A failed refresh keeps
	 * continuity lost, reaches SWR's `error` as `upstream-error` with the
	 * failure as `cause`, and is retried on the next notice or at `connected`.
	 * The engine coalesces notices and never declares an overtaken run, so
	 * this form needs no run token.
	 */
	reconcile?: "latest" | ((key: Key) => void | Promise<void>);
	/**
	 * Each continuity notice away from `continuous`; a repeated `gap` with the
	 * same reason is reported once until reconciled. When neither this nor
	 * `reconcile` is set, `gap` and `unknown` also call
	 * `next(SpinetabError("continuity-lost"))`, because
	 * SWR clears `error` on the next data event while continuity stays sticky.
	 * Call `controls.markReconciled()` once the application has reconciled,
	 * inline or later. A loss already reconciled from `onStatus` is not
	 * reported afterwards. An interruption can report the same state and
	 * reason twice: early at detection, then as the outcome just before
	 * `connected`, even before the application reconciled; reconcile on each.
	 * A newer mutation of the key supersedes an older one's write, so only the
	 * latest run may call `markReconciled()`. These options serve every key,
	 * so keep the run token per key, in a `Map` keyed by the SWR key. A `Map`
	 * compares an array or object key by reference: pass a stable key, or key
	 * the `Map` by SWR's serialised form, `unstable_serialize(key)` from
	 * `swr`:
	 *
	 * ```ts
	 * const runs = new Map<string, number>();
	 * // in swrSubscription's options:
	 * onContinuity: async (_continuity, key, controls) => {
	 * const run = (runs.get(key) ?? 0) + 1;
	 * runs.set(key, run);
	 * controls.markReconciled({ pending: true });
	 * try {
	 * await mutate(snapshotKey(key), fetchSnapshot(key), {
	 * revalidate: false,
	 * throwOnError: true,
	 * });
	 * if (runs.get(key) === run) controls.markReconciled();
	 * } catch {
	 * // The loss stays visible; the next notice runs this again.
	 * }
	 * },
	 * ```
	 */
	onContinuity?(
		continuity: Continuity,
		key: Key,
		controls: SwrSubscriptionControls,
	): void;
	/** Every status change, including resumable states. */
	onStatus?(
		status: SubscriptionStatus,
		key: Key,
		controls: SwrSubscriptionControls,
	): void;
	/** Adapter-defined per-consumer options, for example `...pollEvery(30_000)`. */
	consumer?: ConsumerJson;
	resume?: ConsumerOptions["resume"];
}

/**
 * Recovery for the one Spinetab subscription behind an SWR key, handed to
 * `onContinuity` and `onStatus`. The same object is passed for the lifetime of
 * that subscription and becomes inert once SWR disposes it. The helper never
 * calls either method itself.
 */
export interface SwrSubscriptionControls {
	/**
	 * Declare the application's SWR data reconciled: continuity returns to
	 * `continuous/reconciled` and delivery stopped by `overflow` or
	 * `message-too-large` restarts in a new epoch, for every hook on this key.
	 * `{ pending: true }` restarts delivery but keeps continuity lost.
	 */
	markReconciled(options?: { pending?: boolean }): void;
	/**
	 * `subscription.retry()`: an explicit upstream retry of this key's
	 * connection only. It does not restart delivery stopped by continuity loss.
	 */
	retry(): void;
}

export type SwrSubscribe<Key, Data> = (
	key: Key,
	options: SWRSubscriptionOptions<Data, SpinetabError>,
) => () => void;

/**
 * Bridge for `useSWRSubscription(key, subscribe)` (swr 2.5.1). `requestFor`
 * returns a request or a feed and must be a pure function of the SWR key (SWR
 * keeps the first `subscribe` per key); the auth scope comes from the client,
 * never from the key. The returned function subscribes synchronously and
 * returns its dispose synchronously, so disposing before the runtime attaches
 * cancels the pending intent.
 *
 * `next(error)` is called only for terminal outcomes: a subscription error, a
 * `failed` connection or (without `onContinuity`) continuity loss. The
 * subscription stays open through `reconnecting`, `retry-exhausted` and
 * `auth-blocked`. Revalidating related keys is the application's call.
 * After `overflow` or `message-too-large` the runtime stops delivery to this
 * subscription until the application calls `controls.markReconciled()` from
 * `onContinuity` or `onStatus`, or a configured `reconcile` does;
 * `controls.retry()` does not resume it.
 */
export function swrSubscription<Key, E, Data = E>(
	client: SpinetabClient,
	requestFor: (key: Key) => Source<E> | null | undefined,
	options: SwrSubscriptionOptions<Key, NoInfer<E>, Data> = {},
): SwrSubscribe<Key, Data> {
	// Refused up front: an unknown value would silence continuity-lost
	// and run no policy.
	const { reconcile } = options;
	if (
		reconcile !== undefined &&
		reconcile !== "latest" &&
		typeof reconcile !== "function"
	) {
		throw new SpinetabError(
			"unsupported-option",
			'swrSubscription reconcile must be "latest" or a refresh function.',
			{ detail: { path: "options.reconcile" } },
		);
	}
	return (key, { next }) => {
		const source = requestFor(key);
		if (!source) return () => {};
		const request = toRequest(source, "requestFor(key)");
		let active = true;
		// Bookkeeping is updated before any application callback runs: an
		// inline `controls.markReconciled()` or `retry()` re-enters `status`
		// synchronously, and that newer status must not be overwritten when the
		// outer call resumes.
		let continuityKey = "continuous";
		let failed = false;
		let turn = 0;
		// The status turn whose continuity loss still awaits `onContinuity`; a
		// newer status that resolves (continuous) or re-reports it takes over.
		let noticeTurn = 0;
		// Assigned once `client.subscribe` returns; a status callback fired
		// synchronously inside it sees a continuous subscription anyway.
		let subscription: Subscription<E> | undefined;
		const controls: SwrSubscriptionControls = {
			markReconciled(markOptions) {
				if (active) subscription?.markReconciled(markOptions);
			},
			retry() {
				if (active) subscription?.retry();
			},
		};
		const policy = options.reconcile;
		let latest: { onEvent(): void; stop(): void } | undefined;
		subscription = client.subscribe<E>(
			request,
			{
				next(event, meta) {
					if (!active) return;
					const data = options.map ? options.map(event, meta) : event;
					next(null, data as Data | ((current?: Data) => Data));
					latest?.onEvent();
				},
				error(error) {
					if (active) next(deserialiseError(error));
				},
				status(status) {
					if (!active) return;
					const { continuity, connection } = status;
					const nextKey = noticeKey(continuity);
					const lost = nextKey !== "continuous" && nextKey !== continuityKey;
					const failing = connection.state === "failed" && !failed;
					const self = ++turn;
					continuityKey = nextKey;
					failed = connection.state === "failed";
					if (lost) noticeTurn = self;
					else if (nextKey === "continuous") noticeTurn = 0;
					// SWR errors never re-enter `status`, so they go out first.
					if (
						lost &&
						!options.onContinuity &&
						policy === undefined &&
						(continuity.state === "gap" || continuity.state === "unknown")
					) {
						next(
							new SpinetabError(
								"continuity-lost",
								`Continuity was lost (${continuity.state}${continuity.reason ? `, ${continuity.reason}` : ""}); reconcile the data, then call markReconciled() from the onStatus or onContinuity controls.`,
								{
									detail: {
										state: continuity.state,
										...(continuity.reason ? { reason: continuity.reason } : {}),
									},
								},
							),
						);
					}
					if (failing) {
						next(
							new SpinetabError(
								"upstream-error",
								`The subscription's connection failed${connection.reason ? ` (${connection.reason})` : ""}.`,
								{
									detail: {
										state: "failed",
										...(connection.reason ? { reason: connection.reason } : {}),
									},
								},
							),
						);
					}
					options.onStatus?.(status, key, controls);
					// Skip a loss that `onStatus` already resolved or superseded.
					if (!active || noticeTurn !== self) return;
					noticeTurn = 0;
					options.onContinuity?.(continuity, key, controls);
				},
			},
			{
				...(options.consumer === undefined
					? {}
					: { consumer: options.consumer }),
				...(options.resume === undefined ? {} : { resume: options.resume }),
			},
		);
		let stopEngine: (() => void) | undefined;
		if (policy === "latest") {
			latest = reconcileLatest(subscription);
			stopEngine = latest.stop;
		} else if (typeof policy === "function") {
			stopEngine = reconcileOnLoss(subscription, () => policy(key), {
				onError(error) {
					if (active) next(refreshError(error));
				},
			});
		}
		return () => {
			if (!active) return;
			active = false;
			stopEngine?.();
			subscription?.unsubscribe();
		};
	};
}

function refreshError(error: unknown): SpinetabError {
	return error instanceof SpinetabError
		? error
		: new SpinetabError(
				"upstream-error",
				"The reconcile refresh failed; continuity stays lost until a later refresh succeeds.",
				{ cause: error },
			);
}

/**
 * Identifies one continuity notice. A status that only
 * changes the connection repeats the key. The reconnect outcome after an
 * early notice shares its state and reason but has a fresh `since`, so it is
 * reported again. A repeated `gap` with the same reason (the missed-count
 * update of a stopped subscription, or another drop of the same kind) stays
 * coalesced until the application reconciles.
 */
function noticeKey(continuity: Continuity): string {
	if (continuity.state === "continuous") return "continuous";
	const kind = `${continuity.state}:${continuity.reason ?? ""}`;
	return continuity.state === "gap" ? kind : `${kind}:${continuity.since}`;
}
