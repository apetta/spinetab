import { expectTypeOf } from "expect-type";
import { type ClientStatus, createSpinetab } from "spinetab";
import type { GraphqlResult } from "spinetab/graphql-ws";
import {
	bindClient,
	type UseLiveResult,
	useLive,
	useSpinetabStatus,
	useSubscription,
} from "spinetab/vue";
import type { ComputedRef } from "vue";
import type {
	endpoint,
	RoomDocument,
	TicksData,
	TicksDocument,
	ticks,
} from "./shared-config.js";

// Declaration checks against the packed package.
declare const request: typeof ticks;
declare const graphql: typeof endpoint;
declare const roomDocument: typeof RoomDocument;
declare const ticksDocument: typeof TicksDocument;

const client = createSpinetab({});

client.subscribe(request, {
	next(result) {
		expectTypeOf(result).toEqualTypeOf<GraphqlResult<TicksData>>();
		expectTypeOf(result.data).toEqualTypeOf<TicksData | null | undefined>();
	},
});

// Variables are inferred from the typed document.
graphql.subscription({ query: ticksDocument, variables: { intervalMs: 50 } });
graphql.subscription({ query: roomDocument, variables: { room: "a" } });
// @ts-expect-error: `intervalMs` is a number.
graphql.subscription({ query: ticksDocument, variables: { intervalMs: "50" } });
// @ts-expect-error: `room` is required by the document.
graphql.subscription({ query: roomDocument });

export function useChecks(): ComputedRef<ClientStatus> {
	const subscription = useSubscription(client, () => request, {
		next(result) {
			expectTypeOf(result.data?.ticks.n).toEqualTypeOf<number | undefined>();
		},
	});
	expectTypeOf(subscription.markReconciled).toBeFunction();
	return useSpinetabStatus(client).status;
}

// `bindClient` and the value composable.
const bound = bindClient(client);
export function useBound(): ComputedRef<boolean> {
	bound.useSubscription(
		() => request,
		(result) => {
			expectTypeOf(result).toEqualTypeOf<GraphqlResult<TicksData>>();
		},
	);
	expectTypeOf(bound.useSpinetabStatus().status).toEqualTypeOf<
		ComputedRef<ClientStatus>
	>();
	const live = bound.useLive(() => request, {
		map: (result) => result.data?.ticks.n ?? 0,
	});
	expectTypeOf(live).toEqualTypeOf<
		UseLiveResult<GraphqlResult<TicksData>, number>
	>();
	expectTypeOf(live.data.value).toEqualTypeOf<number | undefined>();
	const unbound = useLive(client, () => request);
	expectTypeOf(unbound.data.value).toEqualTypeOf<
		GraphqlResult<TicksData> | undefined
	>();
	return live.needsReconcile;
}
