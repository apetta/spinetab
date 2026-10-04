import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import { expectTypeOf } from "expect-type";
import { createSpinetab, isSpinetabError } from "spinetab";
import {
	type AiObserveEvent,
	type AiStreamEvent,
	type ObserverRole,
	SpinetabChatTransport,
	SpinetabInterruptedError,
} from "spinetab/ai-sdk";
import type { ChatMessage, chatApi } from "./shared-config.js";

// Declaration checks against the packed package.
declare const api: typeof chatApi;

const client = createSpinetab({});
const transport = new SpinetabChatTransport<ChatMessage>({ client, api });
expectTypeOf(transport).toExtend<ChatTransport<ChatMessage>>();
expectTypeOf(new SpinetabChatTransport({ client })).toExtend<
	ChatTransport<UIMessage>
>();
expectTypeOf(transport.role("chat")).toEqualTypeOf<ObserverRole | undefined>();

// `follow`: the whole resume recipe; returns its disposer.
const unfollow = transport.follow("chat", () => undefined);
expectTypeOf(unfollow).toEqualTypeOf<() => void>();
// @ts-expect-error: follow needs the chat's resume function.
transport.follow("chat");

export async function first(chatId: string): Promise<UIMessageChunk | null> {
	const stream = await transport.reconnectToStream({ chatId });
	if (!stream) return null;
	const { value } = await stream.getReader().read();
	return value ?? null;
}

// Narrowing by type must preserve the AI SDK chunk variant's fields.
declare const observed: AiObserveEvent;
if (observed.type === "chunks") {
	for (const chunk of observed.chunks) {
		if (chunk.type === "text-delta") {
			expectTypeOf(chunk.delta).toEqualTypeOf<string>();
		}
	}
}
declare const streamed: AiStreamEvent;
expectTypeOf(streamed).toEqualTypeOf<UIMessageChunk[]>();

export function interrupted(error: unknown): boolean {
	return (
		error instanceof SpinetabInterruptedError ||
		isSpinetabError(error, "interrupted")
	);
}

// @ts-expect-error: the transport needs the application's client.
export const missing = new SpinetabChatTransport({ api: "api/chat" });
