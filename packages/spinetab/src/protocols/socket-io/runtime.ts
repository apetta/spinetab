import { Manager, type Socket } from "socket.io-client";
import type {
	AdapterConnection,
	AdapterSubscription,
	AdapterSubscriptionOptions,
	ConnectionContext,
	RuntimeAdapter,
	SubscriptionSink,
} from "../../core/adapter.ts";
import { reportInterruption } from "../../core/continuity-phase.ts";
import { stableStringify } from "../../core/identity.ts";
import type {
	CommandOutcome,
	ConnectionReason,
	CredentialRequest,
	Credentials,
	Json,
	SerialisedError,
} from "../../core/types.ts";
import {
	attachedGrant,
	boundedText,
	credentialChannel,
	credentialFailureReason,
	FORBIDDEN,
} from "../shared/runtime.ts";
import { assertJson, isPlainObject } from "../shared/validate.ts";
import {
	pathNamespace,
	SOCKET_IO_DEFAULTS,
	type SocketIoCommand,
	type SocketIoConnection,
	type SocketIoEmitSpec,
	type SocketIoSubscriptionSpec,
	validateSocketIoCommand,
	validateSocketIoConnection,
	validateSocketIoSubscription,
} from "./spec.ts";

export type {
	SocketIoCommand,
	SocketIoConnection,
	SocketIoSubscriptionSpec,
} from "./spec.ts";

/**
 * Worker-side Socket.IO adapter. One explicit `Manager` per
 * Manager identity (never the global `io()` cache) with one namespace socket
 * per connection identity. The Manager loop owns reconnection with a finite
 * budget; Spinetab adds no timer loop (Engine.IO heartbeats are the liveness
 * contract). Commands are emitted at most once, only while connected, with a
 * mandatory acknowledgement timeout.
 */
export interface SocketIoAdapterOptions {
	/**
	 * Classify a middleware rejection (`connect_error` with `socket.active`
	 * false). `"auth"` is a 401-equivalent: `auth-blocked`, and the grant
	 * whose `auth` was sent is rejected. `"forbidden"` ends the
	 * connection as `failed` / `permanent-error` with code `forbidden` and
	 * rejects nothing. Default: `auth` when `err.data.status` is 401 or
	 * the message matches /unauthori[sz]ed/i; `forbidden` when it is 403 or
	 * the message matches /forbidden/i; otherwise a permanent failure.
	 */
	classifyConnectError?: (error: {
		message: string;
		data?: unknown;
	}) => "auth" | "forbidden" | "failed";
	/**
	 * Worker-side membership routes: event arguments → membership keys. Lets
	 * listeners with different keys share one namespace socket. Routes
	 * see payloads only in the worker and must not log them.
	 */
	routes?: Record<
		string,
		(
			args: readonly unknown[],
			context: { event: string; namespace: string },
		) => readonly string[] | undefined
	>;
	/**
	 * Worker-side responders for server-requested acknowledgements, by event.
	 * Without one, the acknowledgement is not called and a diagnostic is
	 * emitted; ack functions never cross the bridge.
	 */
	responders?: Record<
		string,
		(
			args: readonly unknown[],
			context: { namespace: string },
		) => unknown | Promise<unknown>
	>;
}

interface ManagerEntry {
	readonly manager: Manager;
	refs: number;
	/**
	 * Per namespace, a released handle's handshake still draining on the
	 * shared engine: the next handle for that namespace writes its
	 * CONNECT only once it settles. At most MEMBERSHIP_RETIRED_MAX.
	 */
	readonly draining: Map<string, Drain>;
	/** The whole client is restarting to reclaim drains. */
	reclaiming: boolean;
	/**
	 * The shared connection's next acknowledgement id: above every id a
	 * released namespace socket used. A new namespace socket numbers from it,
	 * so no later command, join or leave reuses an id a released handle's
	 * acknowledgement may still answer. One number per Manager, gone with it.
	 */
	ackIds: number;
}

/** Handles waiting for a drain; each removes itself at release. */
interface Drain {
	readonly waiters: Set<() => void>;
}

interface ListenerRecord {
	readonly spec: SocketIoSubscriptionSpec;
	readonly sink: SubscriptionSink<unknown[]>;
	/** False: ended `interrupted` by a deliberate fresh session. */
	readonly repeatable: boolean;
	active: boolean;
	started: boolean;
	/** The current interruption was already reported as a continuity loss. */
	lossReported: boolean;
}

interface Membership {
	readonly key: string;
	readonly join: SocketIoEmitSpec | undefined;
	readonly leave: SocketIoEmitSpec | undefined;
	readonly records: Set<ListenerRecord>;
	state: "idle" | "joining" | "joined";
	epoch: number;
}

interface PendingCommand {
	settle(outcome: CommandOutcome<unknown>): void;
}

/**
 * Who may complete the server-requested acknowledgements one session asked: the connection's context while that session lasts, nothing once it
 * ended or the handle was released.
 */
interface AnswerOwner {
	ctx: ConnectionContext | undefined;
}

type Responder = NonNullable<SocketIoAdapterOptions["responders"]>[string];

type Blocked = "auth" | "failed" | "exhausted" | "server-disconnect";

/**
 * Retired memberships a connection holds at most. Beyond it the
 * connection is flagged `overflowed` instead of evicting a known membership.
 * The same bound holds released handles' unanswered handshakes (drains) on a
 * shared connection; beyond it the whole client restarts.
 */
const MEMBERSHIP_RETIRED_MAX = 64;

/** socket.io-parser packet types (socket.io-client 4.8.4 does not export them). */
const CONNECT = 0;
const DISCONNECT = 1;
const CONNECT_ERROR = 4;

const RESTARTED = "The connection restarted; the operation is not repeatable.";

/** Test-only oracle: a connection's retired references and flag. */
const RETAINED: unique symbol = Symbol.for("spinetab.socket-io.retained");

/** Test-only oracle: the shared connection's drains and waiters. */
const DRAINS: unique symbol = Symbol.for("spinetab.socket-io.drains");

export function defaultClassifyConnectError(error: {
	message: string;
	data?: unknown;
}): "auth" | "forbidden" | "failed" {
	const status = isPlainObject(error.data) ? error.data.status : undefined;
	if (status === 401) return "auth";
	if (status === 403) return "forbidden";
	if (/unauthori[sz]ed/i.test(error.message)) return "auth";
	return /forbidden/i.test(error.message) ? "forbidden" : "failed";
}

export function socketIoAdapter(
	options: SocketIoAdapterOptions = {},
): RuntimeAdapter<
	SocketIoConnection,
	SocketIoSubscriptionSpec,
	unknown[],
	SocketIoCommand,
	unknown
> {
	const managers = new Map<string, ManagerEntry>();
	const routeNames = Object.keys(options.routes ?? {});
	return {
		kind: "socket-io",
		version: 1,
		validateConnection(spec: unknown): asserts spec is SocketIoConnection {
			validateSocketIoConnection(spec, { absolute: true });
		},
		validateSubscription(
			spec: unknown,
		): asserts spec is SocketIoSubscriptionSpec {
			validateSocketIoSubscription(spec, routeNames);
		},
		connectionKey,
		connect(spec, ctx) {
			// Manager identity includes scope and credential mode but excludes namespace; anonymous and credentialed groups must never share one.
			const { url, namespace } = endpointOf(spec);
			const key = stableStringify({
				scope: ctx.scope,
				group: groupIdentity(ctx.key, connectionKey(spec)),
				...SOCKET_IO_DEFAULTS,
				...spec,
				url,
				namespace: undefined,
			});
			let entry = managers.get(key);
			if (!entry) {
				entry = {
					manager: createManager(url, spec),
					refs: 0,
					draining: new Map(),
					reclaiming: false,
					ackIds: 0,
				};
				managers.set(key, entry);
			}
			entry.refs += 1;
			const acquired = entry;
			return new SocketIoConnectionHandle(
				spec,
				namespace,
				ctx,
				acquired,
				options,
				() => {
					acquired.refs -= 1;
					if (acquired.refs === 0 && managers.get(key) === acquired) {
						managers.delete(key);
						acquired.manager.removeAllListeners();
					}
				},
			);
		},
	};
}

/** `https://h/chat` and `https://h` with namespace `/chat` are one identity. */
function connectionKey(spec: SocketIoConnection): string {
	return stableStringify({
		...SOCKET_IO_DEFAULTS,
		...spec,
		...endpointOf(spec),
	});
}

/** Strip only the canonical-spec suffix; preserve unfamiliar group-key shapes to avoid widening sharing. */
function groupIdentity(key: string, canonical: string): string {
	return key.endsWith(canonical) ? key.slice(0, -canonical.length) : key;
}

/** The URL path selects the namespace; the Manager connects to the origin and query. */
function endpointOf(spec: SocketIoConnection): {
	url: string;
	namespace: string;
} {
	const url = new URL(spec.url);
	return {
		url: url.origin + url.search,
		namespace: spec.namespace ?? pathNamespace(url.pathname),
	};
}

/** Upstream retains inactive namespace sockets in Manager.nsps; release must evict them explicitly. */
function namespaceCache(manager: Manager): Record<string, Socket> | undefined {
	return (manager as unknown as { nsps?: Record<string, Socket> }).nsps;
}

/** Continue acknowledgement numbering across replacement sockets so late replies cannot acknowledge new work. */
function ackNumbering(socket: Socket): { ids: number } {
	return socket as unknown as { ids: number };
}

/** Drain the unanswered CONNECT before reusing its namespace; retain the socket and Manager, never the released handle. */
function drainHandshake(
	entry: ManagerEntry,
	socket: Socket,
	namespace: string,
): void {
	const { manager, draining } = entry;
	const drain: Drain = { waiters: new Set() };
	// Events upstream buffered for the released handle before the reply are
	// released too; with no subscription, nothing refills the buffer.
	socket.receiveBuffer.splice(0);
	const settle = () => {
		manager.off("packet", observe);
		manager.off("close", settle);
		if (draining.get(namespace) === drain) draining.delete(namespace);
		// After the Manager's own close handling has scheduled its reconnect,
		// so a resumed handle joins that reconnect instead of opening another.
		queueMicrotask(() => {
			for (const resume of drain.waiters) resume();
			drain.waiters.clear();
		});
	};
	const observe = (packet: { type: number; nsp: string }) => {
		if (packet.nsp !== namespace) return;
		if (packet.type === CONNECT) {
			(socket as unknown as { packet(packet: { type: number }): void }).packet({
				type: DISCONNECT,
			});
			settle();
		} else if (packet.type === CONNECT_ERROR) {
			settle();
		}
	};
	manager.on("packet", observe);
	manager.on("close", settle);
	draining.set(namespace, drain);
}

/** Restart the whole Manager when another drain would exceed the retention bound. */
function reclaim(entry: ManagerEntry): void {
	entry.reclaiming = true;
	try {
		entry.manager._close();
	} finally {
		entry.reclaiming = false;
	}
	entry.manager.open();
}

function createManager(uri: string, spec: SocketIoConnection): Manager {
	return new Manager(uri, {
		path: spec.path ?? SOCKET_IO_DEFAULTS.path,
		autoConnect: false,
		reconnection: true,
		reconnectionAttempts:
			spec.reconnectionAttempts ?? SOCKET_IO_DEFAULTS.reconnectionAttempts,
		...(spec.reconnectionDelayMs !== undefined
			? { reconnectionDelay: spec.reconnectionDelayMs }
			: {}),
		...(spec.reconnectionDelayMaxMs !== undefined
			? { reconnectionDelayMax: spec.reconnectionDelayMaxMs }
			: {}),
		...(spec.timeoutMs !== undefined ? { timeout: spec.timeoutMs } : {}),
		...(spec.transports ? { transports: spec.transports } : {}),
		...(spec.upgrade !== undefined ? { upgrade: spec.upgrade } : {}),
		...(spec.withCredentials !== undefined
			? { withCredentials: spec.withCredentials }
			: {}),
		...(spec.query ? { query: spec.query } : {}),
	});
}

/** Capture only the requesting session's owner; pending responder work must not retain a released handle or answer a later session. */
function respond(
	owner: AnswerOwner,
	socket: Socket,
	ack: (...values: unknown[]) => void,
	responder: Responder,
	args: readonly unknown[],
	event: string,
	namespace: string,
): void {
	const asked = socket.id;
	// The owner while the session that asked is live; nothing after.
	const live = () =>
		socket.connected && socket.id === asked ? owner.ctx : undefined;
	Promise.resolve()
		.then(() => responder(args, { namespace }))
		.then(
			(value) => {
				if (live()) ack(value);
			},
			() => {
				live()?.diagnostic({
					type: "socket-io.responder-failed",
					detail: { event },
				});
			},
		);
}

class SocketIoConnectionHandle
	implements
		AdapterConnection<
			SocketIoSubscriptionSpec,
			unknown[],
			SocketIoCommand,
			unknown
		>
{
	readonly #spec: SocketIoConnection;
	readonly #namespace: string;
	readonly #ctx: ConnectionContext;
	readonly #entry: ManagerEntry;
	readonly #options: SocketIoAdapterOptions;
	readonly #release: () => void;
	readonly #socket: Socket;
	readonly #listeners = new Map<
		string,
		{ handler: (...args: unknown[]) => void; records: Set<ListenerRecord> }
	>();
	readonly #memberships = new Map<string, Membership>();
	/**
	 * Keys without consumers whose room the server may still hold: confirmed
	 * and retired while disconnected, retired with a join in flight, or whose
	 * leave was lost with the transport or timed out while connected. Left
	 * once their joins are acknowledged or time out, or at a recovered
	 * reconnect; dropped at any other connect, a block, dispose or when the
	 * key has consumers again. At most
	 * MEMBERSHIP_RETIRED_MAX; never evicted.
	 */
	readonly #retired = new Map<string, Membership>();
	/**
	 * A retirement found the map full: the memberships it could not
	 * hold end with a fresh session, at once while connected or when
	 * a recovered reconnect would restore them; a reconnect without recovery
	 * simply drops the flag.
	 */
	#overflowed = false;
	/** The fresh session this connection started; never restarted twice. */
	#restarting = false;
	/**
	 * Joins emitted and not yet acknowledged, per key. Upstream keeps the ack
	 * of a join it buffered (heartbeat deadline passed) through a drop and
	 * flushes the join on the next session before `connect`.
	 */
	readonly #joinsInFlight = new Map<string, number>();
	readonly #pending = new Set<PendingCommand>();
	/** The current session's acknowledgement owner. */
	#answers: AnswerOwner | undefined;
	readonly #managerSubs: Array<() => void> = [];
	#blocked: Blocked | undefined;
	/** Blocked by the credential audience: rotation never restarts it. */
	#permanent = false;
	/** The grant whose `auth` the current handshake sent. */
	#attached: Credentials | undefined;
	#hintRetried = false;
	#everConnected = false;
	readonly #firstConnectWaiters = new Set<(connected: boolean) => void>();
	#nextReason: CredentialRequest["reason"] = "connect";
	/** Namespace handshake attempt; bumped by every auth call and close. */
	#authAttempt = 0;
	/**
	 * A CONNECT presented the recovery pid and no `connect` has confirmed it.
	 * The server may have restored the session on it: when the engine closes
	 * first, the pid is spent.
	 */
	#presented = false;
	/**
	 * A CONNECT this socket wrote on the current engine that no `connect` or
	 * `connect_error` has answered: released now, it is drained.
	 */
	#unanswered = false;
	/**
	 * The drain of a released handle's handshake on this namespace this handle
	 * waits for, and how it resumes; removed at release.
	 */
	#waiting: { readonly drain: Drain; readonly resume: () => void } | undefined;
	#disposed = false;

	constructor(
		spec: SocketIoConnection,
		namespace: string,
		ctx: ConnectionContext,
		entry: ManagerEntry,
		options: SocketIoAdapterOptions,
		release: () => void,
	) {
		this.#spec = spec;
		this.#namespace = namespace;
		this.#ctx = ctx;
		this.#entry = entry;
		this.#options = options;
		this.#release = release;
		this.#socket = entry.manager.socket(namespace);
		// A new Socket numbers acknowledgements from 0: continued above every
		// id a released socket used, a late ACK owed to a released handle
		// matches nothing here and upstream drops it.
		const numbering = ackNumbering(this.#socket);
		numbering.ids = Math.max(numbering.ids, entry.ackIds);
		// Set on the instance: this handle's callback, unbound at dispose.
		this.#socket.auth = (callback: (data: object) => void) =>
			this.#auth(callback);
		this.#wire();
	}

	subscribe(
		spec: SocketIoSubscriptionSpec,
		sink: SubscriptionSink<unknown[]>,
		options?: AdapterSubscriptionOptions,
	): AdapterSubscription {
		const record: ListenerRecord = {
			spec,
			sink,
			repeatable: options?.repeatable !== false,
			active: true,
			started: false,
			lossReported: false,
		};
		if (
			spec.membership !== undefined &&
			spec.route === undefined &&
			this.#spec.membership !== spec.membership
		) {
			sink.error({
				code: "unsupported-option",
				message:
					"subscription.membership: keys without a worker-side route need their own socket (use the page builder).",
				detail: { path: "subscription.membership" },
			});
			return { unsubscribe() {} };
		}
		let group = this.#listeners.get(spec.event);
		if (!group) {
			const event = spec.event;
			const handler = (...args: unknown[]) => this.#onEvent(event, args);
			group = { handler, records: new Set() };
			this.#listeners.set(event, group);
			this.#socket.on(event, handler);
		}
		group.records.add(record);
		if (spec.membership !== undefined) this.#addMember(record);
		this.#connect();
		return { unsubscribe: () => this.#removeRecord(record) };
	}

	async command(
		payload: SocketIoCommand,
		options: { id: string; signal: AbortSignal; timeoutMs: number },
	): Promise<CommandOutcome<unknown>> {
		validateSocketIoCommand(payload);
		const socket = this.#socket;
		if (!socket.connected && !this.#everConnected && !this.#blocked) {
			// Nothing has been emitted yet, so waiting for the very first
			// connect cannot duplicate anything; bounded by the ack timeout.
			this.#connect();
			await this.#waitForFirstConnect(
				Math.min(
					this.#spec.ackTimeoutMs ?? SOCKET_IO_DEFAULTS.ackTimeoutMs,
					Math.max(1, options.timeoutMs),
				),
				options.signal,
			);
		}
		if (this.#disposed || !socket.connected) {
			// Never queued in the upstream send buffer.
			this.#connect();
			return notSent("The socket is not connected; the command was not sent.");
		}
		if (options.signal.aborted) {
			return notSent("The command was aborted before it was sent.");
		}
		const args = payload.args ?? [];
		const bufferedBefore = socket.sendBuffer.length;
		if (payload.volatile || payload.ack === false) {
			(payload.volatile ? socket.volatile : socket).emit(
				payload.event,
				...args,
			);
			if (this.#dropBuffered(bufferedBefore)) {
				return notSent("The connection expired; the command was not sent.");
			}
			return { status: "sent" };
		}
		const ackMode = payload.ack ?? true;
		const timeout = Math.min(
			this.#spec.ackTimeoutMs ?? SOCKET_IO_DEFAULTS.ackTimeoutMs,
			Math.max(1, options.timeoutMs),
		);
		return new Promise<CommandOutcome<unknown>>((resolve) => {
			let settled = false;
			const pending: PendingCommand = {
				settle: (outcome) => {
					if (settled) return;
					settled = true;
					this.#pending.delete(pending);
					options.signal.removeEventListener("abort", onAbort);
					resolve(outcome);
				},
			};
			const onAbort = () =>
				pending.settle(unknown("aborted", "The caller aborted after sending."));
			this.#pending.add(pending);
			options.signal.addEventListener("abort", onAbort, { once: true });
			socket
				.timeout(timeout)
				.emit(
					payload.event,
					...args,
					(error: Error | null, ...response: unknown[]) => {
						if (error) {
							const reason = /timed out/i.test(error.message)
								? "timeout"
								: "disconnected";
							pending.settle(
								unknown(
									reason,
									reason === "timeout"
										? "No acknowledgement before the timeout; the server may have acted."
										: "The socket disconnected before the acknowledgement.",
								),
							);
							return;
						}
						if (ackMode === "error-first" && response[0] != null) {
							pending.settle({
								status: "rejected",
								error: {
									code: "command-rejected",
									message: "The server rejected the command.",
									...(jsonOrUndefined(response[0]) === undefined
										? {}
										: { detail: jsonOrUndefined(response[0]) as Json }),
								},
							});
							return;
						}
						pending.settle({
							status: "acknowledged",
							value: ackMode === "error-first" ? response[1] : response[0],
						});
					},
				);
			if (this.#dropBuffered(bufferedBefore)) {
				pending.settle(
					notSent("The connection expired; the command was not sent."),
				);
			}
		});
	}

	/** Test-only oracle: retired references held and the overflow flag. */
	[RETAINED](): { retired: number; overflowed: boolean } {
		return { retired: this.#retired.size, overflowed: this.#overflowed };
	}

	/** Test-only oracle: drains and waiters on the shared connection. */
	[DRAINS](): { drains: number; waiters: number } {
		let waiters = 0;
		for (const drain of this.#entry.draining.values()) {
			waiters += drain.waiters.size;
		}
		return { drains: this.#entry.draining.size, waiters };
	}

	retry(): void {
		if (this.#disposed) return;
		// Every client-initiated reconnect starts a fresh session.
		if (this.#blocked === "exhausted") {
			// The Manager reset its backoff when it emitted reconnect_failed.
			this.#blocked = undefined;
			this.#declineRecovery();
			this.#ctx.setStatus({ state: "connecting" });
			this.#entry.manager.open();
			return;
		}
		if (this.#blocked) {
			this.#declineRecovery();
			this.#blocked = undefined;
			this.#permanent = false;
			this.#nextReason = "retry";
			this.#ctx.setStatus({ state: "connecting" });
			this.#socket.connect();
		}
	}

	rotate(): void {
		if (this.#disposed || this.#permanent) return;
		if (this.#blocked === "auth") {
			this.#blocked = undefined;
			this.#nextReason = "rotated";
			this.#ctx.setStatus({ state: "connecting" });
			this.#declineRecovery();
			this.#socket.connect();
			return;
		}
		if (this.#socket.connected) {
			// Explicit restart: a new namespace session (continuity unknown),
			// never a recovered one.
			this.#nextReason = "rotated";
			this.#declineRecovery();
			this.#socket.disconnect();
			this.#socket.connect();
		}
	}

	probe(): void {
		if (this.#disposed) return;
		if (this.#blocked === "exhausted" && !this.#hintRetried) {
			this.#hintRetried = true;
			this.retry();
			return;
		}
		// After a detected gap, check the Engine.IO heartbeat deadline now
		// rather than waiting for a throttled timer; an expired session closes
		// with "ping timeout" and the Manager loop reconnects (engine.io-client
		// 6.6.7 `_hasPingExpired`).
		const engine = this.#entry.manager.engine as
			| { _hasPingExpired?: () => boolean }
			| undefined;
		if (this.#socket.connected) engine?._hasPingExpired?.();
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		// Pending responder work completes nothing for a released handle and
		// keeps nothing of it.
		this.#endAnswers();
		this.#settleFirstConnect(false);
		for (const pending of [...this.#pending]) {
			pending.settle(
				unknown(
					"worker-lost",
					"The connection was disposed before the acknowledgement.",
				),
			);
		}
		for (const [event, group] of this.#listeners) {
			this.#socket.off(event, group.handler);
			for (const record of group.records) record.active = false;
		}
		this.#listeners.clear();
		this.#memberships.clear();
		this.#retired.clear();
		this.#overflowed = false;
		this.#joinsInFlight.clear();
		for (const unsubscribe of this.#managerSubs.splice(0)) unsubscribe();
		// A handle waiting for a released handle's handshake stops waiting at
		// once: nothing is resumed or written for it.
		const waiting = this.#waiting;
		waiting?.drain.waiters.delete(waiting.resume);
		this.#waiting = undefined;
		this.#socket.removeAllListeners();
		// Packets upstream buffered for this handle (an expired heartbeat) are
		// never flushed on another session.
		this.#socket.sendBuffer.splice(0);
		// Unbind this handle's callback so the disposed handle and its grant
		// are released.
		this.#socket.auth = {};
		// This session's pid and offset are never presented again.
		this.#declineRecovery();
		const socket = this.#socket;
		const cache = namespaceCache(this.#entry.manager);
		// A CONNECT on the shared engine still unanswered: the server may yet
		// register the socket it creates, which would outlive this handle while
		// a sibling keeps the engine open. Without an active sibling the
		// Manager closes below and the server drops the handshake with it.
		const unanswered =
			this.#unanswered &&
			Object.values(cache ?? {}).some(
				(other) => other !== socket && other.active,
			);
		// Upstream disconnect() unsubscribes this socket from Manager events and closes the Manager only when no active namespace remains.
		socket.disconnect();
		// The server may still answer this socket's commands, joins and leaves
		// on the shared engine: no later socket reuses their ids.
		this.#entry.ackIds = Math.max(this.#entry.ackIds, ackNumbering(socket).ids);
		// The Manager caches every namespace socket and evicts none: the
		// released one leaves the cache.
		if (cache?.[this.#namespace] === socket && !socket.active) {
			delete cache[this.#namespace];
		}
		if (unanswered) {
			// Held until answered within the connection's retention bound;
			// beyond it the whole client restarts.
			if (this.#entry.draining.size < MEMBERSHIP_RETIRED_MAX) {
				drainHandshake(this.#entry, socket, this.#namespace);
			} else {
				reclaim(this.#entry);
			}
		}
		this.#release();
	}

	#waitForFirstConnect(
		timeoutMs: number,
		signal: AbortSignal,
	): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			const done = (connected: boolean) => {
				clearTimeout(timer);
				signal.removeEventListener("abort", onAbort);
				this.#firstConnectWaiters.delete(done);
				resolve(connected);
			};
			const onAbort = () => done(false);
			const timer = setTimeout(() => done(false), timeoutMs);
			signal.addEventListener("abort", onAbort, { once: true });
			this.#firstConnectWaiters.add(done);
		});
	}

	#settleFirstConnect(connected: boolean): void {
		for (const waiter of [...this.#firstConnectWaiters]) waiter(connected);
	}

	#connect(): void {
		if (
			this.#disposed ||
			this.#blocked ||
			this.#socket.active ||
			this.#waiting
		) {
			return;
		}
		this.#ctx.setStatus({ state: "connecting" });
		this.#open();
	}

	/**
	 * Connects once no released handle's handshake drains the namespace; the wait is registered on the drain and removed at release.
	 */
	#open(): void {
		const drain = this.#entry.draining.get(this.#namespace);
		if (drain) {
			const resume = () => {
				this.#waiting = undefined;
				if (!this.#disposed && !this.#blocked && !this.#socket.active) {
					this.#open();
				}
			};
			this.#waiting = { drain, resume };
			drain.waiters.add(resume);
			return;
		}
		this.#socket.connect();
	}

	#auth(callback: (data: object) => void): void {
		const reason = this.#nextReason;
		this.#nextReason = "reconnect";
		const base = this.#spec.auth ?? {};
		this.#attached = undefined;
		const attempt = ++this.#authAttempt;
		if (this.#spec.anonymous) {
			this.#sendConnect(callback, { ...base });
			return;
		}
		// upstream's callback writes a CONNECT to whatever engine is open when
		// it runs: only the attempt that asked, still handshaking, may answer.
		const current = () =>
			!this.#disposed &&
			attempt === this.#authAttempt &&
			this.#socket.active &&
			!this.#socket.connected;
		this.#ctx.credentials(reason, this.#spec.url).then(
			(credentials) => {
				if (!current()) return;
				const provided = credentialChannel(credentials, "auth");
				this.#attached = attachedGrant(credentials, provided);
				this.#sendConnect(callback, { ...base, ...provided });
			},
			(error: unknown) => {
				if (!current()) return;
				// Never connect with an empty payload.
				this.#block("auth", { reason: credentialFailureReason(error) });
				this.#socket.disconnect();
			},
		);
	}

	/**
	 * upstream's `auth` callback (`_sendConnectPacket`) writes the namespace
	 * CONNECT at once, with the recovery pid and offset while `_pid` is set:
	 * unanswered from here.
	 */
	#sendConnect(callback: (data: object) => void, data: object): void {
		this.#presented =
			(this.#socket as unknown as { _pid?: string })._pid !== undefined;
		this.#unanswered = true;
		callback(data);
	}

	#wire(): void {
		const socket = this.#socket;
		const manager = this.#entry.manager;
		socket.on("connect", () => {
			if (this.#disposed) return;
			this.#presented = false;
			this.#unanswered = false;
			const recovered = this.#everConnected && socket.recovered;
			const restarted = this.#restarting;
			this.#restarting = false;
			// Recovery would restore rooms the adapter could not hold:
			// declined, the connection restarts on a fresh session.
			if (recovered && this.#overflowed && !restarted) {
				this.#freshSession();
				return;
			}
			this.#overflowed = false;
			this.#blocked = undefined;
			this.#hintRetried = false;
			// The continuity outcome precedes `connected`. It is
			// reported even when the loss was reported at detection: an
			// application that reconciled then must reconcile again (point 48).
			if (recovered) {
				// A session is restored at most once: the server keeps this
				// snapshot and restores it on the old sid, so presenting the pid
				// after a loss the client detects first would bring back rooms
				// left since and, once the old server socket times out, none.
				this.#declineRecovery();
				// Upstream replays the missed packets; memberships survived.
				this.#eachRecord((record) => record.sink.continuity("recovered"));
			} else if (this.#everConnected) {
				// A restore the server refused: upstream's `onconnect` stored the
				// new pid but kept the earlier session's offset, which the new
				// pid must never present.
				(socket as unknown as { _lastOffset?: string })._lastOffset = undefined;
				this.#eachRecord((record) => record.sink.continuity("reconnected"));
				for (const membership of this.#memberships.values()) {
					if (membership.state === "joined") membership.state = "idle";
				}
			}
			// A join unacknowledged at the drop may or may not have applied:
			// it is sent again (declared idempotent) before delivery.
			for (const membership of this.#memberships.values()) {
				if (membership.state === "joining") membership.state = "idle";
			}
			this.#eachRecord((record) => {
				record.lossReported = false;
			});
			this.#everConnected = true;
			this.#ctx.setStatus({ state: "connected" });
			const transport = (
				manager.engine as { transport?: { name?: string } } | undefined
			)?.transport?.name;
			if (transport) {
				this.#ctx.diagnostic({
					type: "socket-io.transport",
					detail: { transport },
				});
			}
			this.#settleFirstConnect(true);
			this.#releaseRetired(recovered);
			this.#joinAll();
		});
		socket.on("connect_error", (error: Error & { data?: unknown }) => {
			if (this.#disposed) return;
			this.#unanswered = false;
			if (socket.active) {
				// Transport failure or timeout: the Manager loop retries.
				this.#reportLoss();
				this.#ctx.setStatus({
					state: "reconnecting",
					reason: "network",
					code: `connect-error:${boundedText(error.message)}`,
				});
				return;
			}
			const classify =
				this.#options.classifyConnectError ?? defaultClassifyConnectError;
			const kind = classify({ message: error.message, data: error.data });
			if (kind === "auth") {
				this.#block("auth", { code: "connect-error" }, this.#attached);
			} else if (kind === "forbidden") {
				this.#block("failed", { code: FORBIDDEN.code });
			} else {
				this.#block("failed", { code: "connect-error" });
			}
		});
		socket.on("disconnect", (reason: string) => {
			if (this.#disposed) return;
			// The session that asked has ended.
			this.#endAnswers();
			this.#authAttempt += 1;
			if (reason === "io client disconnect") return;
			if (reason === "io server disconnect") {
				// Deliberate server disconnect: only an explicit retry reconnects.
				this.#block("server-disconnect", { code: reason });
				return;
			}
			if (this.#entry.reclaiming) this.#reclaimed();
			const statusReason: ConnectionReason =
				reason === "ping timeout" ? "heartbeat-timeout" : "network";
			this.#reportLoss();
			this.#ctx.setStatus({
				state: "reconnecting",
				reason: statusReason,
				code: reason,
			});
		});
		const on = (event: string, listener: (...args: never[]) => void) => {
			manager.on(event as never, listener as never);
			this.#managerSubs.push(() =>
				manager.off(event as never, listener as never),
			);
		};
		// Run before Socket.onconnect flushes receiveBuffer. A fresh session has no replay before CONNECT, so buffered events from another session must be discarded.
		on(
			"packet",
			(packet: { type: number; nsp: string; data?: { pid?: unknown } }) => {
				if (
					packet.type !== CONNECT ||
					packet.nsp !== this.#namespace ||
					!socket.active ||
					socket.connected
				) {
					return;
				}
				const pid = packet.data?.pid;
				const own = (socket as unknown as { _pid?: string })._pid;
				if (!pid || pid !== own) socket.receiveBuffer.splice(0);
			},
		);
		// The engine closed: a pending namespace handshake belongs to it.
		// A recovery pid it presented without a confirmation is spent: the
		// server may have restored the session on it, and presented again the
		// pid would restore it a second time on the same sid, which the first
		// restored socket's expiry strips of its rooms.
		on("close", () => {
			this.#authAttempt += 1;
			this.#unanswered = false;
			if (this.#presented) {
				this.#presented = false;
				this.#declineRecovery();
			}
		});
		on("reconnect_attempt", (attempt: number) => {
			if (this.#disposed || this.#blocked) return;
			this.#reportLoss();
			this.#ctx.setStatus({
				state: "reconnecting",
				reason: "network",
				attempt,
			});
		});
		on("reconnect_failed", () => {
			if (this.#disposed || (this.#blocked && this.#blocked !== "exhausted"))
				return;
			this.#block("exhausted", {});
		});
	}

	#block(
		kind: Blocked,
		detail: { reason?: ConnectionReason; code?: string },
		/** The grant the rejected handshake carried; only a 401 passes it. */
		grant?: Credentials,
	): void {
		this.#blocked = kind;
		this.#permanent = detail.reason === "credentials-audience";
		this.#attached = undefined;
		this.#restarting = false;
		// No reconnect follows on its own: tombstones cannot outlive the
		// disconnection, and recovery is declined so the server cannot
		// restore a room the adapter forgot.
		if (this.#retired.size > 0 || this.#overflowed) {
			this.#releaseRetired(false);
			this.#overflowed = false;
			this.#declineRecovery();
		}
		this.#settleFirstConnect(false);
		const code = detail.code ? { code: detail.code } : {};
		if (kind === "auth") {
			if (grant) this.#ctx.rejectCredentials(grant);
			this.#ctx.setStatus({
				state: "auth-blocked",
				reason: detail.reason ?? "credentials-rejected",
				...code,
			});
		} else if (kind === "exhausted") {
			this.#ctx.setStatus({
				state: "retry-exhausted",
				reason: "attempts-exhausted",
				...code,
			});
		} else {
			this.#ctx.setStatus({
				state: "failed",
				reason:
					kind === "server-disconnect" ? "server-closed" : "permanent-error",
				...code,
			});
		}
	}

	/**
	 * Continuity is unknown from the moment an interruption is detected: the
	 * client declares no replay (connection-state recovery is the server's and
	 * is only known at reconnect, as `recovered`). Each record is told once
	 * per interruption, before any status reports it.
	 */
	#reportLoss(): void {
		if (!this.#everConnected) return;
		this.#eachRecord((record) => {
			if (record.lossReported) return;
			record.lossReported = true;
			reportInterruption(record.sink, "reconnected");
		});
	}

	#eachRecord(callback: (record: ListenerRecord) => void): void {
		for (const group of this.#listeners.values()) {
			for (const record of group.records) if (record.active) callback(record);
		}
	}

	#onEvent(event: string, args: unknown[]): void {
		if (this.#disposed) return;
		const group = this.#listeners.get(event);
		if (!group) return;
		const last = args.at(-1);
		if (typeof last === "function") {
			// A server-requested acknowledgement: the function never crosses
			// the bridge; only a declared worker-side responder may answer.
			args = args.slice(0, -1);
			this.#answer(event, args, last as (...values: unknown[]) => void);
		}
		// Membership keys once per event for each distinct route, so listeners
		// with different routes each match their own keys.
		const routed = new Map<string, readonly string[] | undefined>();
		for (const record of group.records) {
			if (!record.active) continue;
			const { membership, route } = record.spec;
			if (membership !== undefined) {
				const state = this.#memberships.get(membership);
				// No delivery before membership is (re)established.
				if (state?.join && state.state !== "joined") continue;
				if (route !== undefined) {
					if (!routed.has(route)) {
						routed.set(route, this.#route(route, event, args));
					}
					if (!routed.get(route)?.includes(membership)) continue;
				}
			}
			if (!record.started) {
				record.started = true;
				record.sink.started();
			}
			record.sink.next(args);
		}
	}

	#route(
		route: string,
		event: string,
		args: readonly unknown[],
	): readonly string[] | undefined {
		const fn = this.#options.routes?.[route];
		if (!fn) return undefined;
		try {
			return fn(args, { event, namespace: this.#namespace });
		} catch {
			this.#ctx.diagnostic({
				type: "socket-io.route-failed",
				detail: { route, event },
			});
			return undefined;
		}
	}

	#answer(
		event: string,
		args: unknown[],
		ack: (...values: unknown[]) => void,
	): void {
		const responder = this.#options.responders?.[event];
		if (!responder) {
			this.#ctx.diagnostic({
				type: "socket-io.server-ack-unanswered",
				detail: { event },
			});
			return;
		}
		// The session's first request creates its owner; its end clears it.
		this.#answers ??= { ctx: this.#ctx };
		respond(
			this.#answers,
			this.#socket,
			ack,
			responder,
			args,
			event,
			this.#namespace,
		);
	}

	/** Nothing completes the ended session's requests. */
	#endAnswers(): void {
		if (this.#answers) this.#answers.ctx = undefined;
		this.#answers = undefined;
	}

	#addMember(record: ListenerRecord): void {
		const key = record.spec.membership as string;
		let membership = this.#memberships.get(key);
		if (!membership) {
			// A key with consumers again before the next connect keeps what the
			// server may hold: recovery keeps a confirmed join and an
			// unacknowledged one is sent again. While connected a new
			// join is sent.
			const retired = this.#retired.get(key);
			this.#retired.delete(key);
			membership = {
				key,
				join: record.spec.join,
				leave: record.spec.leave,
				records: new Set(),
				state: !record.spec.join
					? "joined"
					: retired && !this.#socket.connected
						? retired.state
						: "idle",
				epoch: 0,
			};
			this.#memberships.set(key, membership);
		}
		membership.records.add(record);
		if (this.#socket.connected) this.#join(membership);
	}

	#joinAll(): void {
		for (const membership of this.#memberships.values()) this.#join(membership);
	}

	/** Join once per key and session; the join is declared idempotent. */
	#join(membership: Membership): void {
		if (
			!membership.join ||
			membership.state !== "idle" ||
			!this.#socket.connected
		) {
			return;
		}
		membership.state = "joining";
		const epoch = ++membership.epoch;
		const { key } = membership;
		const { event, args = [] } = membership.join;
		this.#joinsInFlight.set(key, (this.#joinsInFlight.get(key) ?? 0) + 1);
		this.#socket
			.timeout(this.#spec.ackTimeoutMs ?? SOCKET_IO_DEFAULTS.ackTimeoutMs)
			.emit(event, ...args, (error: Error | null) => {
				if (this.#disposed) return;
				const inFlight = (this.#joinsInFlight.get(key) ?? 1) - 1;
				if (inFlight > 0) this.#joinsInFlight.set(key, inFlight);
				else this.#joinsInFlight.delete(key);
				const connected = this.#socket.connected;
				if (
					membership.epoch === epoch &&
					this.#memberships.get(key) === membership
				) {
					if (!error) {
						membership.state = "joined";
						return;
					}
					// Disconnected mid-join: it may have applied; the next connect
					// sends it again.
					if (!connected) return;
					// Timed out while connected: that key's consumers are errored, and the join may have applied, so it is
					// compensated with one leave.
					this.#memberships.delete(key);
					for (const record of membership.records) {
						this.#removeRecord(record, false);
						record.sink.error({
							code: "subscribe-rejected",
							message: "Joining the membership failed or timed out.",
							detail: { membership: key },
						});
					}
					membership.records.clear();
					// An error handler may have regained the key, disposed the
					// connection or restarted the socket: decide from the state
					// after the loop.
					if (this.#disposed || this.#memberships.has(key)) return;
					if (!this.#joinsInFlight.has(key) && this.#socket.connected) {
						this.#leave(membership);
					} else if (membership.leave) this.#retire(membership);
					return;
				}
				// Serialised after the key's joins: a retired
				// key is left once no join for it awaits its acknowledgement,
				// whether the last one was acknowledged or timed out (it may have
				// applied). After a disconnection the next connect decides; no leave is emitted while disconnected.
				const retired = this.#retired.get(key);
				if (retired && inFlight === 0 && connected) {
					this.#retired.delete(key);
					this.#leave(retired);
				}
			});
	}

	#removeRecord(record: ListenerRecord, leave = true): void {
		if (!record.active) return;
		record.active = false;
		const group = this.#listeners.get(record.spec.event);
		if (group) {
			group.records.delete(record);
			if (group.records.size === 0) {
				this.#socket.off(record.spec.event, group.handler);
				this.#listeners.delete(record.spec.event);
			}
		}
		const key = record.spec.membership;
		if (key === undefined) return;
		const membership = this.#memberships.get(key);
		if (!membership) return;
		membership.records.delete(record);
		if (membership.records.size > 0) return;
		this.#memberships.delete(key);
		membership.epoch += 1;
		if (!leave || !membership.leave) return;
		if (membership.state === "joined" && this.#socket.connected) {
			this.#leave(membership);
			return;
		}
		if (membership.state === "idle") return;
		// Leave once the key's joins in flight land. Until then, or
		// while disconnected, the server may hold the room and recovery would
		// restore it.
		this.#retire(membership);
	}

	/**
	 * Hold a key without consumers whose room the server may still hold, at
	 * most one entry per key and MEMBERSHIP_RETIRED_MAX in all. Beyond the
	 * cap nothing is evicted: the connection is flagged `overflowed`,
	 * with one payload-free diagnostic, and while connected it restarts on a
	 * fresh session once the current task's synchronous work is done.
	 */
	#retire(membership: Membership): void {
		if (
			this.#retired.has(membership.key) ||
			this.#retired.size < MEMBERSHIP_RETIRED_MAX
		) {
			this.#retired.set(membership.key, membership);
			return;
		}
		if (this.#overflowed) return;
		this.#overflowed = true;
		this.#ctx.diagnostic({
			type: "membership-cleanup-uncertain",
			detail: { reason: "retired-overflow" },
		});
		if (!this.#socket.connected) return;
		queueMicrotask(() => {
			// A drop meanwhile defers the outcome to the reconnect.
			if (!this.#disposed && this.#overflowed && this.#socket.connected) {
				this.#freshSession();
			}
		});
	}

	/**
	 * A deliberate restart on a fresh session, modelled on
	 * `rotate()`: DISCONNECT ends the server session and its rooms (a client
	 * namespace disconnect is never persisted for recovery), and the next
	 * CONNECT presents no recovery pid or offset, because the server keeps a
	 * restored session until it expires and would restore its rooms again.
	 * Pending commands settle at the disconnect and are never re-sent;
	 * non-repeatable records end `interrupted`; the others are told
	 * `reconnected` once, at the new `connected`, where live keys join once
	 * and the flag and tombstones are cleared.
	 */
	#freshSession(): void {
		this.#restarting = true;
		this.#declineRecovery();
		this.#socket.disconnect();
		this.#endUnrepeatable();
		this.#socket.connect();
	}

	/**
	 * The shared client restarts to reclaim released handles' unanswered
	 * handshakes. Like the fresh session it presents no
	 * recovery pid or offset and a session that was accepted ends its
	 * non-repeatable records `interrupted`; the others are told of the loss
	 * now and of the outcome before the restored `connected` (point 48).
	 */
	#reclaimed(): void {
		this.#declineRecovery();
		this.#ctx.diagnostic({
			type: "membership-cleanup-uncertain",
			detail: { reason: "drain-overflow" },
		});
		if (this.#everConnected) this.#endUnrepeatable();
	}

	/** The fresh-session rule: non-repeatable records end `interrupted`. */
	#endUnrepeatable(): void {
		const ended: ListenerRecord[] = [];
		this.#eachRecord((record) => {
			if (!record.repeatable) ended.push(record);
		});
		for (const record of ended) {
			this.#removeRecord(record);
			record.sink.error({ code: "interrupted", message: RESTARTED });
		}
	}

	/**
	 * The next CONNECT presents no recovery pid or offset: socket.io-client
	 * 4.8.4 `_sendConnectPacket` adds them only while `_pid` is set, and
	 * `onconnect` stores the next session's pid. The offset is cleared too:
	 * upstream updates `_lastOffset` only while `_pid` is set and never resets
	 * it, so the next session's pid would carry this session's cursor and the
	 * server would replay packets already delivered. Every client-initiated
	 * reconnect declines (rotate(), every retry(), the fresh session, a block
	 * that dropped tombstones), and so does a restored session at its connect
	 * and a presented pid whose confirmation the engine's close outran:
	 * socket.io-adapter 2.5.8 keeps a restored session's room snapshot until
	 * it expires and socket.io 4.8.4 restores it on the old sid.
	 */
	#declineRecovery(): void {
		const socket = this.#socket as unknown as {
			_pid?: string;
			_lastOffset?: string;
		};
		socket._pid = undefined;
		socket._lastOffset = undefined;
	}

	/**
	 * Recovery restored the session's rooms: each retired key is left once,
	 * with its acknowledgement timeout, and dropped. Without recovery the
	 * server holds no rooms, so they are dropped without a command. A key
	 * whose buffered join was flushed on this session before `connect` stays
	 * retired: that join's acknowledgement leaves it.
	 */
	#releaseRetired(recovered: boolean): void {
		for (const [key, membership] of this.#retired) {
			if (this.#joinsInFlight.has(key)) continue;
			this.#retired.delete(key);
			if (recovered) this.#leave(membership, true);
		}
	}

	/**
	 * A leave has its own acknowledgement budget as grace. A leave
	 * lost with the transport, timed out unsent in upstream's buffer, or
	 * timed out while connected (a half-open socket before detection)
	 * may not have applied: its key is retired as possibly held, so recovery
	 * leaves it once and a consumer regaining it joins again. A recovery
	 * leave's own connected timeout is not retired again: bounded per connect.
	 */
	#leave(membership: Membership, recovery = false): void {
		if (!membership.leave) return;
		const { key } = membership;
		const { event, args = [] } = membership.leave;
		this.#socket
			.timeout(this.#spec.ackTimeoutMs ?? SOCKET_IO_DEFAULTS.ackTimeoutMs)
			.emit(event, ...args, (error: Error | null) => {
				if (!error) return;
				// Payload-free: a membership key is application data.
				this.#ctx.diagnostic({ type: "socket-io.leave-failed" });
				if (
					this.#disposed ||
					this.#memberships.has(key) ||
					this.#retired.has(key)
				) {
					return;
				}
				if (this.#socket.connected) {
					this.#ctx.diagnostic({
						type: "membership-cleanup-uncertain",
						detail: { reason: "leave-timeout" },
					});
					if (recovery) return;
				}
				membership.state = "joining";
				this.#retire(membership);
			});
	}

	/** Remove a packet the upstream buffered instead of sending (expired session). */
	#dropBuffered(before: number): boolean {
		const buffer = this.#socket.sendBuffer;
		if (buffer.length <= before) return false;
		buffer.splice(before);
		return true;
	}
}

function notSent(message: string): CommandOutcome<unknown> {
	return { status: "not-sent", error: { code: "command-not-sent", message } };
}

function unknown(reason: string, message: string): CommandOutcome<unknown> {
	const error: SerialisedError = {
		code: "command-unknown",
		message,
		detail: { reason },
	};
	return { status: "unknown", error };
}

function jsonOrUndefined(value: unknown): Json | undefined {
	try {
		assertJson(value, "ack");
		return value;
	} catch {
		return undefined;
	}
}
