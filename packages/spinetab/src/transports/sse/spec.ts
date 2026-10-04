import { refuseCredentialCarriers } from "../../core/validate.ts";
import {
	assertEndpoint,
	assertKeys,
	assertRecord,
	HTTP_PROTOCOLS,
	optionalBoolean,
	optionalHeaders,
	optionalOneOf,
	optionalPositiveInteger,
	optionalString,
	optionError,
	type PlainRecord,
} from "../shared/options.ts";

/**
 * Identity-bearing SSE connection options. Every field
 * is part of the stream identity; credentials never are.
 */
export interface SseConnectionSpec {
	url: string;
	/**
	 * Default "fetch": typed failures, request headers and the cursor
	 * on every reconnect. The builder writes the default into the connection.
	 */
	mode?: "eventsource" | "fetch";
	/** EventSource mode only: send cookies cross-origin. */
	withCredentials?: boolean;
	/** Fetch mode only; default GET. */
	method?: "GET" | "POST";
	/** Fetch mode POST only. */
	body?: string;
	/** Fetch mode only; non-credential request headers. */
	headers?: Record<string, string>;
	/** Fetch mode only: the fetch credentials mode (cookies), default "same-origin". */
	credentials?: "omit" | "same-origin" | "include";
	/**
	 * Fetch mode only: merge `credentials.headers` from the scope's credential
	 * provider into every request. Without a credential source the stream
	 * is `auth-blocked` and no request is sent.
	 */
	authHeaders?: boolean;
	/**
	 * How a cursor is conveyed when the adapter opens a new request: the
	 * `Last-Event-ID` header (fetch; in EventSource mode only the browser's own
	 * reconnection sends it), a query parameter, a named worker `resumeUrls`
	 * hook, or never. Default "header".
	 */
	resume?: false | "header" | { query: string } | { url: string };
	/** Server replay capability; `resumed` is reported only when declared. Default "none". */
	replay?: "none" | "last-event-id";
	/**
	 * Worker decoder name: "json" (the default), "text" for the raw
	 * string, or one registered in `sseAdapter({ decoders })`. Part of
	 * identity; omitting it equals "json".
	 */
	decoder?: string;
	/** Allow-list of event names subscriptions may select. */
	events?: string[];
	/**
	 * Event name the server sends when it cannot replay from the conveyed
	 * cursor (standard SSE has no such signal). Its arrival forces continuity
	 * `gap`; it is never delivered.
	 */
	resetEvent?: string;
	/**
	 * Declared liveness: a heartbeat event name and/or an inbound expectation.
	 * In EventSource mode the expectation also bounds pending connection attempts.
	 */
	heartbeat?: { event?: string; expectInboundWithinMs?: number };
	/** Fetch mode: POST streams restart only when explicitly repeatable (default false for POST, true for GET). */
	repeatable?: boolean;
}

export interface SseSubscriptionSpec {
	/** Event type to receive; default "message". */
	event?: string;
}

/** The mode an SSE connection uses when it names none. */
const DEFAULT_SSE_MODE = "fetch";
/** The decoder an SSE connection uses when it names none. */
export const DEFAULT_SSE_DECODER = "json";

const CONNECTION_KEYS = [
	"url",
	"mode",
	"withCredentials",
	"method",
	"body",
	"headers",
	"credentials",
	"authHeaders",
	"resume",
	"replay",
	"decoder",
	"events",
	"resetEvent",
	"heartbeat",
	"repeatable",
] as const;
const FETCH_ONLY = [
	"method",
	"body",
	"headers",
	"credentials",
	"authHeaders",
] as const;
/** EventSource dispatches its own `open` and `error` events under these names. */
const RESERVED_EVENTSOURCE_NAMES = ["open", "error"];

export function validateSseConnection(
	spec: unknown,
	options: { requireAbsolute: boolean },
	path = "connection",
): asserts spec is SseConnectionSpec {
	assertRecord(spec, path);
	assertKeys(spec, CONNECTION_KEYS, path);
	assertEndpoint(spec, "url", path, HTTP_PROTOCOLS, options);
	const mode =
		optionalOneOf(spec, "mode", ["eventsource", "fetch"], path) ??
		DEFAULT_SSE_MODE;
	const withCredentials = optionalBoolean(spec, "withCredentials", path);
	const method = optionalOneOf(spec, "method", ["GET", "POST"], path);
	const body = optionalString(spec, "body", path);
	optionalHeaders(spec, "headers", path);
	optionalOneOf(spec, "credentials", ["omit", "same-origin", "include"], path);
	optionalBoolean(spec, "authHeaders", path);
	const repeatable = optionalBoolean(spec, "repeatable", path);
	if (mode === "eventsource") {
		for (const key of FETCH_ONLY) {
			if (spec[key] !== undefined) {
				throw optionError(
					`${path}.${key}`,
					'is not supported in eventsource mode; EventSource sends GET without custom headers. Use mode: "fetch".',
				);
			}
		}
		if (repeatable === false) {
			throw optionError(
				`${path}.repeatable`,
				'EventSource always reconnects; use mode: "fetch" for a non-repeatable stream.',
			);
		}
	} else {
		if (withCredentials !== undefined) {
			throw optionError(
				`${path}.withCredentials`,
				'is EventSource-only; use credentials: "include" in fetch mode.',
			);
		}
		if (body !== undefined && method !== "POST") {
			throw optionError(`${path}.body`, 'requires method: "POST".');
		}
	}
	const resume = validateResume(spec, path);
	const replay = optionalOneOf(spec, "replay", ["none", "last-event-id"], path);
	if (replay === "last-event-id" && resume === false) {
		throw optionError(
			`${path}.replay`,
			"declares replay but resume: false never conveys a cursor.",
		);
	}
	optionalString(spec, "decoder", path);
	const events = validateEventNames(spec, mode, path);
	validateResetEvent(spec, mode, events, path);
	validateHeartbeat(spec, mode, path);
	if (events && spec.heartbeat) {
		const heartbeatEvent = (spec.heartbeat as PlainRecord).event;
		if (typeof heartbeatEvent === "string" && events.includes(heartbeatEvent)) {
			throw optionError(
				`${path}.heartbeat.event`,
				"heartbeat events are never delivered; remove it from events.",
			);
		}
	}
}

function validateResume(
	spec: PlainRecord,
	path: string,
): SseConnectionSpec["resume"] {
	const resume = spec.resume;
	if (resume === undefined || resume === false || resume === "header") {
		return resume as SseConnectionSpec["resume"];
	}
	const resumePath = `${path}.resume`;
	if (typeof resume !== "object" || resume === null || Array.isArray(resume)) {
		throw optionError(
			resumePath,
			'must be false, "header", { query } or { url }.',
		);
	}
	assertRecord(resume, resumePath);
	const keys = Object.keys(resume);
	if (keys.length !== 1 || (keys[0] !== "query" && keys[0] !== "url")) {
		throw optionError(resumePath, "must have exactly one of query or url.");
	}
	const value = resume[keys[0] as string];
	if (typeof value !== "string" || value === "") {
		throw optionError(
			`${resumePath}.${keys[0]}`,
			"must be a non-empty string.",
		);
	}
	// A cursor parameter named like a token is refused as one.
	if (keys[0] === "query")
		refuseCredentialCarriers(value, `${resumePath}.query`);
	return resume as SseConnectionSpec["resume"];
}

function validateEventNames(
	spec: PlainRecord,
	mode: SseConnectionSpec["mode"],
	path: string,
): string[] | undefined {
	const events = spec.events;
	if (events === undefined) return undefined;
	if (!Array.isArray(events) || events.length === 0) {
		throw optionError(`${path}.events`, "must be a non-empty array of names.");
	}
	events.forEach((name, index) => {
		assertEventName(name, mode, `${path}.events[${index}]`);
	});
	return events as string[];
}

function validateResetEvent(
	spec: PlainRecord,
	mode: SseConnectionSpec["mode"],
	events: string[] | undefined,
	path: string,
): void {
	const name = spec.resetEvent;
	if (name === undefined) return;
	const resetPath = `${path}.resetEvent`;
	assertEventName(name, mode, resetPath);
	if (mode === "eventsource" && name === "message") {
		throw optionError(
			resetPath,
			'"message" is EventSource\'s default event; give the reset event its own name on the server.',
		);
	}
	if (events?.includes(name)) {
		throw optionError(
			resetPath,
			"reset events are never delivered; remove it from events.",
		);
	}
	// Reset is dispatched before heartbeat, so every heartbeat would force a gap.
	if ((spec.heartbeat as { event?: unknown } | undefined)?.event === name) {
		throw optionError(
			resetPath,
			"must differ from heartbeat.event; every heartbeat would report a gap.",
		);
	}
}

function validateHeartbeat(
	spec: PlainRecord,
	mode: SseConnectionSpec["mode"],
	path: string,
): void {
	if (spec.heartbeat === undefined) return;
	const heartbeatPath = `${path}.heartbeat`;
	assertRecord(spec.heartbeat, heartbeatPath);
	assertKeys(spec.heartbeat, ["event", "expectInboundWithinMs"], heartbeatPath);
	const event = spec.heartbeat.event;
	if (event !== undefined)
		assertEventName(event, mode, `${heartbeatPath}.event`);
	const within = optionalPositiveInteger(
		spec.heartbeat,
		"expectInboundWithinMs",
		heartbeatPath,
		{ min: 100, max: 3_600_000 },
	);
	if (event === undefined && within === undefined) {
		throw optionError(
			heartbeatPath,
			"needs an event name or expectInboundWithinMs; EventSource never exposes comments.",
		);
	}
}

function assertEventName(
	name: unknown,
	mode: SseConnectionSpec["mode"],
	path: string,
): asserts name is string {
	if (typeof name !== "string" || name === "") {
		throw optionError(path, "must be a non-empty event name.");
	}
	if (mode === "eventsource" && RESERVED_EVENTSOURCE_NAMES.includes(name)) {
		throw optionError(
			path,
			`"${name}" collides with EventSource's own ${name} event; use fetch mode or rename it on the server.`,
		);
	}
}

export function validateSseSubscription(
	spec: unknown,
	path = "subscription",
): asserts spec is SseSubscriptionSpec {
	assertRecord(spec, path);
	assertKeys(spec, ["event"], path);
	const event = optionalString(spec, "event", path);
	if (event === "") throw optionError(`${path}.event`, "must not be empty.");
}

/** Validate a subscription against its connection (event allow-list and mode). */
export function checkSubscriptionAgainst(
	connection: SseConnectionSpec,
	subscription: SseSubscriptionSpec,
	path = "subscription",
): string {
	const event = subscription.event ?? "message";
	assertEventName(event, connection.mode, `${path}.event`);
	if (connection.events && !connection.events.includes(event)) {
		throw optionError(`${path}.event`, "is not in the connection's events.");
	}
	if (connection.heartbeat?.event === event) {
		throw optionError(
			`${path}.event`,
			"is the declared heartbeat event, which is never delivered.",
		);
	}
	if (connection.resetEvent === event) {
		throw optionError(
			`${path}.event`,
			"is the declared reset event, which is never delivered.",
		);
	}
	return event;
}

/**
 * The canonical connection: an omitted mode or decoder is written out, so
 * omitting either and passing its default share one identity (NT:39).
 */
export function canonicalSseConnection(
	spec: SseConnectionSpec,
): SseConnectionSpec {
	return spec.mode === undefined || spec.decoder === undefined
		? {
				...spec,
				mode: spec.mode ?? DEFAULT_SSE_MODE,
				decoder: spec.decoder ?? DEFAULT_SSE_DECODER,
			}
		: spec;
}

/** EventSource GET streams always restart; fetch POST only when declared. */
export function isSseRepeatable(spec: SseConnectionSpec): boolean {
	if (spec.mode === "eventsource") return true;
	if ((spec.method ?? "GET") === "POST") return spec.repeatable === true;
	return spec.repeatable !== false;
}
