import type {
	AdapterConnection,
	AdapterSubscription,
	ConnectionContext,
	RuntimeAdapter,
	SubscriptionSink,
} from "../../core/adapter.ts";
import { jitteredBackoff } from "../../core/clock.ts";
import { isSpinetabError, SpinetabError } from "../../core/errors.ts";
import { stableStringify } from "../../core/identity.ts";
import type { ConnectionStatus, Json } from "../../core/types.ts";
import {
	assertKnownKeys,
	assertObject,
	assertOneOf,
	assertPositiveInteger,
	isPlainObject,
	unsupported,
} from "../../core/validate.ts";
import {
	type BlockedReason,
	classifyStatus,
	credentialHeaders,
	httpCode,
	NO_REDIRECT,
} from "../shared/http.ts";
import { normalisePollingRead, type PollingConnection } from "./spec.ts";

export type { PollingConnection };

/**
 * Per-consumer options; they never split identity.
 * Identical to the `spinetab/polling` type of the same name (a unit test
 * keeps them equal); declared here so the page entry is never imported.
 */
export interface PollingConsumerOptions {
	/** Minimum 1 000 ms; default 5 000 ms when omitted. */
	intervalMs?: number;
	eligible?: boolean;
	whileHidden?: boolean;
	onJoin?: "read" | "await";
}

/** Consumer options after `parseConsumer`: the interval is always resolved. */
type ParsedConsumer = PollingConsumerOptions & { intervalMs: number };

/** Decode a whole response body (already size-checked) into a cloneable value. */
export type PollingDecoder = (
	body: Uint8Array,
	info: { status: number; contentType: string | null },
) => unknown;

export interface PollingAdapterOptions {
	/** Additional decoders by name; `json` and `text` are built in. */
	decoders?: Record<string, PollingDecoder>;
	/** Custom fetch (instrumentation or tests); default `globalThis.fetch`. */
	fetch?: typeof fetch;
}

const KIND = "polling";
/** Default limits. */
export const MIN_INTERVAL_MS = 1_000;
/** Interval for a consumer that names none; per consumer, outside identity. */
export const DEFAULT_INTERVAL_MS = 5_000;
const MAX_INTERVAL_MS = 86_400_000;
const JOIN_SPACING_CAP_MS = 1_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 30_000;
const MAX_ATTEMPTS = 10;
const MAX_SERIES_MS = 300_000;
const RETRY_AFTER_CAP_MS = 300_000;

let textDecoder: TextDecoder | undefined;
const utf8 = (body: Uint8Array) => {
	textDecoder ??= new TextDecoder();
	return textDecoder.decode(body);
};

const builtInDecoders: Record<string, PollingDecoder> = {
	json: (body) => JSON.parse(utf8(body)),
	text: (body) => utf8(body),
};

/**
 * Shared polling: one fixed-delay schedule per
 * identity at the shortest eligible interval, at most one read in flight,
 * results delivered to consumers eligible at completion, no result cache,
 * pause with nobody eligible, one catch-up read on return and coalesced
 * reads for late joiners. Provider headers are resolved for each read within
 * the permitted credential origins.
 */
export function pollingAdapter(
	options: PollingAdapterOptions = {},
): RuntimeAdapter<
	PollingConnection,
	Record<string, never>,
	unknown,
	never,
	never,
	Json
> {
	const raw: unknown = options;
	if (!isPlainObject(raw)) {
		throw unsupported(
			"pollingAdapter(options)",
			"must be a plain object.",
			KIND,
		);
	}
	assertKnownKeys(raw, ["decoders", "fetch"], "pollingAdapter(options)", KIND);
	if (options.fetch !== undefined && typeof options.fetch !== "function") {
		throw unsupported("fetch", "must be a function.", KIND);
	}
	const decoders: Record<string, PollingDecoder> = { ...builtInDecoders };
	if (options.decoders !== undefined) {
		const custom: unknown = options.decoders;
		assertObject(custom, "decoders", KIND);
		for (const [name, decoder] of Object.entries(options.decoders)) {
			if (typeof decoder !== "function") {
				throw unsupported(`decoders.${name}`, "must be a function.", KIND);
			}
			decoders[name] = decoder;
		}
	}
	const normalise = (spec: unknown) => {
		const read = normalisePollingRead(spec, "connection", KIND);
		if (!Object.hasOwn(decoders, read.decoder)) {
			throw unsupported(
				"connection.decoder",
				`${JSON.stringify(read.decoder)} is not registered in this runtime.`,
				KIND,
			);
		}
		return read;
	};
	return {
		kind: KIND,
		version: 1,
		validateConnection(spec: unknown): asserts spec is PollingConnection {
			normalise(spec);
		},
		validateSubscription(spec: unknown): asserts spec is Record<string, never> {
			if (
				spec !== undefined &&
				!(isPlainObject(spec) && Object.keys(spec).length === 0)
			) {
				throw unsupported(
					"subscription",
					"must be an empty object; the polled request is the connection.",
					KIND,
				);
			}
		},
		validateConsumer(value: unknown): asserts value is Json {
			parseConsumer(value);
		},
		connectionKey: (spec) => stableStringify(normalise(spec)),
		subscriptionKey: () => "poll",
		connect: (spec, ctx) =>
			createSchedule(
				normalise(spec),
				ctx,
				decoders,
				options.fetch ?? ((...args) => globalThis.fetch(...args)),
			),
	};
}

/**
 * Per-consumer options. No options, or options without `intervalMs`, poll
 * every `DEFAULT_INTERVAL_MS`; visibility still pauses hidden pages.
 */
function parseConsumer(value: unknown): ParsedConsumer {
	if (value === undefined) return { intervalMs: DEFAULT_INTERVAL_MS };
	if (!isPlainObject(value)) {
		throw unsupported("consumer", "must be a plain object.", KIND);
	}
	assertKnownKeys(
		value,
		["intervalMs", "eligible", "whileHidden", "onJoin"],
		"consumer",
		KIND,
	);
	const intervalMs =
		value.intervalMs === undefined ? DEFAULT_INTERVAL_MS : value.intervalMs;
	assertPositiveInteger(intervalMs, "consumer.intervalMs", {
		min: MIN_INTERVAL_MS,
		max: MAX_INTERVAL_MS,
		adapter: KIND,
	});
	for (const key of ["eligible", "whileHidden"] as const) {
		if (value[key] !== undefined && typeof value[key] !== "boolean") {
			throw unsupported(`consumer.${key}`, "must be a boolean.", KIND);
		}
	}
	if (value.onJoin !== undefined) {
		assertOneOf(value.onJoin, ["read", "await"], "consumer.onJoin", KIND);
	}
	return { ...value, intervalMs } as ParsedConsumer;
}

interface ConsumerState {
	options: ParsedConsumer;
	visible: boolean;
}

interface InFlight {
	controller: AbortController;
	wallStart: number;
}

type ScheduleState = "running" | "blocked" | "failed" | "exhausted";

class Transient extends Error {
	constructor(
		readonly reason: NonNullable<ConnectionStatus["reason"]>,
		readonly code: string | number,
		readonly retryAfterMs?: number,
	) {
		super(String(code));
	}
}

function createSchedule(
	spec: PollingConnection,
	ctx: ConnectionContext,
	decoders: Record<string, PollingDecoder>,
	fetchImpl: typeof fetch,
): AdapterConnection<Record<string, never>, unknown, never, never, Json> {
	const consumers = new Map<string, ConsumerState>();
	const decode = decoders[spec.decoder] as PollingDecoder;
	let sink: SubscriptionSink<unknown> | undefined;
	let active = false;
	let state: ScheduleState = "running";
	let timer: ReturnType<typeof setTimeout> | undefined;
	let inFlight: InFlight | undefined;
	let lastStart: number | undefined;
	let lastCompletion: number | undefined;
	let lastSuccessAt: number | undefined;
	let joinDue: number | undefined;
	let backoffUntil: number | undefined;
	let attempt = 0;
	let seriesStart: number | undefined;
	let nextReason: "connect" | "reconnect" | "retry" | "rotated" = "connect";
	const headersFor = credentialHeaders(ctx, spec.authHeaders);

	const eligible = (consumer: ConsumerState) =>
		consumer.options.eligible !== false &&
		(consumer.options.whileHidden === true || consumer.visible);
	const eligibleIds = () =>
		[...consumers]
			.filter(([, consumer]) => eligible(consumer))
			.map(([id]) => id);
	const interval = () => {
		let shortest: number | undefined;
		for (const consumer of consumers.values()) {
			if (!eligible(consumer)) continue;
			const value = consumer.options.intervalMs;
			if (shortest === undefined || value < shortest) shortest = value;
		}
		return shortest;
	};

	const clearTimer = () => {
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
	};

	function abortRead(reason: string): void {
		if (!inFlight) return;
		const controller = inFlight.controller;
		inFlight = undefined;
		controller.abort(new DOMException(reason, "AbortError"));
	}

	/** Recompute the single schedule for this identity. */
	function schedule(): void {
		clearTimer();
		if (!active || state !== "running") return;
		const every = interval();
		if (every === undefined) {
			// Nobody eligible: pause and abort unneeded work.
			abortRead("paused");
			joinDue = undefined;
			return;
		}
		if (inFlight) return;
		const now = ctx.now();
		let due = lastCompletion === undefined ? now : lastCompletion + every;
		if (joinDue !== undefined && joinDue < due) due = joinDue;
		if (backoffUntil !== undefined && backoffUntil > due) due = backoffUntil;
		timer = setTimeout(read, Math.max(0, due - now));
	}

	async function read(): Promise<void> {
		timer = undefined;
		joinDue = undefined;
		const every = interval();
		if (!active || state !== "running" || every === undefined || inFlight)
			return;
		const controller = new AbortController();
		const current: InFlight = { controller, wallStart: Date.now() };
		inFlight = current;
		const startedAt = ctx.now();
		const skipped =
			lastCompletion === undefined
				? 0
				: Math.max(0, Math.floor((startedAt - lastCompletion) / every) - 1);
		lastStart = startedAt;
		const onDispose = () =>
			controller.abort(new DOMException("disposed", "AbortError"));
		ctx.signal.addEventListener("abort", onDispose, { once: true });
		const timeout = setTimeout(
			() =>
				controller.abort(new DOMException("read timed out", "TimeoutError")),
			spec.timeoutMs,
		);
		const reason = nextReason;
		nextReason = "reconnect";
		try {
			const credentials = await headersFor(reason, spec.url);
			if (inFlight !== current) return;
			if (credentials.kind === "aborted") return;
			// A failed credential wait is definitive, even when the read timed
			// out meanwhile: blocked, so the failing provider is not asked again
			// on every backoff attempt.
			if (credentials.kind === "blocked") {
				block(credentials.reason);
				return;
			}
			// The read timed out while credentials were awaited: transient, as
			// below; only an AbortError stays silent.
			if (controller.signal.aborted) throw controller.signal.reason;
			const response = await fetchImpl(spec.url, {
				method: spec.method,
				headers: { ...spec.headers, ...lowerCase(credentials.headers) },
				...(spec.body === undefined
					? {}
					: {
							body:
								typeof spec.body === "string"
									? spec.body
									: JSON.stringify(spec.body),
						}),
				...(spec.credentials ? { credentials: spec.credentials } : {}),
				...(credentials.attached ? NO_REDIRECT : {}),
				signal: controller.signal,
			});
			if (controller.signal.aborted) throw controller.signal.reason;
			const outcome = classifyStatus(response.status);
			if (outcome.kind === "unauthorised") {
				// Never spin on rejected credentials; only
				// the grant that was attached is rejected, and only on a 401.
				void response.body?.cancel().catch(() => {});
				if (credentials.attached) ctx.rejectCredentials(credentials.attached);
				block("credentials-rejected", response.status);
				return;
			}
			if (outcome.kind === "forbidden" || outcome.kind === "redirect") {
				// 403 rejects nothing; a redirect is never followed.
				void response.body?.cancel().catch(() => {});
				fail("permanent-error", outcome.kind);
				return;
			}
			if (
				response.status === 408 ||
				response.status === 429 ||
				response.status >= 500
			) {
				void response.body?.cancel().catch(() => {});
				throw new Transient(
					"server-closed",
					response.status,
					retryAfter(response.headers.get("retry-after")),
				);
			}
			if (!response.ok) {
				void response.body?.cancel().catch(() => {});
				fail("permanent-error", response.status);
				return;
			}
			const body = await readLimited(
				response,
				ctx.limits.maxMessageBytes,
				controller.signal,
			);
			if (inFlight !== current) return;
			if (controller.signal.aborted) throw controller.signal.reason;
			if (
				response.status === 204 ||
				(body.byteLength === 0 && decode === builtInDecoders.json)
			) {
				// No new result: the read succeeded, and nothing is decoded or
				// delivered. A 204 for every decoder; an empty 2xx body only for
				// the built-in JSON decoder, which cannot decode it. The `text`
				// and custom decoders receive an empty body.
				succeed(skipped);
				return;
			}
			let value: unknown;
			try {
				value = decode(body, {
					status: response.status,
					contentType: response.headers.get("content-type"),
				});
			} catch {
				throw new Transient("protocol-error", "decode-error");
			}
			succeed(skipped, { value });
		} catch (error) {
			if (inFlight !== current) return;
			if (
				controller.signal.aborted &&
				controller.signal.reason?.name === "AbortError"
			)
				return;
			if (isSpinetabError(error, "frame-too-large")) {
				// Never truncated or delivered; no automatic retry.
				sink?.continuity("message-too-large");
				fail("protocol-error", "frame-too-large");
				return;
			}
			if (error instanceof Transient) {
				transient(error.reason, error.code, error.retryAfterMs);
			} else if (controller.signal.reason?.name === "TimeoutError") {
				transient("network", "timeout");
			} else {
				transient("network", "network-error");
			}
		} finally {
			clearTimeout(timeout);
			ctx.signal.removeEventListener("abort", onDispose);
			if (inFlight === current) {
				inFlight = undefined;
				lastCompletion = ctx.now();
			}
			schedule();
		}
	}

	/** A successful read; `result` is absent for a read without content. */
	function succeed(skipped: number, result?: { value: unknown }): void {
		attempt = 0;
		seriesStart = undefined;
		backoffUntil = undefined;
		lastSuccessAt = Date.now();
		const targets = eligibleIds();
		// Results go only to consumers eligible at completion; nothing is kept.
		if (result && targets.length > 0) {
			sink?.next(result.value, { consumers: targets });
		}
		ctx.setStatus({
			state: "connected",
			...(skipped > 0 ? { skippedIntervals: skipped } : {}),
		});
	}

	function transient(
		reason: NonNullable<ConnectionStatus["reason"]>,
		code: string | number,
		retryAfterMs?: number,
	): void {
		attempt += 1;
		const now = ctx.now();
		seriesStart ??= now;
		const stale = lastSuccessAt === undefined ? {} : { lastSuccessAt };
		if (attempt > MAX_ATTEMPTS || now - seriesStart > MAX_SERIES_MS) {
			state = "exhausted";
			clearTimer();
			ctx.setStatus({
				state: "retry-exhausted",
				reason: attempt > MAX_ATTEMPTS ? "attempts-exhausted" : "time-limit",
				code,
				attempt: attempt - 1,
				...stale,
			});
			return;
		}
		let delay = jitteredBackoff(attempt, BACKOFF_BASE_MS, BACKOFF_CAP_MS);
		if (retryAfterMs !== undefined) {
			delay = Math.max(delay, Math.min(retryAfterMs, RETRY_AFTER_CAP_MS));
		}
		backoffUntil = now + delay;
		ctx.setStatus({
			state: "reconnecting",
			reason,
			code,
			attempt,
			retryAt: Date.now() + delay,
			...stale,
		});
	}

	/**
	 * Blocked on credentials; only a rotation or an explicit retry reads
	 * again. `credentials-audience` is permanent: rotation never restarts it.
	 */
	function block(reason: BlockedReason, status?: number): void {
		state = reason === "credentials-audience" ? "failed" : "blocked";
		clearTimer();
		ctx.setStatus({
			state: "auth-blocked",
			reason,
			...(status === undefined ? {} : { code: httpCode(status) }),
			...(lastSuccessAt === undefined ? {} : { lastSuccessAt }),
		});
	}

	function fail(
		reason: "permanent-error" | "protocol-error",
		code: string | number,
	): void {
		state = "failed";
		clearTimer();
		ctx.setStatus({
			state: "failed",
			reason,
			code,
			...(lastSuccessAt === undefined ? {} : { lastSuccessAt }),
		});
	}

	function restart(reason: "retry" | "rotated"): void {
		state = "running";
		attempt = 0;
		seriesStart = undefined;
		backoffUntil = undefined;
		nextReason = reason;
		joinDue = ctx.now();
		ctx.setStatus({ state: "connecting" });
		schedule();
	}

	const subscription: AdapterSubscription<Json> = {
		unsubscribe() {
			active = false;
			clearTimer();
			abortRead("unsubscribed");
		},
		consumerAdded(id, options, context) {
			const consumer: ConsumerState = {
				options: parseConsumer(options),
				visible: context.visible,
			};
			consumers.set(id, consumer);
			if (
				eligible(consumer) &&
				consumer.options.onJoin !== "await" &&
				!inFlight
			) {
				// Late joiner: one coalesced fresh read, spaced from the last start; a read in flight already serves the joiner.
				const every = interval() ?? consumer.options.intervalMs;
				const spacing = Math.min(every, JOIN_SPACING_CAP_MS);
				const earliest =
					lastStart === undefined ? ctx.now() : lastStart + spacing;
				joinDue = Math.max(ctx.now(), earliest);
			}
			schedule();
		},
		consumerUpdated(id, options) {
			const consumer = consumers.get(id);
			if (!consumer) return;
			consumer.options = parseConsumer(options);
			// Interval changes apply after an in-flight read; never abort it.
			schedule();
		},
		consumerRemoved(id) {
			consumers.delete(id);
			schedule();
		},
		consumerVisibility(id, visible) {
			const consumer = consumers.get(id);
			if (!consumer) return;
			consumer.visible = visible;
			schedule();
		},
	};

	return {
		subscribe(_spec, nextSink) {
			sink = nextSink;
			active = true;
			return subscription;
		},
		probe() {
			// Coordinated return check: a read that outlived its timeout by wall
			// clock started before a suspension; abort it so the single catch-up
			// read can start. Otherwise recompute the schedule.
			if (inFlight && Date.now() - inFlight.wallStart > spec.timeoutMs) {
				abortRead("stale after suspension");
			}
			schedule();
		},
		retry() {
			if (state !== "running") restart("retry");
		},
		rotate() {
			if (state === "blocked") restart("rotated");
		},
		dispose() {
			active = false;
			clearTimer();
			abortRead("disposed");
			consumers.clear();
		},
	};
}

/** Provider header names lower-cased, so they replace static ones (identity headers are lower-case). */
function lowerCase(
	headers: Record<string, string> | undefined,
): Record<string, string> {
	const lower: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers ?? {})) {
		lower[name.toLowerCase()] = value;
	}
	return lower;
}

function retryAfter(value: string | null): number | undefined {
	if (!value) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
	const date = Date.parse(value);
	return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

async function readLimited(
	response: Response,
	limit: number,
	signal: AbortSignal,
): Promise<Uint8Array> {
	const tooLarge = () =>
		new SpinetabError(
			"frame-too-large",
			`The polled body exceeds ${limit} bytes.`,
			{
				detail: { limit },
			},
		);
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > limit) {
		await response.body?.cancel().catch(() => {});
		throw tooLarge();
	}
	if (!response.body) return new Uint8Array(await response.arrayBuffer());
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		if (signal.aborted) {
			await reader.cancel().catch(() => {});
			throw signal.reason;
		}
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > limit) {
			await reader.cancel().catch(() => {});
			throw tooLarge();
		}
		chunks.push(value);
	}
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return body;
}
