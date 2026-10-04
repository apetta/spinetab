import type { UIMessageChunk } from "ai";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AdapterConnection } from "../../../src/core/adapter.ts";
import { aiSdkAdapter } from "../../../src/integrations/ai-sdk/runtime.ts";
import type {
	AiCommandPayload,
	AiCommandResult,
	AiObserveEvent,
	AiSubscriptionSpec,
} from "../../../src/integrations/ai-sdk/shared.ts";
import { scriptChunks } from "../../fixtures/servers/ai.ts";
import {
	type RunningFixtures,
	startFixtures,
} from "../../fixtures/servers/start.ts";
import {
	fakeContext,
	fixture,
	recordingSink,
	waitFor,
} from "./helpers/fake-context.ts";

// INT-AI-01…07: the worker-side adapter driven through `connect()` with a fake
// ConnectionContext against the real scripted AI SDK backend. A dedicated
// fixture instance keeps counters and faults isolated from other slices'
// concurrent `/__fixture/reset` calls.

// Events are batches of chunks (generation, resume) or observe events; the
// recording sinks accept either and flatten batches.
type Connection = AdapterConnection<
	AiSubscriptionSpec,
	unknown,
	AiCommandPayload,
	AiCommandResult
>;

let running: RunningFixtures;
let origin: string;
let server: Awaited<ReturnType<typeof fixture>>;
let counter = 0;
const id = (prefix: string) => `${prefix}-${++counter}-${Date.now()}`;

beforeAll(async () => {
	running = await startFixtures([0]);
	origin = running.apps[0]?.origin ?? "";
	server = await fixture(origin);
});
afterAll(() => running.close());
beforeEach(() => server.reset());

function connect(
	options: Parameters<typeof fakeContext>[0] = {},
	adapterOptions: Parameters<typeof aiSdkAdapter>[0] = {},
) {
	const adapter = aiSdkAdapter(adapterOptions);
	const context = fakeContext(options);
	const spec = { api: `${origin}/ai/chat` };
	adapter.validateConnection?.(spec);
	const connection = adapter.connect(spec, context.ctx) as Connection;
	return { adapter, connection, context };
}

const startPayload = (
	chatId: string,
	generationId: string,
	extra: Record<string, unknown> = {},
	headers?: Record<string, string>,
): AiCommandPayload => ({
	type: "start",
	chatId,
	generationId,
	body: JSON.stringify({ id: chatId, messages: [], generationId, ...extra }),
	...(headers ? { headers } : {}),
});

const commandOptions = {
	id: "cmd",
	signal: new AbortController().signal,
	timeoutMs: 30_000,
};

describe("aiSdkAdapter", () => {
	it("validates specs and keys resume requests by url and nonce only", () => {
		const adapter = aiSdkAdapter();
		expect(() =>
			adapter.validateConnection?.({ api: "/relative" }),
		).toThrowError(expect.objectContaining({ code: "invalid-endpoint" }));
		expect(() =>
			adapter.validateConnection?.({ api: "https://u:p@example.com/chat" }),
		).toThrowError(expect.objectContaining({ code: "invalid-endpoint" }));
		expect(() =>
			adapter.validateSubscription?.({ kind: "generation", chatId: "c" }),
		).toThrowError(expect.objectContaining({ code: "unsupported-option" }));
		expect(() =>
			adapter.validateSubscription?.({ kind: "observe", chatId: "c", x: 1 }),
		).toThrowError(expect.objectContaining({ code: "unsupported-option" }));
		const a = adapter.subscriptionKey?.({
			kind: "resume",
			url: "https://e.test/s",
			nonce: "n",
			headers: { a: "1" },
		});
		const b = adapter.subscriptionKey?.({
			kind: "resume",
			url: "https://e.test/s",
			nonce: "n",
			headers: { a: "2" },
		});
		expect(a).toBe(b);
		expect(
			adapter.repeatable?.({
				kind: "generation",
				chatId: "c",
				generationId: "g",
			}),
		).toBe(false);
		expect(adapter.repeatable?.({ kind: "observe", chatId: "c" })).toBe(true);
	});

	it("INT-AI-01 starts once and fans out every chunk family unmodified", async () => {
		const { connection } = connect();
		const chatId = id("chat");
		const generationId = id("gen");
		const sink = recordingSink<UIMessageChunk>();
		connection.subscribe({ kind: "generation", chatId, generationId }, sink, {
			key: "k",
			repeatable: false,
		});
		const outcome = await connection.command?.(
			startPayload(chatId, generationId, { script: "all", size: 3 }),
			commandOptions,
		);
		expect(outcome).toEqual({
			status: "acknowledged",
			value: { status: 200, generationId },
		});
		await sink.done;
		expect(sink.errors).toEqual([]);
		expect(sink.completed).toBe(1);
		expect(sink.startedAt).toBe(0);
		// The wire script is the source of truth; [DONE] is not a chunk.
		expect(sink.events).toEqual(scriptChunks("all", generationId, 3));
		const types = new Set<string>(sink.events.map((chunk) => chunk.type));
		for (const family of [
			"start",
			"start-step",
			"reasoning-delta",
			"text-delta",
			"tool-input-delta",
			"tool-input-available",
			"tool-output-available",
			"tool-input-error",
			"tool-output-error",
			"tool-approval-request",
			"tool-output-denied",
			"data-weather",
			"data-notice",
			"source-url",
			"source-document",
			"file",
			"message-metadata",
			"finish-step",
			"finish",
		]) {
			expect(types.has(family)).toBe(true);
		}
		const counters = await server.counters();
		expect(counters.generations).toBe(1);
		expect(counters.generationIds).toEqual([generationId]);
		connection.dispose();
	});

	it("INT-AI-02 merges credential headers with static headers (static headers never carry credentials)", async () => {
		const { connection, context } = connect({
			credentials: () => ({ headers: { authorization: "Bearer valid-a-1" } }),
		});
		const chatId = id("chat");
		const generationId = id("gen");
		const refused = await connection.command?.(
			startPayload(
				chatId,
				generationId,
				{ requireAuth: true },
				{ authorization: "Bearer static-refused" },
			),
			commandOptions,
		);
		expect(refused).toMatchObject({
			status: "not-sent",
			error: {
				code: "unsupported-option",
				detail: { path: "payload.headers.authorization" },
			},
		});
		const outcome = await connection.command?.(
			startPayload(
				chatId,
				generationId,
				{ requireAuth: true },
				{ "x-fixture-custom": "static" },
			),
			commandOptions,
		);
		expect(outcome?.status).toBe("acknowledged");
		const counters = await server.counters();
		expect(counters.startHeaders).toEqual([
			{ authorization: "Bearer valid-a-1", custom: "static" },
		]);
		expect(context.credentialRequests).toBe(1);
		connection.dispose();
	});

	it("INT-AI-02 proceeds without a credential source but never sends on a credential timeout", async () => {
		const noSource = connect();
		const ok = await noSource.connection.command?.(
			startPayload(id("chat"), id("gen")),
			commandOptions,
		);
		expect(ok?.status).toBe("acknowledged");
		noSource.connection.dispose();

		const timedOut = connect({
			credentialError: { code: "credentials-timeout", message: "timeout" },
		});
		const outcome = await timedOut.connection.command?.(
			startPayload(id("chat"), id("gen")),
			commandOptions,
		);
		expect(outcome).toMatchObject({
			status: "not-sent",
			error: { code: "credentials-timeout" },
		});
		expect((await server.counters()).generations).toBe(1);
		timedOut.connection.dispose();
	});

	it("a failed credentials provider sends nothing, exactly as a credentials timeout", async () => {
		for (const code of ["credentials-timeout", "credentials-failed"] as const) {
			const { connection } = connect({
				credentialError: { code, message: "The credentials provider failed." },
			});
			const chatId = id("chat");
			const generationId = id("gen");
			const start = await connection.command?.(
				startPayload(chatId, generationId),
				commandOptions,
			);
			expect(start).toMatchObject({ status: "not-sent", error: { code } });
			const stop = await connection.command?.(
				{
					type: "stop",
					chatId,
					generationId,
					url: `${origin}/ai/chat/${chatId}/stop`,
				},
				commandOptions,
			);
			expect(stop).toMatchObject({ status: "not-sent", error: { code } });
			const resumed = recordingSink<UIMessageChunk>();
			connection.subscribe(
				{
					kind: "resume",
					url: `${origin}/ai/chat/${chatId}/stream`,
					nonce: "n",
				},
				resumed,
				{ key: "r", repeatable: false },
			);
			await resumed.done;
			expect(resumed.events).toEqual([]);
			expect(resumed.errors).toMatchObject([{ code }]);
			connection.dispose();
		}
		const counters = await server.counters();
		expect(counters.generations).toBe(0);
		expect(counters.stops).toBe(0);
		expect(counters.resumeStatuses).toEqual([]);
	});

	it("INT-AI-02 reports a rejected start with status details and rejects the credential", async () => {
		const { connection, context } = connect({
			credentials: () => ({ headers: { authorization: "Bearer revoked-a-1" } }),
		});
		const outcome = await connection.command?.(
			startPayload(id("chat"), id("gen"), { requireAuth: true }),
			commandOptions,
		);
		// the status only, never the upstream body.
		expect(outcome).toMatchObject({
			status: "rejected",
			error: {
				code: "upstream-error",
				message: "Failed to fetch the chat response. (HTTP 401)",
				detail: { status: 401 },
			},
		});
		expect(JSON.stringify(outcome)).not.toContain("Unauthorised");
		expect(context.rejected).toBe(1);
		const failing = await connection.command?.(
			startPayload(id("chat"), id("gen"), { status: 500 }),
			commandOptions,
		);
		expect(failing).toMatchObject({
			status: "rejected",
			error: {
				message: "Failed to fetch the chat response. (HTTP 500)",
				detail: { status: 500 },
			},
		});
		expect(JSON.stringify(failing)).not.toContain("Scripted failure");
		connection.dispose();
	});

	it("INT-AI-01 rejects a second start with the same generation id without a request", async () => {
		const { connection } = connect();
		const chatId = id("chat");
		const generationId = id("gen");
		const first = await connection.command?.(
			startPayload(chatId, generationId),
			commandOptions,
		);
		const second = await connection.command?.(
			startPayload(chatId, generationId),
			commandOptions,
		);
		expect(first?.status).toBe("acknowledged");
		expect(second).toMatchObject({
			status: "rejected",
			error: { code: "command-rejected" },
		});
		expect((await server.counters()).generations).toBe(1);
		connection.dispose();
	});

	it("INT-AI-01 reports a start that failed before a response as unknown and never resends it", async () => {
		const adapter = aiSdkAdapter();
		const { ctx } = fakeContext();
		const connection = adapter.connect(
			{ api: "http://127.0.0.1:9/ai/chat" },
			ctx,
		) as Connection;
		const outcome = await connection.command?.(
			startPayload("c", "g"),
			commandOptions,
		);
		expect(outcome).toMatchObject({
			status: "unknown",
			error: { code: "command-unknown" },
		});
		connection.dispose();
	});

	it("INT-AI-03 resume replays from the start, then 204 after completion", async () => {
		const { connection } = connect();
		const chatId = id("chat");
		const generationId = id("gen");
		const live = recordingSink<UIMessageChunk>();
		connection.subscribe({ kind: "generation", chatId, generationId }, live, {
			key: "g",
			repeatable: false,
		});
		await connection.command?.(
			startPayload(chatId, generationId, { size: 12, delayMs: 15 }),
			commandOptions,
		);
		await waitFor(() => live.events.length >= 4);
		const resumed = recordingSink<UIMessageChunk>();
		connection.subscribe(
			{
				kind: "resume",
				url: `${origin}/ai/chat/${chatId}/stream`,
				nonce: "n1",
			},
			resumed,
			{ key: "r", repeatable: false },
		);
		await Promise.all([live.done, resumed.done]);
		expect(resumed.errors).toEqual([]);
		expect(resumed.events).toEqual(live.events);
		expect(resumed.startedAt).toBe(0);

		const after = recordingSink<UIMessageChunk>();
		connection.subscribe(
			{
				kind: "resume",
				url: `${origin}/ai/chat/${chatId}/stream`,
				nonce: "n2",
			},
			after,
			{ key: "r2", repeatable: false },
		);
		await after.done;
		expect(after.events).toEqual([]);
		expect(after.completed).toBe(1);
		expect(after.errors).toEqual([]);
		const counters = await server.counters();
		expect(counters.resumeStatuses).toEqual([200, 204]);
		expect(counters.generations).toBe(1);
		connection.dispose();
	});

	it("INT-AI-03 rejects a resume stream that does not begin with start", async () => {
		const { connection } = connect();
		const chatId = id("chat");
		await connection.command?.(
			startPayload(chatId, id("gen"), { size: 20, delayMs: 20 }),
			commandOptions,
		);
		await new Promise((resolve) => setTimeout(resolve, 60));
		const resumed = recordingSink<UIMessageChunk>();
		connection.subscribe(
			{
				kind: "resume",
				url: `${origin}/ai/chat/${chatId}/stream?skip=2`,
				nonce: "n",
			},
			resumed,
			{ key: "r", repeatable: false },
		);
		await resumed.done;
		expect(resumed.events).toEqual([]);
		expect(resumed.errors).toEqual([
			expect.objectContaining({
				code: "cannot-resume",
				detail: { reason: "invalid-resume-stream" },
			}),
		]);
		expect((await server.counters()).generations).toBe(1);
		connection.dispose();
	});

	it("INT-AI-04 detach keeps the generation for observers; the last departure releases it after idleCloseMs, never a stop", async () => {
		const { connection } = connect({ limits: { idleCloseMs: 80 } });
		const chatId = id("chat");
		const generationId = id("gen");
		const observer = recordingSink<AiObserveEvent>();
		const observe = connection.subscribe(
			{ kind: "observe", chatId },
			observer,
			{ key: "o", repeatable: true },
		);
		const live = recordingSink<UIMessageChunk>();
		const generation = connection.subscribe(
			{ kind: "generation", chatId, generationId },
			live,
			{ key: "g", repeatable: false },
		);
		await connection.command?.(
			startPayload(chatId, generationId, { size: 200, delayMs: 10 }),
			commandOptions,
		);
		await waitFor(() => live.events.length >= 3);
		generation.unsubscribe();
		const seen = observer.events.length;
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(observer.events.length).toBeGreaterThan(seen);
		expect((await server.counters()).active).toBe(1);

		observe.unsubscribe();
		// Within the grace the response stays open.
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect((await server.counters()).active).toBe(1);
		await waitFor(async () => (await server.counters()).active === 0);
		const counters = await server.counters();
		expect(counters.stops).toBe(0);
		expect(counters.clientDisconnects).toBe(1);
		connection.dispose();
	});

	it("INT-AI-05 stop is one identified command; observers see the backend abort", async () => {
		const { connection } = connect();
		const chatId = id("chat");
		const generationId = id("gen");
		const live = recordingSink<UIMessageChunk>();
		connection.subscribe({ kind: "generation", chatId, generationId }, live, {
			key: "g",
			repeatable: false,
		});
		await connection.command?.(
			startPayload(chatId, generationId, { size: 200, delayMs: 10 }),
			commandOptions,
		);
		await waitFor(() => live.events.length >= 3);
		const outcome = await connection.command?.(
			{
				type: "stop",
				chatId,
				generationId,
				url: `${origin}/ai/chat/${chatId}/stop`,
			},
			commandOptions,
		);
		expect(outcome).toEqual({
			status: "acknowledged",
			value: { status: 200, generationId },
		});
		await live.done;
		expect(live.events.at(-1)).toEqual({ type: "abort", reason: "stopped" });
		const counters = await server.counters();
		expect(counters.stops).toBe(1);
		expect(counters.stopRequests).toEqual([{ chatId, generationId }]);

		const unreachable = await connection.command?.(
			{ type: "stop", chatId, generationId, url: "http://127.0.0.1:9/stop" },
			commandOptions,
		);
		expect(unreachable).toMatchObject({
			status: "unknown",
			error: { code: "command-unknown" },
		});
		connection.dispose();
	});

	it("INT-AI-06 an upstream drop interrupts observers; an error chunk is delivered as a chunk", async () => {
		const { connection } = connect();
		await server.fault("abort", 3);
		const chatId = id("chat");
		const generationId = id("gen");
		const live = recordingSink<UIMessageChunk>();
		const observer = recordingSink<AiObserveEvent>();
		connection.subscribe({ kind: "observe", chatId }, observer, {
			key: "o",
			repeatable: true,
		});
		connection.subscribe({ kind: "generation", chatId, generationId }, live, {
			key: "g",
			repeatable: false,
		});
		await connection.command?.(
			startPayload(chatId, generationId, { size: 20 }),
			commandOptions,
		);
		await live.done;
		expect(live.events).toHaveLength(3);
		expect(live.errors).toEqual([
			expect.objectContaining({ code: "interrupted" }),
		]);
		await waitFor(() => observer.events.some((event) => event.type === "end"));
		expect(observer.events.at(-1)).toMatchObject({
			type: "end",
			generationId,
			outcome: "interrupted",
		});
		await server.fault("abort", false);

		await server.fault("error-chunk", 2);
		const errored = recordingSink<UIMessageChunk>();
		const second = id("gen");
		connection.subscribe(
			{ kind: "generation", chatId, generationId: second },
			errored,
			{ key: "g2", repeatable: false },
		);
		await connection.command?.(
			startPayload(chatId, second, { size: 3 }),
			commandOptions,
		);
		await errored.done;
		expect(errored.events[2]).toEqual({
			type: "error",
			errorText: "Scripted upstream error",
		});
		expect(errored.completed).toBe(1);
		connection.dispose();
	});

	it("INT-AI-07 keeps generations of one chat separate and shares observation only with an echoed id", async () => {
		const { connection } = connect();
		const chatId = id("chat");
		const observer = recordingSink<AiObserveEvent>();
		connection.subscribe({ kind: "observe", chatId }, observer, {
			key: "o",
			repeatable: true,
		});
		const first = id("gen");
		const second = id("gen");
		const a = recordingSink<UIMessageChunk>();
		const b = recordingSink<UIMessageChunk>();
		connection.subscribe(
			{ kind: "generation", chatId, generationId: first },
			a,
			{
				key: "a",
				repeatable: false,
			},
		);
		await connection.command?.(startPayload(chatId, first), commandOptions);
		await a.done;
		connection.subscribe(
			{ kind: "generation", chatId, generationId: second },
			b,
			{
				key: "b",
				repeatable: false,
			},
		);
		await connection.command?.(
			startPayload(chatId, second, { echo: false }),
			commandOptions,
		);
		await b.done;
		expect(a.events[0]).toEqual({ type: "start", messageId: first });
		expect(b.events[0]).toEqual({
			type: "start",
			messageId: `server-${second}`,
		});
		const observed = new Set(
			observer.events.map((event) => event.generationId),
		);
		expect([...observed]).toEqual([first]);
		// Observed batches carry the first chunk's position; together they are
		// the whole generation from position 0, in order.
		const observedChunks = observer.events.flatMap((event) =>
			event.type === "chunks" ? event.chunks : [],
		);
		const positions = observer.events.flatMap((event) =>
			event.type === "chunks"
				? event.chunks.map((_, offset) => event.index + offset)
				: [],
		);
		expect(observedChunks).toEqual(a.events);
		expect(positions).toEqual(a.events.map((_, index) => index));
		expect((await server.counters()).generations).toBe(2);
		connection.dispose();
	});
});
