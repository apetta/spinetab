import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterConnection } from "../../../src/core/adapter.ts";
import { SpinetabError } from "../../../src/core/errors.ts";
import type {
	CommandOutcome,
	SpinetabErrorCode,
} from "../../../src/core/types.ts";
import { resolveEndpoint } from "../../../src/core/url.ts";
import { socketIo } from "../../../src/protocols/socket-io/index.ts";
import { socketIoAdapter } from "../../../src/protocols/socket-io/runtime.ts";
import {
	createRecordingSink,
	createTestContext,
	waitFor,
} from "../../integration/protocols/helpers.ts";

// with a scripted `Manager`: which URI the Manager is created with,
// which namespace socket it hands out, how Managers are shared, and how one
// event is routed to several membership keys. Live socket behaviour is
// covered against real servers in tests/integration/protocols/socket-io.test.ts.

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
		/** Upstream's recovery session id: sent with the next CONNECT while set. */
		_pid: string | undefined = "pid-1";
		/** Deliberate `disconnect()` calls (a DISCONNECT packet when connected). */
		disconnects = 0;
		readonly sendBuffer: unknown[] = [];
		/**
		 * Every emit in order; `ack` is set for acknowledged emits and answers
		 * once. `buffered` marks a packet upstream holds in its send buffer.
		 */
		readonly emits: Array<{
			event: string;
			args: unknown[];
			ack?: (...values: unknown[]) => void;
			settled?: boolean;
			buffered?: boolean;
		}> = [];
		constructor(readonly nsp: string) {
			super();
		}
		timeout(_ms: number) {
			return {
				emit: (event: string, ...rest: unknown[]) => {
					const callback = rest.at(-1) as (...values: unknown[]) => void;
					const entry: (typeof this.emits)[number] = {
						event,
						args: rest.slice(0, -1),
					};
					entry.ack = (...values: unknown[]) => {
						if (entry.settled) return;
						entry.settled = true;
						callback(...values);
					};
					this.emits.push(entry);
				},
			};
		}
		emit(event: string, ...args: unknown[]): this {
			this.emits.push({ event, args });
			return this;
		}
		connect(): this {
			this.active = true;
			return this;
		}
		/** Upstream `disconnect()`: `io client disconnect`, then `_clearAcks`. */
		disconnect(): this {
			const wasConnected = this.connected;
			this.disconnects += wasConnected ? 1 : 0;
			this.active = false;
			this.connected = false;
			if (wasConnected) {
				this.fire("disconnect", "io client disconnect");
				this.clearAcks();
			}
			return this;
		}
		/** Upstream `_clearAcks`: pending acks error, except buffered packets'. */
		clearAcks(): void {
			for (const emit of this.emits) {
				if (emit.ack && !emit.settled && !emit.buffered) {
					emit.ack(new Error("socket has been disconnected"));
				}
			}
		}
		/** Plays the server: the namespace handshake succeeded. */
		serverConnect(): void {
			this.connected = true;
			this.fire("connect");
		}
	}

	class FakeManager extends Emitter {
		static readonly instances: FakeManager[] = [];
		readonly nsps = new Map<string, FakeSocket>();
		engine = undefined;
		constructor(
			readonly uri: string,
			readonly opts: Record<string, unknown>,
		) {
			super();
			FakeManager.instances.push(this);
		}
		socket(nsp: string): FakeSocket {
			let socket = this.nsps.get(nsp);
			if (!socket) {
				socket = new FakeSocket(nsp);
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

/**
 * Test-only oracle: the adapter's retired-membership references and
 * its overflow flag, read through a registry symbol the runtime defines.
 */
const RETAINED = Symbol.for("spinetab.socket-io.retained");
function retainedOf(connection: AdapterConnection): {
	retired: number;
	overflowed: boolean;
} {
	const read = (connection as unknown as Record<symbol, unknown>)[RETAINED];
	if (typeof read !== "function") {
		throw new Error("the retained-references oracle is missing");
	}
	return read.call(connection);
}
const uncertain = (test: ReturnType<typeof createTestContext>) =>
	test.diagnostics.filter(
		(diagnostic) => diagnostic.type === "membership-cleanup-uncertain",
	);
const timedOut = () => new Error("operation has timed out");
/** Index of the last `leave` emitted for `key`, or -1. */
function lastLeave(
	emits: ReadonlyArray<{ event: string; args: unknown[] }>,
	key: string,
): number {
	for (let index = emits.length - 1; index >= 0; index -= 1) {
		const emit = emits[index];
		if (emit?.event === "leave" && emit.args[0] === key) return index;
	}
	return -1;
}

beforeEach(() => {
	managers.length = 0;
});
afterEach(() => {
	for (const connection of connections.splice(0)) connection.dispose();
});

function open(
	adapter: ReturnType<typeof socketIoAdapter>,
	spec: { url: string; namespace?: string; path?: string },
	test = createTestContext({ credentials: () => ({ auth: {} }) }),
) {
	const connection = adapter.connect({ ...spec, sharing: "shared" }, test.ctx);
	connections.push(connection);
	return connection;
}

describe("the origin is the Manager URI and the URL path the namespace", () => {
	it("creates the Manager with the origin and joins the path's namespace", () => {
		open(socketIoAdapter(), { url: "https://h.test/chat" });
		expect(managers).toHaveLength(1);
		expect(managers[0]?.uri).toBe("https://h.test");
		expect([...(managers[0]?.nsps.keys() ?? [])]).toEqual(["/chat"]);
		expect(managers[0]?.opts).toMatchObject({ path: "/socket.io" });
	});

	it("an explicit namespace on a root URL joins the same namespace", () => {
		open(socketIoAdapter(), { url: "https://h.test/", namespace: "/chat" });
		expect(managers[0]?.uri).toBe("https://h.test");
		expect([...(managers[0]?.nsps.keys() ?? [])]).toEqual(["/chat"]);
	});

	it("keeps a query string in the Manager URI, as engine.io reads it there", () => {
		open(socketIoAdapter(), { url: "https://h.test/chat?tenant=a" });
		expect(managers[0]?.uri).toBe("https://h.test?tenant=a");
		expect([...(managers[0]?.nsps.keys() ?? [])]).toEqual(["/chat"]);
	});

	it("Managers are keyed without the namespace: namespaces of one origin multiplex one Manager", () => {
		const adapter = socketIoAdapter();
		open(adapter, { url: "https://h.test/chat" });
		open(adapter, { url: "https://h.test/ops" });
		open(adapter, { url: "https://h.test", namespace: "/admin" });
		expect(managers).toHaveLength(1);
		expect([...(managers[0]?.nsps.keys() ?? [])]).toEqual([
			"/chat",
			"/ops",
			"/admin",
		]);
		// A different engine path is a different Manager.
		open(adapter, { url: "https://h.test/chat", path: "/api/socket.io" });
		expect(managers).toHaveLength(2);
		expect(managers[1]?.uri).toBe("https://h.test");
	});
});

describe("a path the URL parser escapes is the namespace as written", () => {
	// Upstream url() keeps the raw path, but the runtime sees the page's
	// resolved href (`/%%A4` for `/ä`), so the escapes it added are undone.
	const PAGE = "https://app.test/dir/page";
	const cases: Array<[url: string, namespace: string]> = [
		["https://h.test/ä", "/ä"],
		["https://h.test/a b", "/a b"],
		["https://h.test/{id}", "/{id}"],
		// Reserved escapes stay escaped, as upstream keeps them.
		["https://h.test/a%2Fb", "/a%2Fb"],
		// A malformed escape leaves the parsed path as it is.
		["https://h.test/100%", "/100%"],
		// Dot segments are resolved by the URL parser; upstream keeps them.
		["https://h.test/a/../chat", "/chat"],
	];

	it("joins the decoded path of the URL the page resolved", () => {
		for (const [url, namespace] of cases) {
			managers.length = 0;
			const { connection } = socketIo(url, { sharing: "shared" });
			open(socketIoAdapter(), { url: resolveEndpoint(connection.url, PAGE) });
			expect([...(managers[0]?.nsps.keys() ?? [])], url).toEqual([namespace]);
		}
	});

	it("the path form and the explicit form are one identity and do not conflict", () => {
		const adapter = socketIoAdapter();
		for (const [url, namespace] of cases) {
			expect(() =>
				socketIo(url, { namespace, sharing: "shared" }),
			).not.toThrow();
			const pathForm = {
				url: resolveEndpoint(url, PAGE),
				sharing: "shared" as const,
			};
			const explicit = {
				url: resolveEndpoint(new URL(url).origin, PAGE),
				namespace,
				sharing: "shared" as const,
			};
			const both = { ...pathForm, namespace };
			for (const spec of [pathForm, explicit, both]) {
				expect(() => adapter.validateConnection?.(spec), url).not.toThrow();
			}
			expect(adapter.connectionKey?.(pathForm), url).toBe(
				adapter.connectionKey?.(explicit),
			);
			expect(adapter.connectionKey?.(both), url).toBe(
				adapter.connectionKey?.(explicit),
			);
		}
	});

	it("a namespace that differs from the decoded path still conflicts in both realms", () => {
		expect(() =>
			socketIo("https://h.test/ä", { namespace: "/%%A4", sharing: "shared" }),
		).toThrow("socketIo.namespace: differs");
		expect(() =>
			socketIoAdapter().validateConnection?.({
				url: resolveEndpoint("https://h.test/ä", PAGE),
				namespace: "/a",
				sharing: "shared",
			}),
		).toThrow("connection.namespace: differs");
	});
});

describe("routing keys are computed once per distinct route", () => {
	it("two subscriptions on one event with different routes each receive only their own room's events", () => {
		const calls = { byRoom: 0, byOwner: 0 };
		type Room = { room: string; owner: string; n: number };
		const adapter = socketIoAdapter({
			routes: {
				byRoom: (args) => {
					calls.byRoom += 1;
					return [(args[0] as Room).room];
				},
				byOwner: (args) => {
					calls.byOwner += 1;
					return [(args[0] as Room).owner];
				},
			},
		});
		const connection = open(adapter, { url: "https://h.test" });
		const subscribe = (membership: string, route: string) => {
			const recording = createRecordingSink<unknown[]>();
			connection.subscribe(
				{ event: "room", membership, route },
				recording.sink,
				{ key: `${route}:${membership}`, repeatable: true },
			);
			return recording;
		};
		const r1 = subscribe("r1", "byRoom");
		const r2 = subscribe("r2", "byRoom");
		const alice = subscribe("alice", "byOwner");
		const socket = managers[0]?.socket("/");
		socket?.serverConnect();
		const emit = (room: string, owner: string, n: number) =>
			socket?.fire("room", { room, owner, n });
		emit("r1", "bob", 1);
		emit("r2", "alice", 2);
		emit("r1", "alice", 3);
		emit("r3", "bob", 4);
		const seen = (recording: typeof r1) =>
			recording.events.map((args) => (args[0] as Room).n);
		expect(seen(r1)).toEqual([1, 3]);
		expect(seen(r2)).toEqual([2]);
		expect(seen(alice)).toEqual([2, 3]);
		// Once per event for each distinct route, not once per record.
		expect(calls).toEqual({ byRoom: 4, byOwner: 4 });
	});
});

describe("a failed provider blocks the namespace like a timeout", () => {
	it("never connects with an empty auth payload", async () => {
		const outcomes = [];
		const codes: SpinetabErrorCode[] = [
			"credentials-failed",
			"credentials-timeout",
		];
		for (const code of codes) {
			managers.length = 0;
			const test = createTestContext({
				credentials: () => {
					throw new SpinetabError(code, "The credentials provider failed.");
				},
			});
			const connection = open(
				socketIoAdapter(),
				{ url: "https://h.test" },
				test,
			);
			connection.subscribe({ event: "tick" }, createRecordingSink().sink, {
				key: "k",
				repeatable: true,
			});
			const socket = managers[0]?.socket("/");
			let payload: object | undefined;
			// Upstream asks for the auth payload when it opens the namespace.
			socket?.auth?.((data) => {
				payload = data;
			});
			await waitFor(() => test.hasStatus("auth-blocked"), { timeout: 2_000 });
			outcomes.push({
				status: {
					state: test.lastStatus()?.state,
					reason: test.lastStatus()?.reason,
				},
				payload,
				active: socket?.active,
				rejections: test.rejections.length,
			});
		}
		expect(outcomes[0]).toEqual({
			status: { state: "auth-blocked", reason: "credentials-missing" },
			payload: undefined,
			active: false,
			rejections: 0,
		});
		expect(outcomes[1]).toEqual(outcomes[0]);
	});
});

// join and leave for one key are serialised. When
// the last consumer leaves while the key's join still awaits its
// acknowledgement, the leave is emitted once that join lands, unless the join
// failed, the socket disconnected or the key has consumers again.
describe("a leave waits for an in-flight join", () => {
	type Room = { room: string };
	function member() {
		const adapter = socketIoAdapter({
			routes: { byRoom: (args) => [(args[0] as Room).room] },
		});
		const connection = open(adapter, { url: "https://h.test/chat" });
		const socket = managers[0]?.socket("/chat");
		if (!socket) throw new Error("no namespace socket");
		socket.serverConnect();
		const subscribe = () => {
			const recording = createRecordingSink<unknown[]>();
			const subscription = connection.subscribe(
				{
					event: "room",
					membership: "r1",
					route: "byRoom",
					join: { event: "join", args: ["r1"] },
					leave: { event: "leave", args: ["r1"] },
				},
				recording.sink,
				{ key: "k", repeatable: true },
			);
			return { recording, subscription };
		};
		const events = () => socket.emits.map((emit) => emit.event);
		return { connection, socket, subscribe, events };
	}

	it("leaves once the join acknowledgement lands", () => {
		const { socket, subscribe, events } = member();
		const first = subscribe();
		expect(events()).toEqual(["join"]);
		first.subscription.unsubscribe();
		expect(events()).toEqual(["join"]);
		socket.emits[0]?.ack?.(null);
		expect(events()).toEqual(["join", "leave"]);
		expect(socket.emits[1]?.args).toEqual(["r1"]);
		// The leave carries its own acknowledgement timeout.
		expect(typeof socket.emits[1]?.ack).toBe("function");
	});

	it("a join that timed out while connected is compensated with one leave", () => {
		const { socket, subscribe, events } = member();
		subscribe().subscription.unsubscribe();
		socket.emits[0]?.ack?.(timedOut());
		expect(events()).toEqual(["join", "leave"]);
		expect(socket.emits[1]?.args).toEqual(["r1"]);
		expect(typeof socket.emits[1]?.ack).toBe("function");
	});

	it("sends nothing when the socket disconnected before the acknowledgement", () => {
		const { socket, subscribe, events } = member();
		subscribe().subscription.unsubscribe();
		socket.connected = false;
		socket.fire("disconnect", "transport close");
		socket.emits[0]?.ack?.(new Error("socket has been disconnected"));
		expect(events()).toEqual(["join"]);
	});

	it("sends nothing when the key has consumers again", () => {
		const { socket, subscribe, events } = member();
		subscribe().subscription.unsubscribe();
		const again = subscribe();
		expect(events()).toEqual(["join", "join"]);
		socket.emits[0]?.ack?.(null);
		socket.emits[1]?.ack?.(null);
		expect(events()).toEqual(["join", "join"]);
		socket.fire("room", { room: "r1" });
		expect(again.recording.events).toHaveLength(1);
	});
});

// the namespace auth callback answers only the attempt that
// asked. A request still pending when the engine closed (or the namespace
// disconnected) must not call back into a later handshake.
describe("the namespace auth callback is fenced by attempt", () => {
	it("a stale credential answer never calls back; the current one does", async () => {
		const pending: Array<() => void> = [];
		const test = createTestContext({
			credentials: (revision) =>
				new Promise((resolve) =>
					pending.push(() => resolve({ auth: { token: `t${revision}` } })),
				),
		});
		const connection = open(socketIoAdapter(), { url: "https://h.test" }, test);
		connection.subscribe({ event: "tick" }, createRecordingSink().sink, {
			key: "k",
			repeatable: true,
		});
		const manager = managers[0];
		const socket = manager?.socket("/");
		const answers: string[] = [];
		socket?.auth?.(() => answers.push("first"));
		manager?.fire("close", "transport close");
		socket?.fire("disconnect", "transport close");
		socket?.auth?.(() => answers.push("second"));
		for (const resolve of pending) resolve();
		await waitFor(() => answers.length > 0);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(answers).toEqual(["second"]);
		expect(test.requests).toEqual(["connect", "reconnect"]);
	});

	it("a stale credential failure never blocks the current attempt", async () => {
		const settle: Array<{ ok: () => void; fail: () => void }> = [];
		const test = createTestContext({
			credentials: () =>
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
		});
		const connection = open(socketIoAdapter(), { url: "https://h.test" }, test);
		connection.subscribe({ event: "tick" }, createRecordingSink().sink, {
			key: "k",
			repeatable: true,
		});
		const manager = managers[0];
		const socket = manager?.socket("/");
		const answers: string[] = [];
		socket?.auth?.(() => answers.push("first"));
		manager?.fire("close", "transport close");
		socket?.auth?.(() => answers.push("second"));
		settle[0]?.fail();
		settle[1]?.ok();
		await waitFor(() => answers.length > 0);
		expect(answers).toEqual(["second"]);
		expect(test.hasStatus("auth-blocked")).toBe(false);
		expect(socket?.active).toBe(true);
	});
});

//: a membership whose key has no consumers but
// may still be held by the server (confirmed and retired while disconnected,
// or retired or failed with a join that may have applied) gets one declared
// leave, with its acknowledgement timeout, on a recovered reconnect, because
// connection-state recovery restores the session's rooms; it is then dropped.
// Without recovery it is dropped without a command. A key with consumers keeps
// a confirmed join and repeats an unacknowledged one once.
describe("retired memberships across connection-state recovery", () => {
	type Room = { room: string };
	function rooms() {
		const adapter = socketIoAdapter({
			routes: { byRoom: (args) => [(args[0] as Room).room] },
		});
		const test = createTestContext({ credentials: () => ({ auth: {} }) });
		const connection = open(adapter, { url: "https://h.test/chat" }, test);
		const manager = managers.at(-1);
		const socket = manager?.socket("/chat");
		if (!manager || !socket) throw new Error("no namespace socket");
		socket.serverConnect();
		const member = (room: string, withLeave = true, repeatable = true) => {
			const recording = createRecordingSink<unknown[]>();
			const subscription = connection.subscribe(
				{
					event: "room",
					membership: room,
					route: "byRoom",
					join: { event: "join", args: [room] },
					...(withLeave ? { leave: { event: "leave", args: [room] } } : {}),
				},
				recording.sink,
				{ key: room, repeatable },
			);
			return { recording, subscription };
		};
		/** A namespace-wide listener (no membership). */
		const listen = (repeatable: boolean) => {
			const recording = createRecordingSink<unknown[]>();
			connection.subscribe({ event: "room" }, recording.sink, {
				key: `listen:${repeatable}`,
				repeatable,
			});
			return recording;
		};
		/** An acknowledged application command (never re-sent). */
		const command = () =>
			connection.command?.(
				{ event: "echo", args: [{ operation: "one-off" }] },
				{
					id: crypto.randomUUID(),
					signal: new AbortController().signal,
					timeoutMs: 10_000,
				},
			) as Promise<CommandOutcome<unknown>>;
		const answered = new Set<number>();
		/** Emits upstream holds in `sendBuffer` (the heartbeat deadline had passed). */
		const buffered = new Set<number>();
		/** Plays the server's acknowledgement of emit `index` (null: success). */
		const ack = (index: number, error: Error | null = null) => {
			answered.add(index);
			socket.emits[index]?.ack?.(error);
		};
		/** Upstream buffered the latest emit instead of writing it. */
		const buffer = () => {
			const index = socket.emits.length - 1;
			buffered.add(index);
			const emit = socket.emits[index];
			if (emit) emit.buffered = true;
		};
		let drops = 0;
		/**
		 * Upstream `onclose`: `disconnect` first, then every pending ack errors,
		 * except those of buffered packets (`_clearAcks`).
		 */
		const drop = () => {
			drops += 1;
			socket.connected = false;
			socket.fire("disconnect", "transport close");
			socket.emits.forEach((emit, index) => {
				if (emit.ack && !answered.has(index) && !buffered.has(index)) {
					ack(index, new Error("socket has been disconnected"));
				}
			});
		};
		/**
		 * Upstream `onconnect`: `recovered` is set and the send buffer flushed
		 * on the new session before `connect` fires.
		 */
		const reconnect = (recovered: boolean) => {
			socket.recovered = recovered;
			buffered.clear();
			for (const emit of socket.emits) emit.buffered = false;
			socket.serverConnect();
		};
		const sent = () =>
			socket.emits.map((emit) => `${emit.event}:${String(emit.args[0])}`);
		const deliver = (room: string) => socket.fire("room", { room });
		return {
			connection,
			manager,
			socket,
			test,
			member,
			listen,
			command,
			ack,
			buffer,
			drop,
			drops: () => drops,
			reconnect,
			sent,
			deliver,
			retained: () => retainedOf(connection),
		};
	}

	it("a confirmed membership retired while disconnected is left once after recovery, then dropped", () => {
		const { socket, member, ack, drop, reconnect, sent } = rooms();
		const r1 = member("r1");
		ack(0);
		drop();
		r1.subscription.unsubscribe();
		expect(sent()).toEqual(["join:r1"]);
		reconnect(true);
		expect(sent()).toEqual(["join:r1", "leave:r1"]);
		// The leave carries its own acknowledgement timeout.
		expect(typeof socket.emits[1]?.ack).toBe("function");
		ack(1);
		drop();
		reconnect(true);
		expect(sent()).toEqual(["join:r1", "leave:r1"]);
	});

	it("without recovery the server has no rooms: nothing is sent and the reference is dropped", () => {
		const { member, ack, drop, reconnect, sent } = rooms();
		const r1 = member("r1");
		ack(0);
		drop();
		r1.subscription.unsubscribe();
		reconnect(false);
		expect(sent()).toEqual(["join:r1"]);
		// A later recovered reconnect has nothing left to release.
		drop();
		reconnect(true);
		expect(sent()).toEqual(["join:r1"]);
	});

	it("an in-flight join whose last consumer left, before or after the drop, is left once only after recovery", () => {
		const outcomes: Record<string, string[]> = {};
		for (const when of ["before", "after"] as const) {
			for (const recovered of [true, false]) {
				const { member, drop, reconnect, sent } = rooms();
				const r1 = member("r1");
				if (when === "before") r1.subscription.unsubscribe();
				drop();
				if (when === "after") r1.subscription.unsubscribe();
				reconnect(recovered);
				outcomes[`${when}:${recovered}`] = sent();
			}
		}
		expect(outcomes).toEqual({
			"before:true": ["join:r1", "leave:r1"],
			"before:false": ["join:r1"],
			"after:true": ["join:r1", "leave:r1"],
			"after:false": ["join:r1"],
		});
	});

	it("a timed-out join that may have applied is left at once while connected, whether retired or failed", () => {
		const { member, ack, drop, reconnect, sent, retained } = rooms();
		member("r1").subscription.unsubscribe();
		ack(0, timedOut());
		const r2 = member("r2");
		ack(2, timedOut());
		expect(r2.recording.errors.map((error) => error.code)).toEqual([
			"subscribe-rejected",
		]);
		expect(sent()).toEqual(["join:r1", "leave:r1", "join:r2", "leave:r2"]);
		ack(1);
		ack(3);
		expect(retained()).toEqual({ retired: 0, overflowed: false });
		drop();
		reconnect(true);
		expect(sent()).toEqual(["join:r1", "leave:r1", "join:r2", "leave:r2"]);
	});

	it("keys with consumers: a confirmed join is kept without a duplicate, an unacknowledged one is repeated once", () => {
		const recoveredRun = rooms();
		const a = recoveredRun.member("a");
		recoveredRun.ack(0);
		const b = recoveredRun.member("b");
		recoveredRun.drop();
		recoveredRun.reconnect(true);
		expect(recoveredRun.sent()).toEqual(["join:a", "join:b", "join:b"]);
		recoveredRun.deliver("a");
		recoveredRun.deliver("b");
		expect(a.recording.events).toHaveLength(1);
		// No delivery before the repeated join is acknowledged.
		expect(b.recording.events).toHaveLength(0);
		recoveredRun.ack(2);
		recoveredRun.deliver("b");
		expect(b.recording.events).toHaveLength(1);

		const freshRun = rooms();
		freshRun.member("a");
		freshRun.ack(0);
		freshRun.member("b");
		freshRun.drop();
		freshRun.reconnect(false);
		expect(freshRun.sent()).toEqual(["join:a", "join:b", "join:a", "join:b"]);
	});

	it("a confirmed key regained before the reconnect stays joined after recovery: no leave, no second join", () => {
		const { member, ack, drop, reconnect, sent, deliver } = rooms();
		const first = member("r1");
		ack(0);
		drop();
		first.subscription.unsubscribe();
		const again = member("r1");
		reconnect(true);
		expect(sent()).toEqual(["join:r1"]);
		deliver("r1");
		expect(again.recording.events).toHaveLength(1);
		expect(first.recording.events).toHaveLength(0);
		drop();
		reconnect(true);
		expect(sent()).toEqual(["join:r1"]);
	});

	it("a confirmed key regained before an unrecovered reconnect is joined once on the new session", () => {
		const { member, ack, drop, reconnect, sent, deliver } = rooms();
		const first = member("r1");
		ack(0);
		drop();
		first.subscription.unsubscribe();
		const again = member("r1");
		reconnect(false);
		expect(sent()).toEqual(["join:r1", "join:r1"]);
		deliver("r1");
		expect(again.recording.events).toHaveLength(0);
		ack(1);
		deliver("r1");
		expect(again.recording.events).toHaveLength(1);
	});

	it("an unacknowledged key regained before recovery is joined once more and never left", () => {
		const { member, ack, drop, reconnect, sent, deliver } = rooms();
		const first = member("r1");
		drop();
		first.subscription.unsubscribe();
		const again = member("r1");
		expect(sent()).toEqual(["join:r1"]);
		reconnect(true);
		expect(sent()).toEqual(["join:r1", "join:r1"]);
		ack(1);
		deliver("r1");
		expect(again.recording.events).toHaveLength(1);
		drop();
		reconnect(true);
		expect(sent()).toEqual(["join:r1", "join:r1"]);
	});

	it("retirement references are bounded per key: churn while disconnected leaves once", () => {
		const { member, ack, drop, reconnect, sent } = rooms();
		const first = member("r1");
		ack(0);
		drop();
		first.subscription.unsubscribe();
		for (let round = 0; round < 50; round += 1) {
			member("r1").subscription.unsubscribe();
		}
		reconnect(true);
		expect(sent()).toEqual(["join:r1", "leave:r1"]);
	});

	it("a leave already sent after an acknowledged join is not repeated at recovery", () => {
		const { member, ack, drop, reconnect, sent } = rooms();
		member("r1").subscription.unsubscribe();
		ack(0);
		expect(sent()).toEqual(["join:r1", "leave:r1"]);
		ack(1);
		drop();
		reconnect(true);
		expect(sent()).toEqual(["join:r1", "leave:r1"]);
	});

	it("a membership without a declared leave sends nothing at recovery", () => {
		const { member, ack, drop, reconnect, sent } = rooms();
		const r1 = member("r1", false);
		ack(0);
		drop();
		r1.subscription.unsubscribe();
		reconnect(true);
		expect(sent()).toEqual(["join:r1"]);
	});

	// Upstream buffers an emit once the heartbeat deadline has passed,
	// keeps its ack through the drop and flushes it on the next session,
	// recovered or not, before `connect`. Such a join applies on the new
	// session, so its key is released by the join's acknowledgement.
	it("a join upstream buffered at the drop whose last consumer left is left once its flushed join is acknowledged, recovered or not", () => {
		const outcomes: Record<string, string[]> = {};
		for (const recovered of [true, false]) {
			const { member, ack, buffer, drop, reconnect, sent } = rooms();
			const r1 = member("r1");
			buffer();
			r1.subscription.unsubscribe();
			drop();
			reconnect(recovered);
			// Serialised: no leave while the join awaits its ack.
			outcomes[`${recovered}:connect`] = sent();
			ack(0);
			outcomes[`${recovered}:ack`] = sent();
			ack(1);
			drop();
			reconnect(true);
			outcomes[`${recovered}:later`] = sent();
		}
		expect(outcomes).toEqual({
			"true:connect": ["join:r1"],
			"true:ack": ["join:r1", "leave:r1"],
			"true:later": ["join:r1", "leave:r1"],
			"false:connect": ["join:r1"],
			"false:ack": ["join:r1", "leave:r1"],
			"false:later": ["join:r1", "leave:r1"],
		});
	});

	it("a flushed join that times out on the new session is compensated at once", () => {
		const { member, ack, buffer, drop, reconnect, sent, retained } = rooms();
		const r1 = member("r1");
		buffer();
		r1.subscription.unsubscribe();
		drop();
		reconnect(false);
		ack(0, timedOut());
		expect(sent()).toEqual(["join:r1", "leave:r1"]);
		ack(1);
		expect(retained()).toEqual({ retired: 0, overflowed: false });
		drop();
		reconnect(true);
		expect(sent()).toEqual(["join:r1", "leave:r1"]);
	});

	it("a buffered join that timed out during the outage no longer holds its key: released at the reconnect like any timed-out join", () => {
		const outcomes: Record<string, string[]> = {};
		for (const recovered of [true, false]) {
			const { member, ack, buffer, drop, reconnect, sent } = rooms();
			const r1 = member("r1");
			buffer();
			r1.subscription.unsubscribe();
			drop();
			// Upstream's ack timer removed the packet unsent.
			ack(0, new Error("operation has timed out"));
			reconnect(recovered);
			outcomes[String(recovered)] = sent();
		}
		expect(outcomes).toEqual({
			true: ["join:r1", "leave:r1"],
			false: ["join:r1"],
		});
	});

	it("a buffered join's key regained and lost again while disconnected is left once the flushed join is acknowledged, recovered or not", () => {
		const outcomes: Record<string, string[]> = {};
		for (const recovered of [true, false]) {
			const { member, ack, buffer, drop, reconnect, sent } = rooms();
			const first = member("r1");
			buffer();
			drop();
			first.subscription.unsubscribe();
			// Regained (it takes over the unacknowledged state), then lost again.
			member("r1").subscription.unsubscribe();
			reconnect(recovered);
			outcomes[`${recovered}:connect`] = sent();
			ack(0);
			outcomes[`${recovered}:ack`] = sent();
		}
		expect(outcomes).toEqual({
			"true:connect": ["join:r1"],
			"true:ack": ["join:r1", "leave:r1"],
			"false:connect": ["join:r1"],
			"false:ack": ["join:r1", "leave:r1"],
		});
	});

	it("a key whose last consumer left with two joins in flight is left once, after both are acknowledged", () => {
		const { member, ack, buffer, drop, reconnect, sent } = rooms();
		const r1 = member("r1");
		buffer();
		drop();
		// The buffered join is flushed and the key joined once more.
		reconnect(false);
		expect(sent()).toEqual(["join:r1", "join:r1"]);
		r1.subscription.unsubscribe();
		ack(0);
		expect(sent()).toEqual(["join:r1", "join:r1"]);
		ack(1);
		expect(sent()).toEqual(["join:r1", "join:r1", "leave:r1"]);
	});

	it("an unacknowledged join cut off by the drop, regained and lost again while disconnected, is left once after recovery only", () => {
		const outcomes: Record<string, string[]> = {};
		for (const recovered of [true, false]) {
			const { member, drop, reconnect, sent } = rooms();
			const first = member("r1");
			drop();
			first.subscription.unsubscribe();
			member("r1").subscription.unsubscribe();
			reconnect(recovered);
			outcomes[String(recovered)] = sent();
		}
		expect(outcomes).toEqual({
			true: ["join:r1", "leave:r1"],
			false: ["join:r1"],
		});
	});

	// A leave lost with the transport (its ack errors while the socket
	// is disconnected) leaves the room with the session; recovery restores it.
	it("a leave lost with the transport is sent once more after recovery; without recovery nothing is sent", () => {
		const outcomes: Record<string, string[]> = {};
		for (const recovered of [true, false]) {
			const { test, member, ack, drop, reconnect, sent } = rooms();
			const r1 = member("r1");
			ack(0);
			r1.subscription.unsubscribe();
			expect(sent()).toEqual(["join:r1", "leave:r1"]);
			drop();
			// Payload-free: no membership key.
			expect(test.diagnostics).toContainEqual({
				type: "socket-io.leave-failed",
			});
			reconnect(recovered);
			outcomes[String(recovered)] = sent();
			ack(2);
			drop();
			reconnect(true);
			outcomes[`${recovered}:later`] = sent();
		}
		expect(outcomes).toEqual({
			true: ["join:r1", "leave:r1", "leave:r1"],
			"true:later": ["join:r1", "leave:r1", "leave:r1"],
			false: ["join:r1", "leave:r1"],
			"false:later": ["join:r1", "leave:r1"],
		});
	});

	it("a leave upstream buffered at the drop is not repeated once flushed; timed out during the outage it is sent after recovery", () => {
		const flushed = rooms();
		const kept = flushed.member("r1");
		flushed.ack(0);
		kept.subscription.unsubscribe();
		flushed.buffer();
		flushed.drop();
		flushed.reconnect(true);
		flushed.ack(1);
		flushed.drop();
		flushed.reconnect(true);
		expect(flushed.sent()).toEqual(["join:r1", "leave:r1"]);

		const outcomes: Record<string, string[]> = {};
		for (const recovered of [true, false]) {
			const { member, ack, buffer, drop, reconnect, sent } = rooms();
			const r1 = member("r1");
			ack(0);
			r1.subscription.unsubscribe();
			buffer();
			drop();
			// Upstream's ack timer removed the packet unsent.
			ack(1, new Error("operation has timed out"));
			reconnect(recovered);
			outcomes[String(recovered)] = sent();
		}
		expect(outcomes).toEqual({
			true: ["join:r1", "leave:r1", "leave:r1"],
			false: ["join:r1", "leave:r1"],
		});
	});

	it("a key regained after its leave was lost is joined once more after recovery and never left", () => {
		const { member, ack, drop, reconnect, sent, deliver } = rooms();
		const first = member("r1");
		ack(0);
		first.subscription.unsubscribe();
		// The leave may or may not have applied before the transport died.
		drop();
		const again = member("r1");
		reconnect(true);
		expect(sent()).toEqual(["join:r1", "leave:r1", "join:r1"]);
		deliver("r1");
		expect(again.recording.events).toHaveLength(0);
		ack(2);
		deliver("r1");
		expect(again.recording.events).toHaveLength(1);
		drop();
		reconnect(true);
		expect(sent()).toEqual(["join:r1", "leave:r1", "join:r1"]);
	});

	it("a leave that times out while connected leaves one `joining` tombstone, released at the next connect", () => {
		const { test, member, ack, drop, reconnect, sent, retained } = rooms();
		const r1 = member("r1");
		ack(0);
		r1.subscription.unsubscribe();
		ack(1, timedOut());
		expect(test.diagnostics).toContainEqual({
			type: "socket-io.leave-failed",
		});
		expect(uncertain(test)).toEqual([
			{
				type: "membership-cleanup-uncertain",
				detail: { reason: "leave-timeout" },
			},
		]);
		expect(sent()).toEqual(["join:r1", "leave:r1"]);
		expect(retained()).toEqual({ retired: 1, overflowed: false });
		drop();
		reconnect(true);
		expect(sent()).toEqual(["join:r1", "leave:r1", "leave:r1"]);
		expect(retained()).toEqual({ retired: 0, overflowed: false });
	});

	it("a leave lost with the transport after its key was regained is not repeated", () => {
		const { member, ack, drop, reconnect, sent, deliver } = rooms();
		const first = member("r1");
		ack(0);
		first.subscription.unsubscribe();
		const again = member("r1");
		expect(sent()).toEqual(["join:r1", "leave:r1", "join:r1"]);
		drop();
		reconnect(true);
		// The regained key is joined again (its join was cut off), never left.
		expect(sent()).toEqual(["join:r1", "leave:r1", "join:r1", "join:r1"]);
		ack(3);
		deliver("r1");
		expect(again.recording.events).toHaveLength(1);
	});

	// (a), cleanup on a live connection. A timed-out join is
	// compensated with one leave; a leave has its own acknowledgement budget as
	// grace, and a connected timeout leaves one `joining` tombstone for the
	// next connect (a recovery leave's own timeout is never re-retired).
	describe("timed-out joins and leaves on a live connection", () => {
		it("a join that times out after its last consumer left is compensated once; its acknowledged leave leaves nothing held", () => {
			const { test, member, ack, sent, retained } = rooms();
			member("r1").subscription.unsubscribe();
			expect(retained()).toEqual({ retired: 1, overflowed: false });
			ack(0, timedOut());
			expect(sent()).toEqual(["join:r1", "leave:r1"]);
			ack(1);
			expect(retained()).toEqual({ retired: 0, overflowed: false });
			expect(uncertain(test)).toEqual([]);
		});

		it("a key whose two joins are in flight is compensated once, after the last acknowledgement or timeout", () => {
			const { member, ack, buffer, drop, reconnect, sent, retained } = rooms();
			const r1 = member("r1");
			buffer();
			drop();
			reconnect(false);
			r1.subscription.unsubscribe();
			ack(1, timedOut());
			expect(sent()).toEqual(["join:r1", "join:r1"]);
			ack(0, timedOut());
			expect(sent()).toEqual(["join:r1", "join:r1", "leave:r1"]);
			ack(2);
			expect(retained()).toEqual({ retired: 0, overflowed: false });
		});

		it("a leave's connected timeout: one tombstone per key; a recovered connect leaves it once and that leave's own timeout is not re-retired", () => {
			const { test, member, ack, drop, reconnect, sent, retained } = rooms();
			const r1 = member("r1");
			ack(0);
			r1.subscription.unsubscribe();
			ack(1, timedOut());
			expect(retained()).toEqual({ retired: 1, overflowed: false });
			drop();
			reconnect(true);
			expect(sent()).toEqual(["join:r1", "leave:r1", "leave:r1"]);
			ack(2, timedOut());
			// Dropped with the diagnostic: bounded per connect cycle.
			expect(retained()).toEqual({ retired: 0, overflowed: false });
			expect(uncertain(test)).toHaveLength(2);
			drop();
			reconnect(true);
			expect(sent()).toEqual(["join:r1", "leave:r1", "leave:r1"]);
		});

		it("a leave's connected timeout is dropped by a reconnect without recovery", () => {
			const { member, ack, drop, reconnect, sent, retained } = rooms();
			const r1 = member("r1");
			ack(0);
			r1.subscription.unsubscribe();
			ack(1, timedOut());
			drop();
			reconnect(false);
			expect(sent()).toEqual(["join:r1", "leave:r1"]);
			expect(retained()).toEqual({ retired: 0, overflowed: false });
		});

		it("a key regained after its leave timed out is live with one join and holds no entry", () => {
			const { member, ack, sent, retained, deliver } = rooms();
			const first = member("r1");
			ack(0);
			first.subscription.unsubscribe();
			ack(1, timedOut());
			const again = member("r1");
			expect(retained()).toEqual({ retired: 0, overflowed: false });
			expect(sent()).toEqual(["join:r1", "leave:r1", "join:r1"]);
			ack(2);
			deliver("r1");
			expect(again.recording.events).toHaveLength(1);
		});

		it("never emits a leave while disconnected: a join cut off by the drop waits for the connect", () => {
			const { member, drop, reconnect, sent, retained } = rooms();
			member("r1").subscription.unsubscribe();
			drop();
			expect(sent()).toEqual(["join:r1"]);
			expect(retained()).toEqual({ retired: 1, overflowed: false });
			reconnect(false);
			expect(sent()).toEqual(["join:r1"]);
			expect(retained()).toEqual({ retired: 0, overflowed: false });
		});
	});

	// (e), a long-lived healthy connection. The oracle is the
	// adapter's own retired map, not the server (a leave that applied despite a
	// lost acknowledgement would hide client-side retention).
	describe("churn on a healthy connection (retired-map oracle)", () => {
		const CYCLES = 200;

		it("200 cycles of join, last consumer leaves, leave timeout, with join and leave acknowledgements dropped while traffic continues: never more than 64 held, every entry cleared, no induced reconnect", async () => {
			const h = rooms();
			const keep = h.member("keep");
			h.ack(0);
			let max = 0;
			let restarts = 0;
			const sample = () => {
				max = Math.max(max, h.retained().retired);
			};
			for (let n = 0; n < CYCLES; n += 1) {
				const key = `k${n}`;
				const joinAt = h.socket.emits.length;
				const cycle = h.member(key);
				h.deliver("keep");
				cycle.subscription.unsubscribe();
				sample();
				h.ack(joinAt, timedOut());
				sample();
				const leaveAt = lastLeave(h.socket.emits, key);
				if (leaveAt > joinAt) {
					h.ack(leaveAt, timedOut());
					sample();
				}
				await Promise.resolve();
				if (h.socket.active && !h.socket.connected) {
					// The adapter's own fresh session; the server answers.
					restarts += 1;
					sample();
					h.reconnect(false);
					expect(h.retained()).toEqual({ retired: 0, overflowed: false });
					h.ack(h.socket.emits.length - 1);
				}
			}
			expect(max).toBe(64);
			expect(restarts).toBe(3);
			expect(h.drops()).toBe(0);
			expect(keep.recording.errors).toEqual([]);
			expect(keep.recording.events.length).toBeGreaterThan(CYCLES - 10);
			expect(
				uncertain(h.test).filter(
					(event) =>
						(event.detail as { reason: string }).reason === "retired-overflow",
				),
			).toHaveLength(3);
			h.connection.dispose();
			expect(h.retained()).toEqual({ retired: 0, overflowed: false });
		});

		it("200 cycles whose leaves are acknowledged hold nothing after each cycle, whether the join was acknowledged or timed out", () => {
			for (const joinAck of ["acknowledged", "timed out"] as const) {
				const h = rooms();
				for (let n = 0; n < CYCLES; n += 1) {
					const key = `k${n}`;
					const joinAt = h.socket.emits.length;
					const cycle = h.member(key);
					if (joinAck === "acknowledged") h.ack(joinAt);
					cycle.subscription.unsubscribe();
					if (joinAck === "timed out") h.ack(joinAt, timedOut());
					const leaveAt = lastLeave(h.socket.emits, key);
					expect(leaveAt, `${joinAck}: cycle ${n} left`).toBeGreaterThan(
						joinAt,
					);
					h.ack(leaveAt);
					expect(h.retained(), `${joinAck}: cycle ${n}`).toEqual({
						retired: 0,
						overflowed: false,
					});
				}
				expect(uncertain(h.test)).toEqual([]);
				expect(h.socket.disconnects).toBe(0);
			}
		});

		it("200 cycles on one key with every acknowledgement dropped hold at most one entry", () => {
			const h = rooms();
			let max = 0;
			for (let n = 0; n < CYCLES; n += 1) {
				const joinAt = h.socket.emits.length;
				h.member("r1").subscription.unsubscribe();
				h.ack(joinAt, timedOut());
				h.ack(h.socket.emits.length - 1, timedOut());
				max = Math.max(max, h.retained().retired);
			}
			expect(max).toBe(1);
			expect(h.socket.disconnects).toBe(0);
		});
	});

	// (b): disconnected tombstones cannot outlive the disconnection. A
	// connection that stops reconnecting on its own drops them and declines
	// recovery, so a later connect cannot restore a room it forgot.
	describe("(b): tombstones end with the disconnection", () => {
		function tombstone() {
			const h = rooms();
			const r1 = h.member("r1");
			h.ack(0);
			h.drop();
			r1.subscription.unsubscribe();
			expect(h.retained()).toEqual({ retired: 1, overflowed: false });
			return h;
		}

		it("Manager close (reconnect_failed): dropped, recovery declined, nothing sent after a retry", () => {
			const h = tombstone();
			h.manager.fire("reconnect_failed");
			expect(h.test.lastStatus()?.state).toBe("retry-exhausted");
			expect(h.retained()).toEqual({ retired: 0, overflowed: false });
			expect(h.socket._pid).toBeUndefined();
			h.connection.retry?.();
			h.reconnect(false);
			expect(h.sent()).toEqual(["join:r1"]);
		});

		it("auth block: dropped and recovery declined", () => {
			const h = tombstone();
			h.socket.active = false;
			h.socket.fire(
				"connect_error",
				Object.assign(new Error("unauthorized"), { data: { status: 401 } }),
			);
			expect(h.test.lastStatus()?.state).toBe("auth-blocked");
			expect(h.retained()).toEqual({ retired: 0, overflowed: false });
			expect(h.socket._pid).toBeUndefined();
		});

		it("dispose: dropped", () => {
			const h = tombstone();
			h.connection.dispose();
			expect(h.retained()).toEqual({ retired: 0, overflowed: false });
		});

		it("a non-recovered reconnect: dropped without a command; recovered: one leave", () => {
			const dropped = tombstone();
			dropped.reconnect(false);
			expect(dropped.sent()).toEqual(["join:r1"]);
			expect(dropped.retained()).toEqual({ retired: 0, overflowed: false });
			const left = tombstone();
			left.reconnect(true);
			expect(left.sent()).toEqual(["join:r1", "leave:r1"]);
			expect(left.retained()).toEqual({ retired: 0, overflowed: false });
		});
	});

	// MEMBERSHIP_RETIRED_MAX = 64 retired entries, never a silent
	// eviction. Beyond it the connection is flagged `overflowed` (one
	// payload-free diagnostic). While connected it restarts on a fresh session
	// at once; while disconnected a recovered reconnect is declined the same
	// way; a reconnect without recovery simply drops the flag and tombstones.
	describe("the retired cap and the fresh-session outcome", () => {
		function overflowWhileDisconnected() {
			const h = rooms();
			const keep = h.member("keep");
			h.ack(0);
			const finite = h.listen(false);
			const steady = h.listen(true);
			const gone = Array.from({ length: 65 }, (_, n) => h.member(`g${n}`));
			gone.forEach((_, n) => {
				h.ack(n + 1);
			});
			h.drop();
			for (const item of gone) {
				item.subscription.unsubscribe();
				expect(h.retained().retired).toBeLessThanOrEqual(64);
			}
			expect(h.retained()).toEqual({ retired: 64, overflowed: true });
			expect(uncertain(h.test)).toEqual([
				{
					type: "membership-cleanup-uncertain",
					detail: { reason: "retired-overflow" },
				},
			]);
			return { h, keep, finite, steady };
		}

		it("a recovered reconnect while overflowed is declined with a fresh session: no pid, no leave, live keys joined once, non-repeatable records interrupted", () => {
			const { h, keep, finite, steady } = overflowWhileDisconnected();
			const before = h.socket.emits.length;
			h.reconnect(true);
			expect(h.socket.disconnects).toBe(1);
			expect(h.socket._pid).toBeUndefined();
			expect(h.socket.active && !h.socket.connected).toBe(true);
			// Nothing is sent on the recovered session.
			expect(h.socket.emits.length).toBe(before);
			expect(finite.errors).toEqual([
				{
					code: "interrupted",
					message: "The connection restarted; the operation is not repeatable.",
				},
			]);
			h.reconnect(false);
			expect(h.sent().slice(before)).toEqual(["join:keep"]);
			expect(h.retained()).toEqual({ retired: 0, overflowed: false });
			// The loss at detection, then the outcome at the new connected.
			expect(steady.continuity).toEqual([
				{ reason: "reconnected" },
				{ reason: "reconnected" },
			]);
			expect(finite.continuity).toEqual([{ reason: "reconnected" }]);
			expect(keep.recording.errors).toEqual([]);
			h.ack(before);
			h.deliver("keep");
			expect(keep.recording.events).toHaveLength(1);
			expect(finite.events).toHaveLength(0);
		});

		it("without recovery the flag and the tombstones are simply dropped: no restart, nothing interrupted", () => {
			const { h, finite, steady } = overflowWhileDisconnected();
			const before = h.socket.emits.length;
			h.reconnect(false);
			expect(h.socket.disconnects).toBe(0);
			expect(h.socket._pid).toBe("pid-1");
			expect(h.sent().slice(before)).toEqual(["join:keep"]);
			expect(h.retained()).toEqual({ retired: 0, overflowed: false });
			expect(finite.errors).toEqual([]);
			expect(steady.continuity).toEqual([
				{ reason: "reconnected" },
				{ reason: "reconnected" },
			]);
		});

		it("more than 64 unacknowledged joins abandoned on a healthy connection restart it on a fresh session at once; the pending command is not re-sent and a regained key joins once", async () => {
			const h = rooms();
			const keep = h.member("keep");
			h.ack(0);
			const finite = h.listen(false);
			const gone = Array.from({ length: 65 }, (_, n) => h.member(`g${n}`));
			const outcome = h.command();
			for (const item of gone) {
				item.subscription.unsubscribe();
				expect(h.retained().retired).toBeLessThanOrEqual(64);
			}
			expect(h.retained()).toEqual({ retired: 64, overflowed: true });
			expect(uncertain(h.test)).toHaveLength(1);
			// No reconnect is needed: the restart runs once this task's
			// synchronous work is done.
			await Promise.resolve();
			expect(h.socket.disconnects).toBe(1);
			expect(h.socket._pid).toBeUndefined();
			expect(h.drops()).toBe(0);
			await expect(outcome).resolves.toMatchObject({
				status: "unknown",
				error: { code: "command-unknown", detail: { reason: "disconnected" } },
			});
			expect(finite.errors.map((error) => error.code)).toEqual(["interrupted"]);
			const regained = h.member("g0");
			const before = h.socket.emits.length;
			h.reconnect(false);
			expect(h.sent().slice(before).sort()).toEqual(["join:g0", "join:keep"]);
			expect(
				h.socket.emits.filter((emit) => emit.event === "echo"),
			).toHaveLength(1);
			expect(h.retained()).toEqual({ retired: 0, overflowed: false });
			// A deliberate restart reports once, at the new connected.
			expect(keep.recording.continuity).toEqual([{ reason: "reconnected" }]);
			h.ack(before);
			h.ack(before + 1);
			h.deliver("g0");
			h.deliver("keep");
			expect(regained.recording.events).toHaveLength(1);
			expect(keep.recording.events).toHaveLength(1);
			expect(keep.recording.errors).toEqual([]);
		});

		it("an overflow while connected never waits for a reconnect that may not come, and a drop before the restart defers it to the reconnect", async () => {
			const h = rooms();
			h.member("keep");
			h.ack(0);
			const gone = Array.from({ length: 65 }, (_, n) => h.member(`g${n}`));
			for (const item of gone) item.subscription.unsubscribe();
			// The transport drops before the restart runs: the flag decides at
			// the reconnect instead (recovered → declined).
			h.drop();
			await Promise.resolve();
			expect(h.socket.disconnects).toBe(0);
			expect(h.retained()).toEqual({ retired: 64, overflowed: true });
			h.reconnect(true);
			expect(h.socket.disconnects).toBe(1);
			h.reconnect(false);
			expect(h.retained()).toEqual({ retired: 0, overflowed: false });
		});

		it("a key refused by the cap and regained while disconnected is live on the fresh session with one join", () => {
			const { h } = overflowWhileDisconnected();
			const regained = h.member("g64");
			expect(h.retained()).toEqual({ retired: 64, overflowed: true });
			h.reconnect(true);
			const before = h.socket.emits.length;
			h.reconnect(false);
			expect(h.sent().slice(before).sort()).toEqual(["join:g64", "join:keep"]);
			h.ack(before);
			h.ack(before + 1);
			h.deliver("g64");
			expect(regained.recording.events).toHaveLength(1);
		});
	});

	// (a): a client-initiated reconnect — rotate(), or retry() after
	// `io server disconnect` — presents no recovery pid. socket.io-adapter
	// 2.5.8 keeps a restored session's saved room snapshot until it expires,
	// and a client or server namespace disconnect does not refresh it, so the
	// pid would restore rooms left since. Automatic Manager reconnects after
	// transport loss keep recovery (the server saved the session at the drop).
	describe("client-initiated reconnects decline recovery", () => {
		/**
		 * The recovery pid upstream would present with each later `connect()`
		 * (installed after the first subscription, which starts the socket).
		 */
		function pidAtConnect(socket: ReturnType<typeof rooms>["socket"]) {
			const seen: Array<string | undefined> = [];
			const connect = socket.connect.bind(socket);
			socket.connect = () => {
				seen.push(socket._pid);
				return connect();
			};
			return seen;
		}
		/** Upstream `ondisconnect()`: `destroy()`, then `io server disconnect`. */
		function serverDisconnect(socket: ReturnType<typeof rooms>["socket"]) {
			socket.active = false;
			socket.connected = false;
			socket.fire("disconnect", "io server disconnect");
		}

		it("rotate() after a recovered session clears the pid before connecting, with nothing retired; the fresh session reports `reconnected`, joins live keys once and replays no command", async () => {
			const h = rooms();
			const old = h.member("old");
			const keep = h.member("keep");
			const pids = pidAtConnect(h.socket);
			h.ack(0);
			h.ack(1);
			h.drop();
			h.reconnect(true);
			// Restored once: the recovered connect already cleared it.
			expect(h.socket._pid).toBeUndefined();
			old.subscription.unsubscribe();
			h.ack(2);
			expect(h.retained()).toEqual({ retired: 0, overflowed: false });
			const outcome = h.command();
			h.connection.rotate?.();
			expect(pids).toEqual([undefined]);
			expect(h.socket.disconnects).toBe(1);
			await expect(outcome).resolves.toMatchObject({
				status: "unknown",
				error: { code: "command-unknown", detail: { reason: "disconnected" } },
			});
			h.reconnect(false);
			const memberships = h.sent().filter((emit) => !emit.startsWith("echo"));
			expect(memberships).toEqual([
				"join:old",
				"join:keep",
				"leave:old",
				"join:keep",
			]);
			expect(
				h.socket.emits.filter((emit) => emit.event === "echo"),
			).toHaveLength(1);
			expect(keep.recording.continuity).toEqual([
				{ reason: "reconnected" },
				{ reason: "recovered" },
				{ reason: "reconnected" },
			]);
		});

		it("rotate() from auth-blocked clears the pid too: a rotation is a deliberate restart", () => {
			const h = rooms();
			h.member("keep");
			const pids = pidAtConnect(h.socket);
			h.ack(0);
			h.drop();
			h.socket.active = false;
			h.socket.fire(
				"connect_error",
				Object.assign(new Error("unauthorized"), { data: { status: 401 } }),
			);
			expect(h.test.lastStatus()?.state).toBe("auth-blocked");
			// Nothing was retired, so the block itself kept the pid.
			expect(h.socket._pid).toBe("pid-1");
			h.connection.rotate?.();
			expect(pids).toEqual([undefined]);
		});

		it("retry() after `io server disconnect` clears the pid before connecting, with nothing retired (the empty-tombstone case)", () => {
			const h = rooms();
			const old = h.member("old");
			const keep = h.member("keep");
			const pids = pidAtConnect(h.socket);
			h.ack(0);
			h.ack(1);
			h.drop();
			h.reconnect(true);
			old.subscription.unsubscribe();
			h.ack(2);
			expect(h.retained()).toEqual({ retired: 0, overflowed: false });
			serverDisconnect(h.socket);
			expect(h.test.lastStatus()).toMatchObject({
				state: "failed",
				reason: "server-closed",
			});
			// Restored once: the recovered connect already cleared it.
			expect(h.socket._pid).toBeUndefined();
			h.connection.retry?.();
			expect(pids).toEqual([undefined]);
			h.reconnect(false);
			expect(h.sent()).toEqual([
				"join:old",
				"join:keep",
				"leave:old",
				"join:keep",
			]);
			expect(keep.recording.continuity).toEqual([
				{ reason: "reconnected" },
				{ reason: "recovered" },
				{ reason: "reconnected" },
			]);
		});

		it("the first automatic reconnect after transport loss keeps the pid; the connect that reports `recovered` clears it", () => {
			const h = rooms();
			const keep = h.member("keep");
			const pids = pidAtConnect(h.socket);
			h.ack(0);
			h.drop();
			// The Manager loop reconnects on its own; the adapter never connects.
			expect(pids).toEqual([]);
			expect(h.socket._pid).toBe("pid-1");
			h.reconnect(true);
			expect(keep.recording.continuity.at(-1)).toEqual({
				reason: "recovered",
			});
			// A session is restored at most once.
			expect(h.socket._pid).toBeUndefined();
			expect(pids).toEqual([]);
		});

		// The decline itself, where the pid is still set: a session never
		// restored (upstream stores each new session's pid at its connect).
		it("rotate() on a live session never recovered clears the pid before connecting: every client-initiated reconnect starts a fresh session", () => {
			const h = rooms();
			const keep = h.member("keep");
			const pids = pidAtConnect(h.socket);
			h.ack(0);
			expect(h.socket._pid).toBe("pid-1");
			h.connection.rotate?.();
			expect(pids).toEqual([undefined]);
			expect(h.socket.disconnects).toBe(1);
			h.reconnect(false);
			expect(h.sent()).toEqual(["join:keep", "join:keep"]);
			expect(keep.recording.continuity).toEqual([{ reason: "reconnected" }]);
		});

		it("retry() after `io server disconnect` on a session never recovered clears the pid before connecting", () => {
			const h = rooms();
			h.member("keep");
			const pids = pidAtConnect(h.socket);
			h.ack(0);
			serverDisconnect(h.socket);
			expect(h.test.lastStatus()?.state).toBe("failed");
			expect(h.socket._pid).toBe("pid-1");
			h.connection.retry?.();
			expect(pids).toEqual([undefined]);
		});

		// Every client-initiated reconnect follows the same rule, not an
		// enumeration. A block with nothing retired keeps the pid (declines
		// only when it drops tombstones or the flag); the retry declines it.
		for (const block of [
			"retry-exhausted",
			"auth-blocked",
			"failed",
		] as const) {
			it(`retry() after ${block} with nothing retired clears the pid: every retry() branch starts a fresh session`, () => {
				const h = rooms();
				const keep = h.member("keep");
				const pids = pidAtConnect(h.socket);
				h.ack(0);
				h.drop();
				if (block === "retry-exhausted") {
					h.manager.fire("reconnect_failed");
				} else {
					h.socket.active = false;
					h.socket.fire(
						"connect_error",
						block === "auth-blocked"
							? Object.assign(new Error("unauthorized"), {
									data: { status: 401 },
								})
							: new Error("forbidden"),
					);
				}
				expect(h.test.lastStatus()?.state).toBe(block);
				expect(h.retained()).toEqual({ retired: 0, overflowed: false });
				expect(h.socket._pid).toBe("pid-1");
				h.connection.retry?.();
				expect(h.socket._pid).toBeUndefined();
				// The exhausted branch reopens the Manager; the others connect.
				expect(pids).toEqual(block === "retry-exhausted" ? [] : [undefined]);
				h.reconnect(false);
				expect(h.sent()).toEqual(["join:keep", "join:keep"]);
				expect(keep.recording.continuity.at(-1)).toEqual({
					reason: "reconnected",
				});
			});
		}

		it("rotate() with a held leave-timeout tombstone: no pid, and the fresh session drops the tombstone without a command (companion)", () => {
			const h = rooms();
			const r1 = h.member("r1");
			h.member("keep");
			const pids = pidAtConnect(h.socket);
			h.ack(0);
			h.ack(1);
			r1.subscription.unsubscribe();
			h.ack(2, timedOut());
			expect(h.retained()).toEqual({ retired: 1, overflowed: false });
			h.connection.rotate?.();
			expect(pids).toEqual([undefined]);
			h.reconnect(false);
			expect(h.sent()).toEqual([
				"join:r1",
				"join:keep",
				"leave:r1",
				"join:keep",
			]);
			expect(h.retained()).toEqual({ retired: 0, overflowed: false });
		});

		it("rotate() in the task of a connected overflow restarts once on a fresh session: no pid, the flag and tombstones cleared at the new connect (companion)", async () => {
			const h = rooms();
			h.member("keep");
			const pids = pidAtConnect(h.socket);
			h.ack(0);
			const gone = Array.from({ length: 65 }, (_, n) => h.member(`g${n}`));
			for (const item of gone) item.subscription.unsubscribe();
			expect(h.retained()).toEqual({ retired: 64, overflowed: true });
			h.connection.rotate?.();
			await Promise.resolve();
			expect(pids).toEqual([undefined]);
			expect(h.socket.disconnects).toBe(1);
			const before = h.socket.emits.length;
			h.reconnect(false);
			expect(h.sent().slice(before)).toEqual(["join:keep"]);
			expect(h.retained()).toEqual({ retired: 0, overflowed: false });
			expect(h.sent().some((emit) => emit.startsWith("leave:"))).toBe(false);
		});
	});

	// A session is restored at most once. Only a first restore is known
	// to use a snapshot the server saved at a disconnect it detected itself:
	// socket.io-adapter 2.5.8 keeps a restored session's snapshot and
	// socket.io 4.8.4 restores it on the old sid, so presenting the pid again
	// after a loss the client detected first restores rooms left since and,
	// once the old server socket times out, a session without rooms.
	describe("a session is restored at most once", () => {
		it("a connect that reports `recovered` clears the pid: the next automatic reconnect presents none, reports `reconnected`, joins live keys once and replays no command", async () => {
			const h = rooms();
			const keep = h.member("keep");
			const finite = h.listen(false);
			h.ack(0);
			h.drop();
			expect(h.socket._pid).toBe("pid-1");
			h.reconnect(true);
			expect(h.socket._pid).toBeUndefined();
			expect(h.sent()).toEqual(["join:keep"]);
			const outcome = h.command();
			h.drop();
			await expect(outcome).resolves.toMatchObject({
				status: "unknown",
				error: { code: "command-unknown", detail: { reason: "disconnected" } },
			});
			// No pid: the server starts a fresh session.
			h.reconnect(false);
			expect(h.sent().filter((emit) => !emit.startsWith("echo"))).toEqual([
				"join:keep",
				"join:keep",
			]);
			expect(
				h.socket.emits.filter((emit) => emit.event === "echo"),
			).toHaveLength(1);
			expect(keep.recording.continuity).toEqual([
				{ reason: "reconnected" },
				{ reason: "recovered" },
				{ reason: "reconnected" },
				{ reason: "reconnected" },
			]);
			// As on any reconnect without recovery: nothing ended here.
			expect(finite.errors).toEqual([]);
			expect(h.retained()).toEqual({ retired: 0, overflowed: false });
			h.ack(2);
			h.deliver("keep");
			expect(keep.recording.events).toHaveLength(1);
		});

		it("first-recovery control: a session never restored keeps its pid through connects without recovery and its first automatic reconnect, which is restored without a join", () => {
			const h = rooms();
			const keep = h.member("keep");
			h.ack(0);
			// The fake keeps the pid upstream stores at each connect.
			expect(h.socket._pid).toBe("pid-1");
			h.drop();
			h.reconnect(false);
			expect(h.socket._pid).toBe("pid-1");
			h.ack(1);
			h.drop();
			expect(h.socket._pid).toBe("pid-1");
			h.reconnect(true);
			expect(keep.recording.continuity.at(-1)).toEqual({
				reason: "recovered",
			});
			expect(h.sent()).toEqual(["join:keep", "join:keep"]);
			expect(h.retained()).toEqual({ retired: 0, overflowed: false });
		});

		// a rotation is a reconnect without recovery, not the
		// fresh session that abandons unaccountable membership state.
		it("rotate() takes the connect path of a reconnect without recovery: a non-repeatable listener is told `reconnected` and never ended `interrupted`", () => {
			const rotated = rooms();
			const rotatedFinite = rotated.listen(false);
			rotated.connection.rotate?.();
			rotated.reconnect(false);
			const dropped = rooms();
			const droppedFinite = dropped.listen(false);
			dropped.drop();
			dropped.reconnect(false);
			// The same outcome at the new connected; a deliberate restart does
			// not report the loss at detection as well.
			expect(rotatedFinite.continuity).toEqual([{ reason: "reconnected" }]);
			expect(droppedFinite.continuity).toEqual([
				{ reason: "reconnected" },
				{ reason: "reconnected" },
			]);
			expect(rotatedFinite.errors).toEqual([]);
			expect(droppedFinite.errors).toEqual([]);
			rotated.deliver("elsewhere");
			dropped.deliver("elsewhere");
			expect(rotatedFinite.events).toHaveLength(1);
			expect(droppedFinite.events).toHaveLength(1);
		});
	});

	// (b): in #join's timed-out-while-connected branch the consumers are
	// errored before the compensating leave, and an error handler may regain
	// the key, dispose the connection or restart the socket synchronously.
	// The leave is decided from the state after that loop.
	describe("(b): the compensating leave is decided after the consumers' error handlers", () => {
		const spec = (room: string) => ({
			event: "room",
			membership: room,
			route: "byRoom",
			join: { event: "join", args: [room] },
			leave: { event: "leave", args: [room] },
		});
		/** A consumer whose `error` runs `then` synchronously. */
		function reentrant(
			h: ReturnType<typeof rooms>,
			then: () => void,
		): ReturnType<typeof createRecordingSink<unknown[]>> {
			const first = createRecordingSink<unknown[]>();
			h.connection.subscribe(
				spec("r1"),
				{
					...first.sink,
					error: (error) => {
						first.sink.error(error);
						then();
					},
				},
				{ key: "first", repeatable: true },
			);
			return first;
		}

		it("a key regained synchronously inside the join-timeout error stays live: no compensating leave, one more join, and the regained consumer receives data", () => {
			const h = rooms();
			const regained = createRecordingSink<unknown[]>();
			const first = reentrant(h, () => {
				h.connection.subscribe(spec("r1"), regained.sink, {
					key: "again",
					repeatable: true,
				});
			});
			h.ack(0, timedOut());
			expect(first.errors.map((error) => error.code)).toEqual([
				"subscribe-rejected",
			]);
			expect(h.sent()).toEqual(["join:r1", "join:r1"]);
			h.ack(1);
			h.deliver("r1");
			expect(regained.events).toHaveLength(1);
			expect(regained.errors).toEqual([]);
			expect(h.retained()).toEqual({ retired: 0, overflowed: false });
		});

		it("a connection disposed synchronously inside the join-timeout error emits no leave on the disposed socket and reports nothing after dispose", () => {
			const h = rooms();
			let atDispose = -1;
			reentrant(h, () => {
				atDispose = h.test.diagnostics.length;
				h.connection.dispose();
			});
			h.ack(0, timedOut());
			expect(atDispose).toBeGreaterThanOrEqual(0);
			expect(h.sent()).toEqual(["join:r1"]);
			// A leave emitted on the disposed socket would time out later.
			for (const emit of h.socket.emits) emit.ack?.(timedOut());
			expect(h.test.diagnostics.slice(atDispose)).toEqual([]);
		});

		it("a key regained and left again inside the error handler is left once, after the regained join lands (order)", () => {
			const h = rooms();
			reentrant(h, () => {
				h.connection
					.subscribe(spec("r1"), createRecordingSink<unknown[]>().sink, {
						key: "again",
						repeatable: true,
					})
					.unsubscribe();
			});
			h.ack(0, timedOut());
			expect(h.sent()).toEqual(["join:r1", "join:r1"]);
			expect(h.retained()).toEqual({ retired: 1, overflowed: false });
			h.ack(1);
			expect(h.sent()).toEqual(["join:r1", "join:r1", "leave:r1"]);
			h.ack(2);
			expect(h.retained()).toEqual({ retired: 0, overflowed: false });
		});

		it("a socket restarted synchronously inside the error handler keeps the key as a tombstone instead of emitting a leave while disconnected", () => {
			const h = rooms();
			reentrant(h, () => h.connection.rotate?.());
			h.ack(0, timedOut());
			expect(h.sent()).toEqual(["join:r1"]);
			expect(h.retained()).toEqual({ retired: 1, overflowed: false });
			h.reconnect(false);
			expect(h.sent()).toEqual(["join:r1"]);
			expect(h.retained()).toEqual({ retired: 0, overflowed: false });
		});
	});

	// (c), diagnostics carry no application data; a
	// membership key is application-supplied room text.
	it("socket-io.leave-failed is payload-free: no diagnostic carries a membership key ((c))", () => {
		const key = "private-room:alice@example.test";
		const h = rooms();
		const member = h.member(key);
		h.ack(0);
		member.subscription.unsubscribe();
		// A connected timeout, then a recovery leave lost with the transport.
		h.ack(1, timedOut());
		h.drop();
		h.reconnect(true);
		expect(h.sent()).toEqual([`join:${key}`, `leave:${key}`, `leave:${key}`]);
		h.drop();
		expect(
			h.test.diagnostics.filter(
				(diagnostic) => diagnostic.type === "socket-io.leave-failed",
			),
		).toEqual([
			{ type: "socket-io.leave-failed" },
			{ type: "socket-io.leave-failed" },
		]);
		expect(JSON.stringify(h.test.diagnostics)).not.toContain("alice");
	});
});
