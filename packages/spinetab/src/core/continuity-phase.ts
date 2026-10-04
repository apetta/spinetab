import type { SubscriptionSink } from "./adapter.ts";
import type { ContinuityReason } from "./types.ts";

const interruptions = new WeakSet<object>();
// A client and its integration can come from separate ESM/CommonJS module
// copies. Keep their phase on the shared store, with a non-enumerable key, so
// both see it without a global registry retaining clients or subscriptions.
const recoveryKey = Symbol.for("spinetab.recoveryPending.v1");

export function setRecoveryPending(store: object, pending: boolean): void {
	if (pending) {
		Object.defineProperty(store, recoveryKey, {
			value: true,
			configurable: true,
		});
	} else {
		Reflect.deleteProperty(store, recoveryKey);
	}
}

export function recoveryPending(store: object): boolean {
	return (store as { [recoveryKey]?: unknown })[recoveryKey] === true;
}

/** Mark a built-in adapter's early loss notice, before its reconnecting status. */
export function reportInterruption(
	sink: SubscriptionSink,
	reason: ContinuityReason,
): void {
	interruptions.add(sink);
	try {
		sink.continuity(reason);
	} finally {
		interruptions.delete(sink);
	}
}

export function isInterruption(sink: SubscriptionSink): boolean {
	return interruptions.has(sink);
}
