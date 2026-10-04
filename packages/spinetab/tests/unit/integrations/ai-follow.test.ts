import type { UIMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import { SpinetabError } from "../../../src/core/errors.ts";
import type {
	CommandOutcome,
	SpinetabClient,
	SubscriptionObserver,
	SubscriptionStatus,
} from "../../../src/core/types.ts";
import {
	type AiObserveEvent,
	SpinetabChatTransport,
} from "../../../src/integrations/ai-sdk/index.ts";
import type {
	AiCommandPayload,
	AiCommandResult,
	AiSubscriptionSpec,
} from "../../../src/integrations/ai-sdk/shared.ts";

// This fake delivers inline and settles commands on microtasks, exposing follow/stop races.

const API = "https://chat.example/api/chat";
const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

function controlled() {
	const observers: Array<{
		observer: SubscriptionObserver<AiObserveEvent>;
		closed: boolean;
	}> = [];
	const generations: Array<SubscriptionObserver<unknown>> = [];
	const commands: AiCommandPayload[] = [];
	const client = {
		scope: "",
		subscribe(
			request: { subscription: AiSubscriptionSpec },
			observer: SubscriptionObserver<unknown>,
		) {
			if (request.subscription.kind === "observe") {
				const entry = {
					observer: observer as SubscriptionObserver<AiObserveEvent>,
					closed: false,
				};
				observers.push(entry);
				return {
					id: "observe",
					unsubscribe() {
						entry.closed = true;
					},
				};
			}
			generations.push(observer);
			return { id: "generation", unsubscribe() {} };
		},
		async command(request: {
			payload: AiCommandPayload;
		}): Promise<CommandOutcome<AiCommandResult>> {
			commands.push(request.payload);
			return {
				status: "acknowledged",
				value: { status: 200, generationId: request.payload.generationId },
			};
		},
	};
	const transport = new SpinetabChatTransport({
		client: client as unknown as SpinetabClient,
		api: API,
		resume: false,
		stop: { api: (chatId, id) => `${API}/${chatId}/stop?g=${id}` },
	});
	const live = () => {
		const entry = observers.find((candidate) => !candidate.closed);
		if (!entry) throw new Error("no observe registration");
		return entry.observer;
	};
	return {
		client,
		transport,
		commands,
		observers,
		generations,
		/** Another tab starts generation `id` (position 0). */
		begin: (id: string) =>
			live().next(
				{
					type: "chunks",
					generationId: id,
					index: 0,
					chunks: [{ type: "start", messageId: id }],
				},
				{ seq: 0 },
			),
		lose: () =>
			live().error?.({ code: "interrupted", message: "controlled loss" }),
		status: (status: SubscriptionStatus) => live().status?.(status),
	};
}

const sendOptions = (headers?: Record<string, string> | Headers) => ({
	trigger: "submit-message" as const,
	chatId: "chat-1",
	messageId: undefined,
	messages: [
		{ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
	] as UIMessage[],
	abortSignal: undefined,
	...(headers ? { headers } : {}),
});

describe("SpinetabChatTransport.follow", () => {
	it("follow observes the chat and resumes once when another tab starts a generation", async () => {
		const { transport, begin, observers } = controlled();
		const resumes: number[] = [];
		const stop = transport.follow("chat-1", () => resumes.push(1));
		expect(observers).toHaveLength(1);
		begin("g1");
		await flush();
		expect(resumes).toHaveLength(1);
		stop();
		expect(observers[0]?.closed).toBe(true);
		stop();
	});

	it("an actual loss of a followed stream resumes once per episode; a bare status never does", async () => {
		const { transport, begin, lose, status } = controlled();
		const resumes: string[] = [];
		transport.follow("chat-1", () => resumes.push("resume"));
		begin("g1");
		await flush();
		expect(resumes).toHaveLength(1);
		const stream = await transport.reconnectToStream({ chatId: "chat-1" });
		const reader = stream?.getReader();
		await reader?.read();
		// Bare hints: connection-only and reconciled statuses are not loss.
		status({
			active: true,
			connection: { state: "connected", since: 2 },
			continuity: { state: "continuous", reason: "reconciled", since: 2 },
		});
		await flush();
		expect(resumes).toHaveLength(1);
		lose();
		await reader?.read().catch(() => {});
		await vi.waitFor(() => expect(resumes).toHaveLength(2));
		await flush();
		expect(resumes).toHaveLength(2);
	});

	it("follow is suppressed after stop() until a new start", async () => {
		const { transport, begin, lose } = controlled();
		const resumes: number[] = [];
		transport.follow("chat-1", () => resumes.push(1));
		begin("g1");
		await flush();
		const stream = await transport.reconnectToStream({ chatId: "chat-1" });
		const reader = stream?.getReader();
		await reader?.read();
		await transport.stop("chat-1");
		lose();
		await reader?.read().catch(() => {});
		await flush();
		expect(resumes).toHaveLength(1);
	});

	it("concurrent triggers coalesce into one resume per follower", async () => {
		const { transport, begin } = controlled();
		const first: number[] = [];
		const second: number[] = [];
		transport.follow("chat-1", () => first.push(1));
		transport.follow("chat-1", () => second.push(1));
		begin("g1");
		begin("g2");
		await flush();
		expect(first).toHaveLength(1);
		expect(second).toHaveLength(1);
	});

	it("the disposer ends the callbacks: nothing fires after it", async () => {
		const { transport, begin, observers } = controlled();
		const resumes: number[] = [];
		const stop = transport.follow("chat-1", () => resumes.push(1));
		const other = transport.observe("chat-1");
		stop();
		begin("g1");
		await flush();
		expect(resumes).toHaveLength(0);
		// Another registration keeps the shared observe subscription open.
		expect(observers[0]?.closed).toBe(false);
		other();
		expect(observers[0]?.closed).toBe(true);
	});

	it("a throwing resume callback is reported, not thrown into the client", async () => {
		const { transport, begin } = controlled();
		const reported: unknown[] = [];
		const original = globalThis.reportError;
		globalThis.reportError = (error: unknown) => reported.push(error);
		try {
			transport.follow("chat-1", () => {
				throw new Error("boom");
			});
			expect(() => begin("g1")).not.toThrow();
			await flush();
			expect(reported).toHaveLength(1);
		} finally {
			globalThis.reportError = original;
		}
	});

	it("follow validates its arguments", () => {
		const { transport } = controlled();
		expect(() =>
			transport.follow("chat-1", "resume" as unknown as () => void),
		).toThrow(SpinetabError);
	});
});

describe("SpinetabChatTransport page headers", () => {
	it("static headers that name a credential throw at construction, naming the credentials provider", () => {
		const { client } = controlled();
		for (const name of [
			"Authorization",
			"cookie",
			"x-api-key",
			"Last-Event-ID",
		]) {
			let caught: unknown;
			try {
				new SpinetabChatTransport({
					client: client as unknown as SpinetabClient,
					api: API,
					headers: { [name]: "x" },
				});
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(SpinetabError);
			expect(caught).toMatchObject({
				code: "unsupported-option",
				detail: { path: `options.headers.${name}` },
			});
			expect((caught as Error).message).toMatch(/credentials provider/);
		}
	});

	it("resolved and per-request headers that name a credential reject before any command", async () => {
		const resolved = controlled();
		const transport = new SpinetabChatTransport({
			client: resolved.client as unknown as SpinetabClient,
			api: API,
			headers: async () => ({ "X-Auth-Token": "x" }),
		});
		await expect(transport.sendMessages(sendOptions())).rejects.toMatchObject({
			code: "unsupported-option",
			detail: { path: "options.headers.X-Auth-Token" },
		});
		const perRequest = controlled();
		await expect(
			perRequest.transport.sendMessages(
				sendOptions(new Headers({ authorization: "Bearer x" })),
			),
		).rejects.toMatchObject({
			code: "unsupported-option",
			detail: { path: "headers.authorization" },
		});
		expect(resolved.commands).toHaveLength(0);
		expect(perRequest.commands).toHaveLength(0);
		// Ordinary headers still travel.
		await perRequest.transport.sendMessages(sendOptions({ "x-client": "web" }));
		expect(perRequest.commands[0]?.headers).toEqual({ "x-client": "web" });
	});
});
