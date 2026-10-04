import type { Dispatch, SetStateAction } from "react";
import { describe, expectTypeOf, it } from "vitest";
import * as react from "../../../src/bindings/react/index.ts";
import * as solid from "../../../src/bindings/solid/index.ts";
import * as svelte from "../../../src/bindings/svelte/index.ts";
import * as vue from "../../../src/bindings/vue/index.ts";
import type {
	EventMeta,
	Feed,
	SpinetabClient,
	SubscriptionRequest,
} from "../../../src/core/types.ts";
import { swrSubscription } from "../../../src/integrations/swr/index.ts";
import { bindQuery } from "../../../src/integrations/tanstack-query/index.ts";
import { graphqlSse } from "../../../src/protocols/graphql-sse/index.ts";
import { graphqlWs } from "../../../src/protocols/graphql-ws/index.ts";
import { socketIo } from "../../../src/protocols/socket-io/index.ts";
import { polling } from "../../../src/transports/polling/index.ts";

/**
 * type level only; `tsc` over the tests enforces it. Every binding
 * takes the payload type from a feed, accepts a function observer (a React
 * state setter included) and rejects a source whose `.subscription` needs an
 * argument: a stand-in and the real GraphQL and Socket.IO endpoints. The
 * functions below are never called, so the builders never run.
 */

type Queue = { open: number };
const queueFeed = {} as Feed<Queue>;
/** Shaped like a GraphQL or Socket.IO endpoint: its selection is not total. */
const endpoint = {} as {
	readonly connection: { url: string };
	subscription(selection: { query: string }): SubscriptionRequest<Queue>;
};

describe("sources and function observers in the bindings", () => {
	it("React infers the payload from a feed and accepts a state setter", () => {
		const withSetter = (
			client: SpinetabClient,
			setQueue: Dispatch<SetStateAction<Queue | undefined>>,
		) => react.useSubscription(client, queueFeed, setQueue);
		expectTypeOf<ReturnType<typeof withSetter>>().toEqualTypeOf<
			react.UseSubscriptionResult<Queue>
		>();
		const withCallback = (client: SpinetabClient) =>
			react.useSubscription(client, queueFeed, (event, meta) => {
				expectTypeOf(event).toEqualTypeOf<Queue>();
				expectTypeOf(meta).toEqualTypeOf<EventMeta>();
			});
		expectTypeOf(withCallback).toBeFunction();
		const rejected = (client: SpinetabClient) =>
			// @ts-expect-error: an endpoint needs a selection before it is a source.
			react.useSubscription(client, endpoint, () => {});
		expectTypeOf(rejected).toBeFunction();
	});

	it("Vue, Svelte and Solid infer the payload from a feed", () => {
		const fromVue = (client: SpinetabClient) =>
			vue.useSubscription(
				client,
				() => queueFeed,
				() => {},
			);
		expectTypeOf<ReturnType<typeof fromVue>>().toEqualTypeOf<
			vue.UseSubscriptionResult<Queue>
		>();
		const fromSvelte = (client: SpinetabClient) =>
			svelte.subscriptionStore(client, queueFeed, () => {});
		expectTypeOf<ReturnType<typeof fromSvelte>>().toEqualTypeOf<
			svelte.SubscriptionStore<Queue>
		>();
		const fromSolid = (client: SpinetabClient) =>
			solid.createSubscription(
				client,
				() => queueFeed,
				() => {},
			);
		expectTypeOf<ReturnType<typeof fromSolid>>().toEqualTypeOf<
			solid.SubscriptionResource<Queue>
		>();
	});

	it("bindQuery infers the payload from a feed", () => {
		const bound = (
			client: SpinetabClient,
			queryClient: Parameters<typeof bindQuery>[2]["queryClient"],
		) =>
			bindQuery(client, queueFeed, {
				queryClient,
				onEvent: (event) => {
					expectTypeOf(event).toEqualTypeOf<Queue>();
				},
			});
		expectTypeOf(bound).toBeFunction();
	});
});

describe("real builders in the bindings", () => {
	it("React infers the payload from polling<Queue>(url) with a state setter", () => {
		const headline = (
			client: SpinetabClient,
			setQueue: Dispatch<SetStateAction<Queue | undefined>>,
		) => react.useSubscription(client, polling<Queue>("/api/queue"), setQueue);
		expectTypeOf<ReturnType<typeof headline>>().toEqualTypeOf<
			react.UseSubscriptionResult<Queue>
		>();
		const fromOthers = (client: SpinetabClient) => {
			const queue = polling<Queue>("/api/queue");
			return [
				vue.useSubscription(
					client,
					() => queue,
					() => {},
				),
				svelte.subscriptionStore(client, queue, () => {}),
				solid.createSubscription(
					client,
					() => queue,
					() => {},
				),
			] as const;
		};
		expectTypeOf<ReturnType<typeof fromOthers>>().toEqualTypeOf<
			readonly [
				vue.UseSubscriptionResult<Queue>,
				svelte.SubscriptionStore<Queue>,
				solid.SubscriptionResource<Queue>,
			]
		>();
	});

	it("a GraphQL or Socket.IO endpoint is not a source on any surface", () => {
		const rejected = (
			client: SpinetabClient,
			queryClient: Parameters<typeof bindQuery>[2]["queryClient"],
		) => {
			const chat = socketIo("/chat", { sharing: "shared" });
			const gws = graphqlWs("/graphql");
			const gsse = graphqlSse("/graphql/stream");
			// @ts-expect-error: a Socket.IO endpoint needs a selection first.
			react.useSubscription(client, chat, () => {});
			// @ts-expect-error: a graphql-ws endpoint needs an operation first.
			react.useSubscription(client, gws, () => {});
			// @ts-expect-error: a graphql-sse endpoint needs an operation first.
			react.useSubscription(client, gsse, () => {});
			vue.useSubscription(
				client,
				// @ts-expect-error: the Vue getter returns an endpoint.
				() => chat,
				() => {},
			);
			// @ts-expect-error: the Svelte store is given an endpoint.
			svelte.subscriptionStore(client, gws, () => {});
			solid.createSubscription(
				client,
				// @ts-expect-error: the Solid accessor returns an endpoint.
				() => gsse,
				() => {},
			);
			// @ts-expect-error: bindQuery is given an endpoint.
			bindQuery(client, chat, { queryClient, onEvent() {} });
			// @ts-expect-error: requestFor returns an endpoint.
			swrSubscription(client, (_key: string) => gws);
			// @ts-expect-error: the client is given an endpoint.
			client.subscribe(gsse, () => {});
		};
		expectTypeOf(rejected).toBeFunction();
	});
});
