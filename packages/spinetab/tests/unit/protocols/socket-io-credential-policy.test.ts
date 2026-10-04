import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterConnection } from "../../../src/core/adapter.ts";
import { connectionKey } from "../../../src/core/identity.ts";
import type { Credentials } from "../../../src/core/types.ts";
import {
	defaultClassifyConnectError,
	socketIoAdapter,
} from "../../../src/protocols/socket-io/runtime.ts";
import {
	createRecordingSink,
	createTestContext,
	sleep,
	type TestContext,
	waitFor,
} from "../../integration/protocols/helpers.ts";

// Scripted Manager cases isolate state transitions; the integration suite exercises live sockets.

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
		connects = 0;
		connect(): this {
			this.active = true;
			this.connects += 1;
			return this;
		}
		disconnect(): this {
			this.active = false;
			this.connected = false;
			return this;
		}
		/** Plays the server: middleware rejected the handshake. */
		reject(message: string, data?: unknown): void {
			this.active = false;
			this.fire("connect_error", Object.assign(new Error(message), { data }));
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

const managers = fake.FakeManager.instances;
const connections: AdapterConnection[] = [];
beforeEach(() => {
	managers.length = 0;
});
afterEach(() => {
	for (const connection of connections.splice(0)) connection.dispose();
});

function setup(
	options: {
		credentials?: (revision: number) => Credentials;
		audience?: (url: string | undefined) => boolean;
	} = {},
) {
	const test = createTestContext({
		...(options.credentials ? { credentials: options.credentials } : {}),
		...(options.audience ? { audience: options.audience } : {}),
	});
	const connection = socketIoAdapter().connect(
		{ url: "https://h.test/chat", sharing: "shared" },
		test.ctx,
	);
	connections.push(connection);
	connection.subscribe({ event: "tick" }, createRecordingSink().sink, {
		key: "k",
		repeatable: true,
	});
	const socket = managers[0]?.socket("/chat");
	if (!socket) throw new Error("no namespace socket");
	/** Upstream asks for the auth payload when it opens the namespace. */
	const handshake = async () => {
		let payload: object | undefined;
		socket.auth?.((data) => {
			payload = data;
		});
		await sleep(5);
		return payload;
	};
	return { test, connection, socket, handshake };
}

function statusOf(test: TestContext) {
	const last = test.lastStatus();
	return { state: last?.state, reason: last?.reason, code: last?.code };
}

describe("Socket.IO names the URL and blocks for good outside the audience", () => {
	it("asks with the endpoint URL", async () => {
		const { test, handshake } = setup({ credentials: () => ({ auth: {} }) });
		await handshake();
		expect(test.urls).toEqual(["https://h.test/chat"]);
	});

	it("sends no payload, rejects nothing and ignores rotation", async () => {
		const { test, connection, socket, handshake } = setup({
			credentials: () => ({ auth: { token: "t" } }),
			audience: () => false,
		});
		const payload = await handshake();
		await waitFor(() => test.hasStatus("auth-blocked"), { timeout: 1_000 });
		expect(payload).toBeUndefined();
		expect(statusOf(test).reason).toBe("credentials-audience");
		const connects = socket.connects;
		connection.rotate?.();
		expect(socket.connects).toBe(connects);
		expect(test.rejectCalls).toEqual([]);
	});
});

describe("Socket.IO middleware rejections", () => {
	it("the default classifier splits 401 from 403", () => {
		expect(
			defaultClassifyConnectError({ message: "x", data: { status: 401 } }),
		).toBe("auth");
		expect(defaultClassifyConnectError({ message: "Unauthorized" })).toBe(
			"auth",
		);
		expect(
			defaultClassifyConnectError({ message: "x", data: { status: 403 } }),
		).toBe("forbidden");
		expect(defaultClassifyConnectError({ message: "Forbidden" })).toBe(
			"forbidden",
		);
		expect(defaultClassifyConnectError({ message: "room full" })).toBe(
			"failed",
		);
	});

	it("401 rejects the grant whose auth was sent", async () => {
		const grants: Credentials[] = [];
		const { test, socket, handshake } = setup({
			credentials: (revision) => {
				const grant = { auth: { token: `t${revision}` } };
				grants.push(grant);
				return grant;
			},
		});
		expect(await handshake()).toEqual({ token: "t1" });
		socket.reject("invalid token t1", { status: 401 });
		expect(statusOf(test)).toEqual({
			state: "auth-blocked",
			reason: "credentials-rejected",
			code: "connect-error",
		});
		expect(test.rejectCalls).toHaveLength(1);
		expect(test.rejectCalls[0]).toBe(grants[0]);
	});

	it("401 rejects nothing when the grant carried no auth", async () => {
		const { test, socket, handshake } = setup({
			credentials: () => ({ headers: { authorization: "Bearer t" } }),
		});
		expect(await handshake()).toEqual({});
		socket.reject("Unauthorized");
		expect(statusOf(test).state).toBe("auth-blocked");
		expect(test.rejectCalls).toEqual([]);
	});

	it("403 ends as permanent-error with code forbidden and rejects nothing", async () => {
		const { test, socket, handshake } = setup({
			credentials: () => ({ auth: { token: "t" } }),
		});
		await handshake();
		socket.reject("Forbidden: t", { status: 403 });
		expect(statusOf(test)).toEqual({
			state: "failed",
			reason: "permanent-error",
			code: "forbidden",
		});
		expect(test.rejectCalls).toEqual([]);
	});
});

describe("the Manager is keyed on the full group identity", () => {
	/** A connection opened with the group key core composes (marker included). */
	function group(
		adapter: ReturnType<typeof socketIoAdapter>,
		url: string,
		mode: { anonymous: boolean },
		credentials: () => Credentials,
	) {
		const spec = { url, sharing: "shared" as const };
		const key = connectionKey(
			"socket-io",
			"s",
			adapter.connectionKey?.(spec) ?? "",
			mode.anonymous,
		);
		const test = createTestContext({ scope: "s", key, credentials });
		const connection = adapter.connect(spec, test.ctx);
		connections.push(connection);
		const feed = createRecordingSink();
		connection.subscribe({ event: "tick" }, feed.sink, {
			key: "k",
			repeatable: true,
		});
		return { test, connection, feed };
	}

	it("anonymous and provider groups of one scope get their own Manager", async () => {
		const adapter = socketIoAdapter();
		const provider = group(
			adapter,
			"https://h.test/chat",
			{ anonymous: false },
			() => ({
				auth: { token: "t1" },
			}),
		);
		const anonymous = group(
			adapter,
			"https://h.test/chat",
			{ anonymous: true },
			() => ({}),
		);
		expect(managers).toHaveLength(2);
		const [own, other] = managers.map((m) => m.socket("/chat"));
		expect(own).not.toBe(other);
		// The provider's re-handshake still carries its grant (no downgrade).
		let payload: object | undefined;
		own?.auth?.((data) => {
			payload = data;
		});
		await sleep(5);
		expect(payload).toEqual({ token: "t1" });
		// Events on the provider's session never reach the anonymous group.
		own?.fire("tick", "private");
		await sleep(5);
		expect(anonymous.feed.events).toEqual([]);
		// Closing the anonymous group leaves the provider's socket wired.
		anonymous.connection.dispose();
		own?.fire("tick", "still here");
		await sleep(5);
		expect(JSON.stringify(provider.feed.events)).toContain("still here");
	});

	it("groups of one identity still multiplex namespaces on one Manager", () => {
		const adapter = socketIoAdapter();
		const credentials = () => ({ auth: { token: "t1" } });
		group(adapter, "https://h.test/chat", { anonymous: false }, credentials);
		group(adapter, "https://h.test/news", { anonymous: false }, credentials);
		expect(managers).toHaveLength(1);
		expect([...(managers[0]?.nsps.keys() ?? [])]).toEqual(["/chat", "/news"]);
	});
});
