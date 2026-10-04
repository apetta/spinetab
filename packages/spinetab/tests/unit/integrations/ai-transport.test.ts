import type { UIMessage, UIMessageChunk } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	AdapterConnection,
	RuntimeAdapter,
	SubscriptionSink,
} from "../../../src/core/adapter.ts";
import { createClientWithEnv } from "../../../src/core/client.ts";
import { isSpinetabError } from "../../../src/core/errors.ts";
import type {
	CommandOutcome,
	SpinetabClient,
	SubscriptionObserver,
} from "../../../src/core/types.ts";
import {
	type AiObserveEvent,
	SpinetabChatTransport,
	SpinetabInterruptedError,
} from "../../../src/integrations/ai-sdk/index.ts";
import {
	AI_ADAPTER_KIND,
	type AiCommandPayload,
	type AiCommandResult,
	type AiSubscriptionSpec,
} from "../../../src/integrations/ai-sdk/shared.ts";
import { createLoopbackClient } from "../../integration/integrations/helpers/loopback-client.ts";
import { ManualClock } from "../core/helpers/clock.ts";
import { createTestEnv } from "../core/helpers/env.ts";

// UNIT-AI-02…07: page transport semantics against a scripted in-memory adapter
// hosted by the loopback runtime stand-in. No network.

type Sink = SubscriptionSink<UIMessageChunk[]>;

function scriptedAdapter() {
	const sinks = new Map<string, Sink>();
	const payloads: AiCommandPayload[] = [];
	const outcomes: Array<CommandOutcome<AiCommandResult>> = [];
	const adapter: RuntimeAdapter<
		{ api: string },
		AiSubscriptionSpec,
		UIMessageChunk[],
		AiCommandPayload,
		AiCommandResult
	> = {
		kind: AI_ADAPTER_KIND,
		version: 1,
		connect(): AdapterConnection<
			AiSubscriptionSpec,
			UIMessageChunk[],
			AiCommandPayload,
			AiCommandResult
		> {
			return {
				subscribe(spec, sink) {
					const key =
						spec.kind === "generation"
							? spec.generationId
							: spec.kind === "resume"
								? `resume:${spec.nonce}`
								: `observe:${spec.chatId}`;
					sinks.set(key, sink);
					return { unsubscribe: () => sinks.delete(key) };
				},
				async command(payload) {
					payloads.push(payload);
					return (
						outcomes.shift() ?? {
							status: "acknowledged",
							value: { status: 200, generationId: payload.generationId },
						}
					);
				},
				dispose() {},
			};
		},
	};
	return { adapter, sinks, payloads, outcomes };
}

const API = "https://chat.example/api/chat";
const flush = () => new Promise((resolve) => setTimeout(resolve, 5));
const sendOptions = (
	overrides: Partial<Parameters<SpinetabChatTransport["sendMessages"]>[0]> = {},
) => ({
	trigger: "submit-message" as const,
	chatId: "chat-1",
	messageId: undefined,
	messages: [
		{ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
	] as UIMessage[],
	abortSignal: undefined,
	...overrides,
});

async function readAll(stream: ReadableStream<UIMessageChunk>) {
	const chunks: UIMessageChunk[] = [];
	const reader = stream.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) return chunks;
		chunks.push(value);
	}
}

function setup(
	options: Partial<ConstructorParameters<typeof SpinetabChatTransport>[0]> = {},
) {
	const scripted = scriptedAdapter();
	const client = createLoopbackClient({ adapters: [scripted.adapter] });
	const interrupted: string[] = [];
	const transport = new SpinetabChatTransport({
		client,
		api: API,
		stop: { api: (chatId, id) => `${API}/${chatId}/stop?g=${id}` },
		onInterrupted: (chatId) => interrupted.push(chatId),
		...options,
	});
	return { ...scripted, client, transport, interrupted };
}

const generationSink = (sinks: Map<string, Sink>): Sink => {
	const sink = [...sinks.entries()].find(
		([key]) => !key.startsWith("resume") && !key.startsWith("observe"),
	)?.[1];
	if (!sink) throw new Error("no generation sink");
	return sink;
};

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("SpinetabChatTransport construction (UNIT-AI-02)", () => {
	it("is inert: constructing never subscribes, commands or starts the client", () => {
		const client = {
			scope: "",
			start: vi.fn(),
			subscribe: vi.fn(),
			command: vi.fn(),
		} as unknown as SpinetabClient;
		new SpinetabChatTransport({ client, api: API });
		expect(client.start).not.toHaveBeenCalled();
		expect(client.subscribe).not.toHaveBeenCalled();
		expect(client.command).not.toHaveBeenCalled();
	});

	it("rejects options that cannot cross the bridge, naming them", () => {
		const client = createLoopbackClient({ adapters: [] });
		for (const key of [
			"fetch",
			"prepareSendMessagesRequest",
			"prepareReconnectToStreamRequest",
		]) {
			expect(
				() =>
					new SpinetabChatTransport({
						client,
						[key]: () => undefined,
					} as never),
			).toThrowError(
				expect.objectContaining({
					code: "unsupported-option",
					detail: { path: `options.${key}` },
				}),
			);
		}
		expect(() => new SpinetabChatTransport({} as never)).toThrowError(
			expect.objectContaining({ code: "unsupported-option" }),
		);
	});

	it("resolves relative endpoints against the document base; rejects userinfo", async () => {
		vi.stubGlobal("document", { baseURI: "https://app.example/chat/" });
		const { transport, payloads, client } = setup({ api: "../api/chat" });
		const stream = await transport.sendMessages(sendOptions());
		void stream.cancel();
		expect(payloads).toHaveLength(1);
		expect(client.commands[0]).toBeDefined();
		const bad = new SpinetabChatTransport({
			client,
			api: "https://user:pw@app.example/api",
		});
		await expect(bad.sendMessages(sendOptions())).rejects.toMatchObject({
			code: "invalid-endpoint",
		});
	});
});

describe("sendMessages (UNIT-AI-03)", () => {
	it("subscribes before one start command with the DefaultChatTransport body plus generationId", async () => {
		const { transport, payloads, sinks, client } = setup({
			headers: { "x-app": "1" },
			body: { tenant: "t" },
			credentials: "include",
		});
		const subscribe = vi.spyOn(client, "subscribe");
		const command = vi.spyOn(client, "command");
		const stream = await transport.sendMessages(
			sendOptions({ headers: { "x-call": "2" }, body: { extra: true } }),
		);
		expect(subscribe.mock.invocationCallOrder[0]).toBeLessThan(
			command.mock.invocationCallOrder[0] ?? 0,
		);
		expect(payloads).toHaveLength(1);
		const payload = payloads[0] as Extract<AiCommandPayload, { type: "start" }>;
		expect(payload.headers).toEqual({ "x-app": "1", "x-call": "2" });
		expect(payload.credentials).toBe("include");
		const body = JSON.parse(payload.body);
		expect(body).toMatchObject({
			tenant: "t",
			extra: true,
			id: "chat-1",
			trigger: "submit-message",
			generationId: payload.generationId,
		});
		expect(body.messages).toHaveLength(1);
		const sink = generationSink(sinks);
		sink.started();
		sink.next([{ type: "start", messageId: payload.generationId }]);
		sink.next([{ type: "finish" }]);
		sink.complete();
		expect(await readAll(stream)).toEqual([
			{ type: "start", messageId: payload.generationId },
			{ type: "finish" },
		]);
		expect(transport.role("chat-1")).toBe("originator");
	});

	it("flattens delivered batches into ordered chunks", async () => {
		const { transport, sinks } = setup();
		const stream = await transport.sendMessages(sendOptions());
		const sink = generationSink(sinks);
		sink.started();
		sink.next([
			{ type: "start" },
			{ type: "text-start", id: "t" },
			{ type: "text-delta", id: "t", delta: "a" },
		]);
		sink.next([{ type: "text-end", id: "t" }, { type: "finish" }]);
		sink.complete();
		expect((await readAll(stream)).map((chunk) => chunk.type)).toEqual([
			"start",
			"text-start",
			"text-delta",
			"text-end",
			"finish",
		]);
	});

	it("maps rejected, not-sent and unknown starts to typed errors without resending", async () => {
		const { transport, payloads, outcomes, sinks } = setup();
		outcomes.push(
			{
				status: "rejected",
				error: {
					code: "upstream-error",
					message: "Model overloaded",
					detail: { status: 503 },
				},
			},
			{
				status: "not-sent",
				error: { code: "credentials-timeout", message: "timeout" },
			},
			{
				status: "unknown",
				error: { code: "command-unknown", message: "worker lost" },
			},
		);
		await expect(transport.sendMessages(sendOptions())).rejects.toMatchObject({
			code: "upstream-error",
			message: "Model overloaded",
			detail: { status: 503 },
		});
		await expect(transport.sendMessages(sendOptions())).rejects.toMatchObject({
			code: "command-not-sent",
		});
		await expect(transport.sendMessages(sendOptions())).rejects.toMatchObject({
			code: "command-unknown",
		});
		await flush();
		expect(payloads).toHaveLength(3);
		expect(sinks.size).toBe(0);
	});

	it("an already-aborted signal sends nothing; aborting later detaches only", async () => {
		const { transport, payloads, sinks, client } = setup();
		const controller = new AbortController();
		controller.abort();
		await expect(
			transport.sendMessages(sendOptions({ abortSignal: controller.signal })),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(payloads).toHaveLength(0);

		const live = new AbortController();
		const stream = await transport.sendMessages(
			sendOptions({ abortSignal: live.signal }),
		);
		expect(sinks.size).toBe(1);
		live.abort();
		expect(await readAll(stream)).toEqual([]);
		await flush();
		expect(sinks.size).toBe(0);
		expect(
			client.commands.filter(
				(c) => (c.payload as AiCommandPayload).type === "stop",
			),
		).toHaveLength(0);
	});
});

describe("interruption episodes (UNIT-AI-04)", () => {
	it("actual loss errors with a TypeError mentioning network and calls onInterrupted once", async () => {
		const { transport, sinks, interrupted } = setup();
		const stream = await transport.sendMessages(sendOptions());
		const sink = generationSink(sinks);
		sink.started();
		sink.next([{ type: "start" }]);
		sink.error({ code: "interrupted", message: "upstream dropped" });
		const reader = stream.getReader();
		expect(await reader.read()).toEqual({
			done: false,
			value: { type: "start" },
		});
		const failure = await reader.read().catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(TypeError);
		expect(failure).toBeInstanceOf(SpinetabInterruptedError);
		expect((failure as Error).message.toLowerCase()).toContain("network");
		expect(isSpinetabError(failure, "interrupted")).toBe(true);
		await vi.waitFor(() => expect(interrupted).toEqual(["chat-1"]));

		// A second loss in the same episode (a failed resume) is not reported again.
		const resumed = transport.reconnectToStream({ chatId: "chat-1" });
		await flush();
		sinks
			.get("resume:shared")
			?.error({ code: "interrupted", message: "again" });
		await expect(resumed).rejects.toMatchObject({ code: "interrupted" });
		await vi.waitFor(() => expect(interrupted).toEqual(["chat-1"]));
	});

	it("two live streams of one chat lost together report one episode", async () => {
		const { transport, sinks, interrupted } = setup();
		const first = await transport.sendMessages(sendOptions());
		const resuming = transport.reconnectToStream({ chatId: "chat-1" });
		await flush();
		const resumeSink = sinks.get("resume:shared");
		resumeSink?.started();
		resumeSink?.next([{ type: "start", messageId: "g" }]);
		const second = await resuming;
		expect(second).not.toBeNull();
		generationSink(sinks).error({ code: "interrupted", message: "lost" });
		resumeSink?.error({ code: "interrupted", message: "lost" });
		await Promise.all([
			readAll(first).catch(() => {}),
			second ? readAll(second).catch(() => {}) : undefined,
		]);
		await vi.waitFor(() => expect(interrupted).toEqual(["chat-1"]));
	});

	it("continuity loss from the runtime is an interruption; a bare status change is not", async () => {
		const { transport, sinks, interrupted, client } = setup();
		await transport.sendMessages(sendOptions());
		const sink = generationSink(sinks);
		sink.started();
		sink.next([{ type: "start" }]);
		await flush();
		// Status notifications without lost delivery.
		sink.continuity("reconciled");
		await flush();
		expect(interrupted).toEqual([]);
		sink.continuity("runtime-replaced");
		await vi.waitFor(() => expect(interrupted).toEqual(["chat-1"]));
		void client;
	});

	it("explicit stop suppresses interruption callbacks until the next start", async () => {
		const { transport, sinks, interrupted, payloads } = setup();
		await transport.sendMessages(sendOptions());
		const outcome = await transport.stop("chat-1");
		expect(outcome.status).toBe("acknowledged");
		const stop = payloads[1] as Extract<AiCommandPayload, { type: "stop" }>;
		expect(stop.url).toBe(
			`${API}/chat-1/stop?g=${(payloads[0] as { generationId: string }).generationId}`,
		);
		generationSink(sinks).error({ code: "interrupted", message: "x" });
		await flush();
		expect(interrupted).toEqual([]);

		await transport.sendMessages(sendOptions());
		const next = [...sinks.values()].at(-1);
		next?.error({ code: "interrupted", message: "y" });
		await vi.waitFor(() => expect(interrupted).toEqual(["chat-1"]));
	});
});

/**
 * A follower whose stream was claimed, driven by a synchronous controlled
 * client: observe events and errors run inline and commands settle on
 * microtasks, so a stop can be acknowledged before the queued `setTimeout(0)`
 * interruption callback dispatches.
 */
async function claimedFollower(
	settings: {
		headers?: () => Promise<Record<string, string>>;
		outcome?: CommandOutcome<AiCommandResult>;
	} = {},
) {
	let observer: SubscriptionObserver<AiObserveEvent> | undefined;
	const commands: string[] = [];
	const interrupted: Array<{ chatId: string; afterStop: boolean }> = [];
	const client = {
		scope: "alice",
		subscribe(
			request: { subscription: AiSubscriptionSpec },
			sink: SubscriptionObserver<AiObserveEvent>,
		) {
			if (request.subscription.kind !== "observe") {
				throw new Error(`unexpected ${request.subscription.kind} subscription`);
			}
			observer = sink;
			return { id: "observe", unsubscribe() {} };
		},
		async command(request: {
			payload: AiCommandPayload;
		}): Promise<CommandOutcome<AiCommandResult>> {
			commands.push(request.payload.type);
			return (
				settings.outcome ?? {
					status: "acknowledged",
					value: { status: 200, generationId: request.payload.generationId },
				}
			);
		},
	};
	const transport = new SpinetabChatTransport({
		client: client as unknown as SpinetabClient,
		api: API,
		...(settings.headers ? { headers: settings.headers } : {}),
		resume: false,
		stop: { api: (chatId, id) => `${API}/${chatId}/stop?g=${id}` },
		onInterrupted: (chatId) =>
			interrupted.push({ chatId, afterStop: commands.includes("stop") }),
	});
	const dispose = transport.observe("chat-1");
	const sink = () => {
		if (!observer) throw new Error("no observe registration");
		return observer;
	};
	const begin = (generationId: string) =>
		sink().next(
			{
				type: "chunks",
				generationId,
				index: 0,
				chunks: [{ type: "start", messageId: generationId }],
			},
			{ seq: 0 },
		);
	begin("g1");
	const stream = await transport.reconnectToStream({ chatId: "chat-1" });
	if (!stream) throw new Error("follower stream missing");
	const reader = stream.getReader();
	expect((await reader.read()).value).toEqual({
		type: "start",
		messageId: "g1",
	});
	return {
		client,
		transport,
		commands,
		interrupted,
		reader,
		dispose,
		begin,
		lose: () =>
			sink().error?.({ code: "interrupted", message: "controlled loss" }),
		/** The follower's stream error, read after the loss. */
		failure: () => reader.read().catch((error: unknown) => error),
	};
}

describe("interruption callback dispatch (UNIT-AI-04)", () => {
	it("a loss alone notifies once", async () => {
		const follower = await claimedFollower();
		follower.lose();
		expect(isSpinetabError(await follower.failure(), "interrupted")).toBe(true);
		await flush();
		await vi.waitFor(() =>
			expect(follower.interrupted).toEqual([
				{ chatId: "chat-1", afterStop: false },
			]),
		);
		follower.dispose();
	});

	it("a stop acknowledged before the queued callback dispatches suppresses it", async () => {
		const follower = await claimedFollower();
		follower.lose();
		const outcome = await follower.transport.stop("chat-1");
		expect(outcome.status).toBe("acknowledged");
		expect(follower.commands).toEqual(["stop"]);
		expect(isSpinetabError(await follower.failure(), "interrupted")).toBe(true);
		await flush();
		expect(follower.interrupted).toEqual([]);
		follower.dispose();
	});

	it("a stop still preparing its headers when the queued callback dispatches suppresses it", async () => {
		let release: (headers: Record<string, string>) => void = () => {};
		let preparing = 0;
		const follower = await claimedFollower({
			headers: () => {
				preparing += 1;
				return new Promise((resolve) => {
					release = resolve;
				});
			},
		});
		follower.lose();
		const stopping = follower.transport.stop("chat-1");
		// The queued zero-delay callback dispatches while preparation waits.
		await flush();
		await flush();
		expect(preparing).toBe(1);
		expect(follower.commands).toEqual([]);
		expect(follower.interrupted).toEqual([]);
		release({ "x-trace": "1" });
		const outcome = await stopping;
		expect(outcome.status).toBe("acknowledged");
		expect(follower.commands).toEqual(["stop"]);
		expect(isSpinetabError(await follower.failure(), "interrupted")).toBe(true);
		await flush();
		expect(follower.interrupted).toEqual([]);
		follower.dispose();
	});

	it("returns an unknown stop outcome as is, sent once", async () => {
		const follower = await claimedFollower({
			headers: async () => ({}),
			outcome: {
				status: "unknown",
				error: {
					code: "command-unknown",
					message: "timed out",
				} as never,
			},
		});
		follower.lose();
		const outcome = await follower.transport.stop("chat-1");
		expect(outcome).toMatchObject({
			status: "unknown",
			error: { code: "command-unknown" },
		});
		expect(follower.commands).toEqual(["stop"]);
		await flush();
		expect(follower.interrupted).toEqual([]);
		follower.dispose();
	});

	it("a stop whose preparation fails sends nothing and still suppresses the queued callback", async () => {
		const follower = await claimedFollower({
			headers: async () => {
				throw new Error("header source failed");
			},
		});
		follower.lose();
		await expect(follower.transport.stop("chat-1")).rejects.toThrow(
			"header source failed",
		);
		expect(follower.commands).toEqual([]);
		await flush();
		expect(follower.interrupted).toEqual([]);
		follower.dispose();
	});

	it("a stop before the loss suppresses the callback", async () => {
		const follower = await claimedFollower();
		await follower.transport.stop("chat-1");
		follower.lose();
		expect(isSpinetabError(await follower.failure(), "interrupted")).toBe(true);
		await flush();
		expect(follower.interrupted).toEqual([]);
		follower.dispose();
	});

	it("a principal change before the queued callback dispatches suppresses it", async () => {
		const follower = await claimedFollower();
		follower.lose();
		// Silent scope change: nothing looks the chat up before dispatch.
		follower.client.scope = "bob";
		await flush();
		expect(follower.interrupted).toEqual([]);
		follower.dispose();
	});

	it("a callback queued for a superseded episode does not dispatch; the new episode notifies once", async () => {
		const follower = await claimedFollower();
		follower.lose();
		// A new generation opens a new episode, which is lost before dispatch.
		follower.begin("g2");
		const next = await follower.transport.reconnectToStream({
			chatId: "chat-1",
		});
		expect(next).not.toBeNull();
		follower.lose();
		await vi.waitFor(() =>
			expect(follower.interrupted).toEqual([
				{ chatId: "chat-1", afterStop: false },
			]),
		);
		follower.dispose();
	});
});

describe("bounded hold queue (UNIT-AI-05)", () => {
	it("errors only this observer with overflow when it holds more than the window", async () => {
		const { transport, sinks, interrupted } = setup({
			limits: { maxPendingMessagesPerConsumer: 4 },
		});
		const stream = await transport.sendMessages(sendOptions());
		const sink = generationSink(sinks);
		sink.started();
		for (let index = 0; index < 5; index += 1) {
			sink.next([{ type: "text-delta", id: "t", delta: `${index}` }]);
		}
		await flush();
		const failure = await readAll(stream).catch((error: unknown) => error);
		expect(isSpinetabError(failure, "overflow")).toBe(true);
		// The loopback runtime releases its upstream after one macrotask of linger.
		await vi.waitFor(() => expect(sinks.size).toBe(0));
		await vi.waitFor(() => expect(interrupted).toEqual(["chat-1"]));
	});

	it("keeps no history: consumed chunks are released and a reader keeps up indefinitely", async () => {
		const { transport, sinks } = setup({
			limits: { maxPendingMessagesPerConsumer: 2 },
		});
		const stream = await transport.sendMessages(sendOptions());
		const sink = generationSink(sinks);
		const reader = stream.getReader();
		for (let index = 0; index < 50; index += 1) {
			sink.next([{ type: "text-delta", id: "t", delta: `${index}` }]);
			await flush();
			expect((await reader.read()).value).toEqual({
				type: "text-delta",
				id: "t",
				delta: `${index}`,
			});
		}
	});
});

describe("stop and resume sources (UNIT-AI-06)", () => {
	it("stop is unavailable without an endpoint or a known generation", async () => {
		const { client } = setup();
		const without = new SpinetabChatTransport({ client, api: API });
		await expect(without.stop("chat-1")).rejects.toMatchObject({
			code: "stop-unavailable",
			detail: { reason: "not-configured" },
		});
		const { transport } = setup();
		await expect(transport.stop("unknown-chat")).rejects.toMatchObject({
			code: "stop-unavailable",
			detail: { reason: "no-active-generation" },
		});
	});

	it("without a resume source: null when nothing is known, cannot-resume after a loss", async () => {
		const { transport, sinks } = setup({ resume: false });
		expect(await transport.reconnectToStream({ chatId: "chat-1" })).toBeNull();
		await transport.sendMessages(sendOptions());
		generationSink(sinks).error({ code: "interrupted", message: "x" });
		await flush();
		await expect(
			transport.reconnectToStream({ chatId: "chat-1" }),
		).rejects.toMatchObject({
			code: "cannot-resume",
			detail: { reason: "no-resume-source" },
		});
	});
});

describe("scope change (UNIT-AI-07)", () => {
	it("discards queued old-scope chunks and errors with scope-changed", async () => {
		const { transport, sinks, client, interrupted } = setup();
		const stream = await transport.sendMessages(sendOptions());
		const sink = generationSink(sinks);
		sink.next([{ type: "start" }]);
		await flush();
		client.changeScope("other-user");
		sink.next([{ type: "text-delta", id: "t", delta: "old scope" }]);
		await flush();
		const reader = stream.getReader();
		const failure = await reader.read().catch((error: unknown) => error);
		expect(isSpinetabError(failure, "scope-changed")).toBe(true);
		expect(interrupted).toEqual([]);
	});
});

describe("client base URL (UNIT-AI-13)", () => {
	// The document base differs from the client's explicit baseUrl, so one page
	// would otherwise resolve `/api/chat` two ways.
	function baseClient() {
		vi.stubGlobal("document", { baseURI: "https://app.test/page/" });
		const clock = new ManualClock();
		const kit = createTestEnv(clock, {
			baseUri: () => "https://app.test/page/",
		});
		const client = createClientWithEnv(
			{
				baseUrl: "https://api.test/",
				worker: () => {
					throw new Error("no worker");
				},
			},
			kit.env,
		);
		// Spied in place: the transport must receive this very client object.
		const seen: Array<{ connection: unknown; subscription?: unknown }> = [];
		const { command, subscribe } = client;
		client.command = ((request, options) => {
			seen.push({ connection: request.connection });
			return command(request, options);
		}) as typeof client.command;
		client.subscribe = ((source, observer, options) => {
			const request = source as { connection: unknown; subscription: unknown };
			seen.push({
				connection: request.connection,
				subscription: request.subscription,
			});
			return subscribe(source, observer, options);
		}) as typeof client.subscribe;
		return { client, seen };
	}

	it("resolves the chat endpoint against the client's baseUrl, before and after start", async () => {
		const { client, seen } = baseClient();
		const transport = new SpinetabChatTransport({ client, api: "/api/chat" });
		await transport.sendMessages(sendOptions()).catch(() => undefined);
		expect(seen.length).toBeGreaterThan(0);
		for (const item of seen) {
			expect(item.connection).toEqual({ api: "https://api.test/api/chat" });
		}
		seen.length = 0;
		await transport.sendMessages(sendOptions()).catch(() => undefined);
		expect(seen.map((item) => item.connection)).toContainEqual({
			api: "https://api.test/api/chat",
		});
		client.dispose();
	});

	it("resolves a relative resume source against the client's baseUrl", async () => {
		const { client, seen } = baseClient();
		const transport = new SpinetabChatTransport({
			client,
			api: "/api/chat",
			resume: { api: (chatId) => `/api/resume/${chatId}` },
		});
		await transport
			.reconnectToStream({ chatId: "chat-1" })
			.catch(() => undefined);
		const resume = seen.find(
			(item) => (item.subscription as { kind?: string })?.kind === "resume",
		);
		expect(resume?.subscription).toMatchObject({
			url: "https://api.test/api/resume/chat-1",
		});
		expect(resume?.connection).toEqual({ api: "https://api.test/api/chat" });
		client.dispose();
	});

	// the fixed sentence names the base the transport actually uses.
	it("an unresolvable relative endpoint fails invalid-endpoint naming the client's base", async () => {
		// No document and no location: a relative endpoint has no base at all.
		const { transport } = setup({ api: "/api/chat" });
		await expect(transport.sendMessages(sendOptions())).rejects.toMatchObject({
			code: "invalid-endpoint",
			message:
				"api must be an absolute URL or resolvable against the client's base.",
			detail: { path: "api" },
		});
	});
});
