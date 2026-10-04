import type {
	AdapterConnection,
	AdapterSubscription,
	ConnectionContext,
	RuntimeAdapter,
	SubscriptionSink,
} from "../../core/adapter.ts";
import { SpinetabError, toSerialisedError } from "../../core/errors.ts";
import { stableStringify } from "../../core/identity.ts";
import type {
	CommandOutcome,
	CredentialRequest,
	Credentials,
	SerialisedError,
} from "../../core/types.ts";
import {
	AI_ADAPTER_KIND,
	AI_ADAPTER_VERSION,
	type AiChunk,
	type AiCommandPayload,
	type AiCommandResult,
	type AiConnectionSpec,
	type AiFetchCredentials,
	type AiObserveEvent,
	type AiStreamEvent,
	type AiSubscriptionSpec,
	credentialHeaderRefusal,
} from "./shared.ts";
import { createSseDataParser } from "./sse.ts";

export type {
	AiChunk,
	AiCommandPayload,
	AiCommandResult,
	AiConnectionSpec,
	AiObserveEvent,
	AiStreamEvent,
	AiSubscriptionSpec,
} from "./shared.ts";

/**
 * Worker-side AI SDK adapter (`spinetab/ai-sdk/runtime`).
 *
 * The generation upstream runs here so closing the originating tab does
 * not stop other observers. Requests use `fetch` in the runtime realm; the UI
 * message stream (SSE JSON, `[DONE]`) is parsed once and every chunk is fanned
 * out unmodified, in order, as batches (one per network read, bounded by an
 * estimated byte budget). Nothing is retained after delivery: no history.
 *
 * - `start` command: one `POST` per call, never retried or deduplicated.
 * - `generation` subscription: the live stream of one generation.
 * - `observe` subscription: generations of a chat from position 0, shared only
 * when the backend echoes the generation id (`x-generation-id` header or
 * the `start` chunk's `messageId`).
 * - `resume` subscription: one backend `GET`; 204 completes with no events;
 * the first chunk must be `start`, otherwise `cannot-resume`.
 * - `stop` command: one `POST` to the application's stop endpoint.
 *
 * Observer departure never sends a stop. When a generation has no observer
 * left, its response is released after `idleCloseMs`.
 *
 * Credentials: every request asks the broker with the URL it goes
 * to (start: `api`, stop and resume: their own URLs), so the worker's
 * credential audience covers all three. A request that carries
 * provider headers never follows a redirect: it uses `redirect:
 * "manual"`, so a browser shows the redirect as an opaque-redirect answer
 * instead of a network failure, and a start is rejected, never reported as
 * possibly started. A 401 rejects the grant that was
 * attached, a 403 rejects nothing. HTTP failures carry
 * `detail.status` and a fixed message, never the response body.
 */
export interface AiSdkAdapterOptions {
	/** Grace before releasing an unobserved generation; default runtime `idleCloseMs`. */
	idleCloseMs?: number;
}

type AiEvent = AiStreamEvent | AiObserveEvent;

/** Upper bound for one batch's conservative size estimate. */
const MAX_BATCH_ESTIMATE = 32 * 1024;

export function aiSdkAdapter(
	options: AiSdkAdapterOptions = {},
): RuntimeAdapter<
	AiConnectionSpec,
	AiSubscriptionSpec,
	AiEvent,
	AiCommandPayload,
	AiCommandResult
> {
	if (options.idleCloseMs !== undefined) {
		assertPositiveInteger(options.idleCloseMs, "aiSdkAdapter.idleCloseMs");
	}
	return {
		kind: AI_ADAPTER_KIND,
		version: AI_ADAPTER_VERSION,
		validateConnection(spec: unknown): asserts spec is AiConnectionSpec {
			const record = plainObject(spec, "connection");
			onlyKeys(record, ["api"], "connection");
			absoluteUrl(record.api, "connection.api");
		},
		validateSubscription(spec: unknown): asserts spec is AiSubscriptionSpec {
			const record = plainObject(spec, "subscription");
			switch (record.kind) {
				case "generation":
					onlyKeys(record, ["kind", "chatId", "generationId"], "subscription");
					nonEmptyString(record.chatId, "subscription.chatId");
					nonEmptyString(record.generationId, "subscription.generationId");
					return;
				case "observe":
					onlyKeys(record, ["kind", "chatId"], "subscription");
					nonEmptyString(record.chatId, "subscription.chatId");
					return;
				case "resume":
					onlyKeys(
						record,
						["kind", "url", "nonce", "headers", "credentials"],
						"subscription",
					);
					absoluteUrl(record.url, "subscription.url");
					nonEmptyString(record.nonce, "subscription.nonce");
					headerRecord(record.headers, "subscription.headers");
					fetchCredentials(record.credentials, "subscription.credentials");
					return;
				default:
					throw unsupported(
						"subscription.kind",
						"must be generation, observe or resume",
					);
			}
		},
		connectionKey: (spec) => stableStringify({ api: spec.api }),
		subscriptionKey(spec) {
			// Request headers and fetch credentials are not identity.
			if (spec.kind === "resume") {
				return stableStringify({
					kind: spec.kind,
					url: spec.url,
					nonce: spec.nonce,
				});
			}
			return stableStringify(spec);
		},
		repeatable: (spec) => spec.kind === "observe",
		...(options.idleCloseMs === undefined
			? {}
			: { idleCloseMs: options.idleCloseMs }),
		connect: (spec, ctx) => new AiConnection(spec, ctx, options),
	};
}

interface StreamRun {
	readonly kind: "generation" | "resume";
	readonly chatId: string;
	readonly generationId: string | undefined;
	readonly controller: AbortController;
	sink: SubscriptionSink<AiEvent> | undefined;
	/** Chunks delivered so far; 0 means the next chunk is `start`. */
	index: number;
	/** Chunks parsed so far (delivered or pending in the current batch). */
	parsed: number;
	/** Fanned out to `observe` subscriptions (backend echoed the id). */
	shared: boolean;
	fetchStarted: boolean;
	ended: boolean;
	idleTimer: ReturnType<typeof setTimeout> | undefined;
}

class AiConnection
	implements
		AdapterConnection<
			AiSubscriptionSpec,
			AiEvent,
			AiCommandPayload,
			AiCommandResult
		>
{
	readonly #spec: AiConnectionSpec;
	readonly #ctx: ConnectionContext;
	readonly #idleCloseMs: number;
	readonly #generations = new Map<string, StreamRun>();
	readonly #observers = new Map<string, Set<SubscriptionSink<AiEvent>>>();
	readonly #resumes = new Set<StreamRun>();
	#disposed = false;

	constructor(
		spec: AiConnectionSpec,
		ctx: ConnectionContext,
		options: AiSdkAdapterOptions,
	) {
		this.#spec = spec;
		this.#ctx = ctx;
		this.#idleCloseMs = options.idleCloseMs ?? ctx.limits.idleCloseMs;
		// Request-based: the connection is usable as soon as it exists.
		ctx.setStatus({ state: "connected" });
		ctx.signal.addEventListener("abort", () => this.dispose(), { once: true });
	}

	subscribe(
		spec: AiSubscriptionSpec,
		sink: SubscriptionSink<AiEvent>,
	): AdapterSubscription {
		switch (spec.kind) {
			case "generation": {
				const run = this.#generationRun(spec.chatId, spec.generationId);
				run.sink = sink;
				this.#touch(run);
				return {
					unsubscribe: () => {
						if (run.sink !== sink) return;
						run.sink = undefined;
						if (!run.fetchStarted) {
							this.#generations.delete(spec.generationId);
							return;
						}
						this.#checkIdle(run);
					},
				};
			}
			case "observe": {
				let set = this.#observers.get(spec.chatId);
				if (!set) {
					set = new Set();
					this.#observers.set(spec.chatId, set);
				}
				set.add(sink);
				for (const run of this.#generations.values()) {
					if (run.chatId === spec.chatId) this.#touch(run);
				}
				return {
					unsubscribe: () => {
						const current = this.#observers.get(spec.chatId);
						current?.delete(sink);
						if (current?.size === 0) this.#observers.delete(spec.chatId);
						for (const run of this.#generations.values()) {
							if (run.chatId === spec.chatId) this.#checkIdle(run);
						}
					},
				};
			}
			case "resume": {
				const run: StreamRun = {
					kind: "resume",
					chatId: "",
					generationId: undefined,
					controller: new AbortController(),
					sink,
					index: 0,
					parsed: 0,
					shared: false,
					fetchStarted: true,
					ended: false,
					idleTimer: undefined,
				};
				this.#resumes.add(run);
				void this.#resume(run, spec);
				return {
					unsubscribe: () => {
						run.sink = undefined;
						this.#release(run);
					},
				};
			}
		}
	}

	async command(
		payload: AiCommandPayload,
	): Promise<CommandOutcome<AiCommandResult>> {
		try {
			validateCommand(payload);
		} catch (error) {
			return {
				status: "not-sent",
				error: toSerialisedError(error, "unsupported-option"),
			};
		}
		if (payload.type === "start") return this.#start(payload);
		if (payload.type === "stop") return this.#stop(payload);
		return {
			status: "not-sent",
			error: {
				code: "unsupported-option",
				message: "Unknown AI command type.",
				detail: { path: "payload.type" },
			},
		};
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		for (const run of [...this.#generations.values(), ...this.#resumes]) {
			if (run.idleTimer) clearTimeout(run.idleTimer);
			run.ended = true;
			run.controller.abort();
		}
		this.#generations.clear();
		this.#resumes.clear();
		this.#observers.clear();
	}

	// Commands -------------------------------------------------------------

	async #start(
		payload: Extract<AiCommandPayload, { type: "start" }>,
	): Promise<CommandOutcome<AiCommandResult>> {
		if (this.#disposed) return notSent("disposed", "The connection is closed.");
		const existing = this.#generations.get(payload.generationId);
		if (existing?.fetchStarted) {
			return {
				status: "rejected",
				error: {
					code: "command-rejected",
					message: "This generation id has already been started.",
				},
			};
		}
		const headers = await this.#headers(
			payload.headers,
			"connect",
			this.#spec.api,
		);
		if (!headers.ok) return { status: "not-sent", error: headers.error };
		const run = this.#generationRun(payload.chatId, payload.generationId);
		run.fetchStarted = true;
		let response: Response;
		try {
			response = await fetch(this.#spec.api, {
				method: "POST",
				headers: { "content-type": "application/json", ...headers.headers },
				body: payload.body,
				...credentialsInit(payload.credentials),
				...redirectInit(headers.attached),
				signal: run.controller.signal,
			});
		} catch (failure) {
			if (headers.attached && isRedirectError(failure)) {
				// A redirect answer started nothing; its target never saw the grant.
				const error = redirectError();
				this.#endRun(run, error);
				return { status: "rejected", error };
			}
			// The request may have reached the backend: report, never resend.
			const error: SerialisedError = {
				code: "command-unknown",
				message:
					"The chat request failed before a response arrived; the generation may have started.",
			};
			this.#endRun(run, { code: "interrupted", message: error.message });
			return { status: "unknown", error };
		}
		if (isRedirectAnswer(response, headers.attached)) {
			// A redirect answer started nothing; its target never saw the grant.
			await response.body?.cancel().catch(() => {});
			const error = redirectError();
			this.#endRun(run, error);
			return { status: "rejected", error };
		}
		if (!response.ok || !response.body) {
			const error = await httpError(
				response,
				"Failed to fetch the chat response.",
			);
			this.#rejectOn401(response, headers.attached);
			this.#endRun(run, error);
			return { status: "rejected", error };
		}
		run.shared =
			response.headers.get("x-generation-id") === payload.generationId;
		void this.#pump(run, response.body);
		return {
			status: "acknowledged",
			value: { status: response.status, generationId: payload.generationId },
		};
	}

	async #stop(
		payload: Extract<AiCommandPayload, { type: "stop" }>,
	): Promise<CommandOutcome<AiCommandResult>> {
		if (this.#disposed) return notSent("disposed", "The connection is closed.");
		const headers = await this.#headers(
			payload.headers,
			"connect",
			payload.url,
		);
		if (!headers.ok) return { status: "not-sent", error: headers.error };
		let response: Response;
		try {
			response = await fetch(payload.url, {
				method: "POST",
				headers: { "content-type": "application/json", ...headers.headers },
				body: JSON.stringify({
					chatId: payload.chatId,
					generationId: payload.generationId,
				}),
				...credentialsInit(payload.credentials),
				...redirectInit(headers.attached),
			});
		} catch (error) {
			if (headers.attached && isRedirectError(error)) {
				return { status: "rejected", error: redirectError() };
			}
			return {
				status: "unknown",
				error: {
					code: "command-unknown",
					message:
						"The stop request failed before a response arrived; it may have reached the backend.",
				},
			};
		}
		if (isRedirectAnswer(response, headers.attached)) {
			await response.body?.cancel().catch(() => {});
			return { status: "rejected", error: redirectError() };
		}
		if (!response.ok) {
			const error = await httpError(response, "The stop request failed.");
			this.#rejectOn401(response, headers.attached);
			return { status: "rejected", error };
		}
		await response.body?.cancel().catch(() => {});
		return {
			status: "acknowledged",
			value: { status: response.status, generationId: payload.generationId },
		};
	}

	// Streams --------------------------------------------------------------

	async #resume(
		run: StreamRun,
		spec: Extract<AiSubscriptionSpec, { kind: "resume" }>,
	): Promise<void> {
		const headers = await this.#headers(spec.headers, "connect", spec.url);
		if (run.ended) return;
		if (!headers.ok) {
			this.#endRun(run, headers.error);
			return;
		}
		let response: Response;
		try {
			response = await fetch(spec.url, {
				method: "GET",
				headers: headers.headers,
				...credentialsInit(spec.credentials),
				...redirectInit(headers.attached),
				signal: run.controller.signal,
			});
		} catch (error) {
			if (run.ended) return;
			if (headers.attached && isRedirectError(error)) {
				this.#endRun(run, redirectError());
				return;
			}
			this.#endRun(run, {
				code: "interrupted",
				message: `The resume request failed: ${messageOf(error)}`,
			});
			return;
		}
		if (run.ended) {
			await response.body?.cancel().catch(() => {});
			return;
		}
		if (isRedirectAnswer(response, headers.attached)) {
			await response.body?.cancel().catch(() => {});
			this.#endRun(run, redirectError());
			return;
		}
		if (response.status === 204) {
			// No active stream: complete with no events (the page maps it to null).
			this.#endRun(run);
			return;
		}
		if (!response.ok) {
			const error = await httpError(
				response,
				"Failed to fetch the resume stream.",
			);
			this.#rejectOn401(response, headers.attached);
			this.#endRun(run, error);
			return;
		}
		if (!response.body) {
			this.#endRun(run, cannotResume("The resume response body is empty."));
			return;
		}
		await this.#pump(run, response.body);
	}

	async #pump(run: StreamRun, body: ReadableStream<Uint8Array>): Promise<void> {
		const parser = createSseDataParser(this.#ctx.limits.maxFrameBytes);
		const reader = body.getReader();
		// Estimated bytes per batch: several batches fit in one consumer's window.
		const budget = Math.max(
			1024,
			Math.min(
				MAX_BATCH_ESTIMATE,
				Math.floor(this.#ctx.limits.maxPendingBytesPerConsumer / 8),
			),
		);
		try {
			while (!run.ended) {
				const { done, value } = await reader.read();
				if (done) break;
				if (!(await this.#deliver(run, parser.push(value), budget))) return;
			}
			if (run.ended) return;
			if (!(await this.#deliver(run, parser.end(), budget))) return;
			if (run.kind === "resume" && run.index === 0) {
				this.#endRun(run, cannotResume("The resume stream had no chunks."));
				return;
			}
			this.#endRun(run);
		} catch (error) {
			if (run.ended) return;
			const record = toSerialisedError(error, "interrupted");
			this.#endRun(
				run,
				record.code === "frame-too-large"
					? record
					: {
							code: "interrupted",
							message:
								"The AI stream was interrupted; the backend may still be generating.",
						},
			);
		} finally {
			reader.releaseLock();
		}
	}

	/**
	 * Parse the events of one read and deliver them as ordered batches of
	 * unmodified chunks. Batching keeps a buffered burst (a from-start replay)
	 * within the per-consumer message window, and yielding between batches
	 * lets page acknowledgements return. Returns false once the run ended.
	 */
	async #deliver(
		run: StreamRun,
		events: string[],
		budget: number,
	): Promise<boolean> {
		let batch: AiChunk[] = [];
		let estimate = 0;
		for (const data of events) {
			const chunk = this.#parse(run, data);
			if (chunk === false) return false;
			if (chunk === null) continue;
			batch.push(chunk);
			// Conservative: every UTF-16 unit may cost 3 bytes, plus overhead.
			estimate += data.length * 3 + 32;
			if (estimate >= budget) {
				this.#flush(run, batch);
				batch = [];
				estimate = 0;
				await yieldToEventLoop();
				if (run.ended) return false;
			}
		}
		if (batch.length > 0) {
			this.#flush(run, batch);
			await yieldToEventLoop();
		}
		return !run.ended;
	}

	/** Parse one SSE data string: a chunk, `null` for `[DONE]`, `false` when the run ended. */
	#parse(run: StreamRun, data: string): AiChunk | null | false {
		if (run.ended) return false;
		if (data === "[DONE]") return null;
		let chunk: AiChunk;
		try {
			const parsed: unknown = JSON.parse(data);
			if (
				typeof parsed !== "object" ||
				parsed === null ||
				Array.isArray(parsed) ||
				typeof (parsed as { type?: unknown }).type !== "string"
			) {
				throw new Error("not a chunk");
			}
			chunk = parsed as AiChunk;
		} catch {
			this.#endRun(run, {
				code: "decode-error",
				message: "The AI stream contained an event that is not a JSON chunk.",
			});
			return false;
		}
		if (run.parsed === 0) {
			if (run.kind === "resume" && chunk.type !== "start") {
				this.#endRun(
					run,
					cannotResume(
						"The resume stream did not begin with a start chunk, so it cannot be interpreted from this position.",
					),
				);
				return false;
			}
			if (
				run.kind === "generation" &&
				chunk.type === "start" &&
				(chunk as { messageId?: unknown }).messageId === run.generationId
			) {
				run.shared = true;
			}
			run.sink?.started();
		}
		run.parsed += 1;
		return chunk;
	}

	#flush(run: StreamRun, chunks: AiChunk[]): void {
		if (run.ended || chunks.length === 0) return;
		const index = run.index;
		run.index += chunks.length;
		run.sink?.next(chunks);
		if (run.kind === "generation" && run.shared && run.generationId) {
			const event: AiObserveEvent = {
				type: "chunks",
				generationId: run.generationId,
				index,
				chunks,
			};
			for (const observer of this.#observers.get(run.chatId) ?? []) {
				observer.next(event);
			}
		}
	}

	#endRun(run: StreamRun, error?: SerialisedError): void {
		if (run.ended) return;
		run.ended = true;
		if (run.idleTimer) clearTimeout(run.idleTimer);
		run.idleTimer = undefined;
		run.controller.abort();
		if (run.kind === "generation" && run.generationId) {
			if (this.#generations.get(run.generationId) === run) {
				this.#generations.delete(run.generationId);
			}
			if (run.shared) {
				const event: AiObserveEvent = error
					? {
							type: "end",
							generationId: run.generationId,
							outcome: error.code === "interrupted" ? "interrupted" : "error",
							error,
						}
					: {
							type: "end",
							generationId: run.generationId,
							outcome: "complete",
						};
				for (const observer of this.#observers.get(run.chatId) ?? []) {
					observer.next(event);
				}
			}
		} else {
			this.#resumes.delete(run);
		}
		const sink = run.sink;
		run.sink = undefined;
		if (!sink) return;
		if (error) sink.error(error);
		else sink.complete();
	}

	#generationRun(chatId: string, generationId: string): StreamRun {
		let run = this.#generations.get(generationId);
		if (!run) {
			run = {
				kind: "generation",
				chatId,
				generationId,
				controller: new AbortController(),
				sink: undefined,
				index: 0,
				parsed: 0,
				shared: false,
				fetchStarted: false,
				ended: false,
				idleTimer: undefined,
			};
			this.#generations.set(generationId, run);
		}
		return run;
	}

	#observerCount(run: StreamRun): number {
		let count = run.sink ? 1 : 0;
		if (run.shared) count += this.#observers.get(run.chatId)?.size ?? 0;
		return count;
	}

	#touch(run: StreamRun): void {
		if (run.idleTimer && this.#observerCount(run) > 0) {
			clearTimeout(run.idleTimer);
			run.idleTimer = undefined;
		}
	}

	/** Last observer gone: release the response after the idle grace. */
	#checkIdle(run: StreamRun): void {
		if (run.ended || run.idleTimer || this.#observerCount(run) > 0) return;
		run.idleTimer = setTimeout(() => {
			run.idleTimer = undefined;
			if (this.#observerCount(run) === 0) this.#release(run);
		}, this.#idleCloseMs);
	}

	/** Detach without notifying anyone: nobody is observing. Never a stop. */
	#release(run: StreamRun): void {
		if (run.ended) return;
		run.sink = undefined;
		const observers = run.shared
			? (this.#observers.get(run.chatId)?.size ?? 0)
			: 0;
		if (observers > 0) return;
		this.#endRun(run);
	}

	/**
	 * Only a 401 rejects, and only the grant that was attached to
	 * that request; a 403 means "not allowed" and rejects nothing.
	 */
	#rejectOn401(response: Response, attached: Credentials | undefined): void {
		if (response.status === 401 && attached) {
			this.#ctx.rejectCredentials(attached);
		}
	}

	/**
	 * Headers for one request to `url`. `attached` is the provider grant when
	 * it contributed headers to this request, else `undefined`.
	 */
	async #headers(
		base: Record<string, string> | undefined,
		reason: CredentialRequest["reason"],
		url: string,
	): Promise<
		| {
				ok: true;
				headers: Record<string, string>;
				attached: Credentials | undefined;
		  }
		| { ok: false; error: SerialisedError }
	> {
		try {
			const credentials = await this.#ctx.credentials(reason, url);
			const extra = credentialHeaders(credentials.headers);
			return {
				ok: true,
				headers: { ...base, ...extra },
				attached: Object.keys(extra).length > 0 ? credentials : undefined,
			};
		} catch (error) {
			const record = toSerialisedError(error, "credentials-timeout");
			// Cookie-authenticated applications register no credential source.
			// Every other failure, `credentials-timeout` and `credentials-failed`
			// alike, sends nothing: a failed provider never becomes an anonymous
			// request.
			if (record.code === "no-credential-source") {
				return { ok: true, headers: { ...base }, attached: undefined };
			}
			return { ok: false, error: record };
		}
	}
}

// Helpers ------------------------------------------------------------------

function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function notSent(
	code: SerialisedError["code"],
	message: string,
): CommandOutcome<never> {
	return { status: "not-sent", error: { code, message } };
}

function cannotResume(message: string): SerialisedError {
	return {
		code: "cannot-resume",
		message,
		detail: { reason: "invalid-resume-stream" },
	};
}

/**
 * An HTTP failure carries its status and a fixed message only: the response
 * body is discarded unread, so no upstream text reaches statuses, errors or
 * the loud path.
 */
async function httpError(
	response: Response,
	message: string,
): Promise<SerialisedError> {
	await response.body?.cancel().catch(() => {});
	return {
		code: "upstream-error",
		message: `${message} (HTTP ${response.status})`,
		detail: { status: response.status },
	};
}

/**
 * A request that carries provider material never follows a redirect.
 * `"manual"` rather than `"error"`: browsers raise a refused `"error"`
 * redirect as the same plain `TypeError` as a network failure, which would
 * turn a start that started nothing into "may have started".
 */
function redirectInit(attached: Credentials | undefined): {
	redirect?: "manual";
} {
	return attached ? { redirect: "manual" } : {};
}

/**
 * The unfollowed redirect of a `"manual"` request: an opaque-redirect answer
 * in browsers, the 3xx answer itself elsewhere (Node).
 */
function isRedirectAnswer(
	response: Response,
	attached: Credentials | undefined,
): boolean {
	return (
		attached !== undefined &&
		(response.type === "opaqueredirect" ||
			(response.status >= 300 && response.status < 400))
	);
}

/**
 * A redirect refused by the platform (a runtime that applies `"error"`
 * semantics anyway exposes it as a `TypeError` whose cause names the
 * redirect, as Node's `fetch` does); kept as a second line of detection.
 */
function isRedirectError(error: unknown): boolean {
	const cause = (error as { cause?: unknown } | null)?.cause;
	return (
		error instanceof TypeError &&
		cause instanceof Error &&
		/redirect/i.test(cause.message)
	);
}

function redirectError(): SerialisedError {
	return {
		code: "upstream-error",
		message:
			"The endpoint answered with a redirect; requests that carry provider credentials never follow redirects.",
		detail: { reason: "redirect" },
	};
}

function credentialsInit(credentials: AiFetchCredentials | undefined): {
	credentials?: AiFetchCredentials;
} {
	return credentials === undefined ? {} : { credentials };
}

function credentialHeaders(value: unknown): Record<string, string> {
	const headers: Record<string, string> = {};
	if (value === undefined || value === null) return headers;
	const entries: Array<[unknown, unknown]> = Array.isArray(value)
		? (value as Array<[unknown, unknown]>)
		: typeof value === "object"
			? Object.entries(value as Record<string, unknown>)
			: [];
	for (const [name, item] of entries) {
		if (typeof name === "string" && typeof item === "string") {
			headers[name] = item;
		}
	}
	return headers;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.name : "network error";
}

function unsupported(path: string, reason: string): SpinetabError {
	return new SpinetabError("unsupported-option", `${path} ${reason}.`, {
		detail: { path },
	});
}

function plainObject(value: unknown, path: string): Record<string, unknown> {
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		(Object.getPrototypeOf(value) !== Object.prototype &&
			Object.getPrototypeOf(value) !== null)
	) {
		throw unsupported(path, "must be a plain object");
	}
	return value as Record<string, unknown>;
}

function onlyKeys(
	record: Record<string, unknown>,
	allowed: string[],
	path: string,
): void {
	for (const key of Object.keys(record)) {
		if (!allowed.includes(key)) {
			throw unsupported(`${path}.${key}`, "is not a supported option");
		}
	}
}

function nonEmptyString(value: unknown, path: string): void {
	if (typeof value !== "string" || value === "") {
		throw unsupported(path, "must be a non-empty string");
	}
}

function absoluteUrl(value: unknown, path: string): void {
	nonEmptyString(value, path);
	let url: URL;
	try {
		url = new URL(value as string);
	} catch {
		throw new SpinetabError(
			"invalid-endpoint",
			`${path} must be an absolute URL.`,
			{
				detail: { path },
			},
		);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new SpinetabError("invalid-endpoint", `${path} must use HTTP(S).`, {
			detail: { path },
		});
	}
	if (url.username || url.password) {
		throw new SpinetabError(
			"invalid-endpoint",
			`${path} must not contain credentials.`,
			{ detail: { path } },
		);
	}
}

function headerRecord(value: unknown, path: string): void {
	if (value === undefined) return;
	const record = plainObject(value, path);
	for (const [key, item] of Object.entries(record)) {
		if (typeof item !== "string") {
			throw unsupported(`${path}.${key}`, "must be a string");
		}
		const refusal = credentialHeaderRefusal(key, `${path}.${key}`);
		if (refusal) {
			throw new SpinetabError("unsupported-option", refusal, {
				detail: { path: `${path}.${key}` },
			});
		}
	}
}

/**
 * Commands are validated in the worker as subscriptions are: a hand-built
 * bridge message never reaches `fetch` with an unchecked URL or a credential
 * header.
 */
function validateCommand(payload: AiCommandPayload): void {
	const record = plainObject(payload, "payload");
	headerRecord(record.headers, "payload.headers");
	fetchCredentials(record.credentials, "payload.credentials");
	if (record.type === "stop") absoluteUrl(record.url, "payload.url");
}

function fetchCredentials(value: unknown, path: string): void {
	if (value === undefined) return;
	if (value !== "omit" && value !== "same-origin" && value !== "include") {
		throw unsupported(path, "must be omit, same-origin or include");
	}
}

function assertPositiveInteger(value: unknown, path: string): void {
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		throw unsupported(path, "must be a positive integer");
	}
}
