import type {
	AdapterSubscriptionOptions,
	ConnectionContext,
	RuntimeAdapter,
	SubscriptionSink,
} from "../../../../src/core/adapter.ts";
import { SpinetabError } from "../../../../src/core/errors.ts";
import type { CommandOutcome, Json } from "../../../../src/core/types.ts";

export interface TestSubscription {
	spec: unknown;
	key: string;
	repeatable: boolean;
	sink: SubscriptionSink<unknown>;
	consumers: Map<string, { options: Json | undefined; visible: boolean }>;
	log: string[];
	unsubscribed: boolean;
	emit(
		event: unknown,
		meta?: Parameters<SubscriptionSink<unknown>["next"]>[1],
	): void;
}

export interface TestConnection {
	spec: unknown;
	ctx: ConnectionContext;
	subscriptions: TestSubscription[];
	disposed: boolean;
	probes: number;
	retries: number;
	rotations: number;
	commands: Array<{ payload: unknown; id: string; signal: AbortSignal }>;
}

export interface TestAdapterOptions {
	kind?: string;
	repeatable?: (spec: unknown) => boolean;
	shareable?: (spec: unknown) => boolean;
	idleCloseMs?: number;
	command?: (
		payload: unknown,
		options: { id: string; signal: AbortSignal; timeoutMs: number },
		connection: TestConnection,
	) => Promise<CommandOutcome>;
	/** Reject connection specs that are not `{ url?: string, name?: string }`. */
	strict?: boolean;
	/** Validate consumer options (`{ weight?: number }`). */
	consumerCheck?: boolean;
}

/**
 * Scripted adapter for runtime tests: records every hook call and lets tests
 * push events through the real sink. It exercises the runtime contract, not
 * any upstream protocol.
 */
export function createTestAdapter(options: TestAdapterOptions = {}) {
	const connections: TestConnection[] = [];
	const adapter: RuntimeAdapter<
		unknown,
		unknown,
		unknown,
		unknown,
		unknown,
		Json
	> = {
		kind: options.kind ?? "test",
		version: 1,
		...(options.idleCloseMs === undefined
			? {}
			: { idleCloseMs: options.idleCloseMs }),
		...(options.repeatable ? { repeatable: options.repeatable } : {}),
		...(options.shareable ? { shareable: options.shareable } : {}),
		validateConnection(spec: unknown): asserts spec is unknown {
			if (!options.strict) return;
			if (typeof spec !== "object" || spec === null) {
				throw new SpinetabError(
					"unsupported-option",
					"test: connection must be an object",
					{
						detail: { path: "connection" },
					},
				);
			}
			for (const key of Object.keys(spec)) {
				if (key !== "url" && key !== "name") {
					throw new SpinetabError(
						"unsupported-option",
						`test: connection.${key} is not supported`,
						{
							detail: { path: `connection.${key}`, adapter: "test" },
						},
					);
				}
			}
		},
		validateConsumer(value: unknown): asserts value is Json {
			if (!options.consumerCheck || value === undefined) return;
			if (
				typeof value !== "object" ||
				value === null ||
				typeof (value as { weight?: unknown }).weight !== "number"
			) {
				throw new SpinetabError(
					"unsupported-option",
					"test: consumer.weight must be a number",
					{
						detail: { path: "consumer.weight" },
					},
				);
			}
		},
		connect(spec, ctx) {
			const connection: TestConnection = {
				spec,
				ctx,
				subscriptions: [],
				disposed: false,
				probes: 0,
				retries: 0,
				rotations: 0,
				commands: [],
			};
			connections.push(connection);
			return {
				subscribe(subSpec, sink, subOptions: AdapterSubscriptionOptions) {
					const record: TestSubscription = {
						spec: subSpec,
						key: subOptions.key,
						repeatable: subOptions.repeatable,
						sink,
						consumers: new Map(),
						log: [],
						unsubscribed: false,
						emit: (event, meta) => sink.next(event, meta),
					};
					connection.subscriptions.push(record);
					return {
						unsubscribe() {
							record.unsubscribed = true;
							record.log.push("unsubscribe");
						},
						consumerAdded(id, consumerOptions, context) {
							record.consumers.set(id, {
								options: consumerOptions,
								visible: context.visible,
							});
							record.log.push(`added:${id}`);
						},
						consumerUpdated(id, consumerOptions) {
							const entry = record.consumers.get(id);
							if (entry) entry.options = consumerOptions;
							record.log.push(`updated:${id}`);
						},
						consumerRemoved(id) {
							record.consumers.delete(id);
							record.log.push(`removed:${id}`);
						},
						consumerVisibility(id, visible) {
							const entry = record.consumers.get(id);
							if (entry) entry.visible = visible;
							record.log.push(`visibility:${id}:${visible}`);
						},
					};
				},
				...(options.command
					? {
							command: (
								payload: unknown,
								commandOptions: {
									id: string;
									signal: AbortSignal;
									timeoutMs: number;
								},
							) => {
								connection.commands.push({
									payload,
									id: commandOptions.id,
									signal: commandOptions.signal,
								});
								return (
									options.command as NonNullable<TestAdapterOptions["command"]>
								)(payload, commandOptions, connection);
							},
						}
					: {}),
				probe() {
					connection.probes += 1;
				},
				retry() {
					connection.retries += 1;
				},
				rotate() {
					connection.rotations += 1;
				},
				dispose() {
					connection.disposed = true;
				},
			};
		},
	};
	const all = () =>
		connections.flatMap((connection) => connection.subscriptions);
	return {
		adapter,
		connections,
		/** Live (not unsubscribed) upstream subscriptions across connections. */
		active: () => all().filter((subscription) => !subscription.unsubscribed),
		all,
		last: () => {
			const list = all();
			const found = list[list.length - 1];
			if (!found) throw new Error("no upstream subscription yet");
			return found;
		},
	};
}
