import { streamText } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";

/**
 * Real AI SDK route, served by the front server for Vite, webpack and
 * Rspack cells (`--route /api/chat=server/chat.mjs`): `streamText` over a
 * mock model, answered with `toUIMessageStreamResponse()` (ai 7.0.116). The
 * generation id from Spinetab's start request is echoed in
 * `x-generation-id` and as the `start` chunk's message id, so other tabs can
 * follow the generation. `GET /api/counters` reports the starts.
 */
export const WORDS = ["Shared", " across", " tabs", " by", " Spinetab."];

// Counters per chat id: one front process may serve several cells.
const counters = { generations: 0, generationIds: [], byChat: {} };

const usage = {
	inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: WORDS.length, text: WORDS.length, reasoning: 0 },
};

export async function POST(request) {
	const body = await request.json();
	const generationId =
		typeof body?.generationId === "string"
			? body.generationId
			: crypto.randomUUID();
	const chatId = typeof body?.id === "string" ? body.id : "unknown";
	counters.generations += 1;
	counters.generationIds.push(generationId);
	counters.byChat[chatId] = (counters.byChat[chatId] ?? 0) + 1;
	const model = new MockLanguageModelV4({
		doStream: async () => ({
			stream: simulateReadableStream({
				initialDelayInMs: 100,
				chunkDelayInMs: 200,
				chunks: [
					{ type: "stream-start", warnings: [] },
					{ type: "text-start", id: "text-1" },
					...WORDS.map((delta) => ({
						type: "text-delta",
						id: "text-1",
						delta,
					})),
					{ type: "text-end", id: "text-1" },
					{
						type: "finish",
						usage,
						finishReason: { unified: "stop", raw: undefined },
					},
				],
			}),
		}),
	});
	const result = streamText({ model, prompt: "Say hello." });
	return result.toUIMessageStreamResponse({
		generateMessageId: () => generationId,
		headers: { "x-generation-id": generationId },
	});
}

export function GET() {
	return Response.json(counters);
}
