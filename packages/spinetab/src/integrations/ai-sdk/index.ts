import type {
	ChatRequestOptions,
	ChatTransport,
	UIMessage,
	UIMessageChunk,
} from "ai";
import {
	clientBase,
	deserialiseError,
	SpinetabError,
} from "../../core/errors.ts";
import { estimateBytes } from "../../core/estimate.ts";
import { DEFAULT_LIMITS } from "../../core/limits.ts";
import type {
	CommandOutcome,
	DeliveryLimits,
	SerialisedError,
	SpinetabClient,
	Subscription,
	SubscriptionRequest,
	SubscriptionStatus,
} from "../../core/types.ts";
import {
	AI_ADAPTER_KIND,
	type AiCommandPayload,
	type AiCommandResult,
	type AiConnectionSpec,
	type AiFetchCredentials,
	type AiSubscriptionSpec,
	credentialHeaderRefusal,
	type AiObserveEvent as SharedAiObserveEvent,
	type AiStreamEvent as SharedAiStreamEvent,
} from "./shared.ts";

export type { AiChunk, AiCommandResult } from "./shared.ts";

/**
 * Page-side event types: the shared wire events specialised to the AI SDK's
 * discriminated `UIMessageChunk`, so `chunk.type === "text-delta"` narrows
 * `chunk.delta` to `string`. The runtime entry keeps the
 * structural `AiChunk` and never imports `ai`.
 */
export type AiObserveEvent = SharedAiObserveEvent<UIMessageChunk>;
export type AiStreamEvent = SharedAiStreamEvent<UIMessageChunk>;

type Resolvable<T> = T | (() => T | Promise<T>);
type HeadersInput = Record<string, string> | Headers;

export interface SpinetabChatTransportOptions {
	/** Application-owned Spinetab client; the transport never creates one. */
	client: SpinetabClient;
	/**
	 * Chat endpoint (`POST`). Default `/api/chat`. Relative URLs, here and in
	 * `resume` and `stop`, resolve against the client's base: its `baseUrl`,
	 * else the document base.
	 */
	api?: string;
	/**
	 * Resume source. Default: `GET {api}/{chatId}/stream`, as `DefaultChatTransport`.
	 * `false`: no resume source; an active but unobservable generation is `cannot-resume`.
	 */
	resume?: { api: (chatId: string) => string } | false;
	/** Explicit stop endpoint; without it `stop()` fails with `stop-unavailable`. */
	stop?: { api: (chatId: string, generationId: string) => string } | false;
	/**
	 * Non-secret static headers. `authorization`, `proxy-authorization`,
	 * `cookie`, `x-api-key`, `x-auth-token` and `last-event-id` are refused
	 * (`unsupported-option`): credentials come only from the client's
	 * `credentials` provider, which the worker's credential audience governs.
	 */
	headers?: Resolvable<HeadersInput>;
	body?: Resolvable<object>;
	credentials?: Resolvable<AiFetchCredentials>;
	/**
	 * Called once per chat per recovery episode after an observed stream was
	 * actually lost (upstream drop, runtime replacement, lease expiry, overflow).
	 * Not called after `stop()`, and a failed resume is never retried
	 * automatically. `follow(chatId, resumeStream)` is the per-chat form and
	 * needs no registry of chats; this option stays for custom recovery.
	 */
	onInterrupted?: (chatId: string) => void;
	/**
	 * Page-side hold queue per observer, counted in delivered batches and
	 * estimated bytes like the runtime window; defaults to the per-consumer window.
	 */
	limits?: Partial<
		Pick<
			DeliveryLimits,
			"maxPendingMessagesPerConsumer" | "maxPendingBytesPerConsumer"
		>
	>;
}

export interface ObserveOptions {
	/** A generation started elsewhere is available from position 0; call `chat.resumeStream()`. */
	onStart?: (event: { chatId: string; generationId: string }) => void;
}

export type ObserverRole = "originator" | "follower";

/**
 * Error raised when an observed stream is lost. It is a `TypeError` whose
 * message contains "network", so the AI SDK reports `onFinish({ isDisconnect: true })`
 * (ai 7.0.116 `AbstractChat.makeRequest`). Identify it with
 * `isSpinetabError(error, "interrupted")`.
 */
export class SpinetabInterruptedError extends TypeError {
	readonly code = "interrupted" as const;
	readonly retryable = true;
	readonly detail: SerialisedError["detail"];

	constructor(reason: string) {
		super(`Spinetab network interruption: ${reason}`);
		this.name = "SpinetabError";
		this.detail = { reason };
	}
}

const KNOWN_OPTIONS = new Set([
	"client",
	"api",
	"resume",
	"stop",
	"headers",
	"body",
	"credentials",
	"onInterrupted",
	"limits",
]);

/**
 * AI SDK `ChatTransport` (ai 7.0.116) that runs generations in the Spinetab
 * runtime so tabs can observe one generation and recover through the
 * backend's resume endpoint. Start, observe, resume and stop stay separate:
 * `sendMessages` sends exactly one start; aborting a stream only detaches;
 * `stop()` is the only way to stop a generation.
 *
 * Construction is inert. Per-chat state is keyed by the application's client
 * and its auth scope, so `useChat` may recreate the transport on every render.
 * A principal change (`client.setScope`) errors every stream of the previous
 * scope with `scope-changed`, discards its held chunks (including completed but
 * unread ones), ends its `observe()` registrations (observe again under the new
 * scope) and fences request preparation that was awaiting when it happened.
 */
export class SpinetabChatTransport<UI_MESSAGE extends UIMessage = UIMessage>
	implements ChatTransport<UI_MESSAGE>
{
	readonly #client: SpinetabClient;
	readonly #api: string;
	readonly #resume: SpinetabChatTransportOptions["resume"];
	readonly #stop: SpinetabChatTransportOptions["stop"];
	readonly #headers: SpinetabChatTransportOptions["headers"];
	readonly #body: SpinetabChatTransportOptions["body"];
	readonly #credentials: SpinetabChatTransportOptions["credentials"];
	readonly #onInterrupted: SpinetabChatTransportOptions["onInterrupted"];
	readonly #limits: { maxMessages: number; maxBytes: number };

	constructor(options: SpinetabChatTransportOptions) {
		if (typeof options !== "object" || options === null) {
			throw unsupported("options", "must be an object");
		}
		for (const key of Object.keys(options)) {
			if (!KNOWN_OPTIONS.has(key)) {
				throw unsupported(
					`options.${key}`,
					key === "fetch"
						? "cannot cross the worker bridge; requests run in the Spinetab runtime"
						: "is not supported by SpinetabChatTransport",
				);
			}
		}
		const client = options.client;
		if (
			!client ||
			typeof client.subscribe !== "function" ||
			typeof client.command !== "function"
		) {
			throw unsupported("options.client", "must be a Spinetab client");
		}
		if (
			options.headers !== undefined &&
			typeof options.headers !== "function"
		) {
			refuseCredentialHeaders(
				normaliseHeaders(options.headers),
				"options.headers",
			);
		}
		this.#client = client;
		this.#api = options.api ?? "/api/chat";
		this.#resume = options.resume;
		this.#stop = options.stop;
		this.#headers = options.headers;
		this.#body = options.body;
		this.#credentials = options.credentials;
		this.#onInterrupted = options.onInterrupted;
		this.#limits = {
			maxMessages:
				options.limits?.maxPendingMessagesPerConsumer ??
				DEFAULT_LIMITS.maxPendingMessagesPerConsumer,
			maxBytes:
				options.limits?.maxPendingBytesPerConsumer ??
				DEFAULT_LIMITS.maxPendingBytesPerConsumer,
		};
		for (const [key, value] of Object.entries(this.#limits)) {
			if (!Number.isInteger(value) || value <= 0) {
				throw unsupported(
					`options.limits.${key}`,
					"must be a positive integer",
				);
			}
		}
	}

	async sendMessages(
		options: {
			trigger: "submit-message" | "regenerate-message";
			chatId: string;
			messageId: string | undefined;
			messages: UI_MESSAGE[];
			abortSignal: AbortSignal | undefined;
		} & ChatRequestOptions,
	): Promise<ReadableStream<UIMessageChunk>> {
		const { abortSignal, chatId } = options;
		throwIfAborted(abortSignal);
		const connection = this.#connection();
		// Captured before any await: every await below is fenced by its scope.
		const state = chatState(this.#client, connection.api, chatId);
		const prepared = await this.#prepare(options.headers);
		throwIfAborted(abortSignal);
		state.assertCurrent();
		const resolvedBody = await resolveValue(this.#body);
		throwIfAborted(abortSignal);
		state.assertCurrent();
		const generationId = createId();
		const body = JSON.stringify({
			...resolvedBody,
			...options.body,
			id: chatId,
			messages: options.messages,
			trigger: options.trigger,
			messageId: options.messageId,
			generationId,
		});
		state.remember(generationId);
		state.current = { generationId, role: "originator" };
		state.stopped = false;
		state.episodeOpen = false;
		state.unresumable = undefined;

		// Observe before starting so no chunk precedes the observer.
		const observation = new Observation(this.#context(state), {
			kind: "generation",
			chatId,
			generationId,
		});
		let aborted = false;
		const onAbort = () => {
			aborted = true;
			observation.detach();
		};
		abortSignal?.addEventListener("abort", onAbort, { once: true });
		const payload: AiCommandPayload = {
			type: "start",
			chatId,
			generationId,
			body,
			...prepared,
		};
		let outcome: CommandOutcome<AiCommandResult>;
		try {
			outcome = await this.#client.command<AiCommandResult>({
				adapter: AI_ADAPTER_KIND,
				connection,
				payload,
			});
		} catch (error) {
			observation.detach();
			abortSignal?.removeEventListener("abort", onAbort);
			throw error;
		}
		if (outcome.status === "acknowledged" || outcome.status === "sent") {
			if (aborted) throw abortError();
			if (state.stale()) {
				observation.detach();
				abortSignal?.removeEventListener("abort", onAbort);
				throw scopeChangedError();
			}
			return observation.stream(abortSignal, () =>
				abortSignal?.removeEventListener("abort", onAbort),
			);
		}
		observation.detach();
		abortSignal?.removeEventListener("abort", onAbort);
		if (state.current?.generationId === generationId) state.current = undefined;
		throw startError(outcome);
	}

	async reconnectToStream(
		options: { chatId: string; abortSignal?: AbortSignal } & ChatRequestOptions,
	): Promise<ReadableStream<UIMessageChunk> | null> {
		const { chatId, abortSignal } = options;
		throwIfAborted(abortSignal);
		const connection = this.#connection();
		const state = chatState(this.#client, connection.api, chatId);
		const follower = state.current
			? state.followers.get(state.current.generationId)
			: undefined;
		if (follower?.observation.claimable()) {
			state.episodeOpen = false;
			follower.observation.setInterruptHandler(this.#onInterrupted);
			return follower.observation.stream(abortSignal, undefined, () => {});
		}
		if (this.#resume === false) {
			if (state.unresumable) {
				throw new SpinetabError(
					"cannot-resume",
					"The generation cannot be observed from its current position and no resume source is configured.",
					{ detail: { reason: "no-resume-source" } },
				);
			}
			return null;
		}
		const url = resolveUrl(
			this.#resume?.api(chatId) ??
				appendPath(connection.api, `/${encodeURIComponent(chatId)}/stream`),
			"resume.api",
			this.#client,
		);
		const prepared = await this.#prepare(options.headers);
		throwIfAborted(abortSignal);
		state.assertCurrent();
		const context = this.#context(state);
		// Simultaneous resumers share one request; a joiner arriving after the
		// replay started needs its own request from the start.
		for (const nonce of ["shared", createId()]) {
			const observation = new Observation(context, {
				kind: "resume",
				url,
				nonce,
				...prepared,
			});
			const outcome = await observation.first(abortSignal);
			if (state.stale()) {
				observation.detach();
				throw scopeChangedError();
			}
			if (outcome.kind === "empty") {
				observation.detach();
				state.unresumable = undefined;
				return null;
			}
			if (outcome.kind === "chunk") {
				state.episodeOpen = false;
				state.unresumable = undefined;
				const messageId =
					outcome.chunk.type === "start" ? outcome.chunk.messageId : undefined;
				if (messageId) {
					state.current = {
						generationId: messageId,
						role: state.originated.has(messageId) ? "originator" : "follower",
					};
				}
				return observation.stream(abortSignal);
			}
			observation.detach();
			if (
				outcome.error.code === "late-join-unsupported" &&
				nonce === "shared"
			) {
				continue;
			}
			throw toPageError(outcome.error);
		}
		throw new SpinetabError(
			"cannot-resume",
			"The resume stream could not be joined from its start.",
			{ detail: { reason: "position-incompatible" } },
		);
	}

	/**
	 * Pre-attach observation of generations started by any tab for `chatId`.
	 * Returns a disposer. `onStart` fires when a generation is available from
	 * position 0; the application then calls `chat.resumeStream()`.
	 */
	observe(chatId: string, options: ObserveOptions = {}): () => void {
		const connection = this.#connection();
		const state = chatState(this.#client, connection.api, chatId);
		return state.observe(this.#client, connection, this.#limits, options);
	}

	/**
	 * Follow a chat: resume it when another tab starts a generation (from
	 * position 0) and after an actual loss of its observed stream, once per
	 * recovery episode. Pass the chat's `resumeStream`; returns a disposer, so
	 * `useEffect(() => transport.follow(id, resumeStream), [id, resumeStream])`
	 * is the whole recipe.
	 *
	 * Bounded: suppressed after `stop()` until a new
	 * start; one call per trigger, and triggers that land together coalesce
	 * into one call per `follow` registration; never called for a bare page
	 * or network hint; a failed resume is never retried. A principal change
	 * ends the registration, as it ends `observe()`: follow again under the
	 * new scope.
	 */
	follow(chatId: string, resume: () => void): () => void {
		if (typeof resume !== "function") {
			throw unsupported("follow.resume", "must be a function");
		}
		const connection = this.#connection();
		const state = chatState(this.#client, connection.api, chatId);
		const entry = { resume };
		state.follows.add(entry);
		const unobserve = state.observe(this.#client, connection, this.#limits, {
			onStart: () => state.requestFollow(),
		});
		let disposed = false;
		return () => {
			if (disposed) return;
			disposed = true;
			state.follows.delete(entry);
			unobserve();
		};
	}

	/** Role of this page for the chat's latest generation, for gating side effects. */
	role(chatId: string): ObserverRole | undefined {
		return chatState(this.#client, this.#connection().api, chatId).current
			?.role;
	}

	/**
	 * Explicitly stop the chat's current generation through the application's
	 * stop endpoint. Sent once, never retried; the outcome is returned as is.
	 */
	async stop(chatId: string): Promise<CommandOutcome<AiCommandResult>> {
		if (!this.#stop) {
			throw new SpinetabError(
				"stop-unavailable",
				"No stop endpoint is configured for this chat transport.",
				{ detail: { reason: "not-configured" } },
			);
		}
		const connection = this.#connection();
		const state = chatState(this.#client, connection.api, chatId);
		const generationId = state.current?.generationId;
		if (!generationId) {
			throw new SpinetabError(
				"stop-unavailable",
				"There is no known generation to stop for this chat.",
				{ detail: { reason: "no-active-generation" } },
			);
		}
		const url = resolveUrl(
			this.#stop.api(chatId, generationId),
			"stop.api",
			this.#client,
		);
		// The stop is decided here, before any await: a recovery callback that
		// is already queued must not dispatch while headers or credentials are
		// prepared. It stays set if preparation fails, since
		// `onInterrupted` is documented as never called after `stop()`; a new
		// start clears it.
		state.stopped = true;
		const prepared = await this.#prepare(undefined);
		// Never stop an earlier principal's generation with the new session.
		state.assertCurrent();
		return this.#client.command<AiCommandResult>({
			adapter: AI_ADAPTER_KIND,
			connection,
			payload: { type: "stop", chatId, generationId, url, ...prepared },
		});
	}

	#connection(): AiConnectionSpec {
		return { api: resolveUrl(this.#api, "api", this.#client) };
	}

	async #prepare(extra: ChatRequestOptions["headers"]): Promise<{
		headers?: Record<string, string>;
		credentials?: AiFetchCredentials;
	}> {
		const own = normaliseHeaders(await resolveValue(this.#headers));
		refuseCredentialHeaders(own, "options.headers");
		const perRequest = normaliseHeaders(extra);
		refuseCredentialHeaders(perRequest, "headers");
		const headers = { ...own, ...perRequest };
		const credentials = await resolveValue(this.#credentials);
		return {
			...(Object.keys(headers).length > 0 ? { headers } : {}),
			...(credentials === undefined ? {} : { credentials }),
		};
	}

	#context(state: ChatState): ObservationContext {
		return {
			client: this.#client,
			connection: this.#connection(),
			limits: this.#limits,
			state,
			onInterrupted: this.#onInterrupted,
		};
	}
}

// Per-chat page state -------------------------------------------------------

interface ObservationContext {
	client: SpinetabClient;
	connection: AiConnectionSpec;
	limits: { maxMessages: number; maxBytes: number };
	state: ChatState;
	onInterrupted: ((chatId: string) => void) | undefined;
}

interface Follower {
	observation: Observation;
}

const MAX_REMEMBERED_GENERATIONS = 32;
const statesByClient = new WeakMap<SpinetabClient, Map<string, ChatState>>();

/**
 * Per-chat state of one principal: keyed by client, auth scope, endpoint and
 * chat id. Looking a chat up under a new scope retires every state of another
 * scope first, so nothing from an old principal can be claimed afterwards.
 */
function chatState(
	client: SpinetabClient,
	api: string,
	chatId: string,
): ChatState {
	let states = statesByClient.get(client);
	if (!states) {
		states = new Map();
		statesByClient.set(client, states);
	}
	const scope = client.scope;
	for (const state of states.values()) {
		if (state.scope !== scope) state.retire();
	}
	const key = JSON.stringify([scope, api, chatId]);
	let state = states.get(key);
	if (!state) {
		state = new ChatState(client, scope, chatId, () => {
			if (states.get(key) === state) states.delete(key);
		});
		states.set(key, state);
	}
	return state;
}

class ChatState {
	readonly client: SpinetabClient;
	readonly scope: string;
	readonly chatId: string;
	/** Set once on a principal change; a retired state never delivers again. */
	retired = false;
	readonly #forget: () => void;
	/** Every observation holding page-side data or a waiting read. */
	readonly #observations = new Set<Observation>();
	current: { generationId: string; role: ObserverRole } | undefined;
	/** Generations started by this page; never observed as a follower. */
	readonly originated = new Set<string>();
	readonly followers = new Map<string, Follower>();
	/** Explicit stop suppresses interruption callbacks until a new start. */
	stopped = false;
	/** An interruption callback already ran in this recovery episode. */
	episodeOpen = false;
	/** Identifies the episode a queued interruption callback belongs to. */
	episode = 0;
	/** A generation is known to be active but not observable here. */
	unresumable: string | undefined;
	/** `follow()` registrations; each is called once per coalesced trigger. */
	readonly follows = new Set<{ resume: () => void }>();
	#followQueued = false;
	#observe:
		| {
				subscription: Subscription<AiObserveEvent>;
				listeners: Set<ObserveOptions>;
				context: ObservationContext;
		  }
		| undefined;

	constructor(
		client: SpinetabClient,
		scope: string,
		chatId: string,
		forget: () => void,
	) {
		this.client = client;
		this.scope = scope;
		this.chatId = chatId;
		this.#forget = forget;
	}

	/** True when the client's principal is no longer the one this state serves. */
	stale(): boolean {
		if (!this.retired && this.client.scope !== this.scope) this.retire();
		return this.retired;
	}

	/** Fence after every await: throws `scope-changed` once the principal changed. */
	assertCurrent(): void {
		if (this.stale()) throw scopeChangedError();
	}

	track(observation: Observation): void {
		if (this.retired) observation.revoke(scopeChangedError());
		else this.#observations.add(observation);
	}

	untrack(observation: Observation): void {
		this.#observations.delete(observation);
	}

	/**
	 * Principal change: end the observe subscription and its callbacks, and
	 * error every observation with `scope-changed`, discarding open, completed
	 * but unread and waiting queues alike. Idempotent.
	 */
	retire(): void {
		if (this.retired) return;
		this.retired = true;
		this.#forget();
		const observe = this.#observe;
		this.#observe = undefined;
		observe?.listeners.clear();
		observe?.subscription.unsubscribe();
		const error = scopeChangedError();
		for (const observation of [...this.#observations]) {
			observation.revoke(error);
		}
		this.#observations.clear();
		for (const follower of this.followers.values()) {
			follower.observation.revoke(error);
		}
		this.followers.clear();
		this.originated.clear();
		this.follows.clear();
		this.current = undefined;
		this.unresumable = undefined;
	}

	/**
	 * Queue one resume per `follow()` registration. Triggers that arrive before
	 * the queued dispatch runs coalesce into it; eligibility (no principal
	 * change, no explicit stop) is checked again at dispatch.
	 */
	requestFollow(): void {
		if (this.follows.size === 0 || this.#followQueued) return;
		this.#followQueued = true;
		setTimeout(() => {
			this.#followQueued = false;
			if (this.stale() || this.stopped) return;
			for (const entry of [...this.follows]) {
				if (!this.follows.has(entry)) continue;
				try {
					entry.resume();
				} catch (error) {
					reportCallbackError(error);
				}
			}
		}, 0);
	}

	remember(generationId: string): void {
		this.originated.add(generationId);
		if (this.originated.size > MAX_REMEMBERED_GENERATIONS) {
			const oldest = this.originated.values().next().value;
			if (oldest !== undefined) this.originated.delete(oldest);
		}
	}

	observe(
		client: SpinetabClient,
		connection: AiConnectionSpec,
		limits: { maxMessages: number; maxBytes: number },
		options: ObserveOptions,
	): () => void {
		const listener = { ...options };
		if (this.stale()) return () => {};
		if (!this.#observe) {
			const context: ObservationContext = {
				client,
				connection,
				limits,
				state: this,
				onInterrupted: undefined,
			};
			const request: SubscriptionRequest<AiObserveEvent> = {
				adapter: AI_ADAPTER_KIND,
				connection,
				subscription: {
					kind: "observe",
					chatId: this.chatId,
				} satisfies AiSubscriptionSpec,
				repeatable: true,
			};
			const listeners = new Set<ObserveOptions>();
			let subscription: Subscription<AiObserveEvent> | undefined;
			let recovering = false;
			let lossNotice: SubscriptionStatus["continuity"] | undefined;
			subscription = client.subscribe<AiObserveEvent>(request, {
				next: (event) => {
					// Recover discovery only at the beginning of a new observable
					// generation. Interrupted chunk queues remain errored; no prompt
					// or missing chunks are replayed here.
					if (
						recovering &&
						event.type === "chunks" &&
						event.index === 0 &&
						observedChunks(event)
					) {
						recovering = false;
						subscription?.markReconciled();
					}
					this.#onObserveEvent(context, listeners, event);
				},
				error: (error) => {
					if (error.code === "scope-changed") this.retire();
					else this.#failFollowers(toLoss(error));
				},
				status: (status) => {
					if (isScopeChange(status)) return this.retire();
					const loss = continuityLoss(status);
					if (!loss || lossNotice === status.continuity) return;
					lossNotice = status.continuity;
					this.#failFollowers(loss);
					if (status.continuity.reason === "overflow") {
						recovering = true;
						subscription?.markReconciled({ pending: true });
					} else if (status.continuity.state === "unknown") recovering = true;
				},
			});
			if (recovering && lossNotice?.reason === "overflow")
				subscription.markReconciled({ pending: true });
			this.#observe = { subscription, listeners, context };
		}
		const observe = this.#observe;
		observe.listeners.add(listener);
		let disposed = false;
		return () => {
			if (disposed) return;
			disposed = true;
			observe.listeners.delete(listener);
			if (observe.listeners.size > 0 || this.#observe !== observe) return;
			this.#observe = undefined;
			observe.subscription.unsubscribe();
			for (const follower of this.followers.values()) {
				follower.observation.fail(abortError(), false);
			}
			this.followers.clear();
		};
	}

	#onObserveEvent(
		context: ObservationContext,
		listeners: Set<ObserveOptions>,
		event: AiObserveEvent,
	): void {
		if (this.stale() || this.originated.has(event.generationId)) return;
		const follower = this.followers.get(event.generationId);
		if (event.type === "end") {
			if (this.unresumable === event.generationId) this.unresumable = undefined;
			if (!follower) return;
			if (event.outcome === "complete") follower.observation.close();
			else follower.observation.fail(...lossFromEnd(event.error));
			// A complete, unclaimed queue stays available to one reader.
			if (follower.observation.isStreamed()) {
				this.followers.delete(event.generationId);
			}
			return;
		}
		const chunks = observedChunks(event);
		if (!chunks) return;
		if (follower) {
			follower.observation.push(chunks);
			return;
		}
		this.current = { generationId: event.generationId, role: "follower" };
		this.stopped = false;
		if (event.index !== 0) {
			// Joined mid-stream: only a resume source can serve this position.
			this.unresumable = event.generationId;
			return;
		}
		for (const [id, previous] of this.followers) {
			if (previous.observation.isStreamed()) continue;
			previous.observation.fail(abortError(), false);
			this.followers.delete(id);
		}
		const observation = Observation.followerQueue(context);
		this.followers.set(event.generationId, { observation });
		this.episodeOpen = false;
		this.unresumable = undefined;
		observation.push(chunks);
		const generationId = event.generationId;
		queueMicrotask(() => {
			if (this.stale()) return;
			for (const listener of [...listeners]) {
				try {
					listener.onStart?.({ chatId: this.chatId, generationId });
				} catch (error) {
					reportCallbackError(error);
				}
			}
		});
	}

	#failFollowers(loss: Loss): void {
		for (const follower of this.followers.values()) {
			follower.observation.fail(loss.error, loss.interruption);
		}
	}
}

// Observations ---------------------------------------------------------------

type Loss = { error: Error; interruption: boolean };
type FirstOutcome =
	| { kind: "chunk"; chunk: UIMessageChunk }
	| { kind: "empty" }
	| { kind: "error"; error: SerialisedError };

/**
 * One page-side observer: a Spinetab consumer (optional) plus a bounded hold
 * queue exposed as a pull-based `ReadableStream`. The queue holds at most the
 * per-consumer window; exceeding it errors this observer with `overflow`.
 */
class Observation {
	readonly #context: ObservationContext;
	#subscription: Subscription<AiStreamEvent> | undefined;
	/** Unread batches as delivered by the runtime; bounded like its window. */
	#buffer: Array<{ chunks: UIMessageChunk[]; offset: number; bytes: number }> =
		[];
	#bytes = 0;
	#delivered = 0;
	#state: "open" | "closed" | "errored" = "open";
	#error: unknown;
	#wake: (() => void) | undefined;
	#detached = false;
	#streamed = false;
	#first:
		| {
				promise: Promise<FirstOutcome>;
				resolve: (outcome: FirstOutcome) => void;
		  }
		| undefined;
	#lastError: SerialisedError | undefined;

	#onInterrupted: ((chatId: string) => void) | undefined;
	/** Unclaimed follower queues report loss so the application can resume. */
	#follower = false;

	/** Position-0 queue fed by the chat's `observe` subscription. */
	static followerQueue(context: ObservationContext): Observation {
		const observation = new Observation(context, undefined);
		observation.#follower = true;
		return observation;
	}

	constructor(
		context: ObservationContext,
		spec: AiSubscriptionSpec | undefined,
	) {
		this.#context = context;
		this.#onInterrupted = context.onInterrupted;
		let resolveFirst!: (outcome: FirstOutcome) => void;
		const promise = new Promise<FirstOutcome>((resolve) => {
			resolveFirst = resolve;
		});
		this.#first = { promise, resolve: resolveFirst };
		context.state.track(this);
		if (!spec || this.#state !== "open") return;
		const request: SubscriptionRequest<AiStreamEvent> = {
			adapter: AI_ADAPTER_KIND,
			connection: context.connection,
			subscription: spec,
			share: "before-start",
			stateful: true,
			repeatable: false,
		};
		this.#subscription = context.client.subscribe<AiStreamEvent>(request, {
			next: (chunks) => this.push(chunks),
			error: (error) => {
				if (error.code === "scope-changed") return context.state.retire();
				this.#lastError = error;
				const loss = toLoss(error);
				this.fail(loss.error, loss.interruption);
			},
			complete: () => this.close(),
			status: (status) => {
				if (isScopeChange(status)) return context.state.retire();
				const loss = continuityLoss(status);
				if (loss) this.fail(loss.error, loss.interruption);
			},
		});
	}

	claimable(): boolean {
		return (
			!this.#context.state.stale() &&
			!this.#streamed &&
			!this.#detached &&
			this.#state !== "errored"
		);
	}

	isStreamed(): boolean {
		return this.#streamed;
	}

	setInterruptHandler(handler: ((chatId: string) => void) | undefined): void {
		this.#onInterrupted = handler;
	}

	push(chunks: AiStreamEvent): void {
		if (
			this.#state !== "open" ||
			this.#detached ||
			!Array.isArray(chunks) ||
			chunks.length === 0
		) {
			return;
		}
		// A principal change retires the state, which revokes this observation.
		if (this.#context.state.stale()) return;
		const bytes = estimateBytes(chunks) ?? Number.POSITIVE_INFINITY;
		if (
			this.#buffer.length + 1 > this.#context.limits.maxMessages ||
			this.#bytes + bytes > this.#context.limits.maxBytes
		) {
			this.fail(
				new SpinetabError(
					"overflow",
					"This observer fell behind the AI stream and exceeded its bounded queue; resume to recover.",
					{ detail: { reason: "observer-overflow" } },
				),
				true,
			);
			return;
		}
		this.#buffer.push({ chunks, offset: 0, bytes });
		this.#bytes += bytes;
		this.#first?.resolve({ kind: "chunk", chunk: chunks[0] as UIMessageChunk });
		this.#wakeReader();
	}

	close(): void {
		if (this.#state !== "open") return;
		this.#state = "closed";
		this.#first?.resolve({ kind: "empty" });
		this.#unsubscribe();
		this.#wakeReader();
	}

	fail(error: unknown, interruption: boolean): void {
		if (this.#state !== "open") return;
		this.#errorOut(error);
		// A start whose stream was never returned is reported by `sendMessages`.
		if (interruption && !this.#detached && (this.#streamed || this.#follower)) {
			this.#notifyInterrupted();
		}
	}

	/**
	 * Principal change: error with `scope-changed` and discard held chunks even
	 * when the queue already completed, so no old-scope data can be read.
	 */
	revoke(error: SpinetabError): void {
		if (this.#detached || this.#state === "errored") return;
		this.#errorOut(error);
	}

	#errorOut(error: unknown): void {
		this.#state = "errored";
		this.#error = error;
		this.#buffer = [];
		this.#bytes = 0;
		this.#context.state.untrack(this);
		this.#first?.resolve({
			kind: "error",
			error:
				this.#lastError ??
				(isRecord(error) && typeof error.code === "string"
					? {
							code: error.code as SerialisedError["code"],
							message: String(error.message),
						}
					: { code: "interrupted", message: "The stream was interrupted." }),
		});
		this.#unsubscribe();
		this.#wakeReader();
	}

	/** Observer departure only: never a stop. */
	detach(): void {
		if (this.#detached) return;
		this.#detached = true;
		this.#buffer = [];
		this.#bytes = 0;
		this.#context.state.untrack(this);
		this.#first?.resolve({
			kind: "error",
			error: { code: "aborted", message: "The observer detached." },
		});
		this.#unsubscribe();
		this.#wakeReader();
	}

	first(signal: AbortSignal | undefined): Promise<FirstOutcome> {
		const first =
			this.#first?.promise ?? Promise.resolve({ kind: "empty" } as const);
		if (!signal) return first;
		return new Promise<FirstOutcome>((resolve, reject) => {
			const onAbort = () => {
				this.detach();
				reject(abortError());
			};
			if (signal.aborted) return onAbort();
			signal.addEventListener("abort", onAbort, { once: true });
			first.then((outcome) => {
				signal.removeEventListener("abort", onAbort);
				resolve(outcome);
			}, reject);
		});
	}

	stream(
		signal: AbortSignal | undefined,
		onDone?: () => void,
		onCancelUnread?: () => void,
	): ReadableStream<UIMessageChunk> {
		this.#streamed = true;
		this.#first = undefined;
		let finished = false;
		const finish = () => {
			if (finished) return;
			finished = true;
			this.#context.state.untrack(this);
			signal?.removeEventListener("abort", onAbort);
			onDone?.();
		};
		const onAbort = () => cancel();
		const cancel = () => {
			finish();
			if (
				this.#delivered === 0 &&
				onCancelUnread &&
				this.#state !== "errored"
			) {
				// Cancelled before reading anything (Strict Mode): offer it again.
				this.#streamed = false;
				onCancelUnread();
				return;
			}
			this.detach();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		return new ReadableStream<UIMessageChunk>(
			{
				pull: async (controller) => {
					for (;;) {
						// Checked on every read: a waiting or completed queue of an
						// earlier principal errors instead of delivering.
						if (this.#context.state.stale()) {
							this.revoke(scopeChangedError());
						}
						if (this.#detached) {
							finish();
							controller.close();
							return;
						}
						const head = this.#buffer[0];
						const chunk = head?.chunks[head.offset];
						if (head && chunk !== undefined) {
							head.offset += 1;
							if (head.offset >= head.chunks.length) {
								this.#buffer.shift();
								this.#bytes -= head.bytes;
							}
							this.#delivered += 1;
							controller.enqueue(chunk);
							return;
						}
						if (this.#state === "closed") {
							finish();
							controller.close();
							return;
						}
						if (this.#state === "errored") {
							finish();
							controller.error(this.#error);
							return;
						}
						await new Promise<void>((resolve) => {
							this.#wake = resolve;
						});
					}
				},
				cancel: () => cancel(),
			},
			{ highWaterMark: 0 },
		);
	}

	#wakeReader(): void {
		const wake = this.#wake;
		this.#wake = undefined;
		wake?.();
	}

	#unsubscribe(): void {
		const subscription = this.#subscription;
		this.#subscription = undefined;
		subscription?.unsubscribe();
	}

	#notifyInterrupted(): void {
		const { state } = this.#context;
		const onInterrupted = this.#onInterrupted;
		if (state.retired || state.stopped || state.episodeOpen) return;
		if (state.current) state.unresumable = state.current.generationId;
		if (!onInterrupted && state.follows.size === 0) return;
		state.episodeOpen = true;
		const episode = ++state.episode;
		// After the interrupted stream has errored inside the SDK. Eligibility is
		// checked again at dispatch: an explicit stop, a principal change, a new
		// start or a recovery may have landed in between.
		setTimeout(() => {
			if (
				state.stale() ||
				state.stopped ||
				!state.episodeOpen ||
				state.episode !== episode
			) {
				return;
			}
			try {
				onInterrupted?.(state.chatId);
			} catch (error) {
				reportCallbackError(error);
			}
			state.requestFollow();
		}, 0);
	}
}

// Helpers --------------------------------------------------------------------

const LOSS_CODES = new Set([
	"interrupted",
	"attachment-retired",
	"runtime-unavailable",
	"retry-exhausted",
]);
/** `unknown` continuity that follows an actual interruption of delivery. */
const UNKNOWN_LOSS_REASONS = new Set([
	"runtime-replaced",
	"lease-expired",
	"reconnected",
	"reopened",
	"decode-error",
]);
const DELIVERY_CODES = new Set([
	"overflow",
	"message-too-large",
	"event-not-serialisable",
]);

function toLoss(error: SerialisedError): Loss {
	if (LOSS_CODES.has(error.code)) {
		return {
			error: new SpinetabInterruptedError(error.code),
			interruption: true,
		};
	}
	return {
		error: toPageError(error),
		interruption: DELIVERY_CODES.has(error.code),
	};
}

function lossFromEnd(error: SerialisedError): [Error, boolean] {
	const loss = toLoss(error);
	return [loss.error, loss.interruption];
}

/** Actual loss only: a status change without lost delivery is not an interruption. */
function continuityLoss(status: SubscriptionStatus): Loss | undefined {
	const { continuity } = status;
	if (continuity.state === "gap") {
		const reason = continuity.reason;
		const code =
			reason === "message-too-large" || reason === "event-not-serialisable"
				? reason
				: "overflow";
		return {
			error: new SpinetabError(
				code,
				`The observed AI stream lost delivery (${reason ?? "gap"}).`,
				{
					detail: { reason: reason ?? "gap" },
				},
			),
			interruption: true,
		};
	}
	if (
		continuity.state === "unknown" &&
		UNKNOWN_LOSS_REASONS.has(continuity.reason ?? "")
	) {
		return {
			error: new SpinetabInterruptedError(
				continuity.reason ?? "continuity-unknown",
			),
			interruption: true,
		};
	}
	return undefined;
}

/**
 * Chunks of an observe event. The bridge sends ordered, non-empty batches. No other shape is accepted: a malformed event
 * yields nothing and is ignored rather than thrown into the client's callback.
 */
function observedChunks(event: AiObserveEvent): UIMessageChunk[] | undefined {
	const batch = (event as { chunks?: unknown }).chunks;
	if (Array.isArray(batch) && batch.length > 0)
		return batch as UIMessageChunk[];
	return undefined;
}

function toPageError(error: SerialisedError): SpinetabError {
	return deserialiseError(error);
}

/** The client reports a principal change on every registration it keeps. */
function isScopeChange(status: SubscriptionStatus): boolean {
	return (
		status.continuity.state === "unknown" &&
		status.continuity.reason === "scope-changed"
	);
}

function scopeChangedError(): SpinetabError {
	return new SpinetabError(
		"scope-changed",
		"The auth scope changed; AI stream data from the previous scope was discarded.",
	);
}

function startError(outcome: CommandOutcome<AiCommandResult>): Error {
	if (outcome.status === "rejected") return toPageError(outcome.error);
	if (outcome.status === "not-sent") {
		return new SpinetabError("command-not-sent", outcome.error.message, {
			detail: { cause: outcome.error.code },
			retryable: true,
		});
	}
	if (outcome.status === "unknown") {
		return new SpinetabError(
			"command-unknown",
			`The generation start may have reached the backend and is not resent: ${outcome.error.message}`,
			{ detail: { cause: outcome.error.code } },
		);
	}
	return new SpinetabError("command-unknown", "Unexpected start outcome.");
}

function unsupported(path: string, reason: string): SpinetabError {
	return new SpinetabError("unsupported-option", `${path} ${reason}.`, {
		detail: { path },
	});
}

function abortError(): Error {
	return new DOMException("The operation was aborted.", "AbortError");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw abortError();
}

async function resolveValue<T>(
	value: Resolvable<T> | undefined,
): Promise<T | undefined> {
	return typeof value === "function"
		? await (value as () => T | Promise<T>)()
		: value;
}

function normaliseHeaders(
	headers: HeadersInput | undefined,
): Record<string, string> {
	const result: Record<string, string> = {};
	if (!headers) return result;
	if (typeof Headers !== "undefined" && headers instanceof Headers) {
		headers.forEach((value, key) => {
			result[key] = value;
		});
		return result;
	}
	for (const [key, value] of Object.entries(headers)) {
		if (typeof value === "string") result[key] = value;
	}
	return result;
}

/** Credential headers come only from the client's credentials provider. */
function refuseCredentialHeaders(
	headers: Record<string, string>,
	path: string,
): void {
	for (const name of Object.keys(headers)) {
		const refusal = credentialHeaderRefusal(name, `${path}.${name}`);
		if (refusal) {
			throw new SpinetabError("unsupported-option", refusal, {
				detail: { path: `${path}.${name}` },
			});
		}
	}
}

/**
 * Resolve against the client's own base (its `baseUrl`, else the document base
 * it read at start), as the client resolves `connection.url`. A client
 * not made by `createSpinetab` falls back to the document base.
 */
function resolveUrl(url: string, path: string, client: SpinetabClient): string {
	let base: string | undefined;
	try {
		const ownBase = clientBase(client);
		base = ownBase
			? ownBase()
			: (globalThis.document?.baseURI ?? globalThis.location?.href);
	} catch {
		base = undefined;
	}
	let resolved: URL;
	try {
		resolved = base === undefined ? new URL(url) : new URL(url, base);
	} catch {
		throw new SpinetabError(
			"invalid-endpoint",
			`${path} must be an absolute URL or resolvable against the client's base.`,
			{ detail: { path } },
		);
	}
	if (resolved.username || resolved.password) {
		throw new SpinetabError(
			"invalid-endpoint",
			`${path} must not contain credentials.`,
			{
				detail: { path },
			},
		);
	}
	return resolved.href;
}

function appendPath(url: string, path: string): string {
	const index = url.search(/[?#]/);
	return index === -1
		? `${url}${path}`
		: `${url.slice(0, index)}${path}${url.slice(index)}`;
}

function createId(): string {
	const crypto = globalThis.crypto;
	if (typeof crypto?.randomUUID === "function") {
		try {
			return crypto.randomUUID();
		} catch {
			// Insecure contexts expose getRandomValues only.
		}
	}
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
		"",
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function reportCallbackError(error: unknown): void {
	if (typeof reportError === "function") reportError(error);
	else
		setTimeout(() => {
			throw error;
		}, 0);
}
