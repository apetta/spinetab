import type { AnyRuntimeAdapter } from "spinetab/runtime";
import { websocketAdapter } from "spinetab/websocket/runtime";

export function adapters(): AnyRuntimeAdapter[] {
	return [
		websocketAdapter({
			protocols: {
				json: {
					topicKey: (topic: unknown) => String(topic),
					decode: (raw) => {
						const message = JSON.parse(String(raw)) as {
							topic?: string;
							ack?: string;
						};
						return message.ack
							? { kind: "ack", id: message.ack }
							: {
									kind: "event",
									topics: [String(message.topic)],
									event: message,
								};
					},
					subscribe: (topic) => [JSON.stringify({ op: "sub", topic })],
					unsubscribe: (topic) => [JSON.stringify({ op: "unsub", topic })],
					command: (payload, id) => ({
						frames: [JSON.stringify({ op: "cmd", id, payload })],
						expectsAck: true,
					}),
				},
			},
		}),
	];
}
