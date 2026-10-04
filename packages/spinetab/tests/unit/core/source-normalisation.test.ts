import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	adapterNotRegistered,
	isSpinetabError,
} from "../../../src/core/errors.ts";
import {
	createRuntime,
	type Runtime,
	setWorkerOriginForTests,
} from "../../../src/core/runtime.ts";
import { toObserver, toRequest } from "../../../src/core/source.ts";
import type {
	ConnectionStatus,
	EventMeta,
	SubscriptionStatus,
} from "../../../src/core/types.ts";
import { graphqlSse } from "../../../src/protocols/graphql-sse/index.ts";
import { graphqlWs } from "../../../src/protocols/graphql-ws/index.ts";
import { socketIo } from "../../../src/protocols/socket-io/index.ts";
import { polling } from "../../../src/transports/polling/index.ts";
import { pollingAdapter } from "../../../src/transports/polling/runtime.ts";
import { sse } from "../../../src/transports/sse/index.ts";
import { stream } from "../../../src/transports/stream/index.ts";
import { disposeAll, feed, makeClient, observe } from "./helpers/client.ts";
import { ManualClock, settle } from "./helpers/clock.ts";
import { RawPage } from "./helpers/page.ts";
import { createTestAdapter } from "./helpers/test-adapter.ts";
import { FakeWorkerHost } from "./helpers/worker.ts";

const runtimes: Runtime[] = [];
// provider credentials reach only the worker's own origin (or a
// listed one). The Node harness has no origin, so the tests declare one.
beforeEach(() => setWorkerOriginForTests("https://api.test"));
afterEach(() => {
	disposeAll();
	vi.unstubAllGlobals();
	setWorkerOriginForTests(undefined);
	for (const runtime of runtimes.splice(0)) runtime.dispose();
});

/** Polling schedules with real timers: let them run, then settle the clock. */
async function realWait(clock: ManualClock, ms = 30): Promise<void> {
	for (let i = 0; i < 3; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, ms));
		await settle(clock);
	}
}

function caught(run: () => unknown): unknown {
	try {
		run();
	} catch (error) {
		return error;
	}
	throw new Error("expected a synchronous throw");
}

describe("verify with real builders", () => {
	it("a URL-first polling feed and the options form's request share one connection", async () => {
		const clock = new ManualClock();
		const host = new FakeWorkerHost(clock, { test: { kind: "polling" } });
		const { client } = makeClient({}, { host, clock });
		const a = observe();
		const b = observe();
		const c = observe();
		client.subscribe(polling("/api/queue"), a.observer);
		client.subscribe(polling({ url: "/api/queue" }).subscription(), b.observer);
		// Inline rebuild: a new feed object each time, one identity.
		client.subscribe(polling("/api/queue"), c.observer);
		await settle(clock);
		expect(host.test.connections).toHaveLength(1);
		expect(host.test.connections[0]?.subscriptions).toHaveLength(1);
		expect(host.test.last().consumers.size).toBe(3);
		// Relative URL still resolved by the client at subscribe (CR:76).
		expect(host.test.connections[0]?.spec).toMatchObject({
			url: "https://app.test/api/queue",
		});
		host.test.last().emit({ open: 1 });
		await settle(clock);
		expect(a.log.events).toEqual([{ open: 1 }]);
		expect(b.log.events).toEqual([{ open: 1 }]);
		expect(c.log.events).toEqual([{ open: 1 }]);
	});

	it("sse and stream feeds give the same request as their .subscription()", () => {
		const s = sse("/api/ticks");
		expect(toRequest(s, "source")).toStrictEqual(s.subscription());
		expect(toRequest(sse("/api/ticks"), "source")).toStrictEqual(
			sse({ url: "/api/ticks" }).subscription(),
		);
		const st = stream("/api/orders", { repeatable: true });
		expect(toRequest(st, "source")).toStrictEqual(st.subscription());
	});

	it.each([
		["graphqlWs", () => graphqlWs("wss://api.test/graphql")],
		["graphqlSse", () => graphqlSse("https://api.test/graphql/stream")],
		[
			"socketIo",
			() => socketIo("https://api.test/chat", { sharing: "shared" }),
		],
	])("a %s endpoint as a source fails synchronously with unsupported-option naming a path, before anything registers", async (_name, build) => {
		const { client, host, clock } = makeClient();
		const endpoint = build();
		const error = caught(() =>
			client.subscribe(endpoint as never, observe().observer),
		);
		expect(isSpinetabError(error, "unsupported-option")).toBe(true);
		expect(typeof (error as { detail?: { path?: unknown } }).detail?.path).toBe(
			"string",
		);
		await settle(clock);
		expect(host.test.all()).toHaveLength(0);
	});

	it("an existing class-based observer keeps its `this`", async () => {
		const { client, host, clock } = makeClient();
		class Collector {
			events: unknown[] = [];
			statuses: SubscriptionStatus[] = [];
			next(event: unknown) {
				this.events.push(event);
			}
			status(status: SubscriptionStatus) {
				this.statuses.push(status);
			}
		}
		const collector = new Collector();
		expect(toObserver(collector, "observer")).toBe(collector);
		client.subscribe(feed(), collector);
		await settle(clock);
		host.test.last().emit({ n: 1 });
		await settle(clock);
		expect(collector.events).toEqual([{ n: 1 }]);
		expect(collector.statuses.length).toBeGreaterThan(0);
	});

	it("a function observer on a server client is inert and does not throw", () => {
		const { client } = makeClient({}, { env: { isBrowser: () => false } });
		const next = vi.fn<(event: unknown, meta: EventMeta) => void>();
		const sub = client.subscribe(polling("https://api.test/q"), next);
		expect(typeof sub.unsubscribe).toBe("function");
		sub.unsubscribe();
		expect(next).not.toHaveBeenCalled();
	});
});

describe("verify the named factory exists in the named entry", () => {
	const hint = (kind: string, factory: string, entry: string) =>
		`Adapter ${kind} is not registered. List "${kind}" in the plugin's adapters option, or add ${factory}() from spinetab/${entry}/runtime to your worker file.`;

	it.each([
		["polling", "../../../src/transports/polling/runtime.ts"],
		["sse", "../../../src/transports/sse/runtime.ts"],
		["stream", "../../../src/transports/stream/runtime.ts"],
		["websocket", "../../../src/transports/websocket/runtime.ts"],
		["graphql-ws", "../../../src/protocols/graphql-ws/runtime.ts"],
		["graphql-sse", "../../../src/protocols/graphql-sse/runtime.ts"],
		["socket-io", "../../../src/protocols/socket-io/runtime.ts"],
		["trpc-ws", "../../../src/integrations/trpc/runtime.ts"],
		["trpc-sse", "../../../src/integrations/trpc/runtime.ts"],
		["ai-sdk", "../../../src/integrations/ai-sdk/runtime.ts"],
	])("%s", async (kind, path) => {
		const message = adapterNotRegistered(kind).message;
		const match = /add (\w+)\(\) from spinetab\/([\w-]+)\/runtime /.exec(
			message,
		);
		expect(match).not.toBeNull();
		const [, factory, entry] = match as unknown as [string, string, string];
		expect(message).toBe(hint(kind, factory, entry));
		// The entry named is the source module mapped to spinetab/<entry>/runtime.
		expect(path).toContain(`/${entry}/runtime.ts`);
		const mod = (await import(path)) as Record<string, unknown>;
		expect(typeof mod[factory]).toBe("function");
		// The adapter that factory builds really has this kind.
		const built = (mod[factory] as (options?: unknown) => { kind: string })(
			kind === "websocket" ? { protocols: {} } : undefined,
		);
		expect(built.kind).toBe(kind);
	});
});

describe("verify final adapter names (the create* names are gone)", () => {
	it.each([
		["polling", "pollingAdapter", "createPollingAdapter"],
		["sse", "sseAdapter", "createSseAdapter"],
		["stream", "streamAdapter", "createStreamAdapter"],
		["websocket", "websocketAdapter", "createWebSocketAdapter"],
	])("%s", async (entry, alias, original) => {
		const mod = (await import(
			`../../../src/transports/${entry}/runtime.ts`
		)) as Record<string, unknown>;
		expect(typeof mod[alias]).toBe("function");
		expect(mod[original]).toBeUndefined();
	});
});

describe("verify end to end", () => {
	const failureOf = async (
		provider: NonNullable<Parameters<typeof makeClient>[0]>["credentials"],
	) => {
		const { client, host, clock } = makeClient({ credentials: provider });
		client.subscribe(feed(), observe().observer);
		await settle(clock);
		const result = host.test.connections[0]?.ctx
			.credentials("connect")
			.catch((caught: unknown) => caught);
		await settle(clock);
		return result;
	};

	it.each([
		["a string", () => "token"],
		["an array", () => []],
		["undefined", () => undefined],
		["a number", () => 42],
		["a resolved null", async () => null],
	])("a provider returning %s gives credentials-failed", async (_label, fn) => {
		expect(await failureOf(fn as never)).toMatchObject({
			code: "credentials-failed",
		});
	});

	it("a provider rejecting with a no-credential-source error cannot turn into anonymity", async () => {
		const spoof = Object.assign(new Error("none"), {
			name: "SpinetabError",
			code: "no-credential-source",
		});
		expect(
			await failureOf(() => {
				throw spoof;
			}),
		).toMatchObject({ code: "credentials-failed" });
	});

	it("a failing tab with a provider plus a tab without one gives credentials-failed", async () => {
		const clock = new ManualClock();
		const host = new FakeWorkerHost(clock);
		const failing = makeClient(
			{
				credentials: () => {
					throw new Error("no session");
				},
			},
			{ host, clock },
		);
		const plain = makeClient({}, { host, clock });
		failing.client.subscribe(feed(), observe().observer);
		plain.client.subscribe(feed(), observe().observer);
		await settle(clock);
		expect(host.test.connections).toHaveLength(1);
		const result = host.test.connections[0]?.ctx
			.credentials("connect")
			.catch((caught: unknown) => caught);
		await settle(clock);
		expect(await result).toMatchObject({ code: "credentials-failed" });
	});

	it("a failing tab and a working tab give the working tab's credentials", async () => {
		const clock = new ManualClock();
		const host = new FakeWorkerHost(clock);
		const failing = makeClient(
			{
				credentials: () => {
					throw new Error("no session");
				},
			},
			{ host, clock },
		);
		const working = makeClient(
			{ credentials: () => ({ headers: { authorization: "Bearer ok" } }) },
			{ host, clock },
		);
		working.client.subscribe(feed(), observe().observer);
		failing.client.subscribe(feed(), observe().observer);
		await settle(clock);
		const result = host.test.connections[0]?.ctx.credentials("connect");
		await settle(clock);
		await expect(result).resolves.toEqual({
			headers: { authorization: "Bearer ok" },
		});
	});

	it("in local mode a throwing provider gives credentials-failed", async () => {
		const clock = new ManualClock();
		const host = new FakeWorkerHost(clock);
		host.mode = "construct-throws";
		const harness = makeClient(
			{
				credentials: () => {
					throw new Error("no session");
				},
			},
			{ host, clock },
		);
		harness.client.subscribe(feed(), observe().observer);
		await settle(clock);
		const connection = harness.local.test.connections[0];
		expect(connection).toBeDefined();
		const result = connection?.ctx
			.credentials("connect")
			.catch((caught: unknown) => caught);
		await settle(clock);
		expect(await result).toMatchObject({ code: "credentials-failed" });
	});

	it("real polling never reads anonymously when the provider throws", async () => {
		const clock = new ManualClock();
		const fetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ open: 1 }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		const host = new FakeWorkerHost(clock, {
			adapters: () => [pollingAdapter({ fetch })],
		});
		const { client } = makeClient(
			{
				credentials: () => {
					throw new Error("token endpoint down");
				},
			},
			{ host, clock },
		);
		const statuses: ConnectionStatus[] = [];
		const events: unknown[] = [];
		client.subscribe(polling("https://api.test/queue"), {
			next: (event) => events.push(event),
			status: (status) => statuses.push(status.connection),
		});
		await realWait(clock);
		expect(fetch).not.toHaveBeenCalled();
		expect(events).toEqual([]);
		expect(statuses.at(-1)).toMatchObject({
			state: "auth-blocked",
			reason: "credentials-missing",
		});
	});

	it("control: real polling reads anonymously when no page has a provider", async () => {
		const clock = new ManualClock();
		const fetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ open: 1 }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		const host = new FakeWorkerHost(clock, {
			adapters: () => [pollingAdapter({ fetch })],
		});
		const { client } = makeClient({}, { host, clock });
		client.subscribe(polling("https://api.test/queue"), () => {});
		await realWait(clock);
		expect(fetch).toHaveBeenCalled();
	});
});

// Invalid requests and adapter registration are checked at the page boundary.
describe("request validation and adapter registration", () => {
	function setup() {
		const clock = new ManualClock();
		const test = createTestAdapter();
		const runtime = createRuntime({
			adapters: [test.adapter],
			clock,
			credentialOrigins: ["https://x.test"],
		});
		runtimes.push(runtime);
		return { clock, test, runtime };
	}
	async function tab(
		runtime: Runtime,
		clock: ManualClock,
		fields: Record<string, unknown> = {},
	) {
		const raw = new RawPage(runtime);
		raw.hello({ credentials: true, scope: "s", ...fields });
		await settle(clock);
		return raw;
	}
	async function connect(
		raw: RawPage,
		clock: ManualClock,
		test: ReturnType<typeof createTestAdapter>,
	) {
		raw.subscribe("c-1", { connection: { url: "https://x.test/a" } });
		await settle(clock);
		const found = test.connections[0];
		if (!found) throw new Error("no connection");
		return found.ctx;
	}
	function track(promise: Promise<unknown>) {
		const state: { value?: unknown; error?: unknown; done: boolean } = {
			done: false,
		};
		promise.then(
			(value) => Object.assign(state, { value, done: true }),
			(error) => Object.assign(state, { error, done: true }),
		);
		return state;
	}
	const reply = (
		raw: RawPage,
		index: number,
		fields: Record<string, unknown>,
	) => {
		const request = raw.ofType("credentialsRequest")[index];
		if (!request) throw new Error(`no credentials request ${index}`);
		raw.send({ t: "credentials", id: request.id, ...fields });
	};

	it("a no-credential-source reply from a tab that declared a provider counts as a provider failure", async () => {
		const { clock, test, runtime } = setup();
		const raw = await tab(runtime, clock);
		const ctx = await connect(raw, clock, test);
		const result = track(ctx.credentials("connect"));
		await settle(clock);
		reply(raw, 0, {
			ok: false,
			error: {
				code: "no-credential-source",
				message: "No credentials provider.",
			},
			revision: null,
		});
		await settle(clock);
		expect(result.done).toBe(true);
		expect((result.error as { code?: string }).code).toBe("credentials-failed");
	});

	it("an explicit provider failure is not masked by the cached grant", async () => {
		const { clock, test, runtime } = setup();
		const raw = await tab(runtime, clock, { revision: 1 });
		const ctx = await connect(raw, clock, test);
		const first = track(ctx.credentials("connect"));
		await settle(clock);
		reply(raw, 0, {
			ok: true,
			credentials: { auth: { token: "t1" } },
			revision: 1,
		});
		await settle(clock);
		expect(first.value).toEqual({ auth: { token: "t1" } });
		const again = track(ctx.credentials("rotated"));
		await settle(clock);
		reply(raw, 1, {
			ok: false,
			error: {
				code: "credentials-failed",
				message: "The credentials provider failed.",
			},
			revision: 1,
		});
		await settle(clock);
		expect(again.done).toBe(true);
		expect((again.error as { code?: string } | undefined)?.code).toBe(
			"credentials-failed",
		);
	});

	it("(kept): when every asked tab timed out, the cached grant is still reused", async () => {
		const { clock, test, runtime } = setup();
		const raw = await tab(runtime, clock, { revision: 1 });
		const ctx = await connect(raw, clock, test);
		const first = track(ctx.credentials("connect"));
		await settle(clock);
		reply(raw, 0, {
			ok: true,
			credentials: { auth: { token: "t1" } },
			revision: 1,
		});
		await settle(clock);
		expect(first.value).toEqual({ auth: { token: "t1" } });
		const again = track(ctx.credentials("rotated"));
		await settle(clock);
		clock.advance(5_000);
		await settle(clock);
		expect(again.value).toEqual({ auth: { token: "t1" } });
	});

	it("(broker): a reply older than the scope's revision is asked once more, never no-credential-source", async () => {
		const { clock, test, runtime } = setup();
		const raw = await tab(runtime, clock, { revision: 1 });
		const ctx = await connect(raw, clock, test);
		const result = track(ctx.credentials("connect"));
		await settle(clock);
		raw.send({ t: "revision", revision: 2, restart: false });
		await settle(clock);
		reply(raw, 0, {
			ok: true,
			credentials: { auth: { token: "old" } },
			revision: 1,
		});
		await settle(clock);
		const asked = raw.ofType("credentialsRequest").length;
		const code = (result.error as { code?: string } | undefined)?.code;
		expect({ asked, code }).toEqual({ asked: 2, code: undefined });
	});

	it("(page): the reply carries the revision captured when the provider was called", async () => {
		let resolve: (value: unknown) => void = () => {};
		const provider = vi.fn(
			() =>
				new Promise((done) => {
					resolve = done;
				}),
		);
		const { client, host, clock } = makeClient({
			credentialRevision: 1,
			credentials: provider as never,
		});
		client.subscribe(feed(), observe().observer);
		await settle(clock);
		const replies: Array<{ revision?: unknown }> = [];
		for (const relay of host.relays) {
			relay.drop = (data, toRuntime) => {
				if (toRuntime && (data as { t?: string }).t === "credentials") {
					replies.push(data as { revision?: unknown });
				}
				return false;
			};
		}
		void host.test.connections[0]?.ctx.credentials("connect").catch(() => {});
		await settle(clock);
		expect(provider).toHaveBeenCalledTimes(1);
		expect(provider.mock.calls[0]).toMatchObject([{ revision: 1 }]);
		client.setCredentialRevision(2);
		await settle(clock);
		resolve({ headers: { authorization: "Bearer for-revision-1" } });
		await settle(clock);
		expect(replies).toHaveLength(1);
		expect(replies[0]?.revision).toBe(1);
	});
});
