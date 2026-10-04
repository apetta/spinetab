import { streamText } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";

/**
 * Real AI SDK route handler: `streamText` over a mock model answered
 * with `toUIMessageStreamResponse()` (ai 7.0.116). The generation id from
 * Spinetab's start request is echoed in `x-generation-id` and as the `start`
 * chunk's message id so other tabs can follow the generation.
 */
export const dynamic = "force-dynamic";

type StreamPart =
	Awaited<
		ReturnType<MockLanguageModelV4["doStream"]>
	>["stream"] extends ReadableStream<infer Part>
		? Part
		: never;

const WORDS = ["Shared", " across", " tabs", " by", " Spinetab."];

interface Counters {
	generations: number;
	generationIds: string[];
	byChat: Record<string, number>;
}
const counters = (): Counters => {
	const scope = globalThis as { __aiCounters?: Counters };
	scope.__aiCounters ??= { generations: 0, generationIds: [], byChat: {} };
	return scope.__aiCounters;
};

export async function POST(request: Request) {
	const body = (await request.json()) as {
		id?: unknown;
		generationId?: unknown;
	};
	const chatId = typeof body.id === "string" ? body.id : "unknown";
	const generationId =
		typeof body.generationId === "string"
			? body.generationId
			: crypto.randomUUID();
	counters().generations += 1;
	counters().generationIds.push(generationId);
	counters().byChat[chatId] = (counters().byChat[chatId] ?? 0) + 1;
	const chunks: StreamPart[] = [
		{ type: "stream-start", warnings: [] },
		{ type: "text-start", id: "text-1" },
		...WORDS.map(
			(delta): StreamPart => ({ type: "text-delta", id: "text-1", delta }),
		),
		{ type: "text-end", id: "text-1" },
		{
			type: "finish",
			usage: {
				inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
				outputTokens: { total: WORDS.length, text: WORDS.length, reasoning: 0 },
			},
			finishReason: { unified: "stop", raw: undefined },
		},
	];
	const model = new MockLanguageModelV4({
		doStream: async () => ({
			stream: simulateReadableStream({
				initialDelayInMs: 100,
				chunkDelayInMs: 200,
				chunks,
			}),
		}),
	});
	const result = streamText({ model, prompt: "Say hello." });
	return result.toUIMessageStreamResponse({
		generateMessageId: () => generationId,
		headers: { "x-generation-id": generationId },
	});
}
