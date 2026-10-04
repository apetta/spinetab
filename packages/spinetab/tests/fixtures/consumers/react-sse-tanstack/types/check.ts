import { QueryClient } from "@tanstack/query-core";
import { expectTypeOf } from "expect-type";
import {
	type ClientStatus,
	createSpinetab,
	type EventMeta,
	isSpinetabError,
	SERVER_STATUS,
	type SpinetabClient,
	type Subscription,
	type SubscriptionStatus,
} from "spinetab";
import {
	bindClient,
	type UseSubscriptionResult,
	useSpinetabStatus,
	useSubscription,
} from "spinetab/react";
import { sse } from "spinetab/sse";
import { stream } from "spinetab/stream";
import { bindQuery } from "spinetab/tanstack-query";
import type { Line, lines, Tick, ticks } from "./shared-config.js";

// Declaration checks against the packed package.
declare const tickRequest: typeof ticks;
declare const lineRequest: typeof lines;

const client: SpinetabClient = createSpinetab({ sharing: "prefer" });
expectTypeOf(client.status.get()).toEqualTypeOf<ClientStatus>();
expectTypeOf(SERVER_STATUS).toEqualTypeOf<ClientStatus>();

// SSE events are their decoded data; the envelope's fields are in `meta`.
client.subscribe(tickRequest, {
	next(event, meta) {
		expectTypeOf(event).toEqualTypeOf<Tick>();
		expectTypeOf(event.n).toBeNumber();
		expectTypeOf(meta).toEqualTypeOf<EventMeta>();
		expectTypeOf(meta.eventId).toEqualTypeOf<string | undefined>();
		expectTypeOf(meta.event).toEqualTypeOf<string | undefined>();
	},
	status(status) {
		expectTypeOf(status).toEqualTypeOf<SubscriptionStatus>();
	},
});
client.subscribe(lineRequest, {
	next(event) {
		expectTypeOf(event).toEqualTypeOf<Line>();
	},
});

// The one-line form with URL-first feeds: JSON is the
// SSE default, `decoder: "text"` the lever, NDJSON the stream default.
const quick = client.subscribe(sse<Tick>("fx/sse/ticks"), (tick, meta) => {
	expectTypeOf(tick).toEqualTypeOf<Tick>();
	expectTypeOf(meta.eventId).toEqualTypeOf<string | undefined>();
});
expectTypeOf(quick).toEqualTypeOf<Subscription<Tick>>();
client.subscribe(sse("fx/sse/ticks", { decoder: "text" }), (text) => {
	expectTypeOf(text).toEqualTypeOf<string>();
});
client.subscribe(
	stream<Line>("fx/stream/ndjson", { repeatable: true }),
	(line) => {
		expectTypeOf(line).toEqualTypeOf<Line>();
	},
);

bindQuery(client, tickRequest, {
	queryClient: new QueryClient(),
	onEvent(event, tools) {
		expectTypeOf(event).toEqualTypeOf<Tick>();
		tools.setQueryData(["latest-tick"], event.n);
	},
});

// The cache writer form: `map` projects each event into `queryKey`,
// and a full-state feed reconciles on its next event.
bindQuery(client, sse<Tick>("fx/sse/ticks"), {
	queryClient: new QueryClient(),
	queryKey: ["latest-tick"],
	map: (tick, meta) => {
		expectTypeOf(meta).toEqualTypeOf<EventMeta>();
		return tick.n;
	},
	reconcile: "latest",
});
bindQuery(client, tickRequest, {
	queryClient: new QueryClient(),
	queryKey: ["ticks"],
	reduce: (current: number[] | undefined, tick) => [...(current ?? []), tick.n],
	reconcile: "invalidate",
});
bindQuery(client, tickRequest, {
	queryClient: new QueryClient(),
	queryKey: ["latest-tick"],
	// The application's refresh; its settling declares the loss reconciled.
	reconcile: async (context) => {
		expectTypeOf(context.status).toEqualTypeOf<SubscriptionStatus>();
	},
});
bindQuery(client, tickRequest, {
	queryClient: new QueryClient(),
	queryKey: ["latest-tick"],
	// @ts-expect-error: reconcile is a named policy, { queryKey } or a function.
	reconcile: "refetch",
});

export function Hooks(): string {
	const status = useSpinetabStatus(client);
	const result = useSubscription(client, tickRequest, {
		next(event) {
			expectTypeOf(event).toEqualTypeOf<Tick>();
		},
	});
	expectTypeOf(result).toEqualTypeOf<UseSubscriptionResult<Tick>>();
	return status.mode;
}

// `bindClient`: the client applied once, no provider.
const bound = bindClient(client);
export function BoundHooks(): string {
	const status = bound.useSpinetabStatus();
	const result = bound.useSubscription(sse<Tick>("fx/sse/ticks"), (tick) => {
		expectTypeOf(tick).toEqualTypeOf<Tick>();
	});
	expectTypeOf(result).toEqualTypeOf<UseSubscriptionResult<Tick>>();
	// Value-returning hook: a per-mount value beside honest status.
	const live = bound.useLive(sse<Tick>("fx/sse/ticks"));
	expectTypeOf(live.data).toEqualTypeOf<Tick | undefined>();
	expectTypeOf(live.needsReconcile).toBeBoolean();
	expectTypeOf(live.status).toEqualTypeOf<SubscriptionStatus>();
	expectTypeOf(live.subscription).toEqualTypeOf<Subscription<Tick> | null>();
	const count = bound.useLive(sse<Tick>("fx/sse/ticks"), {
		initial: 0,
		map: (tick) => tick.n,
	});
	expectTypeOf(count.data).toEqualTypeOf<number | undefined>();
	live.retry();
	live.markReconciled();
	return status.mode;
}

export function isTimeout(error: unknown): boolean {
	return isSpinetabError(error, "timeout");
}

// @ts-expect-error: the payload is typed, not `any`.
export const wrong: string = null as unknown as Tick;
