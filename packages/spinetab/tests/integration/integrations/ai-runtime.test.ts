import { Chat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage, type UIMessageChunk } from "ai";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	browserEnv,
	type ClientEnv,
	createClientWithEnv,
} from "../../../src/core/client.ts";
import {
	createRuntime,
	type Runtime,
	setWorkerOriginForTests,
} from "../../../src/core/runtime.ts";
import type {
	Credentials,
	SpinetabClient,
	SpinetabOptions,
} from "../../../src/core/types.ts";
import {
	SpinetabChatTransport,
	type SpinetabChatTransportOptions,
} from "../../../src/integrations/ai-sdk/index.ts";
import { aiSdkAdapter } from "../../../src/integrations/ai-sdk/runtime.ts";
import {
	type RunningFixtures,
	startFixtures,
} from "../../fixtures/servers/start.ts";
import { fixture, waitFor } from "./helpers/fake-context.ts";

// INT-RT-01…07: the AI transport over the REAL page client, bridge protocol
// (MessageChannel) and `createRuntime` from the core slice, in Node. Two page
// clients ("tabs") attach to one runtime instance, as tabs attach to one
// SharedWorker. Only browser globals are replaced (ClientEnv); the SharedWorker
// itself is covered by tests/browser/integrations-ai.spec.ts.

(globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;

let running: RunningFixtures;
let origin: string;
let server: Awaited<ReturnType<typeof fixture>>;
let runtime: Runtime | undefined;
const clients: SpinetabClient[] = [];
let counter = 0;
const newChatId = () => `rt-chat-${++counter}-${Date.now()}`;

beforeAll(async () => {
	running = await startFixtures([0]);
	origin = running.apps[0]?.origin ?? "";
	server = await fixture(origin);
	// The worker is served from the fixture's origin, as in a browser: the
	// chat endpoints are its own origin for the credential audience.
	setWorkerOriginForTests(origin);
});
afterAll(() => {
	setWorkerOriginForTests(undefined);
	return running.close();
});
afterEach(async () => {
	for (const client of clients.splice(0)) client.dispose();
	runtime?.dispose();
	runtime = undefined;
	await server.reset();
});

const nodeEnv = (): ClientEnv => ({
	...browserEnv,
	isBrowser: () => true,
	hasSharedWorker: () => false,
	visible: () => true,
	baseUri: () => `${origin}/`,
	listen: () => () => {},
});

function tab(
	chatId: string,
	options: {
		scope?: string;
		credentials?: SpinetabOptions["credentials"];
		transport?: Partial<SpinetabChatTransportOptions>;
	} = {},
) {
	runtime ??= createRuntime({
		adapters: [aiSdkAdapter()],
		limits: { idleCloseMs: 100 },
	});
	const shared = runtime;
	const client = createClientWithEnv(
		{
			sharing: "off",
			local: async () => ({ runtime: () => shared }),
			...(options.scope === undefined ? {} : { scope: options.scope }),
			...(options.credentials === undefined
				? {}
				: { credentials: options.credentials }),
		},
		nodeEnv(),
	);
	clients.push(client);
	const interrupted: string[] = [];
	const transport = new SpinetabChatTransport({
		client,
		api: `${origin}/ai/chat`,
		stop: { api: (id) => `${origin}/ai/chat/${id}/stop` },
		onInterrupted: (id) => interrupted.push(id),
		...options.transport,
	});
	const finishes: Array<{ isAbort: boolean; isDisconnect: boolean }> = [];
	const chat = new Chat<UIMessage>({
		id: chatId,
		transport,
		onFinish: ({ isAbort, isDisconnect }) =>
			finishes.push({ isAbort, isDisconnect }),
	});
	return { client, transport, chat, finishes, interrupted };
}

const lastAssistant = (chat: Chat<UIMessage>): UIMessage | undefined =>
	[...chat.messages].reverse().find((message) => message.role === "assistant");
const withoutId = (message: UIMessage | undefined) => {
	if (!message) return undefined;
	const { id: _id, ...rest } = message;
	return rest;
};
async function drain(stream: ReadableStream<UIMessageChunk> | null) {
	const chunks: UIMessageChunk[] = [];
	if (!stream) return chunks;
	const reader = stream.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) return chunks;
		chunks.push(value);
	}
}
const words = (message: UIMessage | undefined) => {
	const part = message?.parts.find((item) => item.type === "text");
	return part && "text" in part ? part.text.split(" ").length : 0;
};

describe("SpinetabChatTransport over the real client, bridge and runtime", () => {
	it("INT-RT-01 one tab: the final message equals the DefaultChatTransport baseline; one start", async () => {
		const body = { script: "all", size: 4 };
		const baseline = new Chat<UIMessage>({
			id: newChatId(),
			transport: new DefaultChatTransport({ api: `${origin}/ai/chat` }),
		});
		await baseline.sendMessage(
			{ text: "hi" },
			{ body: { ...body, generationId: "baseline" } },
		);
		const a = tab(newChatId());
		await a.chat.sendMessage({ text: "hi" }, { body });
		expect(a.chat.error).toBeUndefined();
		expect(withoutId(lastAssistant(a.chat))).toEqual(
			withoutId(lastAssistant(baseline)),
		);
		expect(a.client.status.get().mode).toBe("local");
		expect((await server.counters()).generations).toBe(2);
	});

	it("INT-RT-02 a pre-attached follower in a second tab receives the whole generation; one start, no resume", async () => {
		const chatId = newChatId();
		const a = tab(chatId);
		const b = tab(chatId);
		b.transport.observe(chatId, { onStart: () => void b.chat.resumeStream() });
		// Let the observe intent reach the runtime before the start.
		await waitFor(() => b.client.status.get().mode === "local");
		await a.chat.sendMessage(
			{ text: "hi" },
			{ body: { size: 40, delayMs: 2 } },
		);
		await waitFor(
			() => b.chat.status === "ready" && lastAssistant(b.chat) !== undefined,
		);
		expect(b.chat.error).toBeUndefined();
		expect(withoutId(lastAssistant(b.chat))).toEqual(
			withoutId(lastAssistant(a.chat)),
		);
		expect(b.transport.role(chatId)).toBe("follower");
		const counters = await server.counters();
		expect(counters.generations).toBe(1);
		expect(counters.resumes).toBe(0);
	});

	it("INT-RT-03 aborting the originator detaches only; the follower completes and no stop is sent", async () => {
		const chatId = newChatId();
		const a = tab(chatId);
		const b = tab(chatId);
		b.transport.observe(chatId, { onStart: () => void b.chat.resumeStream() });
		await waitFor(() => b.client.status.get().mode === "local");
		const sending = a.chat.sendMessage(
			{ text: "hi" },
			{ body: { size: 60, delayMs: 5 } },
		);
		await waitFor(() => (lastAssistant(b.chat)?.parts.length ?? 0) > 0);
		await a.chat.stop();
		await sending;
		await waitFor(() => b.chat.status === "ready" && b.finishes.length === 1);
		expect(a.finishes[0]?.isAbort).toBe(true);
		expect(words(lastAssistant(b.chat))).toBe(60);
		expect((await server.counters()).stops).toBe(0);
	});

	it("INT-RT-04 late joiners resume through backend GETs from the start; a staggered joiner gets its own", async () => {
		const chatId = newChatId();
		const a = tab(chatId);
		const sending = a.chat.sendMessage(
			{ text: "hi" },
			{ body: { size: 50, delayMs: 5 } },
		);
		await waitFor(() => (lastAssistant(a.chat)?.parts.length ?? 0) > 0);
		const c = tab(chatId);
		const first = c.chat.resumeStream();
		await waitFor(() => (lastAssistant(c.chat)?.parts.length ?? 0) > 0);
		// A staggered joiner cannot share the replay already in progress
		// (before-start rejection) and gets its own request from the start.
		const d = tab(chatId);
		await Promise.all([first, d.chat.resumeStream(), sending]);
		for (const joiner of [c, d]) {
			expect(joiner.chat.error).toBeUndefined();
			expect(withoutId(lastAssistant(joiner.chat))).toEqual(
				withoutId(lastAssistant(a.chat)),
			);
		}
		const counters = await server.counters();
		expect(counters.resumes).toBe(2);
		expect(counters.generations).toBe(1);
	});

	it("INT-RT-06 a late resume of a long generation replays its buffered burst without overflowing the window", async () => {
		// 2 000 chunks already emitted arrive at once from the replay; without
		// batching the per-consumer window (64 messages) overflowed after ~60.
		const chatId = newChatId();
		const a = tab(chatId);
		const sending = a.chat.sendMessage(
			{ text: "hi" },
			{ body: { size: 2_100, delayMs: 0 } },
		);
		await waitFor(() => words(lastAssistant(a.chat)) >= 2_000, 30_000);
		const c = tab(chatId);
		await Promise.all([c.chat.resumeStream(), sending]);
		expect(c.chat.error).toBeUndefined();
		expect(words(lastAssistant(c.chat))).toBe(2_100);
		expect((await server.counters()).resumes).toBe(1);
	});

	it("INT-RT-07 a principal change discards a completed, unread follower queue", async () => {
		// the queue of the previous scope must not be claimable.
		// `resume: false` keeps the backend out: only the page queue could answer.
		const chatId = newChatId();
		const scope = "alice";
		const a = tab(chatId, { scope });
		const b = tab(chatId, { scope, transport: { resume: false } });
		const c = tab(chatId, { scope, transport: { resume: false } });
		const disposeB = b.transport.observe(chatId);
		const disposeC = c.transport.observe(chatId);
		await waitFor(
			() =>
				b.client.status.get().mode === "local" &&
				c.client.status.get().mode === "local",
		);
		await a.chat.sendMessage(
			{ text: "hi" },
			{ body: { size: 12, delayMs: 1 } },
		);
		expect(b.transport.role(chatId)).toBe("follower");
		// Control in the old scope: the completed queue holds the whole generation.
		const control = await drain(
			await c.transport.reconnectToStream({ chatId }),
		);
		expect(control.at(-1)?.type).toBe("finish");
		const text = control
			.map((chunk) => (chunk.type === "text-delta" ? chunk.delta : ""))
			.join("");
		expect(text.split(" ")).toHaveLength(12);
		// b's identical queue completed unread; let its last delivery settle.
		await new Promise((resolve) => setTimeout(resolve, 50));

		b.client.setScope("bob");
		const stream = await b.transport.reconnectToStream({ chatId });
		expect(stream).toBeNull();
		expect(await drain(stream)).toEqual([]);
		expect(b.transport.role(chatId)).toBeUndefined();
		const counters = await server.counters();
		expect(counters.generations).toBe(1);
		expect(counters.resumes).toBe(0);
		disposeB();
		disposeC();
	});

	// a provider failure used to reach the broker as
	// `no-credential-source`, which the AI adapter reads as a cookie app and
	// sends without credentials.
	const failingProviders: Array<[string, () => Credentials]> = [
		[
			"throws",
			() => {
				throw new Error("The token endpoint is down.");
			},
		],
		["returns a non-object", () => "token" as unknown as Credentials],
	];
	for (const [label, provider] of failingProviders) {
		it(`a credentials provider that ${label} never sends an anonymous chat request`, async () => {
			const a = tab(newChatId(), { credentials: provider });
			await a.chat.sendMessage({ text: "hi" }, { body: { requireAuth: true } });
			expect(a.chat.error).toMatchObject({
				code: "command-not-sent",
				detail: { cause: "credentials-failed" },
			});
			const counters = await server.counters();
			expect(counters.generations).toBe(0);
			expect(counters.startHeaders).toEqual([]);
		});
	}

	it("INT-RT-05 no active stream: HTTP 204 resolves to null and Chat stays ready", async () => {
		const c = tab(newChatId());
		await c.chat.resumeStream();
		expect(c.chat.status).toBe("ready");
		expect(c.chat.error).toBeUndefined();
		const counters = await server.counters();
		expect(counters.resumeStatuses).toEqual([204]);
		expect(counters.generations).toBe(0);
	});
});
