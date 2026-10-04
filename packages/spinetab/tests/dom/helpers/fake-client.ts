import { stableStringify } from "../../../src/core/identity.ts";
import { createStore, type WritableStore } from "../../../src/core/store.ts";
import type {
	ClientStatus,
	CommandOutcome,
	ConsumerOptions,
	Continuity,
	EventMeta,
	Feed,
	SerialisedError,
	SpinetabClient,
	Subscription,
	SubscriptionObserver,
	SubscriptionRequest,
	SubscriptionStatus,
} from "../../../src/core/types.ts";

/**
 * Fake `SpinetabClient` for binding tests. It keeps consumer references per
 * canonical identity and models the runtime's upstream sharing with a linger
 * of one macrotask, so tests can count consumer and upstream subscriptions.
 * `leaky: true` keeps delivering to unsubscribed consumers, to prove that a
 * binding guards its own callbacks after teardown.
 *
 * Like the runtime, `gap/overflow` and `gap/message-too-large` stop event
 * delivery (not errors) to the affected consumers until `markReconciled()`, which also moves their
 * continuity to `continuous/reconciled` (a new epoch). `markReconciled({ pending: true })`
 * restarts delivery but keeps continuity as it is. A handle's
 * `retry()` is counted per consumer.
 *
 * Opt-in, for the identity matrix: `reportUnhandledErrors: true` models core's loud
 * path (client.ts, stopped delivery): when a stop reason leaves a consumer
 * stopped after its status listeners ran and its observer has no `status`
 * hook, `reports` receives `continuity-lost` once per consumer.
 * `onSubscribe(consumer)` runs inside `subscribe()`, before the handle is
 * returned, so a test can deliver synchronously as core may.
 */
export interface FakeConsumer {
	id: string;
	key: string;
	request: SubscriptionRequest<unknown>;
	observer: SubscriptionObserver<unknown>;
	options: ConsumerOptions | undefined;
	status: WritableStore<SubscriptionStatus>;
	updates: unknown[];
	/** Calls to `markReconciled()`, including any after unsubscribe. */
	reconciled: number;
	/** Calls to `markReconciled({ pending: true })`. */
	pendingReconciles: number;
	/** Calls to the handle's `retry()`. */
	retries: number;
	/** Delivery stopped by overflow or an oversized event. */
	stopped: boolean;
	closed: boolean;
}

export interface FakeClient extends SpinetabClient {
	readonly consumers: FakeConsumer[];
	/** Consumers not yet unsubscribed. */
	active(): FakeConsumer[];
	counts: {
		subscribes: number;
		unsubscribes: number;
		upstreamStarts: number;
		upstreamStops: number;
		retries: number;
		starts: number;
	};
	/** Upstream subscriptions currently open (after linger). */
	upstream(): string[];
	emit(event: unknown, match?: (consumer: FakeConsumer) => boolean): void;
	fail(
		error: SerialisedError,
		match?: (consumer: FakeConsumer) => boolean,
	): void;
	setConnection(
		state: SubscriptionStatus["connection"]["state"],
		reason?: SubscriptionStatus["connection"]["reason"],
	): void;
	setContinuity(
		state: Continuity["state"],
		reason?: Continuity["reason"],
	): void;
	setClientStatus(status: Partial<ClientStatus>): void;
	/** loud reports (codes), recorded only with `reportUnhandledErrors: true`. */
	readonly reports: string[];
}

export const keyOf = (request: SubscriptionRequest<unknown>) =>
	stableStringify({
		adapter: request.adapter,
		connection: request.connection,
		subscription: request.subscription,
		scope: request.scope,
	});

export function createFakeClient(
	options: {
		leaky?: boolean;
		reportUnhandledErrors?: boolean;
		onSubscribe?(consumer: FakeConsumer): void;
	} = {},
): FakeClient {
	const consumers: FakeConsumer[] = [];
	const reports: string[] = [];
	const reported = new WeakSet<FakeConsumer>();
	const upstream = new Set<string>();
	const lingering = new Map<string, ReturnType<typeof setTimeout>>();
	const counts: FakeClient["counts"] = {
		subscribes: 0,
		unsubscribes: 0,
		upstreamStarts: 0,
		upstreamStops: 0,
		retries: 0,
		starts: 0,
	};
	const status = createStore<ClientStatus>({
		mode: "shared",
		health: "healthy",
		generation: 1,
	});
	let seq = 0;
	const deliverable = (consumer: FakeConsumer) =>
		options.leaky || !consumer.closed;
	const stops = (continuity: Continuity) =>
		continuity.state === "gap" &&
		(continuity.reason === "overflow" ||
			continuity.reason === "message-too-large");
	const update = (
		change: (current: SubscriptionStatus) => SubscriptionStatus,
	) => {
		for (const consumer of consumers.filter((c) => !c.closed)) {
			const next = change(consumer.status.get());
			if (stops(next.continuity)) consumer.stopped = true;
			consumer.status.set(next);
			consumer.observer.status?.(next);
			// Core reads the hook after its listeners ran (a reconcile engine
			// restarts delivery at once) and reports each registration once.
			if (
				options.reportUnhandledErrors &&
				consumer.stopped &&
				typeof consumer.observer.status !== "function" &&
				!reported.has(consumer)
			) {
				reported.add(consumer);
				reports.push("continuity-lost");
			}
		}
	};

	const client: FakeClient = {
		status,
		scope: "",
		consumers,
		counts,
		reports,
		start() {
			counts.starts += 1;
		},
		active: () => consumers.filter((consumer) => !consumer.closed),
		upstream: () => [...upstream],
		subscribe<E>(
			request: SubscriptionRequest<E>,
			observer: SubscriptionObserver<E>,
			consumerOptions?: ConsumerOptions,
		): Subscription<E> {
			counts.subscribes += 1;
			const key = keyOf(request);
			const linger = lingering.get(key);
			if (linger) {
				clearTimeout(linger);
				lingering.delete(key);
			} else if (!upstream.has(key)) {
				upstream.add(key);
				counts.upstreamStarts += 1;
			}
			const consumer: FakeConsumer = {
				id: `consumer-${consumers.length + 1}`,
				key,
				request: request as SubscriptionRequest<unknown>,
				observer: observer as SubscriptionObserver<unknown>,
				options: consumerOptions,
				status: createStore<SubscriptionStatus>({
					active: true,
					connection: { state: "connecting", since: 1 },
					continuity: { state: "continuous", since: 1 },
				}),
				updates: [],
				reconciled: 0,
				pendingReconciles: 0,
				retries: 0,
				stopped: false,
				closed: false,
			};
			consumers.push(consumer);
			options.onSubscribe?.(consumer);
			return {
				id: consumer.id,
				status: consumer.status,
				update(value) {
					consumer.updates.push(value);
				},
				markReconciled(markOptions) {
					if (markOptions?.pending) {
						consumer.pendingReconciles += 1;
						if (!consumer.closed) consumer.stopped = false;
						return;
					}
					consumer.reconciled += 1;
					if (consumer.closed) return;
					consumer.stopped = false;
					const next: SubscriptionStatus = {
						...consumer.status.get(),
						continuity: {
							state: "continuous",
							reason: "reconciled",
							since: Date.now(),
						},
					};
					consumer.status.set(next);
					consumer.observer.status?.(next);
				},
				retry() {
					consumer.retries += 1;
				},
				unsubscribe() {
					if (consumer.closed) return;
					consumer.closed = true;
					counts.unsubscribes += 1;
					const others = consumers.some((c) => !c.closed && c.key === key);
					if (others) return;
					lingering.set(
						key,
						setTimeout(() => {
							lingering.delete(key);
							upstream.delete(key);
							counts.upstreamStops += 1;
						}, 0),
					);
				},
			};
		},
		async command<R>(): Promise<CommandOutcome<R>> {
			return { status: "sent" };
		},
		setCredentialRevision() {},
		setScope() {},
		async checkHealth() {
			return status.get();
		},
		retry() {
			counts.retries += 1;
		},
		dispose() {},
		emit(event, match = () => true) {
			for (const consumer of consumers) {
				if (!deliverable(consumer) || consumer.stopped || !match(consumer)) {
					continue;
				}
				const meta: EventMeta = { seq: ++seq };
				consumer.observer.next(event, meta);
			}
		},
		fail(error, match = () => true) {
			for (const consumer of consumers) {
				if (!deliverable(consumer) || !match(consumer)) continue;
				consumer.observer.error?.(error);
			}
		},
		setConnection(state, reason) {
			update((current) => ({
				...current,
				connection: { state, ...(reason ? { reason } : {}), since: Date.now() },
			}));
		},
		setContinuity(state, reason) {
			update((current) => ({
				...current,
				continuity: { state, ...(reason ? { reason } : {}), since: Date.now() },
			}));
		},
		setClientStatus(next) {
			status.patch(next);
		},
	};
	return client;
}

export const request = (
	topic: string,
	extra: Partial<SubscriptionRequest<{ n: number }>> = {},
): SubscriptionRequest<{ n: number }> => ({
	adapter: "test",
	connection: { url: "wss://example.test/feed" },
	subscription: { topic },
	...extra,
});

/**
 * A feed: a builder result whose `.subscription()` takes no argument and
 * builds `request(topic)`. Each call returns new objects, as an inline builder
 * call does on every render.
 */
export const feed = (topic: string): Feed<{ n: number }> => ({
	connection: { url: "wss://example.test/feed" },
	subscription: () => request(topic),
});

/** Matches the consumers of `feed(topic)` or `request(topic)`, open or closed. */
export const byTopic = (topic: string) => (consumer: FakeConsumer) =>
	(consumer.request.subscription as { topic?: unknown }).topic === topic;

export const macrotask = () =>
	new Promise<void>((resolve) => setTimeout(resolve, 0));
