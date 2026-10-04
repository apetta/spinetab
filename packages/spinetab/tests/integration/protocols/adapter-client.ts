import type {
	AdapterConnection,
	AdapterSubscription,
	RuntimeAdapter,
} from "../../../src/core/adapter.ts";
import { stableStringify } from "../../../src/core/identity.ts";
import { createStore } from "../../../src/core/store.ts";
import type {
	CommandOutcome,
	CommandRequest,
	ConnectionStatus,
	ConsumerOptions,
	Continuity,
	ContinuityReason,
	Credentials,
	SpinetabClient,
	Subscription,
	SubscriptionObserver,
	SubscriptionRequest,
	SubscriptionStatus,
} from "../../../src/core/types.ts";
import { createTestContext, type TestContext } from "./helpers.ts";

/**
 * Test-only `SpinetabClient` that routes requests straight to real runtime
 * adapters in this realm: connection and subscription identity, shared
 * upstream work with reference counts, per-consumer status and continuity.
 * It stands in for the core runtime (written concurrently) so the Apollo and
 * tRPC page links can be exercised against real protocol servers. It does not
 * model the bridge, delivery limits or overflow.
 */

const CONTINUITY: Partial<Record<ContinuityReason, Continuity["state"]>> = {
	"runtime-replaced": "unknown",
	"lease-expired": "unknown",
	overflow: "gap",
	"message-too-large": "gap",
	"event-not-serialisable": "gap",
	reconnected: "unknown",
	reopened: "unknown",
	"resumed-with-cursor": "resumed",
	recovered: "continuous",
	reconciled: "continuous",
	"decode-error": "gap",
};

interface Consumer {
	id: string;
	request: SubscriptionRequest;
	observer: SubscriptionObserver<unknown>;
	options: ConsumerOptions | undefined;
	status: ReturnType<typeof createStore<SubscriptionStatus>>;
	seq: number;
	lastEventId: string | undefined;
	shared: SharedSubscription | undefined;
	active: boolean;
}

interface SharedSubscription {
	key: string;
	upstream: AdapterSubscription;
	consumers: Set<Consumer>;
	connection: ConnectionEntry;
}

interface ConnectionEntry {
	key: string;
	adapter: RuntimeAdapter;
	connection: AdapterConnection;
	test: TestContext;
	status: ConnectionStatus;
	subscriptions: Map<string, SharedSubscription>;
}

export interface AdapterClient extends SpinetabClient {
	connections(): ConnectionEntry[];
	/** Simulate runtime replacement: dispose everything, re-register intent via `resume`. */
	replaceRuntime(): void;
	/** Identities with live upstream work (for sharing assertions). */
	subscriptionKeys(): string[];
}

export function createAdapterClient(options: {
	adapters: RuntimeAdapter<never, never, never, never, never, never>[];
	scope?: string;
	credentials?: (revision: number) => Credentials;
	idleCloseMs?: number;
}): AdapterClient {
	const adapters = options.adapters as unknown as RuntimeAdapter[];
	const scope = options.scope ?? "";
	const entries = new Map<string, ConnectionEntry>();
	const consumers = new Set<Consumer>();
	let consumerIds = 0;
	const now = () => performance.now();

	const connectionFor = (
		adapter: RuntimeAdapter,
		spec: unknown,
	): ConnectionEntry => {
		adapter.validateConnection?.(spec);
		const key = `${adapter.kind}|${adapter.connectionKey?.(spec) ?? stableStringify(spec)}`;
		let entry = entries.get(key);
		if (!entry) {
			const test = createTestContext({
				scope,
				...(options.credentials ? { credentials: options.credentials } : {}),
				limits: { idleCloseMs: options.idleCloseMs ?? 100 },
				key,
			});
			const created: ConnectionEntry = {
				key,
				adapter,
				test,
				status: { state: "connecting", since: now() },
				subscriptions: new Map(),
				connection: undefined as unknown as AdapterConnection,
			};
			const setStatus = test.ctx.setStatus.bind(test.ctx);
			test.ctx.setStatus = (status) => {
				setStatus(status);
				created.status = { ...status, since: now() };
				for (const shared of created.subscriptions.values()) {
					for (const consumer of shared.consumers) {
						publish(consumer, { connection: created.status });
					}
				}
			};
			created.connection = adapter.connect(spec, test.ctx);
			entry = created;
			entries.set(key, entry);
		}
		return entry;
	};

	const publish = (consumer: Consumer, change: Partial<SubscriptionStatus>) => {
		if (!consumer.active) return;
		const next = { ...consumer.status.get(), ...change };
		consumer.status.set(next);
		consumer.observer.status?.(next);
	};

	const attach = (consumer: Consumer) => {
		const adapter = adapters.find(
			(item) => item.kind === consumer.request.adapter,
		);
		if (!adapter)
			throw new Error(`adapter ${consumer.request.adapter} not registered`);
		const entry = connectionFor(adapter, consumer.request.connection);
		adapter.validateSubscription?.(consumer.request.subscription);
		const key =
			adapter.subscriptionKey?.(consumer.request.subscription) ??
			stableStringify(consumer.request.subscription);
		let shared = entry.subscriptions.get(key);
		if (!shared) {
			const created: SharedSubscription = {
				key,
				consumers: new Set(),
				connection: entry,
				upstream: undefined as unknown as AdapterSubscription,
			};
			entry.subscriptions.set(key, created);
			created.upstream = entry.connection.subscribe(
				consumer.request.subscription,
				{
					next(event, meta) {
						for (const target of [...created.consumers]) {
							if (meta?.consumers && !meta.consumers.includes(target.id))
								continue;
							target.seq += 1;
							if (meta?.eventId) target.lastEventId = meta.eventId;
							target.observer.next(event, {
								seq: target.seq,
								...(meta?.eventId ? { eventId: meta.eventId } : {}),
							});
						}
					},
					error(error) {
						entry.subscriptions.delete(key);
						for (const target of [...created.consumers]) {
							target.active = false;
							target.observer.error?.(error);
						}
					},
					complete() {
						entry.subscriptions.delete(key);
						for (const target of [...created.consumers]) {
							target.active = false;
							target.observer.complete?.();
						}
					},
					continuity(reason, detail) {
						for (const target of created.consumers) {
							publish(target, {
								continuity: {
									state: CONTINUITY[reason] ?? "unknown",
									reason,
									since: now(),
									...(detail?.cursor ? { cursor: detail.cursor } : {}),
									...(detail?.duplicatesPossible
										? { duplicatesPossible: true }
										: {}),
								},
							});
						}
					},
					started() {},
				},
				{
					key,
					repeatable:
						consumer.request.repeatable ??
						adapter.repeatable?.(consumer.request.subscription) ??
						true,
				},
			);
			shared = created;
		}
		shared.consumers.add(consumer);
		consumer.shared = shared;
		publish(consumer, { active: true, connection: entry.status });
	};

	const detach = (consumer: Consumer) => {
		const shared = consumer.shared;
		consumer.shared = undefined;
		if (!shared) return;
		shared.consumers.delete(consumer);
		if (shared.consumers.size === 0) {
			shared.connection.subscriptions.delete(shared.key);
			shared.upstream.unsubscribe();
		}
	};

	const status = createStore({
		mode: "local" as const,
		health: "healthy" as const,
		generation: 1,
	});

	const client: AdapterClient = {
		status,
		scope,
		start() {},
		subscribe<E>(
			request: SubscriptionRequest<E>,
			observer: SubscriptionObserver<E>,
			consumerOptions?: ConsumerOptions,
		): Subscription<E> {
			consumerIds += 1;
			const consumer: Consumer = {
				id: `c${consumerIds}`,
				request: request as SubscriptionRequest,
				observer: observer as SubscriptionObserver<unknown>,
				options: consumerOptions,
				status: createStore<SubscriptionStatus>({
					active: false,
					connection: { state: "inactive", since: now() },
					continuity: { state: "continuous", since: now() },
				}),
				seq: 0,
				lastEventId: undefined,
				shared: undefined,
				active: true,
			};
			consumers.add(consumer);
			attach(consumer);
			return {
				id: consumer.id,
				status: consumer.status,
				update() {},
				markReconciled() {
					publish(consumer, {
						continuity: {
							state: "continuous",
							reason: "reconciled",
							since: now(),
						},
					});
				},
				retry() {
					// This consumer's connection only.
					const adapter = adapters.find(
						(item) => item.kind === consumer.request.adapter,
					);
					if (!adapter || !consumer.active) return;
					connectionFor(
						adapter,
						consumer.request.connection,
					).connection.retry?.();
				},
				unsubscribe() {
					if (!consumers.delete(consumer)) return;
					consumer.active = false;
					detach(consumer);
				},
			};
		},
		async command<R>(request: CommandRequest<R>): Promise<CommandOutcome<R>> {
			const adapter = adapters.find((item) => item.kind === request.adapter);
			if (!adapter)
				throw new Error(`adapter ${request.adapter} not registered`);
			const entry = connectionFor(adapter, request.connection);
			return (await entry.connection.command?.(request.payload as never, {
				id: crypto.randomUUID(),
				signal: new AbortController().signal,
				timeoutMs: 30_000,
			})) as CommandOutcome<R>;
		},
		setCredentialRevision(revision) {
			for (const entry of entries.values()) {
				entry.test.setRevision(Number(revision));
				entry.connection.rotate?.();
			}
		},
		setScope() {
			throw new Error("not modelled");
		},
		async checkHealth() {
			return status.get();
		},
		retry() {
			for (const entry of entries.values()) entry.connection.retry?.();
		},
		dispose() {
			for (const consumer of consumers) consumer.active = false;
			consumers.clear();
			for (const entry of entries.values()) entry.connection.dispose();
			entries.clear();
		},
		connections: () => [...entries.values()],
		subscriptionKeys: () =>
			[...entries.values()].flatMap((entry) => [...entry.subscriptions.keys()]),
		replaceRuntime() {
			for (const entry of entries.values()) entry.connection.dispose();
			entries.clear();
			for (const consumer of consumers) {
				consumer.shared = undefined;
				const override = consumer.options?.resume?.({
					...(consumer.lastEventId
						? { lastEventId: consumer.lastEventId }
						: {}),
				});
				if (override?.subscription !== undefined) {
					consumer.request = {
						...consumer.request,
						subscription: override.subscription,
					};
				}
				publish(consumer, {
					continuity: {
						state: "unknown",
						reason: "runtime-replaced",
						since: now(),
					},
				});
				attach(consumer);
			}
		},
	};
	return client;
}
