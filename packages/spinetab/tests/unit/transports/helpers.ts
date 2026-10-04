import type {
	ConnectionContext,
	ContinuityDetail,
	SinkNextMeta,
	SubscriptionSink,
} from "../../../src/core/adapter.ts";
import { SpinetabError } from "../../../src/core/errors.ts";
import { DEFAULT_LIMITS } from "../../../src/core/limits.ts";
import type {
	ConnectionStatus,
	ContinuityReason,
	CredentialRequest,
	Credentials,
	DiagnosticEvent,
	RuntimeLimits,
	SerialisedError,
} from "../../../src/core/types.ts";

/**
 * Test doubles for driving transport adapters directly through the adapter
 * contract (`adapter.connect(spec, ctx)` and `connection.subscribe(...)`),
 * without the runtime. Shared by the unit and integration suites.
 */
export type Status = Omit<ConnectionStatus, "since">;

export interface FakeContext {
	ctx: ConnectionContext;
	statuses: Status[];
	diagnostics: Array<Omit<DiagnosticEvent, "at" | "realm">>;
	credentialCalls: CredentialRequest["reason"][];
	/** The URL passed with each credentials request. */
	credentialUrls: Array<string | undefined>;
	rejections(): number;
	/** The grant passed to each `rejectCredentials` call. */
	rejected: Array<Credentials | undefined>;
	last(): Status | undefined;
	states(): string[];
	setCredentials(
		provider: (reason: CredentialRequest["reason"]) => Promise<Credentials>,
	): void;
	abort(): void;
}

export function fakeContext(
	options: { limits?: Partial<RuntimeLimits>; scope?: string } = {},
): FakeContext {
	const statuses: Status[] = [];
	const diagnostics: FakeContext["diagnostics"] = [];
	const credentialCalls: CredentialRequest["reason"][] = [];
	const credentialUrls: Array<string | undefined> = [];
	const rejected: Array<Credentials | undefined> = [];
	let rejections = 0;
	let provider: (reason: CredentialRequest["reason"]) => Promise<Credentials> =
		() =>
			Promise.reject(
				new SpinetabError("no-credential-source", "No credential provider."),
			);
	const controller = new AbortController();
	const ctx: ConnectionContext = {
		scope: options.scope ?? "",
		key: "test",
		limits: { ...DEFAULT_LIMITS, ...options.limits },
		signal: controller.signal,
		credentials(reason, url) {
			credentialCalls.push(reason);
			credentialUrls.push(url);
			return provider(reason);
		},
		rejectCredentials(credentials) {
			rejections += 1;
			rejected.push(credentials);
		},
		setStatus(status) {
			statuses.push(status);
		},
		diagnostic(event) {
			diagnostics.push(event);
		},
		now: () => Date.now(),
	};
	return {
		ctx,
		statuses,
		diagnostics,
		credentialCalls,
		credentialUrls,
		rejections: () => rejections,
		rejected,
		last: () => statuses.at(-1),
		states: () => statuses.map((status) => status.state),
		setCredentials(next) {
			provider = next;
		},
		abort: () => controller.abort(),
	};
}

export interface RecordingSink<E> {
	sink: SubscriptionSink<E>;
	events: E[];
	metas: Array<SinkNextMeta | undefined>;
	errors: SerialisedError[];
	completed: number;
	continuity: Array<{ reason: ContinuityReason; detail?: ContinuityDetail }>;
	log: string[];
}

export function recordingSink<E = unknown>(): RecordingSink<E> {
	const record: RecordingSink<E> = {
		events: [],
		metas: [],
		errors: [],
		completed: 0,
		continuity: [],
		log: [],
		sink: {
			next(event, meta) {
				record.events.push(event);
				record.metas.push(meta);
				record.log.push("next");
			},
			error(error) {
				record.errors.push(error);
				record.log.push(`error:${error.code}`);
			},
			complete() {
				record.completed += 1;
				record.log.push("complete");
			},
			continuity(reason, detail) {
				record.continuity.push(
					detail === undefined ? { reason } : { reason, detail },
				);
				record.log.push(`continuity:${reason}`);
			},
			started() {
				record.log.push("started");
			},
		},
	};
	return record;
}

export const SUBSCRIBE_OPTIONS = { key: "sub", repeatable: true } as const;

/** Minimal WebSocket double implementing the parts the adapter uses. */
export class FakeWebSocket {
	static instances: FakeWebSocket[] = [];
	static reset(): void {
		FakeWebSocket.instances = [];
	}
	static last(): FakeWebSocket {
		const socket = FakeWebSocket.instances.at(-1);
		if (!socket) throw new Error("no socket created");
		return socket;
	}

	readyState = 0;
	binaryType: BinaryType = "blob";
	bufferedAmount = 0;
	protocol = "";
	sent: unknown[] = [];
	closedWith: { code?: number; reason?: string } | undefined;
	onopen: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onclose: ((event: CloseEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;

	constructor(
		readonly url: string,
		readonly protocols?: string | string[],
	) {
		FakeWebSocket.instances.push(this);
	}

	send(data: unknown): void {
		if (this.readyState === 0) {
			throw new DOMException("still connecting", "InvalidStateError");
		}
		// Browsers silently discard data sent while CLOSING or CLOSED.
		if (this.readyState !== 1) return;
		this.sent.push(data);
	}

	close(code?: number, reason?: string): void {
		if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999)) {
			throw new DOMException("invalid code", "InvalidAccessError");
		}
		this.closedWith = { code, reason };
		this.readyState = 2;
	}

	/** Messages the adapter sent, parsed as JSON where possible. */
	json(): unknown[] {
		return this.sent.map((item) =>
			typeof item === "string" ? JSON.parse(item) : item,
		);
	}

	serverOpen(protocol = ""): void {
		this.protocol = protocol;
		this.readyState = 1;
		this.onopen?.(new Event("open"));
	}

	serverMessage(data: string | ArrayBuffer): void {
		this.onmessage?.({ data } as MessageEvent);
	}

	serverClose(code = 1006, reason = "", wasClean = false): void {
		this.readyState = 3;
		this.onerror?.(new Event("error"));
		this.onclose?.({ code, reason, wasClean } as CloseEvent);
	}
}

/** EventSource double: tests drive readyState transitions and events. */
export class FakeEventSource extends EventTarget {
	static instances: FakeEventSource[] = [];
	static reset(): void {
		FakeEventSource.instances = [];
	}
	static last(): FakeEventSource {
		const source = FakeEventSource.instances.at(-1);
		if (!source) throw new Error("no EventSource created");
		return source;
	}

	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSED = 2;
	readyState = 0;
	closed = false;
	readonly listened = new Map<string, number>();

	constructor(
		readonly url: string,
		readonly init?: EventSourceInit,
	) {
		super();
		FakeEventSource.instances.push(this);
	}

	override addEventListener(
		type: string,
		listener: EventListenerOrEventListenerObject | null,
		options?: boolean | AddEventListenerOptions,
	): void {
		this.listened.set(type, (this.listened.get(type) ?? 0) + 1);
		super.addEventListener(type, listener, options);
	}

	override removeEventListener(
		type: string,
		listener: EventListenerOrEventListenerObject | null,
		options?: boolean | EventListenerOptions,
	): void {
		this.listened.set(type, (this.listened.get(type) ?? 0) - 1);
		super.removeEventListener(type, listener, options);
	}

	close(): void {
		this.readyState = 2;
		this.closed = true;
	}

	open(): void {
		this.readyState = 1;
		this.dispatchEvent(new Event("open"));
	}

	emit(type: string, data: string, lastEventId = ""): void {
		this.dispatchEvent(new MessageEvent(type, { data, lastEventId }));
	}

	/** Network error: the browser keeps reconnecting (CONNECTING). */
	networkError(): void {
		this.readyState = 0;
		this.dispatchEvent(new Event("error"));
	}

	/** Failed connection: the browser gives up (CLOSED). */
	fail(): void {
		this.readyState = 2;
		this.dispatchEvent(new Event("error"));
	}
}

/** A response body the test writes to; errors when the request is aborted. */
export interface ScriptedBody {
	stream: ReadableStream<Uint8Array>;
	write(chunk: string | Uint8Array): void;
	end(): void;
	fail(error?: unknown): void;
	cancelled: boolean;
}

export function scriptedBody(): ScriptedBody {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const encoder = new TextEncoder();
	const body: ScriptedBody = {
		cancelled: false,
		stream: new ReadableStream<Uint8Array>({
			start(c) {
				controller = c;
			},
			cancel() {
				body.cancelled = true;
			},
		}),
		write(chunk) {
			controller.enqueue(
				typeof chunk === "string" ? encoder.encode(chunk) : chunk,
			);
		},
		end() {
			controller.close();
		},
		fail(error = new TypeError("terminated")) {
			controller.error(error);
		},
	};
	return body;
}

export interface ScriptedRequest {
	url: string;
	init: RequestInit;
	headers: Headers;
	aborted(): boolean;
}

/**
 * Scripted `fetch`: each call takes the next responder. A responder returns a
 * Response, or throws/rejects for a network failure. Aborting errors the body.
 */
export function scriptedFetch(
	responders: Array<(request: ScriptedRequest) => Response | Promise<Response>>,
) {
	const requests: ScriptedRequest[] = [];
	const fetch = async (
		input: RequestInfo | URL,
		init: RequestInit = {},
	): Promise<Response> => {
		const signal = init.signal ?? undefined;
		const request: ScriptedRequest = {
			url: String(input),
			init,
			headers: new Headers(init.headers),
			aborted: () => signal?.aborted === true,
		};
		requests.push(request);
		const responder = responders.shift();
		if (!responder) throw new TypeError("no scripted response");
		if (signal?.aborted) throw new DOMException("aborted", "AbortError");
		return responder(request);
	};
	return { fetch, requests };
}

export function eventStream(
	body: ScriptedBody,
	init: ResponseInit = {},
	signal?: AbortSignal,
): Response {
	signal?.addEventListener("abort", () => {
		try {
			body.fail(new DOMException("aborted", "AbortError"));
		} catch {
			// already closed
		}
	});
	return new Response(body.stream, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
		...init,
	});
}

/** Let queued microtasks and promise continuations run. */
export async function flush(times = 10): Promise<void> {
	for (let index = 0; index < times; index += 1) await Promise.resolve();
}

/** Poll until `check` passes (real timers; integration tests). */
export async function waitFor<T>(
	check: () => T | undefined | false | Promise<T | undefined | false>,
	timeoutMs = 5_000,
	intervalMs = 10,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;
	for (;;) {
		try {
			const value = await check();
			if (value !== undefined && value !== false) return value as T;
		} catch (error) {
			lastError = error;
		}
		if (Date.now() > deadline) {
			throw lastError instanceof Error
				? lastError
				: new Error(`waitFor timed out after ${timeoutMs} ms`);
		}
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
}
