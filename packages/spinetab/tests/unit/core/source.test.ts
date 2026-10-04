import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { isSpinetabError } from "../../../src/core/errors.ts";
import { toObserver, toRequest } from "../../../src/core/source.ts";
import type {
	EventMeta,
	Feed,
	Observer,
	Source,
	Subscription,
	SubscriptionObserver,
	SubscriptionRequest,
} from "../../../src/core/types.ts";
import { unsupported } from "../../../src/core/validate.ts";
import { graphqlSse } from "../../../src/protocols/graphql-sse/index.ts";
import { graphqlWs } from "../../../src/protocols/graphql-ws/index.ts";
import { socketIo } from "../../../src/protocols/socket-io/index.ts";
import { disposeAll, feed, makeClient, observe } from "./helpers/client.ts";
import { settle } from "./helpers/clock.ts";

// One subscribe shape, `subscribe(source, fn | observer, options?)`.

afterEach(disposeAll);

interface TestConnection {
	url: string;
}
type TestSelection = Record<string, never>;

/**
 * A minimal builder result shaped like a transport feed, without importing a
 * transport. The generic signature keeps `.subscription<T>()` compiling; the
 * plain one, declared last, is the one TypeScript infers the event type from.
 */
interface TestFeed<E = unknown> {
	readonly connection: TestConnection;
	subscription<E2 = E>(): SubscriptionRequest<
		E2,
		TestConnection,
		TestSelection
	>;
	subscription(): SubscriptionRequest<E, TestConnection, TestSelection>;
}

function testFeed<E = unknown>(url = "https://api.test/feed"): TestFeed<E> {
	const connection = { url };
	return {
		connection,
		subscription: () => ({
			adapter: "test",
			connection: { ...connection },
			subscription: {},
		}),
	};
}

/** Throws when called without its required argument, as a GraphQL endpoint's builder does. */
const needsSelection = {
	connection: { url: "https://api.test/graphql" },
	subscription(document: string): SubscriptionRequest {
		if (typeof document !== "string") {
			throw unsupported("operation", "must be a document.", "graphql-ws");
		}
		return feed({ document });
	},
};

function caught(run: () => unknown): unknown {
	try {
		run();
	} catch (error) {
		return error;
	}
	throw new Error("expected a synchronous throw");
}

describe("sources: toRequest", () => {
	it("returns a request unchanged and calls a feed's subscription() with no argument", () => {
		const request = feed();
		expect(toRequest(request, "request")).toBe(request);
		const source = testFeed();
		const spy = vi.spyOn(source, "subscription");
		expect(toRequest(source, "request")).toEqual({
			adapter: "test",
			connection: { url: "https://api.test/feed" },
			subscription: {},
		});
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy.mock.calls[0]).toEqual([]);
	});

	it("gives a feed and its .subscription() identical canonical requests", async () => {
		const source = testFeed();
		expect(toRequest(source, "request")).toStrictEqual(source.subscription());
		const { client, host, clock } = makeClient();
		const fromFeed = observe();
		const fromRequest = observe();
		client.subscribe(source, fromFeed.observer);
		client.subscribe(source.subscription(), fromRequest.observer);
		await settle(clock);
		// One identity: one upstream connection, one subscription, two consumers.
		expect(host.test.connections).toHaveLength(1);
		expect(host.test.connections[0]?.subscriptions).toHaveLength(1);
		expect(host.test.last().consumers.size).toBe(2);
		host.test.last().emit({ n: 1 });
		await settle(clock);
		expect(fromFeed.log.events).toEqual([{ n: 1 }]);
		expect(fromRequest.log.events).toEqual([{ n: 1 }]);
	});

	it("propagates the error a source's subscription() throws, synchronously and unchanged", async () => {
		const { client, host, clock } = makeClient();
		const failure = new TypeError("builder failed");
		const throwing = {
			connection: { url: "https://api.test/feed" },
			subscription(): SubscriptionRequest {
				throw failure;
			},
		};
		expect(caught(() => client.subscribe(throwing, observe().observer))).toBe(
			failure,
		);
		// An endpoint whose selection needs an argument fails in its builder,
		// naming the builder's path, before anything is registered.
		const error = caught(() =>
			client.subscribe(needsSelection as never, observe().observer),
		);
		expect(isSpinetabError(error, "unsupported-option")).toBe(true);
		expect((error as Error).message).toBe(
			"graphql-ws: operation must be a document.",
		);
		await settle(clock);
		expect(host.test.all()).toHaveLength(0);
	});
});

describe("observers: toObserver", () => {
	it("wraps a function as next and returns an observer object as is", () => {
		const next = vi.fn();
		expect(toObserver(next, "observer")).toEqual({ next });
		const observer = observe().observer;
		expect(toObserver(observer, "observer")).toBe(observer);
	});

	it("delivers (event, meta) to a function observer", async () => {
		const { client, host, clock } = makeClient();
		const calls: Array<[unknown, EventMeta]> = [];
		client.subscribe(testFeed(), (event, meta) => {
			calls.push([event, meta]);
		});
		client.subscribe(feed({ other: true }), (event, meta) => {
			calls.push([event, meta]);
		});
		await settle(clock);
		host.test.connections[0]?.subscriptions[0]?.emit(
			{ n: 1 },
			{ eventId: "e1" },
		);
		await settle(clock);
		expect(calls).toEqual([[{ n: 1 }, { seq: 1, eventId: "e1" }]]);
		host.test.last().emit({ n: 2 });
		await settle(clock);
		expect(calls[1]).toEqual([{ n: 2 }, { seq: 1 }]);
	});

	it("still rejects an observer object without a next function", () => {
		const { client } = makeClient();
		for (const observer of [{}, { next: 1 }, { error() {} }, null, 42]) {
			const error = caught(() =>
				client.subscribe(feed(), observer as unknown as Observer<unknown>),
			);
			expect(isSpinetabError(error, "unsupported-option")).toBe(true);
			expect(error).toMatchObject({
				message: "observer.next must be a function.",
				detail: { path: "observer.next" },
			});
		}
		expect(caught(() => toObserver({} as never, "observer"))).toMatchObject({
			code: "unsupported-option",
			message: "observer.next must be a function.",
		});
	});

	it("keeps the validation order: disposed, request, observer, options", () => {
		const { client } = makeClient();
		const badRequest = { adapter: "", connection: {}, subscription: {} };
		expect(
			caught(() => client.subscribe(badRequest, {} as never, 1 as never)),
		).toMatchObject({ detail: { path: "request.adapter" } });
		expect(
			caught(() => client.subscribe(feed(), {} as never, 1 as never)),
		).toMatchObject({ detail: { path: "observer.next" } });
		expect(
			caught(() => client.subscribe(feed(), () => {}, 1 as never)),
		).toMatchObject({ detail: { path: "options" } });
		client.dispose();
		const source = testFeed();
		const spy = vi.spyOn(source, "subscription");
		expect(caught(() => client.subscribe(source, {} as never))).toMatchObject({
			code: "disposed",
		});
		expect(spy).not.toHaveBeenCalled();
	});
});

describe("types", () => {
	it("infers the event type from a feed or a request and types the observer's arguments", () => {
		const { client } = makeClient();
		const fromFeed = client.subscribe(
			testFeed<{ n: number }>(),
			(event, meta) => {
				expectTypeOf(event).toEqualTypeOf<{ n: number }>();
				expectTypeOf(meta).toEqualTypeOf<EventMeta>();
			},
		);
		expectTypeOf(fromFeed).toEqualTypeOf<Subscription<{ n: number }>>();
		const fromRequest = client.subscribe(
			testFeed<{ n: number }>().subscription<{ s: string }>(),
			{
				next(event) {
					expectTypeOf(event).toEqualTypeOf<{ s: string }>();
				},
			},
		);
		expectTypeOf(fromRequest).toEqualTypeOf<Subscription<{ s: string }>>();
		const asFeed: Feed<{ n: number }> = testFeed<{ n: number }>();
		const asSource: Source<{ n: number }> = asFeed;
		expectTypeOf(asSource).toExtend<Source<{ n: number }>>();
		expectTypeOf<(event: number, meta: EventMeta) => void>().toExtend<
			Observer<number>
		>();
		expectTypeOf<SubscriptionObserver<number>>().toExtend<Observer<number>>();
		// The payload type comes from the source; an annotated callback cannot
		// override it (NoInfer, found by the docs snippet check on 29 Sep 2026).
		client.subscribe(
			testFeed<{ n: number }>(),
			// @ts-expect-error: `{ closed: string }` is not the feed's `{ n: number }`.
			(event: { closed: string }) => void event,
		);
		// A selection that needs an argument is not a feed.
		// @ts-expect-error: `subscription(document)` is not assignable to `subscription()`.
		const rejected: Source = needsSelection;
		expect(rejected).toBe(needsSelection);
		fromFeed.unsubscribe();
		fromRequest.unsubscribe();
	});

	it("rejects GraphQL and Socket.IO endpoints as a source, at type level and at runtime", () => {
		// A request's selection is data cloned to the runtime, never a function,
		// so an endpoint's `subscription(spec)` method does not make it a request.
		// @ts-expect-error: `subscription(operation)` is a method, not a selection.
		const ws: Source = graphqlWs("wss://api.test/graphql");
		// @ts-expect-error: `subscription(operation)` is a method, not a selection.
		const http: Source = graphqlSse("https://api.test/graphql/stream");
		// @ts-expect-error: `subscription(spec)` is a method, not a selection.
		const io: Source = socketIo("https://api.test/chat", { sharing: "shared" });
		const { client, host } = makeClient();
		for (const endpoint of [ws, http, io]) {
			let error: unknown;
			try {
				client.subscribe(endpoint, () => {});
			} catch (caught) {
				error = caught;
			}
			expect(isSpinetabError(error, "unsupported-option")).toBe(true);
			expect(error).toMatchObject({ detail: { path: expect.any(String) } });
		}
		expect(host.test.all()).toHaveLength(0);
		// Any other selection stays a request: interfaces, including those whose
		// members are all optional, arrays, primitives and `undefined`.
		interface Operation {
			query: string;
		}
		interface Optional {
			topic?: string;
		}
		type Selecting<S> = SubscriptionRequest<number, unknown, S>;
		expectTypeOf<Selecting<Operation>>().toExtend<Source<number>>();
		expectTypeOf<Selecting<Optional>>().toExtend<Source<number>>();
		expectTypeOf<Selecting<string[]>>().toExtend<Source<number>>();
		expectTypeOf<Selecting<undefined>>().toExtend<Source<number>>();
		expectTypeOf<Selecting<() => void>>().not.toExtend<Source<number>>();
	});
});
