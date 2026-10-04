import { recoveryPending } from "./continuity-phase.ts";
import { handleReporter } from "./errors.ts";
import type { Continuity, Subscription, SubscriptionStatus } from "./types.ts";

export interface ReconcileContext {
	continuity: Continuity;
	status: SubscriptionStatus;
	/** Aborted when superseded, disconnected or disposed. Guard application writes. */
	signal: AbortSignal;
}

export interface ReconcileOptions {
	/**
	 * A failed refresh; default: the client's error reporting path (`onCallbackError`,
	 * else `reportError`).
	 */
	onError?: (error: unknown) => void;
}

const lost = (continuity: Continuity) =>
	continuity.state === "gap" || continuity.state === "unknown";

// A refresh cannot repair a payload that the runtime cannot deliver. Keep
// the gap visible until the application corrects it; never restart it in a loop.
const recoverable = (continuity: Continuity) =>
	lost(continuity) &&
	continuity.reason !== "message-too-large" &&
	continuity.reason !== "event-not-serialisable";

/**
 * Call `onNotice` once per loss notice. A notice is a new continuity object:
 * the client creates one for each notice it accepts and keeps it across other
 * status changes. So the outcome notice after a reconnect counts again even
 * when it repeats the early notice's state and reason, and so does a second
 * notice within the same millisecond (same `since`). `listener` also sees
 * every other status change.
 */
function watch(
	subscription: Subscription<unknown>,
	onNotice: (continuity: Continuity) => void,
	listener: (status: SubscriptionStatus) => void = () => {},
): () => void {
	let seen: Continuity | undefined;
	const onStatus = (status: SubscriptionStatus) => {
		const { continuity } = status;
		if (lost(continuity) && continuity !== seen) {
			seen = continuity;
			onNotice(continuity);
		}
		listener(status);
	};
	const unsubscribe = subscription.status.subscribe(onStatus);
	onStatus(subscription.status.get());
	return unsubscribe;
}

function report(
	subscription: object,
	error: unknown,
	onError?: (error: unknown) => void,
): void {
	if (onError) {
		try {
			onError(error);
			return;
		} catch (inner) {
			error = inner;
		}
	}
	const client = handleReporter(subscription);
	if (client) client(error);
	else if (typeof globalThis.reportError === "function")
		globalThis.reportError(error);
	else
		setTimeout(() => {
			throw error;
		}, 0);
}

/**
 * Reconcile a delta feed with an application refresh whenever continuity is
 * lost. For stopped delivery it restarts delivery first with
 * `markReconciled({ pending: true })`. Events can arrive while refreshing;
 * the application must use its version/watermark rules to merge them safely.
 * It refreshes only while connected, runs once more (coalesced) when
 * a newer notice arrives during a refresh, and declares the subscription
 * reconciled only after a refresh that no newer notice overtook. A failed
 * refresh keeps continuity non-continuous and is retried on the next notice
 * or at the next `connected`, never on a timer. The refresh must resolve only
 * after the application's data has been refreshed and reject or throw when
 * that fails, since the engine trusts its promise; TanStack Query's
 * `invalidateQueries`, SWR's key-only `mutate(key)` and Apollo's
 * `refetchQueries` (under `errorPolicy` `all` or `ignore`) resolve on failure,
 * all three resolve when nothing was refetched, and TanStack's
 * `queryClient.query` (or `fetchQuery`) resolves with the cached data when
 * its fetch is cancelled, so none of them confirms a refresh on its own. No
 * cross-tab coordination: every tab refreshes.
 * Returns `stop`.
 */
export function reconcileOnLoss<E>(
	subscription: Subscription<E>,
	refresh: (context: ReconcileContext) => void | Promise<void>,
	options: ReconcileOptions = {},
): () => void {
	let due = false;
	let running = false;
	let failed = false;
	let connected = false;
	let stopped = false;
	let controller: AbortController | undefined;
	const run = () => {
		const status = subscription.status.get();
		if (
			stopped ||
			running ||
			!due ||
			!recoverable(status.continuity) ||
			recoveryPending(subscription.status) ||
			!status.active ||
			status.connection.state !== "connected"
		) {
			return;
		}
		due = false;
		failed = false;
		running = true;
		const current = new AbortController();
		controller = current;
		let result: void | Promise<void>;
		try {
			result = refresh({
				continuity: status.continuity,
				status,
				signal: current.signal,
			});
		} catch (error) {
			result = Promise.reject(error);
		}
		Promise.resolve(result).then(
			() => {
				running = false;
				if (stopped) return;
				if (due) run();
				else if (
					!current.signal.aborted &&
					recoverable(subscription.status.get().continuity)
				)
					subscription.markReconciled();
			},
			(error: unknown) => {
				running = false;
				if (stopped) return;
				if (current.signal.aborted) {
					run();
					return;
				}
				failed = true;
				report(subscription, error, options.onError);
				run();
			},
		);
	};
	const unsubscribe = watch(
		subscription as Subscription<unknown>,
		(continuity) => {
			controller?.abort();
			if (!recoverable(continuity)) {
				due = false;
				return;
			}
			due = true;
			if (continuity.state === "gap" && continuity.reason === "overflow")
				subscription.markReconciled({ pending: true });
		},
		(status) => {
			const now = status.connection.state === "connected";
			if (running && !lost(status.continuity)) {
				controller?.abort();
				due = false;
			}
			if (!status.active || !now || recoveryPending(subscription.status)) {
				if (running) {
					controller?.abort();
					due = recoverable(status.continuity);
				}
			}
			if (now && !connected && failed) due = true;
			connected = now;
			run();
		},
	);
	return () => {
		stopped = true;
		controller?.abort();
		unsubscribe();
	};
}

/**
 * The `"latest"` policy for full-state feeds, where the next event replaces
 * everything: on a loss notice it restarts delivery with
 * `markReconciled({ pending: true })`, and the next delivered event, reported
 * by the surface through `onEvent()`, declares the subscription reconciled.
 * Never use it on a delta feed: it would present dropped deltas as complete.
 */
export function reconcileLatest<E>(subscription: Subscription<E>): {
	onEvent(): void;
	stop(): void;
} {
	let waiting = false;
	const unsubscribe = watch(subscription as Subscription<unknown>, () => {
		if (!recoverable(subscription.status.get().continuity)) {
			waiting = false;
			return;
		}
		waiting = true;
		subscription.markReconciled({ pending: true });
	});
	return {
		onEvent() {
			if (!waiting || !recoverable(subscription.status.get().continuity))
				return;
			waiting = false;
			if (lost(subscription.status.get().continuity))
				subscription.markReconciled();
		},
		stop() {
			waiting = false;
			unsubscribe();
		},
	};
}
