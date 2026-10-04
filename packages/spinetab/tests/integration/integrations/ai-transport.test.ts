import { Chat } from "@ai-sdk/react";
import {
	DefaultChatTransport,
	lastAssistantMessageIsCompleteWithToolCalls,
	type UIMessage,
} from "ai";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { isSpinetabError } from "../../../src/core/errors.ts";
import { SpinetabChatTransport } from "../../../src/integrations/ai-sdk/index.ts";
import { aiSdkAdapter } from "../../../src/integrations/ai-sdk/runtime.ts";
import {
	type RunningFixtures,
	startFixtures,
} from "../../fixtures/servers/start.ts";
import { fixture, waitFor } from "./helpers/fake-context.ts";
import {
	createLoopbackRuntime,
	type LoopbackClient,
	type LoopbackRuntime,
} from "./helpers/loopback-client.ts";

// INT-TR-01…10: SpinetabChatTransport with the real AI SDK `Chat` (ai 7.0.116,
// @ai-sdk/react 4.0.119) against the scripted backend. Tabs are separate page
// clients on one in-process runtime stand-in (see helpers/loopback-client.ts);
// the real SharedWorker path is covered by tests/browser/integrations-ai.spec.ts.

// The "all" script exercises deprecated part fields; keep test output readable.
(globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;

let running: RunningFixtures;
let origin: string;
let server: Awaited<ReturnType<typeof fixture>>;
let runtime: LoopbackRuntime;
let counter = 0;
const newChatId = () => `chat-${++counter}-${Date.now()}`;

beforeAll(async () => {
	running = await startFixtures([0]);
	origin = running.apps[0]?.origin ?? "";
	server = await fixture(origin);
});
afterAll(() => running.close());
beforeEach(async () => {
	runtime?.dispose();
	runtime = createLoopbackRuntime({
		adapters: [aiSdkAdapter()],
		limits: { idleCloseMs: 100 },
	});
	await server.reset();
});

interface Tab {
	client: LoopbackClient;
	transport: SpinetabChatTransport;
	chat: Chat<UIMessage>;
	finishes: Array<{
		isAbort: boolean;
		isDisconnect: boolean;
		isError: boolean;
	}>;
	interrupted: string[];
}

function tab(
	chatId: string,
	options: {
		resumeApi?: (chatId: string) => string;
		onInterrupted?: (tab: Tab) => void;
		chat?: Partial<ConstructorParameters<typeof Chat<UIMessage>>[0]>;
	} = {},
): Tab {
	const client = runtime.client();
	const self = {} as Tab;
	const transport = new SpinetabChatTransport({
		client,
		api: `${origin}/ai/chat`,
		...(options.resumeApi ? { resume: { api: options.resumeApi } } : {}),
		stop: { api: (id) => `${origin}/ai/chat/${id}/stop` },
		onInterrupted: (id) => {
			self.interrupted.push(id);
			options.onInterrupted?.(self);
		},
	});
	const finishes: Tab["finishes"] = [];
	const chat = new Chat<UIMessage>({
		id: chatId,
		transport,
		onFinish: ({ isAbort, isDisconnect, isError }) => {
			finishes.push({ isAbort, isDisconnect, isError });
		},
		...options.chat,
	});
	Object.assign(self, { client, transport, chat, finishes, interrupted: [] });
	return self;
}

const lastAssistant = (chat: Chat<UIMessage>): UIMessage | undefined =>
	[...chat.messages].reverse().find((message) => message.role === "assistant");

async function baselineMessage(body: Record<string, unknown>) {
	const chat = new Chat<UIMessage>({
		id: newChatId(),
		transport: new DefaultChatTransport({ api: `${origin}/ai/chat` }),
	});
	await chat.sendMessage(
		{ text: "hi" },
		{ body: { ...body, generationId: `baseline-${Date.now()}` } },
	);
	const message = lastAssistant(chat);
	if (!message) throw new Error("baseline produced no assistant message");
	return message;
}

const withoutId = (message: UIMessage | undefined) => {
	if (!message) return undefined;
	const { id: _id, ...rest } = message;
	return rest;
};

const startsFor = async (chatId: string, client: LoopbackClient) => {
	void chatId;
	return client.commands.filter(
		(command) => (command.payload as { type: string }).type === "start",
	).length;
};

describe("SpinetabChatTransport with the AI SDK Chat", () => {
	it("INT-TR-01 a pre-attached follower receives the full ordered stream equal to the DefaultChatTransport baseline", async () => {
		const body = { script: "all", size: 4 };
		const baseline = await baselineMessage(body);
		const chatId = newChatId();
		const a = tab(chatId);
		const b = tab(chatId);
		const startedIds: string[] = [];
		const dispose = b.transport.observe(chatId, {
			onStart: ({ generationId }) => {
				startedIds.push(generationId);
				void b.chat.resumeStream();
			},
		});
		await a.chat.sendMessage({ text: "hi" }, { body });
		await waitFor(
			() => b.chat.status === "ready" && lastAssistant(b.chat) !== undefined,
		);
		const generationId = lastAssistant(a.chat)?.id ?? "";
		expect(startedIds).toEqual([generationId]);
		expect(withoutId(lastAssistant(a.chat))).toEqual(withoutId(baseline));
		expect(withoutId(lastAssistant(b.chat))).toEqual(withoutId(baseline));
		expect(lastAssistant(b.chat)?.id).toBe(generationId);
		expect(a.chat.error).toBeUndefined();
		expect(b.chat.error).toBeUndefined();
		expect(a.transport.role(chatId)).toBe("originator");
		expect(b.transport.role(chatId)).toBe("follower");
		const counters = await server.counters();
		// One baseline start plus exactly one Spinetab start; no resume request.
		expect(
			counters.generationIds.filter((id) => id === generationId),
		).toHaveLength(1);
		expect(counters.generations).toBe(2);
		expect(counters.resumes).toBe(0);
		dispose();
	});

	it("INT-TR-02 aborting the originating observer detaches only; the follower completes and no stop is sent", async () => {
		const chatId = newChatId();
		const a = tab(chatId);
		const b = tab(chatId);
		b.transport.observe(chatId, { onStart: () => void b.chat.resumeStream() });
		const sending = a.chat.sendMessage(
			{ text: "hi" },
			{ body: { size: 60, delayMs: 5 } },
		);
		await waitFor(() => (lastAssistant(b.chat)?.parts.length ?? 0) > 0);
		await a.chat.stop();
		await sending;
		await waitFor(() => b.chat.status === "ready" && b.finishes.length === 1);
		expect(a.finishes).toEqual([
			{ isAbort: true, isDisconnect: false, isError: false },
		]);
		expect(b.finishes).toEqual([
			{ isAbort: false, isDisconnect: false, isError: false },
		]);
		const text = lastAssistant(b.chat)?.parts.find(
			(part) => part.type === "text",
		);
		expect(text && "text" in text ? text.text.split(" ") : []).toHaveLength(60);
		const counters = await server.counters();
		expect(counters.stops).toBe(0);
		expect(counters.generations).toBe(1);
		expect(a.interrupted).toEqual([]);
	});

	it("INT-TR-03 a late joiner resumes through one GET; simultaneous joiners share it; a staggered joiner gets its own", async () => {
		const chatId = newChatId();
		const a = tab(chatId);
		const sending = a.chat.sendMessage(
			{ text: "hi" },
			{ body: { size: 80, delayMs: 5 } },
		);
		await waitFor(() => (lastAssistant(a.chat)?.parts.length ?? 0) > 0);
		const d = tab(chatId);
		const e = tab(chatId);
		const joined = Promise.all([d.chat.resumeStream(), e.chat.resumeStream()]);
		await waitFor(() => (lastAssistant(d.chat)?.parts.length ?? 0) > 0);
		const f = tab(chatId);
		await Promise.all([joined, f.chat.resumeStream(), sending]);
		const expected = withoutId(lastAssistant(a.chat));
		for (const joiner of [d, e, f]) {
			expect(joiner.chat.error).toBeUndefined();
			expect(withoutId(lastAssistant(joiner.chat))).toEqual(expected);
		}
		const counters = await server.counters();
		expect(counters.resumes).toBe(2);
		expect(counters.resumeStatuses).toEqual([200, 200]);
		expect(counters.generations).toBe(1);
	});

	it("INT-TR-04 HTTP 204 resolves to null: Chat stays ready with no error and no start", async () => {
		const chatId = newChatId();
		const c = tab(chatId);
		await c.chat.resumeStream();
		expect(c.chat.status).toBe("ready");
		expect(c.chat.error).toBeUndefined();
		expect(c.chat.messages).toEqual([]);
		const counters = await server.counters();
		expect(counters.resumeStatuses).toEqual([204]);
		expect(counters.generations).toBe(0);
		expect(await startsFor(chatId, c.client)).toBe(0);
	});

	it("INT-TR-05 an invalid resume stream is cannot-resume on Chat.error, never a start and never retried", async () => {
		const chatId = newChatId();
		const a = tab(chatId);
		const sending = a.chat.sendMessage(
			{ text: "hi" },
			{ body: { size: 40, delayMs: 5 } },
		);
		await waitFor(() => (lastAssistant(a.chat)?.parts.length ?? 0) > 0);
		const c = tab(chatId, {
			resumeApi: (id) => `${origin}/ai/chat/${id}/stream?skip=3`,
		});
		await c.chat.resumeStream();
		expect(c.chat.status).toBe("error");
		expect(isSpinetabError(c.chat.error, "cannot-resume")).toBe(true);
		await sending;
		await new Promise((resolve) => setTimeout(resolve, 100));
		const counters = await server.counters();
		expect(counters.resumes).toBe(1);
		expect(counters.generations).toBe(1);
		expect(await startsFor(chatId, c.client)).toBe(0);
		expect(c.interrupted).toEqual([]);
	});

	it("INT-TR-06 stop sends one identified stop command; both observers see the backend abort", async () => {
		const chatId = newChatId();
		const a = tab(chatId);
		const b = tab(chatId);
		b.transport.observe(chatId, { onStart: () => void b.chat.resumeStream() });
		const sending = a.chat.sendMessage(
			{ text: "hi" },
			{ body: { size: 200, delayMs: 5 } },
		);
		await waitFor(() => (lastAssistant(b.chat)?.parts.length ?? 0) > 0);
		const generationId = lastAssistant(a.chat)?.id;
		const outcome = await a.transport.stop(chatId);
		expect(outcome.status).toBe("acknowledged");
		await sending;
		await waitFor(() => b.chat.status === "ready" && b.finishes.length === 1);
		const counters = await server.counters();
		expect(counters.stops).toBe(1);
		expect(counters.stopRequests).toEqual([{ chatId, generationId }]);
		for (const observer of [a, b]) {
			const text = lastAssistant(observer.chat)?.parts.find(
				(part) => part.type === "text",
			);
			expect(
				text && "text" in text ? text.text.split(" ").length : 0,
			).toBeLessThan(200);
			expect(observer.interrupted).toEqual([]);
		}
	});

	it("INT-TR-07 a stalled observer overflows with a typed error; its peer completes", async () => {
		const chatId = newChatId();
		const a = tab(chatId);
		const b = tab(chatId);
		b.transport.observe(chatId, {
			onStart: () => {
				for (const consumer of b.client.consumers()) consumer.stall();
				void b.chat.resumeStream();
			},
		});
		await a.chat.sendMessage(
			{ text: "hi" },
			{ body: { size: 120, delayMs: 1 } },
		);
		await waitFor(() => b.chat.status === "error");
		expect(isSpinetabError(b.chat.error, "overflow")).toBe(true);
		expect(a.chat.error).toBeUndefined();
		const text = lastAssistant(a.chat)?.parts.find(
			(part) => part.type === "text",
		);
		expect(text && "text" in text ? text.text.split(" ") : []).toHaveLength(
			120,
		);
		await waitFor(() => b.interrupted.length === 1);
		expect((await server.counters()).generations).toBe(1);
	});

	it("INT-TR-08 an upstream drop ends the stream as a disconnect, calls onInterrupted once and resume completes the message", async () => {
		await server.fault("abort", 5);
		const chatId = newChatId();
		const a = tab(chatId, {
			onInterrupted: (self) => void self.chat.resumeStream(),
		});
		await a.chat.sendMessage(
			{ text: "hi" },
			{ body: { size: 30, delayMs: 3 } },
		);
		expect(a.finishes[0]).toEqual({
			isAbort: false,
			isDisconnect: true,
			isError: true,
		});
		expect(isSpinetabError(a.chat.error, "interrupted")).toBe(true);
		expect(a.chat.error).toBeInstanceOf(TypeError);
		await waitFor(() => a.finishes.length === 2 && a.chat.status === "ready");
		expect(a.interrupted).toEqual([chatId]);
		const assistants = a.chat.messages.filter((m) => m.role === "assistant");
		expect(assistants).toHaveLength(1);
		const text = assistants[0]?.parts.find((part) => part.type === "text");
		expect(text && "text" in text ? text.text.split(" ") : []).toHaveLength(30);
		const counters = await server.counters();
		expect(counters.resumes).toBe(1);
		expect(counters.generations).toBe(1);
		await server.fault("abort", false);
	});

	it("INT-TR-09 resume → stop → resume (Strict Mode) converges on one observation and one GET", async () => {
		const chatId = newChatId();
		const a = tab(chatId);
		const sending = a.chat.sendMessage(
			{ text: "hi" },
			{ body: { size: 40, delayMs: 5 } },
		);
		await waitFor(() => (lastAssistant(a.chat)?.parts.length ?? 0) > 0);
		const c = tab(chatId);
		const first = c.chat.resumeStream();
		await c.chat.stop();
		const second = c.chat.resumeStream();
		await Promise.all([first, second, sending]);
		expect(c.chat.error).toBeUndefined();
		expect(c.chat.messages.filter((m) => m.role === "assistant")).toHaveLength(
			1,
		);
		expect(withoutId(lastAssistant(c.chat))).toEqual(
			withoutId(lastAssistant(a.chat)),
		);
		const counters = await server.counters();
		expect(counters.resumes).toBe(1);
		expect(counters.stops).toBe(0);
	});

	it("INT-TR-10 role gating keeps client tool side effects in the originating tab", async () => {
		const chatId = newChatId();
		const tabs: Tab[] = [];
		const gated = (index: number) => ({
			onToolCall: ({
				toolCall,
			}: {
				toolCall: { toolCallId: string; toolName: string };
			}) => {
				const self = tabs[index];
				if (self?.transport.role(chatId) !== "originator") return;
				void self.chat.addToolOutput({
					tool: toolCall.toolName as never,
					toolCallId: toolCall.toolCallId,
					output: { confirmed: true } as never,
				});
			},
			sendAutomaticallyWhen: (options: { messages: UIMessage[] }) =>
				tabs[index]?.transport.role(chatId) === "originator" &&
				lastAssistantMessageIsCompleteWithToolCalls(options),
		});
		tabs.push(tab(chatId, { chat: gated(0) }));
		tabs.push(tab(chatId, { chat: gated(1) }));
		const [a, b] = tabs as [Tab, Tab];
		b.transport.observe(chatId, { onStart: () => void b.chat.resumeStream() });
		await a.chat.sendMessage(
			{ text: "hi" },
			{ body: { script: "client-tool" } },
		);
		await waitFor(async () => (await server.counters()).generations === 2);
		await waitFor(() => a.chat.status === "ready" && b.chat.status === "ready");
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(await startsFor(chatId, a.client)).toBe(2);
		expect(await startsFor(chatId, b.client)).toBe(0);
		expect((await server.counters()).generations).toBe(2);
	});

	it("INT-TR-10 without role gating a follower multiplies the side effect (why role() exists)", async () => {
		const chatId = newChatId();
		const tabs: Tab[] = [];
		let enabled = true;
		const ungated = (index: number) => ({
			onToolCall: ({
				toolCall,
			}: {
				toolCall: { toolCallId: string; toolName: string };
			}) => {
				if (!enabled) return;
				void tabs[index]?.chat.addToolOutput({
					tool: toolCall.toolName as never,
					toolCallId: toolCall.toolCallId,
					output: { confirmed: true } as never,
				});
			},
			sendAutomaticallyWhen: (options: { messages: UIMessage[] }) =>
				enabled && lastAssistantMessageIsCompleteWithToolCalls(options),
		});
		tabs.push(tab(chatId, { chat: ungated(0) }));
		tabs.push(tab(chatId, { chat: ungated(1) }));
		const [a, b] = tabs as [Tab, Tab];
		b.transport.observe(chatId, { onStart: () => void b.chat.resumeStream() });
		void a.chat.sendMessage(
			{ text: "hi" },
			{ body: { script: "client-tool" } },
		);
		await waitFor(async () => (await startsFor(chatId, b.client)) >= 1);
		enabled = false;
		await Promise.all([a.chat.stop(), b.chat.stop()]);
		expect(await startsFor(chatId, b.client)).toBeGreaterThanOrEqual(1);
	});
});
