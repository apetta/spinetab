import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterConnection } from "../../../src/core/adapter.ts";
import { SpinetabError } from "../../../src/core/errors.ts";
import type { Credentials } from "../../../src/core/types.ts";
import { aiSdkAdapter } from "../../../src/integrations/ai-sdk/runtime.ts";
import type {
	AiCommandPayload,
	AiCommandResult,
	AiSubscriptionSpec,
} from "../../../src/integrations/ai-sdk/shared.ts";
import {
	fakeContext,
	recordingSink,
} from "../../integration/integrations/helpers/fake-context.ts";

type Connection = AdapterConnection<
	AiSubscriptionSpec,
	unknown,
	AiCommandPayload,
	AiCommandResult
>;

const API = "https://chat.example/api/chat";
const STOP = "https://chat.example/api/chat/c1/stop";
const RESUME = "https://chat.example/api/chat/c1/stream";
const SECRET_BODY = "token sk-live-123 is invalid for alice@example.com";
const commandOptions = {
	id: "cmd",
	signal: new AbortController().signal,
	timeoutMs: 30_000,
};

interface Call {
	url: string;
	init: RequestInit;
}

function stubFetch(respond: (call: Call) => Response | Promise<Response>) {
	const calls: Call[] = [];
	vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
		const call = { url: String(url), init };
		calls.push(call);
		return respond(call);
	});
	return calls;
}

function connect(options: Parameters<typeof fakeContext>[0] = {}) {
	const adapter = aiSdkAdapter();
	const context = fakeContext(options);
	adapter.validateConnection?.({ api: API });
	const connection = adapter.connect({ api: API }, context.ctx) as Connection;
	return { adapter, connection, context };
}

const start = (extra: Partial<AiCommandPayload> = {}): AiCommandPayload =>
	({
		type: "start",
		chatId: "c1",
		generationId: `g-${Math.random()}`,
		body: "{}",
		...extra,
	}) as AiCommandPayload;

const stop = (extra: Record<string, unknown> = {}): AiCommandPayload =>
	({
		type: "stop",
		chatId: "c1",
		generationId: "g1",
		url: STOP,
		...extra,
	}) as AiCommandPayload;

const bearer = (): Credentials => ({
	headers: { authorization: "Bearer t-1" },
});

const sse = () =>
	new Response('data: {"type":"start"}\n\ndata: [DONE]\n\n', {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("aiSdkAdapter credentials", () => {
	it("asks for credentials with the URL each request goes to: start, stop and resume", async () => {
		stubFetch(({ init }) =>
			init.method === "GET"
				? new Response(null, { status: 204 })
				: init.body === "{}"
					? sse()
					: new Response("ok"),
		);
		const { connection, context } = connect({ credentials: bearer });
		await connection.command?.(start(), commandOptions);
		await connection.command?.(stop(), commandOptions);
		const sink = recordingSink();
		connection.subscribe(
			{ kind: "resume", url: RESUME, nonce: "shared" },
			sink as never,
			{ key: "k", repeatable: false },
		);
		await sink.done;
		expect(context.credentialCalls).toEqual([
			["connect", API],
			["connect", STOP],
			["connect", RESUME],
		]);
		connection.dispose();
	});

	it("validates the stop URL in the worker: userinfo, relative and non-HTTP URLs send nothing", async () => {
		const calls = stubFetch(() => new Response("ok"));
		const { connection, context } = connect({ credentials: bearer });
		for (const url of [
			"https://user:pass@chat.example/stop",
			"/api/chat/c1/stop",
			"javascript:alert(1)",
		]) {
			const outcome = await connection.command?.(stop({ url }), commandOptions);
			expect(outcome).toMatchObject({
				status: "not-sent",
				error: { code: "invalid-endpoint", detail: { path: "payload.url" } },
			});
		}
		expect(calls).toHaveLength(0);
		expect(context.credentialRequests).toBe(0);
		connection.dispose();
	});

	it("refuses credential header names in worker payloads and resume specs", async () => {
		const calls = stubFetch(() => sse());
		const { adapter, connection } = connect({ credentials: bearer });
		for (const name of [
			"Authorization",
			"proxy-authorization",
			"cookie",
			"x-api-key",
			"X-Auth-Token",
			"last-event-id",
		]) {
			const outcome = await connection.command?.(
				start({ headers: { [name]: "x" } }),
				commandOptions,
			);
			expect(outcome).toMatchObject({
				status: "not-sent",
				error: {
					code: "unsupported-option",
					detail: { path: `payload.headers.${name}` },
				},
			});
			expect((outcome as { error: { message: string } }).error.message).toMatch(
				/credentials provider/,
			);
			const stopped = await connection.command?.(
				stop({ headers: { [name]: "x" } }),
				commandOptions,
			);
			expect(stopped).toMatchObject({
				status: "not-sent",
				error: { code: "unsupported-option" },
			});
			expect(() =>
				adapter.validateSubscription?.({
					kind: "resume",
					url: RESUME,
					nonce: "n",
					headers: { [name]: "x" },
				}),
			).toThrow(SpinetabError);
		}
		expect(calls).toHaveLength(0);
		// Ordinary headers still pass.
		await connection.command?.(
			start({ headers: { "x-client": "web" } }),
			commandOptions,
		);
		expect(calls).toHaveLength(1);
		connection.dispose();
	});

	it("a credentials-audience refusal sends nothing and names its code", async () => {
		const calls = stubFetch(() => sse());
		const { connection } = connect({
			credentialError: {
				code: "credentials-audience",
				message: "not an allowed audience",
			},
		});
		const outcome = await connection.command?.(start(), commandOptions);
		expect(outcome).toMatchObject({
			status: "not-sent",
			error: { code: "credentials-audience" },
		});
		const stopped = await connection.command?.(stop(), commandOptions);
		expect(stopped).toMatchObject({
			status: "not-sent",
			error: { code: "credentials-audience" },
		});
		const sink = recordingSink();
		connection.subscribe(
			{ kind: "resume", url: RESUME, nonce: "shared" },
			sink as never,
			{ key: "k", repeatable: false },
		);
		await sink.done;
		expect(sink.errors[0]?.code).toBe("credentials-audience");
		expect(calls).toHaveLength(0);
		connection.dispose();
	});

	it("requests that carry provider headers refuse redirects; others keep the platform default", async () => {
		const calls = stubFetch(({ init }) =>
			init.method === "GET" ? new Response(null, { status: 204 }) : sse(),
		);
		const withProvider = connect({ credentials: bearer });
		await withProvider.connection.command?.(start(), commandOptions);
		await withProvider.connection.command?.(stop(), commandOptions);
		const sink = recordingSink();
		withProvider.connection.subscribe(
			{ kind: "resume", url: RESUME, nonce: "shared" },
			sink as never,
			{ key: "k", repeatable: false },
		);
		await sink.done;
		// "manual", not "error": never followed, and visible in browsers (fix round).
		expect(calls.map((call) => call.init.redirect)).toEqual([
			"manual",
			"manual",
			"manual",
		]);
		const cookie = connect();
		await cookie.connection.command?.(start(), commandOptions);
		expect(calls[3]?.init).not.toHaveProperty("redirect");
		// A provider that returns no headers attaches nothing either.
		const empty = connect({ credentials: () => ({}) });
		await empty.connection.command?.(start(), commandOptions);
		expect(calls[4]?.init).not.toHaveProperty("redirect");
		withProvider.connection.dispose();
		cookie.connection.dispose();
		empty.connection.dispose();
	});

	it("a refused redirect is a rejected start with reason redirect, never a resend", async () => {
		const calls = stubFetch(() => {
			throw new TypeError("fetch failed", {
				cause: new Error("unexpected redirect"),
			});
		});
		const { connection } = connect({ credentials: bearer });
		const outcome = await connection.command?.(start(), commandOptions);
		expect(outcome).toMatchObject({
			status: "rejected",
			error: { code: "upstream-error", detail: { reason: "redirect" } },
		});
		expect(calls).toHaveLength(1);
		connection.dispose();
	});

	it("an unfollowed redirect answer to a credentialed start, stop or resume is a redirect, never followed or resent", async () => {
		const calls = stubFetch(({ init }) =>
			init.method === "GET"
				? new Response(null, { status: 307 })
				: new Response(null, { status: 302 }),
		);
		const { connection, context } = connect({ credentials: bearer });
		const started = await connection.command?.(start(), commandOptions);
		const stopped = await connection.command?.(stop(), commandOptions);
		const sink = recordingSink();
		connection.subscribe(
			{ kind: "resume", url: RESUME, nonce: "shared" },
			sink as never,
			{ key: "k", repeatable: false },
		);
		await sink.done;
		const redirect = { code: "upstream-error", detail: { reason: "redirect" } };
		expect(started).toMatchObject({ status: "rejected", error: redirect });
		expect(stopped).toMatchObject({ status: "rejected", error: redirect });
		expect(sink.errors[0]).toMatchObject(redirect);
		expect(calls).toHaveLength(3);
		expect(context.rejected).toBe(0);
		connection.dispose();
	});

	it("a 401 rejects exactly the grant that was attached, and only when provider material was attached", async () => {
		stubFetch(() => new Response(SECRET_BODY, { status: 401 }));
		const grant = bearer();
		const withProvider = connect({ credentials: () => grant });
		await withProvider.connection.command?.(start(), commandOptions);
		await withProvider.connection.command?.(stop(), commandOptions);
		expect(withProvider.context.rejectedWith).toEqual([grant, grant]);
		const noHeaders = connect({
			credentials: () => ({ connectionParams: { token: "x" } }),
		});
		await noHeaders.connection.command?.(start(), commandOptions);
		const cookie = connect();
		await cookie.connection.command?.(start(), commandOptions);
		expect(noHeaders.context.rejected).toBe(0);
		expect(cookie.context.rejected).toBe(0);
		withProvider.connection.dispose();
		noHeaders.connection.dispose();
		cookie.connection.dispose();
	});

	it("a resume answered 401 rejects the attached grant", async () => {
		stubFetch(() => new Response(SECRET_BODY, { status: 401 }));
		const grant = bearer();
		const { connection, context } = connect({ credentials: () => grant });
		const sink = recordingSink();
		connection.subscribe(
			{ kind: "resume", url: RESUME, nonce: "shared" },
			sink as never,
			{ key: "k", repeatable: false },
		);
		await sink.done;
		expect(context.rejectedWith).toEqual([grant]);
		connection.dispose();
	});

	it("a 403 rejects nothing and fails the command", async () => {
		stubFetch(() => new Response(SECRET_BODY, { status: 403 }));
		const { connection, context } = connect({ credentials: bearer });
		const outcome = await connection.command?.(start(), commandOptions);
		expect(outcome).toMatchObject({
			status: "rejected",
			error: { code: "upstream-error", detail: { status: 403 } },
		});
		await connection.command?.(stop(), commandOptions);
		expect(context.rejected).toBe(0);
		connection.dispose();
	});

	it("HTTP errors carry detail.status only, never the response body", async () => {
		let cancelled = 0;
		stubFetch(() => {
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(SECRET_BODY));
				},
				cancel() {
					cancelled += 1;
				},
			});
			return new Response(body, { status: 500 });
		});
		const { connection } = connect({ credentials: bearer });
		const outcomes = [
			await connection.command?.(start(), commandOptions),
			await connection.command?.(stop(), commandOptions),
		];
		const sink = recordingSink();
		connection.subscribe(
			{ kind: "resume", url: RESUME, nonce: "shared" },
			sink as never,
			{ key: "k", repeatable: false },
		);
		await sink.done;
		const errors = [
			...outcomes.map(
				(outcome) =>
					(outcome as { error: { message: string; detail: unknown } }).error,
			),
			sink.errors[0],
		];
		for (const error of errors) {
			expect(error).toMatchObject({
				code: "upstream-error",
				detail: { status: 500 },
			});
			expect(error?.detail).toEqual({ status: 500 });
			expect(JSON.stringify(error)).not.toContain("sk-live");
			expect(JSON.stringify(error)).not.toContain("alice");
		}
		expect(cancelled).toBe(3);
		connection.dispose();
	});
});
