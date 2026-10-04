import { createTRPCClient, type TRPCLink } from "@trpc/client";
import superjson from "superjson";
import { afterEach, describe, expect, it } from "vitest";
import { browserEnv, createClientWithEnv } from "../../../src/core/client.ts";
import { createRuntime } from "../../../src/core/runtime.ts";
import type {
	SerialisedError,
	SpinetabClient,
} from "../../../src/core/types.ts";
import {
	spinetabSseLink,
	spinetabWsLink,
} from "../../../src/integrations/trpc/index.ts";
import {
	trpcSseAdapter,
	trpcWsAdapter,
} from "../../../src/integrations/trpc/runtime.ts";
import type {
	FixtureTrpcRouter,
	TrpcTagCounters,
} from "../../fixtures/servers/trpc.ts";
import { TestEventSource } from "./event-source.ts";
import {
	primaryOrigin,
	readCounters,
	sleep,
	uniqueTag,
	waitFor,
	wsOrigin,
} from "./helpers.ts";

// end to end: real page links in a real createTRPCClient,
// the real page client and bridge (`sharing: "off"`), `createRuntime` with
// the real tRPC adapters, and the superjson fixture router.

const SENTENCE =
	"This tRPC router uses a transformer; construct trpcWsAdapter({ transformer }) or trpcSseAdapter({ transformer }) in your worker file.";

type Tick = { n: number; at: Date; tags: Map<string, number> };
type Kind = "ws" | "sse";

const clients: SpinetabClient[] = [];
const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	for (const client of clients.splice(0)) client.dispose();
});

async function tagCounters(tag: string): Promise<TrpcTagCounters | undefined> {
	const all = await readCounters<{ tags: Record<string, TrpcTagCounters> }>(
		"trpc",
	);
	return all.tags[tag];
}

/** A page client whose local runtime hosts the tRPC adapters, with or without superjson. */
function localClient(tag: string, withTransformer: boolean): SpinetabClient {
	const origin = primaryOrigin();
	const transformer = withTransformer ? { transformer: superjson } : {};
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
							trpcWsAdapter({ ...transformer, retryDelayMs: () => 30 }),
							trpcSseAdapter({
								...transformer,
								EventSource: TestEventSource,
								headers: true,
							}),
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

function link(
	kind: Kind,
	client: SpinetabClient,
	tag: string,
	transformer?: boolean,
): TRPCLink<FixtureTrpcRouter> {
	const marker = transformer === undefined ? {} : { transformer };
	return kind === "ws"
		? spinetabWsLink<FixtureTrpcRouter>({
				client,
				url: `${wsOrigin()}/trpc-ws?tag=${tag}`,
				...marker,
			})
		: spinetabSseLink<FixtureTrpcRouter>({
				client,
				url: `${primaryOrigin()}/trpc`,
				...marker,
			});
}

function subscribeTicks(trpcLink: TRPCLink<FixtureTrpcRouter>, tag: string) {
	const trpc = createTRPCClient<FixtureTrpcRouter>({ links: [trpcLink] });
	const data: Array<{ id: string; data: Tick }> = [];
	const errors: Error[] = [];
	const subscription = trpc.ticks.subscribe(
		{ tag, intervalMs: 20 },
		{
			onData: (value) => void data.push(value),
			onError: (error) => void errors.push(error),
		},
	);
	cleanups.push(() => subscription.unsubscribe());
	return { data, errors };
}

describe("adapter constructed without a transformer", () => {
	for (const kind of ["ws", "sse"] as const) {
		it(`${kind}: a marked link fails with the fixed sentence and never reaches the server`, async () => {
			const tag = uniqueTag(`tmr${kind}`);
			const client = localClient(tag, false);
			const { data, errors } = subscribeTicks(
				link(kind, client, tag, true),
				tag,
			);
			await waitFor(() => errors.length === 1, {
				message: "the refusal at the consumer",
			});
			expect(errors[0]?.message).toBe(SENTENCE);
			expect(data).toEqual([]);
			await sleep(100);
			expect(await tagCounters(tag)).toBeUndefined();
		});

		it(`${kind}: the raw request is refused with unsupported-option`, async () => {
			const tag = uniqueTag(`tmq${kind}`);
			const client = localClient(tag, false);
			const failures: SerialisedError[] = [];
			const subscription = client.subscribe(
				{
					adapter: kind === "ws" ? "trpc-ws" : "trpc-sse",
					connection: {
						url:
							kind === "ws"
								? `${wsOrigin()}/trpc-ws?tag=${tag}`
								: `${primaryOrigin()}/trpc`,
						transformer: true,
					},
					subscription: { path: "ticks", input: { tag, intervalMs: 20 } },
				},
				{ next: () => {}, error: (error) => void failures.push(error) },
			);
			cleanups.push(() => subscription.unsubscribe());
			await waitFor(() => failures.length === 1, {
				message: "the refusal at the consumer",
			});
			expect(failures[0]).toMatchObject({
				code: "unsupported-option",
				message: SENTENCE,
			});
		});

		it(`${kind}: an unmarked link is accepted as before and receives undecoded output`, async () => {
			const tag = uniqueTag(`tmu${kind}`);
			const client = localClient(tag, false);
			// Without a transformer on either side, only input already in
			// superjson's wire form reaches this router's procedure; the output
			// then arrives undecoded, the silent mismatch the marker prevents.
			const trpc = createTRPCClient<FixtureTrpcRouter>({
				links: [link(kind, client, tag)],
			});
			const data: unknown[] = [];
			const errors: Error[] = [];
			const subscription = trpc.ticks.subscribe(
				{ json: { tag, intervalMs: 20 } } as never,
				{
					onData: (value) => void data.push(value),
					onError: (error) => void errors.push(error),
				},
			);
			cleanups.push(() => subscription.unsubscribe());
			await waitFor(() => data.length >= 2, { message: "raw events" });
			expect(errors).toEqual([]);
			// superjson's `{ json, meta }` envelope reaches the application
			// (WebSocket: around the tracked event; SSE: around its data).
			const text = JSON.stringify(data[0]);
			expect(text).toContain('"json":');
			expect(text).toContain('"meta":{"values":');
		});
	}
});

describe("adapter constructed with a transformer", () => {
	for (const kind of ["ws", "sse"] as const) {
		it(`${kind}: marked and unmarked links both decode, sharing one upstream`, async () => {
			const tag = uniqueTag(`tmt${kind}`);
			const client = localClient(tag, true);
			const marked = subscribeTicks(link(kind, client, tag, true), tag);
			const unmarked = subscribeTicks(link(kind, client, tag), tag);
			await waitFor(
				() => marked.data.length >= 2 && unmarked.data.length >= 2,
				{ message: "decoded events at both consumers" },
			);
			for (const feed of [marked, unmarked]) {
				expect(feed.errors).toEqual([]);
				const [first] = feed.data;
				expect(first?.data.at).toBeInstanceOf(Date);
				expect(first?.data.tags).toBeInstanceOf(Map);
			}
			// The marker is not identity: one upstream subscription serves both.
			expect((await tagCounters(tag))?.subscriptions).toBe(1);
		});
	}
});
