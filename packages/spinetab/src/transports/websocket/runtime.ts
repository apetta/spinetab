import type {
	AdapterConnection,
	AdapterSubscription,
	AdapterSubscriptionOptions,
	ConnectionContext,
	RuntimeAdapter,
	SubscriptionSink,
} from "../../core/adapter.ts";
import { MAX_TIMER_MS } from "../../core/clock.ts";
import { reportInterruption } from "../../core/continuity-phase.ts";
import { toSerialisedError } from "../../core/errors.ts";
import { stableStringify } from "../../core/identity.ts";
import { isPlainObject } from "../../core/plain-object.ts";
import type {
	CommandOutcome,
	ConnectionReason,
	ConnectionStatus,
	ContinuityReason,
	CredentialRequest,
	Credentials,
	Json,
} from "../../core/types.ts";
import { unsupported } from "../../core/validate.ts";
import { createBackoff } from "../shared/backoff.ts";
import { type BlockedReason, obtainCredentials } from "../shared/http.ts";
import { assertRecord, optionError } from "../shared/options.ts";
import { exceedsUtf8 } from "../shared/utf8.ts";
import {
	validateWebSocketCommand,
	validateWebSocketConnection,
	validateWebSocketSubscription,
	type WebSocketCommandPayload,
	type WebSocketConnectionSpec,
	type WebSocketSubscriptionSpec,
} from "./spec.ts";

export type {
	WebSocketCommandPayload,
	WebSocketConnectionSpec,
	WebSocketSubscriptionSpec,
};

export type WebSocketFrame =
	| string
	| ArrayBuffer
	| ArrayBufferView<ArrayBuffer>;

export type WebSocketDecoded<E = unknown, R = unknown> =
	| { kind: "event"; topics: string[]; event: E }
	| { kind: "ack"; id: string; result?: R; error?: string }
	| {
			kind: "subscribed" | "subscribe-rejected";
			topicKey: string;
			reason?: string;
	  }
	| { kind: "heartbeat" }
	| { kind: "ignore" };

/**
 * Worker-defined application protocol. Every hook runs
 * in the runtime realm; pages reference the protocol by name.
 */
export interface WebSocketProtocol<
	Topic = Json,
	E = unknown,
	P = Json,
	R = unknown,
> {
	/** Synchronous decode of one frame; text arrives as string, binary as ArrayBuffer. */
	decode(raw: string | ArrayBuffer): WebSocketDecoded<E, R>;
	/** Frames sent once per socket when a topic gains its first subscription. */
	subscribe?(topic: Topic, topicKey: string): WebSocketFrame[];
	/** Frames sent once per socket when a topic loses its last subscription. */
	unsubscribe?(topic: Topic, topicKey: string): WebSocketFrame[];
	/** Encode one command with a correlation id unique to this socket. */
	command?(
		payload: P,
		id: string,
	): { frames: WebSocketFrame[]; expectsAck: boolean };
	/**
	 * First-message authentication with the provider's `connectionParams`
	 * only, never the whole credentials object. Not called when the
	 * provider returned no `connectionParams`.
	 */
	authenticate?(connectionParams: Record<string, Json>): WebSocketFrame[];
	/** Declared liveness: an application probe or an inbound expectation. */
	heartbeat?:
		| { intervalMs: number; timeoutMs: number; frame(): WebSocketFrame }
		| { expectInboundWithinMs: number };
	/** Map a server close to transient (default), auth or permanent. */
	classifyClose?(
		code: number,
		reason: string,
	): "transient" | "auth" | "permanent";
	/** Topic key used for routing; default `stableStringify(topic)`. */
	topicKey?(topic: Topic): string;
	/** Oversized inbound frames are dropped with a gap; "close" also closes with 4001. */
	onOversize?: "drop" | "close";
}

export interface WebSocketAdapterOptions {
	// biome-ignore lint/suspicious/noExplicitAny: heterogeneous protocol registry
	protocols?: Record<string, WebSocketProtocol<any, any, any, any>>;
}

/** Adapter-initiated close codes. */
export const CLOSE_LIVENESS = 4000;
export const CLOSE_OVERSIZE = 4001;
/** Default limits. */
export const WEBSOCKET_ACK_TIMEOUT_MS = 10_000;
export const WEBSOCKET_MAX_BUFFERED_BYTES = 1024 * 1024;

/** Commands are never replayed. A WebSocket restart has unknown continuity because the adapter provides no resume contract. */
export function websocketAdapter(
	options: WebSocketAdapterOptions = {},
): RuntimeAdapter<
	WebSocketConnectionSpec,
	WebSocketSubscriptionSpec,
	unknown,
	WebSocketCommandPayload,
	unknown
> {
	assertRecord(options, "websocketAdapter");
	for (const key of Object.keys(options)) {
		if (key !== "protocols") {
			throw optionError(
				`websocketAdapter.${key}`,
				"is not a supported option.",
			);
		}
	}
	const protocols: Record<string, WebSocketProtocol> = {};
	const heartbeats: Record<string, Heartbeat | undefined> = {};
	for (const [name, protocol] of Object.entries(options.protocols ?? {})) {
		heartbeats[name] = validateProtocol(
			protocol,
			`websocketAdapter.protocols.${name}`,
		);
		protocols[name] = protocol;
	}
	return {
		kind: "websocket",
		version: 1,
		validateConnection(spec: unknown): asserts spec is WebSocketConnectionSpec {
			validateWebSocketConnection(spec, { requireAbsolute: true });
			if (
				spec.protocol !== undefined &&
				!Object.hasOwn(protocols, spec.protocol)
			) {
				throw optionError(
					"connection.protocol",
					"is not registered in websocketAdapter({ protocols }).",
				);
			}
		},
		validateSubscription(
			spec: unknown,
		): asserts spec is WebSocketSubscriptionSpec {
			validateWebSocketSubscription(spec);
		},
		connect(spec, ctx) {
			return new WebSocketConnection(
				spec,
				ctx,
				spec.protocol === undefined ? undefined : protocols[spec.protocol],
				spec.protocol === undefined ? undefined : heartbeats[spec.protocol],
			);
		},
	};
}

/** A validated heartbeat: only the probe carries `intervalMs`. */
type Heartbeat = NonNullable<WebSocketProtocol["heartbeat"]>;

/**
 * Validates a protocol and returns its heartbeat shape. The runtime reads
 * only that shape, never the protocol's own `heartbeat`.
 */
function validateProtocol(
	protocol: unknown,
	path: string,
): Heartbeat | undefined {
	if (typeof protocol !== "object" || protocol === null) {
		throw optionError(path, "must be a protocol object.");
	}
	const record = protocol as Record<string, unknown>;
	const allowed = [
		"decode",
		"subscribe",
		"unsubscribe",
		"command",
		"authenticate",
		"heartbeat",
		"classifyClose",
		"topicKey",
		"onOversize",
	];
	for (const key of Object.keys(record)) {
		if (!allowed.includes(key))
			throw optionError(`${path}.${key}`, "is not a supported hook.");
	}
	if (typeof record.decode !== "function") {
		throw optionError(`${path}.decode`, "is required.");
	}
	for (const hook of [
		"subscribe",
		"unsubscribe",
		"command",
		"authenticate",
		"classifyClose",
		"topicKey",
	]) {
		if (record[hook] !== undefined && typeof record[hook] !== "function") {
			throw optionError(`${path}.${hook}`, "must be a function.");
		}
	}
	if (
		record.onOversize !== undefined &&
		record.onOversize !== "drop" &&
		record.onOversize !== "close"
	) {
		throw optionError(`${path}.onOversize`, 'must be "drop" or "close".');
	}
	if (record.heartbeat === undefined) return undefined;
	// The shape is chosen by defined values, never by key presence: a
	// defined intervalMs is the probe, else a defined expectInboundWithinMs is
	// the inbound expectation, else the heartbeat is refused.
	const heartbeat = record.heartbeat as Record<string, unknown> | null;
	const positive = (value: unknown) =>
		typeof value === "number" && Number.isInteger(value) && value > 0;
	const shapeError = () =>
		optionError(
			`${path}.heartbeat`,
			"must be { intervalMs, timeoutMs, frame() } or { expectInboundWithinMs }.",
		);
	let shape: Heartbeat;
	if (heartbeat?.intervalMs !== undefined) {
		if (
			!positive(heartbeat.intervalMs) ||
			!positive(heartbeat.timeoutMs) ||
			typeof heartbeat.frame !== "function"
		) {
			throw shapeError();
		}
		// The application's object, so frame() keeps its receiver.
		shape = heartbeat as Heartbeat;
	} else if (heartbeat?.expectInboundWithinMs !== undefined) {
		if (!positive(heartbeat.expectInboundWithinMs)) throw shapeError();
		// A fresh object, so no `intervalMs` key reaches the runtime.
		shape = {
			expectInboundWithinMs: heartbeat.expectInboundWithinMs as number,
		};
	} else {
		throw shapeError();
	}
	// Host timers cannot wait longer than MAX_TIMER_MS; a longer delay
	// runs at once. Same sentence as the page's timing options.
	for (const key of ["intervalMs", "timeoutMs", "expectInboundWithinMs"]) {
		const value = heartbeat[key];
		if (typeof value === "number" && value > MAX_TIMER_MS) {
			throw unsupported(
				`${path}.heartbeat.${key}`,
				`must be an integer between 1 and ${MAX_TIMER_MS}.`,
			);
		}
	}
	return shape;
}

interface Sub {
	sink: SubscriptionSink<unknown>;
	repeatable: boolean;
}

interface Topic {
	key: string;
	topic: Json;
	subs: Set<Sub>;
	wire: "none" | "subscribed" | "rejected";
}

interface PendingCommand {
	settle(outcome: CommandOutcome<unknown>): void;
}

type Phase =
	| "idle"
	| "connecting"
	| "open"
	| "waiting"
	| "blocked"
	| "exhausted"
	| "failed"
	| "disposed";

type LossCause = "server" | "liveness" | "oversize" | "reopen";

const notSent = (reason: string, message: string): CommandOutcome<never> => ({
	status: "not-sent",
	error: { code: "command-not-sent", message, detail: { reason } },
});

const unknownOutcome = (
	reason: "timeout" | "disconnected" | "aborted",
): CommandOutcome<never> => ({
	status: "unknown",
	error: {
		code: "command-unknown",
		message:
			reason === "timeout"
				? "No acknowledgement arrived in time; the command may have been processed."
				: reason === "aborted"
					? "Stopped waiting after the command was written; it may have been processed."
					: "The socket closed before an acknowledgement; the command may have been processed.",
		detail: { reason },
	},
});

class WebSocketConnection
	implements
		AdapterConnection<
			WebSocketSubscriptionSpec,
			unknown,
			WebSocketCommandPayload,
			unknown
		>
{
	private phase: Phase = "idle";
	private socket: WebSocket | undefined;
	/** Fences handlers of superseded sockets. */
	private generation = 0;
	/** Commands and subscribe frames go only to a ready (open, authenticated) socket. */
	private ready = false;
	private readonly topics = new Map<string, Topic>();
	/** Connection-scoped subscriptions (no topic). */
	private readonly feed = new Set<Sub>();
	/** Subscriptions live when the socket was lost; owed the outcome once open again. */
	private readonly lost = new Set<Sub>();
	/** Subscriptions already told of the current loss; cleared once open again. */
	private readonly cut = new Set<Sub>();
	private pendingRestart: "reconnected" | "reopened" | undefined;
	private pending = new Map<string, PendingCommand>();
	private commandCounter = 0;
	private readonly backoff = createBackoff();
	private retryTimer: ReturnType<typeof setTimeout> | undefined;
	private heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
	private probeTimer: ReturnType<typeof setTimeout> | undefined;
	private probeSentAt = 0;
	private lastInbound = 0;
	private reconcileQueued = false;
	private credentialReason: CredentialRequest["reason"] = "connect";
	/** The grant whose `connectionParams` authenticated the current socket. */
	private sentCredentials: Credentials | undefined;
	/**
	 * Whether this identity ever authenticated a socket: a later grant without
	 * `connectionParams` then blocks `credentials-missing` instead of opening
	 * an unauthenticated socket for the group (no downgrade).
	 */
	private authenticatedBefore = false;

	private readonly spec: WebSocketConnectionSpec;
	private readonly ctx: ConnectionContext;
	private readonly protocol: WebSocketProtocol | undefined;
	/** The validated heartbeat shape, never `protocol.heartbeat`. */
	private readonly heartbeat: Heartbeat | undefined;

	constructor(
		spec: WebSocketConnectionSpec,
		ctx: ConnectionContext,
		protocol: WebSocketProtocol | undefined,
		heartbeat: Heartbeat | undefined,
	) {
		this.spec = spec;
		this.ctx = ctx;
		this.protocol = protocol;
		this.heartbeat = heartbeat;
	}

	subscribe(
		spec: WebSocketSubscriptionSpec,
		sink: SubscriptionSink<unknown>,
		options: AdapterSubscriptionOptions,
	): AdapterSubscription {
		const sub: Sub = { sink, repeatable: options.repeatable };
		let remove: () => void;
		if (spec.topic === undefined) {
			this.feed.add(sub);
			remove = () => this.feed.delete(sub);
		} else {
			if (!this.protocol) {
				sink.error({
					code: "unsupported-option",
					message:
						"subscription.topic: topics need a worker protocol with routing.",
					detail: { path: "subscription.topic" },
				});
				return { unsubscribe() {} };
			}
			let key: string;
			try {
				key = this.protocol.topicKey
					? this.protocol.topicKey(spec.topic)
					: stableStringify(spec.topic, "subscription.topic");
			} catch (error) {
				sink.error(toSerialisedError(error, "unsupported-option"));
				return { unsubscribe() {} };
			}
			let topic = this.topics.get(key);
			if (!topic || topic.wire === "rejected") {
				topic = { key, topic: spec.topic, subs: new Set(), wire: "none" };
				this.topics.set(key, topic);
			}
			const entry = topic;
			entry.subs.add(sub);
			remove = () => entry.subs.delete(sub);
		}
		this.ensureOpen();
		this.scheduleReconcile();
		let active = true;
		return {
			unsubscribe: () => {
				if (!active) return;
				active = false;
				remove();
				this.lost.delete(sub);
				this.cut.delete(sub);
				this.scheduleReconcile();
			},
		};
	}

	command(
		payload: WebSocketCommandPayload,
		options: { id: string; signal: AbortSignal; timeoutMs: number },
	): Promise<CommandOutcome<unknown>> {
		try {
			validateWebSocketCommand(payload);
		} catch (error) {
			const record = toSerialisedError(error, "unsupported-option");
			return Promise.resolve(notSent("invalid", record.message));
		}
		if (options.signal.aborted) {
			return Promise.resolve(
				notSent("aborted", "Cancelled before it was written."),
			);
		}
		const socket = this.socket;
		if (!socket || !this.ready || socket.readyState !== 1) {
			this.ensureOpen();
			return Promise.resolve(
				notSent(
					"not-connected",
					"The socket is not open; nothing was written.",
				),
			);
		}
		if (this.pending.size >= this.ctx.limits.maxPendingCommands) {
			return Promise.resolve(
				notSent(
					"limit-exceeded",
					"Too many commands are awaiting acknowledgement.",
				),
			);
		}
		if (socket.bufferedAmount > WEBSOCKET_MAX_BUFFERED_BYTES) {
			return Promise.resolve(
				notSent("backpressure", "The socket's outbound buffer is full."),
			);
		}
		this.commandCounter += 1;
		const wireId = `${this.generation}.${this.commandCounter}`;
		let frames: WebSocketFrame[];
		let expectsAck: boolean;
		try {
			if (this.protocol?.command) {
				const encoded = this.protocol.command(payload.data, wireId);
				frames = encoded.frames;
				expectsAck = payload.expectsAck ?? encoded.expectsAck;
			} else if (this.protocol) {
				return Promise.resolve(
					notSent("unsupported", "The protocol defines no command hook."),
				);
			} else {
				frames = [
					typeof payload.data === "string"
						? payload.data
						: JSON.stringify(payload.data),
				];
				expectsAck = false;
			}
		} catch {
			return Promise.resolve(
				notSent(
					"not-serialisable",
					"The protocol could not encode the command.",
				),
			);
		}
		const limit = this.ctx.limits.maxMessageBytes;
		for (const frame of frames) {
			if (frameBytes(frame, limit) > limit) {
				return Promise.resolve(
					notSent("limit-exceeded", `A command frame exceeds ${limit} bytes.`),
				);
			}
		}
		for (const frame of frames) socket.send(frame);
		if (!expectsAck) return Promise.resolve({ status: "sent" });
		return new Promise((resolve) => {
			let settled = false;
			const timeoutMs = Math.min(WEBSOCKET_ACK_TIMEOUT_MS, options.timeoutMs);
			const settle = (outcome: CommandOutcome<unknown>) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				options.signal.removeEventListener("abort", onAbort);
				this.pending.delete(wireId);
				resolve(outcome);
			};
			const timer = setTimeout(
				() => settle(unknownOutcome("timeout")),
				timeoutMs,
			);
			const onAbort = () => settle(unknownOutcome("aborted"));
			options.signal.addEventListener("abort", onAbort);
			this.pending.set(wireId, { settle });
		});
	}

	probe(): void {
		if (this.phase === "waiting") {
			void this.open();
		} else if (this.phase === "exhausted") {
			this.backoff.reset();
			void this.open();
		} else if (this.phase === "open") {
			const heartbeat = this.heartbeat;
			if (heartbeat && "intervalMs" in heartbeat) {
				this.sendProbe();
			} else if (heartbeat) {
				this.checkInbound();
			} else if (this.hasWork() && this.allRepeatable()) {
				// Reopen on return even if the browser has not reported a close.
				this.pendingRestart = "reopened";
				this.lose(1000, "reopen", "reopen");
			}
		}
	}

	retry(): void {
		if (
			this.phase === "exhausted" ||
			this.phase === "failed" ||
			this.phase === "blocked" ||
			this.phase === "waiting"
		) {
			this.backoff.reset();
			this.credentialReason = "retry";
			void this.open();
		}
	}

	rotate(): void {
		// Rotation applies at the next connect; only a blocked
		// connection restarts immediately with the new revision.
		if (this.phase === "blocked") {
			this.backoff.reset();
			this.credentialReason = "rotated";
			void this.open();
		}
	}

	dispose(): void {
		if (this.phase === "disposed") return;
		this.closeSocket(1000, "disposed");
		this.clearTimers();
		this.phase = "disposed";
		this.settlePending();
		this.topics.clear();
		this.feed.clear();
		this.lost.clear();
		this.cut.clear();
	}

	private hasWork(): boolean {
		if (this.feed.size > 0) return true;
		for (const topic of this.topics.values())
			if (topic.subs.size > 0) return true;
		return false;
	}

	private allRepeatable(): boolean {
		for (const sub of this.allSubs()) if (!sub.repeatable) return false;
		return true;
	}

	private *allSubs(): Generator<Sub> {
		yield* this.feed;
		for (const topic of this.topics.values()) yield* topic.subs;
	}

	private setStatus(status: Omit<ConnectionStatus, "since">): void {
		if (this.phase !== "disposed") this.ctx.setStatus(status);
	}

	private ensureOpen(): void {
		if (this.phase === "idle") {
			this.backoff.reset();
			void this.open();
		}
	}

	private clearTimers(): void {
		for (const timer of [
			this.retryTimer,
			this.heartbeatTimer,
			this.probeTimer,
		]) {
			if (timer !== undefined) clearTimeout(timer);
		}
		this.retryTimer = undefined;
		this.heartbeatTimer = undefined;
		this.probeTimer = undefined;
	}

	/** Detach and close the current socket without waiting for its close event. */
	private closeSocket(code: number, reason: string): void {
		this.generation += 1;
		this.ready = false;
		const socket = this.socket;
		this.socket = undefined;
		if (!socket) return;
		socket.onopen = null;
		socket.onmessage = null;
		socket.onerror = null;
		socket.onclose = null;
		try {
			if (socket.readyState === 0 || socket.readyState === 1)
				socket.close(code, reason);
		} catch {
			// close() never throws for the codes used here; stay defensive.
		}
	}

	private settlePending(): void {
		const pending = [...this.pending.values()];
		this.pending.clear();
		for (const command of pending)
			command.settle(unknownOutcome("disconnected"));
	}

	private async open(): Promise<void> {
		this.closeSocket(1000, "superseded");
		this.clearTimers();
		const current = this.generation;
		// Backoff-scheduled attempts keep their `reconnecting` status.
		if (this.phase !== "waiting") this.setStatus({ state: "connecting" });
		this.phase = "connecting";
		let credentials: Credentials | undefined;
		if (this.protocol?.authenticate) {
			const outcome = await obtainCredentials(
				this.ctx,
				this.credentialReason,
				this.spec.url,
			);
			// The phase may have changed while awaiting credentials.
			if (current !== this.generation || (this.phase as Phase) === "disposed")
				return;
			if (outcome.kind === "aborted") return;
			if (outcome.kind === "blocked") {
				this.block(outcome.reason);
				return;
			}
			credentials = outcome.credentials;
			if (
				this.authenticatedBefore &&
				!isPlainObject(credentials?.connectionParams)
			) {
				this.block("credentials-missing");
				return;
			}
		}
		this.credentialReason = "reconnect";
		const Socket = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
		if (typeof Socket !== "function") {
			this.phase = "failed";
			this.reportLoss();
			this.setStatus({
				state: "failed",
				reason: "permanent-error",
				code: "websocket-unavailable",
			});
			return;
		}
		let socket: WebSocket;
		try {
			socket = new Socket(this.spec.url, this.spec.subprotocols ?? []);
		} catch {
			this.phase = "failed";
			this.reportLoss();
			this.setStatus({
				state: "failed",
				reason: "permanent-error",
				code: "invalid-url",
			});
			return;
		}
		socket.binaryType = this.spec.binaryType ?? "arraybuffer";
		this.socket = socket;
		socket.onopen = () => {
			if (current !== this.generation) return;
			this.onOpen(socket, credentials);
		};
		socket.onmessage = (event: MessageEvent) => {
			if (current !== this.generation) return;
			this.onMessage(event.data);
		};
		// `error` is always followed by `close`; transitions happen on close only.
		socket.onerror = null;
		socket.onclose = (event: CloseEvent) => {
			if (current !== this.generation) return;
			this.onClose(event.code, event.reason, event.wasClean);
		};
	}

	private onOpen(
		socket: WebSocket,
		credentials: Credentials | undefined,
	): void {
		const params = credentials?.connectionParams;
		this.sentCredentials = undefined;
		if (isPlainObject(params) && this.protocol?.authenticate) {
			let frames: WebSocketFrame[];
			try {
				frames = this.protocol.authenticate(params as Record<string, Json>);
			} catch {
				this.lose(1000, "authentication encoding failed", "server");
				return;
			}
			for (const frame of frames) socket.send(frame);
			this.sentCredentials = credentials;
			this.authenticatedBefore = true;
		}
		this.ready = true;
		this.phase = "open";
		this.lastInbound = this.ctx.now();
		this.backoff.connected(this.ctx.now());
		// The reconnect outcome precedes `connected` for every subscription live
		// at the loss, whether or not it was told early.
		const outcome: ContinuityReason = this.pendingRestart ?? "reconnected";
		this.pendingRestart = undefined;
		const lost = [...this.lost];
		this.lost.clear();
		this.cut.clear();
		for (const sub of lost) sub.sink.continuity(outcome);
		this.setStatus({ state: "connected" });
		this.ctx.diagnostic({
			type: "websocket-open",
			detail: { protocol: socket.protocol },
		});
		for (const topic of this.topics.values()) {
			if (topic.wire === "subscribed") topic.wire = "none";
		}
		// Liveness first: no reconcile outcome may leave the socket unwatched.
		this.armLiveness();
		this.reconcile();
	}

	private onMessage(raw: unknown): void {
		this.lastInbound = this.ctx.now();
		const limit = this.ctx.limits.maxMessageBytes;
		const size = inboundBytes(raw, limit);
		if (size === undefined) return;
		if (size > limit) {
			// Never delivered, truncated or split.
			this.ctx.diagnostic({
				type: "oversized-frame",
				detail: { bytes: size, limit },
			});
			for (const sub of this.allSubs())
				sub.sink.continuity("message-too-large");
			if (this.protocol?.onOversize === "close") {
				this.lose(CLOSE_OVERSIZE, "message too large", "oversize");
			}
			return;
		}
		if (!this.protocol) {
			let value: unknown = raw;
			if (this.spec.decoder === "json") {
				try {
					value = JSON.parse(
						typeof raw === "string" ? raw : utf8(raw as ArrayBuffer),
					);
				} catch {
					this.ctx.diagnostic({ type: "decode-error" });
					for (const sub of [...this.feed]) sub.sink.continuity("decode-error");
					return;
				}
			}
			for (const sub of [...this.feed]) sub.sink.next(value);
			return;
		}
		let decoded: WebSocketDecoded;
		try {
			decoded = this.protocol.decode(raw as string | ArrayBuffer);
		} catch {
			this.ctx.diagnostic({ type: "decode-error" });
			for (const sub of this.allSubs()) sub.sink.continuity("decode-error");
			return;
		}
		switch (decoded.kind) {
			case "event":
				this.route(decoded.topics, decoded.event);
				return;
			case "ack": {
				const command = this.pending.get(decoded.id);
				if (!command) {
					this.ctx.diagnostic({ type: "late-reply" });
					return;
				}
				command.settle(
					decoded.error === undefined
						? { status: "acknowledged", value: decoded.result }
						: {
								status: "rejected",
								error: { code: "command-rejected", message: decoded.error },
							},
				);
				return;
			}
			case "subscribe-rejected": {
				const topic = this.topics.get(decoded.topicKey);
				if (topic?.wire !== "subscribed") return;
				this.rejectTopic(
					topic,
					decoded.reason ?? "The server rejected the subscription.",
				);
				return;
			}
			case "heartbeat":
				if (this.probeTimer !== undefined) clearTimeout(this.probeTimer);
				this.probeTimer = undefined;
				return;
			default:
				return;
		}
	}

	private route(keys: string[], event: unknown): void {
		const targets = new Set<Sub>(this.feed);
		for (const key of keys) {
			const topic = this.topics.get(key);
			if (topic) for (const sub of topic.subs) targets.add(sub);
		}
		if (targets.size === 0) {
			this.ctx.diagnostic({ type: "unrouted" });
			return;
		}
		for (const sub of targets) sub.sink.next(event);
	}

	private onClose(code: number, reason: string, wasClean: boolean): void {
		this.ctx.diagnostic({
			type: "websocket-close",
			detail: { code, wasClean },
		});
		let classification: "transient" | "auth" | "permanent" = "transient";
		try {
			classification =
				this.protocol?.classifyClose?.(code, reason) ?? "transient";
		} catch {
			// A close the hook cannot classify is transient.
			this.hookFailed("classifyClose");
		}
		if (classification === "auth") {
			this.teardownLost();
			// Only the grant that authenticated this socket; codes only.
			if (this.sentCredentials)
				this.ctx.rejectCredentials(this.sentCredentials);
			this.block("credentials-rejected", `close:${code}`);
			return;
		}
		if (classification === "permanent") {
			this.teardownLost();
			this.phase = "failed";
			this.setStatus({ state: "failed", reason: "permanent-error", code });
			return;
		}
		this.afterLoss("server", code);
	}

	/** Adapter-initiated loss: close with a valid code and continue without waiting. */
	private lose(code: number, reason: string, cause: LossCause): void {
		this.closeSocket(code, reason);
		this.afterLoss(cause, code);
	}

	private teardownLost(deliberate = false): void {
		const wasOpen = this.phase === "open";
		this.closeSocket(1000, "closed");
		this.clearTimers();
		this.settlePending();
		for (const topic of this.topics.values()) {
			if (topic.wire === "subscribed") topic.wire = "none";
		}
		if (wasOpen) {
			this.pendingRestart ??= "reconnected";
			for (const sub of this.allSubs()) this.lost.add(sub);
		}
		// No resume hook: continuity is unknown from the moment a loss is
		// detected, reported once before any status says so. A
		// deliberate reopen reports only its outcome, unless the reopen fails.
		if (!deliberate) this.reportLoss();
	}

	/** The early notice, once per loss, to lost subscriptions not yet told. */
	private reportLoss(): void {
		const reason = this.pendingRestart;
		if (reason === undefined) return;
		for (const sub of [...this.lost]) {
			if (this.cut.has(sub)) continue;
			this.cut.add(sub);
			reportInterruption(sub.sink, reason);
		}
	}

	private afterLoss(cause: LossCause, code: number): void {
		this.teardownLost(cause === "reopen");
		if (!this.hasWork()) {
			// A close with nothing subscribed is idle, not a failure.
			this.phase = "idle";
			this.setStatus({ state: "inactive", reason: "idle", code });
			return;
		}
		if (cause === "reopen") {
			void this.open();
			return;
		}
		const reason: ConnectionReason =
			cause === "liveness"
				? "heartbeat-timeout"
				: code === 1006
					? "network"
					: "server-closed";
		const step = this.backoff.fail(this.ctx.now());
		if (step.kind === "exhausted") {
			this.phase = "exhausted";
			this.setStatus({ state: "retry-exhausted", reason: step.reason, code });
			return;
		}
		this.phase = "waiting";
		this.setStatus({
			state: "reconnecting",
			reason,
			code,
			attempt: step.attempt,
			retryAt: Date.now() + step.delayMs,
		});
		this.retryTimer = setTimeout(() => {
			this.retryTimer = undefined;
			void this.open();
		}, step.delayMs);
	}

	/** `credentials-audience` is permanent: rotation never restarts it. */
	private block(reason: BlockedReason, code?: string): void {
		this.closeSocket(1000, "blocked");
		this.clearTimers();
		this.phase = reason === "credentials-audience" ? "failed" : "blocked";
		// A reopen that ends here was not told early.
		this.reportLoss();
		this.setStatus(
			code === undefined
				? { state: "auth-blocked", reason }
				: { state: "auth-blocked", reason, code },
		);
	}

	private scheduleReconcile(): void {
		if (this.reconcileQueued) return;
		this.reconcileQueued = true;
		queueMicrotask(() => {
			this.reconcileQueued = false;
			this.reconcile();
		});
	}

	/**
	 * Bring the wire in line with intent: at most one
	 * subscribe per topic per socket, one unsubscribe when the last
	 * subscription leaves, nothing for a leave-and-rejoin that nets to zero.
	 */
	private reconcile(): void {
		if (this.phase === "disposed") return;
		const socket = this.socket;
		const ready = this.ready && socket !== undefined && socket.readyState === 1;
		for (const topic of [...this.topics.values()]) {
			const desired = topic.subs.size > 0;
			if (!ready) {
				if (!desired) this.topics.delete(topic.key);
				continue;
			}
			if (desired && topic.wire === "none") {
				let frames: WebSocketFrame[];
				try {
					frames = [
						...(this.protocol?.subscribe?.(topic.topic, topic.key) ?? []),
					];
				} catch {
					// Only this topic ends, as a rejection that is never retried; the other topics carry on.
					this.hookFailed("subscribe");
					this.rejectTopic(
						topic,
						"The protocol could not encode the subscription.",
					);
					continue;
				}
				topic.wire = "subscribed";
				for (const frame of frames) socket.send(frame);
			} else if (!desired) {
				this.topics.delete(topic.key);
				if (topic.wire === "subscribed") {
					let frames: WebSocketFrame[];
					try {
						frames = [
							...(this.protocol?.unsubscribe?.(topic.topic, topic.key) ?? []),
						];
					} catch {
						// No subscription is left to end; the other topics carry on.
						this.hookFailed("unsubscribe");
						continue;
					}
					for (const frame of frames) socket.send(frame);
				}
			}
		}
	}

	/** End a topic's subscriptions with `subscribe-rejected`; never retried. */
	private rejectTopic(topic: Topic, message: string): void {
		topic.wire = "rejected";
		this.topics.delete(topic.key);
		const subs = [...topic.subs];
		topic.subs.clear();
		for (const sub of subs) {
			this.lost.delete(sub);
			this.cut.delete(sub);
			sub.sink.error({ code: "subscribe-rejected", message });
		}
	}

	/** A protocol hook threw: a diagnostic naming the hook only. */
	private hookFailed(hook: string): void {
		this.ctx.diagnostic({ type: "protocol-hook-error", detail: { hook } });
	}

	private armLiveness(): void {
		const heartbeat = this.heartbeat;
		if (!heartbeat) return;
		if ("intervalMs" in heartbeat) {
			this.heartbeatTimer = setTimeout(() => {
				this.heartbeatTimer = undefined;
				this.sendProbe();
				// A probe that could not be built lost the socket.
				if (this.phase === "open") this.armLiveness();
			}, heartbeat.intervalMs);
		} else {
			const remaining = Math.max(
				heartbeat.expectInboundWithinMs - (this.ctx.now() - this.lastInbound),
				0,
			);
			this.heartbeatTimer = setTimeout(() => {
				this.heartbeatTimer = undefined;
				this.checkInbound();
			}, remaining);
		}
	}

	private sendProbe(): void {
		const heartbeat = this.heartbeat;
		const socket = this.socket;
		if (!heartbeat || !("intervalMs" in heartbeat) || !socket || !this.ready)
			return;
		if (this.probeTimer !== undefined) return;
		let frame: WebSocketFrame;
		try {
			frame = heartbeat.frame();
		} catch {
			// A probe that cannot be built proves nothing: a liveness failure.
			this.hookFailed("heartbeat.frame");
			this.livenessFailed(heartbeat.timeoutMs);
			return;
		}
		socket.send(frame);
		this.probeSentAt = this.ctx.now();
		const expire = () => {
			this.probeTimer = undefined;
			// Suspension is not proof of failure: re-arm on executable time.
			const elapsed = this.ctx.now() - this.probeSentAt;
			if (elapsed < heartbeat.timeoutMs) {
				this.probeTimer = setTimeout(expire, heartbeat.timeoutMs - elapsed);
				return;
			}
			this.livenessFailed(heartbeat.timeoutMs);
		};
		this.probeTimer = setTimeout(expire, heartbeat.timeoutMs);
	}

	private checkInbound(): void {
		const heartbeat = this.heartbeat;
		if (!heartbeat || "intervalMs" in heartbeat || this.phase !== "open")
			return;
		if (this.ctx.now() - this.lastInbound < heartbeat.expectInboundWithinMs) {
			if (this.heartbeatTimer === undefined) this.armLiveness();
			return;
		}
		this.livenessFailed(heartbeat.expectInboundWithinMs);
	}

	private livenessFailed(within: number): void {
		this.ctx.diagnostic({ type: "heartbeat-missed", detail: { within } });
		this.lose(CLOSE_LIVENESS, "liveness", "liveness");
	}
}

let textDecoder: TextDecoder | undefined;
/** UTF-8 text of a binary frame; invalid sequences fail the JSON parse after. */
function utf8(buffer: ArrayBuffer): string {
	textDecoder ??= new TextDecoder("utf-8", { fatal: true });
	return textDecoder.decode(buffer);
}

/** Inbound unit size; `undefined` for unsupported frame types. */
function inboundBytes(raw: unknown, limit: number): number | undefined {
	if (typeof raw === "string")
		return exceedsUtf8(raw, limit) ? limit + 1 : raw.length;
	if (raw instanceof ArrayBuffer) return raw.byteLength;
	if (typeof Blob !== "undefined" && raw instanceof Blob) return raw.size;
	return undefined;
}

function frameBytes(frame: WebSocketFrame, limit: number): number {
	if (typeof frame === "string")
		return exceedsUtf8(frame, limit) ? limit + 1 : frame.length;
	return frame.byteLength;
}
