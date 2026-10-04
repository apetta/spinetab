import type { IncomingMessage, ServerResponse } from "node:http";
import { type FixtureApp, readJson, sendJson } from "./app.ts";

/**
 * Scripted AI SDK UI message stream backend.
 *
 * - `POST /ai/chat` starts a generation and streams it as SSE JSON with
 * `x-vercel-ai-ui-message-stream: v1` and a `[DONE]` terminator. The
 * generation id from `body.generationId` is echoed in `x-generation-id` and
 * as the `start` chunk's `messageId`.
 * - The generation runs on a server-side timer, independent of the POST
 * response, like a resumable backend: a client disconnect does not stop it.
 * - `GET /ai/chat/:id/stream` replays the active generation from its first
 * chunk and then follows it live; after it ends the route returns 204.
 * - `POST /ai/chat/:id/stop` records the stop and ends a matching generation
 * with an `abort` chunk.
 *
 * Body switches: `script`, `size`, `delayMs`, `status` (scripted HTTP
 * failure), `requireAuth` (bearer check) and `echo: false` (no id echo).
 *
 * Faults (`target: "ai"`): `stall` (stop emitting after `value` chunks until
 * reset), `error-chunk` (inject an `error` chunk after `value` chunks),
 * `abort` (destroy the POST connection after `value` chunks; the generation
 * itself continues and remains resumable).
 */

type Chunk = Record<string, unknown>;

interface Generation {
	chatId: string;
	generationId: string;
	chunks: Chunk[];
	emitted: number;
	done: boolean;
	listeners: Set<(chunk: Chunk | null) => void>;
	timer: ReturnType<typeof setTimeout> | undefined;
}

interface AiCounters {
	generations: number;
	resumes: number;
	stops: number;
	generationIds: string[];
	stopRequests: Array<{ chatId: string; generationId: string | null }>;
	resumeStatuses: number[];
	/** Per start: whether an Authorization header and a custom header arrived. */
	startHeaders: Array<{ authorization: string | null; custom: string | null }>;
	/** Response streams closed by the client before the generation ended. */
	clientDisconnects: number;
}

const DEFAULT_DELAY_MS = 2;

export function register(app: FixtureApp): void {
	const generations = new Map<string, Generation>(); // by chat id (latest)
	const openResponses = new Map<ServerResponse, () => void>();
	const counters = freshCounters();
	// `active`: POST and GET response streams currently open.
	Object.defineProperty(counters, "active", {
		enumerable: true,
		get: () => openResponses.size,
	});
	app.counters.ai = counters as unknown as Record<string, unknown>;

	// Generations run on server-side timers independent of any response, so
	// both reset and shutdown stop them and end every open stream.
	const stopAll = () => {
		for (const generation of generations.values()) stopTimer(generation);
		generations.clear();
		for (const [res, close] of openResponses) {
			close();
			res.destroy();
		}
		openResponses.clear();
	};
	app.onReset(() => {
		stopAll();
		Object.assign(counters, freshCounters());
	});
	app.onClose(stopAll);

	const faultValue = (action: string, fallback: number): number | undefined => {
		const fault = app.fault("ai", action);
		if (!fault) return undefined;
		return typeof fault.value === "number" ? fault.value : fallback;
	};

	const schedule = (generation: Generation, delayMs: number) => {
		const stallAfter = faultValue("stall", 3);
		if (stallAfter !== undefined && generation.emitted >= stallAfter) {
			// Re-check periodically so a reset or fault removal resumes emission.
			generation.timer = setTimeout(() => schedule(generation, delayMs), 20);
			return;
		}
		generation.timer = setTimeout(() => {
			generation.timer = undefined;
			emitNext(generation, delayMs);
		}, delayMs);
	};

	const emitNext = (generation: Generation, delayMs: number) => {
		if (generation.done) return;
		const errorAfter = faultValue("error-chunk", 2);
		if (
			errorAfter !== undefined &&
			generation.emitted === errorAfter &&
			!generation.chunks.some((chunk) => chunk.type === "error")
		) {
			generation.chunks.splice(generation.emitted, 0, {
				type: "error",
				errorText: "Scripted upstream error",
			});
		}
		const chunk = generation.chunks[generation.emitted];
		if (!chunk) {
			finish(generation);
			return;
		}
		generation.emitted += 1;
		for (const listener of [...generation.listeners]) listener(chunk);
		if (generation.emitted >= generation.chunks.length) finish(generation);
		else schedule(generation, delayMs);
	};

	const finish = (generation: Generation) => {
		if (generation.done) return;
		generation.done = true;
		stopTimer(generation);
		for (const listener of [...generation.listeners]) listener(null);
		generation.listeners.clear();
	};

	app.http("POST", "/ai/chat", async (req, res, url) => {
		const stopMatch = /^\/ai\/chat\/([^/]+)\/stop$/.exec(url.pathname);
		if (stopMatch)
			return handleStop(req, res, decodeURIComponent(stopMatch[1] ?? ""));
		if (url.pathname !== "/ai/chat")
			return sendJson(res, 404, { error: "not-found" });
		const body = (await readJson(req)) as Record<string, unknown> | undefined;
		const chatId = typeof body?.id === "string" ? body.id : "";
		const generationId =
			typeof body?.generationId === "string" ? body.generationId : "";
		counters.generations += 1;
		counters.generationIds.push(generationId);
		counters.startHeaders.push({
			authorization: headerValue(req, "authorization"),
			custom: headerValue(req, "x-fixture-custom"),
		});
		if (body?.requireAuth === true) {
			const auth = app.authorise(
				headerValue(req, "authorization") ?? undefined,
			);
			if (!auth.ok) {
				res.writeHead(401, { "content-type": "text/plain" });
				res.end("Unauthorised chat request");
				return;
			}
		}
		if (typeof body?.status === "number" && body.status >= 400) {
			res.writeHead(body.status, { "content-type": "text/plain" });
			res.end(`Scripted failure ${body.status}`);
			return;
		}
		if (!body || !chatId || !generationId) {
			res.writeHead(400, { "content-type": "text/plain" });
			res.end("Missing chat id or generation id");
			return;
		}
		let script = typeof body.script === "string" ? body.script : "text";
		// A follow-up after client tool output (last message from the assistant)
		// is answered with text, as a real model would.
		const messages = Array.isArray(body.messages) ? body.messages : [];
		const last = messages.at(-1) as { role?: unknown } | undefined;
		if (script === "client-tool" && last?.role === "assistant") script = "text";
		const size = typeof body.size === "number" ? body.size : 5;
		const delayMs =
			typeof body.delayMs === "number" ? body.delayMs : DEFAULT_DELAY_MS;
		const previous = generations.get(chatId);
		if (previous && !previous.done) finish(previous);
		const generation: Generation = {
			chatId,
			generationId,
			// `echo: false` models a backend that does not echo the request id.
			chunks: scriptChunks(
				script,
				body.echo === false ? `server-${generationId}` : generationId,
				size,
			),
			emitted: 0,
			done: false,
			listeners: new Set(),
			timer: undefined,
		};
		generations.set(chatId, generation);
		const abortAfter = faultValue("abort", 3);
		attachStream(res, generation, 0, {
			...(body.echo === false ? {} : { "x-generation-id": generationId }),
			abortAfter,
		});
		schedule(generation, delayMs);
	});

	app.http("GET", "/ai/chat/", (_req, res, url) => {
		const match = /^\/ai\/chat\/([^/]+)\/stream$/.exec(url.pathname);
		if (!match) return sendJson(res, 404, { error: "not-found" });
		counters.resumes += 1;
		const generation = generations.get(decodeURIComponent(match[1] ?? ""));
		if (!generation || generation.done) {
			counters.resumeStatuses.push(204);
			res.writeHead(204);
			res.end();
			return;
		}
		counters.resumeStatuses.push(200);
		const skip = Number(url.searchParams.get("skip") ?? "0");
		attachStream(res, generation, Number.isFinite(skip) ? skip : 0, {});
	});

	function attachStream(
		res: ServerResponse,
		generation: Generation,
		from: number,
		options: { "x-generation-id"?: string; abortAfter?: number },
	) {
		const headers: Record<string, string> = {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			"x-vercel-ai-ui-message-stream": "v1",
		};
		if (options["x-generation-id"]) {
			headers["x-generation-id"] = options["x-generation-id"];
		}
		res.writeHead(200, headers);
		res.flushHeaders();
		let written = 0;
		let open = true;
		const close = () => {
			if (!open) return;
			open = false;
			openResponses.delete(res);
			generation.listeners.delete(listener);
		};
		const write = (chunk: Chunk) => {
			written += 1;
			const drop =
				options.abortAfter !== undefined && written >= options.abortAfter;
			if (drop) close();
			// Destroy only after the last chunk reached the socket.
			res.write(`data: ${JSON.stringify(chunk)}\n\n`, () => {
				if (drop) res.destroy();
			});
		};
		openResponses.set(res, close);
		const listener = (chunk: Chunk | null) => {
			if (!open) return;
			if (chunk === null) {
				res.end("data: [DONE]\n\n");
				close();
				return;
			}
			write(chunk);
		};
		res.on("close", () => {
			if (open && !generation.done) counters.clientDisconnects += 1;
			close();
		});
		for (const chunk of generation.chunks.slice(from, generation.emitted)) {
			if (!open) return;
			write(chunk);
		}
		if (!open) return;
		if (generation.done) {
			res.end("data: [DONE]\n\n");
			close();
			return;
		}
		generation.listeners.add(listener);
	}

	async function handleStop(
		req: IncomingMessage,
		res: ServerResponse,
		chatId: string,
	) {
		const body = (await readJson(req).catch(() => undefined)) as
			| Record<string, unknown>
			| undefined;
		const generationId =
			typeof body?.generationId === "string" ? body.generationId : null;
		counters.stops += 1;
		counters.stopRequests.push({ chatId, generationId });
		const generation = generations.get(chatId);
		if (
			generation &&
			!generation.done &&
			(generationId === null || generation.generationId === generationId)
		) {
			stopTimer(generation);
			generation.chunks.splice(generation.emitted, Infinity, {
				type: "abort",
				reason: "stopped",
			});
			emitNext(generation, 0);
			return sendJson(res, 200, { stopped: true });
		}
		sendJson(res, 200, { stopped: false });
	}
}

function stopTimer(generation: Generation) {
	if (generation.timer) clearTimeout(generation.timer);
	generation.timer = undefined;
}

function headerValue(req: IncomingMessage, name: string): string | null {
	const value = req.headers[name];
	return typeof value === "string" ? value : null;
}

function freshCounters(): AiCounters {
	return {
		generations: 0,
		resumes: 0,
		stops: 0,
		generationIds: [],
		stopRequests: [],
		resumeStatuses: [],
		startHeaders: [],
		clientDisconnects: 0,
	};
}

/**
 * Scripted chunk sequences. `all` covers every chunk family the UI message
 * stream protocol defines in ai 7.0.116 (`UIMessageChunk`).
 */
export function scriptChunks(
	script: string,
	messageId: string,
	size: number,
): Chunk[] {
	const text = (id: string, words: number): Chunk[] => [
		{ type: "text-start", id },
		...Array.from({ length: words }, (_, index) => ({
			type: "text-delta",
			id,
			delta: `${index === 0 ? "" : " "}word${index}`,
		})),
		{ type: "text-end", id },
	];
	const start: Chunk = { type: "start", messageId };
	switch (script) {
		case "reasoning":
			return [
				start,
				{ type: "start-step" },
				{ type: "reasoning-start", id: "r1" },
				{ type: "reasoning-delta", id: "r1", delta: "Thinking" },
				{ type: "reasoning-delta", id: "r1", delta: " hard" },
				{ type: "reasoning-end", id: "r1" },
				...text("t1", size),
				{ type: "finish-step" },
				{ type: "finish", finishReason: "stop" },
			];
		case "tool":
			return [
				start,
				{ type: "start-step" },
				{ type: "tool-input-start", toolCallId: "c1", toolName: "weather" },
				{
					type: "tool-input-delta",
					toolCallId: "c1",
					inputTextDelta: '{"city":',
				},
				{
					type: "tool-input-delta",
					toolCallId: "c1",
					inputTextDelta: '"Paris"}',
				},
				{
					type: "tool-input-available",
					toolCallId: "c1",
					toolName: "weather",
					input: { city: "Paris" },
				},
				{
					type: "tool-output-available",
					toolCallId: "c1",
					output: { temperature: 21 },
				},
				{ type: "finish-step" },
				{ type: "finish", finishReason: "tool-calls" },
			];
		case "client-tool":
			return [
				start,
				{ type: "start-step" },
				{
					type: "tool-input-available",
					toolCallId: "c2",
					toolName: "confirm",
					input: { question: "Proceed?" },
				},
				{ type: "finish-step" },
				{ type: "finish", finishReason: "tool-calls" },
			];
		case "data":
			return [
				start,
				{
					type: "data-weather",
					id: "d1",
					data: { city: "Paris", state: "loading" },
				},
				{
					type: "data-weather",
					id: "d1",
					data: { city: "Paris", state: "done" },
				},
				{ type: "data-notice", data: { note: "transient" }, transient: true },
				...text("t1", size),
				{ type: "finish" },
			];
		case "error":
			return [
				start,
				...text("t1", size),
				{ type: "error", errorText: "Model failed" },
			];
		case "abort":
			return [
				start,
				{ type: "text-start", id: "t1" },
				{ type: "text-delta", id: "t1", delta: "partial" },
				{ type: "abort", reason: "server-abort" },
			];
		case "all":
			return [
				{ type: "start", messageId, messageMetadata: { model: "fixture" } },
				{ type: "start-step" },
				{ type: "reasoning-start", id: "r1" },
				{ type: "reasoning-delta", id: "r1", delta: "Consider" },
				{ type: "reasoning-end", id: "r1" },
				...text("t1", size),
				{ type: "tool-input-start", toolCallId: "c1", toolName: "weather" },
				{ type: "tool-input-delta", toolCallId: "c1", inputTextDelta: "{}" },
				{
					type: "tool-input-available",
					toolCallId: "c1",
					toolName: "weather",
					input: {},
				},
				{
					type: "tool-output-available",
					toolCallId: "c1",
					output: { ok: true },
				},
				{
					type: "tool-input-error",
					toolCallId: "c3",
					toolName: "weather",
					input: { bad: true },
					errorText: "Invalid input",
				},
				{
					type: "tool-input-available",
					toolCallId: "c4",
					toolName: "delete",
					input: { id: 1 },
				},
				{
					type: "tool-output-error",
					toolCallId: "c4",
					errorText: "Denied by server",
				},
				{
					type: "tool-input-available",
					toolCallId: "c5",
					toolName: "delete",
					input: { id: 2 },
				},
				{
					type: "tool-approval-request",
					approvalId: "a5",
					toolCallId: "c5",
				},
				{
					type: "tool-input-available",
					toolCallId: "c6",
					toolName: "delete",
					input: { id: 3 },
				},
				{ type: "tool-output-denied", toolCallId: "c6" },
				{ type: "data-weather", id: "d1", data: { city: "Paris" } },
				{ type: "data-notice", data: { note: "transient" }, transient: true },
				{
					type: "source-url",
					sourceId: "s1",
					url: "https://example.com/a",
					title: "A",
				},
				{
					type: "source-document",
					sourceId: "s2",
					mediaType: "text/plain",
					title: "Doc",
				},
				{
					type: "file",
					url: "data:text/plain;base64,aGk=",
					mediaType: "text/plain",
				},
				{ type: "message-metadata", messageMetadata: { tokens: 42 } },
				{ type: "finish-step" },
				{
					type: "finish",
					finishReason: "stop",
					messageMetadata: { done: true },
				},
			];
		default:
			return [
				start,
				{ type: "start-step" },
				...text("t1", size),
				{ type: "finish-step" },
				{ type: "finish", finishReason: "stop" },
			];
	}
}
