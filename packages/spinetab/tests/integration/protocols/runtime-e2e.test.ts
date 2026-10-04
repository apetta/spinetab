import { ApolloClient, gql, InMemoryCache } from "@apollo/client";
import { afterEach, describe, expect, it } from "vitest";
import { browserEnv, createClientWithEnv } from "../../../src/core/client.ts";
import { createRuntime } from "../../../src/core/runtime.ts";
import type {
	SpinetabClient,
	SubscriptionStatus,
} from "../../../src/core/types.ts";
import { SpinetabLink } from "../../../src/integrations/apollo/index.ts";
import type { DocumentTypeDecoration } from "../../../src/protocols/graphql/types.ts";
import { graphqlSse } from "../../../src/protocols/graphql-sse/index.ts";
import { graphqlSseAdapter } from "../../../src/protocols/graphql-sse/runtime.ts";
import { graphqlWs } from "../../../src/protocols/graphql-ws/index.ts";
import { graphqlWsAdapter } from "../../../src/protocols/graphql-ws/runtime.ts";
import type { GraphqlSseTagCounters } from "../../fixtures/servers/graphql-sse.ts";
import type { GraphqlWsTagCounters } from "../../fixtures/servers/graphql-ws.ts";
import {
	clearFault,
	fastRetry,
	primaryOrigin,
	readCounters,
	setFault,
	uniqueTag,
	waitFor,
} from "./helpers.ts";

// End to end through the real core: page client (`createClientWithEnv`,
// Node environment, `sharing: "off"`), MessageChannel bridge, `createRuntime`
// and the real protocol adapters against the real fixture servers. Relative
// endpoints are resolved by the page client before crossing the bridge.

type TickData = { ticks: { n: number; label: string | null } };
type TickResult = { data?: TickData | null };

// A typed string document, as GraphQL Code Generator's TypedDocumentString.
const TICKS = /* GraphQL */ `
	subscription Ticks($intervalMs: Int, $label: String) {
		ticks(intervalMs: $intervalMs, label: $label) { n label }
	}
` as string &
	DocumentTypeDecoration<TickData, { intervalMs?: number; label?: string }>;

const clients: SpinetabClient[] = [];
afterEach(() => {
	for (const client of clients.splice(0)) client.dispose();
});

function localClient(tag: string): SpinetabClient {
	const origin = primaryOrigin();
	const client = createClientWithEnv(
		{
			sharing: "off",
			scope: tag,
			credentialRevision: 1,
			credentials: ({ revision }) => ({
				connectionParams: { token: `valid-${tag}-${revision ?? 1}` },
				headers: { authorization: `Bearer valid-${tag}-${revision ?? 1}` },
			}),
			local: async () => ({
				default: () =>
					createRuntime({
						adapters: [
							graphqlWsAdapter({ retryWait: fastRetry() }),
							graphqlSseAdapter({ retry: fastRetry() }),
						],
						limits: { idleCloseMs: 100 },
						// Node has no worker origin: declare the fixture's.
						credentialOrigins: [origin],
					}),
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
	clients.push(client);
	return client;
}

async function wsCounters(tag: string): Promise<GraphqlWsTagCounters> {
	const all = await readCounters<{
		tags: Record<string, GraphqlWsTagCounters>;
	}>("graphql-ws");
	return all.tags[tag] as GraphqlWsTagCounters;
}

describe("protocol adapters through the real core runtime", () => {
	it("graphql-ws: two consumers share one upstream operation; status reaches the page", async () => {
		const tag = uniqueTag("e2ew");
		const client = localClient(tag);
		const feed = graphqlWs({ url: `/graphql-ws?tag=${tag}` });
		const request = feed.subscription({
			query: TICKS,
			variables: { intervalMs: 20 },
		});
		const a: TickResult[] = [];
		const b: TickResult[] = [];
		const first = client.subscribe(request, {
			next: (event) => void a.push(event),
		});
		const second = client.subscribe(request, {
			next: (event) => void b.push(event),
		});
		await waitFor(() => a.length >= 3 && b.length >= 3, {
			message: "events at both consumers",
		});
		const counters = await wsCounters(tag);
		expect(counters.connections).toBe(1);
		expect(counters.subscriptions).toBe(1);
		expect(first.status.get().connection.state).toBe("connected");
		expect(client.status.get().mode).toBe("local");

		first.unsubscribe();
		const count = b.length;
		await waitFor(() => b.length > count + 1);
		expect((await wsCounters(tag)).activeSubscriptions).toBe(1);
		second.unsubscribe();
		await waitFor(
			async () => (await wsCounters(tag)).activeSubscriptions === 0,
		);
	});

	it("graphql-ws: missing pong recovers and the consumer sees unknown continuity", async () => {
		const tag = uniqueTag("e2ep");
		await setFault(`graphql-ws@${tag}`, "suppress-pong");
		const client = localClient(tag);
		const feed = graphqlWs({
			url: `/graphql-ws?tag=${tag}`,
			keepAliveMs: 150,
			pongTimeoutMs: 150,
		});
		const statuses: SubscriptionStatus[] = [];
		const events: TickResult[] = [];
		client.subscribe(
			feed.subscription({ query: TICKS, variables: { intervalMs: 20 } }),
			{
				next: (event) => void events.push(event),
				status: (status) => void statuses.push(status),
			},
		);
		await waitFor(() =>
			statuses.some(
				(status) => status.connection.reason === "heartbeat-timeout",
			),
		);
		await clearFault(`graphql-ws@${tag}`, "suppress-pong");
		await waitFor(() =>
			statuses.some((status) => status.continuity.state === "unknown"),
		);
		const before = events.length;
		await waitFor(() => events.length > before + 1);
		expect((await wsCounters(tag)).closeCodes).toContain(4499);
	});

	it("graphql-sse single mode through the runtime", async () => {
		const tag = uniqueTag("e2es");
		const client = localClient(tag);
		const feed = graphqlSse({ url: `/graphql-sse/${tag}`, mode: "single" });
		const events: TickResult[] = [];
		const subscription = client.subscribe(
			feed.subscription({
				query: TICKS,
				variables: { intervalMs: 20, label: "s" },
			}),
			{ next: (event) => void events.push(event) },
		);
		await waitFor(() => events.length >= 2);
		expect(events[0]?.data?.ticks.label).toBe("s");
		subscription.unsubscribe();
		const all = await readCounters<{
			tags: Record<string, GraphqlSseTagCounters>;
		}>("graphql-sse");
		await waitFor(async () => {
			const again = await readCounters<{
				tags: Record<string, GraphqlSseTagCounters>;
			}>("graphql-sse");
			return again.tags[tag]?.requests.DELETE === 1;
		});
		expect(all.tags[tag]?.requests).toMatchObject({ PUT: 1, POST: 1 });
	});

	it("Apollo: SpinetabLink over the real page client", async () => {
		const tag = uniqueTag("e2ea");
		const client = localClient(tag);
		const apollo = new ApolloClient({
			cache: new InMemoryCache(),
			link: new SpinetabLink(
				client,
				graphqlWs({ url: `/graphql-ws?tag=${tag}` }),
			),
		});
		const results: TickResult[] = [];
		const subscription = apollo
			.subscribe({ query: gql(String(TICKS)), variables: { intervalMs: 20 } })
			.subscribe((result) => void results.push(result as TickResult));
		await waitFor(() => results.length >= 2);
		expect(results[0]?.data?.ticks.n).toBe(1);
		subscription.unsubscribe();
		await waitFor(
			async () => (await wsCounters(tag)).activeSubscriptions === 0,
		);
		apollo.stop();
	});
});
