import { expectTypeOf } from "expect-type";
import {
	type ConsumerOptions,
	createSpinetab,
	type EventMeta,
	reconcileOnLoss,
	type StatusPhase,
	type Subscription,
	summariseStatus,
} from "spinetab";
import {
	type PollingConsumerOptions,
	pollEvery,
	polling,
} from "spinetab/polling";
import type { PolledValue, value } from "./shared-config.js";

// Declaration checks against the packed package.
declare const request: typeof value;

const client = createSpinetab({ sharing: "prefer" });
const subscription = client.subscribe(
	request,
	{
		next(event) {
			expectTypeOf(event).toEqualTypeOf<PolledValue>();
		},
	},
	pollEvery(1_000, { whileHidden: false }),
);
expectTypeOf(subscription).toEqualTypeOf<Subscription<PolledValue>>();
expectTypeOf(pollEvery(1_000)).toEqualTypeOf<ConsumerOptions>();

export const slower: PollingConsumerOptions = {
	intervalMs: 2_000,
	onJoin: "await",
};
// an optional property read from `PollingConsumerOptions` carries
// `number | undefined`, which `ConsumerJson` accepts (the page strips it).
subscription.update({ intervalMs: slower.intervalMs, onJoin: "await" });

export const invalid: PollingConsumerOptions = {
	intervalMs: 1_000,
	// @ts-expect-error: `onJoin` accepts only "read" or "await".
	onJoin: "later",
};

// The one-file recipe: the worker module is the lazy local runtime.
export const shared = createSpinetab({
	worker: () =>
		new SharedWorker(new URL("./worker.ts", import.meta.url), {
			type: "module",
		}),
	local: () => import("./worker.js"),
});

// The one-line form: a URL-first feed and a callback.
const quick = shared.subscribe(
	polling<PolledValue>("fx/poll/value"),
	(polled, meta) => {
		expectTypeOf(polled).toEqualTypeOf<PolledValue>();
		expectTypeOf(meta).toEqualTypeOf<EventMeta>();
	},
);
expectTypeOf(quick).toEqualTypeOf<Subscription<PolledValue>>();

// Per-handle retry, the reconcile split and engine.
quick.retry();
quick.markReconciled({ pending: true });
quick.markReconciled();
const stop = reconcileOnLoss(quick, async ({ continuity, status }) => {
	expectTypeOf(continuity.state).toBeString();
	expectTypeOf(status.connection.state).toBeString();
});
expectTypeOf(stop).toEqualTypeOf<() => void>();
const summary = summariseStatus(quick.status.get());
expectTypeOf(summary.phase).toEqualTypeOf<StatusPhase>();
expectTypeOf(summary.needsReconcile).toBeBoolean();

// Credentials declared once: a page that supplies none says so.
export const anonymous = createSpinetab({ anonymous: true });
