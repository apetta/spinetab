import type { UIMessage, UIMessageChunk } from "ai";
import { describe, expect, it } from "vitest";
import { isSpinetabError } from "../../../src/core/errors.ts";
import type {
	CommandOutcome,
	SerialisedError,
	SpinetabClient,
	SubscriptionObserver,
	SubscriptionStatus,
} from "../../../src/core/types.ts";
import { SpinetabChatTransport } from "../../../src/integrations/ai-sdk/index.ts";
import type {
	AiCommandPayload,
	AiCommandResult,
	AiObserveEvent,
	AiSubscriptionSpec,
} from "../../../src/integrations/ai-sdk/shared.ts";

// UNIT-AI-09: a principal change must not let anything
// held for the previous scope reach the page: completed but unread follower
// queues, reads already waiting, and requests whose preparation was awaiting.
// A controlled client plays the core: it can change `scope` silently or emit
// the signals the real client sends (`unknown/scope-changed` status, or a
// `scope-changed` error for registrations it ends).

const API = "https://chat.example/api/chat";
const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

interface Registration {
	spec: AiSubscriptionSpec;
	// biome-ignore lint/suspicious/noExplicitAny: observe and stream events differ.
	observer: SubscriptionObserver<any>;
	closed: boolean;
}

function controlledClient(scope = "alice") {
	const registrations: Registration[] = [];
	const commands: AiCommandPayload[] = [];
	let hold: Promise<void> | undefined;
	const client = {
		scope,
		subscribe(
			request: { subscription: AiSubscriptionSpec },
			// biome-ignore lint/suspicious/noExplicitAny: see Registration.
			observer: SubscriptionObserver<any>,
		) {
			const entry = { spec: request.subscription, observer, closed: false };
			registrations.push(entry);
			return {
				id: `s${registrations.length}`,
				unsubscribe() {
					entry.closed = true;
				},
			};
		},
		async command(request: {
			payload: AiCommandPayload;
		}): Promise<CommandOutcome<AiCommandResult>> {
			commands.push(request.payload);
			await hold;
			return {
				status: "acknowledged",
				value: { status: 200, generationId: request.payload.generationId },
			};
		},
	};
	const find = (kind: AiSubscriptionSpec["kind"]) => {
		const found = registrations.filter((entry) => entry.spec.kind === kind);
		const last = found.at(-1);
		if (!last) throw new Error(`no ${kind} registration`);
		return last;
	};
	return {
		client,
		spinetab: client as unknown as SpinetabClient,
		registrations,
		commands,
		find,
		/** Hold the next command's outcome until the returned release is called. */
		holdCommands() {
			let release!: () => void;
			hold = new Promise((resolve) => {
				release = resolve;
			});
			return release;
		},
	};
}

const scopeChangedStatus: SubscriptionStatus = {
	active: true,
	connection: { state: "connected", since: 0 },
	continuity: { state: "unknown", reason: "scope-changed", since: 0 },
};
const scopeChangedError: SerialisedError = {
	code: "scope-changed",
	message: "The client changed scope.",
};

const generation: UIMessageChunk[] = [
	{ type: "start", messageId: "alice-generation" },
	{ type: "text-start", id: "t" },
	{ type: "text-delta", id: "t", delta: "alice-only-test-data" },
	{ type: "text-end", id: "t" },
	{ type: "finish" },
];

/** Feeds a complete generation into the chat's observe registration, unclaimed. */
function observeCompleteGeneration(observer: Registration["observer"]) {
	const events: AiObserveEvent[] = [
		{
			type: "chunks",
			generationId: "alice-generation",
			index: 0,
			chunks: generation.slice(0, 2),
		},
		{
			type: "chunks",
			generationId: "alice-generation",
			index: 2,
			chunks: generation.slice(2),
		},
		{ type: "end", generationId: "alice-generation", outcome: "complete" },
	];
	for (const event of events) observer.next(event, { seq: 0 });
}

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

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("completed but unread follower queues (UNIT-AI-09)", () => {
	it("control: in the same scope the completed queue is claimable in full", async () => {
		const { spinetab, find } = controlledClient();
		const transport = new SpinetabChatTransport({
			client: spinetab,
			api: API,
			resume: false,
		});
		transport.observe("chat-1");
		observeCompleteGeneration(find("observe").observer);
		const stream = await transport.reconnectToStream({ chatId: "chat-1" });
		expect(await drain(stream)).toEqual(generation);
	});

	it.each([
		["the core's scope-changed error", "error"],
		["the core's unknown/scope-changed status", "status"],
		["no signal at all (scope read lazily)", "none"],
	] as const)("is discarded on a principal change signalled by %s", async (_label, signal) => {
		const { client, spinetab, find } = controlledClient();
		const transport = new SpinetabChatTransport({
			client: spinetab,
			api: API,
			resume: false,
		});
		const dispose = transport.observe("chat-1");
		const observe = find("observe");
		observeCompleteGeneration(observe.observer);
		expect(transport.role("chat-1")).toBe("follower");
		client.scope = "bob";
		if (signal === "error") observe.observer.error?.(scopeChangedError);
		if (signal === "status") observe.observer.status?.(scopeChangedStatus);
		const stream = await transport.reconnectToStream({ chatId: "chat-1" });
		expect(stream).toBeNull();
		expect(await drain(stream)).toEqual([]);
		expect(transport.role("chat-1")).toBeUndefined();
		// The previous principal's observe registration and callbacks are ended.
		expect(observe.closed).toBe(true);
		dispose();
	});

	it("is discarded when the scope changes and returns to the same string", async () => {
		const { client, spinetab, find } = controlledClient();
		const transport = new SpinetabChatTransport({
			client: spinetab,
			api: API,
			resume: false,
		});
		transport.observe("chat-1");
		const observe = find("observe");
		observeCompleteGeneration(observe.observer);
		client.scope = "bob";
		observe.observer.status?.(scopeChangedStatus);
		client.scope = "alice";
		expect(await transport.reconnectToStream({ chatId: "chat-1" })).toBeNull();
	});

	it("fences old observe callbacks and old registrations' later events", async () => {
		const { client, spinetab, find } = controlledClient();
		const transport = new SpinetabChatTransport({
			client: spinetab,
			api: API,
			resume: false,
		});
		const starts: string[] = [];
		transport.observe("chat-1", {
			onStart: ({ generationId }) => starts.push(generationId),
		});
		const observe = find("observe");
		client.scope = "bob";
		// Delivered by the old registration after the change (no signal yet).
		observeCompleteGeneration(observe.observer);
		await flush();
		expect(starts).toEqual([]);
		expect(await transport.reconnectToStream({ chatId: "chat-1" })).toBeNull();
		// Observing again under the new scope works normally.
		transport.observe("chat-1", {
			onStart: ({ generationId }) => starts.push(`bob:${generationId}`),
		});
		const fresh = find("observe");
		expect(fresh).not.toBe(observe);
		observeCompleteGeneration(fresh.observer);
		await flush();
		expect(starts).toEqual(["bob:alice-generation"]);
	});
});

describe("reads waiting across a principal change (UNIT-AI-09)", () => {
	it.each([
		"status",
		"lookup",
	] as const)("a waiting read errors scope-changed (%s) and never sees later chunks", async (signal) => {
		const { client, spinetab, find } = controlledClient();
		const interrupted: string[] = [];
		const transport = new SpinetabChatTransport({
			client: spinetab,
			api: API,
			onInterrupted: (chatId) => interrupted.push(chatId),
		});
		const stream = await transport.sendMessages(sendOptions());
		const live = find("generation");
		live.observer.next(generation.slice(0, 2), { seq: 1 });
		const reader = stream.getReader();
		expect((await reader.read()).value).toEqual(generation[0]);
		expect((await reader.read()).value).toEqual(generation[1]);
		const waiting = reader.read().catch((error: unknown) => error);
		await flush();
		client.scope = "bob";
		if (signal === "status") live.observer.status?.(scopeChangedStatus);
		// Any transport call under the new scope retires the old state.
		else transport.role("chat-1");
		live.observer.next(generation.slice(2), { seq: 2 });
		const failure = await waiting;
		expect(isSpinetabError(failure, "scope-changed")).toBe(true);
		expect(live.closed).toBe(true);
		expect(interrupted).toEqual([]);
	});

	it("a claimed follower stream waiting for chunks errors on the scope-changed status", async () => {
		const { client, spinetab, find } = controlledClient();
		const transport = new SpinetabChatTransport({
			client: spinetab,
			api: API,
			resume: false,
		});
		transport.observe("chat-1");
		const observe = find("observe");
		observe.observer.next(
			{
				type: "chunks",
				generationId: "g",
				index: 0,
				chunks: generation.slice(0, 1),
			} satisfies AiObserveEvent,
			{ seq: 1 },
		);
		const stream = await transport.reconnectToStream({ chatId: "chat-1" });
		if (!stream) throw new Error("expected the follower queue");
		const reader = stream.getReader();
		expect((await reader.read()).value).toEqual(generation[0]);
		const waiting = reader.read().catch((error: unknown) => error);
		client.scope = "bob";
		observe.observer.status?.(scopeChangedStatus);
		expect(isSpinetabError(await waiting, "scope-changed")).toBe(true);
	});

	it("a completed stream already handed out stops delivering held chunks", async () => {
		const { client, spinetab, find } = controlledClient();
		const transport = new SpinetabChatTransport({ client: spinetab, api: API });
		const stream = await transport.sendMessages(sendOptions());
		const live = find("generation");
		live.observer.next(generation, { seq: 1 });
		live.observer.complete?.();
		client.scope = "bob";
		const reader = stream.getReader();
		const failure = await reader.read().catch((error: unknown) => error);
		expect(isSpinetabError(failure, "scope-changed")).toBe(true);
	});
});

describe("request preparation across a principal change (UNIT-AI-09)", () => {
	it("sendMessages: headers resolved after the change send nothing", async () => {
		const { client, spinetab, registrations, commands } = controlledClient();
		const headers = deferred<Record<string, string>>();
		const transport = new SpinetabChatTransport({
			client: spinetab,
			api: API,
			headers: () => headers.promise,
		});
		const sending = transport
			.sendMessages(sendOptions())
			.catch((error: unknown) => error);
		client.scope = "bob";
		headers.resolve({ "x-tenant": "alice" });
		expect(isSpinetabError(await sending, "scope-changed")).toBe(true);
		expect(commands).toEqual([]);
		expect(registrations).toEqual([]);
	});

	it("sendMessages: a body resolved after the change sends nothing", async () => {
		const { client, spinetab, registrations, commands } = controlledClient();
		const body = deferred<object>();
		const transport = new SpinetabChatTransport({
			client: spinetab,
			api: API,
			body: () => body.promise,
		});
		const sending = transport
			.sendMessages(sendOptions())
			.catch((error: unknown) => error);
		await flush();
		client.scope = "bob";
		body.resolve({ user: "alice" });
		expect(isSpinetabError(await sending, "scope-changed")).toBe(true);
		expect(commands).toEqual([]);
		expect(registrations).toEqual([]);
	});

	it("sendMessages: a start acknowledged after the change returns no stream", async () => {
		const { client, spinetab, find, holdCommands } = controlledClient();
		const transport = new SpinetabChatTransport({ client: spinetab, api: API });
		const release = holdCommands();
		const sending = transport
			.sendMessages(sendOptions())
			.catch((error: unknown) => error);
		await flush();
		const live = find("generation");
		client.scope = "bob";
		live.observer.status?.(scopeChangedStatus);
		release();
		expect(isSpinetabError(await sending, "scope-changed")).toBe(true);
		expect(live.closed).toBe(true);
	});

	it("reconnectToStream: preparation resolved after the change opens no resume", async () => {
		const { client, spinetab, registrations } = controlledClient();
		const headers = deferred<Record<string, string>>();
		const transport = new SpinetabChatTransport({
			client: spinetab,
			api: API,
			headers: () => headers.promise,
		});
		const resuming = transport
			.reconnectToStream({ chatId: "chat-1" })
			.catch((error: unknown) => error);
		client.scope = "bob";
		headers.resolve({ "x-tenant": "alice" });
		expect(isSpinetabError(await resuming, "scope-changed")).toBe(true);
		expect(registrations).toEqual([]);
	});

	it("reconnectToStream: a resume answered after the change is not returned", async () => {
		const { client, spinetab, find } = controlledClient();
		const transport = new SpinetabChatTransport({ client: spinetab, api: API });
		const resuming = transport
			.reconnectToStream({ chatId: "chat-1" })
			.catch((error: unknown) => error);
		await flush();
		const resume = find("resume");
		client.scope = "bob";
		resume.observer.next(generation, { seq: 1 });
		expect(isSpinetabError(await resuming, "scope-changed")).toBe(true);
		expect(resume.closed).toBe(true);
	});

	it("stop: preparation resolved after the change sends no stop", async () => {
		const { client, spinetab, commands } = controlledClient();
		let headers:
			| ReturnType<typeof deferred<Record<string, string>>>
			| undefined;
		const transport = new SpinetabChatTransport({
			client: spinetab,
			api: API,
			stop: { api: (chatId, id) => `${API}/${chatId}/stop?g=${id}` },
			headers: () => {
				if (!headers) return {};
				return headers.promise;
			},
		});
		await transport.sendMessages(sendOptions());
		expect(commands.map((payload) => payload.type)).toEqual(["start"]);
		headers = deferred();
		const stopping = transport.stop("chat-1").catch((error: unknown) => error);
		client.scope = "bob";
		headers.resolve({ "x-tenant": "alice" });
		expect(isSpinetabError(await stopping, "scope-changed")).toBe(true);
		expect(commands.map((payload) => payload.type)).toEqual(["start"]);
	});
});
