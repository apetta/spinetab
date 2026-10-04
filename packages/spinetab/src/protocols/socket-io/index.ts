import type { CommandRequest, SubscriptionRequest } from "../../core/types.ts";
import { invalid, toJson, withUrl } from "../shared/validate.ts";
import {
	type SocketIoCommand,
	type SocketIoConnection,
	type SocketIoSubscriptionSpec,
	validateSocketIoCommand,
	validateSocketIoConnection,
	validateSocketIoSubscription,
} from "./spec.ts";

export type {
	SocketIoCommand,
	SocketIoConnection,
	SocketIoEmitSpec,
	SocketIoSubscriptionSpec,
} from "./spec.ts";

export type SocketIoOptions = Omit<SocketIoConnection, "tab" | "membership">;

export interface SocketIoEndpoint {
	readonly adapter: "socket-io";
	readonly connection: SocketIoConnection;
	/** Listener for `event`; events arrive as the ordered argument array. */
	subscription<E extends unknown[] = unknown[]>(
		spec: SocketIoSubscriptionSpec,
		options?: { scope?: string },
	): SubscriptionRequest<E, SocketIoConnection, SocketIoSubscriptionSpec>;
	/** Emitted at most once; never re-sent after a disconnect. */
	command<R = unknown>(
		spec: SocketIoCommand,
		options?: { scope?: string },
	): CommandRequest<R, SocketIoConnection, SocketIoCommand>;
}

let tabId: string | undefined;

/** One id per page realm, created on first use (no import-time work). */
function currentTab(): string {
	tabId ??= globalThis.crypto.randomUUID();
	return tabId;
}

/**
 * Socket.IO endpoint. Page-only: builds cloneable requests; the worker hosts
 * the real `socket.io-client` Manager through `socketIoAdapter()` from
 * `spinetab/socket-io/runtime`.
 *
 * ```ts
 * const chat = socketIo("/chat", { sharing: "shared" }); // namespace /chat
 * client.subscribe(chat.subscription({ event: "message", membership: room, route: "byRoom",
 * join: { event: "join", args: [room] } }), observer);
 * await client.command(chat.command({ event: "send", args: [text] }));
 * ```
 *
 * As with upstream `io()`, the URL path is the namespace and the origin is
 * the Manager URI. `socketIo(url, options)` and `socketIo({ url,...options })`
 * give the same connection; `sharing` is required in both.
 */
export function socketIo(
	url: string,
	options: Omit<SocketIoOptions, "url">,
): SocketIoEndpoint;
/** Options form of `socketIo(url, options)`; both give the same connection. */
export function socketIo(options: SocketIoOptions): SocketIoEndpoint;
export function socketIo(
	input: string | SocketIoOptions,
	options?: Omit<SocketIoOptions, "url">,
): SocketIoEndpoint {
	const connectionOptions = withUrl(input, options);
	validateSocketIoConnection(
		connectionOptions,
		{ absolute: false },
		"socketIo",
	);
	const base = toJson(connectionOptions) as SocketIoConnection;
	const connection: SocketIoConnection =
		base.sharing === "per-tab" ? { ...base, tab: currentTab() } : base;
	return {
		adapter: "socket-io",
		connection,
		subscription<E extends unknown[] = unknown[]>(
			spec: SocketIoSubscriptionSpec,
			options?: { scope?: string },
		) {
			// `subscribe(endpoint, …)` calls this with no argument.
			if (spec === undefined) {
				throw invalid(
					"subscription",
					"needs an event; pass endpoint.subscription({ event }), not the endpoint.",
				);
			}
			validateSocketIoSubscription(spec, undefined);
			const subscription = toJson(spec);
			// Membership keys without a worker-side route cannot share a socket
			// with other keys: they get their own connection identity.
			const target =
				subscription.membership !== undefined &&
				subscription.route === undefined
					? { ...connection, membership: subscription.membership }
					: connection;
			const request: SubscriptionRequest<
				E,
				SocketIoConnection,
				SocketIoSubscriptionSpec
			> = { adapter: "socket-io", connection: target, subscription };
			if (options?.scope !== undefined) request.scope = options.scope;
			return request;
		},
		command<R = unknown>(spec: SocketIoCommand, options?: { scope?: string }) {
			validateSocketIoCommand(spec);
			const request: CommandRequest<R, SocketIoConnection, SocketIoCommand> = {
				adapter: "socket-io",
				connection,
				payload: toJson(spec),
			};
			if (options?.scope !== undefined) request.scope = options.scope;
			return request;
		},
	};
}
