import { createTRPCClient, httpLink, splitLink } from "@trpc/client";
import superjson from "superjson";
import { afterEach, describe, expect, it } from "vitest";
import {
	spinetabSseLink,
	spinetabWsLink,
} from "../../../src/integrations/trpc/index.ts";
import {
	trpcSseAdapter,
	trpcWsAdapter,
} from "../../../src/integrations/trpc/runtime.ts";
import type {
	TrpcEvent,
	TrpcSubscriptionSpec,
} from "../../../src/integrations/trpc/spec.ts";
import type {
	FixtureTrpcRouter,
	TrpcTagCounters,
} from "../../fixtures/servers/trpc.ts";
import { type AdapterClient, createAdapterClient } from "./adapter-client.ts";
import { TestEventSource } from "./event-source.ts";
import {
	closedPort,
	createRecordingSink,
	createTestContext,
	primaryOrigin,
	readCounters,
	sleep,
	uniqueTag,
	waitFor,
	wsOrigin,
} from "./helpers.ts";

// Real @trpc/client 11.19.0 links (in the adapters) against a real
// @trpc/server 11.19.0 router with superjson. Covers P-I-13 and P-I-14.

type Tick = { n: number; at: Date; tags: Map<string, number> };

async function tagCounters(tag: string): Promise<TrpcTagCounters> {
	const all = await readCounters<{ tags: Record<string, TrpcTagCounters> }>(
		"trpc",
	);
	return all.tags[tag] as TrpcTagCounters;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function wsSetup(tag: string, token?: (revision: number) => string) {
	const adapter = trpcWsAdapter({
		transformer: superjson,
		retryDelayMs: () => 30,
	});
	const spec = { url: `${wsOrigin()}/trpc-ws?tag=${tag}`, retryAttempts: 3 };
	adapter.validateConnection?.(spec);
	const test = createTestContext({
		scope: tag,
		credentials: (revision) => ({
			connectionParams: {
				token: token?.(revision) ?? `valid-${tag}-${revision}`,
			},
		}),
		limits: { idleCloseMs: 200 },
	});
	const connection = adapter.connect(spec, test.ctx);
	cleanups.push(() => connection.dispose());
	const subscribe = (spec: TrpcSubscriptionSpec) => {
		adapter.validateSubscription?.(spec);
		const recording =
			createRecordingSink<TrpcEvent<{ id: string; data: Tick }>>();
		const subscription = connection.subscribe(spec, recording.sink as never, {
			key: JSON.stringify(spec),
			repeatable: true,
		});
		return { recording, subscription };
	};
	return { connection, test, subscribe };
}

describe("tRPC WebSocket adapter against the real router", () => {
	it("runs superjson in the worker and delivers tracked envelopes that survive structured clone (P-I-13)", async () => {
		const tag = uniqueTag("trw");
		const { subscribe, test } = wsSetup(tag);
		const feed = subscribe({ path: "ticks", input: { tag, intervalMs: 20 } });
		await waitFor(() => feed.recording.events.length >= 3);
		const [first] = feed.recording.events;
		expect(first?.id).toBe("1");
		// Upstream's tracked shape: result.data is `{ id, data }`.
		const cloned = structuredClone(first);
		expect(cloned?.data.id).toBe("1");
		expect(cloned?.data.data.at).toBeInstanceOf(Date);
		expect(cloned?.data.data.tags).toBeInstanceOf(Map);
		expect(cloned?.data.data.tags.get(tag)).toBe(1);
		expect(feed.recording.metas[0]).toEqual({ eventId: "1" });
		expect(test.hasStatus("connected")).toBe(true);
		expect((await tagCounters(tag)).lastEventIds).toEqual([null]);
	});

	it("forwards the cursor as lastEventId when Spinetab recreates the client (P-I-13)", async () => {
		const tag = uniqueTag("trr");
		const { subscribe, connection } = wsSetup(tag);
		const feed = subscribe({
			path: "ticks",
			input: { tag, intervalMs: 20 },
			replay: true,
		});
		await waitFor(() => feed.recording.events.length >= 3);
		connection.rotate?.();
		await waitFor(
			async () => (await tagCounters(tag)).lastEventIds.length === 2,
		);
		const [initial, resumed] = (await tagCounters(tag)).lastEventIds;
		expect(initial).toBeNull();
		const cursor = Number(resumed);
		expect(cursor).toBeGreaterThanOrEqual(3);
		await waitFor(() => feed.recording.continuity.length === 1);
		expect(feed.recording.continuity[0]).toMatchObject({
			reason: "resumed-with-cursor",
			cursor: String(cursor),
		});
		const before = feed.recording.events.length;
		await waitFor(() => feed.recording.events.length > before);
		// Resumed after the cursor: no duplicate or skipped ids.
		const ids = feed.recording.events.map((event) => Number(event.id));
		expect(ids).toEqual(ids.map((_, index) => index + 1));
	});

	it("upstream reconnect after a dropped socket resends the cursor itself (P-I-13)", async () => {
		const tag = uniqueTag("trd");
		const { subscribe } = wsSetup(tag);
		const feed = subscribe({ path: "ticks", input: { tag, intervalMs: 20 } });
		await waitFor(() => feed.recording.events.length >= 2);
		await fetch(`${primaryOrigin()}/trpc-control/terminate?tag=${tag}`, {
			method: "POST",
		});
		await waitFor(
			async () => (await tagCounters(tag)).lastEventIds.length === 2,
		);
		expect((await tagCounters(tag)).wsConnections).toBe(2);
		await waitFor(() => feed.recording.continuity.length === 2);
		// No declared replay: continuity is unknown, not "resumed". Once at
		// detection, then the reconnect outcome.
		expect(feed.recording.continuity).toEqual([
			{ reason: "reconnected" },
			{ reason: "reconnected" },
		]);
		expect(feed.recording.completions).toBe(0);
	});

	it("detects id:null UNAUTHORIZED context errors and blocks instead of looping (P-I-13)", async () => {
		const tag = uniqueTag("tra");
		const { subscribe, test, connection } = wsSetup(tag, (revision) =>
			revision === 1 ? `revoked-${tag}-1` : `valid-${tag}-${revision}`,
		);
		const feed = subscribe({ path: "ticks", input: { tag, intervalMs: 20 } });
		await waitFor(() => test.hasStatus("auth-blocked"));
		expect(test.lastStatus()).toMatchObject({
			state: "auth-blocked",
			reason: "credentials-rejected",
			code: "trpc:UNAUTHORIZED",
		});
		await sleep(300);
		expect((await tagCounters(tag)).wsConnections).toBe(1);
		expect(test.rejections).toEqual([1]);
		test.setRevision(2);
		connection.rotate?.();
		await waitFor(() => feed.recording.events.length >= 1);
		expect((await tagCounters(tag)).wsConnections).toBe(2);
		expect(feed.recording.errors).toEqual([]);
	});

	it("bounds upstream's unlimited reconnect loop with retry-exhausted (P-I-13)", async () => {
		const adapter = trpcWsAdapter({
			transformer: superjson,
			retryDelayMs: () => 20,
		});
		const test = createTestContext({
			credentials: () => ({ connectionParams: { token: "x" } }),
		});
		const port = await closedPort();
		const connection = adapter.connect(
			{ url: `ws://127.0.0.1:${port}/trpc-ws`, retryAttempts: 3 },
			test.ctx,
		);
		cleanups.push(() => connection.dispose());
		const recording = createRecordingSink<unknown>();
		connection.subscribe(
			{ path: "ticks", input: { tag: "none" } },
			recording.sink as never,
			{
				key: "k",
				repeatable: true,
			},
		);
		await waitFor(() => test.hasStatus("retry-exhausted"));
		expect(recording.completions + recording.errors.length).toBe(0);
	});
});

describe("tRPC SSE adapter with a header-capable EventSource", () => {
	function sseSetup(tag: string, token?: (revision: number) => string) {
		const adapter = trpcSseAdapter({
			transformer: superjson,
			EventSource: TestEventSource,
			headers: true,
			retryDelayMs: () => 30,
		});
		const test = createTestContext({
			scope: tag,
			credentials: (revision) => ({
				headers: {
					authorization: `Bearer ${token?.(revision) ?? `valid-${tag}-${revision}`}`,
				},
			}),
		});
		const connection = adapter.connect(
			{ url: `${primaryOrigin()}/trpc`, retryAttempts: 3 },
			test.ctx,
		);
		cleanups.push(() => connection.dispose());
		const subscribe = (spec: TrpcSubscriptionSpec) => {
			const recording =
				createRecordingSink<TrpcEvent<{ id: string; data: Tick }>>();
			connection.subscribe(spec, recording.sink as never, {
				key: JSON.stringify(spec),
				repeatable: true,
			});
			return recording;
		};
		return { connection, test, subscribe };
	}

	it("sends credentials only as headers and recreates with the cursor on rotation (P-I-14)", async () => {
		const tag = uniqueTag("trs");
		const { subscribe, connection } = sseSetup(tag);
		const feed = subscribe({
			path: "ticks",
			input: { tag, intervalMs: 20 },
			replay: true,
		});
		await waitFor(() => feed.events.length >= 3);
		expect(feed.events[0]?.data.data.at).toBeInstanceOf(Date);
		connection.rotate?.();
		await waitFor(
			async () => (await tagCounters(tag)).lastEventIds.length === 2,
		);
		const counters = await tagCounters(tag);
		expect(Number(counters.lastEventIds[1])).toBeGreaterThanOrEqual(3);
		expect(
			counters.urls.every(
				(url) => !url.includes("valid-") && !url.includes("token"),
			),
		).toBe(true);
		expect(counters.tokens).toEqual([`valid-${tag}-1`, `valid-${tag}-1`]);
		await waitFor(() => feed.continuity.length === 1);
		expect(feed.continuity[0]?.reason).toBe("resumed-with-cursor");
	});

	it("a rejected context blocks without retrying (P-I-14)", async () => {
		const tag = uniqueTag("trsa");
		const { subscribe, test } = sseSetup(tag, () => `revoked-${tag}-1`);
		subscribe({ path: "ticks", input: { tag } });
		await waitFor(() => test.hasStatus("auth-blocked"));
		// Observed with @trpc/server 11.19.0: a createContext failure on an SSE
		// subscription is streamed as a serialised UNAUTHORIZED error event on
		// a 200 response, not as an HTTP 401.
		expect(test.lastStatus()).toMatchObject({ code: "trpc:UNAUTHORIZED" });
		expect(test.rejections).toEqual([1]);
		await sleep(200);
		expect((await tagCounters(tag)).sseRequests).toBe(1);
	});
});

describe("spinetab tRPC page links in a real createTRPCClient", () => {
	function trpcClient(tag: string, kind: "ws" | "sse") {
		const spinetab: AdapterClient = createAdapterClient({
			adapters: [
				trpcWsAdapter({
					transformer: superjson,
					retryDelayMs: () => 30,
				}) as never,
				trpcSseAdapter({
					transformer: superjson,
					EventSource: TestEventSource,
					headers: true,
				}) as never,
			],
			scope: tag,
			credentials: (revision) => ({
				connectionParams: { token: `valid-${tag}-${revision}` },
				headers: { authorization: `Bearer valid-${tag}-${revision}` },
			}),
		});
		cleanups.push(() => spinetab.dispose());
		const subscriptionLink =
			kind === "ws"
				? spinetabWsLink<FixtureTrpcRouter>({
						client: spinetab,
						url: `${wsOrigin()}/trpc-ws?tag=${tag}`,
						replay: ["ticks"],
					})
				: spinetabSseLink<FixtureTrpcRouter>({
						client: spinetab,
						url: `${primaryOrigin()}/trpc`,
					});
		const client = createTRPCClient<FixtureTrpcRouter>({
			links: [
				splitLink({
					condition: (op) => op.type === "subscription",
					true: subscriptionLink,
					false: httpLink({
						url: `${primaryOrigin()}/trpc`,
						transformer: superjson,
						headers: { authorization: `Bearer valid-${tag}-1` },
					}),
				}),
			],
		});
		return { spinetab, client, subscriptionLink };
	}

	it("infers router types, keeps mutations on their link and resumes from the consumer cursor (P-I-13)", async () => {
		const tag = uniqueTag("trl");
		const { spinetab, client } = trpcClient(tag, "ws");
		const echoed = await client.echo.mutate({ hello: tag });
		expect(echoed).toEqual({ hello: tag });

		const data: Array<{ id: string; data: Tick }> = [];
		let started = 0;
		const subscription = client.ticks.subscribe(
			{ tag, intervalMs: 20 },
			{
				onStarted: () => {
					started += 1;
				},
				onData: (value) => {
					data.push(value);
				},
			},
		);
		cleanups.push(() => subscription.unsubscribe());
		await waitFor(() => data.length >= 3);
		expect(started).toBe(1);
		expect(data[0]?.data.at).toBeInstanceOf(Date);
		expect(data[0]?.id).toBe("1");
		// Page-side identity excludes the cursor; the worker saw one upstream.
		expect(spinetab.subscriptionKeys()).toHaveLength(1);

		// Runtime replacement: the link's resume hook forwards the consumer cursor.
		const cursor = data.at(-1)?.id;
		spinetab.replaceRuntime();
		await waitFor(
			async () => (await tagCounters(tag)).lastEventIds.length === 2,
		);
		expect((await tagCounters(tag)).lastEventIds[1]).toBe(cursor);
		const before = data.length;
		await waitFor(() => data.length > before);
		const ids = data.map((item) => Number(item.id));
		expect(ids).toEqual(ids.map((_, index) => index + 1));
	});

	it("errors a non-subscription operation that reaches the link (P-I-13)", async () => {
		const tag = uniqueTag("trn");
		const { subscriptionLink } = trpcClient(tag, "ws");
		const client = createTRPCClient<FixtureTrpcRouter>({
			links: [subscriptionLink],
		});
		await expect(client.echo.mutate({ x: 1 })).rejects.toThrow(
			/only handle subscriptions/,
		);
		await sleep(50);
		expect(await tagCounters(tag)).toBeUndefined();
	});

	it("SSE link: native-style EventSource path through the page link (P-I-14)", async () => {
		const tag = uniqueTag("trls");
		const { client } = trpcClient(tag, "sse");
		const data: Array<{ id: string; data: Tick }> = [];
		const subscription = client.ticks.subscribe(
			{ tag, intervalMs: 20, lastEventId: "5" },
			{ onData: (value) => void data.push(value) },
		);
		cleanups.push(() => subscription.unsubscribe());
		await waitFor(() => data.length >= 2);
		// The explicit starting cursor is forwarded to the server.
		expect((await tagCounters(tag)).lastEventIds).toEqual(["5"]);
		expect(data[0]?.id).toBe("6");
	});
});
