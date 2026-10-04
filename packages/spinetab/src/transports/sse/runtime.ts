import type {
	AdapterConnection,
	AdapterSubscription,
	AdapterSubscriptionOptions,
	ConnectionContext,
	RuntimeAdapter,
	SinkNextMeta,
	SubscriptionSink,
} from "../../core/adapter.ts";
import { reportInterruption } from "../../core/continuity-phase.ts";
import { SpinetabError, toSerialisedError } from "../../core/errors.ts";
import { stableStringify, uniqueKey } from "../../core/identity.ts";
import type { ContinuityReason, SerialisedError } from "../../core/types.ts";
import { type Backoff, createBackoff } from "../shared/backoff.ts";
import { isEventStream, mergeHeaders } from "../shared/http.ts";
import {
	createHttpStream,
	type HttpStream,
	type RestartKind,
} from "../shared/http-stream.ts";
import { assertRecord, optionError } from "../shared/options.ts";
import { parseServerSentEvents, type ServerSentEvent } from "./parser.ts";
import {
	canonicalSseConnection,
	checkSubscriptionAgainst,
	DEFAULT_SSE_DECODER,
	isSseRepeatable,
	type SseConnectionSpec,
	type SseSubscriptionSpec,
	validateSseConnection,
	validateSseSubscription,
} from "./spec.ts";

export {
	parseServerSentEvents,
	type ServerSentEvent,
	type ServerSentEventParser,
	type ServerSentEventParserOptions,
} from "./parser.ts";
export type { SseConnectionSpec, SseSubscriptionSpec };

/**
 * Worker-side decoder: turns event data into the delivered value.
 * A throw is a `decode-error`: a gap for that event; the stream continues.
 */
export type SseDecoder = (
	data: string,
	event: { type: string; id: string | null },
) => unknown;

/**
 * Worker-side hook placing a cursor into a request URL. The result must keep
 * the connection's origin and carry no userinfo; otherwise the
 * connection fails with `unsupported-option`.
 */
export type SseResumeUrl = (url: URL, cursor: string) => string | URL;

export interface SseAdapterOptions {
	decoders?: Record<string, SseDecoder>;
	resumeUrls?: Record<string, SseResumeUrl>;
}

/** `retry:` values are clamped to this range. */
export const SSE_RETRY_MIN_MS = 250;
export const SSE_RETRY_MAX_MS = 60_000;

const BUILT_IN_DECODERS: Record<string, SseDecoder> = {
	text: (data) => data,
	json: (data) => JSON.parse(data),
};

let utf8Encoder: TextEncoder | undefined;

const isHttpWhitespace = (unit: number) =>
	unit === 0x09 || unit === 0x0a || unit === 0x0d || unit === 0x20;

/**
 * The cursor as a `Last-Event-ID` value: its UTF-8 bytes,
 * one code unit per byte, which fetch sends unchanged as a ByteString.
 * `undefined` when a header cannot carry the cursor exactly: fetch strips
 * leading and trailing HTTP whitespace and refuses NUL, CR and LF.
 */
function lastEventIdValue(cursor: string): string | undefined {
	if (
		isHttpWhitespace(cursor.charCodeAt(0)) ||
		isHttpWhitespace(cursor.charCodeAt(cursor.length - 1))
	) {
		return undefined;
	}
	utf8Encoder ??= new TextEncoder();
	let value = "";
	for (const byte of utf8Encoder.encode(cursor)) {
		if (byte === 0x00 || byte === 0x0a || byte === 0x0d) return undefined;
		value += String.fromCharCode(byte);
	}
	return value;
}

type SubscribeOptions = AdapterSubscriptionOptions & {
	/** Last delivered event ID re-registered after runtime replacement. */
	readonly cursor?: string;
};

interface Sub {
	event: string;
	sink: SubscriptionSink<unknown>;
	cursor: string | undefined;
}

/** EventSource owns reconnection in native mode; fetch mode owns its retry loop and parser. Event names do not split the shared stream. */
export function sseAdapter(
	options: SseAdapterOptions = {},
): RuntimeAdapter<SseConnectionSpec, SseSubscriptionSpec, unknown> {
	assertRecord(options, "sseAdapter");
	for (const key of Object.keys(options)) {
		if (key !== "decoders" && key !== "resumeUrls") {
			throw optionError(`sseAdapter.${key}`, "is not a supported option.");
		}
	}
	const decoders: Record<string, SseDecoder> = { ...BUILT_IN_DECODERS };
	for (const [name, decoder] of Object.entries(options.decoders ?? {})) {
		if (typeof decoder !== "function") {
			throw optionError(`sseAdapter.decoders.${name}`, "must be a function.");
		}
		if (Object.hasOwn(BUILT_IN_DECODERS, name)) {
			throw optionError(
				`sseAdapter.decoders.${name}`,
				"is a built-in decoder name.",
			);
		}
		decoders[name] = decoder;
	}
	const resumeUrls: Record<string, SseResumeUrl> = {};
	for (const [name, hook] of Object.entries(options.resumeUrls ?? {})) {
		if (typeof hook !== "function") {
			throw optionError(`sseAdapter.resumeUrls.${name}`, "must be a function.");
		}
		resumeUrls[name] = hook;
	}

	return {
		kind: "sse",
		version: 1,
		validateConnection(spec: unknown): asserts spec is SseConnectionSpec {
			validateSseConnection(spec, { requireAbsolute: true });
			const decoder = spec.decoder ?? DEFAULT_SSE_DECODER;
			if (!Object.hasOwn(decoders, decoder)) {
				throw optionError(
					"connection.decoder",
					"is not registered in sseAdapter({ decoders }).",
				);
			}
			const resume = spec.resume;
			if (
				typeof resume === "object" &&
				"url" in resume &&
				!Object.hasOwn(resumeUrls, resume.url)
			) {
				throw optionError(
					"connection.resume.url",
					"is not registered in sseAdapter({ resumeUrls }).",
				);
			}
		},
		validateSubscription(spec: unknown): asserts spec is SseSubscriptionSpec {
			validateSseSubscription(spec);
		},
		connectionKey(spec) {
			// Non-repeatable streams are never shared. An omitted
			// mode keys as "fetch" and an omitted decoder as "json".
			return isSseRepeatable(spec)
				? stableStringify(canonicalSseConnection(spec))
				: uniqueKey();
		},
		connect(spec, ctx) {
			return new SseConnection(
				spec,
				ctx,
				decoders[spec.decoder ?? DEFAULT_SSE_DECODER] as SseDecoder,
				resumeUrls,
			);
		},
	};
}

class SseConnection implements AdapterConnection<SseSubscriptionSpec, unknown> {
	private readonly subs = new Set<Sub>();
	private readonly byEvent = new Map<string, Set<Sub>>();
	/** Subscriptions live when the stream ended; owed the outcome once live again. */
	private readonly lost = new Set<Sub>();
	/** Subscriptions already told of the current loss; cleared once live again. */
	private readonly cut = new Set<Sub>();
	private readonly repeatable: boolean;
	private readonly backoff: Backoff = createBackoff();
	private readonly driver: EventSourceDriver | HttpStream;
	/** Last event ID, retained across reconnects for SSE replay. */
	private cursor = "";
	/** Cursor conveyed by the request currently opening. */
	private conveyed: string | undefined;
	private disposed = false;

	private readonly spec: SseConnectionSpec;
	private readonly ctx: ConnectionContext;
	private readonly decode: SseDecoder;
	private readonly resumeUrls: Record<string, SseResumeUrl>;

	constructor(
		spec: SseConnectionSpec,
		ctx: ConnectionContext,
		decode: SseDecoder,
		resumeUrls: Record<string, SseResumeUrl>,
	) {
		this.spec = spec;
		this.ctx = ctx;
		this.decode = decode;
		this.resumeUrls = resumeUrls;
		this.repeatable = isSseRepeatable(spec);
		if (spec.mode === "eventsource") {
			this.driver = new EventSourceDriver(this, spec, ctx, this.backoff);
		} else {
			this.driver = this.createFetchDriver();
		}
	}

	subscribe(
		spec: SseSubscriptionSpec,
		sink: SubscriptionSink<unknown>,
		options: SubscribeOptions,
	): AdapterSubscription {
		let event: string;
		try {
			event = checkSubscriptionAgainst(this.spec, spec);
		} catch (error) {
			sink.error(toSerialisedError(error, "unsupported-option"));
			return { unsubscribe() {} };
		}
		const sub: Sub = { event, sink, cursor: options.cursor || undefined };
		const first = this.subs.size === 0;
		if (first && this.cursor === "" && sub.cursor) {
			// Runtime replacement: the first re-registered cursor opens the stream.
			this.cursor = sub.cursor;
		}
		this.subs.add(sub);
		let listeners = this.byEvent.get(event);
		if (!listeners) {
			listeners = new Set();
			this.byEvent.set(event, listeners);
			if (this.driver instanceof EventSourceDriver) this.driver.listen(event);
		}
		listeners.add(sub);
		if (first) this.driver.start();
		let active = true;
		return {
			unsubscribe: () => {
				if (!active) return;
				active = false;
				this.remove(sub);
			},
		};
	}

	probe(): void {
		this.driver.probe();
	}

	retry(): void {
		this.driver.retry();
	}

	rotate(): void {
		this.driver.rotate();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.driver.dispose();
		this.subs.clear();
		this.byEvent.clear();
		this.lost.clear();
		this.cut.clear();
	}

	private remove(sub: Sub): void {
		if (!this.subs.delete(sub)) return;
		this.lost.delete(sub);
		this.cut.delete(sub);
		const listeners = this.byEvent.get(sub.event);
		listeners?.delete(sub);
		if (listeners && listeners.size === 0) {
			this.byEvent.delete(sub.event);
			if (this.driver instanceof EventSourceDriver) {
				this.driver.unlisten(sub.event);
			}
		}
		if (this.subs.size === 0) this.driver.stop();
	}

	/**
	 * URL for a request that conveys `cursor` through the declared query or
	 * hook. A hook's result must keep the connection's origin and carry no
	 * userinfo; otherwise this throws `unsupported-option`.
	 */
	urlWithCursor(cursor: string): string | undefined {
		const resume = this.spec.resume;
		if (cursor === "" || typeof resume !== "object") return undefined;
		const url = new URL(this.spec.url);
		if ("query" in resume) {
			url.searchParams.set(resume.query, cursor);
			return url.href;
		}
		const hook = this.resumeUrls[resume.url];
		if (!hook) return undefined;
		let result: URL | undefined;
		try {
			result = new URL(String(hook(new URL(url), cursor)));
		} catch {
			result = undefined;
		}
		if (
			result === undefined ||
			result.origin !== url.origin ||
			result.username !== "" ||
			result.password !== ""
		) {
			throw new SpinetabError(
				"unsupported-option",
				"connection.resume.url: the resumeUrls hook must return an absolute URL on the connection's origin without credentials.",
				{ detail: { path: "connection.resume.url" } },
			);
		}
		return result.href;
	}

	hasCursorPath(): boolean {
		return typeof this.spec.resume === "object";
	}

	get currentCursor(): string {
		return this.cursor;
	}

	setConveyed(cursor: string | undefined): void {
		this.conveyed = cursor;
	}

	/** The live stream ended: every current subscription is owed an outcome. */
	markLost(): void {
		for (const sub of this.subs) this.lost.add(sub);
	}

	/**
	 * The early notice, once per interruption: continuity is unknown from the
	 * moment a loss is detected, in every mode, before any status says so. With replay declared, the outcome at `established`
	 * replaces it.
	 */
	markInterrupted(restart: RestartKind): void {
		for (const sub of [...this.lost]) {
			if (this.cut.has(sub) || !this.subs.has(sub)) continue;
			this.cut.add(sub);
			reportInterruption(sub.sink, restart);
		}
	}

	/**
	 * A stream (re)opened: every subscription live at the loss receives the
	 * outcome, whether or not it was told early. With replay
	 * declared that is `resumed` only when a non-empty cursor was conveyed; otherwise `reconnected`/`reopened`.
	 */
	established(restart: RestartKind | undefined): void {
		const replay = this.spec.replay === "last-event-id";
		const cursor = this.conveyed;
		const resumed = replay && cursor !== undefined;
		const lost = [...this.lost];
		this.lost.clear();
		this.cut.clear();
		for (const sub of lost) {
			if (!this.subs.has(sub)) continue;
			this.continuity(
				sub,
				resumed ? "resumed-with-cursor" : (restart ?? "reconnected"),
				cursor,
			);
		}
		if (resumed) {
			// Runtime replacement: consumers that re-registered this cursor resume.
			for (const sub of this.subs) {
				if (sub.cursor !== undefined && sub.cursor === cursor) {
					this.continuity(sub, "resumed-with-cursor", cursor);
				}
			}
		}
		for (const sub of this.subs) sub.cursor = undefined;
	}

	private continuity(
		sub: Sub,
		reason: ContinuityReason,
		cursor: string | undefined,
	): void {
		if (reason === "resumed-with-cursor" && cursor !== undefined) {
			sub.sink.continuity(reason, { cursor, duplicatesPossible: true });
		} else {
			sub.sink.continuity(reason);
		}
	}

	dispatch(event: ServerSentEvent): void {
		this.cursor = event.lastEventId;
		if (this.spec.resetEvent === event.type) {
			// The server cannot replay from the conveyed cursor: whatever this
			// stream resumed or continued is not continuous.
			for (const sub of [...this.subs]) sub.sink.continuity("replay-reset");
			return;
		}
		if (this.spec.heartbeat?.event === event.type) return;
		const listeners = this.byEvent.get(event.type);
		if (!listeners || listeners.size === 0) return;
		const id = event.lastEventId === "" ? null : event.lastEventId;
		let data: unknown;
		try {
			data = this.decode(event.data, { type: event.type, id });
		} catch {
			// Loud and never delivered: a diagnostic plus a gap for this
			// event's subscribers; the stream continues.
			this.ctx.diagnostic({ type: "decode-error" });
			for (const sub of [...listeners]) sub.sink.continuity("decode-error");
			return;
		}
		const meta: SinkNextMeta =
			id === null ? { event: event.type } : { eventId: id, event: event.type };
		for (const sub of [...listeners]) {
			if (this.subs.has(sub)) sub.sink.next(data, meta);
		}
	}

	/** Committed cursor changes that carry no delivered event (id-only blocks). */
	setCursor(cursor: string): void {
		this.cursor = cursor;
	}

	failAll(error: SerialisedError): void {
		for (const sub of [...this.subs]) sub.sink.error(error);
		this.subs.clear();
		this.byEvent.clear();
		this.lost.clear();
		this.cut.clear();
	}

	completeAll(): void {
		for (const sub of [...this.subs]) sub.sink.complete();
		this.subs.clear();
		this.byEvent.clear();
		this.lost.clear();
		this.cut.clear();
	}

	private createFetchDriver(): HttpStream {
		const spec = this.spec;
		const resume = spec.resume ?? "header";
		return createHttpStream({
			ctx: this.ctx,
			repeatable: this.repeatable,
			authHeaders: spec.authHeaders,
			expectInboundWithinMs: spec.heartbeat?.expectInboundWithinMs,
			endOfBody: "reconnect",
			backoff: this.backoff,
			request: () => {
				const cursor = this.cursor;
				let url = spec.url;
				let lastEventId: Record<string, string> | undefined;
				let conveyed: string | undefined;
				if (cursor !== "" && resume === "header") {
					// A cursor the header cannot carry exactly is not conveyed:
					// the outcome is then reconnected, never resumed.
					const value = lastEventIdValue(cursor);
					if (value !== undefined) {
						lastEventId = { "Last-Event-ID": value };
						conveyed = cursor;
					}
				} else if (cursor !== "" && typeof resume === "object") {
					const withCursor = this.urlWithCursor(cursor);
					if (withCursor !== undefined) {
						url = withCursor;
						conveyed = cursor;
					}
				}
				this.conveyed = conveyed;
				return {
					url,
					init: (credentials) => {
						const init: RequestInit = {
							method: spec.method ?? "GET",
							headers: mergeHeaders(
								spec.headers,
								credentials,
								{ Accept: "text/event-stream" },
								lastEventId,
							),
							credentials: spec.credentials ?? "same-origin",
							cache: "no-store",
						};
						if (spec.body !== undefined) init.body = spec.body;
						return init;
					},
				};
			},
			accept: (response) => {
				if (response.status === 204) return "complete";
				if (response.status !== 200) {
					return {
						code: "protocol-error",
						message: `Expected status 200 for an event stream, got ${response.status}.`,
					};
				}
				if (!isEventStream(response.headers.get("content-type"))) {
					return {
						code: "protocol-error",
						message: "The response is not text/event-stream.",
					};
				}
				return "ok";
			},
			open: () => {
				const parser = parseServerSentEvents({
					lastEventId: this.cursor,
					maxPendingBytes: this.ctx.limits.maxFrameBytes,
				});
				const handle = (events: ServerSentEvent[]) => {
					for (const event of events) this.dispatch(event);
					this.cursor = parser.lastEventId;
					if (parser.retry !== undefined) {
						this.backoff.setBaseMs(
							Math.min(
								Math.max(parser.retry, SSE_RETRY_MIN_MS),
								SSE_RETRY_MAX_MS,
							),
						);
					}
				};
				const run = (step: () => ServerSentEvent[]) => {
					let events: ServerSentEvent[];
					try {
						events = step();
					} catch (error) {
						// Events dispatched before the failure are delivered in order
						// and advance the cursor; the failure follows.
						const partial = (error as { partial?: unknown } | null)?.partial;
						handle(Array.isArray(partial) ? partial : []);
						throw error;
					}
					handle(events);
				};
				return {
					push: (chunk) => run(() => parser.push(chunk)),
					end: () => run(() => parser.end()),
				};
			},
			established: (restart) => this.established(restart),
			lost: () => this.markLost(),
			interrupted: (restart) => this.markInterrupted(restart),
			terminal: (error) => this.failAll(error),
			complete: () => this.completeAll(),
		});
	}
}

type EventSourceLike = EventSource;

/**
 * Supervises one native EventSource: the browser's own
 * reconnection is the retry loop while `readyState` is CONNECTING; the adapter
 * only counts failed attempts and closes it when the bounded budget runs out.
 * A declared inbound deadline also supervises establishment and built-in
 * reconnects: a source that never opens must not escape the watchdog.
 * CLOSED (non-200, wrong type, 204) is opaque, so the adapter reports
 * `reconnecting` (code `eventsource-closed`) and recreates within the same
 * budget, carrying the cursor only through a declared query or URL hook.
 */
class EventSourceDriver {
	private source: EventSourceLike | undefined;
	private generation = 0;
	private phase:
		| "idle"
		| "connecting"
		| "open"
		| "reconnecting"
		| "waiting"
		| "exhausted"
		| "failed"
		| "disposed" = "idle";
	private readonly names = new Set<string>();
	private readonly handlers = new Map<string, (event: Event) => void>();
	private retryTimer: ReturnType<typeof setTimeout> | undefined;
	private livenessTimer: ReturnType<typeof setTimeout> | undefined;
	private lastInbound = 0;
	private pendingRestart: RestartKind | undefined;
	/** The current EventSource was created with the cursor in its URL. */
	private createdWithCursor: string | undefined;
	private everStarted = false;

	private readonly owner: SseConnection;
	private readonly spec: SseConnectionSpec;
	private readonly ctx: ConnectionContext;
	private readonly backoff: Backoff;

	constructor(
		owner: SseConnection,
		spec: SseConnectionSpec,
		ctx: ConnectionContext,
		backoff: Backoff,
	) {
		this.owner = owner;
		this.spec = spec;
		this.ctx = ctx;
		this.backoff = backoff;
		const heartbeat = spec.heartbeat?.event;
		if (heartbeat !== undefined) this.names.add(heartbeat);
		if (spec.resetEvent !== undefined) this.names.add(spec.resetEvent);
	}

	listen(name: string): void {
		this.names.add(name);
		if (this.source) this.attach(this.source, name);
	}

	unlisten(name: string): void {
		if (this.spec.heartbeat?.event === name) return;
		this.names.delete(name);
		const handler = this.handlers.get(name);
		if (handler && this.source) this.source.removeEventListener(name, handler);
		this.handlers.delete(name);
	}

	start(): void {
		if (this.phase !== "idle") return;
		this.backoff.reset();
		this.create();
	}

	stop(): void {
		if (this.phase === "disposed") return;
		const wasActive = this.phase !== "idle";
		this.teardown();
		this.backoff.reset();
		this.pendingRestart = undefined;
		this.phase = "idle";
		if (wasActive) this.ctx.setStatus({ state: "inactive", reason: "idle" });
	}

	probe(): void {
		if (this.phase === "waiting") {
			this.create();
		} else if (this.phase === "exhausted") {
			this.backoff.reset();
			this.create();
		} else if (this.phase === "connecting" || this.phase === "reconnecting") {
			this.checkLiveness();
		} else if (this.phase === "open") {
			const within = this.spec.heartbeat?.expectInboundWithinMs;
			if (within !== undefined) {
				this.checkLiveness();
				return;
			}
			// A deliberate restart, reported once at the new `connected`.
			this.pendingRestart = "reopened";
			this.owner.markLost();
			this.create();
		}
		// Without a declared deadline, the browser owns its reconnect loop.
	}

	retry(): void {
		if (
			this.phase === "exhausted" ||
			this.phase === "failed" ||
			this.phase === "waiting"
		) {
			this.backoff.reset();
			this.create();
		}
	}

	rotate(): void {
		// Cookies only: EventSource cannot carry credential headers.
	}

	dispose(): void {
		this.teardown();
		this.phase = "disposed";
	}

	private teardown(): void {
		this.generation += 1;
		if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
		if (this.livenessTimer !== undefined) clearTimeout(this.livenessTimer);
		this.retryTimer = undefined;
		this.livenessTimer = undefined;
		this.source?.close();
		this.source = undefined;
		this.handlers.clear();
	}

	private create(): void {
		this.teardown();
		const current = this.generation;
		const Source = (globalThis as { EventSource?: typeof EventSource })
			.EventSource;
		if (typeof Source !== "function") {
			this.phase = "failed";
			this.ctx.setStatus({
				state: "failed",
				reason: "permanent-error",
				code: "eventsource-unavailable",
			});
			return;
		}
		const cursor = this.owner.currentCursor;
		let withCursor: string | undefined;
		try {
			withCursor = this.owner.urlWithCursor(cursor);
		} catch (error) {
			// A worker hook returned an unusable URL: fail, never retry.
			this.phase = "failed";
			this.ctx.setStatus({
				state: "failed",
				reason: "permanent-error",
				code: "unsupported-option",
			});
			this.owner.failAll(toSerialisedError(error, "unsupported-option"));
			return;
		}
		this.createdWithCursor = withCursor === undefined ? undefined : cursor;
		const source = new Source(withCursor ?? this.spec.url, {
			withCredentials: this.spec.withCredentials === true,
		});
		this.source = source;
		if (!this.everStarted) {
			this.everStarted = true;
			this.ctx.setStatus({ state: "connecting" });
		}
		this.phase = "connecting";
		this.lastInbound = this.ctx.now();
		let builtInReconnect = false;
		source.addEventListener("open", () => {
			if (current !== this.generation) return;
			this.phase = "open";
			this.lastInbound = this.ctx.now();
			this.backoff.connected(this.ctx.now());
			// The browser's own reconnection sends Last-Event-ID itself; a
			// recreated EventSource conveys the cursor only through the URL.
			let conveyed: string | undefined;
			if (builtInReconnect) {
				const current = this.owner.currentCursor;
				conveyed =
					current !== "" && this.spec.resume !== false ? current : undefined;
			} else {
				conveyed = this.createdWithCursor;
			}
			builtInReconnect = false;
			this.owner.setConveyed(conveyed);
			const restart = this.pendingRestart;
			this.pendingRestart = undefined;
			// Continuity outcomes precede `connected`, never follow it.
			this.owner.established(restart);
			if (current !== this.generation || this.phase !== "open") return;
			this.ctx.setStatus({ state: "connected" });
			this.armLiveness();
		});
		source.addEventListener("error", () => {
			if (current !== this.generation) return;
			if (this.livenessTimer !== undefined) clearTimeout(this.livenessTimer);
			this.livenessTimer = undefined;
			if (this.phase === "open") {
				this.pendingRestart ??= "reconnected";
				this.owner.markLost();
			}
			// Also after a failed deliberate reopen: the early notice precedes the status.
			if (this.pendingRestart !== undefined) {
				this.owner.markInterrupted(this.pendingRestart);
			}
			const step = this.backoff.fail(this.ctx.now());
			if (step.kind === "exhausted") {
				this.teardown();
				this.phase = "exhausted";
				this.ctx.setStatus({ state: "retry-exhausted", reason: step.reason });
				return;
			}
			if (source.readyState === 0) {
				builtInReconnect = true;
				this.phase = "reconnecting";
				this.ctx.setStatus({
					state: "reconnecting",
					reason: "network",
					attempt: step.attempt,
				});
				this.armLiveness();
				return;
			}
			// CLOSED: the browser gave up and hides the cause.
			this.teardown();
			this.phase = "waiting";
			this.ctx.setStatus({
				state: "reconnecting",
				reason: "server-closed",
				code: "eventsource-closed",
				attempt: step.attempt,
				retryAt: Date.now() + step.delayMs,
			});
			this.retryTimer = setTimeout(() => {
				this.retryTimer = undefined;
				this.create();
			}, step.delayMs);
		});
		for (const name of this.names) this.attach(source, name);
		this.armLiveness();
	}

	private attach(source: EventSourceLike, name: string): void {
		if (this.handlers.has(name)) return;
		const current = this.generation;
		const handler = (event: Event) => {
			if (current !== this.generation) return;
			const message = event as MessageEvent;
			this.lastInbound = this.ctx.now();
			this.owner.dispatch({
				type: name,
				data:
					typeof message.data === "string"
						? message.data
						: String(message.data),
				lastEventId: message.lastEventId ?? "",
			});
		};
		this.handlers.set(name, handler);
		source.addEventListener(name, handler);
	}

	private armLiveness(): void {
		if (this.livenessTimer !== undefined) clearTimeout(this.livenessTimer);
		this.livenessTimer = undefined;
		const within = this.spec.heartbeat?.expectInboundWithinMs;
		if (within === undefined || this.source === undefined) return;
		const remaining = Math.max(within - (this.ctx.now() - this.lastInbound), 0);
		this.livenessTimer = setTimeout(() => this.checkLiveness(), remaining);
	}

	private checkLiveness(): void {
		if (this.livenessTimer !== undefined) clearTimeout(this.livenessTimer);
		this.livenessTimer = undefined;
		const within = this.spec.heartbeat?.expectInboundWithinMs;
		if (
			within === undefined ||
			(this.phase !== "open" &&
				this.phase !== "connecting" &&
				this.phase !== "reconnecting")
		) {
			return;
		}
		if (this.ctx.now() - this.lastInbound < within) {
			this.armLiveness();
			return;
		}
		this.ctx.diagnostic({ type: "heartbeat-missed", detail: { within } });
		if (this.phase === "open") {
			this.pendingRestart ??= "reconnected";
			this.owner.markLost();
		}
		if (this.pendingRestart !== undefined) {
			this.owner.markInterrupted(this.pendingRestart);
		}
		const step = this.backoff.fail(this.ctx.now());
		this.teardown();
		if (step.kind === "exhausted") {
			this.phase = "exhausted";
			this.ctx.setStatus({ state: "retry-exhausted", reason: step.reason });
			return;
		}
		this.phase = "waiting";
		this.ctx.setStatus({
			state: "reconnecting",
			reason: "heartbeat-timeout",
			attempt: step.attempt,
			retryAt: Date.now() + step.delayMs,
		});
		this.retryTimer = setTimeout(() => {
			this.retryTimer = undefined;
			this.create();
		}, step.delayMs);
	}
}
