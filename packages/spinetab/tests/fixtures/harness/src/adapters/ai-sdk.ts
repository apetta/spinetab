/**
 * AI SDK part of the browser harness (`window.harnessAi`). The harness has no
 * `ai` dependency, so it reads the transport's streams directly and records
 * every chunk; the chunk sequence is what the SDK's `Chat` would consume.
 *
 * Wiring (core-owned harness files):
 * main.ts: import { SpinetabChatTransport } from "spinetab/ai-sdk";
 * installAiHarness({ client, SpinetabChatTransport });
 * live.worker.ts: import { aiSdkAdapter } from "spinetab/ai-sdk/runtime";
 * createRuntime({ adapters: [..., aiSdkAdapter()] })
 *
 * The transport class is injected so this module needs no build of the
 * package to typecheck; the harness still consumes the built exports.
 */

type Chunk = { type: string; [key: string]: unknown };

interface TransportLike {
	sendMessages(options: {
		trigger: "submit-message";
		chatId: string;
		messageId: undefined;
		messages: unknown[];
		abortSignal: AbortSignal | undefined;
		body?: object;
	}): Promise<ReadableStream<Chunk>>;
	reconnectToStream(options: {
		chatId: string;
		abortSignal?: AbortSignal;
	}): Promise<ReadableStream<Chunk> | null>;
	observe(
		chatId: string,
		options: {
			onStart?: (event: { chatId: string; generationId: string }) => void;
		},
	): () => void;
	role(chatId: string): "originator" | "follower" | undefined;
	stop(chatId: string): Promise<{ status: string }>;
}

export type TransportClass<Client> = new (options: {
	client: Client;
	api: string;
	stop: { api: (chatId: string, generationId: string) => string };
	onInterrupted: (chatId: string) => void;
}) => TransportLike;

export interface AiRecord {
	chunks: Chunk[];
	error: { name: string; code?: string; message: string } | null;
	done: boolean;
	/** Page clock (`Date.now()`) when `done` was last set, or null. */
	doneAt: number | null;
	noStream: boolean;
	interrupted: number;
	starts: string[];
	text: string;
}

export interface HarnessAi {
	send(chatId: string, body?: object): Promise<void>;
	observe(chatId: string, autoResume?: boolean): void;
	resume(chatId: string): Promise<"stream" | "no-stream" | "error">;
	abort(chatId: string): void;
	stop(chatId: string): Promise<string>;
	role(chatId: string): string | null;
	record(chatId: string): AiRecord;
}

export function installAiHarness<Client>(options: {
	client: Client;
	SpinetabChatTransport: TransportClass<Client>;
	origin?: string;
}): HarnessAi {
	const origin = options.origin ?? location.origin;
	const records = new Map<
		string,
		{ data: AiRecord; controller?: AbortController; observing?: () => void }
	>();
	const entry = (chatId: string) => {
		let value = records.get(chatId);
		if (!value) {
			value = {
				data: {
					chunks: [],
					error: null,
					done: false,
					doneAt: null,
					noStream: false,
					interrupted: 0,
					starts: [],
					text: "",
				},
			};
			records.set(chatId, value);
		}
		return value;
	};
	const transport = new options.SpinetabChatTransport({
		client: options.client,
		api: `${origin}/ai/chat`,
		stop: {
			api: (chatId) => `${origin}/ai/chat/${encodeURIComponent(chatId)}/stop`,
		},
		onInterrupted: (chatId) => {
			entry(chatId).data.interrupted += 1;
		},
	});
	const consume = async (chatId: string, stream: ReadableStream<Chunk>) => {
		const { data } = entry(chatId);
		data.done = false;
		data.doneAt = null;
		data.error = null;
		const reader = stream.getReader();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				data.chunks.push(value);
				if (value.type === "text-delta") data.text += String(value.delta);
			}
		} catch (error) {
			data.error = describe(error);
		} finally {
			data.done = true;
			data.doneAt = Date.now();
		}
	};
	const resume = async (chatId: string) => {
		const record = entry(chatId);
		record.controller = new AbortController();
		try {
			const stream = await transport.reconnectToStream({
				chatId,
				abortSignal: record.controller.signal,
			});
			if (!stream) {
				record.data.noStream = true;
				record.data.done = true;
				record.data.doneAt = Date.now();
				return "no-stream" as const;
			}
			void consume(chatId, stream);
			return "stream" as const;
		} catch (error) {
			record.data.error = describe(error);
			record.data.done = true;
			record.data.doneAt = Date.now();
			return "error" as const;
		}
	};
	const api: HarnessAi = {
		async send(chatId, body = {}) {
			const record = entry(chatId);
			record.controller = new AbortController();
			const stream = await transport.sendMessages({
				trigger: "submit-message",
				chatId,
				messageId: undefined,
				messages: [
					{
						id: `u-${Date.now()}`,
						role: "user",
						parts: [{ type: "text", text: "hi" }],
					},
				],
				abortSignal: record.controller.signal,
				body,
			});
			void consume(chatId, stream);
		},
		observe(chatId, autoResume = true) {
			const record = entry(chatId);
			record.observing?.();
			record.observing = transport.observe(chatId, {
				onStart: ({ generationId }) => {
					record.data.starts.push(generationId);
					if (autoResume) void resume(chatId);
				},
			});
		},
		resume,
		abort(chatId) {
			entry(chatId).controller?.abort();
		},
		async stop(chatId) {
			const outcome = await transport.stop(chatId);
			return outcome.status;
		},
		role: (chatId) => transport.role(chatId) ?? null,
		record: (chatId) => structuredClone(entry(chatId).data),
	};
	(globalThis as { harnessAi?: HarnessAi }).harnessAi = api;
	return api;
}

function describe(error: unknown): AiRecord["error"] {
	const record = error as { name?: unknown; code?: unknown; message?: unknown };
	return {
		name: typeof record?.name === "string" ? record.name : "Error",
		...(typeof record?.code === "string" ? { code: record.code } : {}),
		message:
			typeof record?.message === "string" ? record.message : String(error),
	};
}
