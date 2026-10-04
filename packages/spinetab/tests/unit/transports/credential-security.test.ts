import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isSpinetabError } from "../../../src/core/errors.ts";
import { setWorkerOriginForTests } from "../../../src/core/runtime.ts";
import type { ConnectionStatus, Credentials } from "../../../src/core/types.ts";
import { polling } from "../../../src/transports/polling/index.ts";
import { pollingAdapter } from "../../../src/transports/polling/runtime.ts";
import { sse } from "../../../src/transports/sse/index.ts";
import { sseAdapter } from "../../../src/transports/sse/runtime.ts";
import { stream } from "../../../src/transports/stream/index.ts";
import { streamAdapter } from "../../../src/transports/stream/runtime.ts";
import { websocket } from "../../../src/transports/websocket/index.ts";
import {
	type WebSocketProtocol,
	websocketAdapter,
} from "../../../src/transports/websocket/runtime.ts";
import { disposeAll, makeClient } from "../core/helpers/client.ts";
import { ManualClock, settle } from "../core/helpers/clock.ts";
import { FakeWorkerHost } from "../core/helpers/worker.ts";
import {
	eventStream,
	FakeWebSocket,
	fakeContext,
	flush,
	recordingSink,
	type ScriptedRequest,
	SUBSCRIBE_OPTIONS,
	scriptedBody,
	scriptedFetch,
} from "./helpers.ts";

const APP = "https://app.test";

const bearer = (): Promise<Credentials> =>
	Promise.resolve({ headers: { authorization: "Bearer t" } });

function caught(run: () => unknown): unknown {
	try {
		run();
	} catch (error) {
		return error;
	}
	return undefined;
}

describe("verify origin judgement (fake context)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubGlobal("location", { origin: APP });
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	function poll(url: string, options: Record<string, unknown> = {}) {
		const fake = fakeContext();
		fake.setCredentials(bearer);
		const script = scriptedFetch([
			() => new Response('{"ok":true}', { status: 200 }),
		]);
		const adapter = pollingAdapter({ fetch: script.fetch as typeof fetch });
		const connection = adapter.connect(
			polling(url, options).connection,
			fake.ctx,
		);
		const handle = connection.subscribe({}, recordingSink().sink, {
			key: "poll",
			repeatable: true,
		});
		handle.consumerAdded?.("a", { intervalMs: 1_000 }, { visible: true });
		return { fake, requests: script.requests };
	}

	for (const [name, url] of [
		["userinfo pointing elsewhere", "https://app.test@evil.test/x"],
		[
			"a longer host with the app host as prefix",
			"https://app.test.evil.test/x",
		],
		["another scheme on the same host", "http://app.test/x"],
		["another port on the same host", "https://app.test:8443/x"],
	] as const) {
		it(`auto never asks or merges for ${name}`, async () => {
			const { fake, requests } = poll(url);
			await vi.advanceTimersByTimeAsync(0);
			expect(fake.credentialCalls).toEqual([]);
			expect(requests[0]?.headers.get("authorization")).toBeNull();
			expect(requests[0]?.init.redirect).toBeUndefined();
		});
	}

	it("auto treats the default port as the same origin", async () => {
		const { fake, requests } = poll("https://app.test:443/x");
		await vi.advanceTimersByTimeAsync(0);
		expect(fake.credentialCalls).toHaveLength(1);
		expect(requests[0]?.headers.get("authorization")).toBe("Bearer t");
		expect(requests[0]?.init.redirect).toBe("manual");
	});

	it('auto never merges when the worker origin is opaque ("null")', async () => {
		vi.stubGlobal("location", { origin: "null" });
		const { fake, requests } = poll("https://app.test/x");
		await vi.advanceTimersByTimeAsync(0);
		expect(fake.credentialCalls).toEqual([]);
		expect(requests[0]?.headers.get("authorization")).toBeNull();
	});

	it("the origin is read at call time, not at adapter creation", async () => {
		vi.stubGlobal("location", { origin: "https://elsewhere.test" });
		const { fake, requests } = poll("https://app.test/x");
		vi.stubGlobal("location", { origin: APP });
		await vi.advanceTimersByTimeAsync(0);
		expect(fake.credentialCalls).toHaveLength(1);
		expect(requests[0]?.headers.get("authorization")).toBe("Bearer t");
	});

	it("true with a grant that has no headers blocks and sends nothing", async () => {
		const fake = fakeContext();
		fake.setCredentials(() => Promise.resolve({ connectionParams: { a: 1 } }));
		const script = scriptedFetch([() => new Response("{}")]);
		const adapter = pollingAdapter({ fetch: script.fetch as typeof fetch });
		const connection = adapter.connect(
			polling("https://other.test/x", { authHeaders: true }).connection,
			fake.ctx,
		);
		connection
			.subscribe({}, recordingSink().sink, { key: "p", repeatable: true })
			.consumerAdded?.("a", { intervalMs: 1_000 }, { visible: true });
		await vi.advanceTimersByTimeAsync(0);
		expect(script.requests).toEqual([]);
		expect(fake.last()).toMatchObject({
			state: "auth-blocked",
			reason: "credentials-missing",
		});
	});

	it("no downgrade survives an explicit retry (fetch stream)", async () => {
		const fake = fakeContext();
		let calls = 0;
		fake.setCredentials(() => {
			calls += 1;
			return calls === 1 ? bearer() : Promise.resolve({});
		});
		const responders = [
			(request: ScriptedRequest) =>
				eventStream(
					scriptedBody(),
					{ headers: { "content-type": "application/x-ndjson" } },
					request.init.signal ?? undefined,
				),
		];
		const script = scriptedFetch(responders);
		vi.stubGlobal("fetch", script.fetch);
		const spec = stream(`${APP}/s`, { repeatable: true }).connection;
		const connection = streamAdapter().connect(spec, fake.ctx);
		connection.subscribe({}, recordingSink().sink, SUBSCRIBE_OPTIONS);
		await vi.advanceTimersByTimeAsync(0);
		expect(script.requests).toHaveLength(1);
		connection.retry?.();
		await vi.advanceTimersByTimeAsync(0);
		// The stream was open, so retry is a no-op; force a loss via probe.
		connection.probe?.();
		await vi.advanceTimersByTimeAsync(0);
		expect(script.requests).toHaveLength(1);
		expect(fake.last()).toMatchObject({
			state: "auth-blocked",
			reason: "credentials-missing",
		});
		connection.retry?.();
		await vi.advanceTimersByTimeAsync(0);
		expect(script.requests).toHaveLength(1);
	});
});

describe("verify on fetch-mode SSE (fake context)", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		vi.stubGlobal("location", { origin: "https://api.test" });
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("a resume-query request is judged with the URL that carries the cursor", async () => {
		const fake = fakeContext();
		fake.setCredentials(bearer);
		const script = scriptedFetch([
			(request) =>
				eventStream(scriptedBody(), {}, request.init.signal ?? undefined),
		]);
		vi.stubGlobal("fetch", script.fetch);
		const spec = sse("https://api.test/sse", {
			resume: { query: "from" },
		}).connection;
		const connection = sseAdapter().connect(spec, fake.ctx);
		connection.subscribe({}, recordingSink().sink, {
			...SUBSCRIBE_OPTIONS,
			cursor: "c9",
		} as never);
		await flush(20);
		expect(script.requests[0]?.url).toBe(fake.credentialUrls[0]);
		expect(script.requests[0]?.init.redirect).toBe("manual");
	});

	it("an opaque redirect (status 0) on an SSE request with provider headers fails redirect and is not retried", async () => {
		const fake = fakeContext();
		fake.setCredentials(bearer);
		const opaque = () => {
			const response = new Response(null, { status: 200 });
			Object.defineProperty(response, "status", { value: 0 });
			return response;
		};
		const script = scriptedFetch([opaque]);
		vi.stubGlobal("fetch", script.fetch);
		const spec = sse("https://api.test/sse").connection;
		sseAdapter()
			.connect(spec, fake.ctx)
			.subscribe({}, recordingSink().sink, SUBSCRIBE_OPTIONS);
		await flush(20);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(script.requests).toHaveLength(1);
		expect(fake.last()).toMatchObject({
			state: "failed",
			reason: "permanent-error",
			code: "redirect",
		});
	});

	it("a 401 body never reaches a status, an error or a diagnostic (non-repeatable stream)", async () => {
		const fake = fakeContext();
		fake.setCredentials(bearer);
		const script = scriptedFetch([
			() => new Response("upstream-secret-text", { status: 401 }),
		]);
		vi.stubGlobal("fetch", script.fetch);
		const spec = stream("https://api.test/s", {
			method: "POST",
			body: "x",
		}).connection;
		const sink = recordingSink();
		streamAdapter()
			.connect(spec, fake.ctx)
			.subscribe({}, sink.sink, { key: "s", repeatable: false });
		await flush(20);
		const everything = JSON.stringify([
			fake.statuses,
			fake.diagnostics,
			sink.errors,
		]);
		expect(everything).not.toContain("upstream-secret-text");
		expect(fake.last()).toMatchObject({ code: "http:401" });
		expect(fake.rejections()).toBe(1);
	});

	it("a throwing resumeUrls hook fails with the fixed sentence, never the hook's text", async () => {
		const fake = fakeContext();
		const script = scriptedFetch([]);
		vi.stubGlobal("fetch", script.fetch);
		const spec = sse("https://api.test/sse", {
			resume: { url: "h" },
		}).connection;
		const sink = recordingSink();
		sseAdapter({
			resumeUrls: {
				h: () => {
					throw new Error("hook-secret-text");
				},
			},
		})
			.connect(spec, fake.ctx)
			.subscribe({}, sink.sink, {
				...SUBSCRIBE_OPTIONS,
				cursor: "c1",
			} as never);
		await flush(20);
		expect(script.requests).toEqual([]);
		expect(JSON.stringify(sink.errors)).not.toContain("hook-secret-text");
		expect(sink.errors[0]?.code).toBe("unsupported-option");
	});

	for (const [name, target] of [
		["a protocol-relative URL", "//evil.test/sse"],
		["another scheme on the same host", "http://api.test/sse"],
		["a lookalike host", "https://api.test.evil.test/sse"],
	] as const) {
		it(`a hook returning ${name} fails and sends nothing`, async () => {
			const fake = fakeContext();
			fake.setCredentials(bearer);
			const script = scriptedFetch([]);
			vi.stubGlobal("fetch", script.fetch);
			const spec = sse("https://api.test/sse", {
				resume: { url: "h" },
			}).connection;
			sseAdapter({ resumeUrls: { h: () => target } })
				.connect(spec, fake.ctx)
				.subscribe({}, recordingSink().sink, {
					...SUBSCRIBE_OPTIONS,
					cursor: "c1",
				} as never);
			await flush(20);
			expect(script.requests).toEqual([]);
			expect(fake.credentialCalls).toEqual([]);
			expect(fake.last()).toMatchObject({
				state: "failed",
				code: "unsupported-option",
			});
		});
	}
});

describe("verify and no downgrade on the raw WebSocket transport", () => {
	beforeEach(() => {
		FakeWebSocket.reset();
		vi.stubGlobal("WebSocket", FakeWebSocket);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	// The security review's no-downgrade condition ("once a connection identity
	// has read with provider credentials, losing the provider blocks it") is
	// written for 's HTTP transports; notes decision 4 chose to reconnect a
	// socket that authenticated before without an authentication frame.
	it("no downgrade: a socket that authenticated before never reopens unauthenticated", async () => {
		const protocol: WebSocketProtocol = {
			decode: (raw) => ({ kind: "event", topics: [], event: raw }),
			authenticate: (params) => [JSON.stringify({ type: "auth", ...params })],
			classifyClose: () => "transient",
		};
		const fake = fakeContext();
		let calls = 0;
		fake.setCredentials(async () => {
			calls += 1;
			return calls === 1 ? { connectionParams: { token: "t" } } : {};
		});
		const connection = websocketAdapter({
			protocols: { auth: protocol },
		}).connect({ url: "wss://api.test/ws", protocol: "auth" }, fake.ctx);
		connection.subscribe({}, recordingSink().sink, SUBSCRIBE_OPTIONS);
		await flush();
		FakeWebSocket.last().serverOpen();
		expect(FakeWebSocket.last().sent).toHaveLength(1);
		FakeWebSocket.last().serverClose(1006);
		await vi.advanceTimersByTimeAsync(60_000);
		await flush();
		const reopened = FakeWebSocket.instances.length > 1;
		if (reopened) FakeWebSocket.last().serverOpen();
		// The rule: either no second socket, or it is blocked credentials-missing.
		expect(reopened && FakeWebSocket.last().sent.length === 0).toBe(false);
	});
});

describe("verify carriers in URL query strings", () => {
	const builders = [
		["polling", () => polling("https://api.test/x?access_token=abc")],
		["sse", () => sse("https://api.test/x?access_token=abc")],
		["stream", () => stream("https://api.test/x?access_token=abc")],
		["websocket", () => websocket("wss://api.test/x?access_token=abc")],
	] as const;
	for (const [name, build] of builders) {
		it(`(${name}): a token-named URL query parameter is refused`, () => {
			const error = caught(build);
			expect(isSpinetabError(error, "unsupported-option")).toBe(true);
		});
	}
});

describe("verify escape hatches and identity", () => {
	it("a hand-written SSE request without mode or decoder keys equals the canonical one", () => {
		const adapter = sseAdapter();
		expect(adapter.connectionKey?.({ url: "https://api.test/s" })).toBe(
			adapter.connectionKey?.({
				url: "https://api.test/s",
				mode: "fetch",
				decoder: "json",
			}),
		);
		expect(adapter.connectionKey?.({ url: "https://api.test/s" })).not.toBe(
			adapter.connectionKey?.({ url: "https://api.test/s", decoder: "text" }),
		);
	});

	it("the options-object and URL-first forms keep authHeaders identical", () => {
		for (const value of [true, false] as const) {
			expect(
				polling({ url: "https://api.test/x", authHeaders: value }).connection,
			).toEqual(
				polling("https://api.test/x", { authHeaders: value }).connection,
			);
			expect(
				sse({ url: "https://api.test/x", authHeaders: value }).connection,
			).toEqual(sse("https://api.test/x", { authHeaders: value }).connection);
		}
		expect(polling("https://api.test/x").connection).not.toHaveProperty(
			"authHeaders",
		);
	});

	it("a custom SSE decoder still works and cannot shadow json or text", () => {
		expect(() => sseAdapter({ decoders: { json: (d) => d } })).toThrow(
			/built-in/,
		);
		const adapter = sseAdapter({ decoders: { upper: (d) => d.toUpperCase() } });
		expect(() =>
			adapter.validateConnection?.(
				sse("https://api.test/s", { decoder: "upper" }).connection,
			),
		).not.toThrow();
	});
});

describe("verify through the real runtime", () => {
	const hosts: FakeWorkerHost[] = [];
	afterEach(() => {
		disposeAll();
		for (const host of hosts.splice(0)) host.dispose();
		setWorkerOriginForTests(undefined);
		vi.unstubAllGlobals();
	});

	async function realWait(clock: ManualClock, ms = 30): Promise<void> {
		for (let i = 0; i < 3; i += 1) {
			await new Promise((resolve) => setTimeout(resolve, ms));
			await settle(clock);
		}
	}

	function setup(origin: string, options: Record<string, unknown>) {
		vi.stubGlobal("location", { origin });
		setWorkerOriginForTests(origin);
		const clock = new ManualClock();
		const fetch = vi.fn(
			async (_url: RequestInfo | URL, _init?: RequestInit) =>
				new Response(JSON.stringify({ open: 1 }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		const host = new FakeWorkerHost(clock, {
			adapters: () => [pollingAdapter({ fetch })],
		});
		hosts.push(host);
		const { client } = makeClient(options, { host, clock });
		return { clock, fetch, client };
	}

	it("authHeaders true to an unlisted https origin sends nothing, even with a provider", async () => {
		const { clock, fetch, client } = setup(APP, {
			credentials: () => ({ headers: { authorization: "Bearer t" } }),
		});
		const statuses: ConnectionStatus[] = [];
		const errors: unknown[] = [];
		client.subscribe(polling("https://other.test/x", { authHeaders: true }), {
			next: () => {},
			error: (error) => errors.push(error),
			status: (status) => statuses.push(status.connection),
		});
		await realWait(clock);
		expect(fetch).not.toHaveBeenCalled();
		expect(
			statuses.at(-1)?.reason === "credentials-audience" ||
				errors.some((error) => isSpinetabError(error, "unsupported-option")),
		).toBe(true);
	});

	it("auto on the https own origin with no provider reads without headers", async () => {
		const { clock, fetch, client } = setup(APP, {});
		client.subscribe(polling(`${APP}/x`), () => {});
		await realWait(clock);
		expect(fetch).toHaveBeenCalled();
		const init = fetch.mock.calls[0]?.[1] as RequestInit | undefined;
		expect(new Headers(init?.headers).get("authorization")).toBeNull();
	});

	// table: unset, same-origin URL, no provider → "none" (read without
	// headers). On a plain-http, non-loopback worker origin the runtime's
	// check throws `credentials-audience` before it knows whether any provider
	// exists, and the transport treats that as a permanent block.
	it("auto on a plain-http own origin with no provider reads without headers", async () => {
		const { clock, fetch, client } = setup("http://intranet.test", {});
		const statuses: ConnectionStatus[] = [];
		client.subscribe(polling("http://intranet.test/x"), {
			next: () => {},
			status: (status) => statuses.push(status.connection),
		});
		await realWait(clock);
		expect(statuses.at(-1)?.reason).not.toBe("credentials-audience");
		expect(fetch).toHaveBeenCalled();
	});

	it("control: an anonymous page on a plain-http own origin reads without headers", async () => {
		const { clock, fetch, client } = setup("http://intranet.test", {
			anonymous: true,
		});
		client.subscribe(polling("http://intranet.test/x"), () => {});
		await realWait(clock);
		expect(fetch).toHaveBeenCalled();
	});
});
