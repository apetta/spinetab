import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterConnection } from "../../../src/core/adapter.ts";
import { SpinetabError } from "../../../src/core/errors.ts";
import {
	type SocketIoSubscriptionSpec,
	socketIoAdapter,
} from "../../../src/protocols/socket-io/runtime.ts";
import {
	createRecordingSink,
	createTestContext,
	waitFor,
} from "../../integration/protocols/helpers.ts";

// the REAL socket.io-client 4.8.4 `Socket` over a scripted
// Manager/engine. `Socket.onopen()` calls `auth(cb)` on every Manager `open`,
// and `cb` (`_sendConnectPacket`) writes a namespace CONNECT to whatever engine
// is open when it runs. If the engine drops and reopens while a credential
// request is pending, only the current attempt may send its CONNECT.
// The engine follows engine.io-client 6.6.7: a write while it is closed is
// dropped; a write while a new engine is opening (Manager.open() creates it
// and `_packet` writes to it) is buffered and flushed right after `open`.

const scripted = vi.hoisted(() => ({
	packets: [] as Array<{ type: number; nsp: string; data?: unknown }>,
	managers: [] as unknown[],
}));

vi.mock("socket.io-client", async (importOriginal) => {
	const real = (await importOriginal()) as typeof import("socket.io-client");
	class ScriptedManager {
		readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();
		_readyState = "closed";
		_reconnecting = false;
		_autoConnect = false;
		engineState: "closed" | "opening" | "open" = "closed";
		buffer: Array<{ type: number; nsp: string; data?: unknown }> = [];
		engine = {
			transport: { name: "websocket", writable: true },
			_hasPingExpired: () => false,
		};
		readonly nsps: Record<string, unknown> = {};
		constructor(
			readonly uri: string,
			readonly opts: unknown,
		) {
			scripted.managers.push(this);
		}
		on(event: string, listener: (...args: unknown[]) => void) {
			let set = this.listeners.get(event);
			if (!set) {
				set = new Set();
				this.listeners.set(event, set);
			}
			set.add(listener);
			return this;
		}
		off(event: string, listener: (...args: unknown[]) => void) {
			this.listeners.get(event)?.delete(listener);
			return this;
		}
		removeAllListeners() {
			this.listeners.clear();
			return this;
		}
		fire(event: string, ...args: unknown[]) {
			for (const listener of [...(this.listeners.get(event) ?? [])]) {
				listener(...args);
			}
		}
		socket(nsp: string) {
			let socket = this.nsps[nsp];
			if (!socket) {
				socket = new real.Socket(this as never, nsp, {});
				this.nsps[nsp] = socket;
			}
			return socket;
		}
		open() {
			if (this._readyState === "closed") this._readyState = "opening";
			return this;
		}
		_packet(packet: { type: number; nsp: string; data?: unknown }) {
			if (this.engineState === "open") scripted.packets.push(packet);
			else if (this.engineState === "opening") this.buffer.push(packet);
		}
		_destroy() {}
		setTimeoutFn(fn: () => void, ms: number) {
			return setTimeout(fn, ms);
		}
		clearTimeoutFn(timer: ReturnType<typeof setTimeout>) {
			clearTimeout(timer);
		}
		/** The Manager starts a reconnection attempt: a new engine is opening. */
		engineOpening() {
			this._readyState = "opening";
			this.engineState = "opening";
		}
		/**
		 * The engine opens: every active namespace socket asks for `auth`
		 * (Manager `open`), then the engine flushes its write buffer.
		 */
		engineOpen() {
			this._readyState = "open";
			this.engineState = "open";
			this.fire("open");
			scripted.packets.push(...this.buffer.splice(0));
		}
		/** The engine closes before the namespace handshake completed. */
		engineClose(reason: string) {
			this._readyState = "closed";
			this.engineState = "closed";
			this.buffer = [];
			this.fire("close", reason);
		}
		/** Upstream `_close()` (manager.js 292-297): a forced close, no reconnect. */
		closes = 0;
		_close() {
			this.closes += 1;
			this.engineClose("forced close");
		}
	}
	return { ...real, Manager: ScriptedManager };
});

interface Scripted {
	engineOpening(): void;
	engineOpen(): void;
	engineClose(reason: string): void;
}

const connections: AdapterConnection[] = [];
afterEach(() => {
	for (const connection of connections.splice(0)) connection.dispose();
	scripted.packets.length = 0;
	scripted.managers.length = 0;
});

function setup(
	credentials: (revision: number) => Promise<Record<string, unknown>>,
) {
	const test = createTestContext({ credentials });
	const connection = socketIoAdapter().connect(
		{ url: "https://h.test/chat", sharing: "shared" },
		test.ctx,
	);
	connections.push(connection);
	connection.subscribe({ event: "message" }, createRecordingSink().sink, {
		key: "k",
		repeatable: true,
	});
	const manager = scripted.managers.at(-1) as Scripted;
	const connects = () =>
		scripted.packets.filter(
			(packet) => packet.type === 0 && packet.nsp === "/chat",
		);
	return { test, manager, connects };
}

describe("namespace CONNECT only for the current engine attempt", () => {
	it("an engine that drops and reopens during a pending credential request sends one CONNECT", async () => {
		const pending: Array<() => void> = [];
		const { test, manager, connects } = setup(
			(revision) =>
				new Promise((resolve) =>
					pending.push(() => resolve({ auth: { token: `t${revision}` } })),
				),
		);
		manager.engineOpen(); // attempt A: auth(cb1), credential request 1 pending
		manager.engineClose("transport close");
		manager.engineOpen(); // attempt B: auth(cb2), credential request 2 pending
		for (const resolve of pending) resolve();
		await waitFor(() => connects().length > 0);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(test.requests).toEqual(["connect", "reconnect"]);
		expect(connects()).toHaveLength(1);
		expect(connects()[0]?.data).toEqual({ token: "t1" });
	});

	it("a stale credential failure neither blocks nor stops the current attempt", async () => {
		const settle: Array<{ ok(): void; fail(): void }> = [];
		const { test, manager, connects } = setup(
			() =>
				new Promise((resolve, reject) =>
					settle.push({
						ok: () => resolve({ auth: { token: "t" } }),
						fail: () =>
							reject(
								new SpinetabError(
									"credentials-timeout",
									"The credentials provider failed.",
								),
							),
					}),
				),
		);
		manager.engineOpen();
		manager.engineClose("transport close");
		manager.engineOpen();
		settle[0]?.fail();
		settle[1]?.ok();
		await waitFor(() => connects().length > 0);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(connects()).toHaveLength(1);
		expect(test.hasStatus("auth-blocked")).toBe(false);
	});

	// The stale grant arrives before the next auth call; only the close/disconnect fence can prevent an extra buffered CONNECT.
	it("a stale answer that lands while the next engine is still opening never reaches it", async () => {
		const pending: Array<(token: string) => void> = [];
		const { test, manager, connects } = setup(
			() =>
				new Promise((resolve) =>
					pending.push((token) => resolve({ auth: { token } })),
				),
		);
		manager.engineOpening();
		manager.engineOpen(); // attempt A asks
		manager.engineClose("transport close");
		manager.engineOpening(); // the reconnect's new engine buffers writes
		pending[0]?.("stale"); // the slow provider answers attempt A now
		await new Promise((resolve) => setTimeout(resolve, 10));
		manager.engineOpen(); // attempt B asks, then the buffer flushes
		pending[1]?.("fresh");
		await waitFor(() => connects().length > 0);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(connects().map((packet) => packet.data)).toEqual([
			{ token: "fresh" },
		]);
		expect(test.requests).toEqual(["connect", "reconnect"]);
	});
});

// with the REAL `Socket`: the fresh-session outcome must present
// no recovery `pid`/`offset` (socket.io-client 4.8.4 `_sendConnectPacket`
// adds them while `_pid` is set), because socket.io-adapter 2.5.8 keeps a
// restored session until it expires and would restore its rooms again.
describe("the fresh session presents no recovery pid or offset", () => {
	const CONNECT = 0;
	const DISCONNECT = 1;
	const EVENT = 2;
	const ACK = 3;
	type Packet = { type: number; nsp: string; id?: number; data?: unknown };
	type RealSocket = {
		connected: boolean;
		recovered: boolean;
		onpacket(packet: Packet): void;
	};

	function rooms(
		credentials: () => Promise<Record<string, unknown>> = () =>
			Promise.resolve({ auth: { token: "t" } }),
	) {
		const test = createTestContext({ credentials });
		const connection = socketIoAdapter({
			routes: { byRoom: (args) => [(args[0] as { room: string }).room] },
		}).connect({ url: "https://h.test/chat", sharing: "shared" }, test.ctx);
		connections.push(connection);
		const manager = scripted.managers.at(-1) as Scripted & {
			nsps: Record<string, RealSocket>;
		};
		const finite = createRecordingSink<unknown[]>();
		connection.subscribe({ event: "room" }, finite.sink, {
			key: "finite",
			repeatable: false,
		});
		const socket = manager.nsps["/chat"] as RealSocket;
		const ours = (type: number) =>
			scripted.packets.filter(
				(packet) => packet.type === type && packet.nsp === "/chat",
			) as Packet[];
		const member = (room: string) =>
			connection.subscribe(
				{
					event: "room",
					membership: room,
					route: "byRoom",
					join: { event: "join", args: [room] },
					leave: { event: "leave", args: [room] },
				},
				createRecordingSink<unknown[]>().sink,
				{ key: room, repeatable: true },
			);
		/** Plays the server: the namespace CONNECT reply (`pid` with CSR). */
		const serverConnect = (sid: string, pid: string) =>
			socket.onpacket({ type: CONNECT, nsp: "/chat", data: { sid, pid } });
		/** Plays the server: acknowledges every join emitted so far. */
		const ackJoins = () => {
			for (const packet of ours(EVENT)) {
				const [event] = packet.data as [string];
				if (event === "join" && packet.id !== undefined) {
					socket.onpacket({
						type: ACK,
						nsp: "/chat",
						id: packet.id,
						data: [{ ok: true }],
					});
				}
			}
		};
		const events = (name: string) =>
			ours(EVENT)
				.map((packet) => packet.data as unknown[])
				.filter((data) => data[0] === name)
				.map((data) => data[1]);
		return {
			test,
			manager,
			socket,
			finite,
			ours,
			member,
			serverConnect,
			ackJoins,
			events,
			connects: () => ours(CONNECT),
			disconnects: () => ours(DISCONNECT),
			/** A broadcast with an offset, as the server appends under CSR. */
			broadcast: () =>
				socket.onpacket({
					type: EVENT,
					nsp: "/chat",
					data: ["room", { room: "elsewhere" }, "offset-1"],
				}),
		};
	}

	it("an overflow on a live connection sends DISCONNECT, then a CONNECT without pid or offset", async () => {
		const h = rooms();
		h.manager.engineOpen();
		await waitFor(() => h.connects().length === 1);
		h.serverConnect("s1", "p1");
		h.broadcast();
		h.member("keep");
		h.ackJoins();
		const gone = Array.from({ length: 65 }, (_, n) => h.member(`g${n}`));
		for (const handle of gone) handle.unsubscribe();
		await waitFor(() => h.connects().length === 2);
		expect(h.disconnects()).toHaveLength(1);
		expect(h.connects().map((packet) => packet.data)).toEqual([
			{ token: "t" },
			{ token: "t" },
		]);
		expect(h.events("leave")).toEqual([]);
		expect(h.finite.errors.map((error) => error.code)).toEqual(["interrupted"]);
		h.serverConnect("s2", "p2");
		expect(h.socket.recovered).toBe(false);
		// Live keys join once on the fresh session.
		expect(h.events("join").filter((room) => room === "keep")).toHaveLength(2);
	});

	it("a recovered reconnect while overflowed is declined: DISCONNECT, then a CONNECT without pid; no leave is sent", async () => {
		const h = rooms();
		h.manager.engineOpen();
		await waitFor(() => h.connects().length === 1);
		h.serverConnect("s1", "p1");
		h.broadcast();
		h.member("keep");
		const gone = Array.from({ length: 65 }, (_, n) => h.member(`g${n}`));
		h.ackJoins();
		h.manager.engineClose("transport close");
		for (const handle of gone) handle.unsubscribe();
		h.manager.engineOpen();
		await waitFor(() => h.connects().length === 2);
		// Upstream asks for recovery: the control for the fresh CONNECT below.
		expect(h.connects()[1]?.data).toEqual({
			pid: "p1",
			offset: "offset-1",
			token: "t",
		});
		h.serverConnect("s1", "p1");
		await waitFor(() => h.connects().length === 3);
		expect(h.disconnects()).toHaveLength(1);
		expect(h.connects()[2]?.data).toEqual({ token: "t" });
		expect(h.events("leave")).toEqual([]);
		h.serverConnect("s3", "p3");
		expect(h.socket.recovered).toBe(false);
		expect(h.events("join").filter((room) => room === "keep")).toHaveLength(2);
		expect(h.finite.errors.map((error) => error.code)).toEqual(["interrupted"]);
	});

	// (a): after a recovered session the server still holds the
	// restored session's room snapshot, and neither a client nor a server
	// namespace disconnect refreshes it. A client-initiated reconnect
	// therefore presents no pid; an automatic one after transport loss does.
	describe("client-initiated reconnects present no recovery pid", () => {
		/** A first session, a transport drop and a recovered session. */
		async function recoveredSession() {
			const h = rooms();
			const connection = connections.at(-1);
			if (!connection) throw new Error("no connection");
			h.manager.engineOpen();
			await waitFor(() => h.connects().length === 1);
			h.serverConnect("s1", "p1");
			h.broadcast();
			h.member("keep");
			h.ackJoins();
			h.manager.engineClose("transport close");
			h.manager.engineOpen();
			await waitFor(() => h.connects().length === 2);
			// The control: the automatic reconnect asks for recovery.
			expect(h.connects()[1]?.data).toEqual({
				pid: "p1",
				offset: "offset-1",
				token: "t",
			});
			h.serverConnect("s1", "p1");
			expect(h.socket.recovered).toBe(true);
			return { ...h, connection };
		}

		it("rotate() sends DISCONNECT, then a CONNECT without pid or offset; live keys join once on the fresh session", async () => {
			const h = await recoveredSession();
			h.connection.rotate?.();
			await waitFor(() => h.connects().length === 3);
			expect(h.disconnects()).toHaveLength(1);
			expect(h.connects()[2]?.data).toEqual({ token: "t" });
			h.serverConnect("s3", "p3");
			expect(h.socket.recovered).toBe(false);
			expect(h.events("join").filter((room) => room === "keep")).toHaveLength(
				2,
			);
		});

		it("retry() after `io server disconnect` sends a CONNECT without pid or offset", async () => {
			const h = await recoveredSession();
			h.socket.onpacket({ type: DISCONNECT, nsp: "/chat" });
			expect(h.test.lastStatus()).toMatchObject({
				state: "failed",
				reason: "server-closed",
			});
			h.connection.retry?.();
			await waitFor(() => h.connects().length === 3);
			expect(h.disconnects()).toHaveLength(0);
			expect(h.connects()[2]?.data).toEqual({ token: "t" });
			h.serverConnect("s3", "p3");
			expect(h.socket.recovered).toBe(false);
			expect(h.events("join").filter((room) => room === "keep")).toHaveLength(
				2,
			);
		});

		/** A first session that was never restored: upstream holds its pid. */
		async function firstSession() {
			const h = rooms();
			const connection = connections.at(-1);
			if (!connection) throw new Error("no connection");
			h.manager.engineOpen();
			await waitFor(() => h.connects().length === 1);
			h.serverConnect("s1", "p1");
			h.broadcast();
			h.member("keep");
			h.ackJoins();
			return { ...h, connection };
		}

		it("rotate() on a session never restored sends DISCONNECT, then a CONNECT without pid or offset", async () => {
			const h = await firstSession();
			h.connection.rotate?.();
			await waitFor(() => h.connects().length === 2);
			expect(h.disconnects()).toHaveLength(1);
			expect(h.connects()[1]?.data).toEqual({ token: "t" });
		});

		it("retry() after `io server disconnect` on a session never restored sends a CONNECT without pid or offset", async () => {
			const h = await firstSession();
			h.socket.onpacket({ type: DISCONNECT, nsp: "/chat" });
			expect(h.test.lastStatus()?.state).toBe("failed");
			h.connection.retry?.();
			await waitFor(() => h.connects().length === 2);
			expect(h.connects()[1]?.data).toEqual({ token: "t" });
		});
	});

	// A session is restored at most once. After a restore the next
	// automatic reconnect presents no pid, so a loss the client detected
	// before the server cannot restore the snapshot saved at the earlier drop.
	describe("a restored session is not presented again", () => {
		it("after a recovered connect the next automatic reconnect sends a CONNECT without pid or offset; the fresh session's own first loss presents its new pid", async () => {
			const h = rooms();
			h.manager.engineOpen();
			await waitFor(() => h.connects().length === 1);
			h.serverConnect("s1", "p1");
			h.broadcast();
			h.member("keep");
			h.ackJoins();
			h.manager.engineClose("transport close");
			h.manager.engineOpen();
			await waitFor(() => h.connects().length === 2);
			// The control: a session's first automatic reconnect asks for recovery.
			expect(h.connects()[1]?.data).toEqual({
				pid: "p1",
				offset: "offset-1",
				token: "t",
			});
			h.serverConnect("s1", "p1");
			expect(h.socket.recovered).toBe(true);
			// A loss the client detects first (half-open): an automatic reconnect.
			h.manager.engineClose("ping timeout");
			h.manager.engineOpen();
			await waitFor(() => h.connects().length === 3);
			expect(h.connects()[2]?.data).toEqual({ token: "t" });
			h.serverConnect("s3", "p3");
			expect(h.socket.recovered).toBe(false);
			expect(h.events("join").filter((room) => room === "keep")).toHaveLength(
				2,
			);
			// The fresh session's first loss asks for recovery with its own pid.
			h.socket.onpacket({
				type: EVENT,
				nsp: "/chat",
				data: ["room", { room: "elsewhere" }, "offset-3"],
			});
			h.manager.engineClose("transport close");
			h.manager.engineOpen();
			await waitFor(() => h.connects().length === 4);
			expect(h.connects()[3]?.data).toEqual({
				pid: "p3",
				offset: "offset-3",
				token: "t",
			});
			expect(h.disconnects()).toHaveLength(0);
		});

		// offset addendum: upstream updates `_lastOffset` only while `_pid`
		// is set and never resets it, so a decline that cleared the pid alone
		// left the restored session's cursor for the next session's pid.
		it("a fresh session lost before any event presents its own pid without the restored session's offset (offset addendum)", async () => {
			const h = rooms();
			h.manager.engineOpen();
			await waitFor(() => h.connects().length === 1);
			h.serverConnect("s1", "p1");
			h.broadcast();
			h.member("keep");
			h.ackJoins();
			h.manager.engineClose("transport close");
			h.manager.engineOpen();
			await waitFor(() => h.connects().length === 2);
			expect(h.connects()[1]?.data).toEqual({
				pid: "p1",
				offset: "offset-1",
				token: "t",
			});
			h.serverConnect("s1", "p1");
			expect(h.socket.recovered).toBe(true);
			h.manager.engineClose("transport close");
			h.manager.engineOpen();
			await waitFor(() => h.connects().length === 3);
			expect(h.connects()[2]?.data).toEqual({ token: "t" });
			h.serverConnect("s3", "p3");
			expect(h.socket.recovered).toBe(false);
			// No event reaches the fresh session before its first loss.
			h.manager.engineClose("transport close");
			h.manager.engineOpen();
			await waitFor(() => h.connects().length === 4);
			// socket.io 4.8.4 restores only when both pid and offset are strings,
			// so the server starts a fresh session instead of replaying packets
			// the earlier sessions delivered.
			expect(h.connects()[3]?.data).toEqual({ pid: "p3", token: "t" });
			expect(
				(h.connects()[3]?.data as { offset?: unknown }).offset,
			).toBeUndefined();
			expect(h.disconnects()).toHaveLength(0);
		});
	});

	// A recovery pid the adapter handed to upstream's CONNECT and the
	// server never confirmed before the engine closed is spent: the server
	// may have restored the session onto the old socket id, and presenting it
	// again would restore that session a second time. a restore the
	// server refuses is confirmed with a new pid, and upstream's `onconnect`
	// keeps the earlier session's `_lastOffset` beside it.
	describe("a presented pid is confirmed or spent; a refused restore keeps no earlier cursor", () => {
		/** A first session p1 with one event (offset-1), then a transport loss. */
		async function lostFirstSession(h: ReturnType<typeof rooms>) {
			h.manager.engineOpen();
			await waitFor(() => h.connects().length === 1);
			h.serverConnect("s1", "p1");
			h.broadcast();
			h.member("keep");
			h.ackJoins();
			h.manager.engineClose("transport close");
		}

		it("a recovery CONNECT whose confirmation is lost before the engine closes is spent: the next CONNECT presents no pid or offset, and the fresh session is `reconnected` and joins live keys once", async () => {
			const h = rooms();
			await lostFirstSession(h);
			h.manager.engineOpen();
			await waitFor(() => h.connects().length === 2);
			// Presented: the server may restore the session on this CONNECT.
			expect(h.connects()[1]?.data).toEqual({
				pid: "p1",
				offset: "offset-1",
				token: "t",
			});
			// Its confirmation never arrives; the engine closes.
			h.manager.engineClose("transport close");
			h.manager.engineOpen();
			await waitFor(() => h.connects().length === 3);
			expect(h.connects()[2]?.data).toEqual({ token: "t" });
			h.serverConnect("s3", "p3");
			expect(h.socket.recovered).toBe(false);
			expect(h.events("join").filter((room) => room === "keep")).toHaveLength(
				2,
			);
			expect(h.finite.continuity).toEqual([
				{ reason: "reconnected" },
				{ reason: "reconnected" },
			]);
			expect(h.finite.errors).toEqual([]);
			expect(h.disconnects()).toHaveLength(0);
		});

		it("control: an engine that closes while the credential request is pending sent no CONNECT, so nothing is spent: the next CONNECT still presents the pid and offset", async () => {
			let hold: Promise<void> = Promise.resolve();
			let release = () => {};
			const h = rooms(async () => {
				await hold;
				return { auth: { token: "t" } };
			});
			await lostFirstSession(h);
			hold = new Promise((resolve) => {
				release = resolve;
			});
			h.manager.engineOpen(); // `auth` asked; the provider has not answered
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(h.connects()).toHaveLength(1);
			h.manager.engineClose("transport close");
			release(); // the stale answer is fenced
			await new Promise((resolve) => setTimeout(resolve, 10));
			h.manager.engineOpen();
			await waitFor(() => h.connects().length === 2);
			expect(h.connects()[1]?.data).toEqual({
				pid: "p1",
				offset: "offset-1",
				token: "t",
			});
			h.serverConnect("s1", "p1");
			expect(h.socket.recovered).toBe(true);
		});

		it("a restore the server refuses is confirmed with a new pid and is not spent: that session's own first loss presents its own pid and cursor", async () => {
			const h = rooms();
			await lostFirstSession(h);
			h.manager.engineOpen();
			await waitFor(() => h.connects().length === 2);
			expect(h.connects()[1]?.data).toEqual({
				pid: "p1",
				offset: "offset-1",
				token: "t",
			});
			// The server refuses the restore: a fresh session with a new pid.
			h.serverConnect("s2", "p2");
			expect(h.socket.recovered).toBe(false);
			h.socket.onpacket({
				type: EVENT,
				nsp: "/chat",
				data: ["room", { room: "elsewhere" }, "offset-2"],
			});
			h.manager.engineClose("transport close");
			h.manager.engineOpen();
			await waitFor(() => h.connects().length === 3);
			expect(h.connects()[2]?.data).toEqual({
				pid: "p2",
				offset: "offset-2",
				token: "t",
			});
			h.serverConnect("s2", "p2");
			expect(h.socket.recovered).toBe(true);
			expect(h.finite.continuity.at(-1)).toEqual({ reason: "recovered" });
		});

		it("a restore the server refuses leaves no earlier cursor: the new session lost before any event presents its own pid without an offset", async () => {
			const h = rooms();
			await lostFirstSession(h);
			h.manager.engineOpen();
			await waitFor(() => h.connects().length === 2);
			expect(h.connects()[1]?.data).toEqual({
				pid: "p1",
				offset: "offset-1",
				token: "t",
			});
			h.serverConnect("s2", "p2");
			expect(h.socket.recovered).toBe(false);
			// No event reaches the new session before its first loss.
			h.manager.engineClose("transport close");
			h.manager.engineOpen();
			await waitFor(() => h.connects().length === 3);
			// socket.io 4.8.4 restores only when both pid and offset are strings:
			// the server starts a fresh session instead of replaying the gap.
			expect(h.connects()[2]?.data).toEqual({ pid: "p2", token: "t" });
			expect(
				(h.connects()[2]?.data as { offset?: unknown }).offset,
			).toBeUndefined();
			expect(h.disconnects()).toHaveLength(0);
		});

		// The same class (every client-initiated connect starts a
		// fresh session): upstream `Manager.socket(nsp)` caches the namespace
		// socket and `disconnect()` never clears `_pid` or `_lastOffset`, so a
		// handle created for a namespace whose Manager another namespace kept
		// alive would present the disposed handle's session.
		it("a replacement handle for a released namespace gets its own socket, and neither socket presents an earlier pid or offset: its first CONNECT starts a fresh session", async () => {
			const adapter = socketIoAdapter();
			const test = createTestContext({
				credentials: () => Promise.resolve({ auth: { token: "t" } }),
			});
			const open = (namespace: string) => {
				const connection = adapter.connect(
					{ url: "https://h.test", namespace, sharing: "shared" },
					test.ctx,
				);
				connections.push(connection);
				connection.subscribe(
					{ event: "room" },
					createRecordingSink<unknown[]>().sink,
					{ key: namespace, repeatable: true },
				);
				return connection;
			};
			const first = open("/chat");
			open("/other"); // keeps the Manager
			expect(scripted.managers).toHaveLength(1);
			const manager = scripted.managers[0] as Scripted & {
				nsps: Record<string, RealSocket>;
			};
			const socket = manager.nsps["/chat"] as RealSocket;
			const connects = () =>
				scripted.packets.filter(
					(packet) => packet.type === CONNECT && packet.nsp === "/chat",
				);
			manager.engineOpen();
			await waitFor(() => connects().length === 1);
			socket.onpacket({
				type: CONNECT,
				nsp: "/chat",
				data: { sid: "s1", pid: "p1" },
			});
			socket.onpacket({
				type: EVENT,
				nsp: "/chat",
				data: ["room", { room: "old" }, "offset-1"],
			});
			// A transport loss; the last consumer of `/chat` leaves meanwhile.
			manager.engineClose("transport close");
			first.dispose();
			manager.engineOpen(); // `/other` reconnects; `/chat` is inactive
			// A new consumer of `/chat`: a new handle, on a socket of its own.
			open("/chat");
			const replacement = manager.nsps["/chat"] as RealSocket;
			expect(replacement, "a socket of its own").not.toBe(socket);
			const released = socket as unknown as {
				_pid?: string;
				_lastOffset?: string;
			};
			expect(released._pid, "the released socket keeps no pid").toBeUndefined();
			expect(released._lastOffset).toBeUndefined();
			await waitFor(() => connects().length === 2);
			expect(connects()[1]?.data).toEqual({ token: "t" });
			replacement.onpacket({
				type: CONNECT,
				nsp: "/chat",
				data: { sid: "s2", pid: "p2" },
			});
			expect(replacement.recovered).toBe(false);
		});

		// Release must clear sendBuffer and auth so another session cannot flush stale commands or retain the old grant.
		describe("a disposed handle's namespace socket holds nothing and is not reused", () => {
			type KeptSocket = RealSocket & { sendBuffer: unknown[]; auth: unknown };

			function kept() {
				const adapter = socketIoAdapter({
					routes: { byRoom: (args) => [(args[0] as { room: string }).room] },
				});
				const open = (namespace: string, token = "t") => {
					const connection = adapter.connect(
						{ url: "https://h.test", namespace, sharing: "shared" },
						createTestContext({
							credentials: () => Promise.resolve({ auth: { token } }),
						}).ctx,
					);
					connections.push(connection);
					return connection;
				};
				const member = (connection: AdapterConnection, room: string) =>
					connection.subscribe(
						{
							event: "room",
							membership: room,
							route: "byRoom",
							join: { event: "join", args: [room] },
							leave: { event: "leave", args: [room] },
						},
						createRecordingSink<unknown[]>().sink,
						{ key: room, repeatable: true },
					);
				const first = open("/chat", "t1");
				// Keeps the Manager.
				open("/other").subscribe(
					{ event: "room" },
					createRecordingSink<unknown[]>().sink,
					{ key: "other", repeatable: true },
				);
				expect(scripted.managers).toHaveLength(1);
				const manager = scripted.managers[0] as Scripted & {
					nsps: Record<string, KeptSocket>;
					engine: { _hasPingExpired: () => boolean };
				};
				const socket = manager.nsps["/chat"] as KeptSocket;
				const ours = (type: number) =>
					scripted.packets.filter(
						(packet) => packet.type === type && packet.nsp === "/chat",
					) as Packet[];
				return {
					first,
					open,
					member,
					manager,
					socket,
					connects: () => ours(CONNECT),
					joins: () =>
						ours(EVENT)
							.map((packet) => packet.data as unknown[])
							.filter((data) => data[0] === "join")
							.map((data) => data[1]),
				};
			}

			it("a join upstream buffered while the heartbeat had expired is dropped at dispose: the replacement handle's session sends only its own join", async () => {
				const h = kept();
				const base = h.member(h.first, "base");
				h.manager.engineOpen();
				await waitFor(() => h.connects().length === 1);
				h.socket.onpacket({ type: CONNECT, nsp: "/chat", data: { sid: "s1" } });
				expect(h.joins()).toEqual(["base"]);
				// A frozen tab: the deadline passed while the socket reads connected.
				h.manager.engine._hasPingExpired = () => true;
				const old = h.member(h.first, "old");
				h.manager.engine._hasPingExpired = () => false;
				expect(
					h.socket.sendBuffer,
					"precondition: upstream buffered the join",
				).toHaveLength(1);
				h.manager.engineClose("ping timeout");
				// The last consumers leave during the outage.
				old.unsubscribe();
				base.unsubscribe();
				h.first.dispose();
				expect.soft(h.socket.sendBuffer).toHaveLength(0);
				h.manager.engineOpen(); // `/other` reconnects; `/chat` is inactive
				const second = h.open("/chat");
				h.member(second, "new");
				const replacement = h.manager.nsps["/chat"] as KeptSocket;
				expect(replacement, "a socket of its own").not.toBe(h.socket);
				expect(h.socket.sendBuffer, "the released one queues nothing").toEqual(
					[],
				);
				await waitFor(() => h.connects().length === 2);
				replacement.onpacket({
					type: CONNECT,
					nsp: "/chat",
					data: { sid: "s2" },
				});
				// Nothing the disposed handle queued reaches the new session.
				expect(h.joins()).toEqual(["base", "new"]);
			});

			it("dispose unbinds the handle's `auth` callback from its socket, so neither the handle nor its grant stays reachable through it; the replacement's own socket binds its own and presents its own grant", async () => {
				const h = kept();
				h.member(h.first, "base");
				h.manager.engineOpen();
				await waitFor(() => h.connects().length === 1);
				expect(h.connects()[0]?.data).toEqual({ token: "t1" });
				expect(typeof h.socket.auth).toBe("function");
				// Confirmed, so the release disconnects at once (a release with the
				// CONNECT unanswered drains it first:).
				h.socket.onpacket({ type: CONNECT, nsp: "/chat", data: { sid: "s1" } });
				h.first.dispose();
				expect(
					typeof h.socket.auth,
					"no disposed handle's callback on the kept socket",
				).not.toBe("function");
				expect(h.socket.auth).toEqual({});
				const second = h.open("/chat", "t2");
				const replacement = h.manager.nsps["/chat"] as KeptSocket;
				expect(replacement, "a socket of its own").not.toBe(h.socket);
				expect(h.socket.auth, "the released socket stays unbound").toEqual({});
				expect(typeof replacement.auth).toBe("function");
				h.member(second, "new");
				await waitFor(() => h.connects().length === 2);
				expect(h.connects()[1]?.data).toEqual({ token: "t2" });
			});
		});

		// An unanswered namespace CONNECT needs a drain listener because disconnect() removes the Socket's packet subscriptions.
		describe("the Manager caches only live handles' sockets; a handshake in flight at release is drained", () => {
			const CONNECT_ERROR = 4;
			/** Test-only oracle: drains and waiters on the connection. */
			const DRAINS = Symbol.for("spinetab.socket-io.drains");
			const drainsOf = (
				connection: AdapterConnection,
			): { drains: number; waiters: number } => {
				const read = (connection as unknown as Record<symbol, unknown>)[DRAINS];
				if (typeof read !== "function") {
					throw new Error("the drains oracle is missing");
				}
				return read.call(connection);
			};
			type LiveSocket = RealSocket & {
				active: boolean;
				auth: unknown;
				sendBuffer: unknown[];
				receiveBuffer: unknown[];
				_pid?: string;
				_lastOffset?: string;
			};

			function drainRig(sibling = true) {
				const adapter = socketIoAdapter();
				const open = (
					namespace: string,
					credentials: () => Promise<Record<string, unknown>> = () =>
						Promise.resolve({ auth: { token: namespace } }),
				) => {
					const connection = adapter.connect(
						{ url: "https://h.test", namespace, sharing: "shared" },
						createTestContext({ credentials }).ctx,
					);
					connections.push(connection);
					connection.subscribe(
						{ event: "room" },
						createRecordingSink<unknown[]>().sink,
						{ key: namespace, repeatable: true },
					);
					return connection;
				};
				const first = open("/chat");
				const other = sibling ? open("/other") : undefined;
				expect(scripted.managers).toHaveLength(1);
				const manager = scripted.managers[0] as Scripted & {
					nsps: Record<string, LiveSocket>;
					listeners: Map<string, Set<unknown>>;
					fire(event: string, ...args: unknown[]): void;
					_readyState: string;
					closes: number;
				};
				const socket = manager.nsps["/chat"] as LiveSocket;
				const packets = () =>
					scripted.packets.filter((packet) => packet.nsp === "/chat");
				return {
					first,
					other,
					open,
					manager,
					socket,
					packets,
					/** The shared connection's drains and their waiters. */
					drains: () => drainsOf(other ?? first),
					/** Manager `packet` listeners: live subscribed sockets and drains. */
					packetListeners: () => manager.listeners.get("packet")?.size ?? 0,
					types: () => packets().map((packet) => packet.type),
					connects: () => packets().filter((packet) => packet.type === CONNECT),
					/** Plays the server through the Manager: a namespace packet. */
					server: (packet: Packet) => manager.fire("packet", packet),
					/** `/other` is live: its handshake confirmed. */
					confirmOther: () =>
						(manager.nsps["/other"] as LiveSocket).onpacket({
							type: CONNECT,
							nsp: "/other",
							data: { sid: "o1" },
						}),
				};
			}

			it("a released namespace socket leaves the Manager's cache while a sibling keeps it; the next handle gets its own socket; the released one holds nothing", async () => {
				// socket.io-client 4.8.4's own Manager keeps the cache in `nsps`,
				// keyed by namespace (private in its typings): the field the
				// adapter evicts from. It fails loudly if upstream renames it.
				const actual =
					await vi.importActual<typeof import("socket.io-client")>(
						"socket.io-client",
					);
				const real = new actual.Manager("http://127.0.0.1:9", {
					autoConnect: false,
				});
				const cached = real.socket("/pinned");
				expect(
					(real as unknown as { nsps: Record<string, unknown> }).nsps,
				).toEqual({ "/pinned": cached });
				const h = drainRig();
				h.manager.engineOpen();
				await waitFor(() => h.connects().length === 1);
				h.confirmOther();
				h.socket.onpacket({
					type: CONNECT,
					nsp: "/chat",
					data: { sid: "s1", pid: "p1" },
				});
				h.socket.onpacket({
					type: EVENT,
					nsp: "/chat",
					data: ["room", { room: "old" }, "offset-1"],
				});
				h.first.dispose();
				expect(h.types().at(-1), "DISCONNECT at once").toBe(DISCONNECT);
				expect(h.manager.nsps["/chat"], "evicted").toBeUndefined();
				expect(h.manager.nsps["/other"]).toBeDefined();
				expect(h.socket.active).toBe(false);
				expect(h.socket.auth).toEqual({});
				expect(h.socket.sendBuffer).toHaveLength(0);
				expect(h.socket._pid).toBeUndefined();
				expect(h.socket._lastOffset).toBeUndefined();
				h.open("/chat", () => Promise.resolve({ auth: { token: "t2" } }));
				const replacement = h.manager.nsps["/chat"] as LiveSocket;
				expect(replacement).toBeInstanceOf(actual.Socket);
				expect(replacement).not.toBe(h.socket);
				await waitFor(() => h.connects().length === 2);
				expect(h.connects()[1]?.data).toEqual({ token: "t2" });
			});

			it("a CONNECT unanswered at release, with a sibling keeping the Manager, is drained: the released socket leaves the Manager's subscriptions at once, nothing is written until the server's reply, then one DISCONNECT through its own writer, and never a second CONNECT", async () => {
				const h = drainRig();
				h.manager.engineOpen();
				await waitFor(() => h.connects().length === 1);
				h.confirmOther();
				const live = h.packetListeners();
				h.first.dispose();
				expect(h.types(), "no DISCONNECT before the reply").toEqual([CONNECT]);
				expect(h.manager.nsps["/chat"], "evicted at release").toBeUndefined();
				// Upstream destroy() semantics: no subscription, so nothing received
				// for the released handle is buffered or delivered.
				expect(h.socket.active, "unsubscribed at release").toBe(false);
				expect(h.drains()).toEqual({ drains: 1, waiters: 0 });
				// The released handle's own observer and its socket's subscription
				// are gone; one handshake observer holds the drain.
				const draining = h.packetListeners();
				expect(draining).toBe(live - 1);
				h.server({ type: CONNECT, nsp: "/chat", data: { sid: "s1" } });
				expect(h.types()).toEqual([CONNECT, DISCONNECT]);
				expect(h.drains()).toEqual({ drains: 0, waiters: 0 });
				expect(h.packetListeners(), "the observer is gone").toBe(draining - 1);
				expect(h.socket.connected, "the reply never reached the socket").toBe(
					false,
				);
				expect(h.socket._pid).toBeUndefined();
				h.manager.engineClose("transport close");
				h.manager.engineOpen();
				await new Promise((resolve) => setTimeout(resolve, 10));
				expect(h.types(), "never a second CONNECT").toEqual([
					CONNECT,
					DISCONNECT,
				]);
			});

			it("a handle opened while a released handle's CONNECT drains writes no CONNECT while that handshake's DISCONNECT is owed, and writes it right after the DISCONNECT, with no heartbeat", async () => {
				const h = drainRig();
				h.manager.engineOpen();
				await waitFor(() => h.connects().length === 1);
				h.confirmOther();
				h.first.dispose();
				h.open("/chat", () => Promise.resolve({ auth: { token: "t2" } }));
				const successor = h.manager.nsps["/chat"] as LiveSocket;
				expect(successor).not.toBe(h.socket);
				await new Promise((resolve) => setTimeout(resolve, 10));
				expect(h.types(), "no CONNECT while unanswered").toEqual([CONNECT]);
				expect(
					successor.active,
					"not subscribed while it waits, so it buffers nothing",
				).toBe(false);
				expect(h.drains()).toEqual({ drains: 1, waiters: 1 });
				h.server({ type: CONNECT, nsp: "/chat", data: { sid: "s1" } });
				// No heartbeat is fired: the DISCONNECT written is the only gate.
				await waitFor(() => h.connects().length === 2);
				expect(h.types()).toEqual([CONNECT, DISCONNECT, CONNECT]);
				expect(h.connects()[1]?.data).toEqual({ token: "t2" });
				expect(h.drains()).toEqual({ drains: 0, waiters: 0 });
				successor.onpacket({
					type: CONNECT,
					nsp: "/chat",
					data: { sid: "s2" },
				});
				expect(successor.connected).toBe(true);
			});

			it("a Manager close while the drain waits settles it before any reconnect: the released socket, unsubscribed since its release, writes nothing, and a waiting handle connects on the new engine", async () => {
				const h = drainRig();
				h.manager.engineOpen();
				await waitFor(() => h.connects().length === 1);
				h.confirmOther();
				h.first.dispose();
				expect(h.socket.active, "unsubscribed at release").toBe(false);
				h.open("/chat", () => Promise.resolve({ auth: { token: "t2" } }));
				h.manager.engineClose("transport close");
				expect(h.drains(), "settled at the close").toEqual({
					drains: 0,
					waiters: 0,
				});
				h.manager.engineOpen();
				await waitFor(() => h.connects().length === 2);
				await new Promise((resolve) => setTimeout(resolve, 10));
				expect(h.types(), "only the waiting handle's CONNECT").toEqual([
					CONNECT,
					CONNECT,
				]);
				expect(h.connects()[1]?.data).toEqual({ token: "t2" });
			});

			it("a CONNECT_ERROR for the drained handshake settles the drain at once; nothing is written for it", async () => {
				const h = drainRig();
				h.manager.engineOpen();
				await waitFor(() => h.connects().length === 1);
				h.confirmOther();
				h.first.dispose();
				h.open("/chat", () => Promise.resolve({ auth: { token: "t2" } }));
				await new Promise((resolve) => setTimeout(resolve, 10));
				expect(h.types()).toEqual([CONNECT]);
				h.server({
					type: CONNECT_ERROR,
					nsp: "/chat",
					data: { message: "refused" },
				});
				expect(h.socket.active).toBe(false);
				await waitFor(() => h.connects().length === 2);
				expect(h.types()).toEqual([CONNECT, CONNECT]);
			});

			it("controls: a confirmed release disconnects at once; without a sibling nothing drains; a release during a pending credential request wrote no CONNECT; a later handle then connects at once", async () => {
				// Confirmed: DISCONNECT at release; a later handle does not wait.
				const confirmed = drainRig();
				confirmed.manager.engineOpen();
				await waitFor(() => confirmed.connects().length === 1);
				confirmed.confirmOther();
				confirmed.socket.onpacket({
					type: CONNECT,
					nsp: "/chat",
					data: { sid: "s1" },
				});
				confirmed.first.dispose();
				expect(confirmed.types()).toEqual([CONNECT, DISCONNECT]);
				expect(confirmed.drains(), "nothing retained").toEqual({
					drains: 0,
					waiters: 0,
				});
				confirmed.open("/chat");
				await waitFor(() => confirmed.connects().length === 2);
				scripted.packets.length = 0;
				scripted.managers.length = 0;
				// No sibling: the release destroys the socket at once (upstream
				// then closes the Manager and its engine); nothing drains.
				const alone = drainRig(false);
				alone.manager.engineOpen();
				await waitFor(() => alone.connects().length === 1);
				alone.first.dispose();
				expect(alone.socket.active).toBe(false);
				expect(alone.manager.nsps["/chat"]).toBeUndefined();
				alone.server({ type: CONNECT, nsp: "/chat", data: { sid: "s1" } });
				expect(alone.types()).toEqual([CONNECT]);
				scripted.packets.length = 0;
				scripted.managers.length = 0;
				// Pending credential: no CONNECT was written, so nothing drains.
				let grant = () => {};
				const adapter = socketIoAdapter();
				const pending = adapter.connect(
					{ url: "https://h.test", namespace: "/chat", sharing: "shared" },
					createTestContext({
						credentials: () =>
							new Promise((resolve) => {
								grant = () => resolve({ auth: { token: "late" } });
							}),
					}).ctx,
				);
				connections.push(pending);
				pending.subscribe({ event: "room" }, createRecordingSink().sink, {
					key: "p",
					repeatable: true,
				});
				const other = adapter.connect(
					{ url: "https://h.test", namespace: "/other", sharing: "shared" },
					createTestContext({
						credentials: () => Promise.resolve({ auth: {} }),
					}).ctx,
				);
				connections.push(other);
				other.subscribe({ event: "room" }, createRecordingSink().sink, {
					key: "o",
					repeatable: true,
				});
				const manager = scripted.managers[0] as Scripted & {
					nsps: Record<string, LiveSocket>;
				};
				const released = manager.nsps["/chat"] as LiveSocket;
				manager.engineOpen();
				await new Promise((resolve) => setTimeout(resolve, 10));
				const chat = () =>
					scripted.packets.filter((packet) => packet.nsp === "/chat");
				expect(chat()).toEqual([]);
				pending.dispose();
				expect(released.active).toBe(false);
				expect(drainsOf(other), "nothing drains").toEqual({
					drains: 0,
					waiters: 0,
				});
				grant();
				const next = adapter.connect(
					{ url: "https://h.test", namespace: "/chat", sharing: "shared" },
					createTestContext({
						credentials: () => Promise.resolve({ auth: { token: "next" } }),
					}).ctx,
				);
				connections.push(next);
				next.subscribe({ event: "room" }, createRecordingSink().sink, {
					key: "n",
					repeatable: true,
				});
				await waitFor(() => chat().length === 1);
				expect(chat()[0]?.data).toEqual({ token: "next" });
			});

			// A subscribed, unconnected upstream socket pushes every EVENT
			// for its namespace into `receiveBuffer` (onevent, socket.js
			// 530-543) until its CONNECT: a drained socket kept subscribed would
			// buffer late traffic without bound.
			it("a released socket buffers nothing the server sends before the drained handshake's reply: its earlier buffer is released at release, the Manager decodes the late events and nothing keeps them, and the late reply is answered by one DISCONNECT", async () => {
				const h = drainRig();
				h.manager.engineOpen();
				await waitFor(() => h.connects().length === 1);
				h.confirmOther();
				h.server({ type: EVENT, nsp: "/chat", data: ["room", { seq: 0 }] });
				expect(
					h.socket.receiveBuffer,
					"precondition: upstream buffered an event before the reply",
				).toHaveLength(1);
				h.first.dispose();
				expect(h.socket.receiveBuffer, "released at release").toHaveLength(0);
				for (let seq = 1; seq <= 32; seq += 1) {
					h.server({
						type: EVENT,
						nsp: "/chat",
						data: ["room", { seq, payload: "x".repeat(1_024) }],
					});
				}
				expect(
					h.socket.receiveBuffer,
					"nothing buffered for the released handle",
				).toHaveLength(0);
				expect(h.types(), "nothing written").toEqual([CONNECT]);
				expect(h.drains()).toEqual({ drains: 1, waiters: 0 });
				h.server({ type: CONNECT, nsp: "/chat", data: { sid: "s1" } });
				expect(h.types()).toEqual([CONNECT, DISCONNECT]);
				expect(h.socket.receiveBuffer).toHaveLength(0);
				expect(h.drains()).toEqual({ drains: 0, waiters: 0 });
			});

			// a waiter registers on the drain and unregisters at its own
			// release, whether or not the drained handshake is ever answered.
			it("a handle released while it waits behind a drain unregisters at once: its credential provider is never called and nothing is written for it; only a live waiter resumes after the reply's DISCONNECT", async () => {
				const h = drainRig();
				h.manager.engineOpen();
				await waitFor(() => h.connects().length === 1);
				h.confirmOther();
				h.first.dispose();
				let asked = 0;
				const provider = (token: string) => () => {
					asked += 1;
					return Promise.resolve({ auth: { token } });
				};
				for (let n = 0; n < 4; n += 1) {
					const waiter = h.open("/chat", provider(`cancelled-${n}`));
					expect(h.drains(), `waiter ${n} registered`).toEqual({
						drains: 1,
						waiters: 1,
					});
					waiter.dispose();
					expect(h.drains(), `waiter ${n} unregistered at release`).toEqual({
						drains: 1,
						waiters: 0,
					});
				}
				h.open("/chat", provider("live"));
				expect(h.drains()).toEqual({ drains: 1, waiters: 1 });
				await new Promise((resolve) => setTimeout(resolve, 10));
				expect(asked, "no provider called while the DISCONNECT is owed").toBe(
					0,
				);
				expect(h.types()).toEqual([CONNECT]);
				h.server({ type: CONNECT, nsp: "/chat", data: { sid: "s1" } });
				await waitFor(() => h.connects().length === 2);
				await new Promise((resolve) => setTimeout(resolve, 10));
				expect(
					h.types(),
					"the reply's DISCONNECT, then the live waiter's CONNECT only",
				).toEqual([CONNECT, DISCONNECT, CONNECT]);
				expect(h.connects()[1]?.data).toEqual({ token: "live" });
				expect(asked, "only the live waiter's provider").toBe(1);
				expect(h.drains()).toEqual({ drains: 0, waiters: 0 });
			});

			// drains share the connection's retention bound (64,
			// as for retired memberships); beyond it the whole client restarts,
			// so the server releases every namespace it held for it.
			it("at most 64 released handshakes drain on one shared connection; the 65th restarts the whole client: every drain settles, the Manager closes and reopens, the sibling presents no pid, reports the loss at detection and `reconnected` before its restored `connected`, ends its non-repeatable record `interrupted` with one payload-free diagnostic, a live waiter connects on the new engine and no late reply is answered", async () => {
				const adapter = socketIoAdapter();
				const keepTest = createTestContext({
					credentials: () => Promise.resolve({ auth: { token: "keep" } }),
				});
				const keep = adapter.connect(
					{ url: "https://h.test", namespace: "/keep", sharing: "shared" },
					keepTest.ctx,
				);
				connections.push(keep);
				const lasting = createRecordingSink<unknown[]>();
				const once = createRecordingSink<unknown[]>();
				keep.subscribe({ event: "pulse" }, lasting.sink, {
					key: "lasting",
					repeatable: true,
				});
				keep.subscribe({ event: "once" }, once.sink, {
					key: "once",
					repeatable: false,
				});
				expect(scripted.managers).toHaveLength(1);
				const manager = scripted.managers[0] as Scripted & {
					nsps: Record<string, LiveSocket>;
					listeners: Map<string, Set<unknown>>;
					fire(event: string, ...args: unknown[]): void;
					_readyState: string;
					closes: number;
				};
				const keepSocket = manager.nsps["/keep"] as LiveSocket;
				const packetsOf = (nsp: string) =>
					scripted.packets.filter((packet) => packet.nsp === nsp);
				manager.engineOpen();
				await waitFor(() => packetsOf("/keep").length === 1);
				keepSocket.onpacket({
					type: CONNECT,
					nsp: "/keep",
					data: { sid: "k1", pid: "pk1" },
				});
				expect(keepTest.lastStatus()?.state).toBe("connected");
				const baseline = manager.listeners.get("packet")?.size ?? 0;
				const open = (namespace: string, token = namespace) => {
					const handle = adapter.connect(
						{ url: "https://h.test", namespace, sharing: "shared" },
						createTestContext({
							credentials: () => Promise.resolve({ auth: { token } }),
						}).ctx,
					);
					connections.push(handle);
					handle.subscribe(
						{ event: "room" },
						createRecordingSink<unknown[]>().sink,
						{ key: namespace, repeatable: true },
					);
					return handle;
				};
				const released: LiveSocket[] = [];
				for (let n = 0; n < 65; n += 1) {
					const namespace = `/p-${n}`;
					const handle = open(namespace);
					released.push(manager.nsps[namespace] as LiveSocket);
					await waitFor(() => packetsOf(namespace).length === 1);
					handle.dispose();
					if (n === 0) open("/p-0", "waiter"); // waits behind /p-0's drain
					if (n < 64) {
						expect(drainsOf(keep), `${namespace}: held`).toEqual({
							drains: n + 1,
							waiters: 1,
						});
						expect(manager.closes).toBe(0);
					}
				}
				expect(manager.closes, "one whole-client restart").toBe(1);
				expect(manager._readyState, "reopened at once").toBe("opening");
				expect(drainsOf(keep), "every drain settled").toEqual({
					drains: 0,
					waiters: 0,
				});
				expect(
					manager.listeners.get("packet")?.size,
					"no drain observer remains: the sibling's, and the live waiter's own",
				).toBe(baseline + 1);
				expect(released.every((socket) => !socket.active)).toBe(true);
				expect(
					keepTest.diagnostics
						.filter(
							(diagnostic) =>
								diagnostic.type === "membership-cleanup-uncertain",
						)
						.map((diagnostic) => diagnostic.detail),
				).toEqual([{ reason: "drain-overflow" }]);
				expect(once.errors.map((error) => error.code)).toEqual(["interrupted"]);
				expect(
					lasting.continuity.map((notice) => notice.reason),
					"the loss at detection",
				).toEqual(["reconnected"]);
				expect(keepTest.lastStatus()?.state).toBe("reconnecting");
				manager.engineOpen();
				await waitFor(
					() =>
						packetsOf("/keep").length === 2 && packetsOf("/p-0").length === 2,
				);
				expect(
					packetsOf("/keep")[1]?.data,
					"a fresh session: no pid or offset",
				).toEqual({ token: "keep" });
				expect(packetsOf("/p-0")[1]?.data, "the live waiter").toEqual({
					token: "waiter",
				});
				keepSocket.onpacket({
					type: CONNECT,
					nsp: "/keep",
					data: { sid: "k2", pid: "pk2" },
				});
				expect(
					lasting.continuity.map((notice) => notice.reason),
					"the outcome before the restored `connected`",
				).toEqual(["reconnected", "reconnected"]);
				expect(keepTest.lastStatus()?.state).toBe("connected");
				// A reply for a drained handshake is never answered after the restart.
				manager.fire("packet", {
					type: CONNECT,
					nsp: "/p-3",
					data: { sid: "x" },
				});
				expect(packetsOf("/p-3").map((packet) => packet.type)).toEqual([
					CONNECT,
				]);
			});

			// A fresh CONNECT has no replay; buffered events belong to another session and must be discarded before upstream flushes them.
			it("VG7-S1: at a connect without recovery, events upstream buffered before the reply belong to another session and are neither delivered nor kept as the cursor; a restored session still delivers its replayed packets once", async () => {
				const adapter = socketIoAdapter();
				const test = createTestContext({
					credentials: () => Promise.resolve({ auth: { token: "bob" } }),
				});
				const connection = adapter.connect(
					{ url: "https://h.test", namespace: "/chat", sharing: "shared" },
					test.ctx,
				);
				connections.push(connection);
				const sink = createRecordingSink<unknown[]>();
				connection.subscribe({ event: "notice" }, sink.sink, {
					key: "notice",
					repeatable: true,
				});
				const manager = scripted.managers[0] as Scripted & {
					nsps: Record<string, LiveSocket>;
					fire(event: string, ...args: unknown[]): void;
				};
				const socket = manager.nsps["/chat"] as LiveSocket;
				const connects = () =>
					scripted.packets.filter(
						(packet) => packet.type === CONNECT && packet.nsp === "/chat",
					);
				const seen = () => sink.events.map((args) => args[0]);
				manager.engineOpen();
				await waitFor(() => connects().length === 1);
				manager.fire("packet", {
					type: EVENT,
					nsp: "/chat",
					data: ["notice", { to: "alice" }, "offset-7"],
				});
				expect(socket.receiveBuffer, "precondition: buffered").toHaveLength(1);
				// The reply arrives through the Manager, as every packet does.
				manager.fire("packet", {
					type: CONNECT,
					nsp: "/chat",
					data: { sid: "s2", pid: "p2" },
				});
				expect(socket.recovered).toBeFalsy();
				expect(seen(), "nothing buffered before the reply").toEqual([]);
				expect(socket._lastOffset, "nor kept as the cursor").toBeUndefined();
				manager.fire("packet", {
					type: EVENT,
					nsp: "/chat",
					data: ["notice", { to: "bob", seq: 1 }, "offset-8"],
				});
				expect(seen()).toEqual([{ to: "bob", seq: 1 }]);
				expect(socket._lastOffset).toBe("offset-8");
				// A transport loss; the server restores the session and writes the
				// missed packet before its reply: delivered once.
				manager.engineClose("transport close");
				manager.engineOpen();
				await waitFor(() => connects().length === 2);
				expect(connects()[1]?.data).toEqual({
					pid: "p2",
					offset: "offset-8",
					token: "bob",
				});
				manager.fire("packet", {
					type: EVENT,
					nsp: "/chat",
					data: ["notice", { to: "bob", seq: 2 }, "offset-9"],
				});
				manager.fire("packet", {
					type: CONNECT,
					nsp: "/chat",
					data: { sid: "s2", pid: "p2" },
				});
				expect(socket.recovered).toBe(true);
				expect(seen(), "the replayed packet, once").toEqual([
					{ to: "bob", seq: 1 },
					{ to: "bob", seq: 2 },
				]);
				expect(sink.continuity.map((notice) => notice.reason)).toEqual([
					"reconnected",
					"recovered",
				]);
			});

			it("VG7-S1: after rotate(), events of the ended session that arrive before the new session's reply are not delivered", async () => {
				const adapter = socketIoAdapter();
				const connection = adapter.connect(
					{ url: "https://h.test", namespace: "/chat", sharing: "shared" },
					createTestContext({
						credentials: () => Promise.resolve({ auth: { token: "t" } }),
					}).ctx,
				);
				connections.push(connection);
				const sink = createRecordingSink<unknown[]>();
				connection.subscribe({ event: "notice" }, sink.sink, {
					key: "notice",
					repeatable: true,
				});
				const manager = scripted.managers[0] as Scripted & {
					nsps: Record<string, LiveSocket>;
					fire(event: string, ...args: unknown[]): void;
				};
				const socket = manager.nsps["/chat"] as LiveSocket;
				const types = () =>
					scripted.packets
						.filter((packet) => packet.nsp === "/chat")
						.map((packet) => packet.type);
				manager.engineOpen();
				await waitFor(() => types().length === 1);
				socket.onpacket({ type: CONNECT, nsp: "/chat", data: { sid: "s1" } });
				manager.fire("packet", {
					type: EVENT,
					nsp: "/chat",
					data: ["notice", { session: 1 }],
				});
				connection.rotate?.();
				// The ended session's server socket, until the server applies the
				// DISCONNECT: its traffic reaches the re-subscribed socket.
				manager.fire("packet", {
					type: EVENT,
					nsp: "/chat",
					data: ["notice", { session: 1, late: true }],
				});
				await waitFor(() => types().length === 3);
				expect(types()).toEqual([CONNECT, DISCONNECT, CONNECT]);
				expect(socket.receiveBuffer, "precondition: buffered").toHaveLength(1);
				manager.fire("packet", {
					type: CONNECT,
					nsp: "/chat",
					data: { sid: "s2" },
				});
				manager.fire("packet", {
					type: EVENT,
					nsp: "/chat",
					data: ["notice", { session: 2 }],
				});
				expect(sink.events.map((args) => args[0])).toEqual([
					{ session: 1 },
					{ session: 2 },
				]);
			});
		});
	});
});

// Use real upstream sockets to verify acknowledgement numbering across replacements and session fencing for delayed responders.
describe("acknowledgements belong to the session that asked", () => {
	const CONNECT = 0;
	const DISCONNECT = 1;
	const EVENT = 2;
	const ACK = 3;
	type Packet = { type: number; nsp: string; id?: number; data?: unknown };
	type AckSocket = {
		id?: string;
		ids: number;
		acks: Record<number, unknown>;
		connected: boolean;
		sendBuffer: Packet[];
		onpacket(packet: Packet): void;
		emit(event: string, ...args: unknown[]): unknown;
	};

	function ackRig() {
		/** The worker's pending answers to `ask`, settled by the test. */
		const asks: Array<{ answer(value: unknown): void; fail(): void }> = [];
		const adapter = socketIoAdapter({
			routes: { byRoom: (args) => [(args[0] as { room: string }).room] },
			responders: {
				ask: () =>
					new Promise((resolve, reject) =>
						asks.push({
							answer: resolve,
							fail: () => reject(new Error("synthetic responder failure")),
						}),
					),
			},
		});
		const open = (
			namespace: string,
			spec: SocketIoSubscriptionSpec = { event: "ask" },
		) => {
			const test = createTestContext({
				credentials: () => Promise.resolve({ auth: { token: namespace } }),
			});
			const connection = adapter.connect(
				{ url: "https://h.test", namespace, sharing: "shared" },
				test.ctx,
			);
			connections.push(connection);
			const sink = createRecordingSink<unknown[]>();
			connection.subscribe(spec, sink.sink, {
				key: namespace,
				repeatable: true,
			});
			return { connection, test, sink };
		};
		const manager = () =>
			scripted.managers.at(-1) as Scripted & {
				nsps: Record<string, AckSocket>;
				fire(event: string, ...args: unknown[]): void;
			};
		const ours = (namespace: string, type: number) =>
			scripted.packets.filter(
				(packet) => packet.nsp === namespace && packet.type === type,
			) as Packet[];
		return {
			asks,
			open,
			manager,
			socket: (namespace: string) => manager().nsps[namespace] as AckSocket,
			ours,
			connects: (namespace: string) => ours(namespace, CONNECT),
			/** Plays the server: the namespace CONNECT reply (a pid with recovery). */
			confirm: (namespace: string, sid: string, pid?: string) =>
				(manager().nsps[namespace] as AckSocket).onpacket({
					type: CONNECT,
					nsp: namespace,
					data: pid ? { sid, pid } : { sid },
				}),
			/** Plays the server through the Manager: a namespace packet. */
			server: (packet: Packet) => manager().fire("packet", packet),
			command: (
				handle: ReturnType<typeof open>,
				event: string,
				token: string,
			): Promise<unknown> => {
				const outcome = handle.connection.command?.(
					{ event, args: [token], ack: true },
					{
						id: `${event}:${token}`,
						signal: handle.test.ctx.signal,
						timeoutMs: 1_000,
					},
				);
				if (!outcome) throw new Error("the adapter has no command()");
				return outcome;
			},
		};
	}

	/** `/chat` and its sibling `/other` connected on one engine. */
	async function connected(
		h: ReturnType<typeof ackRig>,
		chatSpec?: SocketIoSubscriptionSpec,
		chatPid?: string,
	) {
		const chat = h.open("/chat", chatSpec);
		const other = h.open("/other");
		expect(scripted.managers).toHaveLength(1);
		h.manager().engineOpen();
		await waitFor(
			() =>
				h.connects("/chat").length === 1 && h.connects("/other").length === 1,
		);
		h.confirm("/chat", "s1", chatPid);
		h.confirm("/other", "o1");
		return { chat, other };
	}

	it("pin: socket.io-client 4.8.4 numbers a Socket's acknowledgements from `ids` (0 for a new Socket), takes `ids++` per emit and drops an ACK whose id matches nothing, without a call or an error", async () => {
		const actual =
			await vi.importActual<typeof import("socket.io-client")>(
				"socket.io-client",
			);
		const real = new actual.Manager("http://127.0.0.1:9", {
			autoConnect: false,
		});
		const socket = real.socket("/pinned") as unknown as AckSocket;
		expect(socket.ids, "a new Socket numbers from 0").toBe(0);
		const calls: unknown[] = [];
		socket.emit("first", (value: unknown) => calls.push(["first", value]));
		expect(socket.ids).toBe(1);
		expect(typeof socket.acks[0]).toBe("function");
		// The field the adapter continues on a new Socket.
		socket.ids = 7;
		socket.emit("second", (value: unknown) => calls.push(["second", value]));
		expect(socket.sendBuffer.map((packet) => packet.id)).toEqual([0, 7]);
		expect(() =>
			socket.onpacket({ type: ACK, nsp: "/pinned", id: 3, data: ["stray"] }),
		).not.toThrow();
		expect(calls, "an unmatched ACK calls nothing").toEqual([]);
		socket.onpacket({ type: ACK, nsp: "/pinned", id: 7, data: ["mine"] });
		expect(calls).toEqual([["second", "mine"]]);
	});

	it("a new namespace Socket starts above the highest id a released Socket used: late ACKs owed to the released handle match nothing and upstream drops them, and the successor's command resolves with its own result", async () => {
		const h = ackRig();
		const { chat } = await connected(h);
		const released = h.socket("/chat");
		const first = h.command(chat, "slow", "A");
		void h.command(chat, "slow", "B");
		expect(h.ours("/chat", EVENT).map((packet) => packet.id)).toEqual([0, 1]);
		chat.connection.dispose();
		expect(await first).toMatchObject({
			status: "unknown",
			error: { detail: { reason: "worker-lost" } },
		});
		expect(h.ours("/chat", DISCONNECT)).toHaveLength(1);
		const chat2 = h.open("/chat");
		const successor = h.socket("/chat");
		expect(successor, "a Socket of its own").not.toBe(released);
		expect(successor.ids, "above the highest released id").toBe(2);
		await waitFor(() => h.connects("/chat").length === 2);
		h.confirm("/chat", "s2");
		let settled: unknown;
		const second = h.command(chat2, "work", "A2").then((outcome) => {
			settled = outcome;
			return outcome;
		});
		expect(h.ours("/chat", EVENT).map((packet) => packet.id)).toEqual([
			0, 1, 2,
		]);
		// The server answers the released handle's commands late.
		h.server({ type: ACK, nsp: "/chat", id: 0, data: [{ token: "A" }] });
		h.server({ type: ACK, nsp: "/chat", id: 1, data: [{ token: "B" }] });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(settled, "the late ACKs settled nothing").toBeUndefined();
		expect(chat2.sink.errors).toEqual([]);
		h.server({ type: ACK, nsp: "/chat", id: 2, data: [{ token: "A2" }] });
		expect(await second).toEqual({
			status: "acknowledged",
			value: { token: "A2" },
		});
	});

	it("joins share the numbering: a released handle's late join acknowledgement does not confirm the successor's join, so nothing reaches it before its own acknowledgement", async () => {
		const h = ackRig();
		const member: SocketIoSubscriptionSpec = {
			event: "room",
			membership: "r1",
			route: "byRoom",
			join: { event: "join", args: ["r1"] },
			leave: { event: "leave", args: ["r1"] },
		};
		const { chat } = await connected(h, member);
		expect(h.ours("/chat", EVENT).map((packet) => packet.id)).toEqual([0]);
		chat.connection.dispose();
		const chat2 = h.open("/chat", member);
		await waitFor(() => h.connects("/chat").length === 2);
		h.confirm("/chat", "s2");
		const joins = h.ours("/chat", EVENT);
		expect(joins.map((packet) => packet.id)).toEqual([0, 1]);
		// The released handle's join is answered late.
		h.server({ type: ACK, nsp: "/chat", id: 0, data: [{ ok: true }] });
		h.server({
			type: EVENT,
			nsp: "/chat",
			data: ["room", { room: "r1", n: 1 }],
		});
		expect(chat2.sink.events, "not joined yet: nothing delivered").toEqual([]);
		h.server({ type: ACK, nsp: "/chat", id: 1, data: [{ ok: true }] });
		h.server({
			type: EVENT,
			nsp: "/chat",
			data: ["room", { room: "r1", n: 2 }],
		});
		expect(chat2.sink.events).toEqual([[{ room: "r1", n: 2 }]]);
	});

	it("the numbering survives a Manager reconnect (the live Socket keeps its ids) and is reset only with the Manager: a handle on a new Manager numbers from 0", async () => {
		const h = ackRig();
		const { chat, other } = await connected(h);
		const socket = h.socket("/chat");
		const fast = h.command(chat, "fast", "A0");
		h.server({ type: ACK, nsp: "/chat", id: 0, data: [{ token: "A0" }] });
		expect(await fast).toEqual({
			status: "acknowledged",
			value: { token: "A0" },
		});
		h.manager().engineClose("transport close");
		h.manager().engineOpen();
		await waitFor(() => h.connects("/chat").length === 2);
		h.confirm("/chat", "s2");
		expect(h.socket("/chat"), "the same Socket after the reconnect").toBe(
			socket,
		);
		void h.command(chat, "slow", "A");
		expect(h.ours("/chat", EVENT).map((packet) => packet.id)).toEqual([0, 1]);
		chat.connection.dispose();
		const chat2 = h.open("/chat");
		expect(h.socket("/chat").ids).toBe(2);
		// Every handle released: the Manager and its numbering go with it.
		chat2.connection.dispose();
		other.connection.dispose();
		h.open("/chat");
		expect(scripted.managers).toHaveLength(2);
		expect(h.socket("/chat").ids, "a new Manager numbers from 0").toBe(0);
	});

	const FAILED = {
		type: "socket-io.responder-failed",
		detail: { event: "ask" },
	};
	for (const leg of [
		"after its handle's release",
		"after the engine closed and a new session connected",
		"after the engine closed and the server restored the session",
		"after the server's namespace disconnect",
		"after rotate() started a new session",
		"in time (control)",
	] as const) {
		const control = leg === "in time (control)";
		const anew =
			leg !== "after its handle's release" && !leg.includes("namespace");
		for (const outcome of ["success", "failure"] as const) {
			it(`a responder's ${outcome} ${leg} ${
				!control
					? "writes no ACK and reports nothing"
					: outcome === "success"
						? "writes its ACK once"
						: "reports one payload-free diagnostic and writes no ACK"
			} (VG7R2-R1)`, async () => {
				const h = ackRig();
				const { chat } = await connected(h, undefined, "p1");
				h.server({ type: EVENT, nsp: "/chat", id: 7, data: ["ask", { q: 1 }] });
				await waitFor(() => h.asks.length === 1, {
					message: "the responder was asked",
				});
				// The server's reply: the pid it restored, or a new session's.
				const reconnect = async (sid: string, pid: string) => {
					await waitFor(() => h.connects("/chat").length === 2);
					h.confirm("/chat", sid, pid);
				};
				if (leg === "after its handle's release") {
					chat.connection.dispose();
				} else if (leg === "after the server's namespace disconnect") {
					h.server({ type: DISCONNECT, nsp: "/chat" });
					expect(chat.test.lastStatus()?.state).toBe("failed");
				} else if (leg === "after rotate() started a new session") {
					chat.connection.rotate?.();
					await reconnect("s2", "p2");
				} else if (!control) {
					h.manager().engineClose("transport close");
					h.manager().engineOpen();
					const restored = leg.includes("restored");
					await reconnect(restored ? "s1" : "s2", restored ? "p1" : "p2");
					// The pid was presented and, restored, matched (`recovered`).
					expect(h.connects("/chat")[1]?.data).toMatchObject({ pid: "p1" });
					expect(chat.sink.continuity.at(-1)).toEqual({
						reason: restored ? "recovered" : "reconnected",
					});
				}
				if (outcome === "success") h.asks[0]?.answer({ answer: 1 });
				else h.asks[0]?.fail();
				await new Promise((resolve) => setTimeout(resolve, 0));
				expect(h.ours("/chat", ACK)).toEqual(
					control && outcome === "success"
						? [{ type: ACK, nsp: "/chat", id: 7, data: [{ answer: 1 }] }]
						: [],
				);
				expect(
					chat.test.diagnostics.filter(
						(diagnostic) => diagnostic.type === FAILED.type,
					),
				).toEqual(control && outcome === "failure" ? [FAILED] : []);
				if (anew && !control) {
					// The next session's own question is answered once.
					h.server({
						type: EVENT,
						nsp: "/chat",
						id: 8,
						data: ["ask", { q: 2 }],
					});
					await waitFor(() => h.asks.length === 2);
					h.asks[1]?.answer({ answer: 2 });
					await new Promise((resolve) => setTimeout(resolve, 0));
					expect(h.ours("/chat", ACK)).toEqual([
						{ type: ACK, nsp: "/chat", id: 8, data: [{ answer: 2 }] },
					]);
					expect(
						chat.test.diagnostics.filter(
							(diagnostic) => diagnostic.type === FAILED.type,
						),
					).toEqual([]);
				}
			});
		}
	}
});
