import {
	focusManager,
	onlineManager,
	QueryClient,
	QueryObserver,
} from "@tanstack/query-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindQuery } from "../../src/integrations/tanstack-query/index.ts";
import { createFakeClient, feed, request } from "./helpers/fake-client.ts";

// DOM-TQ-01…05: a real @tanstack/query-core 5.104 QueryClient.

let queryClient: QueryClient;
afterEach(() => queryClient?.clear());

type Delta = { id: string; version: number; value: number };

describe("bindQuery", () => {
	it("DOM-TQ-01 touches the cache only through application callbacks and never takes over managers or defaults", () => {
		queryClient = new QueryClient();
		const spies = [
			vi.spyOn(queryClient, "setQueryData"),
			vi.spyOn(queryClient, "setQueriesData"),
			vi.spyOn(queryClient, "invalidateQueries"),
			vi.spyOn(queryClient, "getQueryData"),
			vi.spyOn(queryClient, "mount"),
			vi.spyOn(queryClient, "unmount"),
			vi.spyOn(queryClient, "setDefaultOptions"),
			vi.spyOn(queryClient, "setQueryDefaults"),
			vi.spyOn(queryClient, "refetchQueries"),
			vi.spyOn(focusManager, "setFocused"),
			vi.spyOn(focusManager, "setEventListener"),
			vi.spyOn(onlineManager, "setOnline"),
			vi.spyOn(onlineManager, "setEventListener"),
		];
		const client = createFakeClient();
		// Without a policy the loss reaches onError as continuity-lost.
		const onError = vi.fn();
		const binding = bindQuery<Delta>(client, request("prices") as never, {
			queryClient,
			onEvent: () => {},
			onError,
		});
		client.setContinuity("gap", "overflow");
		client.setConnection("reconnecting");
		expect(onError.mock.calls.map(([error]) => error.code)).toEqual([
			"continuity-lost",
		]);
		binding.unsubscribe();
		binding.unsubscribe();
		for (const spy of spies) expect(spy).not.toHaveBeenCalled();
		expect(client.counts.unsubscribes).toBe(1);

		const applied = bindQuery<Delta>(client, request("prices") as never, {
			queryClient,
			onEvent: (event, tools) => {
				tools.setQueryData(["price", event.id], event.value);
			},
		});
		client.emit({ id: "x", version: 1, value: 10 }, (c) => !c.closed);
		expect(queryClient.getQueryData(["price", "x"])).toBe(10);
		expect(spies[0]).toHaveBeenCalledTimes(1);
		applied.unsubscribe();
	});

	it("DOM-TQ-02 continuity reaches onContinuity once per episode; the binding stays open through resumable states", () => {
		queryClient = new QueryClient();
		const client = createFakeClient();
		const onContinuity = vi.fn((_continuity, tools) =>
			tools.invalidateQueries({ queryKey: ["price"] }),
		);
		const onError = vi.fn();
		const onStatus = vi.fn();
		const invalidate = vi.spyOn(queryClient, "invalidateQueries");
		bindQuery(client, request("prices") as never, {
			queryClient,
			onEvent: () => {},
			onContinuity,
			onError,
			onStatus,
		});
		client.setContinuity("gap", "overflow");
		client.setContinuity("gap", "overflow");
		expect(onContinuity).toHaveBeenCalledTimes(1);
		client.setContinuity("continuous", "reconciled");
		client.setContinuity("unknown", "reconnected");
		client.setContinuity("resumed", "resumed-with-cursor");
		expect(onContinuity.mock.calls.map(([c]) => c.state)).toEqual([
			"gap",
			"unknown",
			"resumed",
		]);
		// Invalidation happens only because the application callback asked.
		expect(invalidate).toHaveBeenCalledTimes(3);
		for (const state of [
			"reconnecting",
			"retry-exhausted",
			"auth-blocked",
		] as const) {
			client.setConnection(state);
		}
		expect(onError).not.toHaveBeenCalled();
		expect(client.active()).toHaveLength(1);
		client.setConnection("failed", "permanent-error");
		client.setConnection("failed", "permanent-error");
		expect(onError).toHaveBeenCalledTimes(1);
		expect(onError.mock.calls[0]?.[0]).toMatchObject({
			code: "upstream-error",
		});
		client.fail({ code: "subscribe-rejected", message: "no" });
		expect(onError).toHaveBeenCalledTimes(2);
		expect(onStatus).toHaveBeenCalled();
	});

	it("DOM-TQ-03 an updater returning undefined for a missing entry leaves the cache untouched", () => {
		queryClient = new QueryClient();
		const client = createFakeClient();
		bindQuery<Delta>(client, request("prices") as never, {
			queryClient,
			onEvent: (event, tools) => {
				tools.setQueryData<number>(["price", event.id], (current) =>
					current === undefined ? undefined : current + event.value,
				);
			},
		});
		client.emit({ id: "missing", version: 1, value: 5 });
		expect(
			queryClient.getQueryCache().find({ queryKey: ["price", "missing"] }),
		).toBeUndefined();
		queryClient.setQueryData(["price", "known"], 1);
		client.emit({ id: "known", version: 1, value: 5 });
		expect(queryClient.getQueryData(["price", "known"])).toBe(6);
	});

	it("DOM-TQ-04 events arrive in order with metadata; the application's watermark decides, a naive apply-all is wrong", async () => {
		// Snapshot fetched at version 2 while deltas v1..v4 stream in.
		const run = async (watermark: boolean) => {
			queryClient = new QueryClient();
			const client = createFakeClient();
			const pending: Delta[] = [];
			const seqs: number[] = [];
			bindQuery<Delta>(client, request("prices") as never, {
				queryClient,
				onEvent: (event, tools, meta) => {
					seqs.push(meta.seq);
					const current = tools.getQueryData<{
						version: number;
						value: number;
					}>(["price"]);
					if (!current) {
						pending.push(event);
						return;
					}
					if (watermark && event.version <= current.version) return;
					tools.setQueryData(["price"], {
						version: event.version,
						value: current.value + event.value,
					});
				},
			});
			let resolveFetch!: (value: { version: number; value: number }) => void;
			const fetching = queryClient.fetchQuery({
				queryKey: ["price"],
				queryFn: () =>
					new Promise<{ version: number; value: number }>((resolve) => {
						resolveFetch = resolve;
					}),
			});
			client.emit({ id: "p", version: 1, value: 1 });
			client.emit({ id: "p", version: 2, value: 1 });
			resolveFetch({ version: 2, value: 2 });
			await fetching;
			for (const event of pending.splice(0)) {
				const current = queryClient.getQueryData<{
					version: number;
					value: number;
				}>(["price"]);
				if (!current || (watermark && event.version <= current.version))
					continue;
				queryClient.setQueryData(["price"], {
					version: event.version,
					value: current.value + event.value,
				});
			}
			client.emit({ id: "p", version: 3, value: 1 });
			client.emit({ id: "p", version: 4, value: 1 });
			expect(seqs).toEqual([1, 2, 3, 4]);
			return queryClient.getQueryData<{ value: number }>(["price"])?.value;
		};
		expect(await run(true)).toBe(4);
		expect(await run(false)).not.toBe(4);
	});

	it("DOM-TQ-05 the reconnect outcome after an early notice with the same state and reason re-runs the reconcile recipe", async () => {
		queryClient = new QueryClient();
		const client = createFakeClient();
		const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
		// An active query whose refetches the test settles by hand.
		const fetches: Array<(value: number) => void> = [];
		queryClient.setQueryData(["tick"], 0);
		const observer = new QueryObserver(queryClient, {
			queryKey: ["tick"],
			queryFn: () =>
				new Promise<number>((resolve) => {
					fetches.push(resolve);
				}),
			staleTime: Number.POSITIVE_INFINITY,
		});
		const stop = observer.subscribe(() => {});
		const notices: Array<{ state: string; reason?: string; since: number }> =
			[];
		// A refetch-then-reconcile recipe whose refetches succeed; the failure
		// path is DOM-TQ-05b/05c (tanstack-query-reconcile.test.ts).
		const binding = bindQuery(client, request("prices") as never, {
			queryClient,
			onEvent: () => {},
			onContinuity(continuity, tools) {
				notices.push(continuity);
				void tools
					.invalidateQueries({ queryKey: ["tick"] })
					.then(() => binding.subscription.markReconciled());
			},
		});
		client.setConnection("connected");

		// Early notice at detection: the refetch starts while the upstream is down.
		now.mockReturnValue(2_000);
		client.setContinuity("unknown", "reconnected");
		client.setConnection("reconnecting");
		expect(fetches).toHaveLength(1);

		// The outcome immediately before `connected`, before the app reconciled.
		now.mockReturnValue(3_000);
		client.setContinuity("unknown", "reconnected");
		client.setConnection("connected");
		expect(notices).toMatchObject([
			{ state: "unknown", reason: "reconnected", since: 2_000 },
			{ state: "unknown", reason: "reconnected", since: 3_000 },
		]);
		expect(fetches).toHaveLength(2);

		for (const resolve of fetches) resolve(1);
		await vi.waitFor(() =>
			expect(client.active()[0]?.status.get().continuity).toMatchObject({
				state: "continuous",
				reason: "reconciled",
			}),
		);
		expect(client.active()[0]?.reconciled).toBe(2);

		// A genuine duplicate (the same notice, same since), also redelivered
		// with a connection change, is reported once.
		now.mockReturnValue(4_000);
		client.setContinuity("unknown", "reconnected");
		client.setContinuity("unknown", "reconnected");
		client.setConnection("reconnecting");
		expect(notices).toHaveLength(3);
		// A same-reason gap repeat (a stopped subscription's missed-count
		// update) stays coalesced until the application reconciles.
		now.mockReturnValue(5_000);
		client.setContinuity("gap", "overflow");
		now.mockReturnValue(6_000);
		client.setContinuity("gap", "overflow");
		expect(notices).toHaveLength(4);
		stop();
		binding.unsubscribe();
	});
});

describe("bindQuery with a source", () => {
	it("accepts a feed and subscribes its normalised request", () => {
		queryClient = new QueryClient();
		const client = createFakeClient();
		const binding = bindQuery(client, feed("prices"), {
			queryClient,
			onEvent: (event, tools) => {
				tools.setQueryData(["price"], event.n);
			},
		});
		expect(client.active().map((consumer) => consumer.request)).toEqual([
			request("prices"),
		]);
		client.emit({ n: 7 });
		expect(queryClient.getQueryData(["price"])).toBe(7);
		binding.unsubscribe();
		expect(client.counts.unsubscribes).toBe(1);
	});
});
