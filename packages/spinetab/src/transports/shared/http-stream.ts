import type { ConnectionContext } from "../../core/adapter.ts";
import {
	isSpinetabError,
	SpinetabError,
	toSerialisedError,
} from "../../core/errors.ts";
import type {
	ConnectionReason,
	ConnectionStatus,
	CredentialRequest,
	SerialisedError,
} from "../../core/types.ts";
import { type Backoff, createBackoff } from "./backoff.ts";
import {
	type AuthHeaders,
	type BlockedReason,
	classifyStatus,
	credentialHeaders,
	httpCode,
	NO_REDIRECT,
} from "./http.ts";

/**
 * One supervised fetch stream per connection identity, shared by fetch-mode
 * SSE and `spinetab/stream`. It owns the single native retry loop,
 * classifies responses before parsing, obtains credentials from the
 * scope's broker on every attempt, enforces the declared inbound
 * expectation and never restarts non-repeatable work.
 *
 * Every asynchronous step is fenced by a generation number, so a superseded
 * request can never deliver after an abort, stop or restart.
 */
export type RestartKind = "reconnected" | "reopened";

export interface HttpStreamSession {
	/** Feed one body chunk; throw a `frame-too-large` or `malformed-frame` SpinetabError to fail. */
	push(chunk: Uint8Array): void;
	/** Clean end of body; may deliver remaining frames or throw like `push`. */
	end(): void;
}

export type AcceptResult =
	| "ok"
	| "complete"
	| { code: SerialisedError["code"]; message: string };

export interface HttpStreamConfig {
	ctx: ConnectionContext;
	/** May restart automatically (reconnect, reopen). Non-repeatable work settles `interrupted`. */
	repeatable: boolean;
	/** Credential headers: unset (auto), `true` or `false`. */
	authHeaders: AuthHeaders;
	/** Declared inbound expectation; any received bytes count as liveness. */
	expectInboundWithinMs?: number;
	/** Clean end of a repeatable body: complete (streams) or reconnect (SSE). */
	endOfBody: "complete" | "reconnect";
	/**
	 * Build the request for one attempt: the URL first, judged for credentials, then the init with the provider headers, if any. `request()` may
	 * throw an `unsupported-option` SpinetabError (a worker hook returned a bad
	 * URL); a throwing `init()` fails the connection with a fixed
	 * `unsupported-option` sentence.
	 */
	request(): {
		url: string;
		init(credentials: Record<string, string> | undefined): RequestInit;
	};
	/** Validate a 2xx response before its body is read. */
	accept(response: Response): AcceptResult;
	/** A fresh framing session per response. */
	open(response: Response): HttpStreamSession;
	/** Publish the reconnect outcome before connected restores delivery. */
	established(restart: RestartKind | undefined): void;
	/**
	 * The live response ended, cut off or deliberately reopened: the
	 * subscriptions live now are owed the reconnect outcome at `established`.
	 */
	lost(): void;
	/**
	 * Delivery is down: subscriptions owed an outcome and not yet told are told
	 * at once (the early notice). Called before any status reports the loss; a
	 * deliberate reopen reports only its outcome, unless the reopen fails.
	 */
	interrupted(restart: RestartKind): void;
	/** Terminal error for every subscription. */
	terminal(error: SerialisedError): void;
	/** Clean completion for every subscription. */
	complete(): void;
	backoff?: Backoff;
}

export interface HttpStream {
	/** Start (or restart after completion) when the first subscription arrives. */
	start(): void;
	/** The last subscription left: abort and release everything. */
	stop(): void;
	probe(): void;
	retry(): void;
	rotate(): void;
	dispose(): void;
	readonly backoff: Backoff;
}

type Phase =
	| "idle"
	| "connecting"
	| "open"
	| "waiting"
	| "blocked"
	| "exhausted"
	| "failed"
	| "done"
	| "disposed";

export function createHttpStream(config: HttpStreamConfig): HttpStream {
	const { ctx } = config;
	const backoff = config.backoff ?? createBackoff();
	let phase: Phase = "idle";
	let generation = 0;
	let controller: AbortController | undefined;
	let retryTimer: ReturnType<typeof setTimeout> | undefined;
	let livenessTimer: ReturnType<typeof setTimeout> | undefined;
	let lastInbound = 0;
	let pendingRestart: RestartKind | undefined;
	let credentialReason: CredentialRequest["reason"] = "connect";
	let everStarted = false;
	const headersFor = credentialHeaders(ctx, config.authHeaders);

	const setStatus = (status: Omit<ConnectionStatus, "since">) => {
		if (phase !== "disposed") ctx.setStatus(status);
	};

	/** The early notice for a pending restart, before a status reports the loss. */
	const reportLoss = () => {
		if (pendingRestart !== undefined) config.interrupted(pendingRestart);
	};

	const clearTimers = () => {
		if (retryTimer !== undefined) clearTimeout(retryTimer);
		if (livenessTimer !== undefined) clearTimeout(livenessTimer);
		retryTimer = undefined;
		livenessTimer = undefined;
	};

	const cancelCurrent = () => {
		generation += 1;
		clearTimers();
		controller?.abort();
		controller = undefined;
	};

	const terminal = (error: SerialisedError) => {
		cancelCurrent();
		config.terminal(error);
	};

	/**
	 * Blocked on credentials. `credentials-audience` is permanent: only an
	 * explicit retry tries again, never a rotation.
	 */
	const block = (reason: BlockedReason, status?: number) => {
		cancelCurrent();
		phase = reason === "credentials-audience" ? "failed" : "blocked";
		reportLoss();
		setStatus(
			status === undefined
				? { state: "auth-blocked", reason }
				: { state: "auth-blocked", reason, code: httpCode(status) },
		);
		if (!config.repeatable) {
			config.terminal({
				code: "auth-blocked",
				message: "The request was not authorised; it is not retried.",
				detail: { reason, ...(status === undefined ? {} : { status }) },
			});
		}
	};

	/** 403, an unfollowed redirect or another permanent status. */
	const permanent = (status: number, code: string | number) => {
		cancelCurrent();
		phase = "failed";
		reportLoss();
		setStatus({ state: "failed", reason: "permanent-error", code });
		if (!config.repeatable) {
			config.terminal({
				code: "upstream-error",
				message:
					code === "redirect"
						? "The server redirected a request that carried credentials; redirects are not followed."
						: "The server rejected the request.",
				detail: { status },
			});
		}
	};

	/** A worker hook produced an unusable request: fail, never retry. */
	const invalid = (error: unknown) => {
		cancelCurrent();
		phase = "failed";
		reportLoss();
		setStatus({
			state: "failed",
			reason: "permanent-error",
			code: "unsupported-option",
		});
		config.terminal(toSerialisedError(error, "unsupported-option"));
	};

	const fatal = (error: SerialisedError) => {
		cancelCurrent();
		phase = "failed";
		setStatus({ state: "failed", reason: "protocol-error", code: error.code });
		config.terminal(error);
	};

	const scheduleReconnect = (
		reason: ConnectionReason,
		retryAfterMs?: number,
		code?: number,
	) => {
		cancelCurrent();
		reportLoss();
		const step = backoff.fail(ctx.now(), retryAfterMs);
		if (step.kind === "exhausted") {
			phase = "exhausted";
			setStatus({ state: "retry-exhausted", reason: step.reason });
			return;
		}
		phase = "waiting";
		const status: Omit<ConnectionStatus, "since"> = {
			state: "reconnecting",
			reason,
			attempt: step.attempt,
			retryAt: Date.now() + step.delayMs,
		};
		if (code !== undefined) status.code = code;
		setStatus(status);
		retryTimer = setTimeout(() => {
			retryTimer = undefined;
			void attempt();
		}, step.delayMs);
	};

	/** An open (or opening) stream was cut off. */
	const interrupted = (reason: ConnectionReason, wasOpen: boolean) => {
		if (!config.repeatable) {
			terminal({
				code: "interrupted",
				message:
					"The stream was interrupted and is not repeatable; its outcome is unknown.",
				detail: { reason },
			});
			return;
		}
		if (wasOpen) {
			pendingRestart ??= "reconnected";
			config.lost();
		}
		scheduleReconnect(reason);
	};

	const armLiveness = () => {
		if (livenessTimer !== undefined) clearTimeout(livenessTimer);
		livenessTimer = undefined;
		const within = config.expectInboundWithinMs;
		if (within === undefined) return;
		const remaining = Math.max(within - (ctx.now() - lastInbound), 0);
		livenessTimer = setTimeout(checkLiveness, remaining);
	};

	const checkLiveness = () => {
		livenessTimer = undefined;
		const within = config.expectInboundWithinMs;
		if (
			within === undefined ||
			(phase !== "open" && (phase !== "connecting" || !controller))
		) {
			return;
		}
		// Executable time excludes suspension: a deadline missed while
		// suspended is re-armed, not treated as proof of failure.
		if (ctx.now() - lastInbound < within) {
			armLiveness();
			return;
		}
		ctx.diagnostic({ type: "heartbeat-missed", detail: { within } });
		interrupted("heartbeat-timeout", phase === "open");
	};

	const attempt = async (): Promise<void> => {
		// Backoff-scheduled attempts keep their `reconnecting` status.
		const announce = phase !== "waiting";
		cancelCurrent();
		const current = generation;
		everStarted = true;
		phase = "connecting";
		if (announce) setStatus({ state: "connecting" });
		let request: ReturnType<HttpStreamConfig["request"]>;
		try {
			request = config.request();
		} catch (error) {
			invalid(error);
			return;
		}
		const credentials = await headersFor(credentialReason, request.url);
		if (current !== generation) return;
		if (credentials.kind === "aborted") return;
		if (credentials.kind === "blocked") {
			block(credentials.reason);
			return;
		}
		credentialReason = "reconnect";
		let init: RequestInit;
		try {
			init = request.init(credentials.headers);
		} catch {
			// A header fetch refuses: fail, never an unhandled rejection
			// that leaves the connection `connecting`. The engine's message may
			// quote the value, so a fixed sentence replaces it.
			invalid(
				new SpinetabError(
					"unsupported-option",
					"The request could not be built from the connection's headers; nothing was sent.",
				),
			);
			return;
		}
		const abort = new AbortController();
		controller = abort;
		// Fetch can remain pending until body bytes arrive (notably in Firefox).
		// Supervise the request from dispatch, after credentials are available.
		lastInbound = ctx.now();
		armLiveness();
		let response: Response;
		try {
			response = await fetch(request.url, {
				...init,
				...(credentials.attached ? NO_REDIRECT : {}),
				signal: abort.signal,
			});
		} catch {
			if (current !== generation) return;
			interrupted("network", false);
			return;
		}
		if (current !== generation) {
			void response.body?.cancel().catch(() => {});
			return;
		}
		const outcome = classifyStatus(response.status, response.headers);
		if (outcome.kind !== "ok") {
			void response.body?.cancel().catch(() => {});
			if (outcome.kind === "unauthorised") {
				// Only the grant that was attached, and only on a 401.
				if (credentials.attached) ctx.rejectCredentials(credentials.attached);
				block("credentials-rejected", response.status);
			} else if (outcome.kind === "forbidden") {
				permanent(response.status, "forbidden");
			} else if (outcome.kind === "redirect") {
				permanent(response.status, "redirect");
			} else if (outcome.kind === "permanent") {
				permanent(response.status, response.status);
			} else if (!config.repeatable) {
				terminal({
					code: "upstream-error",
					message: "The server failed the request; it is not repeatable.",
					detail: { status: response.status },
				});
			} else {
				scheduleReconnect(
					"server-closed",
					outcome.retryAfterMs,
					response.status,
				);
			}
			return;
		}
		const accepted = config.accept(response);
		if (accepted !== "ok") {
			void response.body?.cancel().catch(() => {});
			if (accepted === "complete") {
				cancelCurrent();
				phase = "done";
				setStatus({ state: "inactive", reason: "idle" });
				config.complete();
			} else {
				fatal({ code: accepted.code, message: accepted.message });
			}
			return;
		}
		if (!response.body) {
			fatal({ code: "protocol-error", message: "The response has no body." });
			return;
		}
		let session: HttpStreamSession;
		try {
			session = config.open(response);
		} catch (error) {
			fatal(asFrameError(error));
			return;
		}
		const reader = response.body.getReader();
		phase = "open";
		lastInbound = ctx.now();
		backoff.connected(ctx.now());
		const restart = pendingRestart;
		pendingRestart = undefined;
		// Continuity outcomes precede `connected`, never follow it.
		config.established(restart);
		if (current !== generation) {
			void reader.cancel().catch(() => {});
			return;
		}
		setStatus({ state: "connected" });
		armLiveness();
		for (;;) {
			let result: ReadableStreamReadResult<Uint8Array>;
			try {
				result = await reader.read();
			} catch {
				if (current !== generation) return;
				interrupted("network", true);
				return;
			}
			if (current !== generation) return;
			lastInbound = ctx.now();
			try {
				if (result.done) session.end();
				else session.push(result.value);
			} catch (error) {
				if (current !== generation) return;
				void reader.cancel().catch(() => {});
				fatal(asFrameError(error));
				return;
			}
			if (current !== generation) {
				void reader.cancel().catch(() => {});
				return;
			}
			if (result.done) break;
		}
		clearTimers();
		controller = undefined;
		if (config.endOfBody === "complete" || !config.repeatable) {
			generation += 1;
			phase = "done";
			setStatus({ state: "inactive", reason: "idle" });
			config.complete();
			return;
		}
		interrupted("server-closed", true);
	};

	return {
		backoff,
		start() {
			if (phase === "idle" || (phase === "done" && config.repeatable)) {
				if (!config.repeatable && everStarted) return;
				backoff.reset();
				void attempt();
			}
		},
		stop() {
			if (phase === "disposed") return;
			cancelCurrent();
			backoff.reset();
			pendingRestart = undefined;
			const wasActive = phase !== "idle" && phase !== "done";
			phase = "idle";
			if (wasActive) setStatus({ state: "inactive", reason: "idle" });
		},
		probe() {
			if (!config.repeatable) return;
			if (phase === "waiting") {
				void attempt();
			} else if (phase === "exhausted") {
				backoff.reset();
				void attempt();
			} else if (
				phase === "open" ||
				(phase === "connecting" && controller !== undefined)
			) {
				if (config.expectInboundWithinMs !== undefined) {
					if (livenessTimer !== undefined) clearTimeout(livenessTimer);
					checkLiveness();
					return;
				}
				// Conservative reopen-on-return for repeatable work: a
				// deliberate restart, reported once at the new `connected`.
				if (phase === "open") {
					pendingRestart = "reopened";
					config.lost();
				}
				void attempt();
			}
		},
		retry() {
			if (
				phase === "exhausted" ||
				phase === "failed" ||
				phase === "blocked" ||
				phase === "waiting"
			) {
				if (!config.repeatable) return;
				backoff.reset();
				credentialReason = "retry";
				void attempt();
			}
		},
		rotate() {
			if (phase === "blocked" && config.repeatable) {
				backoff.reset();
				credentialReason = "rotated";
				void attempt();
			}
		},
		dispose() {
			cancelCurrent();
			phase = "disposed";
		},
	};
}

function asFrameError(error: unknown): SerialisedError {
	if (
		isSpinetabError(error, "frame-too-large") ||
		isSpinetabError(error, "malformed-frame")
	) {
		const record: SerialisedError = {
			code: error.code,
			message: error.message,
		};
		if (error.detail !== undefined) record.detail = error.detail;
		return record;
	}
	return {
		code: "malformed-frame",
		message: "The parser rejected the response body.",
	};
}
