import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpinetabError } from "../../../src/core/errors.ts";
import type { Credentials, Json } from "../../../src/core/types.ts";
import {
	type WebSocketProtocol,
	websocketAdapter,
} from "../../../src/transports/websocket/runtime.ts";
import {
	FakeWebSocket,
	fakeContext,
	flush,
	recordingSink,
	SUBSCRIBE_OPTIONS,
} from "./helpers.ts";

// on the raw WebSocket transport: the credentials request
// names the socket URL, `authenticate` receives `connectionParams` only, and
// an auth close rejects exactly the grant that was sent.

const URL_BASE = "wss://api.test/ws";

function setup(provider: () => Promise<Credentials>) {
	const seen: unknown[] = [];
	const protocol: WebSocketProtocol = {
		decode: (raw) => ({ kind: "event", topics: [], event: raw }),
		authenticate(params) {
			seen.push(params);
			return [JSON.stringify({ type: "auth", ...(params as object) })];
		},
		classifyClose: (code) =>
			code === 4401 || code === 4403 ? "auth" : "transient",
	};
	const adapter = websocketAdapter({ protocols: { auth: protocol } });
	const fake = fakeContext();
	fake.setCredentials(provider);
	const conn = adapter.connect({ url: URL_BASE, protocol: "auth" }, fake.ctx);
	conn.subscribe({}, recordingSink().sink, SUBSCRIBE_OPTIONS);
	return { conn, fake, seen };
}

beforeEach(() => {
	FakeWebSocket.reset();
	vi.stubGlobal("WebSocket", FakeWebSocket);
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("raw WebSocket credentials", () => {
	it("the credentials request names the socket URL", async () => {
		const { fake } = setup(async () => ({ connectionParams: { token: "t" } }));
		await flush();
		expect(fake.credentialUrls).toEqual([URL_BASE]);
	});

	it("authenticate receives connectionParams only, never the whole grant", async () => {
		const { seen } = setup(async () => ({
			headers: { authorization: "Bearer h" },
			connectionParams: { token: "t" },
			auth: { token: "a" },
		}));
		await flush();
		const socket = FakeWebSocket.last();
		socket.serverOpen();
		expect(seen).toEqual([{ token: "t" }]);
		expect(socket.json()[0]).toEqual({ type: "auth", token: "t" });
	});

	it("a grant without connectionParams sends no authentication frame", async () => {
		const { seen } = setup(async () => ({
			headers: { authorization: "Bearer h" },
		}));
		await flush();
		const socket = FakeWebSocket.last();
		socket.serverOpen();
		expect(seen).toEqual([]);
		expect(socket.sent).toEqual([]);
	});

	it("an auth close rejects exactly the grant that was sent and reports close:<code>", async () => {
		const grant = { connectionParams: { token: "t" } as Record<string, Json> };
		const { fake } = setup(async () => grant);
		await flush();
		const socket = FakeWebSocket.last();
		socket.serverOpen();
		socket.serverClose(4401, "token expired for alice", true);
		expect(fake.rejected).toHaveLength(1);
		expect(fake.rejected[0]).toBe(grant);
		expect(fake.last()).toEqual({
			state: "auth-blocked",
			reason: "credentials-rejected",
			code: "close:4401",
		});
	});

	it("an auth close after no authentication frame rejects nothing", async () => {
		const { fake } = setup(async () => ({ headers: { a: "b" } }));
		await flush();
		const socket = FakeWebSocket.last();
		socket.serverOpen();
		socket.serverClose(4401, "", true);
		expect(fake.rejections()).toBe(0);
		expect(fake.last()).toMatchObject({ state: "auth-blocked" });
	});

	it("no downgrade: a socket that authenticated before blocks credentials-missing instead of reopening unauthenticated", async () => {
		let grant: Credentials = { connectionParams: { token: "t1" } };
		const { conn, fake, seen } = setup(async () => grant);
		await flush();
		FakeWebSocket.last().serverOpen();
		expect(FakeWebSocket.last().sent).toHaveLength(1);
		// The provider now supplies nothing for the socket (for example after
		// logout); the reconnect must not share an unauthenticated socket.
		grant = {};
		FakeWebSocket.last().serverClose(1006);
		await vi.advanceTimersByTimeAsync(60_000);
		await flush();
		expect(FakeWebSocket.instances).toHaveLength(1);
		expect(fake.last()).toEqual({
			state: "auth-blocked",
			reason: "credentials-missing",
		});
		expect(fake.rejections()).toBe(0);
		// A new revision with material restarts it and authenticates again.
		grant = { connectionParams: { token: "t2" } };
		conn.rotate?.();
		await flush();
		expect(FakeWebSocket.instances).toHaveLength(2);
		FakeWebSocket.last().serverOpen();
		expect(seen).toEqual([{ token: "t1" }, { token: "t2" }]);
		expect(fake.last()).toEqual({ state: "connected" });
	});

	it("no downgrade: a socket that never authenticated keeps opening without a frame", async () => {
		const { fake } = setup(async () => ({}));
		await flush();
		FakeWebSocket.last().serverOpen();
		FakeWebSocket.last().serverClose(1006);
		await vi.advanceTimersByTimeAsync(60_000);
		await flush();
		expect(FakeWebSocket.instances.length).toBeGreaterThan(1);
		FakeWebSocket.last().serverOpen();
		expect(FakeWebSocket.last().sent).toEqual([]);
		expect(fake.last()).toEqual({ state: "connected" });
	});

	it("credentials-audience blocks permanently without opening a socket", async () => {
		const { conn, fake } = setup(() =>
			Promise.reject(new SpinetabError("credentials-audience", "no")),
		);
		await flush();
		expect(FakeWebSocket.instances).toHaveLength(0);
		expect(fake.last()).toEqual({
			state: "auth-blocked",
			reason: "credentials-audience",
		});
		conn.rotate?.();
		await flush();
		expect(fake.credentialCalls).toHaveLength(1);
		expect(FakeWebSocket.instances).toHaveLength(0);
	});
});
