import {
	ApolloClient,
	CombinedGraphQLErrors,
	gql,
	InMemoryCache,
	type TypedDocumentNode,
} from "@apollo/client";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import { browserEnv, createClientWithEnv } from "../../../src/core/client.ts";
import {
	isSpinetabError,
	type SpinetabError,
} from "../../../src/core/errors.ts";
import { createRuntime, type Runtime } from "../../../src/core/runtime.ts";
import type { SubscriptionStatus } from "../../../src/core/types.ts";
import { SpinetabLink } from "../../../src/integrations/apollo/index.ts";
import { graphqlWs } from "../../../src/protocols/graphql-ws/index.ts";
import { graphqlWsAdapter } from "../../../src/protocols/graphql-ws/runtime.ts";
import type { GraphqlWsTagCounters } from "../../fixtures/servers/graphql-ws.ts";
import { createAdapterClient } from "./adapter-client.ts";
import {
	clearFault,
	fastRetry,
	primaryOrigin,
	readCounters,
	setFault,
	sleep,
	uniqueTag,
	waitFor,
	wsOrigin,
} from "./helpers.ts";

// A real Apollo Client 4.3.1 (InMemoryCache) in Node, terminating in
// SpinetabLink, over the real graphql-ws adapter and server. Covers P-I-12.

interface TicksData {
	ticks: { __typename: "Tick"; n: number; flaky: string | null };
}
interface TicksVariables {
	intervalMs: number;
	count?: number;
	errorAfter?: number;
	partial?: boolean;
	label?: string;
}

const TICKS: TypedDocumentNode<TicksData, TicksVariables> = gql`
	subscription Ticks($intervalMs: Int!, $count: Int, $errorAfter: Int, $partial: Boolean, $label: String) {
		ticks(intervalMs: $intervalMs, count: $count, errorAfter: $errorAfter, partial: $partial, label: $label) { n flaky }
	}
`;

async function tagCounters(tag: string): Promise<GraphqlWsTagCounters> {
	const all = await readCounters<{
		tags: Record<string, GraphqlWsTagCounters>;
	}>("graphql-ws");
	return all.tags[tag] as GraphqlWsTagCounters;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function setup(tag: string, options: { queryDeduplication?: boolean } = {}) {
	const spinetab = createAdapterClient({
		adapters: [graphqlWsAdapter({ retryWait: fastRetry() }) as never],
		scope: tag,
		credentials: (revision) => ({
			connectionParams: { token: `valid-${tag}-${revision}` },
		}),
	});
	cleanups.push(() => spinetab.dispose());
	const statuses: SubscriptionStatus[] = [];
	const link = new SpinetabLink(
		spinetab,
		graphqlWs({ url: `${wsOrigin()}/graphql-ws?tag=${tag}` }),
		{ onStatus: (status) => statuses.push(status) },
	);
	const client = new ApolloClient({
		cache: new InMemoryCache(),
		link,
		queryDeduplication: options.queryDeduplication ?? true,
	});
	cleanups.push(() => client.stop());
	return { client, spinetab, statuses };
}

describe("SpinetabLink in a real ApolloClient", () => {
	it("delivers typed results and releases the consumer on unsubscribe", async () => {
		const tag = uniqueTag("apa");
		const { client } = setup(tag);
		const results: Array<{ data?: TicksData; error?: unknown }> = [];
		const observable = client.subscribe({
			query: TICKS,
			variables: { intervalMs: 20 },
		});
		const subscription = observable.subscribe((result) => {
			expectTypeOf(result.data).toEqualTypeOf<TicksData | undefined>();
			results.push(result);
		});
		await waitFor(() => results.length >= 3);
		expect(results[0]?.data?.ticks.n).toBe(1);
		expect(results[0]?.data?.ticks.__typename).toBe("Tick");
		const counters = await tagCounters(tag);
		// Apollo's transformed document (with __typename) is what is sent.
		expect(counters.payloads[0]?.query).toContain("__typename");
		expect(counters.payloads[0]?.operationName).toBe("Ticks");
		subscription.unsubscribe();
		await waitFor(
			async () => (await tagCounters(tag)).activeSubscriptions === 0,
		);
	});

	it("maps GraphQL errors to CombinedGraphQLErrors and keeps partial data with errorPolicy all", async () => {
		const tag = uniqueTag("apb");
		const { client } = setup(tag);
		const failing: Array<{ data?: unknown; error?: unknown }> = [];
		client
			.subscribe({ query: TICKS, variables: { intervalMs: 20, errorAfter: 1 } })
			.subscribe((result) => failing.push(result));
		await waitFor(() => failing.some((result) => result.error));
		const errored = failing.find((result) => result.error);
		expect(CombinedGraphQLErrors.is(errored?.error)).toBe(true);
		expect((errored?.error as CombinedGraphQLErrors).errors[0]?.message).toBe(
			"ticks failed after 1 events",
		);

		const partial: Array<{ data?: TicksData; error?: unknown }> = [];
		client
			.subscribe({
				query: TICKS,
				variables: { intervalMs: 20, partial: true, count: 2 },
				errorPolicy: "all",
			})
			.subscribe((result) => partial.push(result));
		await waitFor(() => partial.length === 2);
		expect(partial[1]?.data?.ticks.flaky).toBeNull();
		expect(CombinedGraphQLErrors.is(partial[1]?.error)).toBe(true);
	});

	it("stays open through a reconnect and reports status through onStatus", async () => {
		const tag = uniqueTag("apc");
		const { client, statuses } = setup(tag);
		const results: Array<{ data?: TicksData; error?: unknown }> = [];
		let completed = false;
		client
			.subscribe({ query: TICKS, variables: { intervalMs: 20 } })
			.subscribe({
				next: (result) => results.push(result),
				complete: () => {
					completed = true;
				},
			});
		await waitFor(() => results.length >= 2);
		await fetch(`${primaryOrigin()}/graphql-ws/control/terminate?tag=${tag}`, {
			method: "POST",
		});
		await waitFor(() =>
			statuses.some((status) => status.continuity.reason === "reconnected"),
		);
		const before = results.length;
		await waitFor(() => results.length > before + 1);
		expect(results.every((result) => result.error === undefined)).toBe(true);
		expect(completed).toBe(false);
		expect(
			statuses.some((status) => status.connection.state === "reconnecting"),
		).toBe(true);
	});

	it("separates identities by context.spinetab and never sends queries through the worker", async () => {
		const tag = uniqueTag("apd");
		const { client, spinetab } = setup(tag, { queryDeduplication: false });
		const seen: string[] = [];
		for (const locale of ["en", "fr"]) {
			client
				.subscribe({
					query: TICKS,
					variables: { intervalMs: 20 },
					context: { spinetab: { locale } },
				})
				.subscribe(() => seen.push(locale));
		}
		await waitFor(() => seen.includes("en") && seen.includes("fr"));
		expect(spinetab.subscriptionKeys()).toHaveLength(2);
		expect((await tagCounters(tag)).subscriptions).toBe(2);

		const query = gql`query Hello { hello }`;
		await expect(client.query({ query })).rejects.toThrow(/subscriptions only/);
		await sleep(50);
		expect(
			(await tagCounters(tag)).payloads.every(
				(payload) => !payload.query.includes("hello"),
			),
		).toBe(true);
	});
});

// through the real core: page client (`createClientWithEnv`,
// `sharing: "off"`), MessageChannel bridge and `createRuntime`, so the
// callback-error path and the runtime consumer count are the product's own.
describe("SpinetabLink callback isolation through the real core", () => {
	it("a throwing onStatus on a real failed connection still errors Apollo and releases the consumer", async () => {
		const tag = uniqueTag("ape");
		const origin = primaryOrigin();
		const appError = new Error("application onStatus failed");
		const callbackErrors: unknown[] = [];
		let runtime: Runtime | undefined;
		const spinetab = createClientWithEnv(
			{
				sharing: "off",
				scope: tag,
				credentialRevision: 1,
				credentials: ({ revision }) => ({
					connectionParams: { token: `valid-${tag}-${revision ?? 1}` },
				}),
				onCallbackError: (error) => callbackErrors.push(error),
				local: async () => ({
					default: () => {
						runtime = createRuntime({
							adapters: [graphqlWsAdapter({ retryWait: fastRetry() })],
							limits: { idleCloseMs: 100 },
							// Node has no worker origin: declare the fixture's.
							credentialOrigins: [primaryOrigin()],
						});
						return runtime;
					},
				}),
			},
			{
				...browserEnv,
				isBrowser: () => true,
				hasSharedWorker: () => false,
				visible: () => true,
				baseUri: () => `${origin}/app/`,
				listen: () => () => {},
			},
		);
		cleanups.push(() => spinetab.dispose());
		cleanups.push(() => void clearFault(`graphql-ws@${tag}`, "close-code"));
		const statuses: SubscriptionStatus[] = [];
		const client = new ApolloClient({
			cache: new InMemoryCache(),
			link: new SpinetabLink(
				spinetab,
				graphqlWs({ url: `/graphql-ws?tag=${tag}` }),
				{
					onStatus: (status) => {
						statuses.push(status);
						if (status.connection.state === "failed") throw appError;
					},
				},
			),
		});
		cleanups.push(() => client.stop());
		const results: Array<{ data?: TicksData; error?: unknown }> = [];
		let completed = 0;
		client
			.subscribe({ query: TICKS, variables: { intervalMs: 20 } })
			.subscribe({
				next: (result) => results.push(result),
				complete: () => {
					completed += 1;
				},
			});
		await waitFor(() => results.length >= 2, { message: "ticks delivered" });
		expect(runtime?.stats().consumers).toBe(1);
		expect((await tagCounters(tag)).activeSubscriptions).toBe(1);

		// The reconnect after a dropped socket is refused with 4500, which the
		// graphql-ws adapter classifies as terminal: connection.state "failed".
		await setFault(`graphql-ws@${tag}`, "close-code", 4500);
		await fetch(`${origin}/graphql-ws/control/terminate?tag=${tag}`, {
			method: "POST",
		});
		await waitFor(
			() =>
				statuses.some((status) => status.connection.state === "failed") &&
				callbackErrors.length > 0,
			{ message: "connection failed and the callback error reported" },
		);
		await waitFor(() => results.some((result) => result.error), {
			message: "Apollo observable errored",
		});
		const error = results.find((result) => result.error)
			?.error as SpinetabError;
		expect(isSpinetabError(error, "upstream-error")).toBe(true);
		expect(error.detail).toEqual({ state: "failed", code: "close:4500" });
		expect(
			statuses.filter((status) => status.connection.state === "failed"),
		).toHaveLength(1);
		expect(completed).toBe(1);
		await waitFor(() => runtime?.stats().consumers === 0, {
			message: "runtime consumer released",
		});
		// The upstream closes through the runtime's linger timer (lingerMs 0 is
		// the next timer task), so the record is observed, not sampled.
		await waitFor(() => runtime?.stats().subscriptions === 0, {
			message: "runtime subscription released",
		});
		expect((await tagCounters(tag)).activeSubscriptions).toBe(0);
		await sleep(100);
		// Reported once through the core's callback-error path, not swallowed.
		expect(callbackErrors).toEqual([appError]);
		expect(results.filter((result) => result.error)).toHaveLength(1);
	});
});
