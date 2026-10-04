import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterConnection } from "../../../src/core/adapter.ts";
import {
	createRuntime,
	type Runtime,
	setWorkerOriginForTests,
} from "../../../src/core/runtime.ts";
import { trpcSseAdapter } from "../../../src/integrations/trpc/runtime.ts";
import type { TrpcSubscriptionSpec } from "../../../src/integrations/trpc/spec.ts";
import { graphqlSse } from "../../../src/protocols/graphql-sse/index.ts";
import { graphqlSseAdapter } from "../../../src/protocols/graphql-sse/runtime.ts";
import { socketIoAdapter } from "../../../src/protocols/socket-io/runtime.ts";
import {
	createRecordingSink,
	createTestContext,
	waitFor,
} from "../../integration/protocols/helpers.ts";
import { ManualClock, settle } from "../core/helpers/clock.ts";
import { RawPage } from "../core/helpers/page.ts";

const fake = vi.hoisted(() => {
	type Listener = (...args: unknown[]) => void;
	class Emitter {
		readonly handlers = new Map<string, Set<Listener>>();
		on(event: string, listener: Listener): this {
			let set = this.handlers.get(event);
			if (!set) {
				set = new Set();
				this.handlers.set(event, set);
			}
			set.add(listener);
			return this;
		}
		off(event: string, listener: Listener): this {
			this.handlers.get(event)?.delete(listener);
			return this;
		}
		removeAllListeners(): this {
			this.handlers.clear();
			return this;
		}
		fire(event: string, ...args: unknown[]): void {
			for (const listener of [...(this.handlers.get(event) ?? [])]) {
				listener(...args);
			}
		}
	}
	class FakeSocket extends Emitter {
		auth: ((callback: (data: object) => void) => void) | undefined;
		active = false;
		connected = false;
		recovered = false;
		readonly sendBuffer: unknown[] = [];
		connect(): this {
			this.active = true;
			return this;
		}
		disconnect(): this {
			this.active = false;
			this.connected = false;
			return this;
		}
	}
	class FakeManager extends Emitter {
		static readonly instances: FakeManager[] = [];
		readonly nsps = new Map<string, FakeSocket>();
		engine = undefined;
		constructor(readonly uri: string) {
			super();
			FakeManager.instances.push(this);
		}
		// socket.io-client 4.8 `Manager.socket` caches one Socket per namespace.
		socket(nsp: string): FakeSocket {
			let socket = this.nsps.get(nsp);
			if (!socket) {
				socket = new FakeSocket();
				this.nsps.set(nsp, socket);
			}
			return socket;
		}
		open(): this {
			return this;
		}
	}
	return { FakeManager };
});

vi.mock("socket.io-client", () => ({ Manager: fake.FakeManager }));

const runtimes: Runtime[] = [];
const connections: AdapterConnection[] = [];
beforeEach(() => {
	fake.FakeManager.instances.length = 0;
});
afterEach(() => {
	for (const connection of connections.splice(0)) connection.dispose();
	for (const runtime of runtimes.splice(0)) runtime.dispose();
	setWorkerOriginForTests(undefined);
});

describe("anonymous and provider pages in one scope never share a Socket.IO session", () => {
	async function twoPages() {
		setWorkerOriginForTests("https://app.test");
		const clock = new ManualClock();
		const runtime = createRuntime({ adapters: [socketIoAdapter()], clock });
		runtimes.push(runtime);
		const provider = new RawPage(runtime);
		provider.hello({ scope: "s", credentials: true, revision: 1 });
		const anonymous = new RawPage(runtime);
		anonymous.hello({ scope: "s", anonymous: true });
		await settle(clock);
		const request = {
			adapter: "socket-io",
			connection: { url: "https://app.test/chat", sharing: "shared" },
			subscription: { event: "tick" },
		};
		provider.subscribe("p", request);
		await settle(clock);
		const socket = fake.FakeManager.instances[0]?.socket("/chat");
		if (!socket) throw new Error("no namespace socket");
		const handshake = async () => {
			let payload: object | undefined;
			socket.auth?.((data) => {
				payload = data;
			});
			await settle(clock);
			return () => payload;
		};
		// The provider's handshake: asked once, answered with a token.
		const first = await handshake();
		const ask = provider.ofType("credentialsRequest")[0];
		if (!ask) throw new Error("provider was not asked");
		provider.send({
			t: "credentials",
			id: ask.id,
			ok: true,
			credentials: { auth: { token: "t1" } },
			revision: 1,
		});
		await settle(clock);
		expect(first()).toEqual({ token: "t1" });
		socket.connected = true;
		socket.fire("connect");
		await settle(clock);
		anonymous.subscribe("a", request);
		await settle(clock);
		return { clock, provider, anonymous, socket, handshake };
	}

	it("gives the anonymous group its own Manager or namespace socket", async () => {
		const { socket } = await twoPages();
		const sockets = fake.FakeManager.instances.map((m) => m.socket("/chat"));
		// Two groups (distinct connection keys) must not drive one Socket.
		expect(sockets.filter((s) => s === socket)).toHaveLength(1);
		expect(fake.FakeManager.instances.length).toBeGreaterThanOrEqual(2);
	});

	it("never re-handshakes the provider's session without its credentials (no downgrade)", async () => {
		const { provider, handshake, socket } = await twoPages();
		// The shared socket drops, then reconnects: socket.io-client asks for
		// `auth` again only after `onclose` (the answer is fenced).
		socket.connected = false;
		socket.fire("disconnect", "transport close");
		const next = await handshake();
		// A reconnect within the same scope and revision is answered from
		// the broker's cached grant, so the provider tab need not be asked again.
		// What matters is that the handshake still carries the provider's token.
		expect(provider.ofType("credentialsRequest").length).toBeGreaterThanOrEqual(
			1,
		);
		expect(next()).toHaveProperty("token");
	});

	it("never delivers events from the provider-authenticated session to the anonymous page", async () => {
		const { clock, anonymous, socket } = await twoPages();
		socket.fire("tick", { secret: "for the signed-in user" });
		await settle(clock);
		expect(JSON.stringify(anonymous.data("a"))).not.toContain("signed-in");
	});

	it("keeps delivering to the provider page after the anonymous group closes", async () => {
		const { clock, provider, anonymous, socket } = await twoPages();
		socket.fire("tick", 41);
		await settle(clock);
		expect(provider.data("p")).toContainEqual([41]);
		provider.ackAll("p");
		anonymous.send({ t: "unsubscribe", c: "a" });
		await settle(clock);
		for (let step = 0; step < 20; step += 1) {
			clock.advance(5_000);
			await settle(clock);
		}
		socket.connected = true;
		socket.fire("tick", 42);
		await settle(clock);
		expect(provider.data("p")).toContainEqual([42]);
	});
});

describe("a refused redirect becomes permanent-error with code redirect", () => {
	it("graphql-sse", async () => {
		const redirects: Array<RequestRedirect | undefined> = [];
		const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
			redirects.push(init?.redirect);
			// What the platform does with a 302 under each redirect mode.
			if (init?.redirect === "error") {
				throw new TypeError("fetch failed", {
					cause: new Error("unexpected redirect"),
				});
			}
			if (init?.redirect === "manual") {
				return new Response(null, {
					status: 302,
					headers: { location: "https://evil.test/" },
				});
			}
			throw new Error("the redirect would have been followed");
		}) as typeof fetch;
		const test = createTestContext({
			credentials: (revision) => ({
				headers: { authorization: `Bearer t${revision}` },
			}),
		});
		const connection = graphqlSseAdapter({
			fetchFn,
			retry: async () => {},
		}).connect({ url: "https://api.test/graphql/stream" }, test.ctx);
		connections.push(connection);
		connection.subscribe(
			{ query: "subscription { ticks { n } }" },
			createRecordingSink().sink,
			{ key: "k", repeatable: true },
		);
		await waitFor(
			() =>
				test.hasStatus("failed") ||
				test.hasStatus("retry-exhausted") ||
				redirects.length > 10,
			{ timeout: 2_000 },
		);
		expect(redirects.every((mode) => mode !== undefined)).toBe(true);
		expect(test.lastStatus()).toMatchObject({
			state: "failed",
			reason: "permanent-error",
			code: "redirect",
		});
		expect(redirects).toHaveLength(1);
	});
});

class ScriptedEventSource {
	static instances: ScriptedEventSource[] = [];
	readyState = 0;
	readonly #listeners = new Map<string, Set<(event: unknown) => void>>();
	constructor(
		readonly url: string,
		readonly init: Record<string, unknown> = {},
	) {
		ScriptedEventSource.instances.push(this);
	}
	addEventListener(type: string, listener: (event: unknown) => void): void {
		let set = this.#listeners.get(type);
		if (!set) {
			set = new Set();
			this.#listeners.set(type, set);
		}
		set.add(listener);
	}
	removeEventListener(type: string, listener: (event: unknown) => void): void {
		this.#listeners.get(type)?.delete(listener);
	}
	close(): void {
		this.readyState = 2;
	}
	fire(type: string, event: Record<string, unknown> = {}): void {
		for (const listener of [...(this.#listeners.get(type) ?? [])]) {
			listener({ type, ...event });
		}
	}
}

describe("tRPC procedure-error text stays bounded", () => {
	it("bounds every string an error formatter adds to shape.data", async () => {
		ScriptedEventSource.instances = [];
		const test = createTestContext({ credentials: () => ({}) });
		const connection = trpcSseAdapter({
			EventSource: ScriptedEventSource,
			headers: true,
			retryDelayMs: () => 5,
		}).connect({ url: "https://api.test/trpc" }, test.ctx);
		connections.push(connection as AdapterConnection);
		const feed = createRecordingSink<unknown>();
		const spec: TrpcSubscriptionSpec = { path: "ticks" };
		connection.subscribe(spec, feed.sink as never, {
			key: "k",
			repeatable: true,
		});
		await waitFor(() => ScriptedEventSource.instances.length > 0, {
			timeout: 1_000,
		});
		const source = ScriptedEventSource.instances[0] as ScriptedEventSource;
		source.fire("serialized-error", {
			data: JSON.stringify({
				code: -32600,
				message: "bad input",
				data: {
					code: "BAD_REQUEST",
					httpStatus: 400,
					// A common errorFormatter addition (zod's flattened issues).
					zodError: { formErrors: [`upstream ${"y".repeat(5_000)}`] },
				},
			}),
		});
		await waitFor(() => feed.errors.length === 1, { timeout: 1_000 });
		const strings: string[] = [];
		const walk = (value: unknown) => {
			if (typeof value === "string") strings.push(value);
			else if (value && typeof value === "object")
				for (const item of Object.values(value)) walk(item);
		};
		walk(feed.errors[0]);
		expect(Math.max(...strings.map((s) => s.length))).toBeLessThanOrEqual(120);
	});
});

describe("static credential headers are refused naming the credentials provider", () => {
	it("graphqlSse headers.authorization", () => {
		let message = "";
		try {
			graphqlSse("/stream", { headers: { authorization: "Bearer x" } });
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toContain("credentials provider");
	});
});

describe("tRPC FORBIDDEN on one procedure ends that subscription only", () => {
	it("leaves another subscription on the same connection running", async () => {
		ScriptedEventSource.instances = [];
		const test = createTestContext({
			credentials: () => ({ headers: { authorization: "Bearer t" } }),
		});
		const connection = trpcSseAdapter({
			EventSource: ScriptedEventSource,
			headers: true,
			retryDelayMs: () => 5,
		}).connect({ url: "https://api.test/trpc" }, test.ctx);
		connections.push(connection as AdapterConnection);
		const subscribe = (room: string) => {
			const feed = createRecordingSink<unknown>();
			connection.subscribe(
				{ path: "room", input: { room } },
				feed.sink as never,
				{ key: room, repeatable: true },
			);
			return feed;
		};
		const denied = subscribe("staff-only");
		await waitFor(() => ScriptedEventSource.instances.length === 1, {
			timeout: 1_000,
		});
		const allowed = subscribe("lobby");
		await waitFor(() => ScriptedEventSource.instances.length === 2, {
			timeout: 1_000,
		});
		const [first, second] = ScriptedEventSource.instances as [
			ScriptedEventSource,
			ScriptedEventSource,
		];
		first.fire("serialized-error", {
			data: JSON.stringify({
				code: -32003,
				message: "not a member of staff-only",
				data: { code: "FORBIDDEN", httpStatus: 403 },
			}),
		});
		await waitFor(() => denied.errors.length > 0 || test.hasStatus("failed"), {
			timeout: 1_000,
		});
		expect(test.rejectCalls).toEqual([]);
		// The lobby subscription is untouched by the staff-only denial.
		expect(second.readyState).not.toBe(2);
		expect(test.lastStatus()?.state).not.toBe("failed");
		expect(allowed.errors).toEqual([]);
	});
});
