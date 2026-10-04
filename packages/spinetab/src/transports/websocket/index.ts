import type {
	CommandRequest,
	Json,
	SubscriptionRequest,
} from "../../core/types.ts";
import { withUrl } from "../shared/options.ts";
import {
	validateWebSocketConnection,
	type WebSocketCommandPayload,
	type WebSocketConnectionSpec,
	type WebSocketSubscriptionSpec,
} from "./spec.ts";

export type {
	WebSocketCommandPayload,
	WebSocketConnectionSpec,
	WebSocketSubscriptionSpec,
};

export const WEBSOCKET_ADAPTER = "websocket";

export interface WebSocketFeed<Topic extends Json = Json> {
	readonly connection: WebSocketConnectionSpec;
	/**
	 * Subscribe to a protocol-routed topic, or omit the topic for every event
	 * on the connection. One socket serves every topic of this identity.
	 */
	subscription<E = unknown>(
		topic?: Topic,
	): SubscriptionRequest<E, WebSocketConnectionSpec, WebSocketSubscriptionSpec>;
	/**
	 * The same call without a type argument. Listed last, as on the other
	 * transport feeds, so a union of feed types can call `.subscription()`.
	 */
	subscription(
		topic?: Topic,
	): SubscriptionRequest<
		unknown,
		WebSocketConnectionSpec,
		WebSocketSubscriptionSpec
	>;
	/**
	 * One individual command. Outcomes: `acknowledged`/`rejected` (correlated
	 * reply), `sent` (fire-and-forget), `not-sent` (never written) or `unknown`
	 * (written, no reply). Uncertain commands are never replayed.
	 */
	command<R = unknown>(
		payload: Json,
		options?: { expectsAck?: boolean },
	): CommandRequest<R, WebSocketConnectionSpec, WebSocketCommandPayload>;
}

/**
 * A raw connection (no `protocol`): one feed of every frame, typed as the
 * runtime delivers it. `string | ArrayBuffer` by default, `string | Blob`
 * with `binaryType: "blob"`, and the claimed shape with `decoder: "json"`.
 * Raw feeds have no topics.
 */
export interface RawWebSocketFeed<E = string | ArrayBuffer> {
	readonly connection: WebSocketConnectionSpec;
	subscription(): SubscriptionRequest<
		E,
		WebSocketConnectionSpec,
		WebSocketSubscriptionSpec
	>;
	/** One frame, sent as given; outcomes as on {@link WebSocketFeed.command}. */
	command<R = unknown>(
		payload: Json,
		options?: { expectsAck?: boolean },
	): CommandRequest<R, WebSocketConnectionSpec, WebSocketCommandPayload>;
}

type Options = Omit<WebSocketConnectionSpec, "url">;
type RawOptions = Omit<Options, "protocol" | "decoder"> & { protocol?: never };

/**
 * Describe a WebSocket connection. Codecs, routing, subscribe and command
 * hooks live in the worker's `websocketAdapter({ protocols })` and are
 * referenced by `protocol` name; the protocol's codec decides the payload,
 * which `.subscription<E>(topic)` names. Options are validated synchronously.
 * `websocket(url, options)` and `websocket({ url,...options })` are one
 * connection.
 */
export function websocket<Topic extends Json = Json>(
	url: string,
	options: Options & { protocol: string },
): WebSocketFeed<Topic>;
export function websocket<E = unknown>(
	url: string,
	options: RawOptions & { decoder: "json" },
): RawWebSocketFeed<E>;
export function websocket(
	url: string,
	options: RawOptions & { binaryType: "blob"; decoder?: never },
): RawWebSocketFeed<string | Blob>;
export function websocket(
	url: string,
	options?: RawOptions & { binaryType?: "arraybuffer"; decoder?: never },
): RawWebSocketFeed;
/**
 * Options whose shape is not known here, such as a shared partial spec (the
 * escape hatch): the protocol's codec decides, so the payload is named at
 * `.subscription<E>()`.
 */
export function websocket<Topic extends Json = Json>(
	url: string,
	options: Options,
): WebSocketFeed<Topic>;
export function websocket<Topic extends Json = Json>(
	connection: WebSocketConnectionSpec & { protocol: string },
): WebSocketFeed<Topic>;
export function websocket<E = unknown>(
	connection: RawOptions & { url: string; decoder: "json" },
): RawWebSocketFeed<E>;
export function websocket(
	connection: RawOptions & {
		url: string;
		binaryType: "blob";
		decoder?: never;
	},
): RawWebSocketFeed<string | Blob>;
export function websocket(
	connection: RawOptions & {
		url: string;
		binaryType?: "arraybuffer";
		decoder?: never;
	},
): RawWebSocketFeed;
/** A spec whose shape is not known here (the escape hatch): the codec decides. */
export function websocket<Topic extends Json = Json>(
	connection: WebSocketConnectionSpec,
): WebSocketFeed<Topic>;
export function websocket<Topic extends Json = Json>(
	target: string | WebSocketConnectionSpec,
	options?: Options,
): WebSocketFeed<Topic> {
	const connection =
		typeof target === "string"
			? withUrl(target, options, "connection")
			: target;
	validateWebSocketConnection(connection, { requireAbsolute: false });
	return {
		connection,
		subscription(topic?: Topic) {
			return {
				adapter: WEBSOCKET_ADAPTER,
				connection,
				subscription: topic === undefined ? {} : { topic },
			};
		},
		command(payload, options = {}) {
			const body: WebSocketCommandPayload = { data: payload };
			if (options.expectsAck !== undefined)
				body.expectsAck = options.expectsAck;
			return { adapter: WEBSOCKET_ADAPTER, connection, payload: body };
		},
	};
}
