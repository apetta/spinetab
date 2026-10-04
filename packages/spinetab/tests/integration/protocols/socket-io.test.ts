import { createServer } from "node:http";
import {
	createServer as createNetServer,
	type Socket as NetSocket,
	connect as netConnect,
} from "node:net";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { Server, type Socket as ServerSocket } from "socket.io";
import { Manager, Socket } from "socket.io-client";
import { afterEach, describe, expect, it } from "vitest";
import type { AdapterConnection } from "../../../src/core/adapter.ts";
import type { CommandOutcome, Credentials } from "../../../src/core/types.ts";
import { socketIo } from "../../../src/protocols/socket-io/index.ts";
import {
	type SocketIoAdapterOptions,
	socketIoAdapter,
} from "../../../src/protocols/socket-io/runtime.ts";
import type {
	SocketIoCommand,
	SocketIoConnection,
	SocketIoSubscriptionSpec,
} from "../../../src/protocols/socket-io/spec.ts";
import type { SocketIoTagCounters } from "../../fixtures/servers/socket-io.ts";
import {
	clearFault,
	closedPort,
	createRecordingSink,
	createTestContext,
	primaryOrigin,
	readCounters,
	setFault,
	sleep,
	type TestContext,
	uniqueTag,
	waitFor,
} from "./helpers.ts";

// Real socket.io-client 4.8.4 Manager (in the adapter) against real
// socket.io 4.8.4 servers. Covers P-I-09…11.

async function tagCounters(tag: string): Promise<SocketIoTagCounters> {
	const all = await readCounters<{ tags: Record<string, SocketIoTagCounters> }>(
		"socket-io",
	);
	return all.tags[tag] as SocketIoTagCounters;
}

const control = (action: string, tag: string) =>
	fetch(`${primaryOrigin()}/socket-io-control/${action}?tag=${tag}`, {
		method: "POST",
	});

const connections: AdapterConnection[] = [];
afterEach(() => {
	for (const connection of connections.splice(0)) connection.dispose();
});

function setup(
	tag: string,
	options: {
		connection?: Partial<SocketIoConnection>;
		adapter?: SocketIoAdapterOptions;
		ticks?: number;
		token?: (revision: number) => string;
		url?: string;
	} = {},
) {
	const adapter = socketIoAdapter(options.adapter);
	const endpoint = socketIo({
		url: options.url ?? primaryOrigin(),
		sharing: "shared",
		reconnectionDelayMs: 30,
		reconnectionDelayMaxMs: 60,
		query: { tag, ...(options.ticks ? { ticks: String(options.ticks) } : {}) },
		...options.connection,
	});
	const test = createTestContext({
		scope: tag,
		credentials: (revision) => ({
			auth: { token: options.token?.(revision) ?? `valid-${tag}-${revision}` },
		}),
	});
	const opened = new Map<string, AdapterConnection>();
	const connectionFor = (spec: SocketIoConnection) => {
		adapter.validateConnection?.(spec);
		const key = adapter.connectionKey?.(spec) ?? "";
		let connection = opened.get(key);
		if (!connection) {
			connection = adapter.connect(spec, test.ctx);
			opened.set(key, connection);
			connections.push(connection);
		}
		return connection;
	};
	const subscribe = (spec: SocketIoSubscriptionSpec) => {
		const request = endpoint.subscription(spec);
		adapter.validateSubscription?.(request.subscription);
		const recording = createRecordingSink<unknown[]>();
		const subscription = connectionFor(request.connection).subscribe(
			request.subscription,
			recording.sink,
			{ key: JSON.stringify(request.subscription), repeatable: true },
		);
		return { recording, subscription };
	};
	const command = (
		spec: SocketIoCommand,
		signal = new AbortController().signal,
	) => {
		const request = endpoint.command(spec);
		const connection = connectionFor(request.connection);
		return connection.command?.(request.payload, {
			id: crypto.randomUUID(),
			signal,
			timeoutMs: 30_000,
		}) as Promise<CommandOutcome<unknown>>;
	};
	return {
		endpoint,
		test,
		subscribe,
		command,
		connection: () => [...opened.values()][0],
	};
}

describe("socket.io adapter against real socket.io servers", () => {
	for (const transport of ["websocket", "polling"] as const) {
		it(`${transport}-only transport delivers events with auth in the namespace payload (P-I-09)`, async () => {
			const tag = uniqueTag(`sio${transport[0]}`);
			const { subscribe, test } = setup(tag, {
				ticks: 25,
				connection: { transports: [transport] },
			});
			const ticks = subscribe({ event: "tick" });
			await waitFor(() => ticks.recording.events.length >= 3);
			const counters = await tagCounters(tag);
			expect(counters.byTransport).toEqual({ [transport]: 1 });
			expect(counters.upgrades).toBe(0);
			expect(counters.tokens).toEqual([`valid-${tag}-1`]);
			expect(ticks.recording.events[0]?.[0]).toMatchObject({ n: 1, tag });
			expect(test.diagnostics).toContainEqual({
				type: "socket-io.transport",
				detail: { transport },
			});
		});
	}

	it("routes room events by membership key and joins once per key (P-I-09)", async () => {
		const tag = uniqueTag("sior");
		const [roomA, roomB] = [`${tag}a`, `${tag}b`];
		const { subscribe } = setup(tag, {
			adapter: {
				routes: {
					byRoom: (args) => [String((args[0] as { room: string }).room)],
				},
			},
		});
		const member = (room: string) =>
			subscribe({
				event: "room",
				membership: room,
				route: "byRoom",
				join: { event: "join", args: [room] },
				leave: { event: "leave", args: [room] },
			});
		const a = member(roomA);
		const b = member(roomB);
		await waitFor(
			() => a.recording.events.length >= 3 && b.recording.events.length >= 3,
		);
		expect(
			a.recording.events.every(
				(args) => (args[0] as { room: string }).room === roomA,
			),
		).toBe(true);
		expect(
			b.recording.events.every(
				(args) => (args[0] as { room: string }).room === roomB,
			),
		).toBe(true);
		let counters = await tagCounters(tag);
		expect(counters.connections).toBe(1);
		expect(counters.joins).toEqual({ [roomA]: 1, [roomB]: 1 });

		a.subscription.unsubscribe();
		await waitFor(async () => (await tagCounters(tag)).leaves[roomA] === 1);
		counters = await tagCounters(tag);
		expect(counters.leaves).toEqual({ [roomA]: 1 });
	});

	it("the URL path is the namespace, as with upstream io()", async () => {
		for (const form of ["path", "explicit"] as const) {
			const tag = uniqueTag(`sion${form[0]}`);
			const { subscribe } = setup(tag, {
				ticks: 25,
				...(form === "path"
					? { url: `${primaryOrigin()}/ops` }
					: { connection: { namespace: "/ops" } }),
			});
			const ticks = subscribe({ event: "tick" });
			await waitFor(() => ticks.recording.events.length >= 2);
			expect((await tagCounters(tag)).byNamespace, form).toEqual({
				"/ops": 1,
			});
		}
	});

	it("resolves command outcomes exactly once per call (P-I-10)", async () => {
		const tag = uniqueTag("sioc");
		const { command, test } = setup(tag, { connection: { ackTimeoutMs: 200 } });
		await expect(
			command({ event: "echo", args: [{ value: 7 }] }),
		).resolves.toEqual({
			status: "acknowledged",
			value: { value: 7 },
		});
		await expect(
			command({ event: "reject", args: [], ack: "error-first" }),
		).resolves.toMatchObject({
			status: "rejected",
			error: { code: "command-rejected", detail: { reason: "not allowed" } },
		});
		await expect(command({ event: "count", ack: false })).resolves.toEqual({
			status: "sent",
		});
		await setFault(`socket-io@${tag}`, "drop-ack");
		await expect(command({ event: "echo", args: [1] })).resolves.toMatchObject({
			status: "unknown",
			error: { code: "command-unknown", detail: { reason: "timeout" } },
		});
		// Disconnected mid-flight: acknowledgement lost with the transport.
		const pending = command({ event: "echo", args: [2] });
		await sleep(20);
		await control("disconnect", tag);
		await expect(pending).resolves.toMatchObject({
			status: "unknown",
			error: { detail: { reason: "disconnected" } },
		});
		await waitFor(() => test.hasStatus("failed", { reason: "server-closed" }));
		// Not connected: rejected immediately, never buffered for later.
		await expect(command({ event: "echo", args: [3] })).resolves.toMatchObject({
			status: "not-sent",
		});
		await sleep(100);
		const counters = await tagCounters(tag);
		expect(counters.commands).toEqual({ echo: 3, reject: 1, count: 1 });
	});

	it("recovered sessions report `recovered` and keep memberships (P-I-11)", async () => {
		const tag = uniqueTag("siorc");
		const room = `${tag}r`;
		const { subscribe } = setup(tag, {
			ticks: 20,
			adapter: {
				routes: {
					byRoom: (args) => [String((args[0] as { room: string }).room)],
				},
			},
		});
		const ticks = subscribe({ event: "tick" });
		const member = subscribe({
			event: "room",
			membership: room,
			route: "byRoom",
			join: { event: "join", args: [room] },
		});
		await waitFor(
			() =>
				ticks.recording.events.length >= 2 &&
				member.recording.events.length >= 2,
		);
		await control("close-transport", tag);
		// The loss is reported when detected (continuity unknown); recovery
		// is only known at reconnect and upgrades it.
		await waitFor(() => ticks.recording.continuity.length === 2);
		const outcomes = [{ reason: "reconnected" }, { reason: "recovered" }];
		expect(ticks.recording.continuity).toEqual(outcomes);
		expect(member.recording.continuity).toEqual(outcomes);
		const before = member.recording.events.length;
		await waitFor(() => member.recording.events.length > before + 1);
		const counters = await tagCounters(tag);
		expect(counters.recovered).toBe(1);
		expect(counters.joins).toEqual({ [room]: 1 });
	});

	it("unrecovered sessions report `reconnected` and rejoin before delivery (P-I-11)", async () => {
		const tag = uniqueTag("sionr");
		const room = `${tag}r`;
		const { subscribe } = setup(tag, {
			connection: { path: "/socket.io-nocsr" },
			adapter: {
				routes: {
					byRoom: (args) => [String((args[0] as { room: string }).room)],
				},
			},
		});
		const member = subscribe({
			event: "room",
			membership: room,
			route: "byRoom",
			join: { event: "join", args: [room] },
		});
		await waitFor(() => member.recording.events.length >= 2);
		await control("close-transport", tag);
		await waitFor(() => member.recording.continuity.length === 1);
		expect(member.recording.continuity).toEqual([{ reason: "reconnected" }]);
		const before = member.recording.events.length;
		await waitFor(() => member.recording.events.length > before + 1);
		const counters = await tagCounters(tag);
		expect(counters.recovered).toBe(0);
		expect(counters.joins).toEqual({ [room]: 2 });
		expect(counters.connections).toBe(2);
	});

	it("server disconnect fails without reconnecting; explicit retry reconnects (P-I-11)", async () => {
		const tag = uniqueTag("siosd");
		const { subscribe, test, connection } = setup(tag, { ticks: 20 });
		const ticks = subscribe({ event: "tick" });
		await waitFor(() => ticks.recording.events.length >= 1);
		await control("disconnect", tag);
		await waitFor(() => test.hasStatus("failed"));
		expect(test.lastStatus()).toMatchObject({
			state: "failed",
			reason: "server-closed",
			code: "io server disconnect",
		});
		await sleep(200);
		expect((await tagCounters(tag)).connections).toBe(1);
		connection()?.retry?.();
		await waitFor(() => test.lastStatus()?.state === "connected");
		const before = ticks.recording.events.length;
		await waitFor(() => ticks.recording.events.length > before);
		expect((await tagCounters(tag)).connections).toBe(2);
		expect(ticks.recording.continuity).toEqual([{ reason: "reconnected" }]);
	});

	it("middleware rejection is auth-blocked with one attempt per revision (P-I-11)", async () => {
		const tag = uniqueTag("sioau");
		const { subscribe, test, connection } = setup(tag, {
			ticks: 20,
			token: (revision) =>
				revision === 1 ? `revoked-${tag}-1` : `valid-${tag}-${revision}`,
		});
		const ticks = subscribe({ event: "tick" });
		await waitFor(() => test.hasStatus("auth-blocked"));
		expect(test.rejections).toEqual([1]);
		connection()?.retry?.();
		await sleep(200);
		let counters = await tagCounters(tag);
		expect(counters.tokens).toEqual([`revoked-${tag}-1`]);
		expect(test.lastStatus()).toMatchObject({ reason: "credentials-rejected" });

		test.setRevision(2);
		connection()?.rotate?.();
		await waitFor(() => ticks.recording.events.length >= 1);
		counters = await tagCounters(tag);
		expect(counters.tokens).toEqual([`revoked-${tag}-1`, `valid-${tag}-2`]);
	});

	it("reports retry-exhausted after the finite Manager budget (P-I-11)", async () => {
		const tag = uniqueTag("sioex");
		const { subscribe, test } = setup(tag, {
			url: `http://127.0.0.1:${await closedPort()}`,
			connection: { reconnectionAttempts: 2, timeoutMs: 500 },
		});
		subscribe({ event: "tick" });
		await waitFor(() => test.hasStatus("retry-exhausted"), { timeout: 10_000 });
		expect(
			test.statuses
				.filter((status) => status.attempt !== undefined)
				.map((s) => s.attempt),
		).toEqual([1, 2]);
	});

	it("answers server-requested acknowledgements only through a worker responder", async () => {
		const tag = uniqueTag("sioask");
		const { subscribe, command, test } = setup(tag, {
			adapter: {
				responders: {
					ask: (args) => ({
						answer: (args[0] as { question: number }).question + 1,
					}),
				},
			},
		});
		const asks = subscribe({ event: "ask" });
		await command({ event: "please-ask", ack: false });
		await waitFor(async () => (await tagCounters(tag))?.answers.length === 1);
		expect((await tagCounters(tag)).answers).toEqual([{ answer: 43 }]);
		// The ack function never reaches consumers.
		expect(asks.recording.events).toEqual([[{ question: 42 }]]);
		expect(
			test.diagnostics.some(
				(d) => d.type === "socket-io.server-ack-unanswered",
			),
		).toBe(false);
	});

	it("never calls a server-requested acknowledgement without a worker responder", async () => {
		const tag = uniqueTag("sionr");
		const { subscribe, command, test } = setup(tag);
		const asks = subscribe({ event: "ask" });
		await command({ event: "please-ask", ack: false });
		await waitFor(() => asks.recording.events.length === 1);
		// The ack function is stripped: consumers get plain, cloneable args.
		expect(asks.recording.events[0]).toEqual([{ question: 42 }]);
		expect(structuredClone(asks.recording.events[0])).toEqual([
			{ question: 42 },
		]);
		expect(test.diagnostics).toContainEqual({
			type: "socket-io.server-ack-unanswered",
			detail: { event: "ask" },
		});
	});
});

// the last consumer of a key leaves while the key's
// join still awaits its acknowledgement. The real server has joined the room,
// so the leave must follow once the acknowledgement lands.
describe("socket.io join and leave serialisation", () => {
	it("a leave for a join still awaiting its acknowledgement reaches the server", async () => {
		const tag = uniqueTag("siol");
		const room = `${tag}r`;
		const { subscribe } = setup(tag, {
			ticks: 25,
			adapter: {
				routes: {
					byRoom: (args) => [String((args[0] as { room: string }).room)],
				},
			},
		});
		const ticks = subscribe({ event: "tick" });
		await waitFor(() => ticks.recording.events.length >= 1);
		const member = subscribe({
			event: "room",
			membership: room,
			route: "byRoom",
			join: { event: "join", args: [room] },
			leave: { event: "leave", args: [room] },
		});
		// Synchronously after the join was emitted: its acknowledgement is pending.
		member.subscription.unsubscribe();
		await waitFor(async () => (await tagCounters(tag)).leaves[room] === 1);
		const counters = await tagCounters(tag);
		expect(counters.joins).toEqual({ [room]: 1 });
		expect(counters.leaves).toEqual({ [room]: 1 });
		expect(member.recording.events).toEqual([]);
	});
});

// A recovered session can restore retired memberships; leave them once without replaying joins.
describe("socket.io retired memberships across connection-state recovery", () => {
	const byRoom = (args: readonly unknown[]) => [
		String((args[0] as { room: string }).room),
	];

	async function serverRooms(tag: string): Promise<string[]> {
		const response = await fetch(
			`${primaryOrigin()}/socket-io-control/rooms?tag=${tag}`,
		);
		return ((await response.json()) as { rooms: string[] }).rooms;
	}

	const restores: Array<() => void> = [];
	afterEach(() => {
		for (const restore of restores.splice(0)) restore();
	});

	/** Every Manager the adapter asks for a namespace socket. */
	function captureManagers(): Manager[] {
		const captured: Manager[] = [];
		const original = Manager.prototype.socket;
		Manager.prototype.socket = function (
			this: Manager,
			...args: Parameters<typeof original>
		) {
			if (!captured.includes(this)) captured.push(this);
			return original.apply(this, args);
		};
		restores.push(() => {
			Manager.prototype.socket = original;
		});
		return captured;
	}

	/** engine.io-client 6.6.7 internals the fault legs drive. */
	type EngineInternals = {
		_pingTimeoutTime: number;
		transport: { name: string; ws?: { send: (...args: unknown[]) => void } };
	};
	const engineOf = (managers: Manager[]) => {
		const engine = managers[0]?.engine as unknown as
			| EngineInternals
			| undefined;
		if (!engine) throw new Error("the adapter's Manager has no engine");
		return engine;
	};
	/**
	 * As after a suspension: the heartbeat deadline has passed, so upstream
	 * buffers the next emit, keeps its ack through the drop, closes with
	 * "ping timeout" and flushes the packet on the next session.
	 */
	const expireHeartbeat = (managers: Manager[]) => {
		engineOf(managers)._pingTimeoutTime = Date.now() - 1;
	};
	/** A half-open socket: the network loses whatever is written from now on. */
	const loseWrites = (managers: Manager[]) => {
		const transport = engineOf(managers).transport;
		expect(transport.name).toBe("websocket");
		if (transport.ws) transport.ws.send = () => {};
	};

	function rooms(
		tag: string,
		recovery: boolean,
		connection: Partial<SocketIoConnection> = {},
	) {
		const harness = setup(tag, {
			connection: {
				...(recovery ? {} : { path: "/socket.io-nocsr" }),
				...connection,
			},
			adapter: { routes: { byRoom } },
		});
		// Unrouted: every `room` packet the server sends to this socket.
		const raw = harness.subscribe({ event: "room" });
		const member = (room: string) =>
			harness.subscribe({
				event: "room",
				membership: room,
				route: "byRoom",
				join: { event: "join", args: [room] },
				leave: { event: "leave", args: [room] },
			});
		const connects = () =>
			harness.test.statuses.filter((status) => status.state === "connected")
				.length;
		/** Rooms heard after in-flight packets drained (the leave is a round trip). */
		const heard = async () => {
			await sleep(200);
			const mark = raw.recording.events.length;
			await sleep(400);
			return [
				...new Set(
					raw.recording.events
						.slice(mark)
						.map((args) => (args[0] as { room: string }).room),
				),
			].sort();
		};
		/** The server drops the transport; the next namespace connect may recover. */
		const drop = async () => {
			const before = connects();
			await control("close-transport", tag);
			return before;
		};
		return { ...harness, raw, member, connects, heard, drop };
	}

	for (const recovery of [true, false]) {
		const mode = recovery ? "recovery on" : "recovery off";

		it(`an unacknowledged join whose last consumer left is released after the reconnect (${mode}; root repro)`, async () => {
			const tag = uniqueTag("sioret");
			const [retired, retained] = [`${tag}a`, `${tag}b`];
			const { test, member, connects, heard, drop } = rooms(tag, recovery, {
				ackTimeoutMs: 5_000,
			});
			await waitFor(() => test.hasStatus("connected"));
			await setFault(`socket-io@${tag}`, "drop-ack");
			member(retired).subscription.unsubscribe();
			await waitFor(
				async () => (await tagCounters(tag))?.joins?.[retired] === 1,
			);
			await clearFault(`socket-io@${tag}`, "drop-ack");
			const active = member(retained);
			await waitFor(() => active.recording.events.length >= 2);
			await drop();
			await waitFor(() => connects() === 2, { timeout: 5_000 });
			expect(
				await heard(),
				"the server no longer sends the retired room",
			).toEqual([retained]);
			expect(await serverRooms(tag)).toEqual([retained]);
			const counters = await tagCounters(tag);
			expect(counters.recovered).toBe(recovery ? 1 : 0);
			expect(active.recording.errors).toEqual([]);
			// One declared leave for the join that may have applied; none
			// without recovery (the server kept no rooms).
			expect(counters.leaves).toEqual(recovery ? { [retired]: 1 } : {});
			// The confirmed membership is not joined twice in a recovered session.
			expect(counters.joins).toEqual({
				[retired]: 1,
				[retained]: recovery ? 1 : 2,
			});
		});

		it(`an unacknowledged join whose last consumer left while disconnected is released after the reconnect (${mode})`, async () => {
			const tag = uniqueTag("sioretu");
			const [retired, retained] = [`${tag}a`, `${tag}b`];
			const { test, raw, member, connects, heard, drop } = rooms(
				tag,
				recovery,
				{
					reconnectionDelayMs: 500,
					reconnectionDelayMaxMs: 500,
					ackTimeoutMs: 5_000,
				},
			);
			const kept = member(retained);
			await waitFor(() => kept.recording.events.length >= 2);
			await setFault(`socket-io@${tag}`, "drop-ack");
			const gone = member(retired);
			await waitFor(
				async () => (await tagCounters(tag))?.joins?.[retired] === 1,
			);
			await clearFault(`socket-io@${tag}`, "drop-ack");
			await waitFor(() =>
				raw.recording.events.some(
					(args) => (args[0] as { room: string }).room === retired,
				),
			);
			await drop();
			await waitFor(() => test.lastStatus()?.state === "reconnecting");
			gone.subscription.unsubscribe();
			expect(connects(), "still disconnected").toBe(1);
			await waitFor(() => connects() === 2, { timeout: 5_000 });
			expect(await heard()).toEqual([retained]);
			expect(await serverRooms(tag)).toEqual([retained]);
			const counters = await tagCounters(tag);
			expect(counters.recovered).toBe(recovery ? 1 : 0);
			expect(counters.leaves).toEqual(recovery ? { [retired]: 1 } : {});
			expect(counters.joins).toEqual({
				[retired]: 1,
				[retained]: recovery ? 1 : 2,
			});
			expect(gone.recording.events).toEqual([]);
		});

		it(`a confirmed membership whose last consumer left while disconnected is released once (${mode})`, async () => {
			const tag = uniqueTag("sioretd");
			const [retired, retained] = [`${tag}a`, `${tag}b`];
			const { test, member, connects, heard, drop } = rooms(tag, recovery, {
				reconnectionDelayMs: 500,
				reconnectionDelayMaxMs: 500,
			});
			const gone = member(retired);
			const kept = member(retained);
			await waitFor(
				() =>
					gone.recording.events.length >= 2 &&
					kept.recording.events.length >= 2,
			);
			await drop();
			await waitFor(() => test.lastStatus()?.state === "reconnecting");
			gone.subscription.unsubscribe();
			expect(connects(), "still disconnected").toBe(1);
			await waitFor(() => connects() === 2, { timeout: 5_000 });
			expect(await heard()).toEqual([retained]);
			expect(await serverRooms(tag)).toEqual([retained]);
			let counters = await tagCounters(tag);
			expect(counters.recovered).toBe(recovery ? 1 : 0);
			expect(counters.leaves).toEqual(recovery ? { [retired]: 1 } : {});
			expect(counters.joins).toEqual({
				[retired]: 1,
				[retained]: recovery ? 1 : 2,
			});
			expect(kept.recording.errors).toEqual([]);
			// Bounded: the reference went with its leave (or with the
			// unrecovered reconnect), so a later reconnect sends nothing more.
			await drop();
			await waitFor(() => connects() === 3, { timeout: 5_000 });
			await sleep(200);
			counters = await tagCounters(tag);
			expect(counters.leaves).toEqual(recovery ? { [retired]: 1 } : {});
			expect(await serverRooms(tag)).toEqual([retained]);
		});

		it(`timed-out joins that may have applied are left at the timeout, not again after the reconnect (${mode})`, async () => {
			const tag = uniqueTag("sioreto");
			const [left, rejected, retained] = [`${tag}a`, `${tag}b`, `${tag}c`];
			const { test, member, connects, heard, drop } = rooms(tag, recovery, {
				ackTimeoutMs: 300,
			});
			await waitFor(() => test.hasStatus("connected"));
			await setFault(`socket-io@${tag}`, "drop-ack");
			// The last consumer leaves while the join is in flight; the join
			// then times out.
			member(left).subscription.unsubscribe();
			// A consumer kept until the timeout errors it.
			const failed = member(rejected);
			await waitFor(() => failed.recording.errors.length === 1);
			expect(failed.recording.errors[0]?.code).toBe("subscribe-rejected");
			await clearFault(`socket-io@${tag}`, "drop-ack");
			const kept = member(retained);
			await waitFor(() => kept.recording.events.length >= 2);
			// acknowledged; each was compensated with one leave at its timeout.
			await waitFor(async () => (await serverRooms(tag)).join() === retained);
			expect((await tagCounters(tag)).leaves).toEqual({
				[left]: 1,
				[rejected]: 1,
			});
			await drop();
			await waitFor(() => connects() === 2, { timeout: 5_000 });
			expect(await heard()).toEqual([retained]);
			expect(await serverRooms(tag)).toEqual([retained]);
			const counters = await tagCounters(tag);
			expect(counters.recovered).toBe(recovery ? 1 : 0);
			expect(counters.leaves).toEqual({ [left]: 1, [rejected]: 1 });
			expect(counters.joins).toEqual({
				[left]: 1,
				[rejected]: 1,
				[retained]: recovery ? 1 : 2,
			});
		});

		it(`a confirmed key regained before the reconnect stays live without a duplicate join (${mode})`, async () => {
			const tag = uniqueTag("sioregj");
			const room = `${tag}r`;
			const { test, member, connects, drop } = rooms(tag, recovery, {
				reconnectionDelayMs: 500,
				reconnectionDelayMaxMs: 500,
			});
			const first = member(room);
			await waitFor(() => first.recording.events.length >= 2);
			await drop();
			await waitFor(() => test.lastStatus()?.state === "reconnecting");
			first.subscription.unsubscribe();
			const again = member(room);
			expect(connects(), "still disconnected").toBe(1);
			await waitFor(() => connects() === 2, { timeout: 5_000 });
			await waitFor(() => again.recording.events.length >= 3);
			await sleep(200);
			const counters = await tagCounters(tag);
			expect(counters.recovered).toBe(recovery ? 1 : 0);
			expect(counters.leaves).toEqual({});
			// Recovered: the room survived, so no second join; otherwise the
			// new session joins once.
			expect(counters.joins).toEqual({ [room]: recovery ? 1 : 2 });
			expect(await serverRooms(tag)).toEqual([room]);
			expect(again.recording.errors).toEqual([]);
		});

		it(`a key regained before the reconnect whose join was unacknowledged is joined once more (${mode})`, async () => {
			const tag = uniqueTag("sioregu");
			const room = `${tag}r`;
			const { test, raw, member, connects, drop } = rooms(tag, recovery, {
				reconnectionDelayMs: 500,
				reconnectionDelayMaxMs: 500,
				ackTimeoutMs: 5_000,
			});
			await waitFor(() => test.hasStatus("connected"));
			await setFault(`socket-io@${tag}`, "drop-ack");
			const first = member(room);
			await waitFor(async () => (await tagCounters(tag))?.joins?.[room] === 1);
			await clearFault(`socket-io@${tag}`, "drop-ack");
			// A received broadcast carries the offset a recovery handshake needs
			// (upstream sends `pid` and `offset`; the server needs both).
			await waitFor(() => raw.recording.events.length >= 2);
			await drop();
			await waitFor(() => test.lastStatus()?.state === "reconnecting");
			first.subscription.unsubscribe();
			const again = member(room);
			expect(connects(), "still disconnected").toBe(1);
			await waitFor(() => connects() === 2, { timeout: 5_000 });
			await waitFor(() => again.recording.events.length >= 3);
			await sleep(200);
			const counters = await tagCounters(tag);
			expect(counters.recovered).toBe(recovery ? 1 : 0);
			expect(counters.leaves).toEqual({});
			// The join may have applied (the server's join is idempotent): one
			// re-join so the key is known to be joined before delivery.
			expect(counters.joins).toEqual({ [room]: 2 });
			expect(await serverRooms(tag)).toEqual([room]);
			expect(first.recording.events).toEqual([]);
		});

		it(`a join upstream buffered at the drop whose last consumer left is left once it lands on the new session (${mode}; VG-1)`, async () => {
			const tag = uniqueTag("sioretb");
			const [buffered, retained] = [`${tag}k`, `${tag}b`];
			const managers = captureManagers();
			const { test, member, connects, heard } = rooms(tag, recovery, {
				reconnectionDelayMs: 300,
				reconnectionDelayMaxMs: 300,
				ackTimeoutMs: 5_000,
			});
			const kept = member(retained);
			await waitFor(() => kept.recording.events.length >= 2);
			expireHeartbeat(managers);
			member(buffered).subscription.unsubscribe();
			await waitFor(() => test.lastStatus()?.state === "reconnecting");
			expect(connects(), "still disconnected").toBe(1);
			await waitFor(() => connects() === 2, { timeout: 5_000 });
			// Upstream flushed the buffered join on the new session.
			await waitFor(
				async () => (await tagCounters(tag))?.joins?.[buffered] === 1,
			);
			expect(await heard()).toEqual([retained]);
			expect(await serverRooms(tag)).toEqual([retained]);
			const counters = await tagCounters(tag);
			expect(counters.recovered).toBe(recovery ? 1 : 0);
			expect(counters.leaves).toEqual({ [buffered]: 1 });
			expect(counters.joins).toEqual({
				[buffered]: 1,
				[retained]: recovery ? 1 : 2,
			});
			expect(kept.recording.errors).toEqual([]);
		});

		it(`a leave lost with the dying transport is sent once more after recovery only (${mode}; VG-2)`, async () => {
			const tag = uniqueTag("sioretl");
			const [left, retained] = [`${tag}a`, `${tag}b`];
			const managers = captureManagers();
			const { test, member, connects, heard, drop } = rooms(tag, recovery, {
				transports: ["websocket"],
				reconnectionDelayMs: 300,
				reconnectionDelayMaxMs: 300,
			});
			const gone = member(left);
			const kept = member(retained);
			await waitFor(
				() =>
					gone.recording.events.length >= 2 &&
					kept.recording.events.length >= 2,
			);
			loseWrites(managers);
			gone.subscription.unsubscribe();
			await drop();
			await waitFor(() => connects() === 2, { timeout: 5_000 });
			expect(await heard()).toEqual([retained]);
			expect(await serverRooms(tag)).toEqual([retained]);
			const counters = await tagCounters(tag);
			expect(counters.recovered).toBe(recovery ? 1 : 0);
			// Payload-free: no membership key.
			expect(test.diagnostics).toContainEqual({
				type: "socket-io.leave-failed",
			});
			expect(JSON.stringify(test.diagnostics)).not.toContain(left);
			// The first leave never reached the server.
			expect(counters.leaves).toEqual(recovery ? { [left]: 1 } : {});
			expect(counters.joins).toEqual({
				[left]: 1,
				[retained]: recovery ? 1 : 2,
			});
		});

		it(`a leave upstream buffered at the drop that timed out before the reconnect is sent after recovery only (${mode}; VG-2)`, async () => {
			const tag = uniqueTag("sioretc");
			const [left, retained] = [`${tag}a`, `${tag}b`];
			const managers = captureManagers();
			const { test, member, connects, heard } = rooms(tag, recovery, {
				reconnectionDelayMs: 800,
				reconnectionDelayMaxMs: 800,
				ackTimeoutMs: 200,
			});
			const gone = member(left);
			const kept = member(retained);
			await waitFor(
				() =>
					gone.recording.events.length >= 2 &&
					kept.recording.events.length >= 2,
			);
			expireHeartbeat(managers);
			gone.subscription.unsubscribe();
			// Upstream's ack timer removes the buffered leave unsent.
			await waitFor(() =>
				test.diagnostics.some(
					(diagnostic) => diagnostic.type === "socket-io.leave-failed",
				),
			);
			expect(connects(), "still disconnected").toBe(1);
			await waitFor(() => connects() === 2, { timeout: 5_000 });
			expect(await heard()).toEqual([retained]);
			expect(await serverRooms(tag)).toEqual([retained]);
			const counters = await tagCounters(tag);
			expect(counters.recovered).toBe(recovery ? 1 : 0);
			expect(counters.leaves).toEqual(recovery ? { [left]: 1 } : {});
			expect(counters.joins).toEqual({
				[left]: 1,
				[retained]: recovery ? 1 : 2,
			});
		});
	}
});

// Sample both server rooms and retained client records to catch cleanup that only fixes one side.
describe("socket.io bounded membership cleanup", () => {
	const RESTARTED =
		"The connection restarted; the operation is not repeatable.";
	const RETAINED = Symbol.for("spinetab.socket-io.retained");
	const byRoom = (args: readonly unknown[]) => [
		String((args[0] as { room: string }).room),
	];
	const retainedOf = (
		connection: AdapterConnection | undefined,
	): { retired: number; overflowed: boolean } => {
		const read = (connection as unknown as Record<symbol, unknown>)?.[RETAINED];
		if (typeof read !== "function") {
			throw new Error("the retained-references oracle is missing");
		}
		return read.call(connection);
	};
	const serverRooms = async (tag: string) =>
		(
			(await (
				await fetch(`${primaryOrigin()}/socket-io-control/rooms?tag=${tag}`)
			).json()) as { rooms: string[] }
		).rooms;
	const roomsIn = (events: unknown[][], from: number) =>
		[
			...new Set(
				events.slice(from).map((args) => (args[0] as { room: string }).room),
			),
		].sort();
	const uncertain = (test: ReturnType<typeof setup>["test"]) =>
		test.diagnostics.filter(
			(diagnostic) => diagnostic.type === "membership-cleanup-uncertain",
		);

	const samplers: Array<ReturnType<typeof setInterval>> = [];
	afterEach(() => {
		for (const sampler of samplers.splice(0)) clearInterval(sampler);
	});

	function bounded(
		tag: string,
		recovery: boolean,
		connection: Partial<SocketIoConnection>,
	) {
		const harness = setup(tag, {
			connection: {
				...(recovery ? {} : { path: "/socket.io-nocsr" }),
				...connection,
			},
			adapter: { routes: { byRoom } },
		});
		// Unrouted: every `room` packet the server sends to this socket.
		const raw = harness.subscribe({ event: "room" });
		const member = (room: string) =>
			harness.subscribe({
				event: "room",
				membership: room,
				route: "byRoom",
				join: { event: "join", args: [room] },
				leave: { event: "leave", args: [room] },
			});
		/** A non-repeatable namespace-wide listener. */
		const finite = () => {
			const request = harness.endpoint.subscription({ event: "room" });
			const recording = createRecordingSink<unknown[]>();
			harness.connection()?.subscribe(request.subscription, recording.sink, {
				key: "finite",
				repeatable: false,
			});
			return recording;
		};
		const connects = () =>
			harness.test.statuses.filter((status) => status.state === "connected")
				.length;
		let max = 0;
		let unreadable = false;
		const sample = () => {
			const retained = retainedOf(harness.connection());
			max = Math.max(max, retained.retired);
			return retained;
		};
		samplers.push(
			setInterval(() => {
				try {
					sample();
				} catch {
					unreadable = true;
				}
			}, 5),
		);
		return {
			...harness,
			raw,
			member,
			finite,
			connects,
			sample,
			max: () => max,
			unreadable: () => unreadable,
		};
	}

	for (const recovery of [false, true]) {
		for (const retireBeforeTimeout of [false, true]) {
			const label = `${recovery ? "recovery on" : "recovery off"}, ${
				retireBeforeTimeout ? "explicit unsubscribe" : "timed-out join"
			}`;
			it(`applied joins with missing acknowledgements are cleaned while connected, without a reconnect (${label}; root repro)`, async () => {
				const tag = uniqueTag("siotmo");
				const target = `socket-io@${tag}`;
				// WebSocket only: an emit during the polling upgrade probe can
				// outlast the 100 ms budget and reject the retained room itself.
				const h = bounded(tag, recovery, {
					transports: ["websocket"],
					ackTimeoutMs: 100,
				});
				await waitFor(() => h.test.hasStatus("connected"));
				const retained = `${tag}keep`;
				const live = h.member(retained);
				await waitFor(() => live.recording.events.length >= 2);
				await setFault(target, "drop-ack");
				const retired = [0, 1, 2].map((n) => `${tag}retired${n}`);
				const attempts = retired.map((room) => h.member(room));
				if (retireBeforeTimeout) {
					for (const attempt of attempts) attempt.subscription.unsubscribe();
				}
				await waitFor(async () => {
					const joins = (await tagCounters(tag))?.joins ?? {};
					return retired.every((room) => joins[room] === 1);
				});
				if (!retireBeforeTimeout) {
					await waitFor(() =>
						attempts.every((attempt) => attempt.recording.errors.length === 1),
					);
				}
				// bounded 100 ms waits; the retained room rules out disposal.
				await sleep(400);
				await clearFault(target, "drop-ack");
				const mark = h.raw.recording.events.length;
				await sleep(150);
				const rooms = await serverRooms(tag);
				const counters = await tagCounters(tag);
				expect(counters.connections).toBe(1);
				expect(counters.active).toBe(1);
				expect(counters.recovered).toBe(0);
				expect(live.recording.errors).toEqual([]);
				expect(
					rooms,
					"last-consumer cleanup must not wait for an unrelated future reconnect",
				).toEqual([retained]);
				expect(roomsIn(h.raw.recording.events, mark)).toEqual([retained]);
				// One compensating leave per join that may have applied.
				expect(counters.leaves).toEqual(
					Object.fromEntries(retired.map((room) => [room, 1])),
				);
				if (!retireBeforeTimeout) {
					expect(
						attempts.flatMap((attempt) =>
							attempt.recording.errors.map((error) => error.code),
						),
					).toEqual(Array(3).fill("subscribe-rejected"));
				}
				// Client-side oracle: nothing is held once the leaves went out.
				expect(h.sample()).toEqual({ retired: 0, overflowed: false });
				expect(h.max()).toBeLessThanOrEqual(3);
				expect(h.unreadable()).toBe(false);
			});
		}
	}

	it("real-server churn: repeated timed-out joins on one healthy connection are compensated and hold nothing", async () => {
		const tag = uniqueTag("siochurn");
		const target = `socket-io@${tag}`;
		const h = bounded(tag, true, {
			transports: ["websocket"],
			ackTimeoutMs: 100,
		});
		const keep = `${tag}keep`;
		const live = h.member(keep);
		await waitFor(() => live.recording.events.length >= 2);
		await setFault(target, "drop-ack");
		const all: string[] = [];
		for (let cycle = 0; cycle < 8; cycle += 1) {
			const keys = Array.from({ length: 8 }, (_, n) => `${tag}c${cycle}n${n}`);
			all.push(...keys);
			for (const key of keys) h.member(key).subscription.unsubscribe();
			// The joins time out after 100 ms and are compensated; the fixture
			// acknowledges leaves.
			await waitFor(async () => {
				const leaves = (await tagCounters(tag)).leaves;
				return keys.every((key) => leaves[key] === 1);
			});
			expect(h.sample(), `cycle ${cycle}`).toEqual({
				retired: 0,
				overflowed: false,
			});
		}
		await clearFault(target, "drop-ack");
		const mark = h.raw.recording.events.length;
		await sleep(150);
		expect(await serverRooms(tag)).toEqual([keep]);
		expect(roomsIn(h.raw.recording.events, mark)).toEqual([keep]);
		const counters = await tagCounters(tag);
		expect(counters.connections).toBe(1);
		expect(counters.recovered).toBe(0);
		expect(Object.keys(counters.leaves).sort()).toEqual([...all].sort());
		expect(h.max()).toBeLessThanOrEqual(8);
		expect(uncertain(h.test)).toEqual([]);
		expect(live.recording.errors).toEqual([]);
		expect(h.unreadable()).toBe(false);
	});

	for (const recovery of [true, false]) {
		const mode = recovery ? "recovery on" : "recovery off";
		it(`more than 64 memberships retired while disconnected: ${
			recovery
				? "recovery is declined and the connection restarts on a fresh session"
				: "the flag and the tombstones are dropped"
		} (${mode})`, async () => {
			const tag = uniqueTag("sioovd");
			const target = `socket-io@${tag}`;
			const h = bounded(tag, recovery, {
				transports: ["websocket"],
				ackTimeoutMs: 2_500,
				reconnectionDelayMs: 500,
				reconnectionDelayMaxMs: 500,
			});
			await waitFor(() => h.test.hasStatus("connected"));
			const finite = h.finite();
			const keep = `${tag}keep`;
			const live = h.member(keep);
			const abandoned = Array.from({ length: 65 }, (_, n) => `${tag}gone${n}`);
			const handles = abandoned.map((room) => h.member(room));
			// All 66 joins acknowledged: each room has delivered.
			await waitFor(
				() =>
					live.recording.started === 1 &&
					handles.every((item) => item.recording.started === 1),
			);
			await setFault(target, "drop-ack");
			const pending = h.command({
				event: "echo",
				args: [{ operation: "one-off" }],
			});
			await waitFor(async () => (await tagCounters(tag)).commands.echo === 1);
			const reply = await control("close-transport", tag);
			expect(((await reply.json()) as { affected: number }).affected).toBe(1);
			await waitFor(() => h.test.lastStatus()?.state === "reconnecting");
			for (const item of handles) {
				item.subscription.unsubscribe();
				expect(h.sample().retired).toBeLessThanOrEqual(64);
			}
			expect(h.connects(), "still disconnected").toBe(1);
			expect(h.sample()).toEqual({ retired: 64, overflowed: true });
			expect(uncertain(h.test)).toEqual([
				{
					type: "membership-cleanup-uncertain",
					detail: { reason: "retired-overflow" },
				},
			]);
			await clearFault(target, "drop-ack");
			await waitFor(() => h.connects() === 2, { timeout: 8_000 });
			await waitFor(async () => (await serverRooms(tag)).join() === keep, {
				timeout: 8_000,
				message: "the abandoned rooms end with the outcome",
			});
			expect(await pending).toMatchObject({
				status: "unknown",
				error: { code: "command-unknown" },
			});
			const mark = h.raw.recording.events.length;
			const liveMark = live.recording.events.length;
			await sleep(250);
			expect(live.recording.events.length).toBeGreaterThan(liveMark);
			expect(live.recording.errors).toEqual([]);
			expect(roomsIn(h.raw.recording.events, mark)).toEqual([keep]);
			const counters = await tagCounters(tag);
			expect(counters.active).toBe(1);
			// The uncertain application command is never replayed.
			expect(counters.commands.echo).toBe(1);
			expect(counters.recovered).toBe(recovery ? 1 : 0);
			expect(counters.connections).toBe(recovery ? 3 : 2);
			// No leave was needed: the new session holds none of the old rooms.
			expect(counters.leaves).toEqual({});
			expect(counters.joins[keep]).toBe(2);
			expect(abandoned.every((room) => counters.joins[room] === 1)).toBe(true);
			// The loss at detection, then the outcome before the new connected;
			// never `recovered`.
			expect(h.raw.recording.continuity).toEqual([
				{ reason: "reconnected" },
				{ reason: "reconnected" },
			]);
			if (recovery) {
				expect(finite.errors).toEqual([
					{ code: "interrupted", message: RESTARTED },
				]);
			} else {
				expect(finite.errors).toEqual([]);
				expect(finite.continuity).toEqual([
					{ reason: "reconnected" },
					{ reason: "reconnected" },
				]);
			}
			expect(h.sample()).toEqual({ retired: 0, overflowed: false });
			expect(h.max()).toBeLessThanOrEqual(64);
			expect(h.unreadable()).toBe(false);
			h.connection()?.dispose();
			await waitFor(async () => (await tagCounters(tag)).active === 0);
			expect(await serverRooms(tag)).toEqual([]);
		});

		it(`more than 64 unacknowledged joins abandoned on a healthy connection restart it on a fresh session at once (${mode})`, async () => {
			const tag = uniqueTag("siovc");
			const target = `socket-io@${tag}`;
			const h = bounded(tag, recovery, {
				transports: ["websocket"],
				ackTimeoutMs: 2_500,
			});
			await waitFor(() => h.test.hasStatus("connected"));
			const finite = h.finite();
			const keep = `${tag}keep`;
			const live = h.member(keep);
			await waitFor(() => live.recording.events.length >= 2);
			await setFault(target, "drop-ack");
			const abandoned = Array.from({ length: 65 }, (_, n) => `${tag}gone${n}`);
			const handles = abandoned.map((room) => h.member(room));
			const pending = h.command({
				event: "echo",
				args: [{ operation: "one-off" }],
			});
			await waitFor(async () => {
				const counters = await tagCounters(tag);
				return (
					counters.commands.echo === 1 &&
					abandoned.every((room) => counters.joins[room] === 1)
				);
			});
			await clearFault(target, "drop-ack");
			// All 65 joins applied without acknowledgements: left at once.
			for (const item of handles) {
				item.subscription.unsubscribe();
				expect(h.sample().retired).toBeLessThanOrEqual(64);
			}
			expect(h.sample()).toEqual({ retired: 64, overflowed: true });
			// The fresh session starts once this task's synchronous work is
			// done; a key regained now is live on it with one server join.
			await Promise.resolve();
			const regainedRoom = abandoned[0] as string;
			const regained = h.member(regainedRoom);
			await waitFor(() => h.connects() === 2, { timeout: 8_000 });
			const expected = [regainedRoom, keep].sort();
			await waitFor(
				async () => (await serverRooms(tag)).join() === expected.join(),
				{ timeout: 8_000, message: "abandoned rooms cleaned by the outcome" },
			);
			expect(await pending).toMatchObject({
				status: "unknown",
				error: { code: "command-unknown" },
			});
			await waitFor(() => regained.recording.events.length >= 1);
			const mark = h.raw.recording.events.length;
			const liveMark = live.recording.events.length;
			await sleep(250);
			expect(live.recording.events.length).toBeGreaterThan(liveMark);
			expect(live.recording.errors).toEqual([]);
			expect(regained.recording.errors).toEqual([]);
			expect(roomsIn(h.raw.recording.events, mark)).toEqual(expected);
			const counters = await tagCounters(tag);
			expect(counters.connections).toBe(2);
			expect(counters.recovered).toBe(0);
			expect(counters.active).toBe(1);
			expect(counters.commands.echo).toBe(1);
			expect(counters.leaves).toEqual({});
			expect(counters.joins[keep]).toBe(2);
			// One join per session: exactly one on the fresh session.
			expect(counters.joins[regainedRoom]).toBe(2);
			expect(
				abandoned.slice(1).every((room) => counters.joins[room] === 1),
			).toBe(true);
			// A deliberate restart reports once, at the new connected.
			expect(h.raw.recording.continuity).toEqual([{ reason: "reconnected" }]);
			expect(finite.errors).toEqual([
				{ code: "interrupted", message: RESTARTED },
			]);
			expect(uncertain(h.test)).toEqual([
				{
					type: "membership-cleanup-uncertain",
					detail: { reason: "retired-overflow" },
				},
			]);
			expect(h.sample()).toEqual({ retired: 0, overflowed: false });
			expect(h.max()).toBeLessThanOrEqual(64);
			expect(h.unreadable()).toBe(false);
			h.connection()?.dispose();
			await waitFor(async () => (await tagCounters(tag)).active === 0);
			expect(await serverRooms(tag)).toEqual([]);
		});
	}
});

// Exercise explicit reconnects after leaving rooms, plus leave acknowledgements lost after the server applied them.
describe("socket.io client-initiated reconnects, error re-entry and leave timeouts", () => {
	const RETAINED = Symbol.for("spinetab.socket-io.retained");
	const byRoom = (args: readonly unknown[]) => [
		String((args[0] as { room: string }).room),
	];
	const retainedOf = (
		connection: AdapterConnection | undefined,
	): { retired: number; overflowed: boolean } => {
		const read = (connection as unknown as Record<symbol, unknown>)?.[RETAINED];
		if (typeof read !== "function") {
			throw new Error("the retained-references oracle is missing");
		}
		return read.call(connection);
	};
	const serverRooms = async (tag: string) =>
		(
			(await (
				await fetch(`${primaryOrigin()}/socket-io-control/rooms?tag=${tag}`)
			).json()) as { rooms: string[] }
		).rooms;
	const roomsIn = (events: unknown[][], from: number) =>
		[
			...new Set(
				events.slice(from).map((args) => (args[0] as { room: string }).room),
			),
		].sort();
	const uncertain = (test: ReturnType<typeof setup>["test"]) =>
		test.diagnostics.filter(
			(diagnostic) => diagnostic.type === "membership-cleanup-uncertain",
		);

	const restores: Array<() => void> = [];
	afterEach(() => {
		for (const restore of restores.splice(0)) restore();
	});

	function harness(
		tag: string,
		recovery: boolean,
		connection: Partial<SocketIoConnection>,
	) {
		const h = setup(tag, {
			connection: {
				...(recovery ? {} : { path: "/socket.io-nocsr" }),
				...connection,
			},
			adapter: { routes: { byRoom } },
		});
		// Unrouted: every `room` packet the server sends to this socket.
		const raw = h.subscribe({ event: "room" });
		const spec = (room: string): SocketIoSubscriptionSpec =>
			h.endpoint.subscription({
				event: "room",
				membership: room,
				route: "byRoom",
				join: { event: "join", args: [room] },
				leave: { event: "leave", args: [room] },
			}).subscription;
		const member = (room: string) =>
			h.subscribe({
				event: "room",
				membership: room,
				route: "byRoom",
				join: { event: "join", args: [room] },
				leave: { event: "leave", args: [room] },
			});
		const connects = () =>
			h.test.statuses.filter((status) => status.state === "connected").length;
		const retained = () => retainedOf(h.connection());
		return { ...h, raw, spec, member, connects, retained };
	}

	/** Every join and leave emit, with `connected` at the moment of emitting. */
	function recordMembershipEmits() {
		const emits: Array<{ event: string; connected: boolean }> = [];
		const proto = Socket.prototype as unknown as {
			emit: (this: { connected: boolean }, ...args: unknown[]) => unknown;
		};
		const original = proto.emit;
		proto.emit = function (this: { connected: boolean }, ...args: unknown[]) {
			if (args[0] === "join" || args[0] === "leave") {
				emits.push({ event: String(args[0]), connected: this.connected });
			}
			return original.apply(this, args);
		};
		restores.push(() => {
			proto.emit = original;
		});
		return emits;
	}

	for (const recovery of [true, false]) {
		const mode = recovery ? "recovery on" : "recovery off";
		for (const action of ["rotate", "retry"] as const) {
			const restart =
				action === "rotate"
					? "rotate()"
					: "retry() after `io server disconnect`";
			it(`${restart} after a recovered session restores no room left since: recovered=false, [keep] only, keep joined once on the fresh session, no command replay (${mode}; primary, empty tombstones)`, async () => {
				const tag = uniqueTag("sioxr");
				const target = `socket-io@${tag}`;
				const h = harness(tag, recovery, {
					transports: ["websocket"],
					ackTimeoutMs: 1_000,
				});
				await waitFor(() => h.test.hasStatus("connected"));
				const [left, keep] = [`${tag}old`, `${tag}keep`];
				const old = h.member(left);
				const live = h.member(keep);
				await waitFor(
					() =>
						old.recording.events.length >= 2 &&
						live.recording.events.length >= 2,
				);
				// An automatic reconnect after transport loss: recovery applies.
				await control("close-transport", tag);
				await waitFor(() => h.connects() === 2);
				expect((await tagCounters(tag)).recovered).toBe(recovery ? 1 : 0);
				const afterDrop = live.recording.events.length;
				await waitFor(() => live.recording.events.length > afterDrop);
				old.subscription.unsubscribe();
				await waitFor(async () => {
					const counters = await tagCounters(tag);
					return (
						counters.leaves[left] === 1 &&
						(await serverRooms(tag)).join() === keep
					);
				});
				// Before the restart: rooms [keep], nothing retired.
				expect(h.retained()).toEqual({ retired: 0, overflowed: false });
				await setFault(target, "drop-ack");
				const pending = h.command({
					event: "echo",
					args: [{ operation: "one-off" }],
				});
				await waitFor(async () => (await tagCounters(tag)).commands.echo === 1);
				await clearFault(target, "drop-ack");
				const continuityMark = h.raw.recording.continuity.length;
				h.test.setRevision(2);
				if (action === "rotate") {
					h.connection()?.rotate?.();
				} else {
					const reply = await control("disconnect", tag);
					expect(((await reply.json()) as { affected: number }).affected).toBe(
						1,
					);
					await waitFor(() => h.test.lastStatus()?.state === "failed");
					h.connection()?.retry?.();
				}
				await waitFor(() => h.connects() === 3);
				// The server counts a session when it connects it: a stale
				// snapshot restored here would read 2 (recovery on).
				expect((await tagCounters(tag)).recovered).toBe(recovery ? 1 : 0);
				// Keep is joined exactly once on the fresh session.
				await waitFor(
					async () =>
						(await tagCounters(tag)).joins[keep] === (recovery ? 2 : 3),
					{ message: "keep joined on the fresh session" },
				);
				expect(await pending).toMatchObject({
					status: "unknown",
					error: { code: "command-unknown" },
				});
				expect(h.test.requests.at(-1)).toBe(
					action === "rotate" ? "rotated" : "retry",
				);
				expect(await serverRooms(tag)).toEqual([keep]);
				const mark = h.raw.recording.events.length;
				const liveMark = live.recording.events.length;
				await sleep(250);
				expect(live.recording.events.length).toBeGreaterThan(liveMark);
				expect(live.recording.errors).toEqual([]);
				expect(roomsIn(h.raw.recording.events, mark)).toEqual([keep]);
				const counters = await tagCounters(tag);
				expect(counters.connections).toBe(3);
				expect(counters.active).toBe(1);
				// Declined: the third session is not recovered; old never returns.
				expect(counters.recovered).toBe(recovery ? 1 : 0);
				expect(counters.joins[left]).toBe(recovery ? 1 : 2);
				expect(counters.leaves).toEqual({ [left]: 1 });
				// The uncertain application command is never replayed.
				expect(counters.commands.echo).toBe(1);
				expect(h.raw.recording.continuity.slice(continuityMark)).toEqual([
					{ reason: "reconnected" },
				]);
				expect(h.retained()).toEqual({ retired: 0, overflowed: false });
				if (recovery) {
					// Automatic recovery after transport loss is kept afterwards.
					await control("close-transport", tag);
					await waitFor(() => h.connects() === 4);
					expect((await tagCounters(tag)).recovered).toBe(2);
					expect(h.raw.recording.continuity.at(-1)).toEqual({
						reason: "recovered",
					});
					expect(await serverRooms(tag)).toEqual([keep]);
				}
				h.connection()?.dispose();
				await waitFor(async () => (await tagCounters(tag)).active === 0);
				expect(await serverRooms(tag)).toEqual([]);
			});
		}
	}

	for (const action of ["rotate", "retry"] as const) {
		const restart =
			action === "rotate" ? "rotate()" : "retry() after `io server disconnect`";
		it(`${restart} with a held leave-timeout tombstone after a recovered session: recovery declined, the tombstone dropped without a command (recovery on; companion)`, async () => {
			const tag = uniqueTag("sioxt");
			const target = `socket-io@${tag}`;
			const h = harness(tag, true, {
				transports: ["websocket"],
				ackTimeoutMs: 200,
			});
			await waitFor(() => h.test.hasStatus("connected"));
			const [left, keep] = [`${tag}old`, `${tag}keep`];
			const old = h.member(left);
			const live = h.member(keep);
			await waitFor(
				() =>
					old.recording.events.length >= 2 && live.recording.events.length >= 2,
			);
			await control("close-transport", tag);
			await waitFor(() => h.connects() === 2);
			expect((await tagCounters(tag)).recovered).toBe(1);
			const afterDrop = live.recording.events.length;
			await waitFor(() => live.recording.events.length > afterDrop);
			await setFault(target, "drop-leave-ack");
			old.subscription.unsubscribe();
			await waitFor(() => uncertain(h.test).length === 1);
			expect(h.retained()).toEqual({ retired: 1, overflowed: false });
			await clearFault(target, "drop-leave-ack");
			if (action === "rotate") {
				h.connection()?.rotate?.();
			} else {
				await control("disconnect", tag);
				await waitFor(() => h.test.lastStatus()?.state === "failed");
				h.connection()?.retry?.();
			}
			await waitFor(() => h.connects() === 3);
			expect((await tagCounters(tag)).recovered).toBe(1);
			await waitFor(async () => (await tagCounters(tag)).joins[keep] === 2, {
				message: "keep joined on the fresh session",
			});
			const mark = h.raw.recording.events.length;
			await sleep(250);
			expect(roomsIn(h.raw.recording.events, mark)).toEqual([keep]);
			expect(await serverRooms(tag)).toEqual([keep]);
			const counters = await tagCounters(tag);
			expect(counters.recovered).toBe(1);
			// No recovery leave: the fresh session holds none of the old rooms.
			expect(counters.leaves).toEqual({ [left]: 1 });
			expect(h.retained()).toEqual({ retired: 0, overflowed: false });
			expect(live.recording.errors).toEqual([]);
			expect(h.raw.recording.continuity.at(-1)).toEqual({
				reason: "reconnected",
			});
		});
	}

	it("a key regained synchronously inside the join-timeout error stays joined on the server: no compensating leave, and the regained consumer receives data ((b))", async () => {
		const tag = uniqueTag("siosr");
		const target = `socket-io@${tag}`;
		const h = harness(tag, true, {
			transports: ["websocket"],
			ackTimeoutMs: 400,
		});
		await waitFor(() => h.test.hasStatus("connected"));
		const room = `${tag}r`;
		const connection = h.connection();
		if (!connection) throw new Error("no connection");
		await setFault(target, "drop-ack");
		const first = createRecordingSink<unknown[]>();
		const regained = createRecordingSink<unknown[]>();
		connection.subscribe(
			h.spec(room),
			{
				...first.sink,
				error: (error) => {
					first.sink.error(error);
					connection.subscribe(h.spec(room), regained.sink, {
						key: "again",
						repeatable: true,
					});
				},
			},
			{ key: "first", repeatable: true },
		);
		await waitFor(async () => (await tagCounters(tag))?.joins?.[room] === 1);
		await clearFault(target, "drop-ack");
		await waitFor(() => first.errors.length === 1, { timeout: 3_000 });
		await waitFor(() => regained.events.length >= 2, {
			message: "the regained consumer receives room traffic",
		});
		// Past any leave's own acknowledgement budget.
		await sleep(600);
		expect(await serverRooms(tag)).toEqual([room]);
		const counters = await tagCounters(tag);
		expect(counters.leaves).toEqual({});
		// The timed-out join (applied) and one join for the regained consumer.
		expect(counters.joins[room]).toBe(2);
		expect(first.errors.map((error) => error.code)).toEqual([
			"subscribe-rejected",
		]);
		expect(regained.errors).toEqual([]);
		expect(h.retained()).toEqual({ retired: 0, overflowed: false });
	});

	it("a connection disposed synchronously inside the join-timeout error emits no leave on the disposed socket and reports nothing after it ((b))", async () => {
		const emits = recordMembershipEmits();
		const tag = uniqueTag("siosd");
		const target = `socket-io@${tag}`;
		const h = harness(tag, true, {
			transports: ["websocket"],
			ackTimeoutMs: 300,
		});
		await waitFor(() => h.test.hasStatus("connected"));
		const room = `${tag}r`;
		const connection = h.connection();
		if (!connection) throw new Error("no connection");
		await setFault(target, "drop-ack");
		const first = createRecordingSink<unknown[]>();
		let atDispose = -1;
		connection.subscribe(
			h.spec(room),
			{
				...first.sink,
				error: (error) => {
					first.sink.error(error);
					atDispose = h.test.diagnostics.length;
					connection.dispose();
				},
			},
			{ key: "first", repeatable: true },
		);
		await waitFor(() => first.errors.length === 1, { timeout: 3_000 });
		await clearFault(target, "drop-ack");
		// Past a stray leave's own acknowledgement budget.
		await sleep(700);
		expect(emits).toEqual([{ event: "join", connected: true }]);
		expect(atDispose).toBeGreaterThanOrEqual(0);
		expect(h.test.diagnostics.slice(atDispose)).toEqual([]);
		await waitFor(async () => (await tagCounters(tag)).active === 0);
		expect(await serverRooms(tag)).toEqual([]);
	});

	for (const recovery of [true, false]) {
		const mode = recovery ? "recovery on" : "recovery off";
		it(`a leave that times out while connected leaves one \`joining\` tombstone, released at the next connect; a recovery leave's own timeout is not re-retired (${mode})`, async () => {
			const tag = uniqueTag("siolt");
			const target = `socket-io@${tag}`;
			const h = harness(tag, recovery, {
				transports: ["websocket"],
				ackTimeoutMs: 200,
			});
			await waitFor(() => h.test.hasStatus("connected"));
			const [left, keep] = [`${tag}gone`, `${tag}keep`];
			const gone = h.member(left);
			const live = h.member(keep);
			await waitFor(
				() =>
					gone.recording.events.length >= 2 &&
					live.recording.events.length >= 2,
			);
			await setFault(target, "drop-leave-ack");
			gone.subscription.unsubscribe();
			await waitFor(async () => (await tagCounters(tag)).leaves[left] === 1);
			await waitFor(() => uncertain(h.test).length === 1);
			expect(uncertain(h.test)).toEqual([
				{
					type: "membership-cleanup-uncertain",
					detail: { reason: "leave-timeout" },
				},
			]);
			expect(h.test.diagnostics).toContainEqual({
				type: "socket-io.leave-failed",
			});
			// One `joining` tombstone, held on the healthy connection until the
			// next connect (no timer, no second attempt while connected).
			expect(h.retained()).toEqual({ retired: 1, overflowed: false });
			await sleep(400);
			expect(h.retained()).toEqual({ retired: 1, overflowed: false });
			expect((await tagCounters(tag)).leaves[left]).toBe(1);
			expect(await serverRooms(tag)).toEqual([keep]);
			// The fault stays on: a recovery leave also times out.
			await control("close-transport", tag);
			await waitFor(() => h.connects() === 2);
			if (recovery) {
				// Recovered: the tombstone is left once, and that leave's own
				// connected timeout is reported but never re-retired.
				await waitFor(async () => (await tagCounters(tag)).leaves[left] === 2);
				await waitFor(() => uncertain(h.test).length === 2);
			} else {
				// Not recovered: the server holds no rooms; dropped, no command.
				await sleep(400);
			}
			expect(h.retained()).toEqual({ retired: 0, overflowed: false });
			await clearFault(target, "drop-leave-ack");
			await control("close-transport", tag);
			await waitFor(() => h.connects() === 3);
			await sleep(400);
			const counters = await tagCounters(tag);
			// The second session was restored once, so this loss starts a fresh
			// session and keep joins again.
			expect(counters.recovered).toBe(recovery ? 1 : 0);
			expect(counters.joins[keep]).toBe(recovery ? 2 : 3);
			expect(h.raw.recording.continuity.at(-1)).toEqual({
				reason: "reconnected",
			});
			expect(counters.connections).toBe(3);
			// Bounded per connect cycle: nothing more after the second connect.
			expect(counters.leaves).toEqual({ [left]: recovery ? 2 : 1 });
			expect(uncertain(h.test)).toHaveLength(recovery ? 2 : 1);
			expect(h.retained()).toEqual({ retired: 0, overflowed: false });
			const mark = h.raw.recording.events.length;
			await sleep(200);
			expect(roomsIn(h.raw.recording.events, mark)).toEqual([keep]);
			expect(await serverRooms(tag)).toEqual([keep]);
			expect(live.recording.errors).toEqual([]);
			expect(JSON.stringify(h.test.diagnostics)).not.toContain(left);
		});
	}

	// A session is restored at most once. socket.io-adapter 2.5.8 keeps
	// a restored session's snapshot and socket.io 4.8.4 restores it on the old
	// sid, so an automatic reconnect that presents the pid again after a loss
	// the client detected first (half-open: a network change, a client-side
	// heartbeat expiry) restores rooms left since and, once the old server
	// socket times out, strips the restored socket of every room and of the
	// namespace while the client still reads connected.
	describe("a session is restored at most once", () => {
		it("first-recovery control: a session never restored is recovered at its first transport loss, with its rooms and without a join (recovery on)", async () => {
			const tag = uniqueTag("sio1r");
			const h = harness(tag, true, {
				transports: ["websocket"],
				ackTimeoutMs: 1_000,
			});
			await waitFor(() => h.test.hasStatus("connected"));
			const [a, b] = [`${tag}a`, `${tag}b`];
			const first = h.member(a);
			const second = h.member(b);
			await waitFor(
				() =>
					first.recording.events.length >= 2 &&
					second.recording.events.length >= 2,
			);
			const continuityMark = h.raw.recording.continuity.length;
			await control("close-transport", tag);
			await waitFor(() => h.connects() === 2);
			const mark = h.raw.recording.events.length;
			const secondMark = second.recording.events.length;
			await sleep(250);
			const counters = await tagCounters(tag);
			expect(counters.recovered).toBe(1);
			expect(counters.connections).toBe(2);
			// Restored with the session: nothing is joined again.
			expect(counters.joins).toEqual({ [a]: 1, [b]: 1 });
			expect(counters.leaves).toEqual({});
			expect(await serverRooms(tag)).toEqual([a, b]);
			expect(roomsIn(h.raw.recording.events, mark)).toEqual([a, b]);
			expect(second.recording.events.length).toBeGreaterThan(secondMark);
			expect(h.raw.recording.continuity.slice(continuityMark)).toEqual([
				{ reason: "reconnected" },
				{ reason: "recovered" },
			]);
			expect(h.retained()).toEqual({ retired: 0, overflowed: false });
			h.connection()?.dispose();
			await waitFor(async () => (await tagCounters(tag)).active === 0);
			expect(await serverRooms(tag)).toEqual([]);
		});

		it("churn, then a server-detected drop after a restored session: a fresh session reports `reconnected`, joins each wanted room once and replays no command; its own first loss is recovered (recovery on)", async () => {
			const tag = uniqueTag("sioch");
			const target = `socket-io@${tag}`;
			const h = harness(tag, true, {
				transports: ["websocket"],
				ackTimeoutMs: 1_000,
			});
			await waitFor(() => h.test.hasStatus("connected"));
			const [left, keep, added] = [`${tag}old`, `${tag}keep`, `${tag}new`];
			const wanted = [keep, added].sort();
			const old = h.member(left);
			const live = h.member(keep);
			await waitFor(
				() =>
					old.recording.events.length >= 2 && live.recording.events.length >= 2,
			);
			await control("close-transport", tag);
			await waitFor(() => h.connects() === 2);
			expect((await tagCounters(tag)).recovered).toBe(1);
			// Churn in the restored session: one room left, one joined.
			old.subscription.unsubscribe();
			const joined = h.member(added);
			await waitFor(async () => {
				const counters = await tagCounters(tag);
				return (
					counters.leaves[left] === 1 &&
					counters.joins[added] === 1 &&
					(await serverRooms(tag)).join() === wanted.join()
				);
			});
			await waitFor(() => joined.recording.events.length >= 1);
			// An application command still unacknowledged at the drop.
			await setFault(target, "drop-ack");
			const pending = h.command({
				event: "echo",
				args: [{ operation: "one-off" }],
			});
			await waitFor(async () => (await tagCounters(tag)).commands.echo === 1);
			await clearFault(target, "drop-ack");
			const continuityMark = h.raw.recording.continuity.length;
			// The server detects this drop and saves a current snapshot, but the
			// session was restored once already.
			await control("close-transport", tag);
			await waitFor(() => h.connects() === 3);
			expect((await tagCounters(tag)).recovered).toBe(1);
			await waitFor(
				async () => {
					const counters = await tagCounters(tag);
					return counters.joins[keep] === 2 && counters.joins[added] === 2;
				},
				{ message: "the wanted rooms joined on the fresh session" },
			);
			expect(await pending).toMatchObject({
				status: "unknown",
				error: { code: "command-unknown" },
			});
			const mark = h.raw.recording.events.length;
			const liveMark = live.recording.events.length;
			const joinedMark = joined.recording.events.length;
			await sleep(250);
			expect(live.recording.events.length).toBeGreaterThan(liveMark);
			expect(joined.recording.events.length).toBeGreaterThan(joinedMark);
			expect(roomsIn(h.raw.recording.events, mark)).toEqual(wanted);
			expect(await serverRooms(tag)).toEqual(wanted);
			let counters = await tagCounters(tag);
			expect(counters.connections).toBe(3);
			expect(counters.recovered).toBe(1);
			expect(counters.joins).toEqual({ [left]: 1, [keep]: 2, [added]: 2 });
			expect(counters.leaves).toEqual({ [left]: 1 });
			// The uncertain application command is never replayed.
			expect(counters.commands.echo).toBe(1);
			expect(h.raw.recording.continuity.slice(continuityMark)).toEqual([
				{ reason: "reconnected" },
				{ reason: "reconnected" },
			]);
			expect(live.recording.errors).toEqual([]);
			expect(joined.recording.errors).toEqual([]);
			expect(h.retained()).toEqual({ retired: 0, overflowed: false });
			// The fresh session's own first loss is a first restore.
			await control("close-transport", tag);
			await waitFor(() => h.connects() === 4);
			counters = await tagCounters(tag);
			expect(counters.recovered).toBe(2);
			expect(counters.joins).toEqual({ [left]: 1, [keep]: 2, [added]: 2 });
			expect(h.raw.recording.continuity.at(-1)).toEqual({
				reason: "recovered",
			});
			expect(await serverRooms(tag)).toEqual(wanted);
			h.connection()?.dispose();
			await waitFor(async () => (await tagCounters(tag)).active === 0);
			expect(await serverRooms(tag)).toEqual([]);
		});

		/** Use an isolated server with short heartbeats; disable periodic traffic when explicit broadcasts must be the sequence oracle. */
		async function halfOpenServer({ ticker = true, pingTimeout = 300 } = {}) {
			const transport = createServer();
			const tcp = new Set<NetSocket>();
			transport.on("connection", (socket) => {
				tcp.add(socket);
				socket.on("close", () => tcp.delete(socket));
			});
			const server = new Server(transport, {
				pingInterval: 400,
				pingTimeout,
				connectionStateRecovery: { maxDisconnectionDuration: 90_000 },
			});
			const sockets: ServerSocket[] = [];
			const joins: Record<string, number> = {};
			const leaves: Record<string, number> = {};
			let recovered = 0;
			server.on("connection", (socket) => {
				sockets.push(socket);
				if (socket.recovered) recovered += 1;
				socket.on("join", (room: string, ack: (value: unknown) => void) => {
					joins[room] = (joins[room] ?? 0) + 1;
					void socket.join(room);
					ack({ ok: true });
				});
				socket.on("leave", (room: string, ack: (value: unknown) => void) => {
					leaves[room] = (leaves[room] ?? 0) + 1;
					void socket.leave(room);
					ack({ ok: true });
				});
			});
			await new Promise<void>((resolve) =>
				transport.listen(0, "127.0.0.1", resolve),
			);
			const address = transport.address();
			if (!address || typeof address === "string") {
				throw new Error("no loopback port");
			}
			const timer = ticker
				? setInterval(() => {
						for (const room of ["old", "keep"]) {
							server.to(room).emit("room", { room });
						}
						server.emit("room", { room: "*" });
					}, 30)
				: undefined;
			return {
				url: `http://127.0.0.1:${address.port}`,
				server,
				joins,
				leaves,
				recovered: () => recovered,
				current: () => {
					const socket = sockets.at(-1);
					if (!socket) throw new Error("no server socket");
					return socket;
				},
				roomsOf: (socket: ServerSocket) =>
					[...socket.rooms].filter((room) => room !== socket.id).sort(),
				async close() {
					clearInterval(timer);
					server.disconnectSockets(true);
					// A muted client close leaves the old TCP connection open.
					for (const socket of tcp) socket.destroy();
					await new Promise<void>((resolve) => server.close(() => resolve()));
				},
			};
		}

		/** The genuine upstream namespace sockets the adapter creates. */
		function tapPeers() {
			const peers: Socket[] = [];
			const proto = Manager.prototype as unknown as {
				socket: (this: Manager, ...args: unknown[]) => Socket;
			};
			const original = proto.socket;
			proto.socket = function (this: Manager, ...args: unknown[]) {
				const socket = original.apply(this, args);
				peers.push(socket);
				return socket;
			};
			restores.push(() => {
				proto.socket = original;
			});
			return peers;
		}

		for (const prior of [false, true]) {
			for (const churn of [true, false]) {
				const label = `${
					prior ? "after a restored session" : "never restored (control)"
				}, ${churn ? "a room left" : "memberships unchanged"}`;
				it(`a half-open loss the client detects first reconnects on a fresh session that still receives after the old server socket times out: ${label}`, async () => {
					const s = await halfOpenServer();
					const peers = tapPeers();
					const h = harness(uniqueTag("sioho"), true, {
						url: s.url,
						transports: ["websocket"],
						ackTimeoutMs: 1_000,
					});
					let restoreWire: (() => void) | undefined;
					try {
						await waitFor(() => h.test.hasStatus("connected"));
						const old = h.member("old");
						const keep = h.member("keep");
						await waitFor(
							() =>
								old.recording.events.length >= 2 &&
								keep.recording.events.length >= 2,
						);
						if (prior) {
							// A transport loss the server detects: the first restore.
							s.current().conn.close();
							await waitFor(() => h.connects() === 2);
							expect(s.recovered()).toBe(1);
							expect(h.raw.recording.continuity.at(-1)).toEqual({
								reason: "recovered",
							});
						}
						const wanted = churn ? ["keep"] : ["keep", "old"];
						if (churn) old.subscription.unsubscribe();
						await waitFor(
							() =>
								(!churn || s.leaves.old === 1) &&
								s.roomsOf(s.current()).join() === wanted.join(),
						);
						expect(h.retained()).toEqual({ retired: 0, overflowed: false });
						// Half-open: the client's writes and close are black-holed and
						// its heartbeat deadline lapses; the server has seen nothing.
						const peer = peers[0];
						if (!peer) throw new Error("no upstream socket");
						const engine = peer.io.engine as unknown as {
							_pingTimeoutTime: number;
							transport: {
								ws: {
									send: (...args: unknown[]) => unknown;
									close: (...args: unknown[]) => unknown;
									terminate?: () => void;
								};
							};
						};
						const wire = engine.transport.ws;
						const { send, close } = wire;
						wire.send = () => {};
						wire.close = () => {};
						restoreWire = () => {
							wire.send = send;
							wire.close = close;
							wire.terminate?.();
						};
						const oldServerSocket = s.current();
						const connectsBefore = h.connects();
						const continuityMark = h.raw.recording.continuity.length;
						engine._pingTimeoutTime = Date.now() - 1;
						h.connection()?.probe?.();
						await waitFor(() => h.connects() === connectsBefore + 1);
						expect(
							oldServerSocket.connected,
							"the server has not detected the old socket yet",
						).toBe(true);
						// Settles at once: a restore is visible at its connect, and a
						// fresh session's joins land within milliseconds, well before
						// the old server socket times out.
						await waitFor(
							() =>
								s.current().recovered ||
								(s.joins.keep === 2 && (churn || s.joins.old === 2)),
						);
						expect(
							s.roomsOf(s.current()),
							"no room left since is restored",
						).toEqual(wanted);
						// The old server socket reaches its own heartbeat timeout.
						await waitFor(() => !oldServerSocket.connected, {
							timeout: 5_000,
							message: "the old server socket times out",
						});
						await sleep(100);
						const current = s.current();
						const mark = h.raw.recording.events.length;
						const keepMark = keep.recording.events.length;
						await sleep(400);
						expect(h.test.lastStatus()?.state).toBe("connected");
						expect(
							keep.recording.events.length,
							"the retained consumer still receives",
						).toBeGreaterThan(keepMark);
						expect(
							roomsIn(h.raw.recording.events, mark),
							"room and namespace traffic",
						).toEqual(["*", ...wanted]);
						expect(s.roomsOf(current)).toEqual(wanted);
						expect(s.server.of("/").sockets.get(current.id)).toBe(current);
						// A fresh session, never a second restore of the old sid.
						expect(current.recovered).toBe(false);
						expect(current.id).not.toBe(oldServerSocket.id);
						expect(s.recovered()).toBe(prior ? 1 : 0);
						expect(h.raw.recording.continuity.slice(continuityMark)).toEqual([
							{ reason: "reconnected" },
							{ reason: "reconnected" },
						]);
						// The wanted rooms joined once on it; a room left never returns.
						expect(s.joins).toEqual(
							churn ? { old: 1, keep: 2 } : { old: 2, keep: 2 },
						);
						expect(s.leaves).toEqual(churn ? { old: 1 } : {});
						expect(keep.recording.errors).toEqual([]);
						expect(h.retained()).toEqual({ retired: 0, overflowed: false });
						// Dispose leaves no room on the server.
						h.connection()?.dispose();
						await waitFor(() => s.server.of("/").sockets.size === 0);
						const rooms = [...s.server.of("/").adapter.rooms.keys()];
						expect(
							rooms.filter((room) => room === "old" || room === "keep"),
						).toEqual([]);
					} finally {
						h.connection()?.dispose();
						restoreWire?.();
						await s.close();
					}
				});
			}
		}

		// A fresh session must not inherit an earlier session's replay offset.
		describe("a declined session leaves no offset behind (offset addendum)", () => {
			async function offsetRig() {
				const s = await halfOpenServer({ ticker: false });
				const peers = tapPeers();
				const h = harness(uniqueTag("siooff"), true, {
					url: s.url,
					transports: ["websocket"],
					ackTimeoutMs: 1_000,
				});
				await waitFor(() => h.test.hasStatus("connected"));
				const keep = h.member("keep");
				const seqs = () =>
					keep.recording.events.map((args) => (args[0] as { seq: number }).seq);
				const joined = () => s.current().rooms.has("keep");
				const emit = (seq: number) =>
					s.server.to("keep").emit("room", { room: "keep", seq });
				const peer = () => {
					const socket = peers[0];
					if (!socket) throw new Error("no upstream socket");
					return socket;
				};
				return { s, h, keep, seqs, joined, emit, peer };
			}

			for (const clearOffsetControl of [false, true]) {
				it(`a fresh session lost before any event presents no earlier session's offset: nothing delivered is replayed and the loss is \`reconnected\` (clearOffsetControl=${clearOffsetControl}; offset addendum)`, async () => {
					const { s, h, keep, seqs, joined, emit, peer } = await offsetRig();
					try {
						await waitFor(() => h.connects() === 1 && joined());
						emit(1);
						await waitFor(() => seqs().length === 1);
						// A never-restored session's first loss: the first safe recovery.
						s.current().conn.close();
						await waitFor(() => h.connects() === 2 && joined());
						expect(
							peer().recovered,
							"the first safe recovery is preserved",
						).toBe(true);
						expect(s.joins.keep, "the first recovery needs no join").toBe(1);
						if (clearOffsetControl) {
							(peer() as unknown as { _lastOffset?: string })._lastOffset =
								undefined;
						}
						emit(2);
						emit(3);
						await waitFor(() => seqs().length === 3);
						expect(seqs()).toEqual([1, 2, 3]);
						// The restored session is declined: a fresh session.
						s.current().conn.close();
						await waitFor(() => h.connects() === 3 && joined());
						expect(
							peer().recovered,
							"the second loss creates a fresh session",
						).toBe(false);
						expect(s.joins.keep).toBe(2);
						expect(seqs()).toEqual([1, 2, 3]);
						// No event reaches the fresh session before its first loss.
						const continuityMark = keep.recording.continuity.length;
						s.current().conn.close();
						await waitFor(() => h.connects() === 4 && joined());
						await sleep(150);
						expect(
							seqs(),
							"previously delivered events cannot replay on the fresh session",
						).toEqual([1, 2, 3]);
						expect(keep.recording.errors).toEqual([]);
						// No event initialised this session's offset: its loss is a
						// fresh session, honestly reported, with one join.
						expect(peer().recovered).toBe(false);
						expect(s.current().recovered).toBe(false);
						expect(s.recovered()).toBe(1);
						expect(s.joins.keep).toBe(3);
						expect(keep.recording.continuity.slice(continuityMark)).toEqual([
							{ reason: "reconnected" },
							{ reason: "reconnected" },
						]);
						emit(4);
						await waitFor(() => seqs().length === 4);
						expect(seqs()).toEqual([1, 2, 3, 4]);
						expect(h.retained()).toEqual({ retired: 0, overflowed: false });
						// Dispose leaves no room on the server.
						h.connection()?.dispose();
						await waitFor(() => s.server.of("/").sockets.size === 0);
						expect(s.server.of("/").adapter.rooms.has("keep")).toBe(false);
					} finally {
						h.connection()?.dispose();
						await s.close();
					}
				});
			}

			it("first-safe-recovery control: a fresh session that received an event is recovered at its own first loss, replays the missed event once and duplicates nothing (offset addendum)", async () => {
				const { s, h, keep, seqs, joined, emit, peer } = await offsetRig();
				try {
					await waitFor(() => h.connects() === 1 && joined());
					emit(1);
					await waitFor(() => seqs().length === 1);
					// A never-restored session's first loss: the first safe recovery.
					s.current().conn.close();
					await waitFor(() => h.connects() === 2 && joined());
					expect(peer().recovered, "first safe recovery").toBe(true);
					expect(s.joins.keep).toBe(1);
					emit(2);
					await waitFor(() => seqs().length === 2);
					// The restored session's next loss: a fresh session.
					s.current().conn.close();
					await waitFor(() => h.connects() === 3 && joined());
					expect(
						peer().recovered,
						"a restored session is not presented again",
					).toBe(false);
					expect(s.joins.keep).toBe(2);
					// An event initialises the fresh session's own offset.
					emit(3);
					await waitFor(() => seqs().length === 3);
					// Its first loss, with one event missed while it is down.
					const continuityMark = keep.recording.continuity.length;
					s.current().conn.close();
					await sleep(5);
					emit(4);
					await waitFor(() => h.connects() === 4 && seqs().length >= 4);
					await sleep(150);
					expect(
						peer().recovered,
						"the fresh session's first loss recovers",
					).toBe(true);
					expect(s.recovered()).toBe(2);
					expect(s.joins.keep, "a recovered session needs no join").toBe(2);
					expect(seqs(), "missed once, nothing duplicated").toEqual([
						1, 2, 3, 4,
					]);
					expect(keep.recording.continuity.slice(continuityMark)).toEqual([
						{ reason: "reconnected" },
						{ reason: "recovered" },
					]);
					expect(keep.recording.errors).toEqual([]);
					emit(5);
					await waitFor(() => seqs().length === 5);
					expect(seqs()).toEqual([1, 2, 3, 4, 5]);
					expect(h.retained()).toEqual({ retired: 0, overflowed: false });
					h.connection()?.dispose();
					await waitFor(() => s.server.of("/").sockets.size === 0);
					expect(s.server.of("/").adapter.rooms.has("keep")).toBe(false);
				} finally {
					h.connection()?.dispose();
					await s.close();
				}
			});
		});

		// Clear the offset when the server refuses recovery so a later reconnect cannot replay an already-reported gap.
		describe("a refused restore leaves no earlier cursor behind", () => {
			/** The verifier's probe shape through this file's harness. */
			async function refusedRig() {
				const s = await halfOpenServer({ ticker: false });
				const peers = tapPeers();
				const h = harness(uniqueTag("siorf"), true, {
					url: s.url,
					transports: ["websocket"],
					ackTimeoutMs: 1_000,
				});
				const keep = h.member("keep");
				const seqs = () =>
					keep.recording.events.map((args) => (args[0] as { seq: number }).seq);
				const joined = () => s.current().rooms.has("keep");
				const emit = (seq: number) =>
					s.server.to("keep").emit("room", { room: "keep", seq });
				const peer = () => {
					const socket = peers[0];
					if (!socket) throw new Error("no upstream socket");
					return socket;
				};
				/** upstream's private recovery session id. */
				const pidOf = () => (peer() as unknown as { _pid?: string })._pid;
				let restoreWire: (() => void) | undefined;
				/**
				 * Session A receives seq 1 and is lost half-open, detected by the
				 * client first; seqs 2 and 3 are broadcast while A is dead; the
				 * server refuses the restore, so session B is fresh.
				 */
				async function refuseRestore() {
					await waitFor(() => h.connects() === 1 && joined());
					emit(1);
					await waitFor(() => seqs().length === 1);
					const pidA = pidOf();
					const engine = peer().io.engine as unknown as {
						_pingTimeoutTime: number;
						transport: {
							ws: {
								send: (...args: unknown[]) => unknown;
								close: (...args: unknown[]) => unknown;
								terminate?: () => void;
							};
						};
					};
					const wire = engine.transport.ws;
					const { send, close } = wire;
					wire.send = () => {};
					wire.close = () => {};
					restoreWire = () => {
						wire.send = send;
						wire.close = close;
						wire.terminate?.();
					};
					const sessionA = s.current();
					engine._pingTimeoutTime = Date.now() - 1;
					h.connection()?.probe?.();
					// Gap events: the dead session A is still in `keep` on the server.
					emit(2);
					emit(3);
					await waitFor(() => h.connects() === 2 && joined());
					expect(
						sessionA.connected,
						"the server has not detected session A yet",
					).toBe(true);
					expect(peer().recovered, "the server refused the restore").toBe(
						false,
					);
					expect(pidOf(), "session B has its own pid").not.toBe(pidA);
					expect(s.joins.keep, "session B joins once").toBe(2);
					expect(seqs()).toEqual([1]);
				}
				return {
					s,
					h,
					keep,
					seqs,
					joined,
					emit,
					peer,
					refuseRestore,
					async close() {
						h.connection()?.dispose();
						restoreWire?.();
						await s.close();
					},
				};
			}

			it("a quiet fresh session after a refused restore presents no earlier cursor: its server-detected loss is a fresh session, `reconnected`, and nothing reported lost is replayed (VG5-P1 port)", async () => {
				const r = await refusedRig();
				try {
					await r.refuseRestore();
					// The loss was reported: the application reconciles here.
					const continuityMark = r.keep.recording.continuity.length;
					// Session B receives no event, then a loss the server detects.
					r.s.current().conn.close();
					await waitFor(() => r.h.connects() === 3 && r.joined());
					await sleep(150);
					expect(
						r.seqs(),
						"gap events reported `reconnected` are not replayed",
					).toEqual([1]);
					expect(r.keep.recording.errors).toEqual([]);
					expect(
						r.peer().recovered,
						"a session with no event cannot recover",
					).toBe(false);
					expect(r.s.current().recovered).toBe(false);
					expect(r.s.recovered()).toBe(0);
					expect(r.s.joins.keep, "one join per fresh session").toBe(3);
					expect(r.keep.recording.continuity.slice(continuityMark)).toEqual([
						{ reason: "reconnected" },
						{ reason: "reconnected" },
					]);
					r.emit(4);
					await waitFor(() => r.seqs().length === 2);
					expect(r.seqs()).toEqual([1, 4]);
					expect(r.h.retained()).toEqual({ retired: 0, overflowed: false });
					// Dispose leaves no room once session A's server socket expires.
					r.h.connection()?.dispose();
					await waitFor(() => r.s.server.of("/").sockets.size === 0);
					expect(r.s.server.of("/").adapter.rooms.has("keep")).toBe(false);
				} finally {
					await r.close();
				}
			});

			it("first-safe control: a fresh session after a refused restore that received an event keeps recovery for its own first loss (its confirmed CONNECT is not spent): `recovered`, no join, the missed event once", async () => {
				const r = await refusedRig();
				try {
					await r.refuseRestore();
					// An event initialises session B's own cursor.
					r.emit(4);
					await waitFor(() => r.seqs().length === 2);
					const continuityMark = r.keep.recording.continuity.length;
					// B's first loss, with one event missed while it is down.
					r.s.current().conn.close();
					await sleep(5);
					r.emit(5);
					await waitFor(() => r.h.connects() === 3 && r.seqs().length >= 3);
					await sleep(150);
					expect(r.peer().recovered, "session B's first loss recovers").toBe(
						true,
					);
					expect(r.s.recovered()).toBe(1);
					expect(r.s.joins.keep, "a recovered session needs no join").toBe(2);
					expect(r.seqs(), "missed once, nothing duplicated").toEqual([
						1, 4, 5,
					]);
					expect(r.keep.recording.continuity.slice(continuityMark)).toEqual([
						{ reason: "reconnected" },
						{ reason: "recovered" },
					]);
					expect(r.keep.recording.errors).toEqual([]);
					r.emit(6);
					await waitFor(() => r.seqs().length === 4);
					expect(r.seqs()).toEqual([1, 4, 5, 6]);
					expect(r.h.retained()).toEqual({ retired: 0, overflowed: false });
					r.h.connection()?.dispose();
					await waitFor(() => r.s.server.of("/").sockets.size === 0);
					expect(r.s.server.of("/").adapter.rooms.has("keep")).toBe(false);
				} finally {
					await r.close();
				}
			});
		});

		// An unconfirmed recovery attempt spends its recovery ID; the next reconnect must start fresh.
		describe("a recovery handshake whose confirmation is lost is spent", () => {
			async function unconfirmedRig() {
				const s = await halfOpenServer({ ticker: false, pingTimeout: 800 });
				// Never acknowledged: an application command uncertain at the drop.
				let echoes = 0;
				s.server.on("connection", (socket) => {
					socket.on("echo", () => {
						echoes += 1;
					});
				});
				// Drop downstream traffic after Engine.IO OPEN so the namespace CONNECT reply is lost.
				let armed = false;
				let droppedConnects = 0;
				const downstream: Array<() => void> = [];
				s.server.engine.on("connection", (engine: ServerSocket["conn"]) => {
					if (!armed) return;
					armed = false;
					const wire = engine as unknown as {
						sendPacket: (...args: unknown[]) => unknown;
					};
					const { sendPacket } = wire;
					wire.sendPacket = (...args: unknown[]) => {
						if (
							args[0] === "message" &&
							typeof args[1] === "string" &&
							args[1].startsWith("0{")
						) {
							droppedConnects += 1;
						}
						return engine;
					};
					downstream.push(() => {
						wire.sendPacket = sendPacket;
					});
				});
				const peers = tapPeers();
				const h = harness(uniqueTag("siouc"), true, {
					url: s.url,
					transports: ["websocket"],
					ackTimeoutMs: 1_000,
				});
				const keep = h.member("keep");
				const seqs = () =>
					keep.recording.events.map((args) => (args[0] as { seq: number }).seq);
				const joined = () => s.current().rooms.has("keep");
				const emit = (seq: number) =>
					s.server.to("keep").emit("room", { room: "keep", seq });
				const peer = () => {
					const socket = peers[0];
					if (!socket) throw new Error("no upstream socket");
					return socket;
				};
				let restoreUpstream: (() => void) | undefined;
				return {
					s,
					h,
					keep,
					seqs,
					joined,
					emit,
					peer,
					arm() {
						armed = true;
					},
					dropped: () => droppedConnects,
					echoes: () => echoes,
					/** The client's engine closes; the server does not learn of it. */
					closeEngineQuietly() {
						const engine = peer().io.engine as unknown as {
							close: () => void;
							transport: {
								ws: {
									send: (...args: unknown[]) => unknown;
									close: (...args: unknown[]) => unknown;
									terminate?: () => void;
								};
							};
						};
						const wire = engine.transport.ws;
						const { send, close } = wire;
						wire.send = () => {};
						wire.close = () => {};
						restoreUpstream = () => {
							wire.send = send;
							wire.close = close;
							wire.terminate?.();
						};
						engine.close();
					},
					async close() {
						h.connection()?.dispose();
						restoreUpstream?.();
						for (const restore of downstream.splice(0)) restore();
						await s.close();
					},
				};
			}

			it("a recovery CONNECT whose confirmation is lost is spent: the next reconnect is a fresh session that keeps its room and data after the unconfirmed restored socket expires; `reconnected`, one join, no command replay (root's shape)", async () => {
				const r = await unconfirmedRig();
				try {
					await waitFor(() => r.h.connects() === 1 && r.joined());
					r.emit(1);
					await waitFor(() => r.seqs().length === 1);
					const pending = r.h.command({
						event: "echo",
						args: [{ operation: "one-off" }],
					});
					await waitFor(() => r.echoes() === 1);
					const continuityMark = r.keep.recording.continuity.length;
					const first = r.s.current();
					r.arm();
					// An ordinary disconnect the server detects: it saves the session.
					first.conn.close();
					await waitFor(() => r.dropped() === 1 && r.s.current() !== first);
					const unconfirmed = r.s.current();
					expect(unconfirmed.recovered, "the server restored the session").toBe(
						true,
					);
					expect(unconfirmed.id).toBe(first.id);
					expect(unconfirmed.connected).toBe(true);
					expect(
						r.peer().connected,
						"the namespace CONNECT reply never reached the client",
					).toBe(false);
					expect(r.h.connects()).toBe(1);
					expect(r.s.joins.keep).toBe(1);
					expect(await pending).toMatchObject({
						status: "unknown",
						error: { code: "command-unknown" },
					});
					r.closeEngineQuietly();
					await waitFor(
						() => r.h.connects() === 2 && r.s.current() !== unconfirmed,
					);
					expect(
						unconfirmed.connected,
						"the unconfirmed restored socket is alive at the reconnect",
					).toBe(true);
					const current = r.s.current();
					// The unconfirmed restored socket reaches its own heartbeat timeout.
					await waitFor(() => !unconfirmed.connected, {
						timeout: 5_000,
						message: "the unconfirmed restored socket times out",
					});
					await sleep(100);
					expect(
						r.s.roomsOf(current),
						"live membership survives the expiry of the unconfirmed restored socket",
					).toEqual(["keep"]);
					r.emit(2);
					await waitFor(() => r.seqs().length === 2, {
						message: "the reported session receives fresh room data",
					});
					expect(r.seqs()).toEqual([1, 2]);
					// A fresh session: a new socket id, one join, the loss honest.
					expect(current.recovered).toBe(false);
					expect(current.id).not.toBe(unconfirmed.id);
					expect(r.peer().recovered).toBe(false);
					expect(r.s.recovered(), "only the unconfirmed restore").toBe(1);
					expect(r.s.joins).toEqual({ keep: 2 });
					expect(r.s.leaves).toEqual({});
					expect(r.keep.recording.continuity.slice(continuityMark)).toEqual([
						{ reason: "reconnected" },
						{ reason: "reconnected" },
					]);
					expect(r.keep.recording.errors).toEqual([]);
					expect(r.echoes(), "the uncertain command is never replayed").toBe(1);
					expect(r.h.test.lastStatus()?.state).toBe("connected");
					expect(r.h.retained()).toEqual({ retired: 0, overflowed: false });
					// Dispose leaves no room on the server.
					r.h.connection()?.dispose();
					await waitFor(() => r.s.server.of("/").sockets.size === 0);
					expect(r.s.server.of("/").adapter.rooms.has("keep")).toBe(false);
				} finally {
					await r.close();
				}
			});

			it("first-safe control: a recovery CONNECT that is confirmed is not spent: `recovered`, the room restored without a join, the missed event once", async () => {
				const r = await unconfirmedRig();
				try {
					await waitFor(() => r.h.connects() === 1 && r.joined());
					r.emit(1);
					await waitFor(() => r.seqs().length === 1);
					const continuityMark = r.keep.recording.continuity.length;
					const first = r.s.current();
					first.conn.close();
					await sleep(5);
					r.emit(2);
					await waitFor(() => r.h.connects() === 2 && r.seqs().length >= 2);
					await sleep(150);
					const current = r.s.current();
					expect(r.peer().recovered, "first safe recovery").toBe(true);
					expect(current.recovered).toBe(true);
					expect(current.id).toBe(first.id);
					expect(r.s.recovered()).toBe(1);
					expect(r.s.joins, "a restored session needs no join").toEqual({
						keep: 1,
					});
					expect(r.s.roomsOf(current)).toEqual(["keep"]);
					expect(r.seqs(), "missed once, nothing duplicated").toEqual([1, 2]);
					expect(r.keep.recording.continuity.slice(continuityMark)).toEqual([
						{ reason: "reconnected" },
						{ reason: "recovered" },
					]);
					expect(r.keep.recording.errors).toEqual([]);
					r.emit(3);
					await waitFor(() => r.seqs().length === 3);
					expect(r.seqs()).toEqual([1, 2, 3]);
					expect(r.h.retained()).toEqual({ retired: 0, overflowed: false });
					r.h.connection()?.dispose();
					await waitFor(() => r.s.server.of("/").sockets.size === 0);
					expect(r.s.server.of("/").adapter.rooms.has("keep")).toBe(false);
				} finally {
					await r.close();
				}
			});
		});

		// The same class (every client-initiated connect starts a
		// fresh session). Namespace sockets of one identity share a Manager;
		// upstream `Manager.socket(nsp)` caches the namespace socket and
		// `disconnect()` never clears `_pid` or `_lastOffset`. Handle A (`/a`)
		// is disposed during a loss the server detected while handle B (`/b`)
		// keeps the Manager alive; a new handle A2 for `/a` gets the same
		// upstream socket and must not restore A's session and rooms.
		describe("a replacement handle presents no earlier handle's session (class)", () => {
			it("a new handle for a released namespace gets its own socket and a fresh session: the disposed handle's rooms are not restored and nothing reaches a room no consumer wants", async () => {
				const transport = createServer();
				const tcp = new Set<NetSocket>();
				transport.on("connection", (socket) => {
					tcp.add(socket);
					socket.on("close", () => tcp.delete(socket));
				});
				const server = new Server(transport, {
					pingInterval: 400,
					pingTimeout: 300,
					connectionStateRecovery: { maxDisconnectionDuration: 90_000 },
				});
				const sockets: Record<string, ServerSocket[]> = { "/a": [], "/b": [] };
				const joins: Record<string, number> = {};
				for (const name of ["/a", "/b"]) {
					server.of(name).on("connection", (socket) => {
						sockets[name]?.push(socket);
						socket.on("join", (room: string, ack: (value: unknown) => void) => {
							joins[`${name}:${room}`] = (joins[`${name}:${room}`] ?? 0) + 1;
							void socket.join(room);
							ack({ ok: true });
						});
						socket.on(
							"leave",
							(room: string, ack: (value: unknown) => void) => {
								void socket.leave(room);
								ack({ ok: true });
							},
						);
					});
				}
				await new Promise<void>((resolve) =>
					transport.listen(0, "127.0.0.1", resolve),
				);
				const address = transport.address();
				if (!address || typeof address === "string") {
					throw new Error("no loopback port");
				}
				const peers = tapPeers();
				/** upstream's namespace name (private in its typings). */
				const nspOf = (peer: Socket) =>
					(peer as unknown as { nsp: string }).nsp;
				/** upstream's recovery pid and cursor (private in its typings). */
				const recoveryOf = (peer: Socket) =>
					peer as unknown as { _pid?: string; _lastOffset?: string };
				const base = {
					url: `http://127.0.0.1:${address.port}`,
					sharing: "shared" as const,
					anonymous: true,
					transports: ["websocket" as const],
					reconnectionDelayMs: 300,
					reconnectionDelayMaxMs: 600,
					ackTimeoutMs: 1_000,
				};
				const adapter = socketIoAdapter({ routes: { byRoom } });
				const member = (room: string): SocketIoSubscriptionSpec => ({
					event: "room",
					membership: room,
					route: "byRoom",
					join: { event: "join", args: [room] },
					leave: { event: "leave", args: [room] },
				});
				const contextA = createTestContext({ credentials: () => ({}) });
				const contextB = createTestContext({ credentials: () => ({}) });
				const contextA2 = createTestContext({ credentials: () => ({}) });
				const handleA = adapter.connect(
					{ ...base, namespace: "/a" },
					contextA.ctx,
				);
				const handleB = adapter.connect(
					{ ...base, namespace: "/b" },
					contextB.ctx,
				);
				let handleA2: AdapterConnection | undefined;
				const roomsOf = (socket: ServerSocket | undefined) =>
					socket
						? [...socket.rooms].filter((room) => room !== socket.id).sort()
						: [];
				const connected = (context: typeof contextA) =>
					context.statuses.filter((status) => status.state === "connected")
						.length;
				try {
					const old = createRecordingSink<unknown[]>();
					handleA.subscribe(member("old"), old.sink, {
						key: "old",
						repeatable: true,
					});
					const keep = createRecordingSink<unknown[]>();
					handleB.subscribe(member("keep"), keep.sink, {
						key: "keep",
						repeatable: true,
					});
					await waitFor(
						() =>
							roomsOf(sockets["/a"]?.at(-1)).includes("old") &&
							roomsOf(sockets["/b"]?.at(-1)).includes("keep"),
					);
					expect(
						sockets["/a"]?.at(-1)?.conn,
						"/a and /b share one physical Engine",
					).toBe(sockets["/b"]?.at(-1)?.conn);
					// An event gives A's upstream socket a recovery cursor.
					server.of("/a").to("old").emit("room", { room: "old", seq: 1 });
					await waitFor(() => old.events.length === 1);
					const upstreamA = peers.find((peer) => nspOf(peer) === "/a");
					if (!upstreamA) throw new Error("no upstream /a socket");
					const pidA = recoveryOf(upstreamA)._pid;
					expect(pidA, "the first session holds a recovery pid").toEqual(
						expect.any(String),
					);
					// A loss the server detects (both namespaces share the engine),
					// and the last consumer of `/a` leaves during the outage.
					sockets["/a"]?.at(-1)?.conn.close();
					await waitFor(() => contextA.lastStatus()?.state === "reconnecting");
					handleA.dispose();
					await waitFor(() => connected(contextB) === 2);
					// A fresh session rejoins `keep` just after its `connected`: the
					// event below needs the rejoin, not just the status.
					await waitFor(() => roomsOf(sockets["/b"]?.at(-1)).includes("keep"));
					// The kept socket holds nothing of the disposed handle's session.
					expect(recoveryOf(upstreamA)._pid, "no disposed pid").toBeUndefined();
					expect(
						recoveryOf(upstreamA)._lastOffset,
						"no disposed offset",
					).toBeUndefined();
					// The sibling receives on the shared connection before the
					// replacement...
					server.of("/b").to("keep").emit("room", { room: "keep", seq: 10 });
					await waitFor(() => keep.events.length === 1);
					// A new consumer of `/a` within the recovery window.
					handleA2 = adapter.connect(
						{ ...base, namespace: "/a" },
						contextA2.ctx,
					);
					const fresh = createRecordingSink<unknown[]>();
					handleA2.subscribe(member("new"), fresh.sink, {
						key: "new",
						repeatable: true,
					});
					await waitFor(() => roomsOf(sockets["/a"]?.at(-1)).includes("new"));
					await sleep(150);
					const a2 = sockets["/a"]?.at(-1);
					const upstreamA2 = peers
						.filter((peer) => nspOf(peer) === "/a")
						.at(-1) as Socket;
					expect(upstreamA2, "the replacement gets its own socket").not.toBe(
						upstreamA,
					);
					expect(
						(upstreamA.io as unknown as { nsps: Record<string, Socket> }).nsps[
							"/a"
						],
						"the disposed one is not cached",
					).toBe(upstreamA2);
					expect(upstreamA.active, "the disposed one is inert").toBe(false);
					expect(
						recoveryOf(upstreamA)._pid,
						"and keeps no pid",
					).toBeUndefined();
					expect(
						a2?.conn,
						"the replacement shares the sibling's physical Engine",
					).toBe(sockets["/b"]?.at(-1)?.conn);
					const pidA2 = recoveryOf(upstreamA2)._pid;
					expect(pidA2, "the replacement's own session pid").toEqual(
						expect.any(String),
					);
					expect(pidA2, "not the disposed handle's session").not.toBe(pidA);
					expect(
						roomsOf(a2),
						"no room of the disposed handle is restored",
					).toEqual(["new"]);
					expect(a2?.recovered, "a fresh session").toBe(false);
					expect(server.of("/a").adapter.rooms.has("old")).toBe(false);
					expect(joins).toMatchObject({ "/a:old": 1, "/a:new": 1 });
					// The fresh handle receives its own room; nothing else reaches it.
					server.of("/a").to("old").emit("room", { room: "old", seq: 2 });
					server.of("/a").to("new").emit("room", { room: "new", seq: 3 });
					await waitFor(() => fresh.events.length === 1);
					await sleep(100);
					// Under recovery the server appends its offset to each event.
					expect(fresh.events.map((args) => args[0])).toEqual([
						{ room: "new", seq: 3 },
					]);
					expect(fresh.errors).toEqual([]);
					expect(contextA2.lastStatus()?.state).toBe("connected");
					// The other namespace is unaffected.
					expect(roomsOf(sockets["/b"]?.at(-1))).toEqual(["keep"]);
					//...and after it, on the same session: its traffic is
					// uninterrupted across the replacement.
					server.of("/b").to("keep").emit("room", { room: "keep", seq: 11 });
					await waitFor(() => keep.events.length === 2);
					expect(keep.events.map((args) => args[0])).toEqual([
						{ room: "keep", seq: 10 },
						{ room: "keep", seq: 11 },
					]);
					expect(
						connected(contextB),
						"the sibling kept its session across the replacement",
					).toBe(2);
					expect(sockets["/b"]).toHaveLength(2);
					expect(contextB.lastStatus()?.state).toBe("connected");
					handleA2.dispose();
					handleB.dispose();
					await waitFor(
						() =>
							server.of("/a").sockets.size === 0 &&
							server.of("/b").sockets.size === 0,
					);
					expect(server.of("/a").adapter.rooms.size).toBe(0);
				} finally {
					handleA2?.dispose();
					handleB.dispose();
					handleA.dispose();
					server.disconnectSockets(true);
					for (const socket of tcp) socket.destroy();
					await new Promise<void>((resolve) => server.close(() => resolve()));
				}
			});
		});

		// Check both buffered packets and retained authentication callbacks after releasing a namespace handle.
		describe("a disposed handle's namespace socket holds nothing and is not reused", () => {
			/** upstream's namespace name (private in its typings). */
			const nspOf = (peer: Socket) => (peer as unknown as { nsp: string }).nsp;
			const member = (room: string): SocketIoSubscriptionSpec => ({
				event: "room",
				membership: room,
				route: "byRoom",
				join: { event: "join", args: [room] },
				leave: { event: "leave", args: [room] },
			});
			const roomsOf = (socket: ServerSocket | undefined) =>
				socket
					? [...socket.rooms].filter((room) => room !== socket.id).sort()
					: [];
			const connected = (context: ReturnType<typeof createTestContext>) =>
				context.statuses.filter((status) => status.state === "connected")
					.length;
			/** Listener counts per event (component-emitter's private store). */
			const listenerCounts = (emitter: unknown) =>
				Object.fromEntries(
					Object.entries(
						(emitter as { _callbacks?: Record<string, unknown[]> })
							._callbacks ?? {},
					).filter(([, listeners]) => listeners.length > 0),
				);

			/** Namespaces `/a` and `/b` of one isolated server, one Manager. */
			async function namespaces(recovery: boolean, ackTimeoutMs: number) {
				const transport = createServer();
				const tcp = new Set<NetSocket>();
				transport.on("connection", (socket) => {
					tcp.add(socket);
					socket.on("close", () => tcp.delete(socket));
				});
				const server = new Server(transport, {
					pingInterval: 400,
					pingTimeout: 300,
					...(recovery
						? { connectionStateRecovery: { maxDisconnectionDuration: 90_000 } }
						: {}),
				});
				const sockets: Record<string, ServerSocket[]> = { "/a": [], "/b": [] };
				const joins: Record<string, number> = {};
				for (const name of ["/a", "/b"]) {
					server.of(name).on("connection", (socket) => {
						sockets[name]?.push(socket);
						socket.on("join", (room: string, ack: (value: unknown) => void) => {
							joins[`${name}:${room}`] = (joins[`${name}:${room}`] ?? 0) + 1;
							void socket.join(room);
							ack({ ok: true });
						});
						socket.on(
							"leave",
							(room: string, ack: (value: unknown) => void) => {
								void socket.leave(room);
								ack({ ok: true });
							},
						);
					});
				}
				await new Promise<void>((resolve) =>
					transport.listen(0, "127.0.0.1", resolve),
				);
				const address = transport.address();
				if (!address || typeof address === "string") {
					throw new Error("no loopback port");
				}
				const peers = tapPeers();
				const adapter = socketIoAdapter({ routes: { byRoom } });
				const opened = new Set<AdapterConnection>();
				const peersOf = (namespace: string) =>
					peers.filter((peer) => nspOf(peer) === namespace);
				return {
					server,
					sockets,
					joins,
					peersOf,
					/** The genuine upstream socket the Manager keeps for `namespace`. */
					peer(namespace: string) {
						const peer = peersOf(namespace)[0];
						if (!peer) throw new Error(`no upstream ${namespace} socket`);
						return peer;
					},
					/** A new handle for `namespace` on the shared Manager. */
					open(namespace: string) {
						const context = createTestContext({ credentials: () => ({}) });
						const connection = adapter.connect(
							{
								url: `http://127.0.0.1:${address.port}`,
								namespace,
								sharing: "shared",
								anonymous: true,
								transports: ["websocket" as const],
								reconnectionDelayMs: 300,
								reconnectionDelayMaxMs: 600,
								ackTimeoutMs,
							},
							context.ctx,
						);
						opened.add(connection);
						return { connection, context };
					},
					dispose(connection: AdapterConnection) {
						connection.dispose();
						opened.delete(connection);
					},
					async close() {
						for (const connection of opened) connection.dispose();
						server.disconnectSockets(true);
						for (const socket of tcp) socket.destroy();
						await new Promise<void>((resolve) => server.close(() => resolve()));
					},
				};
			}

			for (const recovery of [true, false]) {
				for (const buffered of [true, false]) {
					it(`${
						buffered
							? "a join upstream buffered while the heartbeat had expired"
							: "control: a join sent before the loss"
					} for a disposed handle never reaches the replacement's session: rooms ["new"] only, no traffic for a room no consumer wants (recovery ${
						recovery ? "on" : "off"
					}, VG6-B1)`, async () => {
						// The acknowledgement budget outlasts the replacement's connect:
						// upstream drops a buffered packet when its acknowledgement
						// times out.
						const rig = await namespaces(recovery, 5_000);
						try {
							const a = rig.open("/a");
							const b = rig.open("/b");
							const baseSink = createRecordingSink<unknown[]>();
							const baseSub = a.connection.subscribe(
								member("base"),
								baseSink.sink,
								{ key: "base", repeatable: true },
							);
							const keep = createRecordingSink<unknown[]>();
							b.connection.subscribe(member("keep"), keep.sink, {
								key: "keep",
								repeatable: true,
							});
							await waitFor(
								() =>
									roomsOf(rig.sockets["/a"]?.at(-1)).includes("base") &&
									roomsOf(rig.sockets["/b"]?.at(-1)).includes("keep"),
							);
							rig.server
								.of("/a")
								.to("base")
								.emit("room", { room: "base", seq: 1 });
							await waitFor(() => baseSink.events.length === 1);
							const upstreamA = rig.peer("/a");
							const subscribeOld = () =>
								a.connection.subscribe(
									member("old"),
									createRecordingSink<unknown[]>().sink,
									{ key: "old", repeatable: true },
								);
							let oldSub: { unsubscribe(): void };
							if (buffered) {
								// A frozen tab: the heartbeat deadline (400 + 300 ms) passes
								// while the socket still reads connected; the first task on
								// resume subscribes. Nothing private is written.
								const until = Date.now() + 900;
								while (Date.now() < until) {
									// the event loop is blocked
								}
								oldSub = subscribeOld();
								expect(
									upstreamA.sendBuffer,
									"precondition: upstream buffered the join (heartbeat expired)",
								).toHaveLength(1);
							} else {
								oldSub = subscribeOld();
								await waitFor(() =>
									roomsOf(rig.sockets["/a"]?.at(-1)).includes("old"),
								);
								// A loss the server detects (both namespaces share the engine).
								rig.sockets["/a"]?.at(-1)?.conn.close();
							}
							await waitFor(
								() => a.context.lastStatus()?.state === "reconnecting",
							);
							// The last consumers of `/a` leave during the outage.
							oldSub.unsubscribe();
							baseSub.unsubscribe();
							rig.dispose(a.connection);
							expect
								.soft(
									upstreamA.sendBuffer,
									"nothing queued for the disposed handle is kept",
								)
								.toHaveLength(0);
							await waitFor(() => connected(b.context) === 2);
							// A new consumer of `/a` inside the acknowledgement window.
							const a2 = rig.open("/a");
							const fresh = createRecordingSink<unknown[]>();
							a2.connection.subscribe(member("new"), fresh.sink, {
								key: "new",
								repeatable: true,
							});
							await waitFor(() =>
								roomsOf(rig.sockets["/a"]?.at(-1)).includes("new"),
							);
							await sleep(200);
							const replacement = rig.sockets["/a"]?.at(-1);
							// Raw `/a` traffic the Manager decodes, below any socket.
							const rawOld: unknown[] = [];
							(
								upstreamA.io as unknown as {
									on(
										event: "packet",
										listener: (packet: { nsp: string; data?: unknown }) => void,
									): void;
								}
							).on("packet", (packet) => {
								const payload = Array.isArray(packet.data)
									? (packet.data[1] as { room?: string } | undefined)
									: undefined;
								if (packet.nsp === "/a" && payload?.room === "old") {
									rawOld.push(payload);
								}
							});
							rig.server
								.of("/a")
								.to("old")
								.emit("room", { room: "old", seq: 2 });
							rig.server
								.of("/a")
								.to("new")
								.emit("room", { room: "new", seq: 3 });
							await waitFor(() => fresh.events.length === 1);
							await sleep(100);
							const upstreamA2 = rig.peersOf("/a").at(-1);
							expect(
								upstreamA2,
								"the replacement gets its own socket",
							).not.toBe(upstreamA);
							expect(upstreamA.active, "the disposed one is inert").toBe(false);
							expect(
								upstreamA.sendBuffer,
								"and holds no queued packet",
							).toHaveLength(0);
							expect(
								(upstreamA.io as unknown as { nsps: Record<string, Socket> })
									.nsps["/a"],
								"and is not cached",
							).toBe(upstreamA2);
							expect(replacement?.conn, "one physical Engine").toBe(
								rig.sockets["/b"]?.at(-1)?.conn,
							);
							expect(
								roomsOf(replacement),
								"no room of the disposed handle reaches the replacement",
							).toEqual(["new"]);
							expect(replacement?.recovered, "a fresh session").toBe(false);
							expect(rig.server.of("/a").adapter.rooms.has("old")).toBe(false);
							expect(rawOld, "no traffic for a room no consumer wants").toEqual(
								[],
							);
							expect(
								rig.joins["/a:old"] ?? 0,
								buffered
									? "the buffered join is never sent"
									: "sent once, before the loss",
							).toBe(buffered ? 0 : 1);
							expect(rig.joins["/a:new"]).toBe(1);
							// Under recovery the server appends its offset to each event.
							expect(fresh.events.map((args) => args[0])).toEqual([
								{ room: "new", seq: 3 },
							]);
							expect(fresh.errors).toEqual([]);
							expect(roomsOf(rig.sockets["/b"]?.at(-1))).toEqual(["keep"]);
							rig.dispose(a2.connection);
							rig.dispose(b.connection);
							await waitFor(
								() =>
									rig.server.of("/a").sockets.size === 0 &&
									rig.server.of("/b").sockets.size === 0,
							);
							expect(rig.server.of("/a").adapter.rooms.size).toBe(0);
						} finally {
							await rig.close();
						}
					});
				}
			}

			it("24 replace cycles of `/a` while `/b` keeps the shared connection: each dispose unbinds the handle's callback and keeps no queued packet, each replacement gets its own socket, the Manager caches only the namespaces with live handles with flat listener counts, and `/b` receives every broadcast without a reconnect (VG6-R2, VG6-R3)", async () => {
				const CYCLES = 24;
				const rig = await namespaces(true, 1_000);
				try {
					const b = rig.open("/b");
					const keep = createRecordingSink<unknown[]>();
					b.connection.subscribe(member("keep"), keep.sink, {
						key: "keep",
						repeatable: true,
					});
					await waitFor(() =>
						roomsOf(rig.sockets["/b"]?.at(-1)).includes("keep"),
					);
					const manager = rig.peer("/b").io;
					const baseline = listenerCounts(manager);
					for (let cycle = 0; cycle < CYCLES; cycle += 1) {
						const a = rig.open("/a");
						const sink = createRecordingSink<unknown[]>();
						a.connection.subscribe(member(`r${cycle}`), sink.sink, {
							key: `r${cycle}`,
							repeatable: true,
						});
						await waitFor(() =>
							roomsOf(rig.sockets["/a"]?.at(-1)).includes(`r${cycle}`),
						);
						const upstreamA = rig.peersOf("/a").at(-1) as Socket;
						expect(
							new Set(rig.peersOf("/a")).size,
							`cycle ${cycle}: a socket of its own`,
						).toBe(cycle + 1);
						expect(
							typeof upstreamA.auth,
							`cycle ${cycle}: the live handle's callback is bound`,
						).toBe("function");
						expect(
							rig.sockets["/a"]?.at(-1)?.conn,
							`cycle ${cycle}: one physical Engine`,
						).toBe(rig.sockets["/b"]?.at(-1)?.conn);
						rig.server
							.of("/a")
							.to(`r${cycle}`)
							.emit("room", { room: `r${cycle}`, seq: cycle });
						rig.server
							.of("/b")
							.to("keep")
							.emit("room", { room: "keep", seq: cycle });
						await waitFor(
							() =>
								sink.events.length === 1 && keep.events.length === cycle + 1,
						);
						rig.dispose(a.connection);
						expect(
							typeof upstreamA.auth,
							`cycle ${cycle}: no disposed handle's callback on the kept socket`,
						).not.toBe("function");
						expect(
							upstreamA.sendBuffer,
							`cycle ${cycle}: nothing queued for the disposed handle`,
						).toHaveLength(0);
						expect(
							Object.keys(
								(manager as unknown as { nsps: Record<string, unknown> }).nsps,
							).sort(),
							`cycle ${cycle}: only the namespaces with live handles`,
						).toEqual(["/b"]);
						expect(
							listenerCounts(manager),
							`cycle ${cycle}: Manager listener counts flat`,
						).toEqual(baseline);
						await waitFor(
							() =>
								rig.server.of("/a").sockets.size === 0 &&
								rig.server.of("/a").adapter.rooms.size === 0,
							{ message: `cycle ${cycle}: the disposed handle's room is gone` },
						);
					}
					expect(
						keep.events.map((args) => args[0]),
						"/b received every broadcast",
					).toEqual(
						Array.from({ length: CYCLES }, (_, seq) => ({ room: "keep", seq })),
					);
					expect(connected(b.context), "/b never reconnected").toBe(1);
					expect(rig.sockets["/b"]).toHaveLength(1);
					expect(roomsOf(rig.sockets["/b"]?.at(-1))).toEqual(["keep"]);
					rig.dispose(b.connection);
					await waitFor(() => rig.server.of("/b").sockets.size === 0);
					expect(rig.server.of("/b").adapter.rooms.size).toBe(0);
				} finally {
					await rig.close();
				}
			});
		});

		// Release during an unanswered namespace handshake must clean up the server socket while a sibling keeps the engine alive.
		describe("a namespace handshake in flight at release is drained", () => {
			const CONNECT = 0;
			const DISCONNECT = 1;
			/** upstream's namespace name (private in its typings). */
			const nspOf = (peer: Socket) => (peer as unknown as { nsp: string }).nsp;
			/** upstream's recovery pid and cursor (private in its typings). */
			const recoveryOf = (peer: Socket) =>
				peer as unknown as { _pid?: string; _lastOffset?: string };
			/** The Manager's namespace cache (private in its typings). */
			const cacheOf = (manager: Manager) =>
				(manager as unknown as { nsps: Record<string, Socket> }).nsps;
			const member = (room: string): SocketIoSubscriptionSpec => ({
				event: "room",
				membership: room,
				route: "byRoom",
				join: { event: "join", args: [room] },
				leave: { event: "leave", args: [room] },
			});
			const roomsOf = (socket: ServerSocket | undefined) =>
				socket
					? [...socket.rooms].filter((room) => room !== socket.id).sort()
					: [];
			const connected = (context: ReturnType<typeof createTestContext>) =>
				context.statuses.filter((status) => status.state === "connected")
					.length;

			/**
			 * The namespace packets every upstream socket writes (`packet()`) and
			 * receives for its own namespace (`onpacket()`), in order. Installed
			 * before any socket subscribes: upstream binds `onpacket` then.
			 */
			function tapWire() {
				const wire: Array<{
					dir: "in" | "out";
					/** The upstream socket, or the Manager for what it decoded. */
					socket: Socket | Manager;
					type: number;
					data?: unknown;
				}> = [];
				type Packet = { nsp: string; type: number; data?: unknown };
				const proto = Socket.prototype as unknown as {
					packet: (this: Socket, packet: Packet) => void;
					onpacket: (this: Socket, packet: Packet) => void;
				};
				const { packet, onpacket } = proto;
				proto.packet = function (this: Socket, value: Packet) {
					wire.push({ dir: "out", socket: this, type: value.type });
					return packet.call(this, value);
				};
				proto.onpacket = function (this: Socket, value: Packet) {
					if (value.nsp === nspOf(this)) {
						wire.push({
							dir: "in",
							socket: this,
							type: value.type,
							data: value.data,
						});
					}
					return onpacket.call(this, value);
				};
				restores.push(() => {
					proto.packet = packet;
					proto.onpacket = onpacket;
				});
				return wire;
			}

			/**
			 * An isolated server with `/a` and `/b` on one adapter and Manager.
			 * `hold()` holds the next `/a` handshake in the `/a` middleware
			 * (`middleware`) or in the session store (`restore`) until
			 * `release(error?)`.
			 */
			async function rig(options: {
				recovery: boolean;
				skipMiddlewares?: false;
				userRoom?: boolean;
			}) {
				const transport = createServer();
				const tcp = new Set<NetSocket>();
				transport.on("connection", (socket) => {
					tcp.add(socket);
					socket.on("close", () => tcp.delete(socket));
				});
				const server = new Server(transport, {
					pingInterval: 400,
					pingTimeout: 300,
					...(options.recovery
						? {
								connectionStateRecovery: {
									maxDisconnectionDuration: 90_000,
									...(options.skipMiddlewares === false
										? { skipMiddlewares: false }
										: {}),
								},
							}
						: {}),
				});
				let holding: "middleware" | "restore" | undefined;
				const held: Array<(error?: Error) => void> = [];
				server.of("/a").use((_socket, next) => {
					if (holding !== "middleware") return next();
					holding = undefined;
					held.push((error) => (error ? next(error) : next()));
				});
				const store = server.of("/a").adapter as unknown as {
					restoreSession: (pid: string, offset: string) => Promise<unknown>;
				};
				const restoreSession = store.restoreSession.bind(store);
				store.restoreSession = async (pid: string, offset: string) => {
					if (holding === "restore") {
						holding = undefined;
						await new Promise<void>((resolve) => held.push(() => resolve()));
					}
					return restoreSession(pid, offset);
				};
				const sockets: Record<string, ServerSocket[]> = { "/a": [], "/b": [] };
				const joins: Record<string, number> = {};
				/** One-off application commands the server executed. */
				const commands: string[] = [];
				for (const name of ["/a", "/b"]) {
					server.of(name).on("connection", (socket) => {
						sockets[name]?.push(socket);
						// A per-user room the server joins on connection.
						if (options.userRoom && name === "/a") void socket.join("user");
						socket.on(
							"once",
							(token: string, ack: (value: unknown) => void) => {
								commands.push(`${name}:${token}`);
								ack({ token });
							},
						);
						socket.on("join", (room: string, ack: (value: unknown) => void) => {
							joins[`${name}:${room}`] = (joins[`${name}:${room}`] ?? 0) + 1;
							void socket.join(room);
							ack({ ok: true });
						});
						socket.on(
							"leave",
							(room: string, ack: (value: unknown) => void) => {
								void socket.leave(room);
								ack({ ok: true });
							},
						);
					});
				}
				await new Promise<void>((resolve) =>
					transport.listen(0, "127.0.0.1", resolve),
				);
				const address = transport.address();
				if (!address || typeof address === "string") {
					throw new Error("no loopback port");
				}
				const wire = tapWire();
				const peers = tapPeers();
				const adapter = socketIoAdapter({ routes: { byRoom } });
				const opened = new Set<AdapterConnection>();
				const base = {
					url: `http://127.0.0.1:${address.port}`,
					sharing: "shared" as const,
					transports: ["websocket" as const],
					reconnectionDelayMs: 300,
					reconnectionDelayMaxMs: 600,
					ackTimeoutMs: 1_000,
				};
				return {
					server,
					sockets,
					joins,
					commands,
					wire,
					peers,
					/** The upstream sockets created for `namespace`, in order. */
					peersOf: (namespace: string) =>
						peers.filter((peer) => nspOf(peer) === namespace),
					hold(where: "middleware" | "restore") {
						holding = where;
					},
					/** Answers the held handshake (an error refuses it). */
					release(error?: Error) {
						holding = undefined;
						for (const answer of held.splice(0)) answer(error);
					},
					heldCount: () => held.length,
					/** A new handle for `namespace` on the shared Manager. */
					open(
						namespace: string,
						credentials?: () => Promise<Record<string, unknown>>,
					) {
						const context = createTestContext({
							credentials: credentials ?? (() => ({})),
						});
						const connection = adapter.connect(
							{
								...base,
								namespace,
								...(credentials ? {} : { anonymous: true }),
							},
							context.ctx,
						);
						opened.add(connection);
						return { connection, context };
					},
					dispose(connection: AdapterConnection) {
						connection.dispose();
						opened.delete(connection);
					},
					async close() {
						this.release();
						for (const connection of opened) connection.dispose();
						server.disconnectSockets(true);
						for (const socket of tcp) socket.destroy();
						await new Promise<void>((resolve) => server.close(() => resolve()));
					},
				};
			}

			/**
			 * Events the Manager decodes for `namespace` from now on, below any
			 * namespace socket: what reaches the client whether or not a socket
			 * still listens.
			 */
			function eventsFor(manager: Manager, namespace: string) {
				const events: unknown[] = [];
				(
					manager as unknown as {
						on(
							event: "packet",
							listener: (packet: {
								nsp: string;
								type: number;
								data?: unknown;
							}) => void,
						): void;
					}
				).on("packet", (packet) => {
					if (packet.nsp === namespace && packet.type === 2) {
						events.push(packet.data);
					}
				});
				return events;
			}

			/** `socket`'s namespace packets from `from` on: [direction, type]. */
			const trace = (
				wire: Awaited<ReturnType<typeof rig>>["wire"],
				socket: Socket,
				from: number,
			) =>
				wire
					.slice(from)
					.filter((entry) => entry.socket === socket)
					.map((entry) => `${entry.dir}:${entry.type}`);

			/**
			 * Records into `wire` every packet the Manager decodes for
			 * `namespace` from now on, before any socket or drain sees it: a
			 * released socket no longer subscribes, so the drained
			 * handshake's reply is observed here.
			 */
			function tapManager(
				wire: Awaited<ReturnType<typeof rig>>["wire"],
				manager: Manager,
				namespace: string,
			) {
				manager.on("packet", (packet) => {
					if (packet.nsp === namespace) {
						wire.push({
							dir: "in",
							socket: manager,
							type: packet.type,
							data: packet.data,
						});
					}
				});
			}

			/** The Manager's (`M`) and `socket`'s (`A`) entries from `from` on. */
			const drainTrace = (
				wire: Awaited<ReturnType<typeof rig>>["wire"],
				manager: Manager,
				socket: Socket,
				from: number,
			) =>
				wire
					.slice(from)
					.filter(
						(entry) => entry.socket === manager || entry.socket === socket,
					)
					.map(
						(entry) =>
							`${entry.socket === manager ? "M" : "A"}:${entry.dir}:${entry.type}`,
					);

			// Hold the recovery CONNECT in middleware or session storage to exercise release before confirmation.
			for (const leg of [
				"hold-middleware",
				"hold-restore",
				"control-confirmed",
				"control-outage",
			] as const) {
				it(`a handle released while its recovery CONNECT is unanswered leaves no server socket, room or buffered event of its session behind, and the next handle does not disrupt the sibling (${leg}, VG6R2-F1)`, async () => {
					const h = await rig({
						recovery: true,
						...(leg === "hold-middleware"
							? { skipMiddlewares: false as const }
							: {}),
					});
					try {
						const a = h.open("/a");
						const b = h.open("/b");
						const old = createRecordingSink<unknown[]>();
						const oldSub = a.connection.subscribe(member("old"), old.sink, {
							key: "old",
							repeatable: true,
						});
						const keep = createRecordingSink<unknown[]>();
						b.connection.subscribe(member("keep"), keep.sink, {
							key: "keep",
							repeatable: true,
						});
						await waitFor(
							() =>
								roomsOf(h.sockets["/a"]?.at(-1)).includes("old") &&
								roomsOf(h.sockets["/b"]?.at(-1)).includes("keep"),
						);
						// An event gives A's upstream socket a recovery cursor.
						h.server.of("/a").to("old").emit("room", { room: "old", seq: 1 });
						await waitFor(() => old.events.length === 1);
						const [upstreamA] = h.peersOf("/a");
						if (!upstreamA) throw new Error("no upstream /a socket");
						const manager = upstreamA.io;
						const pidA = recoveryOf(upstreamA)._pid;
						expect(pidA, "the first session holds a recovery pid").toEqual(
							expect.any(String),
						);
						if (leg.startsWith("hold")) {
							h.hold(leg === "hold-middleware" ? "middleware" : "restore");
						}
						// A loss the server detects: both namespaces share the engine
						// and both sessions are kept for recovery.
						h.sockets["/a"]?.at(-1)?.conn.close();
						await waitFor(
							() => a.context.lastStatus()?.state === "reconnecting",
						);
						// The last consumer of `/a` leaves during the outage.
						oldSub.unsubscribe();
						// An event the session misses: replayed on a restore.
						h.server.of("/a").to("old").emit("room", { room: "old", seq: 2 });
						let receiveBufferAtDispose = 0;
						if (leg === "control-confirmed") {
							await waitFor(() => connected(a.context) === 2);
						} else if (leg !== "control-outage") {
							// A's CONNECT (with its pid and offset) reached the server
							// and is being processed; no confirmation was sent.
							await waitFor(() => h.heldCount() === 1, {
								message: "the /a CONNECT never reached the server",
							});
							if (leg === "hold-middleware") {
								// The restored socket writes the missed packet before its
								// CONNECT: upstream keeps it in `receiveBuffer`.
								await waitFor(() => upstreamA.receiveBuffer.length > 0, {
									timeout: 3_000,
								});
							}
							receiveBufferAtDispose = upstreamA.receiveBuffer.length;
							expect(upstreamA.connected, "unconfirmed at release").toBe(false);
						}
						tapManager(h.wire, manager, "/a");
						const mark = h.wire.length;
						h.dispose(a.connection);
						expect(
							cacheOf(manager)["/a"],
							"the released socket left the Manager's cache",
						).toBeUndefined();
						// Unsubscribed at release, its buffer released: nothing the
						// server sends before its reply is kept for it.
						expect(upstreamA.active).toBe(false);
						expect(upstreamA.receiveBuffer).toHaveLength(0);
						h.release();
						await waitFor(() => connected(b.context) === 2);
						await sleep(300);
						// Traffic for the disposed session's room, after the release.
						const toClient = eventsFor(manager, "/a");
						h.server.of("/a").to("old").emit("room", { room: "old", seq: 3 });
						// Several heartbeats: nothing times a lingering socket out.
						await sleep(1_200);
						expect(
							h.server.of("/a").adapter.rooms.has("old"),
							"no room of the disposed handle survives on the shared engine",
						).toBe(false);
						expect(
							h.server.of("/a").sockets.size,
							"no /a server socket of the disposed handle",
						).toBe(0);
						expect(
							toClient,
							"no traffic for a room no consumer wants reaches the client",
						).toEqual([]);
						// The wire: nothing before the server's reply (decoded by the
						// Manager, never by the released socket), then DISCONNECT once
						// through the released socket's own writer; never a second
						// CONNECT.
						expect(drainTrace(h.wire, manager, upstreamA, mark)).toEqual(
							leg === "control-confirmed"
								? [`A:out:${DISCONNECT}`]
								: leg === "control-outage"
									? []
									: leg === "hold-restore"
										? [`M:in:2`, `M:in:${CONNECT}`, `A:out:${DISCONNECT}`]
										: [`M:in:${CONNECT}`, `A:out:${DISCONNECT}`],
						);
						expect(upstreamA.receiveBuffer, "nothing buffered").toHaveLength(0);
						expect(upstreamA.active, "the drained socket is inert").toBe(false);
						expect(
							recoveryOf(upstreamA)._pid,
							"and keeps no pid",
						).toBeUndefined();
						expect(recoveryOf(upstreamA)._lastOffset).toBeUndefined();
						// A later consumer of `/a` on the same shared connection.
						const bConnects = connected(b.context);
						const bSockets = h.sockets["/b"]?.length ?? 0;
						const a2 = h.open("/a");
						const fresh = createRecordingSink<unknown[]>();
						a2.connection.subscribe(member("new"), fresh.sink, {
							key: "new",
							repeatable: true,
						});
						// A fresh consumer of `old` on the replacement.
						const freshOld = createRecordingSink<unknown[]>();
						a2.connection.subscribe(member("old"), freshOld.sink, {
							key: "old",
							repeatable: true,
						});
						await waitFor(
							() =>
								roomsOf(h.sockets["/a"]?.at(-1)).includes("new") &&
								roomsOf(h.sockets["/a"]?.at(-1)).includes("old") &&
								a2.context.lastStatus()?.state === "connected",
							{ timeout: 10_000 },
						);
						await sleep(400);
						h.server.of("/a").to("old").emit("room", { room: "old", seq: 4 });
						await waitFor(() =>
							freshOld.events.some(
								(args) => (args[0] as { seq?: number }).seq === 4,
							),
						);
						await sleep(200);
						const upstreamA2 = h.peersOf("/a").at(-1);
						expect(upstreamA2, "the replacement has its own socket").not.toBe(
							upstreamA,
						);
						expect(cacheOf(manager)["/a"]).toBe(upstreamA2);
						expect(recoveryOf(upstreamA2 as Socket)._pid).not.toBe(pidA);
						expect(h.sockets["/a"]?.at(-1)?.recovered, "a fresh session").toBe(
							false,
						);
						expect(h.sockets["/a"]?.at(-1)?.conn).toBe(
							h.sockets["/b"]?.at(-1)?.conn,
						);
						// A missed event the disposed socket held in `receiveBuffer`
						// (hold-middleware: seq 2) never reaches a fresh consumer.
						expect(
							freshOld.events.map((args) => (args[0] as { seq?: number }).seq),
							`a fresh consumer on the replacement receives no event of the disposed session (receiveBuffer at release: ${receiveBufferAtDispose})`,
						).toEqual([4]);
						if (leg === "hold-middleware") {
							expect(receiveBufferAtDispose).toBeGreaterThan(0);
						}
						expect(fresh.errors).toEqual([]);
						expect(freshOld.errors).toEqual([]);
						expect(
							connected(b.context),
							"the sibling keeps its session across the replacement",
						).toBe(bConnects);
						expect(h.sockets["/b"]).toHaveLength(bSockets);
						expect(b.context.lastStatus()?.state).toBe("connected");
						expect(roomsOf(h.sockets["/b"]?.at(-1))).toEqual(["keep"]);
					} finally {
						await h.close();
					}
				});
			}

			// Hold the fresh CONNECT in auth middleware to exercise release before the server registers its per-user room.
			for (const recovery of [false, true]) {
				for (const leg of [
					"hold-first-connect",
					"control-confirmed",
				] as const) {
					it(`a handle released while its first CONNECT is unanswered leaves no server socket or room on the shared engine, and a later handle does not disrupt the sibling (${leg}, recovery ${
						recovery ? "on" : "off"
					}, VG6R2-F1)`, async () => {
						const h = await rig({ recovery, userRoom: true });
						try {
							const b = h.open("/b");
							const keep = createRecordingSink<unknown[]>();
							b.connection.subscribe(member("keep"), keep.sink, {
								key: "keep",
								repeatable: true,
							});
							await waitFor(() =>
								roomsOf(h.sockets["/b"]?.at(-1)).includes("keep"),
							);
							if (leg === "hold-first-connect") h.hold("middleware");
							const a = h.open("/a");
							a.connection.subscribe(
								member("mine"),
								createRecordingSink<unknown[]>().sink,
								{ key: "mine", repeatable: true },
							);
							if (leg === "hold-first-connect") {
								await waitFor(() => h.heldCount() === 1, {
									message: "the /a CONNECT never reached the server",
								});
							} else {
								await waitFor(() => connected(a.context) === 1);
							}
							const [upstreamA] = h.peersOf("/a");
							if (!upstreamA) throw new Error("no upstream /a socket");
							const manager = upstreamA.io;
							tapManager(h.wire, manager, "/a");
							const mark = h.wire.length;
							h.dispose(a.connection);
							expect(cacheOf(manager)["/a"]).toBeUndefined();
							expect(upstreamA.active, "unsubscribed at release").toBe(false);
							h.release();
							await sleep(400);
							const toClient = eventsFor(manager, "/a");
							h.server
								.of("/a")
								.to("user")
								.emit("room", { room: "user", seq: 1 });
							// Several heartbeats: nothing times a lingering socket out.
							await sleep(1_200);
							h.server
								.of("/b")
								.to("keep")
								.emit("room", { room: "keep", seq: 1 });
							await waitFor(() => keep.events.length === 1);
							expect(
								h.server.of("/a").sockets.size,
								"no /a server socket of the disposed handle",
							).toBe(0);
							expect(h.server.of("/a").adapter.rooms.has("user")).toBe(false);
							expect(toClient, "no traffic for the disposed handle").toEqual(
								[],
							);
							expect(drainTrace(h.wire, manager, upstreamA, mark)).toEqual(
								leg === "control-confirmed"
									? [`A:out:${DISCONNECT}`]
									: [`M:in:${CONNECT}`, `A:out:${DISCONNECT}`],
							);
							expect(upstreamA.active).toBe(false);
							expect(upstreamA.receiveBuffer).toHaveLength(0);
							// A later consumer of `/a` on the same shared connection.
							const bConnects = connected(b.context);
							const bSockets = h.sockets["/b"]?.length ?? 0;
							const a2 = h.open("/a");
							a2.connection.subscribe(
								member("new"),
								createRecordingSink<unknown[]>().sink,
								{ key: "new", repeatable: true },
							);
							await waitFor(
								() =>
									roomsOf(h.sockets["/a"]?.at(-1)).includes("new") &&
									a2.context.lastStatus()?.state === "connected",
								{ timeout: 10_000 },
							);
							await sleep(600);
							h.server
								.of("/b")
								.to("keep")
								.emit("room", { room: "keep", seq: 2 });
							await waitFor(() => keep.events.length === 2);
							expect(h.peersOf("/a").at(-1)).not.toBe(upstreamA);
							expect(h.server.of("/a").sockets.size).toBe(1);
							expect(roomsOf(h.sockets["/a"]?.at(-1))).toEqual(["new", "user"]);
							expect(
								connected(b.context),
								"the sibling keeps its session across the later /a handle",
							).toBe(bConnects);
							expect(h.sockets["/b"]).toHaveLength(bSockets);
							expect(keep.continuity).toEqual([]);
							expect(a2.context.statuses.map((status) => status.state)).toEqual(
								["connecting", "connected"],
							);
						} finally {
							await h.close();
						}
					});
				}
			}

			// A successor may force one engine close; verify sibling recovery and that commands are never replayed.
			for (const recovery of [false, true]) {
				it(`a handle opened while a released handle's CONNECT drains writes no CONNECT while that DISCONNECT is owed and connects on its own socket once it is written; the sibling keeps the Engine with no notice or recovers from one forced close by phase (recovery ${
					recovery ? "on" : "off"
				})`, async () => {
					const h = await rig({ recovery, userRoom: true });
					try {
						const b = h.open("/b");
						const keep = createRecordingSink<unknown[]>();
						const notices: Array<{
							reason: string;
							status: string | undefined;
							connected: number;
						}> = [];
						b.connection.subscribe(
							member("keep"),
							{
								...keep.sink,
								continuity(reason, detail) {
									notices.push({
										reason,
										status: b.context.lastStatus()?.state,
										connected: connected(b.context),
									});
									keep.sink.continuity(reason, detail);
								},
							},
							{ key: "keep", repeatable: true },
						);
						await waitFor(() =>
							roomsOf(h.sockets["/b"]?.at(-1)).includes("keep"),
						);
						const once = await b.connection.command?.(
							{ event: "once", args: ["one-off"], ack: true },
							{ id: "one-off", signal: b.context.ctx.signal, timeoutMs: 1_000 },
						);
						expect(once?.status).toBe("acknowledged");
						h.hold("middleware");
						const a = h.open("/a");
						a.connection.subscribe(
							member("mine"),
							createRecordingSink<unknown[]>().sink,
							{ key: "mine", repeatable: true },
						);
						await waitFor(() => h.heldCount() === 1);
						const [upstreamA] = h.peersOf("/a");
						if (!upstreamA) throw new Error("no upstream /a socket");
						const manager = upstreamA.io;
						h.dispose(a.connection);
						// The successor, while the drained CONNECT is still unanswered.
						const a2 = h.open("/a");
						const fresh = createRecordingSink<unknown[]>();
						a2.connection.subscribe(member("new"), fresh.sink, {
							key: "new",
							repeatable: true,
						});
						await sleep(300);
						const upstreamA2 = h.peersOf("/a").at(-1) as Socket;
						expect(upstreamA2, "the successor has its own socket").not.toBe(
							upstreamA,
						);
						expect(
							trace(h.wire, upstreamA2, 0),
							"no CONNECT while the released handle's DISCONNECT is owed",
						).toEqual([]);
						expect(
							upstreamA2.active,
							"not subscribed while it waits, so it buffers nothing",
						).toBe(false);
						expect(a2.context.lastStatus()?.state).toBe("connecting");
						const engineBefore = manager.engine;
						const bConnects = connected(b.context);
						h.release();
						await waitFor(
							() =>
								roomsOf(h.sockets["/a"]?.at(-1)).includes("new") &&
								a2.context.lastStatus()?.state === "connected" &&
								b.context.lastStatus()?.state === "connected" &&
								roomsOf(h.sockets["/b"]?.at(-1)).includes("keep"),
							{ timeout: 10_000 },
						);
						await sleep(600);
						// The successor's CONNECT follows the drain's DISCONNECT.
						const order = h.wire
							.filter(
								(entry) =>
									entry.dir === "out" &&
									(entry.socket === upstreamA || entry.socket === upstreamA2),
							)
							.map((entry) =>
								entry.socket === upstreamA
									? `A:${entry.type}`
									: `A2:${entry.type}`,
							);
						expect(order.slice(0, 3)).toEqual([
							`A:${CONNECT}`,
							`A:${DISCONNECT}`,
							`A2:${CONNECT}`,
						]);
						expect(
							h.sockets["/a"]?.[0]?.connected,
							"the drained session's server socket is gone",
						).toBe(false);
						expect(h.server.of("/a").sockets.size).toBe(1);
						expect(roomsOf(h.sockets["/a"]?.at(-1))).toEqual(["new", "user"]);
						expect(h.sockets["/a"]?.at(-1)?.conn).toBe(
							h.sockets["/b"]?.at(-1)?.conn,
						);
						h.server.of("/a").to("new").emit("room", { room: "new", seq: 1 });
						await waitFor(() => fresh.events.length === 1);
						expect(fresh.errors).toEqual([]);
						expect(
							fresh.continuity,
							"the replacement's first connect reports no continuity",
						).toEqual([]);
						expect(h.commands, "no command replayed").toEqual(["/b:one-off"]);
						if (manager.engine === engineBefore) {
							expect(connected(b.context)).toBe(bConnects);
							expect(h.sockets["/b"]).toHaveLength(1);
							expect(notices).toEqual([]);
							expect(h.joins["/b:keep"]).toBe(1);
						} else {
							// Allow one forced close and one continuity notice per phase.
							expect(connected(b.context), "one forced close").toBe(
								bConnects + 1,
							);
							expect(
								notices,
								"the loss at detection, then the outcome before the restored `connected`",
							).toEqual([
								{
									reason: "reconnected",
									status: "connected",
									connected: bConnects,
								},
								{
									reason: expect.stringMatching(/^(reconnected|recovered)$/),
									status: "reconnecting",
									connected: bConnects,
								},
							]);
							expect(h.joins["/b:keep"], "rejoined once, or restored").toBe(
								notices[1]?.reason === "recovered" ? 1 : 2,
							);
						}
						expect(roomsOf(h.sockets["/b"]?.at(-1))).toEqual(["keep"]);
					} finally {
						await h.close();
					}
				});
			}

			it("a Manager close while the drain waits settles it before any reconnect: the released socket, unsubscribed since its release, never writes a second CONNECT, and a later handle connects", async () => {
				const h = await rig({ recovery: true, userRoom: true });
				try {
					const b = h.open("/b");
					b.connection.subscribe(
						member("keep"),
						createRecordingSink<unknown[]>().sink,
						{ key: "keep", repeatable: true },
					);
					await waitFor(() =>
						roomsOf(h.sockets["/b"]?.at(-1)).includes("keep"),
					);
					h.hold("middleware");
					const a = h.open("/a");
					a.connection.subscribe(
						member("mine"),
						createRecordingSink<unknown[]>().sink,
						{ key: "mine", repeatable: true },
					);
					await waitFor(() => h.heldCount() === 1);
					const [upstreamA] = h.peersOf("/a");
					if (!upstreamA) throw new Error("no upstream /a socket");
					const manager = upstreamA.io;
					const mark = h.wire.length;
					h.dispose(a.connection);
					expect(upstreamA.active, "unsubscribed at release").toBe(false);
					let activeAtClose: boolean | undefined;
					manager.on("close", () => {
						activeAtClose ??= upstreamA.active;
					});
					// The engine closes before the server answers.
					h.sockets["/b"]?.at(-1)?.conn.close();
					await waitFor(() => connected(b.context) === 2);
					expect(activeAtClose, "destroyed at the Manager's close").toBe(false);
					h.release(); // the old engine's handshake: ignored by the server
					await sleep(600);
					expect(trace(h.wire, upstreamA, mark), "nothing written").toEqual([]);
					expect(h.server.of("/a").sockets.size).toBe(0);
					const a2 = h.open("/a");
					a2.connection.subscribe(
						member("new"),
						createRecordingSink<unknown[]>().sink,
						{ key: "new", repeatable: true },
					);
					await waitFor(
						() =>
							roomsOf(h.sockets["/a"]?.at(-1)).includes("new") &&
							a2.context.lastStatus()?.state === "connected",
						{ timeout: 10_000 },
					);
					await sleep(400);
					expect(h.server.of("/a").sockets.size).toBe(1);
					expect(trace(h.wire, upstreamA, mark)).toEqual([]);
					expect(connected(b.context), "one induced reconnect only").toBe(2);
					expect(h.sockets["/b"]).toHaveLength(2);
				} finally {
					await h.close();
				}
			});

			it("a CONNECT_ERROR for the drained handshake settles the drain: a waiting handle then connects without disrupting the sibling", async () => {
				const h = await rig({ recovery: false });
				try {
					const b = h.open("/b");
					b.connection.subscribe(
						member("keep"),
						createRecordingSink<unknown[]>().sink,
						{ key: "keep", repeatable: true },
					);
					await waitFor(() =>
						roomsOf(h.sockets["/b"]?.at(-1)).includes("keep"),
					);
					h.hold("middleware");
					const a = h.open("/a");
					a.connection.subscribe(
						member("mine"),
						createRecordingSink<unknown[]>().sink,
						{ key: "mine", repeatable: true },
					);
					await waitFor(() => h.heldCount() === 1);
					const [upstreamA] = h.peersOf("/a");
					if (!upstreamA) throw new Error("no upstream /a socket");
					tapManager(h.wire, upstreamA.io, "/a");
					const mark = h.wire.length;
					h.dispose(a.connection);
					const a2 = h.open("/a");
					a2.connection.subscribe(
						member("new"),
						createRecordingSink<unknown[]>().sink,
						{ key: "new", repeatable: true },
					);
					await sleep(200);
					h.release(new Error("refused"));
					await waitFor(
						() =>
							roomsOf(h.sockets["/a"]?.at(-1)).includes("new") &&
							a2.context.lastStatus()?.state === "connected",
						{ timeout: 10_000 },
					);
					await sleep(400);
					// The refusal is decoded by the Manager; the released socket neither
					// receives nor writes anything. The successor's own
					// handshake follows it.
					expect(
						drainTrace(h.wire, upstreamA.io, upstreamA, mark).slice(0, 1),
					).toEqual(["M:in:4"]);
					expect(trace(h.wire, upstreamA, mark)).toEqual([]);
					expect(upstreamA.active).toBe(false);
					expect(h.server.of("/a").sockets.size).toBe(1);
					expect(connected(b.context)).toBe(1);
					expect(h.sockets["/b"]).toHaveLength(1);
				} finally {
					await h.close();
				}
			});

			it("control: without a sibling a handle released during its handshake closes the Manager and its Engine, so the server drops the handshake; nothing drains", async () => {
				const h = await rig({ recovery: true, userRoom: true });
				try {
					h.hold("middleware");
					const a = h.open("/a");
					a.connection.subscribe(
						member("mine"),
						createRecordingSink<unknown[]>().sink,
						{ key: "mine", repeatable: true },
					);
					await waitFor(() => h.heldCount() === 1);
					const [upstreamA] = h.peersOf("/a");
					if (!upstreamA) throw new Error("no upstream /a socket");
					const manager = upstreamA.io as Manager & { _readyState: string };
					const mark = h.wire.length;
					h.dispose(a.connection);
					expect(manager._readyState, "the Manager closed").toBe("closed");
					expect(upstreamA.active).toBe(false);
					h.release();
					await sleep(600);
					expect(h.server.of("/a").sockets.size).toBe(0);
					expect(h.server.engine.clientsCount).toBe(0);
					expect(trace(h.wire, upstreamA, mark)).toEqual([]);
				} finally {
					await h.close();
				}
			});

			it("control: a handle released while its credential request is pending wrote no CONNECT, so nothing drains and a later handle connects at once", async () => {
				const h = await rig({ recovery: true });
				try {
					// Credentialed like `/a`, so both share one Manager.
					const b = h.open("/b", () => Promise.resolve({ auth: {} }));
					b.connection.subscribe(
						member("keep"),
						createRecordingSink<unknown[]>().sink,
						{ key: "keep", repeatable: true },
					);
					await waitFor(() =>
						roomsOf(h.sockets["/b"]?.at(-1)).includes("keep"),
					);
					let grant = () => {};
					const a = h.open(
						"/a",
						() =>
							new Promise((resolve) => {
								grant = () => resolve({ auth: {} });
							}),
					);
					a.connection.subscribe(
						member("mine"),
						createRecordingSink<unknown[]>().sink,
						{ key: "mine", repeatable: true },
					);
					await sleep(200);
					const [upstreamA] = h.peersOf("/a");
					if (!upstreamA) throw new Error("no upstream /a socket");
					expect(upstreamA.io, "one shared Manager").toBe(
						h.peersOf("/b")[0]?.io,
					);
					expect(trace(h.wire, upstreamA, 0), "no CONNECT yet").toEqual([]);
					h.dispose(a.connection);
					grant(); // fenced: the handle is disposed
					const a2 = h.open("/a", () => Promise.resolve({ auth: {} }));
					a2.connection.subscribe(
						member("new"),
						createRecordingSink<unknown[]>().sink,
						{ key: "new", repeatable: true },
					);
					await waitFor(
						() =>
							roomsOf(h.sockets["/a"]?.at(-1)).includes("new") &&
							a2.context.lastStatus()?.state === "connected",
					);
					await sleep(300);
					expect(trace(h.wire, upstreamA, 0)).toEqual([]);
					expect(upstreamA.active).toBe(false);
					expect(h.server.of("/a").sockets.size).toBe(1);
					expect(connected(b.context)).toBe(1);
				} finally {
					await h.close();
				}
			});

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

			/**
			 * An isolated server with `/keep` and `/pending-<n>` namespaces whose
			 * first handshake is held in middleware (`held`) until `release(name)`
			 * or answered at once; later handshakes are answered. Every handle
			 * shares one Manager (same scope and key).
			 */
			async function pendingRig(options: { held: boolean }) {
				const transport = createServer();
				const tcp = new Set<NetSocket>();
				transport.on("connection", (socket) => {
					tcp.add(socket);
					socket.on("close", () => tcp.delete(socket));
				});
				const server = new Server(transport, {
					pingInterval: 100,
					pingTimeout: 1_000,
				});
				const engineIds: string[] = [];
				const closedEngineIds: string[] = [];
				server.engine.on(
					"connection",
					(engine: {
						id: string;
						on(event: "close", fn: () => void): void;
					}) => {
						engineIds.push(engine.id);
						engine.on("close", () => closedEngineIds.push(engine.id));
					},
				);
				const keepSockets: ServerSocket[] = [];
				const joins: string[] = [];
				const commands: string[] = [];
				server.of("/keep").on("connection", (socket) => {
					keepSockets.push(socket);
					socket.on("join", (room: string, ack: (value: unknown) => void) => {
						joins.push(room);
						void socket.join(room);
						ack({ ok: true });
					});
					socket.on("leave", (room: string, ack: (value: unknown) => void) => {
						void socket.leave(room);
						ack({ ok: true });
					});
					socket.on("once", (token: string, ack: (value: unknown) => void) => {
						commands.push(token);
						ack({ token });
					});
				});
				/** The first server socket each pending namespace's middleware saw. */
				const entered = new Map<string, ServerSocket>();
				const held = new Map<string, () => void>();
				for (let n = 0; n < 70; n += 1) {
					const name = `/pending-${n}`;
					server.of(name).use((socket, next) => {
						const first = !entered.has(name);
						if (first) entered.set(name, socket);
						if (options.held && first) held.set(name, () => next());
						else next();
					});
				}
				await new Promise<void>((resolve) =>
					transport.listen(0, "127.0.0.1", resolve),
				);
				const address = transport.address();
				if (!address || typeof address === "string") {
					throw new Error("no loopback port");
				}
				const wire = tapWire();
				const peers = tapPeers();
				const adapter = socketIoAdapter({ routes: { keep: () => ["keep"] } });
				const opened = new Set<AdapterConnection>();
				return {
					server,
					engineIds,
					closedEngineIds,
					keepSockets,
					joins,
					commands,
					entered,
					wire,
					peersOf: (namespace: string) =>
						peers.filter((peer) => nspOf(peer) === namespace),
					/** Answers `name`'s held handshake. */
					release(name: string) {
						const answer = held.get(name);
						held.delete(name);
						answer?.();
					},
					heldCount: () => held.size,
					open(
						namespace: string,
						credentials: () => Credentials | Promise<Credentials> = () => ({}),
					) {
						const context = createTestContext({
							scope: "pending-drains",
							key: "same-manager-group",
							credentials,
						});
						const connection = adapter.connect(
							{
								url: `http://127.0.0.1:${address.port}`,
								namespace,
								sharing: "shared",
								transports: ["websocket" as const],
								reconnectionDelayMs: 100,
								reconnectionDelayMaxMs: 200,
								ackTimeoutMs: 1_000,
							},
							context.ctx,
						);
						opened.add(connection);
						return { connection, context };
					},
					dispose(connection: AdapterConnection) {
						connection.dispose();
						opened.delete(connection);
					},
					async close() {
						for (const connection of opened) connection.dispose();
						for (const answer of held.values()) answer();
						held.clear();
						server.disconnectSockets(true);
						for (const socket of tcp) socket.destroy();
						await new Promise<void>((resolve) => server.close(() => resolve()));
					},
				};
			}

			/** `/keep`, joined and connected, with its notices by phase. */
			async function keepAlive(h: Awaited<ReturnType<typeof pendingRig>>) {
				const keep = h.open("/keep");
				const sink = createRecordingSink<unknown[]>();
				const notices: Array<{
					reason: string;
					status: string | undefined;
					connected: number;
				}> = [];
				keep.connection.subscribe(
					{
						event: "pulse",
						membership: "keep",
						route: "keep",
						join: { event: "join", args: ["keep"] },
						leave: { event: "leave", args: ["keep"] },
					},
					{
						...sink.sink,
						continuity(reason, detail) {
							notices.push({
								reason,
								status: keep.context.lastStatus()?.state,
								connected: connected(keep.context),
							});
							sink.sink.continuity(reason, detail);
						},
					},
					{ key: "keep", repeatable: true },
				);
				await waitFor(
					() =>
						h.keepSockets.at(-1)?.rooms.has("keep") &&
						keep.context.lastStatus()?.state === "connected",
				);
				const [upstream] = h.peersOf("/keep");
				if (!upstream) throw new Error("no upstream /keep socket");
				return { ...keep, sink, notices, manager: upstream.io };
			}

			/** Report a forced-close loss at detection and its outcome before connected. */
			function expectPhases(
				notices: Array<{
					reason: string;
					status: string | undefined;
					connected: number;
				}>,
				connectsBefore: number,
			) {
				if (notices.length === 0) return;
				expect(notices).toEqual([
					{
						reason: "reconnected",
						status: "connected",
						connected: connectsBefore,
					},
					{
						reason: "reconnected",
						status: "reconnecting",
						connected: connectsBefore,
					},
				]);
			}

			// Destroy the released socket's subscriptions so a pending handshake cannot keep buffering events.
			for (const held of [true, false]) {
				it(`${
					held
						? "a released handle whose handshake is held"
						: "control: a released handle whose handshake was confirmed"
				} keeps none of the server's late events: the Manager decodes all 32, the released socket buffers none, the disposed consumer receives none and the sibling stays on its Engine${
					held
						? "; the late reply is then answered by one DISCONNECT and still nothing is delivered"
						: ""
				}`, async () => {
					const h = await pendingRig({ held });
					try {
						const keep = await keepAlive(h);
						const a = h.open("/pending-0");
						const discarded = createRecordingSink<unknown[]>();
						a.connection.subscribe({ event: "discarded" }, discarded.sink, {
							key: "discarded",
							repeatable: true,
						});
						await waitFor(() => h.entered.has("/pending-0"));
						if (!held) {
							await waitFor(
								() => a.context.lastStatus()?.state === "connected",
							);
						}
						const [upstream] = h.peersOf("/pending-0");
						if (!upstream) throw new Error("no upstream /pending-0 socket");
						const { manager } = keep;
						const engine = manager.engine;
						let decoded = 0;
						manager.on("packet", (packet) => {
							if (packet.nsp === "/pending-0" && packet.type === 2)
								decoded += 1;
						});
						tapManager(h.wire, manager, "/pending-0");
						const mark = h.wire.length;
						h.dispose(a.connection);
						if (!held) {
							await waitFor(() => h.server.of("/pending-0").sockets.size === 0);
						}
						expect(drainsOf(keep.connection)).toEqual({
							drains: held ? 1 : 0,
							waiters: 0,
						});
						// The server's own Socket.emit on the socket it created.
						const payload = "x".repeat(65_536);
						const pendingServer = h.entered.get("/pending-0");
						for (let index = 0; index < 32; index += 1) {
							pendingServer?.emit("discarded", { index, payload });
						}
						await waitFor(() => decoded === 32);
						h.keepSockets.at(-1)?.emit("pulse", { marker: "after-burst" });
						await waitFor(() => keep.sink.events.length === 1);
						expect(
							upstream.receiveBuffer,
							"no late event kept for the released handle",
						).toHaveLength(0);
						expect(discarded.events).toEqual([]);
						expect(manager.engine, "the sibling stays on its Engine").toBe(
							engine,
						);
						expect(h.keepSockets.at(-1)?.connected).toBe(true);
						if (held) {
							expect(upstream.active, "unsubscribed at release").toBe(false);
							h.release("/pending-0");
							await waitFor(
								() =>
									drainsOf(keep.connection).drains === 0 &&
									h.server.of("/pending-0").sockets.size === 0,
								{ message: "the late reply was answered by a DISCONNECT" },
							);
							await sleep(200);
							expect(
								drainTrace(h.wire, manager, upstream, mark).filter(
									(entry) => !entry.endsWith(":2"),
								),
								"the reply, decoded by the Manager, then one DISCONNECT",
							).toEqual([`M:in:${CONNECT}`, `A:out:${DISCONNECT}`]);
							expect(upstream.receiveBuffer).toHaveLength(0);
							expect(discarded.events).toEqual([]);
						}
						expect(keep.notices, "the sibling was never interrupted").toEqual(
							[],
						);
					} finally {
						await h.close();
					}
				});
			}

			// Release must unregister drain waiters instead of retaining them until the handshake settles.
			it("handles released while they wait behind one drain unregister at once: their providers are never called and nothing is written for them; the late reply is answered by one DISCONNECT, then only the live waiter connects and nothing reaches a released handle", async () => {
				const h = await pendingRig({ held: true });
				try {
					const keep = await keepAlive(h);
					const { manager } = keep;
					tapManager(h.wire, manager, "/pending-0");
					const baseline = manager.listeners("packet").length;
					const original = h.open("/pending-0");
					const originalSink = createRecordingSink<unknown[]>();
					original.connection.subscribe({ event: "pulse" }, originalSink.sink, {
						key: "original",
						repeatable: true,
					});
					await waitFor(() => h.entered.has("/pending-0"));
					const [upstream] = h.peersOf("/pending-0");
					if (!upstream) throw new Error("no upstream /pending-0 socket");
					const mark = h.wire.length;
					h.dispose(original.connection);
					expect(drainsOf(keep.connection)).toEqual({ drains: 1, waiters: 0 });
					expect(
						manager.listeners("packet").length,
						"one handshake observer for the drain",
					).toBe(baseline + 1);
					/** Provider calls per waiter. */
					const asked: Record<string, number> = {};
					const provider = (waiter: string) => () => {
						asked[waiter] = (asked[waiter] ?? 0) + 1;
						return { auth: { waiter } };
					};
					const cancelledSinks: Array<ReturnType<typeof createRecordingSink>> =
						[];
					for (let n = 0; n < 4; n += 1) {
						const waiter = h.open("/pending-0", provider(`cancelled-${n}`));
						const sink = createRecordingSink<unknown[]>();
						cancelledSinks.push(sink);
						waiter.connection.subscribe({ event: "pulse" }, sink.sink, {
							key: `waiter-${n}`,
							repeatable: true,
						});
						expect(drainsOf(keep.connection), `waiter ${n} registered`).toEqual(
							{
								drains: 1,
								waiters: 1,
							},
						);
						h.dispose(waiter.connection);
						expect(
							drainsOf(keep.connection),
							`waiter ${n} unregistered at its release`,
						).toEqual({ drains: 1, waiters: 0 });
					}
					const live = h.open("/pending-0", provider("live"));
					const liveSink = createRecordingSink<unknown[]>();
					live.connection.subscribe({ event: "pulse" }, liveSink.sink, {
						key: "live",
						repeatable: true,
					});
					expect(drainsOf(keep.connection)).toEqual({ drains: 1, waiters: 1 });
					await sleep(200);
					expect(
						asked,
						"no provider called while the DISCONNECT is owed",
					).toEqual({});
					const connectsBefore = connected(keep.context);
					const waiters = h.peersOf("/pending-0").slice(1);
					expect(waiters).toHaveLength(5);
					expect(
						waiters.every((peer) => !peer.active),
						"no waiter subscribed",
					).toBe(true);
					h.release("/pending-0");
					await waitFor(
						() =>
							live.context.lastStatus()?.state === "connected" &&
							h.server.of("/pending-0").sockets.size === 1,
					);
					await sleep(200);
					expect(
						drainTrace(h.wire, manager, upstream, mark).slice(0, 2),
					).toEqual([`M:in:${CONNECT}`, `A:out:${DISCONNECT}`]);
					// Only the live waiter's provider is asked: once, or again if its
					// CONNECT and the drained DISCONNECT cost one forced close.
					expect(Object.keys(asked), "only the live waiter's provider").toEqual(
						["live"],
					);
					for (const cancelled of waiters.slice(0, 4)) {
						expect(trace(h.wire, cancelled, 0), "nothing written").toEqual([]);
					}
					expect(drainsOf(keep.connection)).toEqual({ drains: 0, waiters: 0 });
					h.server.of("/pending-0").emit("pulse", { seq: 1 });
					await waitFor(() => liveSink.events.length === 1);
					await sleep(100);
					expect(originalSink.events).toEqual([]);
					expect(cancelledSinks.map((sink) => sink.events.length)).toEqual([
						0, 0, 0, 0,
					]);
					expect(
						manager.listeners("packet").length,
						"no drain observer: the live waiter's own and its subscription",
					).toBe(baseline + 2);
					expectPhases(keep.notices, connectsBefore);
				} finally {
					await h.close();
				}
			});

			// Overflowing the drain bound restarts the engine and releases every namespace, including unanswered handshakes.
			for (const held of [true, false]) {
				it(`${
					held
						? "65 released handles whose handshakes are held"
						: "control: 65 released handles whose handshakes were answered"
				}: retained drains never exceed 64${
					held
						? "; the 65th restarts the whole client once on a new Engine, the sibling recovers with the loss at detection and the outcome before its restored `connected`, rejoins once, replays no command, and late replies after it leave no namespace behind"
						: "; nothing is retained, the Engine is kept and nothing is reported"
				}`, async () => {
					const CYCLES = 65;
					const h = await pendingRig({ held });
					try {
						const keep = await keepAlive(h);
						const { manager } = keep;
						const keepServer = () => h.keepSockets.at(-1);
						const engineBefore = h.engineIds.at(-1);
						const connectsBefore = connected(keep.context);
						const baseline = manager.listeners("packet").length;
						const command = await keep.connection.command?.(
							{ event: "once", args: ["one-off"], ack: true },
							{
								id: "one-off",
								signal: keep.context.ctx.signal,
								timeoutMs: 1_000,
							},
						);
						expect(command?.status).toBe("acknowledged");
						const disposedSinks: Array<ReturnType<typeof createRecordingSink>> =
							[];
						const observed: Array<{ drains: number; listeners: number }> = [];
						for (let cycle = 0; cycle < CYCLES; cycle += 1) {
							const namespace = `/pending-${cycle}`;
							const handle = h.open(namespace);
							const sink = createRecordingSink<unknown[]>();
							disposedSinks.push(sink);
							handle.connection.subscribe({ event: "pulse" }, sink.sink, {
								key: namespace,
								repeatable: true,
							});
							await waitFor(() => h.entered.has(namespace));
							if (!held) {
								await waitFor(
									() => handle.context.lastStatus()?.state === "connected",
								);
							}
							h.dispose(handle.connection);
							if (!held) {
								await waitFor(() => h.server.of(namespace).sockets.size === 0);
							}
							if (held && cycle === CYCLES - 1) {
								await waitFor(
									() =>
										h.engineIds.length === 2 &&
										keepServer()?.rooms.has("keep") &&
										keep.context.lastStatus()?.state === "connected",
									{ message: "the whole-client restart recovered" },
								);
							}
							keepServer()?.emit("pulse", { cycle });
							await waitFor(() => keep.sink.events.length === cycle + 1);
							observed.push({
								drains: drainsOf(keep.connection).drains,
								listeners: manager.listeners("packet").length,
							});
						}
						// Middleware that answers only now: the old Engine is closed.
						for (let cycle = 0; cycle < CYCLES; cycle += 1) {
							h.release(`/pending-${cycle}`);
						}
						await sleep(200);
						expect(
							observed.every((entry) => entry.drains <= 64),
							"retained drains never exceed 64",
						).toBe(true);
						expect(
							observed.every((entry) => entry.listeners <= baseline + 64),
						).toBe(true);
						expect(observed.at(-1)?.drains).toBe(0);
						expect(manager.listeners("packet").length).toBe(baseline);
						expect(
							[...h.entered.keys()].filter(
								(name) => h.server.of(name).sockets.size !== 0,
							),
							"no namespace of a released handle left on the server",
						).toEqual([]);
						expect(
							h.peersOf("/keep").length,
							"one /keep socket throughout",
						).toBe(1);
						const released = [...h.entered.keys()].flatMap((name) =>
							h.peersOf(name),
						);
						expect(released).toHaveLength(CYCLES);
						expect(released.every((peer) => !peer.active)).toBe(true);
						expect(
							released.every(
								(peer) =>
									peer.sendBuffer.length === 0 &&
									peer.receiveBuffer.length === 0,
							),
						).toBe(true);
						expect(
							disposedSinks.reduce((sum, sink) => sum + sink.events.length, 0),
						).toBe(0);
						expect(keep.sink.events).toHaveLength(CYCLES);
						expect(h.commands, "the one-off command ran once").toEqual([
							"one-off",
						]);
						if (held) {
							expect(h.engineIds, "one restart, on a new Engine").toHaveLength(
								2,
							);
							expect(h.closedEngineIds).toEqual([engineBefore]);
							expect(
								[...h.entered.values()].every(
									(socket) => socket.conn.readyState === "closed",
								),
								"every held handshake belonged to the closed Engine",
							).toBe(true);
							expect(h.keepSockets, "/keep reconnected once").toHaveLength(2);
							expect(h.joins, "rejoined once").toEqual(["keep", "keep"]);
							expect(connected(keep.context)).toBe(connectsBefore + 1);
							expect(keep.notices).toEqual([
								{
									reason: "reconnected",
									status: "connected",
									connected: connectsBefore,
								},
								{
									reason: "reconnected",
									status: "reconnecting",
									connected: connectsBefore,
								},
							]);
							expect(
								keep.context.diagnostics
									.filter(
										(diagnostic) =>
											diagnostic.type === "membership-cleanup-uncertain",
									)
									.map((diagnostic) => diagnostic.detail),
							).toEqual([{ reason: "drain-overflow" }]);
						} else {
							expect(h.engineIds).toEqual([engineBefore]);
							expect(h.closedEngineIds).toEqual([]);
							expect(h.keepSockets).toHaveLength(1);
							expect(h.joins).toEqual(["keep"]);
							expect(connected(keep.context)).toBe(connectsBefore);
							expect(keep.notices).toEqual([]);
						}
					} finally {
						await h.close();
					}
				});
			}

			// The successor CONNECT follows the drained DISCONNECT without waiting for a heartbeat.
			for (const heartbeat of ["server default", "100 ms control"] as const) {
				it(`a successor opened during a drain connects once the drained DISCONNECT is written, without waiting for a heartbeat (${heartbeat})`, async () => {
					const transport = createServer();
					const tcp = new Set<NetSocket>();
					transport.on("connection", (socket) => {
						tcp.add(socket);
						socket.on("close", () => tcp.delete(socket));
					});
					const server = new Server(
						transport,
						heartbeat === "server default"
							? {}
							: { pingInterval: 100, pingTimeout: 1_000 },
					);
					let release: (() => void) | undefined;
					server.of("/a").use((_socket, next) => {
						if (release === undefined) release = () => next();
						else next();
					});
					const serverA: ServerSocket[] = [];
					server.of("/a").on("connection", (socket) => {
						serverA.push(socket);
					});
					server.of("/b");
					await new Promise<void>((resolve) =>
						transport.listen(0, "127.0.0.1", resolve),
					);
					const address = transport.address();
					if (!address || typeof address === "string") {
						throw new Error("no loopback port");
					}
					const adapter = socketIoAdapter();
					const spec = {
						url: `http://127.0.0.1:${address.port}`,
						anonymous: true,
						sharing: "shared" as const,
						transports: ["websocket" as const],
						reconnectionDelayMs: 50,
						reconnectionDelayMaxMs: 100,
					};
					const b = createTestContext({ credentials: () => ({}) });
					const a2 = createTestContext({ credentials: () => ({}) });
					const opened: AdapterConnection[] = [];
					const open = (namespace: string, context: TestContext) => {
						const connection = adapter.connect(
							{ ...spec, namespace },
							context.ctx,
						);
						opened.push(connection);
						connection.subscribe(
							{ event: "pulse" },
							createRecordingSink<unknown[]>().sink,
							{ key: namespace, repeatable: true },
						);
						return connection;
					};
					try {
						open("/b", b);
						await waitFor(() => b.lastStatus()?.state === "connected");
						const old = open(
							"/a",
							createTestContext({ credentials: () => ({}) }),
						);
						await waitFor(() => release !== undefined);
						old.dispose();
						open("/a", a2);
						release?.();
						await waitFor(() => serverA.length >= 1 && !serverA[0]?.connected, {
							message: "the drained server socket is gone",
						});
						const removedAt = Date.now();
						await waitFor(() => a2.lastStatus()?.state === "connected", {
							timeout: 3_000,
							message: "the successor is held after the drain",
						});
						expect(Date.now() - removedAt).toBeLessThan(3_000);
						expect(serverA).toHaveLength(2);
					} finally {
						for (const connection of opened) connection.dispose();
						release?.();
						server.disconnectSockets(true);
						for (const socket of tcp) socket.destroy();
						await new Promise<void>((resolve) => server.close(() => resolve()));
					}
				});
			}

			// Delay client-to-server traffic so the successor can buffer the released session's events before its own CONNECT reply. A fresh session must discard them.
			for (const delayMs of [60, 0]) {
				for (const recovery of [false, true]) {
					it(`a successor opened during a drain never receives the drained session's events (${
						delayMs ? `${delayMs} ms client-to-server latency` : "loopback"
					}, recovery ${recovery ? "on" : "off"}; VG7-S1)`, async () => {
						const REPS = delayMs ? 8 : 5;
						const results: Array<Record<string, unknown>> = [];
						const peers = tapPeers();
						for (let rep = 0; rep < REPS; rep += 1) {
							const transport = createServer();
							const tcp = new Set<NetSocket>();
							transport.on("connection", (socket) => {
								tcp.add(socket);
								socket.on("close", () => tcp.delete(socket));
							});
							const server = new Server(transport, {
								pingInterval: 400,
								pingTimeout: 300,
								...(recovery
									? {
											connectionStateRecovery: {
												maxDisconnectionDuration: 90_000,
											},
										}
									: {}),
							});
							let gate: (() => void) | undefined;
							server.of("/a").use((_socket, next) => {
								if (gate === undefined) gate = () => next();
								else next();
							});
							let aliceEmitted = 0;
							server.of("/a").on("connection", (socket) => {
								const user = String(
									(socket.handshake.auth as { user?: unknown }).user ?? "",
								);
								if (user !== "alice") return;
								let turns = 0;
								// Every loop turn on loopback, every 2 ms through the proxy
								// (as the verifier's two probes).
								const next = () =>
									delayMs ? setTimeout(tick, 2) : setImmediate(tick);
								const tick = () => {
									if (!socket.connected || turns >= 400) return;
									turns += 1;
									aliceEmitted += 1;
									socket.emit("notice", { to: "alice", seq: aliceEmitted });
									next();
								};
								next();
							});
							const bSockets: ServerSocket[] = [];
							server.of("/b").on("connection", (socket) => {
								bSockets.push(socket);
							});
							await new Promise<void>((resolve) =>
								transport.listen(0, "127.0.0.1", resolve),
							);
							const address = transport.address();
							if (!address || typeof address === "string") {
								throw new Error("no loopback port");
							}
							const piped = new Set<NetSocket>();
							const proxy = createNetServer((client) => {
								const upstream = netConnect(address.port, "127.0.0.1");
								piped.add(client);
								piped.add(upstream);
								client.on("data", (chunk) => {
									setTimeout(() => {
										if (!upstream.destroyed) upstream.write(chunk);
									}, delayMs);
								});
								upstream.on("data", (chunk) => {
									if (!client.destroyed) client.write(chunk);
								});
								const end = () => {
									setTimeout(() => {
										client.destroy();
										upstream.destroy();
									}, delayMs + 5);
								};
								client.on("close", end);
								upstream.on("close", end);
								client.on("error", end);
								upstream.on("error", end);
							});
							await new Promise<void>((resolve) =>
								proxy.listen(0, "127.0.0.1", resolve),
							);
							const proxyAddress = proxy.address();
							if (!proxyAddress || typeof proxyAddress === "string") {
								throw new Error("no proxy port");
							}
							const adapter = socketIoAdapter();
							const base = {
								url: `http://127.0.0.1:${delayMs ? proxyAddress.port : address.port}`,
								sharing: "shared" as const,
								transports: ["websocket" as const],
								reconnectionDelayMs: 300,
								reconnectionDelayMaxMs: 600,
								ackTimeoutMs: 1_000,
							};
							const contextB = createTestContext({
								credentials: () => ({ auth: {} }),
							});
							const contextA = createTestContext({
								credentials: () => ({ auth: { user: "alice" } }),
							});
							const contextA2 = createTestContext({
								credentials: () => ({ auth: { user: "bob" } }),
							});
							const opened: AdapterConnection[] = [];
							const open = (namespace: string, context: TestContext) => {
								const connection = adapter.connect(
									{ ...base, namespace },
									context.ctx,
								);
								opened.push(connection);
								return connection;
							};
							try {
								const handleB = open("/b", contextB);
								handleB.subscribe(
									{ event: "pulse" },
									createRecordingSink<unknown[]>().sink,
									{ key: "pulse", repeatable: true },
								);
								await waitFor(
									() => contextB.lastStatus()?.state === "connected",
								);
								const handleA = open("/a", contextA);
								handleA.subscribe(
									{ event: "notice" },
									createRecordingSink<unknown[]>().sink,
									{ key: "notice", repeatable: true },
								);
								await waitFor(() => gate !== undefined, {
									message: "the alice CONNECT never reached the server",
								});
								handleA.dispose();
								const handleA2 = open("/a", contextA2);
								const sinkA2 = createRecordingSink<unknown[]>();
								handleA2.subscribe({ event: "notice" }, sinkA2.sink, {
									key: "notice",
									repeatable: true,
								});
								gate?.();
								await waitFor(
									() => contextA2.lastStatus()?.state === "connected",
									{ timeout: 10_000, message: "the successor never connected" },
								);
								await sleep(delayMs ? 600 : 300);
								const managers = new Set(
									peers.slice(-3).map((peer) => peer.io),
								);
								peers.length = 0;
								results.push({
									rep,
									sharedManager: managers.size === 1,
									aliceEmitted,
									successorGotAlice: sinkA2.events.filter((args) =>
										JSON.stringify(args).includes('"alice"'),
									).length,
									successorEvents: sinkA2.events.length,
									serverASockets: server.of("/a").sockets.size,
									bServerSockets: bSockets.length,
								});
							} finally {
								for (const connection of opened) connection.dispose();
								server.disconnectSockets(true);
								for (const socket of tcp) socket.destroy();
								for (const socket of piped) socket.destroy();
								await new Promise<void>((resolve) =>
									server.close(() => resolve()),
								);
								await new Promise<void>((resolve) =>
									proxy.close(() => resolve()),
								);
							}
						}
						expect(
							results.map((result) => result.sharedManager),
							"precondition: /a, its successor and /b share one Manager",
						).toEqual(results.map(() => true));
						expect(
							results.filter((result) => (result.aliceEmitted as number) > 0),
							"precondition: the drained session emitted",
						).toHaveLength(REPS);
						expect(
							results
								.filter((result) => (result.successorGotAlice as number) > 0)
								.map((result) => result.rep),
							`the successor's consumer never receives the drained session's events: ${JSON.stringify(results)}`,
						).toEqual([]);
					});
				}
			}
		});

		// Releasing an inactive namespace socket must evict it from the shared Manager cache.
		describe("a released namespace handle leaves the Manager's namespace cache", () => {
			/** The Manager's namespace cache (private in its typings). */
			const cacheOf = (manager: Manager) =>
				Object.keys(
					(manager as unknown as { nsps: Record<string, Socket> }).nsps,
				).sort();

			/** `/keep` plus static `/fixed` and dynamic `/dynamic-<n>` namespaces. */
			async function lifetime() {
				const transport = createServer();
				const tcp = new Set<NetSocket>();
				transport.on("connection", (socket) => {
					tcp.add(socket);
					socket.on("close", () => tcp.delete(socket));
				});
				const server = new Server(transport, {
					cleanupEmptyChildNamespaces: true,
				});
				const keepSockets: ServerSocket[] = [];
				server.of("/keep").on("connection", (socket) => {
					keepSockets.push(socket);
				});
				server.of("/fixed");
				server.of(/^\/dynamic-\d+$/);
				await new Promise<void>((resolve) =>
					transport.listen(0, "127.0.0.1", resolve),
				);
				const address = transport.address();
				if (!address || typeof address === "string") {
					throw new Error("no loopback port");
				}
				const managers: Manager[] = [];
				const peers: Socket[] = [];
				const proto = Manager.prototype as unknown as {
					socket: (this: Manager, ...args: unknown[]) => Socket;
				};
				const original = proto.socket;
				proto.socket = function (this: Manager, ...args: unknown[]) {
					if (!managers.includes(this)) managers.push(this);
					const socket = original.apply(this, args);
					peers.push(socket);
					return socket;
				};
				restores.push(() => {
					proto.socket = original;
				});
				const adapter = socketIoAdapter();
				const opened = new Set<AdapterConnection>();
				return {
					server,
					keepSockets,
					managers,
					peers,
					/** A handle in the one Manager group (same scope and key). */
					open(namespace: string) {
						const context = createTestContext({
							scope: "namespace-lifetime",
							key: "same-manager-group",
							credentials: () => ({ auth: {} }),
						});
						const connection = adapter.connect(
							{
								url: `http://127.0.0.1:${address.port}`,
								namespace,
								sharing: "shared",
								transports: ["websocket" as const],
							},
							context.ctx,
						);
						opened.add(connection);
						const sink = createRecordingSink<unknown[]>();
						connection.subscribe({ event: "pulse" }, sink.sink, {
							key: namespace,
							repeatable: true,
						});
						return { connection, context, sink };
					},
					dispose(connection: AdapterConnection) {
						connection.dispose();
						opened.delete(connection);
					},
					async close() {
						for (const connection of opened) connection.dispose();
						server.disconnectSockets(true);
						for (const socket of tcp) socket.destroy();
						await new Promise<void>((resolve) => server.close(() => resolve()));
					},
				};
			}

			for (const distinct of [true, false]) {
				it(`${
					distinct
						? "24 distinct namespaces visited while `/keep` stays connected"
						: "control: one namespace replaced 24 times while `/keep` stays connected"
				}: after each release the Manager caches exactly the namespaces with live handles, each temporary server namespace has no socket, and \`/keep\` receives every pulse on one Manager and one Engine without a reconnect`, async () => {
					const CYCLES = 24;
					const rig = await lifetime();
					try {
						const keep = rig.open("/keep");
						await waitFor(
							() =>
								rig.keepSockets.at(-1)?.connected &&
								keep.context.lastStatus()?.state === "connected",
						);
						const [manager] = rig.managers;
						if (!manager) throw new Error("no Manager");
						const engineId = manager.engine.id;
						const temporaries: Socket[] = [];
						for (let cycle = 0; cycle < CYCLES; cycle += 1) {
							const namespace = distinct ? `/dynamic-${cycle}` : "/fixed";
							const temporary = rig.open(namespace);
							await waitFor(
								() => temporary.context.lastStatus()?.state === "connected",
							);
							const upstream = rig.peers.at(-1) as Socket;
							expect(
								temporaries.includes(upstream),
								`cycle ${cycle}: a socket of its own`,
							).toBe(false);
							temporaries.push(upstream);
							expect(cacheOf(manager), `cycle ${cycle}: live`).toEqual(
								[namespace, "/keep"].sort(),
							);
							rig.dispose(temporary.connection);
							expect(
								cacheOf(manager),
								`cycle ${cycle}: only the namespaces with live handles`,
							).toEqual(["/keep"]);
							await waitFor(() => rig.server.of(namespace).sockets.size === 0, {
								message: `cycle ${cycle}: ${namespace} has no socket`,
							});
							rig.keepSockets.at(-1)?.emit("pulse", { cycle });
							await waitFor(() => keep.sink.events.length === cycle + 1);
							expect(manager.engine.id, `cycle ${cycle}: one Engine`).toBe(
								engineId,
							);
						}
						expect(rig.managers, "one Manager").toHaveLength(1);
						expect(
							keep.sink.events.map((args) => args[0]),
							"`/keep` received every pulse",
						).toEqual(
							Array.from({ length: CYCLES }, (_, cycle) => ({ cycle })),
						);
						expect(rig.keepSockets, "`/keep` never reconnected").toHaveLength(
							1,
						);
						expect(rig.keepSockets[0]?.connected).toBe(true);
						expect(
							keep.context.statuses.filter(
								(status) => status.state === "connected",
							),
						).toHaveLength(1);
						// The released sockets hold nothing of their handles.
						for (const socket of temporaries) {
							expect(socket.active).toBe(false);
							expect(socket.sendBuffer).toHaveLength(0);
							expect(typeof socket.auth).not.toBe("function");
						}
					} finally {
						await rig.close();
					}
				});
			}

			it("the last handle's release still closes the Manager and its Engine, and leaves the cache empty", async () => {
				const rig = await lifetime();
				try {
					const keep = rig.open("/keep");
					const temporary = rig.open("/dynamic-0");
					await waitFor(
						() =>
							keep.context.lastStatus()?.state === "connected" &&
							temporary.context.lastStatus()?.state === "connected",
					);
					const [manager] = rig.managers;
					if (!manager) throw new Error("no Manager");
					const internals = manager as Manager & { _readyState: string };
					const engine = manager.engine;
					rig.dispose(temporary.connection);
					expect(cacheOf(manager)).toEqual(["/keep"]);
					expect(internals._readyState, "a sibling keeps it open").toBe("open");
					rig.dispose(keep.connection);
					expect(internals._readyState, "the Manager closed").toBe("closed");
					expect(engine.readyState, "its Engine closes").not.toBe("open");
					await waitFor(() => engine.readyState === "closed", {
						message: "its Engine closed",
					});
					expect(cacheOf(manager), "nothing cached").toEqual([]);
					await waitFor(() => rig.server.engine.clientsCount === 0);
					// A new handle starts a new Manager; the released one is not reused.
					const next = rig.open("/keep");
					await waitFor(() => next.context.lastStatus()?.state === "connected");
					expect(rig.managers).toHaveLength(2);
					expect(rig.managers[1]).not.toBe(manager);
				} finally {
					await rig.close();
				}
			});
		});

		// Allow the server to force-close an immediately reused namespace; assert cleanup, fresh replacement and sibling recovery.
		describe("a confirmed release then an immediate same-namespace reopen on a shared Engine", () => {
			const nspOf = (peer: Socket) => (peer as unknown as { nsp: string }).nsp;
			for (const transportKind of ["websocket", "polling"] as const) {
				for (const timing of ["immediate", "server-release control"] as const) {
					it(`the released namespace leaves nothing behind, the replacement connects fresh and the sibling keeps its Engine or recovers by phase (${transportKind}, ${timing})`, async () => {
						const transport = createServer();
						const tcp = new Set<NetSocket>();
						transport.on("connection", (socket) => {
							tcp.add(socket);
							socket.on("close", () => tcp.delete(socket));
						});
						const server = new Server(transport, {
							pingInterval: 1_000,
							pingTimeout: 1_000,
						});
						const serverSockets: Record<string, ServerSocket[]> = {
							"/a": [],
							"/b": [],
						};
						const engineCloses: string[] = [];
						const joins: Array<{ namespace: string; room: string }> = [];
						const oneOff: Array<{ namespace: string; token: string }> = [];
						server.engine.on(
							"connection",
							(engine: {
								on(event: "close", fn: (reason: string) => void): void;
							}) => {
								engine.on("close", (reason) => engineCloses.push(reason));
							},
						);
						for (const namespace of ["/a", "/b"]) {
							server.of(namespace).on("connection", (socket) => {
								serverSockets[namespace]?.push(socket);
								socket.on(
									"join",
									(room: string, ack: (value: unknown) => void) => {
										joins.push({ namespace, room });
										void socket.join(room);
										ack({ ok: true });
									},
								);
								socket.on(
									"once",
									(token: string, ack: (value: unknown) => void) => {
										oneOff.push({ namespace, token });
										ack({ token });
									},
								);
								socket.on(
									"leave",
									(room: string, ack: (value: unknown) => void) => {
										void socket.leave(room);
										ack({ ok: true });
									},
								);
							});
						}
						await new Promise<void>((resolve) =>
							transport.listen(0, "127.0.0.1", resolve),
						);
						const address = transport.address();
						if (!address || typeof address === "string") {
							throw new Error("no loopback port");
						}
						const peers = tapPeers();
						const adapter = socketIoAdapter({
							routes: {
								byRoom: (args) => [String((args[0] as { room: string }).room)],
							},
						});
						const connection = {
							url: `http://127.0.0.1:${address.port}`,
							sharing: "shared" as const,
							anonymous: true,
							transports: [transportKind],
							upgrade: false,
							reconnectionDelayMs: 100,
							reconnectionDelayMaxMs: 200,
							ackTimeoutMs: 1_000,
						};
						const member = (room: string): SocketIoSubscriptionSpec => ({
							event: "room",
							membership: room,
							route: "byRoom",
							join: { event: "join", args: [room] },
							leave: { event: "leave", args: [room] },
						});
						const a = createTestContext({ credentials: () => ({}) });
						const b = createTestContext({ credentials: () => ({}) });
						const a2 = createTestContext({ credentials: () => ({}) });
						const handleA = adapter.connect(
							{ ...connection, namespace: "/a" },
							a.ctx,
						);
						const handleB = adapter.connect(
							{ ...connection, namespace: "/b" },
							b.ctx,
						);
						let replacement: AdapterConnection | undefined;
						const roomsOf = (socket: ServerSocket | undefined) =>
							socket
								? [...socket.rooms].filter((room) => room !== socket.id).sort()
								: [];
						const connects = (context: TestContext) =>
							context.statuses.filter((status) => status.state === "connected")
								.length;
						try {
							const keep = createRecordingSink<unknown[]>();
							const old = createRecordingSink<unknown[]>();
							const notices: Array<{
								reason: string;
								status: string | undefined;
								connected: number;
							}> = [];
							handleA.subscribe(member("old"), old.sink, {
								key: "old",
								repeatable: true,
							});
							handleB.subscribe(
								member("keep"),
								{
									...keep.sink,
									continuity(reason, detail) {
										notices.push({
											reason,
											status: b.lastStatus()?.state,
											connected: connects(b),
										});
										keep.sink.continuity(reason, detail);
									},
								},
								{ key: "keep", repeatable: true },
							);
							await waitFor(
								() =>
									roomsOf(serverSockets["/a"]?.at(-1)).includes("old") &&
									roomsOf(serverSockets["/b"]?.at(-1)).includes("keep"),
							);
							const upstreamB = peers.find((peer) => nspOf(peer) === "/b");
							const releasedServer = serverSockets["/a"]?.at(-1);
							if (!upstreamB || !releasedServer) {
								throw new Error("no confirmed /a or sibling /b");
							}
							const command = await handleB.command?.(
								{ event: "once", args: ["one-off"], ack: true },
								{ id: "one-off", signal: b.ctx.signal, timeoutMs: 1_000 },
							);
							expect(command?.status).toBe("acknowledged");
							const engineBefore = upstreamB.io.engine;
							const bConnectsBefore = connects(b);
							handleA.dispose();
							if (timing === "server-release control") {
								await waitFor(() => server.of("/a").sockets.size === 0);
							}
							// The immediate leg has no await between release and reopen.
							replacement = adapter.connect(
								{ ...connection, namespace: "/a" },
								a2.ctx,
							);
							const fresh = createRecordingSink<unknown[]>();
							replacement.subscribe(member("new"), fresh.sink, {
								key: "new",
								repeatable: true,
							});
							await waitFor(
								() =>
									a2.lastStatus()?.state === "connected" &&
									b.lastStatus()?.state === "connected" &&
									roomsOf(serverSockets["/a"]?.at(-1)).includes("new") &&
									roomsOf(serverSockets["/b"]?.at(-1)).includes("keep"),
							);
							server.of("/a").to("new").emit("room", { room: "new", seq: 1 });
							server.of("/b").to("keep").emit("room", { room: "keep", seq: 1 });
							await waitFor(
								() => fresh.events.length === 1 && keep.events.length === 1,
							);
							await sleep(50);
							expect(peers.every((peer) => peer.io === upstreamB.io)).toBe(
								true,
							);
							expect(
								server.of("/a").sockets.has(releasedServer.id),
								"the released server socket is gone",
							).toBe(false);
							expect(roomsOf(releasedServer)).toEqual([]);
							expect(
								old.events,
								"nothing reaches the disposed consumer",
							).toEqual([]);
							expect(
								fresh.continuity,
								"the replacement's first connect reports no continuity",
							).toEqual([]);
							expect(roomsOf(serverSockets["/a"]?.at(-1))).toEqual(["new"]);
							expect(roomsOf(serverSockets["/b"]?.at(-1))).toEqual(["keep"]);
							expect(oneOff, "the one-off command ran once").toEqual([
								{ namespace: "/b", token: "one-off" },
							]);
							expect(joins.filter((join) => join.namespace === "/a")).toEqual([
								{ namespace: "/a", room: "old" },
								{ namespace: "/a", room: "new" },
							]);
							if (
								timing === "server-release control" ||
								upstreamB.io.engine === engineBefore
							) {
								expect(upstreamB.io.engine).toBe(engineBefore);
								expect(engineCloses).toEqual([]);
								expect(connects(b)).toBe(bConnectsBefore);
								expect(notices).toEqual([]);
								expect(joins.filter((join) => join.namespace === "/b")).toEqual(
									[{ namespace: "/b", room: "keep" }],
								);
							} else {
								expect(engineCloses).toEqual(["forced close"]);
								expect(connects(b)).toBe(bConnectsBefore + 1);
								// Point 48: one detection notice, one restoration outcome,
								// each before its corresponding new status.
								expect(notices).toEqual([
									{
										reason: "reconnected",
										status: "connected",
										connected: bConnectsBefore,
									},
									{
										reason: "reconnected",
										status: "reconnecting",
										connected: bConnectsBefore,
									},
								]);
								expect(joins.filter((join) => join.namespace === "/b")).toEqual(
									[
										{ namespace: "/b", room: "keep" },
										{ namespace: "/b", room: "keep" },
									],
								);
							}
						} finally {
							replacement?.dispose();
							handleA.dispose();
							handleB.dispose();
							server.disconnectSockets(true);
							for (const socket of tcp) socket.destroy();
							await new Promise<void>((resolve) =>
								server.close(() => resolve()),
							);
						}
					});
				}
			}
		});
	});
});

// Replacement sockets must continue acknowledgement numbering; late replies on the shared engine must never settle a successor's command. Server-requested replies belong only to the session that asked.
describe("socket.io acknowledgements belong to the session that asked", () => {
	const restores: Array<() => void> = [];
	afterEach(() => {
		for (const restore of restores.splice(0)) restore();
	});

	const connectedCount = (context: TestContext) =>
		context.statuses.filter((status) => status.state === "connected").length;

	/**
	 * ACKs the client's `/a` sockets received, before upstream matches them.
	 * The Manager hands every packet to every subscribed socket, which keeps
	 * only its own namespace's (socket.js `onpacket`).
	 */
	function tapAcks() {
		type Packet = { type: number; nsp: string; id?: number; data?: unknown };
		const seen: Array<{
			sid: string | undefined;
			id: number | undefined;
			data: unknown;
		}> = [];
		const proto = Socket.prototype as unknown as {
			onpacket: (this: Socket, packet: Packet) => void;
		};
		const { onpacket } = proto;
		proto.onpacket = function (this: Socket, packet: Packet) {
			const own = (this as unknown as { nsp: string }).nsp;
			if (packet.type === 3 && packet.nsp === "/a" && own === "/a") {
				seen.push({
					sid: this.id,
					id: packet.id,
					data: structuredClone(packet.data),
				});
			}
			return onpacket.call(this, packet);
		};
		restores.push(() => {
			proto.onpacket = onpacket;
		});
		return seen;
	}

	/**
	 * An isolated server: `/a` holds the acknowledgements of `slow` and `work`
	 * until the test answers them (`fast` answers at once) and, with `ask`,
	 * asks the worker on every connection; `/b` is the sibling; `pending`
	 * namespaces hold their first handshake. The server's Engine
	 * reports the id of every `/a` EVENT and ACK frame it receives. Every
	 * handle shares one Manager.
	 */
	async function ackRig(options: {
		recovery: boolean;
		ask?: boolean;
		pending?: number;
	}) {
		const transport = createServer();
		const tcp = new Set<NetSocket>();
		transport.on("connection", (socket) => {
			tcp.add(socket);
			socket.on("close", () => tcp.delete(socket));
		});
		const server = new Server(
			transport,
			options.recovery
				? { connectionStateRecovery: { maxDisconnectionDuration: 60_000 } }
				: {},
		);
		const engineIds: string[] = [];
		const engineCloses: string[] = [];
		const frames: Array<{ type: "event" | "ack"; id: number; name?: string }> =
			[];
		server.engine.on(
			"connection",
			(engine: {
				id: string;
				on(event: string, listener: (...args: never[]) => void): void;
			}) => {
				engineIds.push(engine.id);
				engine.on("close", (reason: string) => engineCloses.push(reason));
				engine.on("packet", (packet: { type: string; data?: unknown }) => {
					const frame =
						packet.type === "message" && typeof packet.data === "string"
							? /^([23])\/a,(\d+)(.*)$/s.exec(packet.data)
							: null;
					if (!frame) return;
					const [, type, id = "", body = "[]"] = frame;
					frames.push(
						type === "2"
							? {
									type: "event",
									id: Number(id),
									name: (JSON.parse(body) as [string])[0],
								}
							: { type: "ack", id: Number(id) },
					);
				});
			},
		);
		const received: string[] = [];
		const held: Array<{ command: string; answer(): void }> = [];
		const lateAcks: Array<{
			token: unknown;
			connected: boolean;
			engineOpen: boolean;
		}> = [];
		const aSockets: ServerSocket[] = [];
		const answers: Array<{ sid: string; answer: unknown }> = [];
		server.of("/a").on("connection", (socket) => {
			aSockets.push(socket);
			for (const name of ["slow", "work"]) {
				socket.on(name, (token: string, ack: (value: unknown) => void) => {
					received.push(`${name}:${token}`);
					held.push({
						command: `${name}:${token}`,
						answer() {
							if (name === "slow") {
								lateAcks.push({
									token,
									connected: socket.connected,
									engineOpen: socket.conn.readyState === "open",
								});
							}
							ack({ token, command: name });
						},
					});
				});
			}
			socket.on("fast", (token: string, ack: (value: unknown) => void) => {
				received.push(`fast:${token}`);
				ack({ token, command: "fast" });
			});
			if (options.ask) {
				const sid = socket.id;
				socket.emit("ask", { q: aSockets.length }, (answer: unknown) =>
					answers.push({ sid, answer }),
				);
			}
		});
		const bSockets: ServerSocket[] = [];
		server.of("/b").on("connection", (socket) => {
			bSockets.push(socket);
			socket.on("fast", (token: string, ack: (value: unknown) => void) =>
				ack({ token, command: "fast" }),
			);
		});
		const entered = new Set<string>();
		const handshakes: Array<() => void> = [];
		for (let n = 0; n < (options.pending ?? 0); n += 1) {
			const name = `/pending-${n}`;
			server.of(name).use((_socket, next) => {
				if (entered.has(name)) return next();
				entered.add(name);
				handshakes.push(() => next());
			});
		}
		await new Promise<void>((resolve) =>
			transport.listen(0, "127.0.0.1", resolve),
		);
		const address = transport.address();
		if (!address || typeof address === "string") {
			throw new Error("no loopback port");
		}
		/** The worker's pending answers to `ask`, settled by the test. */
		const asks: Array<{ q: unknown; answer(): void; fail(): void }> = [];
		const adapter = socketIoAdapter({
			responders: {
				ask: (args) =>
					new Promise((resolve, reject) => {
						const q = (args[0] as { q: unknown }).q;
						asks.push({
							q,
							answer: () => resolve({ q }),
							fail: () => reject(new Error("synthetic responder failure")),
						});
					}),
			},
		});
		const opened = new Set<AdapterConnection>();
		/** Anonymous unless given credentials (one Manager per kind). */
		const open = (
			namespace: string,
			event = "notice",
			credentials?: () => Credentials,
		) => {
			const context = createTestContext(credentials ? { credentials } : {});
			const connection = adapter.connect(
				{
					url: `http://127.0.0.1:${address.port}`,
					namespace,
					sharing: "shared",
					...(credentials ? {} : { anonymous: true }),
					transports: ["websocket"],
					reconnectionDelayMs: 30,
					reconnectionDelayMaxMs: 60,
					ackTimeoutMs: 3_000,
				},
				context.ctx,
			);
			opened.add(connection);
			const sink = createRecordingSink<unknown[]>();
			connection.subscribe({ event }, sink.sink, {
				key: event,
				repeatable: true,
			});
			return { connection, context, sink };
		};
		return {
			tcp,
			engineIds,
			engineCloses,
			frames,
			received,
			lateAcks,
			aSockets,
			bSockets,
			answers,
			asks,
			entered,
			open,
			/** The live `/a` sessions on the server. */
			aSids: () => [...server.of("/a").sockets.keys()],
			/** A namespace broadcast: with recovery it carries the session offset. */
			broadcast: (namespace: string, event: string) =>
				server.of(namespace).emit(event, "broadcast"),
			command: (
				handle: ReturnType<typeof open>,
				event: string,
				token: string,
			): Promise<CommandOutcome<unknown>> => {
				const outcome = handle.connection.command?.(
					{ event, args: [token], ack: true },
					{
						id: `${event}:${token}`,
						signal: handle.context.ctx.signal,
						timeoutMs: 3_000,
					},
				);
				if (!outcome) throw new Error("the adapter has no command()");
				return outcome;
			},
			/** The server answers the held `<command>:<token>`. */
			answer(command: string) {
				const index = held.findIndex((entry) => entry.command === command);
				if (index < 0) throw new Error(`nothing held for ${command}`);
				held.splice(index, 1)[0]?.answer();
			},
			dispose(connection: AdapterConnection) {
				connection.dispose();
				opened.delete(connection);
			},
			async close() {
				for (const connection of opened) connection.dispose();
				for (const release of handshakes.splice(0)) release();
				server.disconnectSockets(true);
				for (const socket of tcp) socket.destroy();
				await new Promise<void>((resolve) => server.close(() => resolve()));
			},
		};
	}

	const DISPOSED = {
		status: "unknown",
		error: {
			code: "command-unknown",
			message: "The connection was disposed before the acknowledgement.",
			detail: { reason: "worker-lost" },
		},
	};
	const own = (token: string, command = "work") => ({
		status: "acknowledged",
		value: { token, command },
	});

	for (const recovery of [false, true]) {
		const mode = recovery ? "recovery on" : "recovery off";
		it(`a released handle's late acknowledgement never settles a later handle's command: the successor numbers above every id the released socket used and resolves with its own result, upstream drops the late ACK without a call or an error, the released command stays \`unknown\` and the sibling keeps its Engine (${mode}, VG7R2-A1)`, async () => {
			const acks = tapAcks();
			const h = await ackRig({ recovery });
			try {
				const b = h.open("/b");
				await waitFor(() => b.context.lastStatus()?.state === "connected");
				const a = h.open("/a");
				await waitFor(() => a.context.lastStatus()?.state === "connected");
				const first = h.command(a, "slow", "A");
				await waitFor(() => h.received.includes("slow:A"));
				h.dispose(a.connection);
				expect(await first).toEqual(DISPOSED);
				await waitFor(() => h.aSids().length === 0, {
					message: "the server removed A's socket",
				});
				const a2 = h.open("/a");
				await waitFor(() => a2.context.lastStatus()?.state === "connected");
				const [a2Sid] = h.aSids();
				let settled: CommandOutcome<unknown> | undefined;
				const second = h.command(a2, "work", "A2").then((outcome) => {
					settled = outcome;
					return outcome;
				});
				await waitFor(() => h.received.includes("work:A2"));
				// A's server handler answers now, on the shared Engine.
				h.answer("slow:A");
				await waitFor(() => acks.length === 1, {
					message: "the late ACK reached the successor's socket",
				});
				await sleep(20);
				expect(settled, "the late ACK settled nothing").toBeUndefined();
				h.answer("work:A2");
				expect(await second).toEqual(own("A2"));
				expect(
					h.lateAcks,
					"precondition: answered on the open Engine after A's socket left",
				).toEqual([{ token: "A", connected: false, engineOpen: true }]);
				expect(
					h.frames,
					"the successor numbers above the released socket's ids",
				).toEqual([
					{ type: "event", id: 0, name: "slow" },
					{ type: "event", id: 1, name: "work" },
				]);
				expect(acks).toEqual([
					{ sid: a2Sid, id: 0, data: [{ token: "A", command: "slow" }] },
					{ sid: a2Sid, id: 1, data: [{ token: "A2", command: "work" }] },
				]);
				// Dropped by upstream: nothing reaches the successor.
				expect(a2.context.statuses.map((status) => status.state)).toEqual([
					"connecting",
					"connected",
				]);
				expect(
					a2.context.diagnostics.map((diagnostic) => diagnostic.type),
				).toEqual(["socket-io.transport"]);
				expect(a2.sink.errors).toEqual([]);
				expect(a2.sink.continuity).toEqual([]);
				expect(h.engineIds, "one Engine throughout").toHaveLength(1);
				expect(h.engineCloses).toEqual([]);
				expect(h.bSockets, "the sibling never reconnected").toHaveLength(1);
				expect(connectedCount(b.context)).toBe(1);
				expect(b.sink.continuity).toEqual([]);
			} finally {
				await h.close();
			}
		});

		it(`after a Manager reconnect the live socket keeps its numbering and a successor still numbers above every id its released predecessor used, so a late ACK settles none of the successor's commands (${mode})`, async () => {
			const acks = tapAcks();
			const h = await ackRig({ recovery });
			try {
				const b = h.open("/b");
				await waitFor(() => b.context.lastStatus()?.state === "connected");
				const a = h.open("/a");
				await waitFor(() => a.context.lastStatus()?.state === "connected");
				expect(await h.command(a, "fast", "A0")).toEqual(own("A0", "fast"));
				for (const socket of h.tcp) socket.destroy();
				await waitFor(
					() =>
						connectedCount(a.context) === 2 &&
						connectedCount(b.context) === 2 &&
						h.aSids().length === 1,
					{ message: "the Manager reconnected" },
				);
				const first = h.command(a, "slow", "A");
				await waitFor(() => h.received.includes("slow:A"));
				h.dispose(a.connection);
				expect(await first).toEqual(DISPOSED);
				await waitFor(() => h.aSids().length === 0);
				const a2 = h.open("/a");
				await waitFor(() => a2.context.lastStatus()?.state === "connected");
				const [a2Sid] = h.aSids();
				const outcomes: CommandOutcome<unknown>[] = [];
				const seconds = ["A2", "A3"].map((token) =>
					h.command(a2, "work", token).then((outcome) => {
						outcomes.push(outcome);
						return outcome;
					}),
				);
				await waitFor(
					() =>
						h.received.includes("work:A2") && h.received.includes("work:A3"),
				);
				h.answer("slow:A");
				await waitFor(() => acks.some((ack) => ack.sid === a2Sid), {
					message: "the late ACK reached the successor's socket",
				});
				await sleep(20);
				expect(outcomes, "the late ACK settled nothing").toEqual([]);
				h.answer("work:A2");
				h.answer("work:A3");
				expect(await Promise.all(seconds)).toEqual([own("A2"), own("A3")]);
				expect(h.engineIds, "one Manager reconnect").toHaveLength(2);
				expect(
					h.frames,
					"one numbering across the reconnect and the release",
				).toEqual([
					{ type: "event", id: 0, name: "fast" },
					{ type: "event", id: 1, name: "slow" },
					{ type: "event", id: 2, name: "work" },
					{ type: "event", id: 3, name: "work" },
				]);
				expect(h.lateAcks).toEqual([
					{ token: "A", connected: false, engineOpen: true },
				]);
				expect(acks.filter((ack) => ack.sid === a2Sid)).toEqual([
					{ sid: a2Sid, id: 1, data: [{ token: "A", command: "slow" }] },
					{ sid: a2Sid, id: 2, data: [{ token: "A2", command: "work" }] },
					{ sid: a2Sid, id: 3, data: [{ token: "A3", command: "work" }] },
				]);
				expect(a2.sink.errors).toEqual([]);
				expect(connectedCount(b.context)).toBe(2);
			} finally {
				await h.close();
			}
		});

		it(`across the whole-client restart that reclaims 65 held handshakes a successor still numbers above every id a handle released before it used; the released handle's late answer finds its Engine closed and reaches nobody (${mode})`, async () => {
			const acks = tapAcks();
			const h = await ackRig({ recovery, pending: 65 });
			try {
				const b = h.open("/b");
				await waitFor(() => b.context.lastStatus()?.state === "connected");
				const a = h.open("/a");
				await waitFor(() => a.context.lastStatus()?.state === "connected");
				const first = h.command(a, "slow", "A");
				await waitFor(() => h.received.includes("slow:A"));
				h.dispose(a.connection);
				expect(await first).toEqual(DISPOSED);
				await waitFor(() => h.aSids().length === 0);
				for (let n = 0; n < 65; n += 1) {
					const name = `/pending-${n}`;
					const pending = h.open(name);
					await waitFor(() => h.entered.has(name));
					h.dispose(pending.connection);
				}
				await waitFor(
					() =>
						h.engineIds.length === 2 &&
						connectedCount(b.context) === 2 &&
						b.context.lastStatus()?.state === "connected",
					{ message: "the whole client restarted on a new Engine" },
				);
				const a2 = h.open("/a");
				await waitFor(() => a2.context.lastStatus()?.state === "connected");
				const [a2Sid] = h.aSids();
				let settled: CommandOutcome<unknown> | undefined;
				const second = h.command(a2, "work", "A2").then((outcome) => {
					settled = outcome;
					return outcome;
				});
				await waitFor(() => h.received.includes("work:A2"));
				h.answer("slow:A");
				await sleep(50);
				expect(settled, "the late answer settled nothing").toBeUndefined();
				h.answer("work:A2");
				expect(await second).toEqual(own("A2"));
				expect(h.lateAcks, "answered after its Engine closed").toEqual([
					{ token: "A", connected: false, engineOpen: false },
				]);
				expect(
					h.frames,
					"the numbering survives the whole-client restart",
				).toEqual([
					{ type: "event", id: 0, name: "slow" },
					{ type: "event", id: 1, name: "work" },
				]);
				expect(acks).toEqual([
					{ sid: a2Sid, id: 1, data: [{ token: "A2", command: "work" }] },
				]);
				expect(h.engineCloses, "one restart").toHaveLength(1);
			} finally {
				await h.close();
			}
		});
	}

	const FAILED = {
		type: "socket-io.responder-failed",
		detail: { event: "ask" },
	};
	const failures = (context: TestContext) =>
		context.diagnostics.filter(
			(diagnostic) => diagnostic.type === "socket-io.responder-failed",
		);

	for (const late of [true, false]) {
		for (const outcome of ["success", "failure"] as const) {
			const expected = late
				? "after its handle's release is dropped: no ACK and no diagnostic, so the server never receives a packet for a namespace it no longer holds; the shared Engine is kept and the sibling undisturbed"
				: outcome === "success"
					? "in time (control) writes its ACK once"
					: "in time (control) reports one payload-free diagnostic and writes no ACK";
			it(`a worker-side responder's ${outcome} ${expected} (VG7R2-R1)`, async () => {
				const h = await ackRig({ recovery: false, ask: true });
				try {
					const b = h.open("/b");
					await waitFor(() => b.context.lastStatus()?.state === "connected");
					const a = h.open("/a", "ask");
					await waitFor(() => h.asks.length === 1, {
						message: "the responder was asked",
					});
					const [asked] = h.aSids();
					if (late) {
						h.dispose(a.connection);
						await waitFor(() => h.aSids().length === 0);
					}
					if (outcome === "success") h.asks[0]?.answer();
					else h.asks[0]?.fail();
					await sleep(0);
					// A round trip on the shared Engine after the answer: an ACK
					// written before it reaches the server first.
					expect(await h.command(b, "fast", "B")).toEqual(own("B", "fast"));
					const answered = !late && outcome === "success";
					if (answered) await waitFor(() => h.answers.length === 1);
					if (!late) h.dispose(a.connection);
					expect(h.answers).toEqual(
						answered ? [{ sid: asked, answer: { q: 1 } }] : [],
					);
					expect(h.frames.filter((frame) => frame.type === "ack")).toEqual(
						answered ? [{ type: "ack", id: 0 }] : [],
					);
					expect(failures(a.context)).toEqual(
						!late && outcome === "failure" ? [FAILED] : [],
					);
					expect(h.engineIds).toHaveLength(1);
					expect(h.engineCloses).toEqual([]);
					expect(h.bSockets).toHaveLength(1);
					expect(connectedCount(b.context)).toBe(1);
					expect(b.sink.continuity).toEqual([]);
				} finally {
					await h.close();
				}
			});
		}
	}

	for (const cause of [
		"the server's namespace disconnect",
		"a transport drop",
		"a transport drop the server's session recovery restored",
		"rotate()",
	] as const) {
		const restored = cause.endsWith("restored");
		for (const outcome of ["success", "failure"] as const) {
			it(`a worker-side responder's ${outcome} after ${cause} ended the session that asked is dropped: no ACK and no diagnostic, nothing more closes or reconnects, and the next session is answered once (VG7R2-R1)`, async () => {
				const h = await ackRig({ recovery: restored, ask: true });
				try {
					const b = h.open("/b");
					await waitFor(() => b.context.lastStatus()?.state === "connected");
					const a = h.open("/a", "ask");
					await waitFor(
						() =>
							h.asks.length === 1 &&
							a.context.lastStatus()?.state === "connected",
					);
					const [asked] = h.aSids();
					const next = () =>
						waitFor(
							() =>
								h.asks.length === 2 &&
								a.context.lastStatus()?.state === "connected" &&
								b.context.lastStatus()?.state === "connected",
							{ message: "the next session was asked" },
						);
					if (cause === "the server's namespace disconnect") {
						h.aSockets[0]?.disconnect();
						await waitFor(() => a.context.lastStatus()?.state === "failed");
					} else if (cause === "rotate()") {
						a.connection.rotate?.();
						await next();
					} else {
						if (restored) {
							// A restore needs the pid and an offset, which only a
							// broadcast carries (socket.io 4.8.4 namespace.js 245-262).
							const offset = createRecordingSink<unknown[]>();
							a.connection.subscribe({ event: "warm" }, offset.sink, {
								key: "warm",
								repeatable: true,
							});
							h.broadcast("/a", "warm");
							await waitFor(() => offset.events.length === 1);
						}
						for (const socket of h.tcp) socket.destroy();
						await next();
					}
					// What the transition itself cost: a transport drop reconnects
					// the shared connection, and rotate()'s DISCONNECT then CONNECT
					// may cost it one reconnect. The late settlement must
					// cost nothing more.
					const shared = () => ({
						engines: h.engineIds.length,
						closes: h.engineCloses.length,
						bSockets: h.bSockets.length,
						bConnected: connectedCount(b.context),
						bContinuity: b.sink.continuity.length,
					});
					const before = shared();
					if (cause === "the server's namespace disconnect") {
						expect(before, "the Engine and the sibling were kept").toEqual({
							engines: 1,
							closes: 0,
							bSockets: 1,
							bConnected: 1,
							bContinuity: 0,
						});
					}
					if (outcome === "success") h.asks[0]?.answer();
					else h.asks[0]?.fail();
					await sleep(0);
					// A round trip on the shared Engine after the settlement: an ACK
					// written before it reaches the server first.
					expect(await h.command(b, "fast", "B")).toEqual(own("B", "fast"));
					expect(h.answers, "the ended session's answer was dropped").toEqual(
						[],
					);
					expect(h.frames.filter((frame) => frame.type === "ack")).toEqual([]);
					expect(failures(a.context), "nothing reported for it").toEqual([]);
					expect(shared(), "nothing more closed or reconnected").toEqual(
						before,
					);
					if (cause === "the server's namespace disconnect") {
						a.connection.retry?.();
						await next();
					}
					const [current] = h.aSids();
					if (restored) {
						// A restored server socket has no acknowledgement handlers from the previous session.
						expect(current, "the session id, restored").toBe(asked);
					} else {
						expect(current, "a new session").not.toBe(asked);
					}
					h.asks[1]?.answer();
					await waitFor(() => h.answers.length === 1);
					expect(await h.command(b, "fast", "B2")).toEqual(own("B2", "fast"));
					expect(h.answers).toEqual([{ sid: current, answer: { q: 2 } }]);
					expect(h.frames.filter((frame) => frame.type === "ack")).toEqual([
						{ type: "ack", id: 1 },
					]);
					expect(failures(a.context)).toEqual([]);
				} finally {
					await h.close();
				}
			});
		}
	}

	/**
	 * A full collection without a command-line flag, as Jest's leak detector
	 * takes one: the flag exposes `gc` to new contexts only (node:v8, node:vm).
	 */
	const collector = () => {
		setFlagsFromString("--expose-gc");
		return runInNewContext("gc") as () => void;
	};
	const collected = (refs: ReadonlyArray<WeakRef<object>>) =>
		refs.filter((ref) => ref.deref() === undefined).length;
	/** A credential provider whose fresh grant is watched, never held. */
	const watchedGrants =
		(grants: Array<WeakRef<object>>, n: number) => (): Credentials => {
			const grant = { auth: { grant: n } };
			grants.push(new WeakRef(grant));
			return grant;
		};

	for (const held of [true, false]) {
		it(`${
			held
				? "a responder still pending when its handle is released keeps nothing of the handle: the completion owner is cleared at release, so four released handles, their contexts and their grants are collected while the application holds the work and the sibling keeps the shared Engine; settled later, the work writes no ACK and reports nothing"
				: "a responder that answered before its handle's release (control): four released handles, their contexts and their grants are collected while the sibling keeps the shared Engine"
		} (structural)`, async () => {
			const gc = collector();
			const h = await ackRig({ recovery: false, ask: true });
			try {
				const b = h.open("/b", "notice", () => ({ auth: { sibling: true } }));
				await waitFor(() => b.context.lastStatus()?.state === "connected");
				const handles: Array<WeakRef<object>> = [];
				const contexts: Array<WeakRef<object>> = [];
				const grants: Array<WeakRef<object>> = [];
				const reports: Array<TestContext["diagnostics"]> = [];
				// Each cycle in its own frame: nothing of the handle outlives it.
				const cycle = async (n: number) => {
					const a = h.open("/a", "ask", watchedGrants(grants, n));
					handles.push(new WeakRef(a.connection));
					contexts.push(new WeakRef(a.context.ctx));
					reports.push(a.context.diagnostics);
					await waitFor(
						() =>
							h.asks.length === n + 1 &&
							a.context.lastStatus()?.state === "connected",
						{ message: "the responder was asked" },
					);
					if (!held) {
						h.asks[n]?.answer();
						await waitFor(() => h.answers.length === n + 1);
					}
					h.dispose(a.connection);
					await waitFor(() => h.aSids().length === 0);
				};
				for (let n = 0; n < 4; n += 1) await cycle(n);
				expect(grants, "one grant per handshake").toHaveLength(4);
				await sleep(20);
				// No deref() before a collection: it keeps its target for the job.
				for (let round = 0; round < 3; round += 1) {
					await sleep(10);
					gc();
				}
				await sleep(10);
				expect(
					collected(handles),
					"released handles unreachable from pending work",
				).toBe(4);
				expect(collected(contexts), "their contexts").toBe(4);
				expect(collected(grants), "their grants").toBe(4);
				if (held) {
					h.asks.forEach((ask, n) => {
						if (n % 2 === 0) ask.answer();
						else ask.fail();
					});
					await sleep(0);
					expect(await h.command(b, "fast", "B")).toEqual(own("B", "fast"));
					expect(h.answers).toEqual([]);
					expect(h.frames.filter((frame) => frame.type === "ack")).toEqual([]);
					expect(
						reports
							.flat()
							.filter((d) => d.type === "socket-io.responder-failed"),
					).toEqual([]);
				} else {
					expect(h.answers).toHaveLength(4);
				}
				expect(h.engineIds, "one shared Engine throughout").toHaveLength(1);
				expect(h.engineCloses).toEqual([]);
				expect(h.bSockets).toHaveLength(1);
				expect(connectedCount(b.context)).toBe(1);
			} finally {
				await h.close();
			}
		});
	}
});
