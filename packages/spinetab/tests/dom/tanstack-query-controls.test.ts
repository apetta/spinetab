import { QueryClient, QueryObserver } from "@tanstack/query-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpinetabError } from "../../src/core/errors.ts";
import type { ReconcileContext } from "../../src/core/reconcile.ts";
import { bindQuery } from "../../src/integrations/tanstack-query/index.ts";
import { createFakeClient, feed, macrotask } from "./helpers/fake-client.ts";

let queryClient: QueryClient;
afterEach(() => queryClient?.clear());

type Tick = { n: number };

describe("bindQuery flat options", () => {
	it("consumer and resume are flat, passed to subscribe as the bindings do", () => {
		queryClient = new QueryClient();
		const client = createFakeClient();
		const resume = () => undefined;
		bindQuery<Tick>(client, feed("t"), {
			queryClient,
			queryKey: ["tick"],
			consumer: { intervalMs: 30_000, whileHidden: undefined },
			resume,
		});
		expect(client.consumers[0]?.options).toEqual({
			consumer: { intervalMs: 30_000, whileHidden: undefined },
			resume,
		});
		bindQuery<Tick>(client, feed("t"), { queryClient, queryKey: ["tick"] });
		expect(client.consumers[1]?.options).toEqual({});
	});
});

describe("bindQuery declared writes", () => {
	it("queryKey alone writes each event; map projects it", () => {
		queryClient = new QueryClient();
		const client = createFakeClient();
		bindQuery<Tick>(client, feed("a"), { queryClient, queryKey: ["raw"] });
		bindQuery<Tick, number>(client, feed("a"), {
			queryClient,
			queryKey: ["n"],
			map: (tick) => tick.n,
		});
		client.emit({ n: 3 });
		expect(queryClient.getQueryData(["raw"])).toEqual({ n: 3 });
		expect(queryClient.getQueryData(["n"])).toBe(3);
	});

	it("reduce accumulates; returning undefined changes nothing", () => {
		queryClient = new QueryClient();
		const client = createFakeClient();
		const onEvent = vi.fn();
		bindQuery<Tick, number[]>(client, feed("a"), {
			queryClient,
			queryKey: ["list"],
			reduce: (current, tick) =>
				tick.n < 0 ? undefined : [...(current ?? []), tick.n],
			onEvent,
		});
		client.emit({ n: 1 });
		client.emit({ n: -1 });
		client.emit({ n: 2 });
		expect(queryClient.getQueryData(["list"])).toEqual([1, 2]);
		// onEvent stays the custom recipe alongside a declared write.
		expect(onEvent).toHaveBeenCalledTimes(3);
		expect(onEvent.mock.calls[0]?.[1]).toHaveProperty("markReconciled");
	});

	it("inconsistent write options fail synchronously with unsupported-option at their path", () => {
		queryClient = new QueryClient();
		const client = createFakeClient();
		const cases: Array<[Record<string, unknown>, string]> = [
			[
				{ queryKey: ["k"], map: (x: unknown) => x, reduce: () => 1 },
				"options.reduce",
			],
			[{ map: (x: unknown) => x, onEvent() {} }, "options.map"],
			[{ reduce: () => 1, onEvent() {} }, "options.reduce"],
			[{}, "options.onEvent"],
			[{ onEvent() {}, reconcile: "invalidate" }, "options.reconcile"],
		];
		for (const [options, path] of cases) {
			let caught: unknown;
			try {
				bindQuery(client, feed("a"), { queryClient, ...options });
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(SpinetabError);
			expect(caught).toMatchObject({
				code: "unsupported-option",
				detail: { path },
			});
		}
		expect(client.counts.subscribes).toBe(0);
	});
});

describe("bindQuery reconcile", () => {
	it('reconcile "invalidate" invalidates queryKey while connected, then declares it reconciled once the active query refetched', async () => {
		queryClient = new QueryClient();
		const client = createFakeClient();
		const invalidate = vi.spyOn(queryClient, "invalidateQueries");
		const onError = vi.fn();
		// An active query with fresh data: the invalidation refetches it.
		queryClient.setQueryData(["tick"], { n: 0 });
		const refetch = vi.fn(async () => ({ n: 1 }));
		const stop = new QueryObserver(queryClient, {
			queryKey: ["tick"],
			queryFn: refetch,
			staleTime: Number.POSITIVE_INFINITY,
		}).subscribe(() => {});
		const binding = bindQuery<Tick>(client, feed("a"), {
			queryClient,
			queryKey: ["tick"],
			reconcile: "invalidate",
			onError,
		});
		client.setContinuity("gap", "overflow");
		await macrotask();
		// Not connected yet: the refresh waits for `connected`.
		expect(invalidate).not.toHaveBeenCalled();
		// A stopped gap restarts delivery first, so nothing is lost meanwhile.
		expect(client.consumers[0]?.pendingReconciles).toBe(1);
		client.setConnection("connected");
		await vi.waitFor(() =>
			expect(binding.subscription.status.get().continuity.state).toBe(
				"continuous",
			),
		);
		expect(invalidate).toHaveBeenCalledTimes(1);
		expect(invalidate.mock.calls[0]?.[0]).toEqual({ queryKey: ["tick"] });
		expect(refetch).toHaveBeenCalledTimes(1);
		expect(queryClient.getQueryData(["tick"])).toEqual({ n: 1 });
		// A configured policy is the confirmation: no continuity-lost error.
		expect(onError).not.toHaveBeenCalled();
		stop();
	});

	it("reconcile { queryKey } invalidates that key", async () => {
		queryClient = new QueryClient();
		const client = createFakeClient();
		const invalidate = vi.spyOn(queryClient, "invalidateQueries");
		queryClient.setQueryData(["other"], 0);
		const stop = new QueryObserver(queryClient, {
			queryKey: ["other"],
			queryFn: async () => 1,
			staleTime: Number.POSITIVE_INFINITY,
		}).subscribe(() => {});
		const onError = vi.fn();
		const binding = bindQuery<Tick>(client, feed("a"), {
			queryClient,
			onEvent() {},
			reconcile: { queryKey: ["other"] },
			onError,
		});
		client.setConnection("connected");
		client.setContinuity("unknown", "reconnected");
		await vi.waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
		expect(invalidate.mock.calls[0]?.[0]).toEqual({ queryKey: ["other"] });
		await vi.waitFor(() =>
			expect(binding.subscription.status.get().continuity.state).toBe(
				"continuous",
			),
		);
		expect(onError).not.toHaveBeenCalled();
		stop();
	});

	it("a reconcile function is the refresh; its failure reaches onError", async () => {
		queryClient = new QueryClient();
		const client = createFakeClient();
		const onError = vi.fn();
		const refresh = vi.fn(async (_context: ReconcileContext) => {
			throw new Error("reload failed");
		});
		bindQuery<Tick>(client, feed("a"), {
			queryClient,
			queryKey: ["tick"],
			reconcile: refresh,
			onError,
		});
		client.setConnection("connected");
		client.setContinuity("unknown", "reconnected");
		await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
		expect(refresh.mock.calls[0]?.[0]).toMatchObject({
			continuity: { state: "unknown", reason: "reconnected" },
		});
		expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(SpinetabError);
		expect(client.consumers[0]?.reconciled).toBe(0);
	});

	it('reconcile "latest": a loss restarts delivery and the next event declares it reconciled', () => {
		queryClient = new QueryClient();
		const client = createFakeClient();
		const binding = bindQuery<Tick, number>(client, feed("a"), {
			queryClient,
			queryKey: ["n"],
			map: (tick) => tick.n,
			reconcile: "latest",
		});
		client.setContinuity("gap", "overflow");
		expect(client.consumers[0]?.pendingReconciles).toBe(1);
		expect(binding.subscription.status.get().continuity.state).toBe("gap");
		client.emit({ n: 9 });
		expect(queryClient.getQueryData(["n"])).toBe(9);
		expect(binding.subscription.status.get().continuity.state).toBe(
			"continuous",
		);
	});

	it("unsubscribe stops the engine", async () => {
		queryClient = new QueryClient();
		const client = createFakeClient({ leaky: true });
		const invalidate = vi.spyOn(queryClient, "invalidateQueries");
		const binding = bindQuery<Tick>(client, feed("a"), {
			queryClient,
			queryKey: ["tick"],
			reconcile: "invalidate",
		});
		binding.unsubscribe();
		client.consumers[0]?.status.set({
			active: true,
			connection: { state: "connected", since: 2 },
			continuity: { state: "unknown", reason: "reconnected", since: 2 },
		});
		await macrotask();
		expect(invalidate).not.toHaveBeenCalled();
	});
});

describe("bindQuery loud default (P-TQ-3)", () => {
	it("P-TQ-3 without a policy, gap and unknown reach onError as continuity-lost once per notice", () => {
		queryClient = new QueryClient();
		const client = createFakeClient();
		const onError = vi.fn();
		bindQuery<Tick>(client, feed("a"), {
			queryClient,
			queryKey: ["tick"],
			onError,
		});
		client.setContinuity("gap", "overflow");
		client.setContinuity("gap", "overflow");
		client.setContinuity("resumed", "resumed-with-cursor");
		client.setContinuity("unknown", "reconnected");
		expect(onError.mock.calls.map(([error]) => error.code)).toEqual([
			"continuity-lost",
			"continuity-lost",
		]);
		expect(onError.mock.calls[0]?.[0]).toMatchObject({
			detail: { state: "gap", reason: "overflow" },
		});
		expect(onError.mock.calls[0]?.[1]).toHaveProperty("retry");
	});

	it("P-TQ-3 onContinuity is the custom recipe: it takes the notice instead of onError", () => {
		queryClient = new QueryClient();
		const client = createFakeClient();
		const onError = vi.fn();
		const onContinuity = vi.fn((_continuity, tools) => tools.markReconciled());
		bindQuery<Tick>(client, feed("a"), {
			queryClient,
			onEvent() {},
			onContinuity,
			onError,
		});
		client.setContinuity("gap", "overflow");
		expect(onContinuity).toHaveBeenCalledTimes(1);
		expect(client.consumers[0]?.reconciled).toBe(1);
		expect(onError).not.toHaveBeenCalled();
	});

	it("without onError a terminal error or an unreconciled loss is rethrown into the client's callback guard", () => {
		queryClient = new QueryClient();
		const client = createFakeClient();
		bindQuery<Tick>(client, feed("a"), { queryClient, queryKey: ["tick"] });
		expect(() => client.setContinuity("gap", "overflow")).toThrow(
			expect.objectContaining({ code: "continuity-lost" }),
		);
		expect(() =>
			client.fail({ code: "subscribe-rejected", message: "no" }),
		).toThrow(expect.objectContaining({ code: "subscribe-rejected" }));
	});
});

describe("bindQuery controls", () => {
	it("tools.retry retries this subscription only; onStatus receives the tools", () => {
		queryClient = new QueryClient();
		const client = createFakeClient();
		const onStatus = vi.fn();
		bindQuery<Tick>(client, feed("a"), {
			queryClient,
			queryKey: ["tick"],
			onStatus,
		});
		client.setConnection("retry-exhausted");
		const tools = onStatus.mock.calls[0]?.[1];
		tools.retry();
		expect(client.consumers[0]?.retries).toBe(1);
		expect(client.counts.retries).toBe(0);
		tools.markReconciled({ pending: true });
		expect(client.consumers[0]?.pendingReconciles).toBe(1);
	});
});

describe("bindQuery refresh failures and cancellation", () => {
	it("without onError a subscription error is rethrown as core's own object", () => {
		const client = createFakeClient();
		const queryClient = new QueryClient();
		const binding = bindQuery(client, feed("a"), {
			queryClient,
			onEvent() {},
		});
		const error = new SpinetabError("upstream-error", "upstream text");
		let thrown: unknown;
		try {
			client.fail(error);
		} catch (caught) {
			thrown = caught;
		}
		binding.unsubscribe();
		expect(thrown).toBe(error);
	});

	it("without onError the binding's own continuity-lost and failed reports carry a code and a fixed sentence only", () => {
		const client = createFakeClient();
		const queryClient = new QueryClient();
		const binding = bindQuery(client, feed("a"), {
			queryClient,
			onEvent() {},
		});
		const thrown: unknown[] = [];
		const capture = (action: () => void) => {
			try {
				action();
			} catch (caught) {
				thrown.push(caught);
			}
		};
		capture(() => client.setContinuity("gap", "overflow"));
		capture(() => client.setConnection("failed", "credentials-audience"));
		binding.unsubscribe();
		expect(
			thrown.map((error) => {
				const record = error as SpinetabError;
				return { code: record.code, detail: record.detail };
			}),
		).toEqual([
			{ code: "continuity-lost", detail: undefined },
			{ code: "upstream-error", detail: undefined },
		]);
		for (const error of thrown) {
			expect((error as Error).message).not.toMatch(/overflow|credentials/);
		}
	});

	it("an unknown reconcile is refused before anything subscribes", () => {
		const client = createFakeClient();
		const queryClient = new QueryClient();
		for (const reconcile of [null, "refetch", { queryKey: undefined }, {}]) {
			expect(() =>
				bindQuery(client, feed("a"), {
					queryClient,
					onEvent() {},
					reconcile: reconcile as never,
				}),
			).toThrow(expect.objectContaining({ code: "unsupported-option" }));
		}
		expect(client.counts.subscribes).toBe(0);
	});
});
