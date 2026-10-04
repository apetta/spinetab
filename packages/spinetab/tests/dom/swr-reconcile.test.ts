import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import useSWR, {
	mutate as globalMutate,
	type MutatorOptions,
	type ScopedMutator,
	SWRConfig,
	useSWRConfig,
} from "swr";
import useSWRSubscription from "swr/subscription";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { isSpinetabError } from "../../src/core/errors.ts";
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
	type SwrSubscriptionOptions,
	swrSubscription,
} from "../../src/integrations/swr/index.ts";

// Reconciliation resolves only after fetched data is written, and rejects on
// failure. These cases exercise application-owned populate mutations, missing
// hooks, overlapping notices and shared options using real SWR and React.

type Order = { n: number };
type Backend = (id: string) => Promise<Order>;

/** The contracted sentence for a failed refresh (swrSubscription). */
const REFRESH_FAILED =
	"The reconcile refresh failed; continuity stays lost until a later refresh succeeds.";

const orders: SubscriptionRequest<Order> = {
	adapter: "test",
	connection: { url: "https://example.test/orders" },
	subscription: { topic: "orders" },
};
const snapshotKey = (id: string) => `/api/orders/${id}/snapshot`;
const KEY = snapshotKey("1");
const STALE: Order = { n: 7 };
const FRESH: Order = { n: 9 };

beforeAll(() => {
	(
		globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
	).IS_REACT_ACT_ENVIRONMENT = true;
});

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => {
	unhandled.push(reason);
};
const disposers: Array<() => void> = [];
let root: Root | undefined;
beforeEach(() => {
	unhandled.length = 0;
	process.on("unhandledRejection", onUnhandled);
});
afterEach(async () => {
	for (const dispose of disposers.splice(0)) dispose();
	await act(async () => root?.unmount());
	root = undefined;
	process.off("unhandledRejection", onUnhandled);
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

/** A snapshot backend that always fails with `failure`. */
const failing = (failure = new Error("backend unavailable")) =>
	vi.fn(async (_id: string): Promise<Order> => {
		throw failure;
	});
/** A snapshot backend that answers FRESH. */
const working = () =>
	vi.fn(async (_id: string): Promise<Order> => ({ ...FRESH }));
/** A snapshot backend whose every call waits on its own gate. */
function gated() {
	const gates: Array<ReturnType<typeof deferred<Order>>> = [];
	const fetchSnapshot = vi.fn((_id: string): Promise<Order> => {
		const gate = deferred<Order>();
		gates.push(gate);
		return gate.promise;
	});
	return { fetchSnapshot, gates };
}

/**
 * A `SpinetabClient` with one subscription: a status store, `markReconciled`
 * (plain: `continuous/reconciled`; pending: counted, continuity kept) and
 * status delivery. Enough for swrSubscription and the reconcile engine.
 */
function localClient() {
	const status = createStore<SubscriptionStatus>({
		active: true,
		connection: { state: "connecting", since: 1 },
		continuity: { state: "continuous", since: 1 },
	});
	let observer: SubscriptionObserver<Order> | undefined;
	let since = 1;
	const counts = { reconciled: 0, pending: 0 };
	const publish = (next: SubscriptionStatus) => {
		status.set(next);
		observer?.status?.(next);
	};
	const handle: Subscription<Order> = {
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
		subscribe(_request: unknown, next: SubscriptionObserver<Order>) {
			observer = next;
			return handle;
		},
	} as unknown as SpinetabClient;
	return {
		client,
		counts,
		continuity: () => status.get().continuity,
		connection(state: SubscriptionStatus["connection"]["state"]) {
			publish({ ...status.get(), connection: { state, since: Date.now() } });
		},
		/** One continuity notice; a repeated `unknown` is a new notice. */
		notice(state: "gap" | "unknown", reason: Continuity["reason"]) {
			since = Math.max(since + 1, Date.now());
			publish({ ...status.get(), continuity: { state, reason, since } });
		},
		/** Connected, then one `gap/replay-reset` notice. */
		lose() {
			publish({
				...status.get(),
				connection: { state: "connected", since: Date.now() },
			});
			publish({
				...status.get(),
				continuity: { state: "gap", reason: "replay-reset", since: Date.now() },
			});
		},
	};
}

/**
 * SWR with its own cache, where the snapshot key holds STALE, and, when
 * `hookFetcher` is given, a mounted `useSWR` for that key that does not fetch
 * on mount. Returns the scoped `mutate`, the hook's view and the cached data.
 */
async function mountSwr(
	options: { hookFetcher?: Backend; paused?: boolean } = {},
) {
	const cache = new Map<string, unknown>([[KEY, { data: STALE }]]);
	const view: { mutate?: ScopedMutator; data?: unknown; error?: unknown } = {};
	const { hookFetcher } = options;
	function Capture() {
		view.mutate = useSWRConfig().mutate;
		return null;
	}
	function SnapshotView() {
		const { data, error } = useSWR(KEY, hookFetcher ?? null, {
			revalidateOnMount: false,
			shouldRetryOnError: false,
		});
		view.data = data;
		view.error = error;
		return null;
	}
	const value = {
		provider: () => cache as never,
		...(options.paused ? { isPaused: () => true } : {}),
	};
	root = createRoot(document.createElement("div"));
	await act(async () => {
		root?.render(
			createElement(
				SWRConfig,
				{ value },
				createElement(Capture),
				hookFetcher ? createElement(SnapshotView) : null,
			),
		);
	});
	const { mutate } = view;
	if (!mutate) throw new Error("SWR did not render");
	const cachedAt = (key: string) =>
		(cache.get(key) as { data?: unknown } | undefined)?.data;
	return { mutate, view, cached: () => cachedAt(KEY), cachedAt };
}

/** swrSubscription for key "1", driven as `useSWRSubscription` calls it. */
function drive(options: SwrSubscriptionOptions<string, Order, Order>) {
	const local = localClient();
	const next = vi.fn<(error?: unknown, data?: unknown) => void>();
	const dispose = swrSubscription<string, Order>(
		local.client,
		() => orders,
		options,
	)("1", { next } as never);
	disposers.push(dispose);
	return {
		...local,
		next,
		errors: () =>
			next.mock.calls.map(([error]) => error).filter((error) => error != null),
	};
}

/**
 * Several keys through one swrSubscription (so one options object), each key
 * on its own local subscription. Returns the local clients in key order.
 */
function driveKeys(
	options: SwrSubscriptionOptions<string, Order, Order>,
	ids: string[],
) {
	const locals = ids.map(() => localClient());
	const queue = [...locals];
	const client = {
		subscribe(...args: unknown[]) {
			const local = queue.shift();
			if (!local) throw new Error("one subscription per key");
			return (local.client.subscribe as (...rest: unknown[]) => unknown)(
				...args,
			);
		},
	} as unknown as SpinetabClient;
	const subscribe = swrSubscription<string, Order>(
		client,
		() => orders,
		options,
	);
	for (const id of ids) {
		disposers.push(subscribe(id, { next: vi.fn() } as never));
	}
	return locals;
}

async function lose(run: { lose(): void }): Promise<void> {
	await act(async () => {
		run.lose();
		await settle();
	});
}

/**
 * The documented two-notice flow: an interruption reports early at detection,
 * then again as the outcome just before `connected`.
 */
async function twoNotices(run: {
	connection(state: SubscriptionStatus["connection"]["state"]): void;
	notice(state: "gap" | "unknown", reason: Continuity["reason"]): void;
}): Promise<void> {
	await act(async () => {
		run.connection("reconnecting");
		run.notice("unknown", "reconnected");
		await settle();
		run.notice("unknown", "reconnected");
		run.connection("connected");
		await settle();
	});
}

/**
 * The populate options: the documented form states `throwOnError: true`
 * because SWR's types say the default is `false` while its runtime
 * default is `true`; the second form leaves it to that runtime default.
 */
const DOCUMENTED: MutatorOptions<Order> = {
	revalidate: false,
	throwOnError: true,
};
const FORMS: Array<{ form: string; options: MutatorOptions<Order> }> = [
	{ form: "documented form, throwOnError: true", options: DOCUMENTED },
	{
		form: "SWR runtime default",
		options: { revalidate: false },
	},
];

/** Populate the key from an application fetch that rejects on failure. */
const populate = (
	mutate: ScopedMutator,
	fetchSnapshot: Backend,
	options: MutatorOptions<Order> = { revalidate: false },
): SwrSubscriptionOptions<string, Order, Order> => ({
	reconcile: async (id) => {
		await mutate(snapshotKey(id), fetchSnapshot(id), options);
	},
});

/**
 * The previous escape hatch (no run token), pinned below as an
 * anti-pattern: an overtaken run declares although SWR dropped its
 * write.
 */
const previousOnContinuity = (
	mutate: ScopedMutator,
	fetchSnapshot: Backend,
	options: MutatorOptions<Order> = { revalidate: false },
): SwrSubscriptionOptions<string, Order, Order> => ({
	onContinuity: async (_continuity, id, controls) => {
		controls.markReconciled({ pending: true });
		try {
			await mutate(snapshotKey(id), fetchSnapshot(id), options);
			controls.markReconciled();
		} catch {
			// The loss stays visible; the next notice runs this again.
		}
	},
});

/**
 * In the escape hatch: restart delivery, populate, then
 * declare only from the newest run on that key. The options serve every key,
 * so the run token is kept per key.
 */
const populateOnContinuity = (
	mutate: ScopedMutator,
	fetchSnapshot: Backend,
	options: MutatorOptions<Order> = { revalidate: false },
): SwrSubscriptionOptions<string, Order, Order> => {
	const runs = new Map<string, number>();
	return {
		onContinuity: async (_continuity, id, controls) => {
			const run = (runs.get(id) ?? 0) + 1;
			runs.set(id, run);
			controls.markReconciled({ pending: true });
			try {
				await mutate(snapshotKey(id), fetchSnapshot(id), options);
				// A newer mutation of the key supersedes this run's write.
				if (runs.get(id) === run) controls.markReconciled();
			} catch {
				// The loss stays visible; the next notice runs this again.
			}
		},
	};
};

/** Superseded documentation (swr.md:56): key-only `mutate(key)`. */
const keyOnly = (
	mutate: ScopedMutator,
	_fetchSnapshot?: Backend,
): SwrSubscriptionOptions<string, Order, Order> => ({
	reconcile: async (id) => {
		await mutate(snapshotKey(id));
	},
});

/** Superseded documentation (swr.md:80-84): the key-only escape hatch. */
const keyOnlyOnContinuity = (
	mutate: ScopedMutator,
	_fetchSnapshot?: Backend,
): SwrSubscriptionOptions<string, Order, Order> => ({
	onContinuity: async (_continuity, id, controls) => {
		controls.markReconciled({ pending: true });
		await mutate(snapshotKey(id));
		controls.markReconciled();
	},
});

describe("SWR reconcile: the populate recipe (real swr 2.5.1)", () => {
	it.each(
		FORMS,
	)("DOM-SWR-14 a failed fetch keeps the loss visible: gap, next(upstream-error) once with the cause, cache kept, nothing unhandled ($form)", async ({
		options,
	}) => {
		const failure = new Error("backend unavailable");
		const fetchSnapshot = failing(failure);
		// The mounted hook shares the backend; revalidate: false keeps it idle.
		const swr = await mountSwr({ hookFetcher: fetchSnapshot });
		const run = drive(populate(swr.mutate, fetchSnapshot, options));
		await lose(run);
		expect(fetchSnapshot).toHaveBeenCalledTimes(1);
		expect(run.continuity().state).toBe("gap");
		expect(run.counts).toEqual({ reconciled: 0, pending: 0 });
		const errors = run.errors();
		expect(errors).toHaveLength(1);
		const [error] = errors;
		expect(isSpinetabError(error, "upstream-error")).toBe(true);
		expect((error as Error).message).toBe(REFRESH_FAILED);
		expect((error as Error).cause).toBe(failure);
		expect(swr.cached()).toEqual(STALE);
		expect(swr.view.data).toEqual(STALE);
		expect(swr.view.error).toBeUndefined();
		await settle();
		expect(unhandled).toEqual([]);
	});

	it("DOM-SWR-14 the failed refresh runs again at the next connected and reconciles once the fetch succeeds", async () => {
		let down = true;
		const fetchSnapshot = vi.fn(async (_id: string): Promise<Order> => {
			if (down) throw new Error("backend unavailable");
			return { ...FRESH };
		});
		const swr = await mountSwr();
		const run = drive(populate(swr.mutate, fetchSnapshot));
		await lose(run);
		expect(run.continuity().state).toBe("gap");
		down = false;
		await act(async () => {
			run.connection("reconnecting");
			run.connection("connected");
			await settle();
		});
		expect(fetchSnapshot).toHaveBeenCalledTimes(2);
		expect(run.continuity()).toMatchObject({
			state: "continuous",
			reason: "reconciled",
		});
		expect(run.counts.reconciled).toBe(1);
		expect(swr.cached()).toEqual(FRESH);
		expect(run.errors()).toHaveLength(1);
	});

	it.each(
		FORMS,
	)("DOM-SWR-15 a successful fetch reconciles and writes the cache with no mounted hook ($form)", async ({
		options,
	}) => {
		const fetchSnapshot = working();
		const swr = await mountSwr();
		const run = drive(populate(swr.mutate, fetchSnapshot, options));
		await lose(run);
		expect(fetchSnapshot).toHaveBeenCalledTimes(1);
		expect(fetchSnapshot).toHaveBeenCalledWith("1");
		expect(run.continuity()).toMatchObject({
			state: "continuous",
			reason: "reconciled",
		});
		expect(run.counts).toEqual({ reconciled: 1, pending: 0 });
		expect(swr.cached()).toEqual(FRESH);
		expect(run.errors()).toEqual([]);
	});

	it("DOM-SWR-15 the data may be an async function: reconciled with the cache written", async () => {
		const fetchSnapshot = working();
		const swr = await mountSwr();
		const run = drive({
			reconcile: async (id) => {
				await swr.mutate(snapshotKey(id), () => fetchSnapshot(id), {
					revalidate: false,
				});
			},
		});
		await lose(run);
		expect(fetchSnapshot).toHaveBeenCalledTimes(1);
		expect(run.continuity().state).toBe("continuous");
		expect(swr.cached()).toEqual(FRESH);
	});

	it("DOM-SWR-15 a mounted hook shows the written data without running its own fetcher (revalidate: false)", async () => {
		const hookFetcher = vi.fn(
			async (_id: string): Promise<Order> => ({ n: 8 }),
		);
		const fetchSnapshot = working();
		const swr = await mountSwr({ hookFetcher });
		const run = drive(populate(swr.mutate, fetchSnapshot));
		await lose(run);
		expect(run.continuity().state).toBe("continuous");
		expect(swr.view.data).toEqual(FRESH);
		expect(hookFetcher).not.toHaveBeenCalled();
		expect(fetchSnapshot).toHaveBeenCalledTimes(1);
	});

	it("DOM-SWR-14 and 15 through the module-level form: global mutate, real useSWRSubscription, default cache, no snapshot hook", async () => {
		const id = "module-level";
		await globalMutate(snapshotKey(id), STALE, { revalidate: false });
		let down = true;
		const fetchSnapshot = vi.fn(async (_id: string): Promise<Order> => {
			if (down) throw new Error("backend unavailable");
			return { ...FRESH };
		});
		const local = localClient();
		const live = swrSubscription(local.client, (_id: string) => orders, {
			reconcile: async (key) => {
				await globalMutate(snapshotKey(key), fetchSnapshot(key), {
					revalidate: false,
				});
			},
		});
		const seen: {
			error?: unknown;
			config?: ReturnType<typeof useSWRConfig>;
		} = {};
		function OrdersView() {
			seen.error = useSWRSubscription(id, live).error;
			seen.config = useSWRConfig();
			return null;
		}
		root = createRoot(document.createElement("div"));
		await act(async () => root?.render(createElement(OrdersView)));
		const cached = () =>
			(
				seen.config?.cache.get(snapshotKey(id)) as
					| { data?: unknown }
					| undefined
			)?.data;
		await lose(local);
		expect(fetchSnapshot).toHaveBeenCalledTimes(1);
		expect(local.continuity().state).toBe("gap");
		expect(isSpinetabError(seen.error, "upstream-error")).toBe(true);
		expect(cached()).toEqual(STALE);
		down = false;
		await act(async () => {
			local.connection("reconnecting");
			local.connection("connected");
			await settle();
		});
		expect(fetchSnapshot).toHaveBeenCalledTimes(2);
		expect(local.continuity().state).toBe("continuous");
		expect(local.counts.reconciled).toBe(1);
		expect(cached()).toEqual(FRESH);
		expect(unhandled).toEqual([]);
	});

	it.each(
		FORMS,
	)("DOM-SWR-16 onContinuity: a failed fetch inside try/catch keeps the loss visible, restarts delivery only, and leaves nothing unhandled ($form)", async ({
		options,
	}) => {
		const fetchSnapshot = failing();
		const swr = await mountSwr({ hookFetcher: fetchSnapshot });
		const run = drive(populateOnContinuity(swr.mutate, fetchSnapshot, options));
		await lose(run);
		expect(fetchSnapshot).toHaveBeenCalledTimes(1);
		expect(run.continuity().state).toBe("gap");
		expect(run.counts).toEqual({ reconciled: 0, pending: 1 });
		// With onContinuity set there is no continuity-lost error: the
		// application's handler owns the outcome.
		expect(run.errors()).toEqual([]);
		expect(swr.cached()).toEqual(STALE);
		await settle();
		expect(unhandled).toEqual([]);
	});

	it.each(
		FORMS,
	)("DOM-SWR-16 onContinuity: a successful fetch reconciles and writes the cache ($form)", async ({
		options,
	}) => {
		const fetchSnapshot = working();
		const swr = await mountSwr();
		const run = drive(populateOnContinuity(swr.mutate, fetchSnapshot, options));
		await lose(run);
		expect(run.continuity().state).toBe("continuous");
		expect(run.counts).toEqual({ reconciled: 1, pending: 1 });
		expect(swr.cached()).toEqual(FRESH);
	});

	it.each(
		FORMS,
	)("DOM-SWR-16 onContinuity, two notices for one interruption (detection, then the outcome): the first run's answer lands while the second run's fetch is in flight, which then fails; the loss stays visible ($form)", async ({
		options,
	}) => {
		const api = gated();
		const swr = await mountSwr();
		const run = drive(
			populateOnContinuity(swr.mutate, api.fetchSnapshot, options),
		);
		await twoNotices(run);
		expect(api.fetchSnapshot).toHaveBeenCalledTimes(2);
		await act(async () => {
			api.gates[0]?.resolve({ n: 8 });
			await settle();
		});
		// SWR drops the overtaken mutation's write; its run must not declare.
		expect(run.counts.reconciled).toBe(0);
		expect(run.continuity().state).toBe("unknown");
		expect(swr.cached()).toEqual(STALE);
		await act(async () => {
			api.gates[1]?.reject(new Error("backend unavailable"));
			await settle();
		});
		expect(run.counts).toEqual({ reconciled: 0, pending: 2 });
		expect(run.continuity().state).toBe("unknown");
		expect(swr.cached()).toEqual(STALE);
		expect(run.errors()).toEqual([]);
		await settle();
		expect(unhandled).toEqual([]);
	});

	it("DOM-SWR-16 onContinuity, two notices: the second run's answer is written and reconciles; SWR drops the first run's late write and that run does not declare", async () => {
		const api = gated();
		const swr = await mountSwr();
		const run = drive(
			populateOnContinuity(swr.mutate, api.fetchSnapshot, DOCUMENTED),
		);
		await twoNotices(run);
		await act(async () => {
			api.gates[1]?.resolve({ ...FRESH });
			await settle();
		});
		expect(run.counts.reconciled).toBe(1);
		expect(run.continuity().state).toBe("continuous");
		expect(swr.cached()).toEqual(FRESH);
		await act(async () => {
			api.gates[0]?.resolve({ n: 8 });
			await settle();
		});
		expect(run.counts).toEqual({ reconciled: 1, pending: 2 });
		expect(swr.cached()).toEqual(FRESH);
		await settle();
		expect(unhandled).toEqual([]);
	});

	it("DOM-SWR-16 onContinuity: one options object serves every key, so the run token is kept per key; interleaved notices on two keys both reconcile", async () => {
		const api = gated();
		const swr = await mountSwr();
		const [first, second] = driveKeys(
			populateOnContinuity(swr.mutate, api.fetchSnapshot, DOCUMENTED),
			["1", "2"],
		);
		if (!first || !second) throw new Error("two keys expected");
		// One connection drop: detection on both keys, then both outcomes.
		await act(async () => {
			first.notice("unknown", "reconnected");
			second.notice("unknown", "reconnected");
			await settle();
			first.notice("unknown", "reconnected");
			second.notice("unknown", "reconnected");
			await settle();
		});
		expect(api.fetchSnapshot.mock.calls.map(([id]) => id)).toEqual([
			"1",
			"2",
			"1",
			"2",
		]);
		await act(async () => {
			api.gates[2]?.resolve({ n: 21 });
			api.gates[3]?.resolve({ n: 22 });
			await settle();
		});
		expect(first.continuity().state).toBe("continuous");
		expect(second.continuity().state).toBe("continuous");
		expect(swr.cachedAt(snapshotKey("1"))).toEqual({ n: 21 });
		expect(swr.cachedAt(snapshotKey("2"))).toEqual({ n: 22 });
		await act(async () => {
			api.gates[0]?.resolve({ n: 11 });
			api.gates[1]?.resolve({ n: 12 });
			await settle();
		});
		expect(first.counts.reconciled).toBe(1);
		expect(second.counts.reconciled).toBe(1);
		expect(swr.cachedAt(snapshotKey("1"))).toEqual({ n: 21 });
		expect(swr.cachedAt(snapshotKey("2"))).toEqual({ n: 22 });
		await settle();
		expect(unhandled).toEqual([]);
	});

	it("DOM-SWR-16 anti-pattern (the previous escape hatch, no run token): in the two-notice flow the overtaken run declares although SWR dropped its write; the second fetch then fails and continuity reads continuous", async () => {
		const api = gated();
		const swr = await mountSwr();
		const run = drive(
			previousOnContinuity(swr.mutate, api.fetchSnapshot, DOCUMENTED),
		);
		await twoNotices(run);
		await act(async () => {
			api.gates[0]?.resolve({ n: 8 });
			await settle();
		});
		expect(run.counts.reconciled).toBe(1);
		expect(run.continuity().state).toBe("continuous");
		expect(swr.cached()).toEqual(STALE);
		await act(async () => {
			api.gates[1]?.reject(new Error("backend unavailable"));
			await settle();
		});
		expect(run.continuity().state).toBe("continuous");
		expect(swr.cached()).toEqual(STALE);
		await settle();
		expect(unhandled).toEqual([]);
	});
});

describe("DOM-SWR-17 anti-pattern, never a recipe: the superseded key-only mutate(key)", () => {
	// Pinned so a change in SWR is noticed. Key-only mutate runs the mounted
	// hook's revalidator, which catches the fetch error, and resolves with the
	// cached data; with no hook, or while paused, it fetches nothing and
	// resolves. Either way the loss is declared reconciled over stale data.
	it.each([
		{
			row: "root's case: a mounted hook whose fetcher rejects",
			backend: "failing",
			hook: true,
			paused: false,
			recipe: keyOnly,
			fetches: 1,
			hookError: "backend unavailable",
		},
		{
			row: "no mounted hook",
			backend: "working",
			hook: false,
			paused: false,
			recipe: keyOnly,
			fetches: 0,
			hookError: undefined,
		},
		{
			row: "SWR isPaused",
			backend: "working",
			hook: true,
			paused: true,
			recipe: keyOnly,
			fetches: 0,
			hookError: undefined,
		},
		{
			row: "the old onContinuity example, fetcher rejects",
			backend: "failing",
			hook: true,
			paused: false,
			recipe: keyOnlyOnContinuity,
			fetches: 1,
			hookError: "backend unavailable",
		},
	])("$row: declared reconciled although nothing fresh was written", async (row) => {
		const fetchSnapshot = row.backend === "failing" ? failing() : working();
		const swr = await mountSwr({
			...(row.hook ? { hookFetcher: fetchSnapshot } : {}),
			paused: row.paused,
		});
		const run = drive(row.recipe(swr.mutate, fetchSnapshot));
		await lose(run);
		expect(fetchSnapshot).toHaveBeenCalledTimes(row.fetches);
		expect(swr.cached()).toEqual(STALE);
		expect((swr.view.error as Error | undefined)?.message).toBe(row.hookError);
		expect(run.continuity().state).toBe("continuous");
		expect(run.counts.reconciled).toBe(1);
	});
});
