import type { Query, QueryClient, QueryKey } from "@tanstack/query-core";
import { deserialiseError, SpinetabError } from "../../core/errors.ts";
import {
	type ReconcileContext,
	reconcileLatest,
	reconcileOnLoss,
} from "../../core/reconcile.ts";
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

/**
 * Cache tools bound to the application's `QueryClient`, plus the recovery
 * controls of this binding's subscription. The cache methods are the only way
 * this helper touches the cache when an application callback calls them;
 * `queryKey` with `map` or `reduce`, and a configured `reconcile`, are the
 * application's declared writes and refreshes.
 */
export interface QueryTools {
	setQueryData: QueryClient["setQueryData"];
	setQueriesData: QueryClient["setQueriesData"];
	invalidateQueries: QueryClient["invalidateQueries"];
	getQueryData: QueryClient["getQueryData"];
	/** `subscription.markReconciled(options?)` of this binding. */
	markReconciled(options?: { pending?: boolean }): void;
	/** `subscription.retry()`: an explicit retry of this binding's connection only. */
	retry(): void;
}

/**
 * How a continuity loss is reconciled, opt-in:
 * - `"invalidate"`: `invalidateQueries({ queryKey })` with TanStack's own
 * scheduling (active queries refetch). Reconciled only when every query
 * matching `queryKey` refetched successfully during the refresh; a refetch
 * already running over cached data is restarted (`cancelRefetch`) and
 * counts. Otherwise the loss stays visible, `onError` is called once and
 * the refresh runs again at the next notice or `connected`: a failed
 * refetch; an inactive, disabled, static, paused or cache-only query; no
 * match; an initial fetch without data already running at the notice
 * (joined, not refetched); a refetch the application cancels. The entries
 * stay invalidated until they refetch or are written;
 * - `{ queryKey }`: the same for that key or prefix; for a prefix with
 * inactive entries, name a precise key or pass a refresh function;
 * - `"latest"`: a full-state feed; the next event is the reconciled value;
 * - a function: the application's refresh, run by `reconcileOnLoss`. Cancel
 * the key's TanStack fetch first, then resolve only after your own fetch
 * wrote fresh data, and reject or throw on failure:
 *
 * ```ts
 * reconcile: async () => {
 * await queryClient.cancelQueries({ queryKey: ["tick"], exact: true });
 * queryClient.setQueryData(["tick"], await fetchTick());
 * },
 * ```
 *
 * TanStack writes every fetch it did not cancel, so without the cancel a
 * component's fetch begun before the notice could land after your write
 * and replace it; a cancelled initial fetch leaves its component pending
 * until your write lands. `invalidateQueries` resolves on failure, and
 * `queryClient.query` (or `fetchQuery`) alone is not a success signal: it
 * can join a fetch begun before the notice, and resolves with the cached
 * data when TanStack cancels its fetch. The engine coalesces notices and
 * never declares an overtaken run, so no run token is needed here.
 */
export type QueryReconcile =
	| "invalidate"
	| { queryKey: QueryKey }
	| "latest"
	| ((context: ReconcileContext) => void | Promise<void>);

export interface BindQueryOptions<E, T = E> {
	/** The application's own `QueryClient`; never created or configured here. */
	queryClient: QueryClient;
	/**
	 * Declared write target: each event is written to this key with
	 * `setQueryData`, as `map(event, meta)` (default: the event) or as
	 * `reduce(current, event, meta)`; a `reduce` that returns `undefined`
	 * leaves the entry unchanged.
	 */
	queryKey?: QueryKey;
	map?(event: E, meta: EventMeta): T;
	reduce?(current: T | undefined, event: E, meta: EventMeta): T | undefined;
	/** Each event, in order, with its metadata (the custom recipe). */
	onEvent?(event: E, tools: QueryTools, meta: EventMeta): void;
	/** Opt-in reconciliation (see `QueryReconcile`). Without it, and without `onContinuity`, `gap` and `unknown` reach `onError` as `continuity-lost`. */
	reconcile?: QueryReconcile;
	/**
	 * Each continuity notice away from `continuous` (`gap`, `unknown`,
	 * `resumed`); a repeated `gap` with the same reason is reported once until
	 * reconciled. An interruption can report the same state and reason twice:
	 * early at detection, then as the outcome just before `connected`.
	 * Reconcile on each; the second covers events sent during the outage, so
	 * only the newest run may write and call `tools.markReconciled()`. The
	 * custom recipe keeps one run token per binding:
	 *
	 * ```ts
	 * let latest = 0;
	 * bindQuery(spinetab, ticks, {
	 * queryClient,
	 * onEvent: (tick, tools) => tools.setQueryData(["tick"], tick.n),
	 * onContinuity: async (_continuity, tools) => {
	 * const run = ++latest;
	 * tools.markReconciled({ pending: true });
	 * try {
	 * // A fetch begun before the notice would otherwise overwrite yours.
	 * await queryClient.cancelQueries({ queryKey: ["tick"], exact: true });
	 * const data = await fetchTick(); // rejects on failure
	 * if (run === latest) {
	 * queryClient.setQueryData(["tick"], data);
	 * tools.markReconciled();
	 * }
	 * } catch {
	 * // The loss stays visible; the next notice runs this again.
	 * }
	 * },
	 * });
	 * ```
	 *
	 * Fetch the data yourself: `queryClient.query` and `fetchQuery` can join a
	 * fetch begun before the notice, and resolve with the cached data when
	 * TanStack cancels their fetch. `cancelQueries` cannot cancel your own
	 * fetch; it stops a component's TanStack fetch begun before the notice
	 * from landing after your write (TanStack writes every fetch it did not
	 * cancel), and a cancelled initial fetch stays pending until your write.
	 */
	onContinuity?(continuity: Continuity, tools: QueryTools): void;
	/**
	 * Terminal outcomes (a `failed` connection or a subscription error), an
	 * unreconciled loss without a policy (`continuity-lost`, once per notice)
	 * and a failed `reconcile` refresh. Without it they are rethrown into the
	 * client's callback guard: `onCallbackError`, else `reportError`.
	 */
	onError?(error: SpinetabError, tools: QueryTools): void;
	/** Every status change, including resumable states. */
	onStatus?(status: SubscriptionStatus, tools: QueryTools): void;
	/** Adapter-defined per-consumer options, for example `...pollEvery(30_000)`. */
	consumer?: ConsumerJson;
	resume?: ConsumerOptions["resume"];
}

export interface QueryBinding<E> {
	readonly subscription: Subscription<E>;
	/**
	 * Idempotent. Never touches the cache: it stops the binding's own
	 * QueryCache listener at once and leaves the application's queries and
	 * refetches running; a pending refresh declares nothing.
	 */
	unsubscribe(): void;
}

/**
 * Route one Spinetab subscription into TanStack Query cache updates. The
 * subscription stays open through `reconnecting`, `retry-exhausted` and
 * `auth-blocked` (reported through `onStatus`); only a `failed` connection,
 * an operation error or continuity loss is surfaced as a terminal or recovery
 * signal. Focus and online managers, defaults and query scheduling are
 * never touched, and sharing a feed does not deduplicate refetches:
 * invalidating in five tabs may cause five fetches. `source` is a request or
 * a feed.
 */
export function bindQuery<E, T = E>(
	client: SpinetabClient,
	source: Source<E>,
	options: BindQueryOptions<NoInfer<E>, T>,
): QueryBinding<E> {
	const { queryClient, queryKey, map, reduce, reconcile } = options;
	if (!queryClient || typeof queryClient.setQueryData !== "function") {
		throw unsupported(
			"options.queryClient",
			"bindQuery needs the application's QueryClient.",
		);
	}
	if (map && reduce) {
		throw unsupported(
			"options.reduce",
			"bindQuery takes map or reduce, not both.",
		);
	}
	if ((map || reduce) && queryKey === undefined) {
		throw unsupported(
			map ? "options.map" : "options.reduce",
			"bindQuery map and reduce need options.queryKey, the key they write.",
		);
	}
	if (queryKey === undefined && typeof options.onEvent !== "function") {
		throw unsupported(
			"options.onEvent",
			"bindQuery needs options.onEvent, or options.queryKey to write events to.",
		);
	}
	if (!isQueryReconcile(reconcile)) {
		throw unsupported(
			"options.reconcile",
			'bindQuery reconcile must be "invalidate", { queryKey }, "latest" or a refresh function.',
		);
	}
	if (reconcile === "invalidate" && queryKey === undefined) {
		throw unsupported(
			"options.reconcile",
			'bindQuery reconcile "invalidate" needs options.queryKey; pass { queryKey } to name another key.',
		);
	}
	const request = toRequest(source, "source");
	const bind = <K extends keyof QueryClient>(name: K): QueryClient[K] => {
		const method = queryClient[name] as (...args: unknown[]) => unknown;
		return ((...args: unknown[]) =>
			method.apply(queryClient, args)) as QueryClient[K];
	};
	let subscription: Subscription<E> | undefined;
	let active = true;
	const tools: QueryTools = {
		setQueryData: bind("setQueryData"),
		setQueriesData: bind("setQueriesData"),
		invalidateQueries: bind("invalidateQueries"),
		getQueryData: bind("getQueryData"),
		markReconciled(markOptions) {
			if (active) subscription?.markReconciled(markOptions);
		},
		retry() {
			if (active) subscription?.retry();
		},
	};
	// Without onError the error goes to the client's callback guard, whose
	// report carries a code and one fixed sentence only. A core error is
	// rethrown as the same object (core then reports it itself); this
	// binding's own signals are thrown detail-free.
	const fail = (error: SpinetabError, report: () => unknown) => {
		if (!options.onError) throw report();
		options.onError(error, tools);
	};
	const loud = reconcile === undefined && !options.onContinuity;
	const signals = createSignalTracker();
	let latest: { onEvent(): void; stop(): void } | undefined;
	subscription = client.subscribe<E>(
		request,
		{
			next(event, meta) {
				if (!active) return;
				if (queryKey !== undefined) {
					if (reduce) {
						queryClient.setQueryData<T>(queryKey, (current) =>
							reduce(current, event, meta),
						);
					} else {
						queryClient.setQueryData(
							queryKey,
							map ? map(event, meta) : (event as unknown as T),
						);
					}
				}
				options.onEvent?.(event, tools, meta);
				latest?.onEvent();
			},
			error(error) {
				if (active) fail(deserialiseError(error), () => error);
			},
			status(status) {
				if (!active) return;
				options.onStatus?.(status, tools);
				const signal = signals.update(status);
				if (signal.continuity) options.onContinuity?.(status.continuity, tools);
				if (signal.failed) {
					fail(signal.failed, () => fixedReport("upstream-error", FAILED));
				}
				const { continuity } = status;
				if (
					signal.continuity &&
					loud &&
					(continuity.state === "gap" || continuity.state === "unknown")
				) {
					fail(continuityLost(continuity), () =>
						fixedReport("continuity-lost", LOST),
					);
				}
			},
		},
		{
			...(options.consumer === undefined ? {} : { consumer: options.consumer }),
			...(options.resume === undefined ? {} : { resume: options.resume }),
		},
	);
	let stopEngine: (() => void) | undefined;
	// The QueryCache listener of a confirming refresh still waiting on
	// its refetch, which unsubscribe() stops at once.
	const listening = new Set<() => void>();
	if (reconcile === "latest") {
		latest = reconcileLatest(subscription);
		stopEngine = latest.stop;
	} else if (reconcile !== undefined) {
		const own = typeof reconcile !== "function";
		// `queryKey` is required for "invalidate" (checked above).
		const target = (
			typeof reconcile === "object" ? reconcile.queryKey : queryKey
		) as QueryKey;
		const refresh = own
			? confirmedRefresh(queryClient, target, listening)
			: reconcile;
		// Without onError, a failure of the binding's own refresh reaches
		// the guard as a code and a fixed sentence (the engine hands what its
		// onError throws to the handle's guard); an application refresh's error
		// goes there as it is.
		let onError: ((error: unknown) => void) | undefined;
		if (options.onError) {
			onError = (error) => options.onError?.(asSpinetabError(error), tools);
		} else if (own) {
			onError = () => {
				throw fixedReport("upstream-error", REFRESH);
			};
		}
		stopEngine = reconcileOnLoss(
			subscription,
			refresh,
			onError ? { onError } : undefined,
		);
	}
	const live = subscription;
	return {
		subscription: live,
		unsubscribe() {
			if (!active) return;
			active = false;
			// Release the refresh's cache observation now, not when the
			// application's fetch settles; that fetch keeps running, and the
			// stopped engine discards the refresh's outcome.
			for (const stop of listening) stop();
			listening.clear();
			stopEngine?.();
			live.unsubscribe();
		},
	};
}

/** The guard's fixed sentences for this binding's own signals. */
const FAILED =
	"the subscription's connection failed; pass onError or watch onStatus.";
const LOST =
	"continuity was lost; set reconcile, or reconcile in onContinuity and call tools.markReconciled().";
const REFRESH =
	"the reconcile refresh failed; continuity stays lost until a later refresh succeeds; pass onError to receive the cause.";

/** Why the confirming refresh rejected: plain errors, wrapped by `asSpinetabError`. */
const NO_MATCH = "No query matched the reconcile queryKey.";
const REFETCH_FAILED = "A matching query's refetch failed.";
const NOT_REFETCHED =
	"A matching query was not refetched: it is inactive, disabled, static, paused or cache-only, its refetch was cancelled, or its initial fetch without data was already running at the notice and was joined.";

/**
 * The refresh behind `"invalidate"` and `{ queryKey }`. It keeps
 * TanStack's scheduling, a plain `invalidateQueries({ queryKey })` (active
 * queries refetch; no `throwOnError`, so a paused fetch that fails later is
 * never an unhandled rejection), and only observes the QueryCache for the
 * duration of the call. It resolves when every query that matched at the
 * start dispatched a `fetch` and then a non-manual `success`; it rejects when
 * one of them failed or did not refetch, or when nothing matched. While the
 * call waits, its listener is in `listening`, so the binding's `unsubscribe()`
 * can stop it without touching the application's query or refetch.
 */
function confirmedRefresh(
	queryClient: QueryClient,
	queryKey: QueryKey,
	listening: Set<() => void>,
): () => Promise<void> {
	return async () => {
		const cache = queryClient.getQueryCache();
		const progress = new Map<Query, "matched" | "fetching" | "refetched">();
		for (const query of cache.findAll({ queryKey })) {
			progress.set(query, "matched");
		}
		let failure: { error: unknown } | undefined;
		const stop = cache.subscribe((event) => {
			if (event.type !== "updated") return;
			const state = progress.get(event.query);
			if (state === undefined) return;
			const { action } = event;
			if (action.type === "fetch" && state === "matched") {
				progress.set(event.query, "fetching");
			} else if (
				action.type === "success" &&
				!action.manual &&
				state === "fetching"
			) {
				progress.set(event.query, "refetched");
			} else if (action.type === "error") {
				failure ??= { error: action.error };
			}
		});
		listening.add(stop);
		try {
			await queryClient.invalidateQueries({ queryKey });
		} finally {
			// Not in the set once unsubscribe() stopped it: stop exactly once.
			if (listening.delete(stop)) stop();
		}
		if (failure) throw new Error(REFETCH_FAILED, { cause: failure.error });
		if (progress.size === 0) throw new Error(NO_MATCH);
		for (const state of progress.values()) {
			if (state !== "refetched") throw new Error(NOT_REFETCHED);
		}
	};
}

function fixedReport(
	code: "upstream-error" | "continuity-lost",
	sentence: string,
): SpinetabError {
	return new SpinetabError(code, `${code}: ${sentence}`);
}

/** A supported `reconcile`; `{ queryKey }` must name a key (an array). */
function isQueryReconcile(value: unknown): value is QueryReconcile | undefined {
	if (
		value === undefined ||
		value === "invalidate" ||
		value === "latest" ||
		typeof value === "function"
	) {
		return true;
	}
	return (
		typeof value === "object" &&
		value !== null &&
		Array.isArray((value as { queryKey?: unknown }).queryKey)
	);
}

function unsupported(path: string, message: string): SpinetabError {
	return new SpinetabError("unsupported-option", message, {
		detail: { path },
	});
}

function continuityLost(continuity: Continuity): SpinetabError {
	return new SpinetabError(
		"continuity-lost",
		`Continuity was lost (${continuity.state}${continuity.reason ? `, ${continuity.reason}` : ""}); set reconcile, or reconcile in onContinuity and call tools.markReconciled().`,
		{
			detail: {
				state: continuity.state,
				...(continuity.reason ? { reason: continuity.reason } : {}),
			},
		},
	);
}

function asSpinetabError(error: unknown): SpinetabError {
	return error instanceof SpinetabError
		? error
		: new SpinetabError(
				"upstream-error",
				"The reconcile refresh failed; continuity stays lost until a later refresh succeeds.",
				{ cause: error },
			);
}

/**
 * Deduplicates recovery signals: continuity is reported once per notice (see
 * `noticeKey`), and `failed` once per failure episode.
 */
function createSignalTracker() {
	let continuityKey = "continuous";
	let failed = false;
	return {
		update(status: SubscriptionStatus): {
			continuity: boolean;
			failed?: SpinetabError;
		} {
			const { continuity, connection } = status;
			const key = noticeKey(continuity);
			const continuityChanged = key !== continuityKey && key !== "continuous";
			continuityKey = key;
			let failure: SpinetabError | undefined;
			if (connection.state === "failed" && !failed) {
				failed = true;
				failure = new SpinetabError(
					"upstream-error",
					`The subscription's connection failed${connection.reason ? ` (${connection.reason})` : ""}.`,
					{
						detail: {
							state: "failed",
							...(connection.reason ? { reason: connection.reason } : {}),
						},
					},
				);
			} else if (connection.state !== "failed") {
				failed = false;
			}
			return {
				continuity: continuityChanged,
				...(failure ? { failed: failure } : {}),
			};
		},
	};
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
