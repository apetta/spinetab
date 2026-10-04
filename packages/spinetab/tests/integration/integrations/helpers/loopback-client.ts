import type {
	AdapterConnection,
	AdapterSubscription,
	ConnectionContext,
	RuntimeAdapter,
	SubscriptionSink,
} from "../../../../src/core/adapter.ts";
import { toSerialisedError } from "../../../../src/core/errors.ts";
import { stableStringify } from "../../../../src/core/identity.ts";
import { DEFAULT_LIMITS } from "../../../../src/core/limits.ts";
import { createStore, type WritableStore } from "../../../../src/core/store.ts";
import type {
	ClientStatus,
	CommandOutcome,
	CommandRequest,
	ConnectionStatus,
	Credentials,
	RuntimeLimits,
	SerialisedError,
	SpinetabClient,
	Subscription,
	SubscriptionObserver,
	SubscriptionRequest,
	SubscriptionStatus,
} from "../../../../src/core/types.ts";

/**
 * In-process stand-in for the Spinetab runtime used while `createRuntime` is
 * not available. It hosts real adapters and reproduces the contract points the
 * AI transport depends on: identity-keyed sharing of one adapter subscription,
 * `share: "before-start"` rejection (`late-join-unsupported`), structured
 * cloning and macrotask delivery per consumer, linger of one macrotask before
 * the adapter unsubscribe, and a per-consumer stall switch that overflows a
 * consumer (`gap/overflow`) after `maxPendingMessagesPerConsumer` held events.
 * It is test infrastructure, not runtime evidence.
 */
// biome-ignore lint/suspicious/noExplicitAny: hosts adapters of any spec types.
type AnyAdapter = RuntimeAdapter<any, any, any, any, any, any>;
// biome-ignore lint/suspicious/noExplicitAny: hosts adapters of any spec types.
type AnyConnection = AdapterConnection<any, any, any, any, any>;

export interface LoopbackOptions {
	adapters: AnyAdapter[];
	scope?: string;
	credentials?: () => Credentials | Promise<Credentials>;
	limits?: Partial<RuntimeLimits>;
}

interface Consumer {
	id: string;
	group: Group;
	observer: SubscriptionObserver<unknown>;
	status: WritableStore<SubscriptionStatus>;
	stalled: boolean;
	held: unknown[];
	overflowed: boolean;
	closed: boolean;
	seq: number;
}

interface Group {
	key: string;
	connectionKey: string;
	consumers: Set<Consumer>;
	adapterSubscription: AdapterSubscription | undefined;
	started: boolean;
	ended: boolean;
	lingerTimer: ReturnType<typeof setTimeout> | undefined;
}

interface HostedConnection {
	connection: AnyConnection;
	controller: AbortController;
	status: ConnectionStatus;
}

export interface LoopbackClient extends SpinetabClient {
	/** Consumers currently registered, for stall/overflow tests. */
	consumers(): Array<{
		id: string;
		key: string;
		stall(): void;
		release(): void;
	}>;
	/** Adapter subscriptions currently open. */
	openGroups(): string[];
	commands: Array<{ adapter: string; payload: unknown }>;
	/** Change the scope (test helper; the real client retires its attachment). */
	changeScope(scope: string): void;
}

const INITIAL_STATUS: ClientStatus = {
	mode: "local",
	health: "healthy",
	generation: 1,
};

export interface LoopbackRuntime {
	/** A page client ("tab") attached to this runtime. */
	client(scope?: string): LoopbackClient;
	openGroups(): string[];
	dispose(): void;
}

/** One runtime shared by several page clients, like tabs on one worker. */
export function createLoopbackRuntime(
	options: Omit<LoopbackOptions, "scope">,
): LoopbackRuntime {
	const limits: RuntimeLimits = { ...DEFAULT_LIMITS, ...options.limits };
	const adapters = new Map(options.adapters.map((a) => [a.kind, a]));
	const connections = new Map<string, HostedConnection>();
	const groups = new Map<string, Group>();
	let nextId = 0;
	const clients: LoopbackClient[] = [];
	return {
		client(scope = "") {
			const client = attachClient({
				scope,
				limits,
				adapters,
				connections,
				groups,
				credentials: options.credentials,
				nextId: () => ++nextId,
			});
			clients.push(client);
			return client;
		},
		openGroups: () => [...groups.keys()],
		dispose() {
			for (const client of clients) client.dispose();
			for (const hosted of connections.values()) {
				hosted.controller.abort();
				hosted.connection.dispose();
			}
			connections.clear();
		},
	};
}

export function createLoopbackClient(options: LoopbackOptions): LoopbackClient {
	return createLoopbackRuntime(options).client(options.scope);
}

interface Shared {
	scope: string;
	limits: RuntimeLimits;
	adapters: Map<string, AnyAdapter>;
	connections: Map<string, HostedConnection>;
	groups: Map<string, Group>;
	credentials: LoopbackOptions["credentials"];
	nextId(): number;
}

function attachClient(shared: Shared): LoopbackClient {
	const { limits, adapters, connections, groups, credentials } = shared;
	let scope = shared.scope;
	const allConsumers = new Set<Consumer>();
	const commands: LoopbackClient["commands"] = [];

	const adapterFor = (kind: string) => {
		const adapter = adapters.get(kind);
		if (!adapter) throw new Error(`adapter ${kind} not registered`);
		return adapter;
	};

	const connectionFor = (
		adapter: AnyAdapter,
		spec: unknown,
	): { key: string; hosted: HostedConnection } => {
		adapter.validateConnection?.(spec);
		const key = `${adapter.kind}|${JSON.stringify(scope)}|${
			adapter.connectionKey?.(spec) ?? stableStringify(spec)
		}`;
		let hosted = connections.get(key);
		if (!hosted) {
			const controller = new AbortController();
			const ctx: ConnectionContext = {
				scope,
				key,
				limits,
				signal: controller.signal,
				credentials: async () => {
					if (!credentials) {
						throw { code: "no-credential-source", message: "none" };
					}
					return credentials();
				},
				rejectCredentials: () => {},
				setStatus: (status) => {
					if (hosted) hosted.status = { ...status, since: Date.now() };
				},
				diagnostic: () => {},
				now: () => performance.now(),
			};
			hosted = {
				connection: undefined as unknown as HostedConnection["connection"],
				controller,
				status: { state: "connecting", since: Date.now() },
			};
			connections.set(key, hosted);
			hosted.connection = adapter.connect(spec, ctx);
		}
		return { key, hosted };
	};

	const deliver = (consumer: Consumer, run: () => void) => {
		setImmediate(() => {
			if (consumer.closed) return;
			run();
		});
	};

	const setContinuity = (
		consumer: Consumer,
		continuity: SubscriptionStatus["continuity"],
	) => {
		const next = { ...consumer.status.get(), continuity };
		consumer.status.set(next);
		deliver(consumer, () => consumer.observer.status?.(next));
	};

	const closeConsumer = (consumer: Consumer) => {
		consumer.closed = true;
		allConsumers.delete(consumer);
		const group = consumer.group;
		group.consumers.delete(consumer);
		if (group.consumers.size === 0 && !group.ended && !group.lingerTimer) {
			group.lingerTimer = setTimeout(() => {
				group.lingerTimer = undefined;
				if (group.consumers.size > 0 || group.ended) return;
				group.ended = true;
				groups.delete(group.key);
				group.adapterSubscription?.unsubscribe();
			}, 0);
		}
	};

	const makeSink = (group: Group): SubscriptionSink<unknown> => ({
		next(event) {
			if (group.ended) return;
			for (const consumer of [...group.consumers]) {
				if (consumer.overflowed) continue;
				const copy = structuredClone(event);
				if (consumer.stalled) {
					consumer.held.push(copy);
					if (consumer.held.length > limits.maxPendingMessagesPerConsumer) {
						consumer.overflowed = true;
						consumer.held = [];
						setContinuity(consumer, {
							state: "gap",
							reason: "overflow",
							since: Date.now(),
						});
					}
					continue;
				}
				const seq = ++consumer.seq;
				deliver(consumer, () => consumer.observer.next(copy, { seq }));
			}
		},
		error(error) {
			if (group.ended) return;
			group.ended = true;
			groups.delete(group.key);
			for (const consumer of [...group.consumers]) {
				const copy = structuredClone(error);
				deliver(consumer, () => {
					consumer.closed = true;
					consumer.observer.error?.(copy);
				});
				allConsumers.delete(consumer);
			}
		},
		complete() {
			if (group.ended) return;
			group.ended = true;
			groups.delete(group.key);
			for (const consumer of [...group.consumers]) {
				deliver(consumer, () => {
					consumer.closed = true;
					consumer.observer.complete?.();
				});
				allConsumers.delete(consumer);
			}
		},
		continuity(reason, detail) {
			for (const consumer of group.consumers) {
				setContinuity(consumer, {
					state: "unknown",
					reason,
					...detail,
					since: Date.now(),
				});
			}
		},
		started() {
			group.started = true;
		},
	});

	const inactive: SubscriptionStatus = {
		active: false,
		connection: { state: "inactive", since: 0 },
		continuity: { state: "continuous", since: 0 },
	};

	const client: LoopbackClient = {
		status: createStore<ClientStatus>(INITIAL_STATUS),
		get scope() {
			return scope;
		},
		start() {},
		subscribe<E>(
			request: SubscriptionRequest<E>,
			observer: SubscriptionObserver<E>,
		): Subscription<E> {
			const id = `c${shared.nextId()}`;
			const statusStore = createStore<SubscriptionStatus>(inactive);
			const handle: Subscription<E> = {
				id,
				status: statusStore,
				update() {},
				markReconciled() {},
				retry() {},
				unsubscribe() {
					if (consumer && !consumer.closed) closeConsumer(consumer);
				},
			};
			let consumer: Consumer | undefined;
			const fail = (error: SerialisedError) => {
				setImmediate(() => observer.error?.(error));
			};
			let adapter: AnyAdapter;
			let hosted: { key: string; hosted: HostedConnection };
			try {
				adapter = adapterFor(request.adapter);
				hosted = connectionFor(adapter, structuredClone(request.connection));
				adapter.validateSubscription?.(request.subscription);
			} catch (error) {
				fail(toSerialisedError(error, "unsupported-option"));
				return handle;
			}
			const spec = structuredClone(request.subscription);
			const key = `${hosted.key}|${adapter.subscriptionKey?.(spec) ?? stableStringify(spec)}`;
			let group = groups.get(key);
			if (group?.started && request.share === "before-start") {
				fail({
					code: "late-join-unsupported",
					message:
						"This stream already started; join it through a resume source.",
				});
				return handle;
			}
			const created = !group;
			if (!group) {
				group = {
					key,
					connectionKey: hosted.key,
					consumers: new Set(),
					adapterSubscription: undefined,
					started: false,
					ended: false,
					lingerTimer: undefined,
				};
				groups.set(key, group);
			}
			if (group.lingerTimer) {
				clearTimeout(group.lingerTimer);
				group.lingerTimer = undefined;
			}
			consumer = {
				id,
				group,
				observer: observer as SubscriptionObserver<unknown>,
				status: statusStore,
				stalled: false,
				held: [],
				overflowed: false,
				closed: false,
				seq: 0,
			};
			group.consumers.add(consumer);
			allConsumers.add(consumer);
			statusStore.set({
				active: true,
				connection: hosted.hosted.status,
				continuity: { state: "continuous", since: Date.now() },
			});
			if (created) {
				group.adapterSubscription = hosted.hosted.connection.subscribe(
					spec,
					makeSink(group),
					{
						key,
						repeatable:
							request.repeatable ?? adapter.repeatable?.(spec) ?? true,
					},
				);
			}
			return handle;
		},
		async command<R>(request: CommandRequest<R>): Promise<CommandOutcome<R>> {
			const adapter = adapterFor(request.adapter);
			const { hosted } = connectionFor(
				adapter,
				structuredClone(request.connection),
			);
			const payload = structuredClone(request.payload);
			commands.push({ adapter: request.adapter, payload });
			if (!hosted.connection.command) {
				return {
					status: "not-sent",
					error: { code: "command-not-sent", message: "no command support" },
				};
			}
			const outcome = await hosted.connection.command(payload, {
				id: `cmd${shared.nextId()}`,
				signal: new AbortController().signal,
				timeoutMs: limits.commandTimeoutMs,
			});
			// Cross the "bridge" on a macrotask like a port reply.
			await new Promise((resolve) => setImmediate(resolve));
			return structuredClone(outcome) as CommandOutcome<R>;
		},
		setCredentialRevision() {},
		setScope(next) {
			client.changeScope(next);
		},
		async checkHealth() {
			return client.status.get();
		},
		retry() {},
		dispose() {
			for (const consumer of [...allConsumers]) closeConsumer(consumer);
		},
		consumers() {
			return [...allConsumers].map((consumer) => ({
				id: consumer.id,
				key: consumer.group.key,
				stall() {
					consumer.stalled = true;
				},
				release() {
					consumer.stalled = false;
					const held = consumer.held;
					consumer.held = [];
					for (const event of held) {
						const seq = ++consumer.seq;
						deliver(consumer, () => consumer.observer.next(event, { seq }));
					}
				},
			}));
		},
		openGroups() {
			return [...groups.keys()];
		},
		commands,
		changeScope(next) {
			scope = next;
		},
	};
	return client;
}
