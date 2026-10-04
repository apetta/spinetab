/**
 * WebSocket part of the harness worker: the `ws` fixture's topic protocol,
 * defined as an application would in its worker entry.
 *
 * Wiring (core-owned harness files):
 * live.worker.ts: import * as websocketRuntime from "spinetab/websocket/runtime";
 * import { websocketAdapter } from "./adapters/websocket.ts";
 * createRuntime({ adapters: [..., websocketAdapter(websocketRuntime)] })
 * Pages use `{ adapter: "websocket", connection: { url, protocol: "topics" },
 * subscription: { topic } }` (plain data; `websocket()` builds the same).
 *
 * The runtime module is injected so this file typechecks without a package
 * build; the harness still consumes the built exports. Types are structural:
 * tests/unit/transports/topic-protocol.ts checks them against
 * `WebSocketProtocol`.
 *
 * Wire format (tests/fixtures/servers/ws.ts): JSON text frames, client →
 * server `subscribe | unsubscribe | cmd | ping | auth`, server → client
 * `event | subscribed | subscribe-rejected | ack | pong`. Binary frames: one
 * byte topic length, the UTF-8 topic, then the payload.
 */
type Frame = string | ArrayBuffer;
type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };

type Decoded =
	| { kind: "event"; topics: string[]; event: unknown }
	| { kind: "ack"; id: string; result?: JsonValue; error?: string }
	| {
			kind: "subscribed" | "subscribe-rejected";
			topicKey: string;
			reason?: string;
	  }
	| { kind: "heartbeat" }
	| { kind: "ignore" };

type Heartbeat =
	| { intervalMs: number; timeoutMs: number; frame(): Frame }
	| { expectInboundWithinMs: number };

export interface TopicProtocol {
	topicKey(topic: string): string;
	decode(raw: string | ArrayBuffer): Decoded;
	subscribe(topic: string, topicKey: string): Frame[];
	unsubscribe(topic: string, topicKey: string): Frame[];
	command(
		payload: JsonValue,
		id: string,
	): { frames: Frame[]; expectsAck: boolean };
	classifyClose(
		code: number,
		reason: string,
	): "transient" | "auth" | "permanent";
	authenticate?(credentials: Record<string, unknown>): Frame[];
	heartbeat?: Heartbeat;
	onOversize?: "drop" | "close";
}

interface Message {
	type: string;
	topic?: string;
	data?: JsonValue;
	id?: string;
	result?: JsonValue;
	error?: string;
	reason?: string;
}

export function createTopicProtocol(
	options: {
		heartbeat?: Heartbeat;
		onOversize?: "drop" | "close";
		authenticate?: boolean;
	} = {},
): TopicProtocol {
	const protocol: TopicProtocol = {
		topicKey: (topic) => topic,
		decode(raw) {
			if (typeof raw !== "string") {
				const bytes = new Uint8Array(raw);
				const length = bytes[0] ?? 0;
				const topic = new TextDecoder().decode(bytes.subarray(1, 1 + length));
				return { kind: "event", topics: [topic], event: raw.slice(1 + length) };
			}
			const message = JSON.parse(raw) as Message;
			switch (message.type) {
				case "event":
					return {
						kind: "event",
						topics: [message.topic ?? ""],
						event: message.data,
					};
				case "ack":
					return message.error === undefined
						? { kind: "ack", id: message.id ?? "", result: message.result }
						: { kind: "ack", id: message.id ?? "", error: message.error };
				case "subscribed":
					return { kind: "subscribed", topicKey: message.topic ?? "" };
				case "subscribe-rejected":
					return {
						kind: "subscribe-rejected",
						topicKey: message.topic ?? "",
						reason: message.reason,
					};
				case "pong":
					return { kind: "heartbeat" };
				default:
					return { kind: "ignore" };
			}
		},
		subscribe: (topic) => [JSON.stringify({ type: "subscribe", topic })],
		unsubscribe: (topic) => [JSON.stringify({ type: "unsubscribe", topic })],
		command: (payload, id) => ({
			frames: [JSON.stringify({ type: "cmd", id, payload })],
			expectsAck: true,
		}),
		// 4401 rejects the attached grant; 4403 (forbidden) rejects nothing
		// and ends the connection.
		classifyClose: (code) =>
			code === 4401
				? "auth"
				: code === 4400 || code === 4403
					? "permanent"
					: "transient",
	};
	if (options.heartbeat) protocol.heartbeat = options.heartbeat;
	if (options.onOversize) protocol.onOversize = options.onOversize;
	if (options.authenticate) {
		protocol.authenticate = (credentials) => [
			JSON.stringify({ type: "auth", token: credentials.token }),
		];
	}
	return protocol;
}

export interface WebSocketRuntimeModule<A> {
	websocketAdapter(options: { protocols: Record<string, TopicProtocol> }): A;
}

/**
 * The harness's WebSocket adapter. Protocol names: `topics` (plain),
 * `topics-probe` (application ping/pong liveness), `topics-auth`
 * (first-message authentication with `connectionParams.token`; `authenticate`
 * receives the provider's `connectionParams` only).
 */
export function websocketAdapter<A>(runtime: WebSocketRuntimeModule<A>): A {
	return runtime.websocketAdapter({
		protocols: {
			topics: createTopicProtocol(),
			"topics-probe": createTopicProtocol({
				heartbeat: {
					intervalMs: 1_000,
					timeoutMs: 1_000,
					frame: () => JSON.stringify({ type: "ping" }),
				},
			}),
			"topics-auth": createTopicProtocol({ authenticate: true }),
		},
	});
}
