import {
	onlineManager,
	QueryClient,
	type QueryFunction,
	type QueryKey,
	QueryObserver,
	type QueryObserverOptions,
} from "@tanstack/query-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpinetabError } from "../../src/core/errors.ts";
import { createStore } from "../../src/core/store.ts";
import type {
	Continuity,
	SpinetabClient,
	Subscription,
	SubscriptionObserver,
	SubscriptionRequest,
	SubscriptionStatus,
} from "../../src/core/types.ts";
import {
	bindQuery,
	type QueryReconcile,
	type QueryTools,
} from "../../src/integrations/tanstack-query/index.ts";

// Reconciliation succeeds only after matching data has been refreshed. These
// cases cover failed refreshes, cancellation, listener cleanup, overlapping
// notices and application-owned snapshots using the real QueryClient.

type Tick = { n: number };

/** The contracted wrapper sentence for a failed refresh (with `onError`). */
const REFRESH_FAILED =
	"The reconcile refresh failed; continuity stays lost until a later refresh succeeds.";

/** The plain cause when a match was not refetched. */
const NOT_REFETCHED =
	"A matching query was not refetched: it is inactive, disabled, static, paused or cache-only, its refetch was cancelled, or its initial fetch without data was already running at the notice and was joined.";

const ticks: SubscriptionRequest<Tick> = {
	adapter: "test",
	connection: { url: "wss://example.test/feed" },
	subscription: { topic: "ticks" },
};

let queryClient: QueryClient | undefined;
afterEach(() => {
	queryClient?.clear();
	queryClient = undefined;
	// Every paused case also restores it in its own finally block.
	onlineManager.setOnline(true);
});

const macrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
async function settle(times = 3): Promise<void> {
	for (let turn = 0; turn < times; turn += 1) await macrotask();
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((onResolve, onReject) => {
		resolve = onResolve;
		reject = onReject;
	});
	return { promise, resolve, reject };
}

function newQueryClient(queries: Record<string, unknown> = {}): QueryClient {
	queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false, gcTime: Number.POSITIVE_INFINITY, ...queries },
		},
	});
	return queryClient;
}

/** An active query: one observer whose cached data is fresh (no mount fetch). */
function observe(
	client: QueryClient,
	queryKey: QueryKey,
	queryFn?: QueryFunction<unknown>,
	extra: Partial<QueryObserverOptions<unknown>> = {},
): () => void {
	return new QueryObserver<unknown>(client, {
		queryKey,
		...(queryFn ? { queryFn } : {}),
		staleTime: Number.POSITIVE_INFINITY,
		...extra,
	}).subscribe(() => {});
}

/** The QueryCache's listener count (protected in query-core; read for 10c). */
const cacheListeners = (client: QueryClient) =>
	(client.getQueryCache() as unknown as { listeners: Set<unknown> }).listeners
		.size;

/** Collects unhandled rejections until `stop()`. */
function trackUnhandled() {
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => {
		unhandled.push(reason);
	};
	process.on("unhandledRejection", onUnhandled);
	return {
		unhandled,
		stop: () => process.off("unhandledRejection", onUnhandled),
	};
}

/**
 * The application's backend: every call waits on its own gate. When TanStack
 * runs it as a `queryFn` (a component's query, or the withdrawn recipe), an
 * abort rejects that call. While `network.online` is false a call rejects at
 * once, as `fetch` does offline.
 */
function backend() {
	const gates: Array<ReturnType<typeof deferred<number>>> = [];
	const network = { online: true };
	const fetchTick = vi.fn(
		(context?: { signal?: AbortSignal }): Promise<number> => {
			if (!network.online) {
				return Promise.reject(new TypeError("Failed to fetch"));
			}
			const gate = deferred<number>();
			context?.signal?.addEventListener("abort", () =>
				gate.reject(new Error("aborted")),
			);
			gates.push(gate);
			return gate.promise;
		},
	);
	return { fetchTick, gates, network };
}

/**
 * A component's own fetch begun before the notice: a refetch over cached data
 * (7), or the initial fetch of a query without data. Returns the unsubscribe.
 */
function preNoticeFetch(
	client: QueryClient,
	key: QueryKey,
	fetchTick: QueryFunction<number>,
	withData: boolean,
): () => void {
	if (withData) client.setQueryData(key, 7);
	const observer = new QueryObserver<number>(client, {
		queryKey: key,
		queryFn: fetchTick,
		staleTime: Number.POSITIVE_INFINITY,
	});
	const stop = observer.subscribe(() => {});
	if (withData) void observer.refetch();
	return stop;
}

/**
 * A `SpinetabClient` with one subscription: a status store, `markReconciled`
 * (plain: `continuous/reconciled`; pending: counted, continuity kept) and
 * event delivery. Enough for bindQuery and the reconcile engine.
 */
function localClient() {
	const status = createStore<SubscriptionStatus>({
		active: true,
		connection: { state: "connecting", since: 1 },
		continuity: { state: "continuous", since: 1 },
	});
	let observer: SubscriptionObserver<Tick> | undefined;
	let seq = 0;
	let since = 1;
	const counts = { reconciled: 0, pending: 0 };
	const publish = (next: SubscriptionStatus) => {
		status.set(next);
		observer?.status?.(next);
	};
	const handle: Subscription<Tick> = {
		id: "local-1",
		status,
		update() {},
		markReconciled(options) {
			if (options?.pending) {
				counts.pending += 1;
				return;
			}
			counts.reconciled += 1;
			publish({
				...status.get(),
				continuity: {
					state: "continuous",
					reason: "reconciled",
					since: Date.now(),
				},
			});
		},
		retry() {},
		unsubscribe() {
			observer = undefined;
		},
	};
	const client = {
		subscribe(_source: unknown, next: SubscriptionObserver<Tick>) {
			observer = next;
			return handle;
		},
	} as unknown as SpinetabClient;
	return {
		client,
		counts,
		connection(state: SubscriptionStatus["connection"]["state"]) {
			publish({ ...status.get(), connection: { state, since: Date.now() } });
		},
		notice(state: "gap" | "unknown", reason: Continuity["reason"]) {
			// Strictly increasing: a repeated `unknown` notice (the outcome after
			// an early notice) is a new notice for bindQuery.
			since = Math.max(since + 1, Date.now());
			publish({ ...status.get(), continuity: { state, reason, since } });
		},
		emit(event: Tick) {
			seq += 1;
			observer?.next(event, { seq });
		},
	};
}

/** bindQuery with a reconcile policy; `lose()` connects and sends one loss notice. */
function start(
	client: QueryClient,
	options: {
		queryKey: QueryKey;
		reconcile: QueryReconcile;
		reduce?: (current: unknown, event: Tick) => unknown;
		withOnError?: boolean;
	},
) {
	const local = localClient();
	const onError = vi.fn<(error: SpinetabError, tools: QueryTools) => void>();
	const binding = bindQuery<Tick, unknown>(local.client, ticks, {
		queryClient: client,
		queryKey: options.queryKey,
		reconcile: options.reconcile,
		...(options.reduce ? { reduce: options.reduce } : {}),
		...(options.withOnError === false ? {} : { onError }),
	});
	return {
		...local,
		binding,
		onError,
		continuity: () => binding.subscription.status.get().continuity,
		lose() {
			local.connection("connected");
			local.notice("gap", "replay-reset");
		},
	};
}

/** The loss stays visible and onError receives the wrapped failure once. */
function expectLost(run: ReturnType<typeof start>): SpinetabError {
	expect(run.continuity().state).toBe("gap");
	expect(run.counts.reconciled).toBe(0);
	expect(run.onError).toHaveBeenCalledTimes(1);
	const error = run.onError.mock.calls[0]?.[0] as SpinetabError;
	expect(error).toBeInstanceOf(SpinetabError);
	expect(error).toMatchObject({
		code: "upstream-error",
		message: REFRESH_FAILED,
	});
	// A plain error from the refresh, wrapped by the binding with it as cause.
	expect(error.cause).toBeInstanceOf(Error);
	expect(error.cause).not.toBeInstanceOf(SpinetabError);
	return error;
}

describe('bindQuery reconcile "invalidate": a failed refetch is not reconciled', () => {
	it("DOM-TQ-07 root case 1: an active query whose refetch rejects keeps the loss visible and calls onError once", async () => {
		const client = newQueryClient();
		const key = ["review-feed"];
		client.setQueryData(key, { n: 7 });
		const backend = new Error("backend unavailable");
		const fetcher = vi.fn(async () => {
			throw backend;
		});
		const stop = observe(client, key, fetcher);
		const run = start(client, { queryKey: key, reconcile: "invalidate" });
		try {
			run.lose();
			await vi.waitFor(() =>
				expect(client.getQueryState(key)?.status).toBe("error"),
			);
			await settle();
			expect(fetcher).toHaveBeenCalledTimes(1);
			expect(client.getQueryData(key)).toEqual({ n: 7 });
			const error = expectLost(run);
			// The query's own error stays reachable for the application.
			expect((error.cause as Error).cause).toBe(backend);
		} finally {
			run.binding.unsubscribe();
			stop();
		}
	});

	it("DOM-TQ-07 the failed refresh runs again at the next connected and reconciles once the refetch succeeds", async () => {
		const client = newQueryClient();
		const key = ["retry-at-connected"];
		client.setQueryData(key, { n: 7 });
		let up = false;
		const fetcher = vi.fn(async () => {
			if (!up) throw new Error("backend unavailable");
			return { n: 8 };
		});
		const stop = observe(client, key, fetcher);
		const run = start(client, { queryKey: key, reconcile: "invalidate" });
		try {
			run.lose();
			await vi.waitFor(() => expect(run.onError).toHaveBeenCalledTimes(1));
			expect(run.continuity().state).toBe("gap");
			up = true;
			run.connection("reconnecting");
			run.connection("connected");
			await vi.waitFor(() => expect(run.counts.reconciled).toBe(1));
			expect(run.continuity()).toMatchObject({
				state: "continuous",
				reason: "reconciled",
			});
			expect(client.getQueryData(key)).toEqual({ n: 8 });
			expect(fetcher).toHaveBeenCalledTimes(2);
			expect(run.onError).toHaveBeenCalledTimes(1);
		} finally {
			run.binding.unsubscribe();
			stop();
		}
	});

	it("DOM-TQ-07 without onError the failure reaches the callback guard as a code and a fixed sentence only", async () => {
		const reported: unknown[] = [];
		vi.stubGlobal("reportError", (error: unknown) => {
			reported.push(error);
		});
		const client = newQueryClient();
		const key = ["guard"];
		client.setQueryData(key, { n: 7 });
		const stop = observe(client, key, async () => {
			throw new Error("backend unavailable at https://api.example.test");
		});
		const run = start(client, {
			queryKey: key,
			reconcile: "invalidate",
			withOnError: false,
		});
		try {
			run.lose();
			await vi.waitFor(() => expect(reported).toHaveLength(1));
			await settle();
			expect(reported).toHaveLength(1);
			const error = reported[0] as SpinetabError;
			expect(error).toBeInstanceOf(SpinetabError);
			expect({
				code: error.code,
				message: error.message,
				detail: error.detail,
				cause: error.cause,
			}).toEqual({
				code: "upstream-error",
				message:
					"upstream-error: the reconcile refresh failed; continuity stays lost until a later refresh succeeds; pass onError to receive the cause.",
				detail: undefined,
				cause: undefined,
			});
			expect(run.continuity().state).toBe("gap");
			expect(run.counts.reconciled).toBe(0);
		} finally {
			run.binding.unsubscribe();
			stop();
			vi.unstubAllGlobals();
		}
	});

	it("DOM-TQ-08 with retry 2 the loss stays visible after the third failed attempt", async () => {
		const client = newQueryClient({ retry: 2, retryDelay: 5 });
		const key = ["retries-fail"];
		client.setQueryData(key, { n: 7 });
		const fetcher = vi.fn(async () => {
			throw new Error("down");
		});
		const stop = observe(client, key, fetcher);
		const run = start(client, { queryKey: key, reconcile: "invalidate" });
		try {
			run.lose();
			await vi.waitFor(() =>
				expect(client.getQueryState(key)?.status).toBe("error"),
			);
			await settle();
			expect(fetcher).toHaveBeenCalledTimes(3);
			expectLost(run);
		} finally {
			run.binding.unsubscribe();
			stop();
		}
	});

	it("DOM-TQ-08 with retry 2 a third attempt that succeeds reconciles", async () => {
		const client = newQueryClient({ retry: 2, retryDelay: 5 });
		const key = ["retries-succeed"];
		client.setQueryData(key, { n: 7 });
		let attempt = 0;
		const fetcher = vi.fn(async () => {
			attempt += 1;
			if (attempt < 3) throw new Error("flaky");
			return { n: 9 };
		});
		const stop = observe(client, key, fetcher);
		const run = start(client, { queryKey: key, reconcile: "invalidate" });
		try {
			run.lose();
			await vi.waitFor(() => expect(run.counts.reconciled).toBe(1));
			expect(client.getQueryData(key)).toEqual({ n: 9 });
			expect(run.continuity().state).toBe("continuous");
			expect(run.onError).not.toHaveBeenCalled();
		} finally {
			run.binding.unsubscribe();
			stop();
		}
	});

	it("DOM-TQ-09 a { queryKey } prefix matching two active queries stays lost when one refetch fails", async () => {
		const client = newQueryClient();
		client.setQueryData(["todos", 1], { ok: 1 });
		client.setQueryData(["todos", 2], { bad: 1 });
		const ok = vi.fn(async () => ({ ok: 2 }));
		const bad = vi.fn(async () => {
			throw new Error("one of two fails");
		});
		const stopOk = observe(client, ["todos", 1], ok);
		const stopBad = observe(client, ["todos", 2], bad);
		const run = start(client, {
			queryKey: ["todos-write"],
			reconcile: { queryKey: ["todos"] },
		});
		try {
			run.lose();
			await vi.waitFor(() =>
				expect(client.getQueryState(["todos", 2])?.status).toBe("error"),
			);
			await settle();
			expect(ok).toHaveBeenCalledTimes(1);
			expect(bad).toHaveBeenCalledTimes(1);
			expectLost(run);
		} finally {
			run.binding.unsubscribe();
			stopOk();
			stopBad();
		}
	});

	it("DOM-TQ-10 an active query whose refetch succeeds reconciles (over-rejection guard)", async () => {
		const client = newQueryClient();
		const key = ["active-ok"];
		client.setQueryData(key, { n: 7 });
		const fetcher = vi.fn(async () => ({ n: 8 }));
		const stop = observe(client, key, fetcher);
		const run = start(client, { queryKey: key, reconcile: "invalidate" });
		try {
			run.lose();
			await vi.waitFor(() => expect(run.counts.reconciled).toBe(1));
			expect(fetcher).toHaveBeenCalledTimes(1);
			expect(client.getQueryData(key)).toEqual({ n: 8 });
			expect(run.continuity()).toMatchObject({
				state: "continuous",
				reason: "reconciled",
			});
			expect(run.onError).not.toHaveBeenCalled();
		} finally {
			run.binding.unsubscribe();
			stop();
		}
	});

	it("DOM-TQ-10 a refetch already in flight on a query with data is restarted (cancelRefetch) and reconciles", async () => {
		const client = newQueryClient();
		const key = ["inflight-with-data"];
		client.setQueryData(key, { n: 7 });
		const gates: Array<ReturnType<typeof deferred<{ n: number }>>> = [];
		const fetcher = vi.fn(() => {
			const gate = deferred<{ n: number }>();
			gates.push(gate);
			return gate.promise;
		});
		const observer = new QueryObserver(client, {
			queryKey: key,
			queryFn: fetcher,
			staleTime: Number.POSITIVE_INFINITY,
		});
		const stop = observer.subscribe(() => {});
		void observer.refetch();
		await macrotask();
		expect(fetcher).toHaveBeenCalledTimes(1);
		const run = start(client, { queryKey: key, reconcile: "invalidate" });
		try {
			run.lose();
			await macrotask();
			// The pre-notice fetch was cancelled silently; the restart is the refresh's.
			expect(fetcher).toHaveBeenCalledTimes(2);
			gates.at(-1)?.resolve({ n: 9 });
			await vi.waitFor(() => expect(run.counts.reconciled).toBe(1));
			expect(client.getQueryData(key)).toEqual({ n: 9 });
			expect(run.onError).not.toHaveBeenCalled();
		} finally {
			run.binding.unsubscribe();
			stop();
		}
	});

	it("DOM-TQ-10b a paused match that goes online and then fails leaves no unhandled rejection", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		const client = newQueryClient();
		client.mount();
		const key = ["paused-then-fails"];
		client.setQueryData(key, { n: 7 });
		const fetcher = vi.fn(async () => {
			throw new Error("backend unavailable");
		});
		const stop = observe(client, key, fetcher);
		const run = start(client, { queryKey: key, reconcile: "invalidate" });
		try {
			onlineManager.setOnline(false);
			run.lose();
			await vi.waitFor(() => expect(run.onError).toHaveBeenCalledTimes(1));
			expect(client.getQueryState(key)?.fetchStatus).toBe("paused");
			onlineManager.setOnline(true);
			await vi.waitFor(() =>
				expect(client.getQueryState(key)?.status).toBe("error"),
			);
			await settle();
			expect(fetcher).toHaveBeenCalledTimes(1);
			expect(unhandled).toEqual([]);
			expectLost(run);
		} finally {
			onlineManager.setOnline(true);
			process.off("unhandledRejection", onUnhandled);
			run.binding.unsubscribe();
			stop();
			client.unmount();
		}
	});

	it("DOM-TQ-10c the QueryCache listener lasts only for the call: after a resolve, a reject and an unsubscribe while pending", async () => {
		const client = newQueryClient();
		const baseline = cacheListeners(client);

		client.setQueryData(["resolves"], { n: 1 });
		const stopOk = observe(client, ["resolves"], async () => ({ n: 2 }));
		const resolves = start(client, {
			queryKey: ["resolves"],
			reconcile: "invalidate",
		});
		resolves.lose();
		await vi.waitFor(() => expect(resolves.counts.reconciled).toBe(1));
		expect(cacheListeners(client)).toBe(baseline);

		client.setQueryData(["rejects"], { n: 1 });
		const stopBad = observe(client, ["rejects"], async () => {
			throw new Error("down");
		});
		const rejects = start(client, {
			queryKey: ["rejects"],
			reconcile: "invalidate",
		});
		rejects.lose();
		await vi.waitFor(() => expect(rejects.onError).toHaveBeenCalledTimes(1));
		expect(cacheListeners(client)).toBe(baseline);

		client.setQueryData(["pending"], { n: 1 });
		const gate = deferred<{ n: number }>();
		const stopPending = observe(client, ["pending"], () => gate.promise);
		const pending = start(client, {
			queryKey: ["pending"],
			reconcile: "invalidate",
		});
		try {
			pending.lose();
			await macrotask();
			expect(cacheListeners(client)).toBe(baseline + 1);
			pending.binding.unsubscribe();
			gate.resolve({ n: 2 });
			await settle();
			expect(cacheListeners(client)).toBe(baseline);
			// An in-flight refresh declares nothing after unsubscribe.
			expect(pending.counts.reconciled).toBe(0);
			expect(pending.onError).not.toHaveBeenCalled();
		} finally {
			resolves.binding.unsubscribe();
			rejects.binding.unsubscribe();
			pending.binding.unsubscribe();
			stopOk();
			stopBad();
			stopPending();
		}
	});

	it("DOM-TQ-10c an error on a query that did not match does not reject the refresh", async () => {
		const client = newQueryClient();
		client.setQueryData(["todos", 1], { n: 1 });
		client.setQueryData(["other"], { n: 1 });
		const gate = deferred<{ n: number }>();
		const stopTodos = observe(client, ["todos", 1], () => gate.promise);
		const other = new QueryObserver(client, {
			queryKey: ["other"],
			queryFn: async () => {
				throw new Error("unrelated");
			},
			staleTime: Number.POSITIVE_INFINITY,
		});
		const stopOther = other.subscribe(() => {});
		const run = start(client, {
			queryKey: ["todos-write"],
			reconcile: { queryKey: ["todos"] },
		});
		try {
			run.lose();
			// While the matched refetch is in flight, an unrelated query fails.
			await other.refetch();
			expect(client.getQueryState(["other"])?.status).toBe("error");
			gate.resolve({ n: 2 });
			await vi.waitFor(() => expect(run.counts.reconciled).toBe(1));
			expect(run.onError).not.toHaveBeenCalled();
		} finally {
			run.binding.unsubscribe();
			stopTodos();
			stopOther();
		}
	});

	for (const outcome of ["answers", "fails"] as const) {
		it(`DOM-TQ-10d unsubscribe while the refresh waits on the application's fetch releases the QueryCache listener at once; the fetch is not cancelled, ${outcome} as usual, and nothing is declared`, async () => {
			const client = newQueryClient();
			const key = ["independent-cleanup"];
			client.setQueryData(key, { n: 1 });
			const gate = deferred<{ n: number }>();
			const signals: AbortSignal[] = [];
			const fetcher = vi.fn((context: { signal: AbortSignal }) => {
				signals.push(context.signal);
				return gate.promise;
			});
			const observer = new QueryObserver(client, {
				queryKey: key,
				queryFn: fetcher,
				staleTime: Number.POSITIVE_INFINITY,
			});
			const stop = observer.subscribe(() => {});
			const baseline = cacheListeners(client);
			const run = start(client, { queryKey: key, reconcile: "invalidate" });
			const tracked = trackUnhandled();
			try {
				run.lose();
				await vi.waitFor(() =>
					expect(cacheListeners(client)).toBe(baseline + 1),
				);
				expect(fetcher).toHaveBeenCalledTimes(1);
				// The application's own promise on that fetch (joined, not restarted).
				const application = observer.refetch({ cancelRefetch: false });
				run.binding.unsubscribe();
				// Released at once, while the application's fetch is still pending...
				expect(cacheListeners(client)).toBe(baseline);
				//...which unsubscribe neither cancels nor restarts.
				expect(client.getQueryState(key)?.fetchStatus).toBe("fetching");
				expect(signals[0]?.aborted).toBe(false);
				if (outcome === "answers") gate.resolve({ n: 2 });
				else gate.reject(new Error("backend unavailable"));
				const result = await application;
				expect(result.status).toBe(outcome === "answers" ? "success" : "error");
				expect(client.getQueryData(key)).toEqual(
					outcome === "answers" ? { n: 2 } : { n: 1 },
				);
				expect(fetcher).toHaveBeenCalledTimes(1);
				await settle();
				// The abandoned refresh declares nothing and reports nothing.
				expect(run.counts.reconciled).toBe(0);
				expect(run.onError).not.toHaveBeenCalled();
				expect(run.continuity().state).toBe("gap");
				expect(cacheListeners(client)).toBe(baseline);
				expect(tracked.unhandled).toEqual([]);
			} finally {
				tracked.stop();
				run.binding.unsubscribe();
				stop();
			}
		});
	}
});

describe('bindQuery reconcile "invalidate": nothing refetched is not reconciled', () => {
	it("DOM-TQ-11 root case 2: an inactive query (queryFn from setQueryDefaults, no observer) is not refetched and stays lost", async () => {
		const client = newQueryClient();
		const key = ["review-inactive"];
		const fetcher = vi.fn(async () => ({ n: 8 }));
		client.setQueryDefaults(key, { queryFn: fetcher });
		client.setQueryData(key, { n: 7 });
		const run = start(client, { queryKey: key, reconcile: "invalidate" });
		try {
			run.lose();
			await vi.waitFor(() => expect(run.onError).toHaveBeenCalledTimes(1));
			await settle();
			expect(fetcher).not.toHaveBeenCalled();
			expect(client.getQueryData(key)).toEqual({ n: 7 });
			expect(client.getQueryState(key)?.isInvalidated).toBe(true);
			expectLost(run);
		} finally {
			run.binding.unsubscribe();
		}
	});

	it("DOM-TQ-11 a cache-only key (no observer, no queryFn) stays lost", async () => {
		const client = newQueryClient();
		const key = ["cache-only"];
		client.setQueryData(key, { n: 7 });
		const run = start(client, { queryKey: key, reconcile: "invalidate" });
		try {
			run.lose();
			await vi.waitFor(() => expect(run.onError).toHaveBeenCalledTimes(1));
			expectLost(run);
		} finally {
			run.binding.unsubscribe();
		}
	});

	it("DOM-TQ-12 a paused query (offline) stays lost while its fetch is paused", async () => {
		const client = newQueryClient();
		const key = ["paused"];
		client.setQueryData(key, { n: 7 });
		const fetcher = vi.fn(async () => ({ n: 8 }));
		const stop = observe(client, key, fetcher);
		const run = start(client, { queryKey: key, reconcile: "invalidate" });
		try {
			onlineManager.setOnline(false);
			run.lose();
			await vi.waitFor(() => expect(run.onError).toHaveBeenCalledTimes(1));
			expect(client.getQueryState(key)?.fetchStatus).toBe("paused");
			expect(fetcher).not.toHaveBeenCalled();
			expectLost(run);
		} finally {
			onlineManager.setOnline(true);
			run.binding.unsubscribe();
			stop();
		}
	});

	it("DOM-TQ-12 a declared write while the refetch is paused is not taken for the refetch", async () => {
		const client = newQueryClient();
		const key = ["paused-write"];
		client.setQueryData(key, { n: 7 });
		const fetcher = vi.fn(async () => ({ n: 8 }));
		const stop = observe(client, key, fetcher);
		const run = start(client, { queryKey: key, reconcile: "invalidate" });
		try {
			onlineManager.setOnline(false);
			run.lose();
			// An event arrives during the refresh; the binding writes it with
			// setQueryData, a manual success on the matched query.
			run.emit({ n: 9 });
			await vi.waitFor(() => expect(run.onError).toHaveBeenCalledTimes(1));
			expect(client.getQueryData(key)).toEqual({ n: 9 });
			expect(fetcher).not.toHaveBeenCalled();
			expectLost(run);
		} finally {
			onlineManager.setOnline(true);
			run.binding.unsubscribe();
			stop();
		}
	});

	it("DOM-TQ-13 a disabled observer (enabled: false) is skipped and stays lost", async () => {
		const client = newQueryClient();
		const key = ["disabled"];
		client.setQueryData(key, { n: 7 });
		const fetcher = vi.fn(async () => ({ n: 8 }));
		const stop = observe(client, key, fetcher, { enabled: false });
		const run = start(client, { queryKey: key, reconcile: "invalidate" });
		try {
			run.lose();
			await vi.waitFor(() => expect(run.onError).toHaveBeenCalledTimes(1));
			expect(fetcher).not.toHaveBeenCalled();
			expectLost(run);
		} finally {
			run.binding.unsubscribe();
			stop();
		}
	});

	it("DOM-TQ-13 a static query (staleTime: 'static') is skipped and stays lost", async () => {
		const client = newQueryClient();
		const key = ["static"];
		client.setQueryData(key, { n: 7 });
		const fetcher = vi.fn(async () => ({ n: 8 }));
		const stop = observe(client, key, fetcher, { staleTime: "static" });
		const run = start(client, { queryKey: key, reconcile: "invalidate" });
		try {
			run.lose();
			await vi.waitFor(() => expect(run.onError).toHaveBeenCalledTimes(1));
			expect(fetcher).not.toHaveBeenCalled();
			expectLost(run);
		} finally {
			run.binding.unsubscribe();
			stop();
		}
	});

	it("DOM-TQ-14 an initial fetch without data already in flight at the notice is joined, not refetched, and stays lost", async () => {
		const client = newQueryClient();
		const key = ["inflight-no-data"];
		const gates: Array<ReturnType<typeof deferred<{ n: number }>>> = [];
		const fetcher = vi.fn(() => {
			const gate = deferred<{ n: number }>();
			gates.push(gate);
			return gate.promise;
		});
		const stop = observe(client, key, fetcher);
		await macrotask();
		expect(fetcher).toHaveBeenCalledTimes(1);
		const run = start(client, { queryKey: key, reconcile: "invalidate" });
		try {
			run.lose();
			await macrotask();
			gates[0]?.resolve({ n: 1 });
			await vi.waitFor(() => expect(run.onError).toHaveBeenCalledTimes(1));
			// No fetch started after the notice: the joined one began before it.
			expect(fetcher).toHaveBeenCalledTimes(1);
			expectLost(run);
		} finally {
			run.binding.unsubscribe();
			stop();
		}
	});

	it("DOM-TQ-14 the plain cause names the lost cases as the invalidate list does: a joined initial fetch without data was not refetched", async () => {
		const client = newQueryClient();
		const key = ["inflight-no-data-cause"];
		const gate = deferred<{ n: number }>();
		const stop = observe(client, key, () => gate.promise);
		await macrotask();
		const run = start(client, { queryKey: key, reconcile: "invalidate" });
		try {
			run.lose();
			await macrotask();
			gate.resolve({ n: 1 });
			await vi.waitFor(() => expect(run.onError).toHaveBeenCalledTimes(1));
			const error = expectLost(run);
			expect((error.cause as Error).message).toBe(NOT_REFETCHED);
		} finally {
			run.binding.unsubscribe();
			stop();
		}
	});

	it("DOM-TQ-15 a refetch the application cancels (cancelQueries reverts) stays lost", async () => {
		const client = newQueryClient();
		const key = ["cancelled"];
		client.setQueryData(key, { n: 7 });
		const fetcher = vi.fn(
			(context: { signal: AbortSignal }) =>
				new Promise<{ n: number }>((_resolve, reject) => {
					context.signal.addEventListener("abort", () =>
						reject(new Error("aborted")),
					);
				}),
		);
		const stop = observe(client, key, fetcher);
		const run = start(client, { queryKey: key, reconcile: "invalidate" });
		try {
			run.lose();
			await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
			await client.cancelQueries({ queryKey: key });
			await vi.waitFor(() => expect(run.onError).toHaveBeenCalledTimes(1));
			expect(client.getQueryData(key)).toEqual({ n: 7 });
			expect(client.getQueryState(key)?.isInvalidated).toBe(true);
			expectLost(run);
		} finally {
			run.binding.unsubscribe();
			stop();
		}
	});

	it("DOM-TQ-16 a { queryKey } prefix matching one active and one inactive query stays lost", async () => {
		const client = newQueryClient();
		const ok = vi.fn(async () => ({ ok: 2 }));
		client.setQueryDefaults(["lists"], { queryFn: ok });
		client.setQueryData(["lists", 1], { ok: 1 });
		client.setQueryData(["lists", 2], { ok: 1 });
		const stop = observe(client, ["lists", 1]);
		const run = start(client, {
			queryKey: ["lists-write"],
			reconcile: { queryKey: ["lists"] },
		});
		try {
			run.lose();
			await vi.waitFor(() => expect(run.onError).toHaveBeenCalledTimes(1));
			// The active entry refetched; the inactive one only stayed invalidated.
			expect(ok).toHaveBeenCalledTimes(1);
			expect(client.getQueryData(["lists", 1])).toEqual({ ok: 2 });
			expect(client.getQueryState(["lists", 2])?.isInvalidated).toBe(true);
			expectLost(run);
		} finally {
			run.binding.unsubscribe();
			stop();
		}
	});

	it("DOM-TQ-16 a { queryKey } that matches no query stays lost (a mistyped key never reconciles)", async () => {
		const client = newQueryClient();
		const run = start(client, {
			queryKey: ["write"],
			reconcile: { queryKey: ["nothing-cached"] },
		});
		try {
			run.lose();
			await vi.waitFor(() => expect(run.onError).toHaveBeenCalledTimes(1));
			expectLost(run);
		} finally {
			run.binding.unsubscribe();
		}
	});

	it("DOM-TQ-17 an inactive reduce target with staleTime Infinity: stale data plus a delta is never shown as continuous", async () => {
		const client = newQueryClient({ staleTime: Number.POSITIVE_INFINITY });
		const key = ["totals"];
		const fetcher = vi.fn(async () => ({ total: 12 }));
		client.setQueryDefaults(key, { queryFn: fetcher });
		// The cached total misses a delta this tab never received.
		client.setQueryData(key, { total: 6 });
		const run = start(client, {
			queryKey: key,
			reconcile: "invalidate",
			reduce: (current, event) => ({
				total:
					((current as { total: number } | undefined)?.total ?? 0) + event.n,
			}),
		});
		try {
			run.lose();
			await vi.waitFor(() => expect(run.onError).toHaveBeenCalledTimes(1));
			expect(fetcher).not.toHaveBeenCalled();
			expect(run.continuity().state).toBe("gap");
			run.emit({ n: 2 });
			// The declared write lands on the stale entry and, as any
			// setQueryData does, clears TanStack's invalidated flag...
			expect(client.getQueryData(key)).toEqual({ total: 8 });
			expect(client.getQueryState(key)?.isInvalidated).toBe(false);
			//...but the loss stays visible: never continuous with stale data.
			expect(run.continuity().state).toBe("gap");
			expect(run.counts.reconciled).toBe(0);
			expect(run.onError).toHaveBeenCalledTimes(1);
		} finally {
			run.binding.unsubscribe();
		}
	});
});

/**
 * The documented two-notice flow: an interruption reports early at detection,
 * then again as the outcome just before `connected`.
 */
async function twoNotices(
	run: Pick<ReturnType<typeof localClient>, "connection" | "notice">,
): Promise<void> {
	run.connection("reconnecting");
	run.notice("unknown", "reconnected");
	await settle();
	run.notice("unknown", "reconnected");
	run.connection("connected");
	await settle();
}

describe("the onContinuity escape hatch", () => {
	/** onContinuity recipe bound to a local client; the recipe gets the tools. */
	function hatch(
		client: QueryClient,
		key: QueryKey,
		recipe: (tools: QueryTools) => Promise<void>,
	) {
		const local = localClient();
		const binding = bindQuery<Tick>(local.client, ticks, {
			queryClient: client,
			onEvent: (tick, tools) => tools.setQueryData(key, tick.n),
			onContinuity: (_continuity, tools) => {
				void recipe(tools);
			},
		});
		return {
			...local,
			binding,
			continuity: () => binding.subscription.status.get().continuity,
		};
	}

	/**
	 * An unsafe recipe: cancelQueries, then `query` or
	 * `fetchQuery`. Pinned below as an anti-pattern: its fetch belongs to
	 * TanStack, and a revert cancel resolves it with the cached data.
	 */
	const withdrawn =
		(
			client: QueryClient,
			key: QueryKey,
			fetchTick: QueryFunction<number>,
			method: "query" | "fetchQuery" = "query",
		) =>
		async (tools: QueryTools) => {
			tools.markReconciled({ pending: true });
			try {
				await client.cancelQueries({ queryKey: key, exact: true });
				const options = { queryKey: key, queryFn: fetchTick, staleTime: 0 };
				await (method === "query"
					? client.query(options)
					: client.fetchQuery(options));
				tools.markReconciled();
			} catch {
				// The loss stays visible.
			}
		};

	/**
	 * The escape hatch the onContinuity JSDoc documents: cancel
	 * a TanStack fetch begun before the notice, then the application's own
	 * fetch, which rejects on failure, an explicit cache write, and one run
	 * token per binding, so only the newest run writes and declares. No
	 * `query` or `fetchQuery`.
	 */
	function recipe(
		client: QueryClient,
		key: QueryKey,
		fetchTick: () => Promise<number>,
	) {
		let latest = 0;
		return async (tools: QueryTools) => {
			const run = ++latest;
			tools.markReconciled({ pending: true });
			try {
				// A component fetch begun before the notice would otherwise land
				// after this run's write and replace it.
				await client.cancelQueries({ queryKey: key, exact: true });
				const data = await fetchTick();
				// A newer notice's run supersedes this one.
				if (run === latest) {
					client.setQueryData(key, data);
					tools.markReconciled();
				}
			} catch {
				// The loss stays visible; the next notice runs this again.
			}
		};
	}

	it("DOM-TQ-05b anti-pattern: await invalidateQueries, then markReconciled, declares a failed refetch reconciled (invalidateQueries resolves on failure)", async () => {
		const client = newQueryClient();
		const key = ["tick"];
		client.setQueryData(key, 7);
		const fetcher = vi.fn(async (): Promise<number> => {
			throw new Error("backend unavailable");
		});
		const stop = observe(client, key, fetcher);
		const run = hatch(client, key, async (tools) => {
			tools.markReconciled({ pending: true });
			await tools.invalidateQueries({ queryKey: key });
			tools.markReconciled();
		});
		try {
			run.connection("connected");
			run.notice("gap", "replay-reset");
			await vi.waitFor(() => expect(run.counts.reconciled).toBe(1));
			// The refetch failed, yet the recipe declared the cache reconciled:
			// the documentation must not show this recipe.
			expect(fetcher).toHaveBeenCalledTimes(1);
			expect(client.getQueryState(key)?.status).toBe("error");
			expect(client.getQueryData(key)).toBe(7);
			expect(run.continuity().state).toBe("continuous");
		} finally {
			run.binding.unsubscribe();
			stop();
		}
	});

	it("DOM-TQ-05c recipe (cancelQueries, then the application's own fetch, setQueryData, a run token, in try/catch): a failed fetch keeps the loss visible", async () => {
		const client = newQueryClient();
		const key = ["tick"];
		client.setQueryData(key, 7);
		const api = backend();
		const run = hatch(client, key, recipe(client, key, api.fetchTick));
		const tracked = trackUnhandled();
		try {
			run.connection("connected");
			run.notice("gap", "replay-reset");
			await settle();
			api.gates[0]?.reject(new Error("backend unavailable"));
			await settle();
			expect(api.fetchTick).toHaveBeenCalledTimes(1);
			expect(run.counts).toEqual({ reconciled: 0, pending: 1 });
			expect(run.continuity().state).toBe("gap");
			expect(client.getQueryData(key)).toBe(7);
			expect(tracked.unhandled).toEqual([]);
		} finally {
			tracked.stop();
			run.binding.unsubscribe();
		}
	});

	it("DOM-TQ-05c recipe: a successful fetch writes the cache and reconciles, with no observer", async () => {
		const client = newQueryClient();
		const key = ["tick"];
		client.setQueryData(key, 7);
		const api = backend();
		const run = hatch(client, key, recipe(client, key, api.fetchTick));
		try {
			run.connection("connected");
			run.notice("gap", "replay-reset");
			await settle();
			expect(run.counts.reconciled).toBe(0);
			api.gates[0]?.resolve(8);
			await vi.waitFor(() => expect(run.counts.reconciled).toBe(1));
			expect(api.fetchTick).toHaveBeenCalledTimes(1);
			expect(client.getQueryData(key)).toBe(8);
			expect(run.continuity().state).toBe("continuous");
		} finally {
			run.binding.unsubscribe();
		}
	});

	it("DOM-TQ-05c recipe: offline, the application's fetch rejects at once and nothing is reconciled; the next notice after reconnecting reconciles", async () => {
		const client = newQueryClient();
		client.mount();
		const key = ["tick"];
		client.setQueryData(key, 7);
		const api = backend();
		const run = hatch(client, key, recipe(client, key, api.fetchTick));
		const tracked = trackUnhandled();
		try {
			onlineManager.setOnline(false);
			api.network.online = false;
			run.connection("connected");
			run.notice("gap", "replay-reset");
			await settle();
			expect(run.counts.reconciled).toBe(0);
			expect(run.continuity().state).toBe("gap");
			expect(client.getQueryData(key)).toBe(7);
			// The fetch is the application's: it failed at once, and TanStack
			// holds no paused fetch that could resolve later.
			expect(api.fetchTick).toHaveBeenCalledTimes(1);
			expect(client.getQueryState(key)?.fetchStatus).toBe("idle");
			api.network.online = true;
			onlineManager.setOnline(true);
			await settle();
			// Coming back online declares nothing by itself.
			expect(run.counts.reconciled).toBe(0);
			run.notice("unknown", "reconnected");
			await settle();
			api.gates[0]?.resolve(8);
			await vi.waitFor(() => expect(run.counts.reconciled).toBe(1));
			expect(client.getQueryData(key)).toBe(8);
			expect(tracked.unhandled).toEqual([]);
		} finally {
			tracked.stop();
			api.network.online = true;
			onlineManager.setOnline(true);
			run.binding.unsubscribe();
			client.unmount();
		}
	});

	for (const withData of [true, false]) {
		const begun = withData
			? "a refetch over cached data"
			: "an initial fetch without data";
		it(`DOM-TQ-05c recipe: ${begun} begun before the notice is cancelled, not joined; its answer is dropped and declares nothing; reconciled only on the recipe's own answer`, async () => {
			const client = newQueryClient();
			const key = ["tick"];
			const api = backend();
			const stop = preNoticeFetch(client, key, api.fetchTick, withData);
			const run = hatch(client, key, recipe(client, key, api.fetchTick));
			const tracked = trackUnhandled();
			try {
				await macrotask();
				expect(api.fetchTick).toHaveBeenCalledTimes(1);
				run.connection("connected");
				run.notice("gap", "replay-reset");
				await settle();
				// The recipe made its own request after the notice.
				expect(api.fetchTick).toHaveBeenCalledTimes(2);
				api.gates[0]?.resolve(1);
				await settle();
				// The recipe cancelled the pre-notice fetch (reverted), so its
				// answer is never written; it declares nothing.
				expect(client.getQueryData(key)).toBe(withData ? 7 : undefined);
				expect(run.counts.reconciled).toBe(0);
				expect(run.continuity().state).toBe("gap");
				api.gates[1]?.resolve(8);
				await vi.waitFor(() => expect(run.counts.reconciled).toBe(1));
				expect(client.getQueryData(key)).toBe(8);
				expect(run.continuity().state).toBe("continuous");
				await settle();
				expect(tracked.unhandled).toEqual([]);
			} finally {
				tracked.stop();
				run.binding.unsubscribe();
				stop();
			}
		});
	}

	it("DOM-TQ-05c recipe: the application's cancelQueries during the recipe's fetch (an optimistic update's onMutate) declares nothing; reconciled only on the recipe's own answer", async () => {
		const client = newQueryClient();
		const key = ["tick"];
		client.setQueryData(key, 7);
		const api = backend();
		const run = hatch(client, key, recipe(client, key, api.fetchTick));
		try {
			run.connection("connected");
			run.notice("gap", "replay-reset");
			await settle();
			expect(api.fetchTick).toHaveBeenCalledTimes(1);
			await client.cancelQueries({ queryKey: key });
			await settle();
			expect(run.counts.reconciled).toBe(0);
			expect(run.continuity().state).toBe("gap");
			api.gates[0]?.resolve(8);
			await vi.waitFor(() => expect(run.counts.reconciled).toBe(1));
			expect(client.getQueryData(key)).toBe(8);
		} finally {
			run.binding.unsubscribe();
		}
	});

	it("DOM-TQ-05c recipe: the last observer unmounting during the recipe's fetch declares nothing; reconciled only on the recipe's own answer", async () => {
		const client = newQueryClient();
		const key = ["tick"];
		client.setQueryData(key, 7);
		const api = backend();
		const stop = observe(client, key, api.fetchTick);
		const run = hatch(client, key, recipe(client, key, api.fetchTick));
		try {
			run.connection("connected");
			run.notice("gap", "replay-reset");
			await settle();
			expect(api.fetchTick).toHaveBeenCalledTimes(1);
			stop(); // a route change during the reconnect
			await settle();
			expect(run.counts.reconciled).toBe(0);
			expect(run.continuity().state).toBe("gap");
			api.gates[0]?.resolve(8);
			await vi.waitFor(() => expect(run.counts.reconciled).toBe(1));
			expect(client.getQueryData(key)).toBe(8);
		} finally {
			run.binding.unsubscribe();
		}
	});

	it("DOM-TQ-05c recipe, two notices for one interruption (detection, then the outcome): the first run's answer lands after the second run's fetch failed; nothing is reconciled", async () => {
		const client = newQueryClient();
		const key = ["tick"];
		client.setQueryData(key, 7);
		const api = backend();
		const run = hatch(client, key, recipe(client, key, api.fetchTick));
		const tracked = trackUnhandled();
		try {
			await twoNotices(run);
			// Each run made its own request; none has been answered.
			expect(api.fetchTick).toHaveBeenCalledTimes(2);
			expect(run.counts.reconciled).toBe(0);
			expect(run.continuity().state).toBe("unknown");
			api.gates[1]?.reject(new Error("backend unavailable"));
			await settle();
			api.gates[0]?.resolve(8);
			await settle();
			// The first run was overtaken: it neither writes nor declares.
			expect(run.counts).toEqual({ reconciled: 0, pending: 2 });
			expect(run.continuity().state).toBe("unknown");
			expect(client.getQueryData(key)).toBe(7);
			expect(tracked.unhandled).toEqual([]);
		} finally {
			tracked.stop();
			run.binding.unsubscribe();
		}
	});

	it("DOM-TQ-05c recipe, two notices while offline: each run's fetch fails at once; nothing is reconciled", async () => {
		const client = newQueryClient();
		client.mount();
		const key = ["tick"];
		client.setQueryData(key, 7);
		const api = backend();
		const run = hatch(client, key, recipe(client, key, api.fetchTick));
		const tracked = trackUnhandled();
		try {
			onlineManager.setOnline(false);
			api.network.online = false;
			await twoNotices(run);
			expect(run.counts.reconciled).toBe(0);
			expect(run.continuity().state).toBe("unknown");
			expect(client.getQueryData(key)).toBe(7);
			expect(api.fetchTick).toHaveBeenCalledTimes(2);
			expect(tracked.unhandled).toEqual([]);
		} finally {
			tracked.stop();
			api.network.online = true;
			onlineManager.setOnline(true);
			await settle();
			for (const gate of api.gates) gate.resolve(1);
			await settle();
			run.binding.unsubscribe();
			client.unmount();
		}
	});

	it("DOM-TQ-05c recipe, two notices: the second run answers first and reconciles; the first run's late answer is neither written nor declared", async () => {
		const client = newQueryClient();
		const key = ["tick"];
		client.setQueryData(key, 7);
		const api = backend();
		const run = hatch(client, key, recipe(client, key, api.fetchTick));
		const tracked = trackUnhandled();
		try {
			await twoNotices(run);
			expect(api.fetchTick).toHaveBeenCalledTimes(2);
			expect(run.counts.reconciled).toBe(0);
			api.gates[1]?.resolve(8);
			await vi.waitFor(() => expect(run.counts.reconciled).toBe(1));
			expect(client.getQueryData(key)).toBe(8);
			// Requested between the notices: older than the second run's answer.
			api.gates[0]?.resolve(1);
			await settle();
			expect(run.counts.reconciled).toBe(1);
			expect(client.getQueryData(key)).toBe(8);
			expect(run.continuity().state).toBe("continuous");
			expect(tracked.unhandled).toEqual([]);
		} finally {
			tracked.stop();
			run.binding.unsubscribe();
		}
	});

	for (const withData of [true, false]) {
		for (const signal of ["honours", "ignores"] as const) {
			const begun = withData
				? "a refetch over cached data"
				: "an initial fetch without data";
			it(`DOM-TQ-05c recipe (safety; the residual): ${begun} begun before the notice, whose queryFn ${signal} the abort signal, answers after the recipe's write and never replaces it`, async () => {
				const client = newQueryClient();
				const key = ["tick"];
				const api = backend();
				const component: QueryFunction<number> =
					signal === "honours" ? api.fetchTick : () => api.fetchTick();
				const stop = preNoticeFetch(client, key, component, withData);
				const run = hatch(client, key, recipe(client, key, api.fetchTick));
				const tracked = trackUnhandled();
				try {
					await macrotask();
					expect(api.fetchTick).toHaveBeenCalledTimes(1);
					run.connection("connected");
					run.notice("gap", "replay-reset");
					await settle();
					expect(api.fetchTick).toHaveBeenCalledTimes(2);
					api.gates[1]?.resolve(8);
					await vi.waitFor(() => expect(run.counts.reconciled).toBe(1));
					expect(client.getQueryData(key)).toBe(8);
					// The answer to the request made before the notice lands late.
					// query-core writes every fetch it did not cancel; the recipe
					// cancelled this one first.
					api.gates[0]?.resolve(1);
					await settle();
					expect(client.getQueryData(key)).toBe(8);
					expect(run.continuity().state).toBe("continuous");
					expect(run.counts.reconciled).toBe(1);
					expect(tracked.unhandled).toEqual([]);
				} finally {
					tracked.stop();
					run.binding.unsubscribe();
					stop();
				}
			});
		}
	}

	it("DOM-TQ-05c recipe, the cost of the cancel (pinned): a component's initial fetch without data in flight at the notice is reverted to pending; when the recipe's fetch fails the loss stays visible and the component waits for a later run's write", async () => {
		const client = newQueryClient();
		const key = ["tick"];
		const api = backend();
		const component = new QueryObserver<number>(client, {
			queryKey: key,
			queryFn: api.fetchTick,
			staleTime: Number.POSITIVE_INFINITY,
		});
		const stop = component.subscribe(() => {});
		const run = hatch(client, key, recipe(client, key, api.fetchTick));
		const tracked = trackUnhandled();
		try {
			await macrotask();
			expect(api.fetchTick).toHaveBeenCalledTimes(1);
			run.connection("connected");
			run.notice("gap", "replay-reset");
			await settle();
			expect(api.fetchTick).toHaveBeenCalledTimes(2);
			// Reverted: no data, and no fetch of its own in flight any more.
			expect(component.getCurrentResult()).toMatchObject({
				status: "pending",
				fetchStatus: "idle",
				data: undefined,
			});
			api.gates[1]?.reject(new Error("backend unavailable"));
			api.gates[0]?.resolve(1);
			await settle();
			expect(component.getCurrentResult()).toMatchObject({
				status: "pending",
				fetchStatus: "idle",
				data: undefined,
			});
			expect(run.continuity().state).toBe("gap");
			expect(run.counts.reconciled).toBe(0);
			// The next notice's run writes the data the component shows.
			run.notice("unknown", "reconnected");
			await settle();
			expect(api.fetchTick).toHaveBeenCalledTimes(3);
			api.gates[2]?.resolve(8);
			await vi.waitFor(() => expect(run.counts.reconciled).toBe(1));
			expect(component.getCurrentResult()).toMatchObject({
				status: "success",
				data: 8,
			});
			expect(tracked.unhandled).toEqual([]);
		} finally {
			tracked.stop();
			run.binding.unsubscribe();
			stop();
		}
	});

	for (const method of ["query", "fetchQuery"] as const) {
		it(`DOM-TQ-05c anti-pattern (unsafe recipe: cancelQueries, then ${method}): in the two-notice flow the second run's cancelQueries revert-cancels the first run's fetch, ${method} resolves with the cached data, and the loss is declared reconciled with no post-outcome answer`, async () => {
			const client = newQueryClient();
			const key = ["tick"];
			client.setQueryData(key, 7);
			const api = backend();
			const run = hatch(
				client,
				key,
				withdrawn(client, key, api.fetchTick, method),
			);
			try {
				await twoNotices(run);
				// Declared on the cached value; no request has been answered.
				expect(api.fetchTick).toHaveBeenCalledTimes(2);
				expect(run.counts.reconciled).toBe(1);
				expect(run.continuity().state).toBe("continuous");
				api.gates[1]?.reject(new Error("backend unavailable"));
				await settle();
				expect(client.getQueryState(key)?.status).toBe("error");
				expect(client.getQueryData(key)).toBe(7);
				expect(run.continuity().state).toBe("continuous");
			} finally {
				run.binding.unsubscribe();
			}
		});
	}

	it("DOM-TQ-05c anti-pattern (never a recipe): query joins a refetch begun before the notice and declares the loss reconciled on the pre-notice response", async () => {
		const client = newQueryClient();
		const key = ["tick"];
		const api = backend();
		const stop = preNoticeFetch(client, key, api.fetchTick, true);
		const run = hatch(client, key, async (tools) => {
			tools.markReconciled({ pending: true });
			try {
				await client.query({
					queryKey: key,
					queryFn: api.fetchTick,
					staleTime: 0,
				});
				tools.markReconciled();
			} catch {
				// The loss stays visible.
			}
		});
		try {
			await macrotask();
			run.connection("connected");
			run.notice("gap", "replay-reset");
			await settle();
			// No fetch after the notice: query joined the one begun before it.
			expect(api.fetchTick).toHaveBeenCalledTimes(1);
			api.gates[0]?.resolve(1);
			await vi.waitFor(() => expect(run.counts.reconciled).toBe(1));
			expect(client.getQueryData(key)).toBe(1);
			expect(run.continuity().state).toBe("continuous");
		} finally {
			run.binding.unsubscribe();
			stop();
		}
	});
});

describe("a reconcile function: the refresh the QueryReconcile JSDoc documents", () => {
	/** An unsafe refresh function, pinned below as an anti-pattern. */
	const withdrawnRefresh =
		(client: QueryClient, key: QueryKey, fetchTick: QueryFunction<number>) =>
		async () => {
			await client.cancelQueries({ queryKey: key, exact: true });
			await client.query({ queryKey: key, queryFn: fetchTick, staleTime: 0 });
		};

	/**
	 * The documented refresh: cancel a TanStack fetch begun
	 * before the notice, then the application's own fetch and setQueryData.
	 * The engine coalesces notices and never declares an overtaken run, so no
	 * run token is needed.
	 */
	const refresh =
		(client: QueryClient, key: QueryKey, fetchTick: () => Promise<number>) =>
		async () => {
			await client.cancelQueries({ queryKey: key, exact: true });
			client.setQueryData(key, await fetchTick());
		};

	it("DOM-TQ-05c as a reconcile function (the application's own fetch, then setQueryData): a failed fetch keeps the loss visible and calls onError once", async () => {
		const client = newQueryClient();
		const key = ["tick"];
		client.setQueryData(key, 7);
		const api = backend();
		const run = start(client, {
			queryKey: key,
			reconcile: refresh(client, key, api.fetchTick),
		});
		const tracked = trackUnhandled();
		try {
			run.lose();
			await settle();
			api.gates[0]?.reject(new Error("backend unavailable"));
			await vi.waitFor(() => expect(run.onError).toHaveBeenCalledTimes(1));
			expectLost(run);
			expect(client.getQueryData(key)).toBe(7);
			await settle();
			expect(tracked.unhandled).toEqual([]);
		} finally {
			tracked.stop();
			run.binding.unsubscribe();
		}
	});

	it("DOM-TQ-05c as a reconcile function: the application's cancelQueries during the refresh declares nothing; reconciled only on the refresh's own answer", async () => {
		const client = newQueryClient();
		const key = ["tick"];
		client.setQueryData(key, 7);
		const api = backend();
		const run = start(client, {
			queryKey: key,
			reconcile: refresh(client, key, api.fetchTick),
		});
		try {
			run.lose();
			await settle();
			expect(api.fetchTick).toHaveBeenCalledTimes(1);
			await client.cancelQueries({ queryKey: key });
			await settle();
			expect(run.counts.reconciled).toBe(0);
			expect(run.continuity().state).toBe("gap");
			api.gates[0]?.resolve(8);
			await vi.waitFor(() => expect(run.counts.reconciled).toBe(1));
			expect(client.getQueryData(key)).toBe(8);
			expect(run.onError).not.toHaveBeenCalled();
		} finally {
			run.binding.unsubscribe();
		}
	});

	it("DOM-TQ-05c as a reconcile function: the last observer unmounting during the refresh declares nothing; reconciled only on the refresh's own answer", async () => {
		const client = newQueryClient();
		const key = ["tick"];
		client.setQueryData(key, 7);
		const api = backend();
		const stop = observe(client, key, api.fetchTick);
		const run = start(client, {
			queryKey: key,
			reconcile: refresh(client, key, api.fetchTick),
		});
		try {
			run.lose();
			await settle();
			expect(api.fetchTick).toHaveBeenCalledTimes(1);
			stop();
			await settle();
			expect(run.counts.reconciled).toBe(0);
			expect(run.continuity().state).toBe("gap");
			api.gates[0]?.resolve(8);
			await vi.waitFor(() => expect(run.counts.reconciled).toBe(1));
			expect(client.getQueryData(key)).toBe(8);
			expect(run.onError).not.toHaveBeenCalled();
		} finally {
			run.binding.unsubscribe();
		}
	});

	it("DOM-TQ-05c as a reconcile function: a refetch begun before the notice is cancelled, not joined; its answer is dropped and declares nothing; reconciled only on the refresh's own answer", async () => {
		const client = newQueryClient();
		const key = ["tick"];
		const api = backend();
		const stop = preNoticeFetch(client, key, api.fetchTick, true);
		const run = start(client, {
			queryKey: key,
			reconcile: refresh(client, key, api.fetchTick),
		});
		const tracked = trackUnhandled();
		try {
			await macrotask();
			expect(api.fetchTick).toHaveBeenCalledTimes(1);
			run.lose();
			await settle();
			// The refresh made its own request after the notice.
			expect(api.fetchTick).toHaveBeenCalledTimes(2);
			api.gates[0]?.resolve(1);
			await settle();
			// Cancelled (reverted) by the refresh: the answer is never written.
			expect(client.getQueryData(key)).toBe(7);
			expect(run.counts.reconciled).toBe(0);
			expect(run.continuity().state).toBe("gap");
			api.gates[1]?.resolve(8);
			await vi.waitFor(() => expect(run.counts.reconciled).toBe(1));
			expect(client.getQueryData(key)).toBe(8);
			expect(run.continuity().state).toBe("continuous");
			expect(run.onError).not.toHaveBeenCalled();
			await settle();
			expect(tracked.unhandled).toEqual([]);
		} finally {
			tracked.stop();
			run.binding.unsubscribe();
			stop();
		}
	});

	for (const withData of [true, false]) {
		for (const signal of ["honours", "ignores"] as const) {
			const begun = withData
				? "a refetch over cached data"
				: "an initial fetch without data";
			it(`DOM-TQ-05c as a reconcile function (safety; the residual): ${begun} begun before the notice, whose queryFn ${signal} the abort signal, answers after the refresh's write and never replaces it`, async () => {
				const client = newQueryClient();
				const key = ["tick"];
				const api = backend();
				const component: QueryFunction<number> =
					signal === "honours" ? api.fetchTick : () => api.fetchTick();
				const stop = preNoticeFetch(client, key, component, withData);
				const run = start(client, {
					queryKey: key,
					reconcile: refresh(client, key, api.fetchTick),
				});
				const tracked = trackUnhandled();
				try {
					await macrotask();
					expect(api.fetchTick).toHaveBeenCalledTimes(1);
					run.lose();
					await settle();
					expect(api.fetchTick).toHaveBeenCalledTimes(2);
					api.gates[1]?.resolve(8);
					await vi.waitFor(() => expect(run.counts.reconciled).toBe(1));
					expect(client.getQueryData(key)).toBe(8);
					// The answer to the request made before the notice lands late.
					api.gates[0]?.resolve(1);
					await settle();
					expect(client.getQueryData(key)).toBe(8);
					expect(run.continuity().state).toBe("continuous");
					expect(run.counts.reconciled).toBe(1);
					expect(run.onError).not.toHaveBeenCalled();
					expect(tracked.unhandled).toEqual([]);
				} finally {
					tracked.stop();
					run.binding.unsubscribe();
					stop();
				}
			});
		}
	}

	it("DOM-TQ-05c as a reconcile function, two notices with the first refresh in flight: the engine never declares the overtaken run and runs the refresh again; a failing rerun keeps the loss visible", async () => {
		const client = newQueryClient();
		const key = ["tick"];
		client.setQueryData(key, 7);
		const api = backend();
		const run = start(client, {
			queryKey: key,
			reconcile: refresh(client, key, api.fetchTick),
		});
		const tracked = trackUnhandled();
		try {
			run.connection("connected");
			run.notice("unknown", "reconnected");
			await settle();
			run.notice("unknown", "reconnected");
			await settle();
			expect(api.fetchTick).toHaveBeenCalledTimes(1);
			api.gates[0]?.resolve(8);
			await settle();
			// Overtaken: not declared; the engine ran the refresh again.
			expect(run.counts.reconciled).toBe(0);
			expect(api.fetchTick).toHaveBeenCalledTimes(2);
			api.gates[1]?.reject(new Error("backend unavailable"));
			await vi.waitFor(() => expect(run.onError).toHaveBeenCalledTimes(1));
			expect(run.counts.reconciled).toBe(0);
			expect(run.continuity().state).toBe("unknown");
			await settle();
			expect(tracked.unhandled).toEqual([]);
		} finally {
			tracked.stop();
			run.binding.unsubscribe();
		}
	});

	it("DOM-TQ-05c anti-pattern (unsafe refresh function: cancelQueries, then query): query resolves with the cached data when the application's cancelQueries revert-cancels its fetch, so the engine declares the loss reconciled", async () => {
		const client = newQueryClient();
		const key = ["tick"];
		client.setQueryData(key, 7);
		const api = backend();
		const run = start(client, {
			queryKey: key,
			reconcile: withdrawnRefresh(client, key, api.fetchTick),
		});
		try {
			run.lose();
			await settle();
			expect(api.fetchTick).toHaveBeenCalledTimes(1);
			await client.cancelQueries({ queryKey: key });
			await vi.waitFor(() => expect(run.counts.reconciled).toBe(1));
			expect(client.getQueryData(key)).toBe(7);
			expect(run.continuity().state).toBe("continuous");
			expect(run.onError).not.toHaveBeenCalled();
		} finally {
			run.binding.unsubscribe();
		}
	});
});
