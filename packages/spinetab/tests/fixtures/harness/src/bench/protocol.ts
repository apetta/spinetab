import type { Json } from "spinetab/runtime";
import type { WebSocketProtocol } from "spinetab/websocket/runtime";
import type { BenchEvent } from "./event";

/** Bench event frames are bare JSON; control frames carry op. Authentication reads only the provider's connectionParams. */

const PING = '{"op":"ping"}';

interface Control {
	op?: unknown;
	id?: unknown;
	result?: unknown;
	error?: unknown;
}

export function benchProtocol(
	options: { auth?: boolean } = {},
): WebSocketProtocol<number, BenchEvent, Json, unknown> {
	const protocol: WebSocketProtocol<number, BenchEvent, Json, unknown> = {
		topicKey: (topic) => String(topic),
		decode(raw) {
			if (typeof raw !== "string") return { kind: "ignore" };
			const message = JSON.parse(raw) as BenchEvent & Control;
			if (message.op === undefined) {
				return {
					kind: "event",
					topics: [String(message.topic)],
					event: message,
				};
			}
			switch (message.op) {
				case "pong":
					return { kind: "heartbeat" };
				case "ack":
					return typeof message.error === "string"
						? { kind: "ack", id: String(message.id), error: message.error }
						: { kind: "ack", id: String(message.id), result: message.result };
				default:
					return { kind: "ignore" };
			}
		},
		subscribe: (topic) => [JSON.stringify({ op: "sub", topic })],
		unsubscribe: (topic) => [JSON.stringify({ op: "unsub", topic })],
		command: (payload, id) => ({
			frames: [JSON.stringify({ op: "cmd", id, payload })],
			expectsAck: true,
		}),
		heartbeat: { intervalMs: 15_000, timeoutMs: 2_000, frame: () => PING },
		classifyClose: () => "transient",
	};
	if (options.auth) {
		protocol.authenticate = (credentials) => [
			JSON.stringify({ op: "auth", token: String(credentials.token ?? "") }),
		];
	}
	return protocol;
}
