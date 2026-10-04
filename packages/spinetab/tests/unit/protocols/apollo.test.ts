import {
	ApolloClient,
	CombinedGraphQLErrors,
	gql,
	InMemoryCache,
} from "@apollo/client";
import { describe, expect, it } from "vitest";
import {
	isSpinetabError,
	type SpinetabError,
} from "../../../src/core/errors.ts";
import type {
	SpinetabClient,
	SubscriptionStatus,
} from "../../../src/core/types.ts";
import { SpinetabLink } from "../../../src/integrations/apollo/index.ts";
import { graphqlSse } from "../../../src/protocols/graphql-sse/index.ts";
import { graphqlWs } from "../../../src/protocols/graphql-ws/index.ts";
import { createFakeClient } from "./fakes.ts";

// with a real ApolloClient and a fake
// Spinetab page client.

const SUB = gql`
	subscription OnTick($room: String!) {
		ticks(room: $room) { n }
	}
`;

function setup(endpoint = graphqlWs({ url: "/graphql" })) {
	const { client, calls } = createFakeClient();
	const statuses: string[] = [];
	const apollo = new ApolloClient({
		cache: new InMemoryCache(),
		link: new SpinetabLink(client, endpoint, {
			onStatus: (status) => statuses.push(status.connection.state),
		}),
	});
	const results: Array<{ data?: unknown; error?: unknown }> = [];
	let completed = 0;
	const start = (
		variables = { room: "a" },
		context?: Record<string, unknown>,
	) =>
		apollo
			.subscribe({ query: SUB, variables, ...(context ? { context } : {}) })
			.subscribe({
				next: (result) => results.push(result),
				complete: () => {
					completed += 1;
				},
			});
	return {
		apollo,
		calls,
		statuses,
		results,
		start,
		completed: () => completed,
	};
}

describe("SpinetabLink mapping", () => {
	it("forwards the printed transformed document, variables, operation name and context.spinetab", () => {
		const { calls, start } = setup();
		start(
			{ room: "a" },
			{ spinetab: { locale: "fr" }, headers: { authorization: "x" } },
		);
		expect(calls).toHaveLength(1);
		const request = calls[0]?.request;
		expect(request?.adapter).toBe("graphql-ws");
		expect(request?.connection).toEqual({ url: "/graphql" });
		expect(request?.subscription).toMatchObject({
			operationName: "OnTick",
			variables: { room: "a" },
			context: { locale: "fr" },
		});
		expect(
			String((request?.subscription as { query: string }).query),
		).toContain("__typename");
		// Other context (headers, client, cache) stays in the page.
		expect(JSON.stringify(request)).not.toContain("authorization");
		expect(structuredClone(request)).toEqual(request);
	});

	it("works with graphql-sse endpoints too", () => {
		const { calls, start } = setup(
			graphqlSse({ url: "/stream", mode: "single" }),
		);
		start();
		expect(calls[0]?.request.adapter).toBe("graphql-sse");
	});

	it("rejects queries and mutations before reaching the client", async () => {
		const { apollo, calls } = setup();
		await expect(apollo.query({ query: gql`query Q { a }` })).rejects.toSatisfy(
			(error) => isSpinetabError(error, "unsupported-option"),
		);
		await expect(
			apollo.mutate({ mutation: gql`mutation M { a }` }),
		).rejects.toThrow(/subscriptions only/);
		expect(calls).toHaveLength(0);
	});
});

describe("SpinetabLink results and errors", () => {
	it("passes results through and maps GraphQL errors to CombinedGraphQLErrors", async () => {
		const { calls, results, start } = setup();
		start();
		const observer = calls[0]?.observer;
		observer?.next(
			{ data: { ticks: { __typename: "Tick", n: 1 } } },
			{ seq: 1 },
		);
		observer?.error?.({
			code: "upstream-error",
			message: "The GraphQL operation failed.",
			detail: { errors: [{ message: "boom" }] },
		});
		await Promise.resolve();
		expect(results[0]).toEqual({
			data: { ticks: { __typename: "Tick", n: 1 } },
		});
		expect(CombinedGraphQLErrors.is(results[1]?.error)).toBe(true);
		expect((results[1]?.error as CombinedGraphQLErrors).errors).toEqual([
			{ message: "boom" },
		]);
	});

	it("stays open through reconnecting, retry-exhausted and auth-blocked", () => {
		const { calls, results, start, statuses, completed } = setup();
		start();
		const call = calls[0];
		for (const state of [
			"reconnecting",
			"retry-exhausted",
			"auth-blocked",
			"connected",
		] as const) {
			call?.status(state);
		}
		call?.status("connected", {
			continuity: { state: "unknown", reason: "reconnected", since: 0 },
		});
		call?.observer.next(
			{ data: { ticks: { __typename: "Tick", n: 2 } } },
			{ seq: 2 },
		);
		expect(results).toEqual([
			{ data: { ticks: { __typename: "Tick", n: 2 } } },
		]);
		expect(statuses).toContain("retry-exhausted");
		expect(completed()).toBe(0);
		expect(call?.unsubscribed).toBe(0);
	});

	it("errors with a coded error on failed and on continuity loss, releasing the consumer", () => {
		const failed = setup();
		failed.start();
		failed.calls[0]?.status("failed");
		expect(isSpinetabError(failed.results[0]?.error, "upstream-error")).toBe(
			true,
		);
		expect(failed.calls[0]?.unsubscribed).toBeGreaterThanOrEqual(1);

		const gap = setup();
		gap.start();
		gap.calls[0]?.status("connected", {
			continuity: { state: "gap", reason: "overflow", since: 0 },
		});
		expect(isSpinetabError(gap.results[0]?.error, "continuity-lost")).toBe(
			true,
		);
	});

	it("releases its consumer exactly once on teardown; restart creates a fresh one", () => {
		const { calls, start } = setup();
		const subscription = start();
		subscription.unsubscribe();
		subscription.unsubscribe();
		expect(calls[0]?.unsubscribed).toBe(1);
		start();
		expect(calls).toHaveLength(2);
	});

	it("completes on genuine completion", () => {
		const { calls, start, completed } = setup();
		start();
		calls[0]?.observer.complete?.();
		expect(completed()).toBe(1);
	});
});

// an application `onStatus` that throws must not stop the
// link's own terminal handling, and the exception must still reach the page
// client's status dispatcher (core reports it through `onCallbackError`).
describe("SpinetabLink status callback isolation", () => {
	const TERMINALS = {
		failed: {
			state: "failed",
			extra: {
				connection: {
					state: "failed",
					reason: "protocol-error",
					code: "close:4500",
					since: 0,
				},
			},
			code: "upstream-error",
			message: "The subscription connection failed (protocol-error).",
			detail: { state: "failed", code: "close:4500" },
		},
		gap: {
			state: "connected",
			extra: {
				continuity: { state: "gap", reason: "overflow", since: 0 },
			},
			code: "continuity-lost",
			message:
				"Subscription delivery stopped (overflow); restart to resubscribe.",
			detail: { reason: "overflow" },
		},
	} as const;

	function isolated(
		onStatus: (status: SubscriptionStatus) => void,
		client?: SpinetabClient,
	) {
		const fake = createFakeClient();
		const log: string[] = [];
		const apollo = new ApolloClient({
			cache: new InMemoryCache(),
			link: new SpinetabLink(client ?? fake.client, graphqlWs({ url: "/g" }), {
				onStatus: (status) => {
					log.push(
						`status:${status.connection.state}:${status.continuity.state}`,
					);
					onStatus(status);
				},
			}),
		});
		const results: Array<{ data?: unknown; error?: unknown }> = [];
		let completed = 0;
		const start = (
			onResult?: (result: { error?: unknown }) => void,
		): { unsubscribe(): void } => {
			const subscription = apollo
				.subscribe({ query: SUB, variables: { room: "a" } })
				.subscribe({
					next: (result) => {
						results.push(result);
						if (result.error) {
							log.push(`error:${(result.error as SpinetabError).code}`);
						}
						onResult?.(result);
					},
					complete: () => {
						completed += 1;
					},
				});
			return subscription;
		};
		return {
			calls: fake.calls,
			fake: fake.client,
			log,
			results,
			start,
			completed: () => completed,
		};
	}

	const appError = new Error("application onStatus failed");
	const throwing = () => {
		throw appError;
	};

	for (const [name, terminal] of Object.entries(TERMINALS)) {
		for (const throws of [true, false]) {
			it(`${throws ? "a throwing" : "a returning"} onStatus on ${name} still errors the observable and releases the consumer exactly once`, () => {
				const { calls, log, results, start, completed } = isolated(
					throws ? throwing : () => {},
				);
				start();
				const call = calls[0];
				const dispatch = () => call?.status(terminal.state, terminal.extra);
				if (throws) expect(dispatch).toThrow(appError);
				else expect(dispatch).not.toThrow();
				expect(results).toHaveLength(1);
				const error = results[0]?.error as SpinetabError;
				expect(isSpinetabError(error, terminal.code)).toBe(true);
				expect(error.message).toBe(terminal.message);
				expect(error.detail).toEqual(terminal.detail);
				expect(call?.unsubscribed).toBe(1);
				// The application sees the status before the observable errors.
				expect(log).toEqual([
					`status:${terminal.state}:${name === "gap" ? "gap" : "continuous"}`,
					`error:${terminal.code}`,
				]);
				// Apollo delivers the link error as a result, then completes;
				// nothing is emitted after termination.
				call?.observer.next({ data: { ticks: { n: 9 } } }, { seq: 9 });
				expect(results).toHaveLength(1);
				expect(completed()).toBe(1);
			});
		}
	}

	it("a throwing onStatus on a non-terminal status leaves a healthy subscription open and delivering", () => {
		const { calls, results, start, completed } = isolated(throwing);
		start();
		const call = calls[0];
		expect(() => call?.status("reconnecting")).toThrow(appError);
		expect(() => call?.status("retry-exhausted")).toThrow(appError);
		expect(() =>
			call?.status("connected", {
				continuity: { state: "unknown", reason: "reconnected", since: 0 },
			}),
		).toThrow(appError);
		call?.observer.next(
			{ data: { ticks: { __typename: "Tick", n: 3 } } },
			{ seq: 3 },
		);
		expect(results).toEqual([
			{ data: { ticks: { __typename: "Tick", n: 3 } } },
		]);
		expect(completed()).toBe(0);
		expect(call?.unsubscribed).toBe(0);
	});

	it("tolerates an unsubscribe from inside onStatus (re-entrant teardown)", () => {
		for (const throws of [false, true]) {
			let subscription: { unsubscribe(): void } | undefined;
			const { calls, results, start } = isolated((status) => {
				if (status.connection.state !== "failed") return;
				subscription?.unsubscribe();
				if (throws) throw appError;
			});
			subscription = start();
			const dispatch = () => calls[0]?.status("failed");
			if (throws) expect(dispatch).toThrow(appError);
			else expect(dispatch).not.toThrow();
			expect(calls[0]?.unsubscribed).toBe(1);
			expect(results).toEqual([]);
			subscription.unsubscribe();
			expect(calls[0]?.unsubscribed).toBe(1);
		}
	});

	it("tolerates an unsubscribe from inside the observer's error handler (re-entrant teardown)", () => {
		for (const throws of [false, true]) {
			let subscription: { unsubscribe(): void } | undefined;
			const { calls, results, start } = isolated(throws ? throwing : () => {});
			subscription = start((result) => {
				if (result.error) subscription?.unsubscribe();
			});
			const dispatch = () => calls[0]?.status("connected", TERMINALS.gap.extra);
			if (throws) expect(dispatch).toThrow(appError);
			else expect(dispatch).not.toThrow();
			expect(isSpinetabError(results[0]?.error, "continuity-lost")).toBe(true);
			expect(calls[0]?.unsubscribed).toBe(1);
		}
	});

	it("releases once when a status arrives while the link is releasing", () => {
		const { calls, client: fake } = createFakeClient();
		const statuses: string[] = [];
		const client = {
			...fake,
			subscribe: ((request, observer, options) => {
				const subscription = fake.subscribe(request, observer, options);
				return {
					...subscription,
					unsubscribe() {
						subscription.unsubscribe();
						calls.at(-1)?.status("failed");
					},
				};
			}) as SpinetabClient["subscribe"],
		} as SpinetabClient;
		const apollo = new ApolloClient({
			cache: new InMemoryCache(),
			link: new SpinetabLink(client, graphqlWs({ url: "/g" }), {
				onStatus: (status) => statuses.push(status.connection.state),
			}),
		});
		const results: unknown[] = [];
		const subscription = apollo
			.subscribe({ query: SUB, variables: { room: "a" } })
			.subscribe((result) => results.push(result));
		expect(() => subscription.unsubscribe()).not.toThrow();
		expect(calls[0]?.unsubscribed).toBe(1);
		expect(statuses).toEqual(["failed"]);
		expect(results).toEqual([]);
	});

	it("handles a terminal status dispatched synchronously inside client.subscribe", () => {
		for (const throws of [false, true]) {
			const { calls, client: fake } = createFakeClient();
			const callbackErrors: unknown[] = [];
			// Core-like dispatcher: observer exceptions are reported, not thrown.
			const client = {
				...fake,
				subscribe: ((request, observer, options) => {
					const subscription = fake.subscribe(request, observer, options);
					try {
						calls.at(-1)?.status("failed");
					} catch (error) {
						callbackErrors.push(error);
					}
					return subscription;
				}) as SpinetabClient["subscribe"],
			} as SpinetabClient;
			const apollo = new ApolloClient({
				cache: new InMemoryCache(),
				link: new SpinetabLink(client, graphqlWs({ url: "/g" }), {
					onStatus: throws ? throwing : () => {},
				}),
			});
			const results: Array<{ error?: unknown }> = [];
			apollo
				.subscribe({ query: SUB, variables: { room: "a" } })
				.subscribe((result) => results.push(result));
			expect(isSpinetabError(results[0]?.error, "upstream-error")).toBe(true);
			expect(callbackErrors).toEqual(throws ? [appError] : []);
			expect(calls[0]?.unsubscribed).toBe(1);
		}
	});
});
