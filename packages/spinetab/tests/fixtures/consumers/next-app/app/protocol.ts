import type { WebSocketProtocol } from "spinetab/websocket/runtime";

type Frame = string | ArrayBuffer;

interface Message {
	type: string;
	topic?: string;
	data?: unknown;
	reason?: string;
}

/**
 * The fixture's JSON topic protocol (`tests/fixtures/servers/ws.ts`), as an
 * application defines its own protocol in the worker entry.
 */
export const topics: WebSocketProtocol<string> = {
	topicKey: (topic) => topic,
	decode(raw: Frame) {
		if (typeof raw !== "string") return { kind: "ignore" };
		const message = JSON.parse(raw) as Message;
		switch (message.type) {
			case "event":
				return {
					kind: "event",
					topics: [message.topic ?? ""],
					event: message.data,
				};
			case "subscribed":
				return { kind: "subscribed", topicKey: message.topic ?? "" };
			case "subscribe-rejected":
				return {
					kind: "subscribe-rejected",
					topicKey: message.topic ?? "",
					...(message.reason ? { reason: message.reason } : {}),
				};
			default:
				return { kind: "ignore" };
		}
	},
	subscribe: (topic) => [JSON.stringify({ type: "subscribe", topic })],
	unsubscribe: (topic) => [JSON.stringify({ type: "unsubscribe", topic })],
	classifyClose: (code) =>
		code === 4401 || code === 4403 ? "auth" : "transient",
};
