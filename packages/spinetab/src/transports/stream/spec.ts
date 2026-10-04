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
} from "../shared/options.ts";

/** Identity-bearing fetch stream options. */
export interface StreamConnectionSpec {
	url: string;
	/** Default GET. */
	method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
	headers?: Record<string, string>;
	body?: string;
	/** Fetch credentials mode (cookies); default "same-origin". */
	credentials?: "omit" | "same-origin" | "include";
	/** Merge `credentials.headers` from the scope's credential provider. */
	authHeaders?: boolean;
	/**
	 * Worker parser name: the built-in "ndjson" (default) or "lines",
	 * or one registered in `streamAdapter({ parsers })`.
	 */
	parser?: string;
	/**
	 * Default false for every method: only an explicitly
	 * repeatable read is shared by identity and restarted after interruption.
	 */
	repeatable?: boolean;
	/** Malformed frame policy; default "error" (fail the response). */
	malformed?: "error" | "skip";
	heartbeat?: { expectInboundWithinMs: number };
}

export type StreamSubscriptionSpec = Record<string, never>;

const CONNECTION_KEYS = [
	"url",
	"method",
	"headers",
	"body",
	"credentials",
	"authHeaders",
	"parser",
	"repeatable",
	"malformed",
	"heartbeat",
] as const;

export function validateStreamConnection(
	spec: unknown,
	options: { requireAbsolute: boolean },
	path = "connection",
): asserts spec is StreamConnectionSpec {
	assertRecord(spec, path);
	assertKeys(spec, CONNECTION_KEYS, path);
	assertEndpoint(spec, "url", path, HTTP_PROTOCOLS, options);
	const method = optionalOneOf(
		spec,
		"method",
		["GET", "POST", "PUT", "PATCH", "DELETE"],
		path,
	);
	optionalHeaders(spec, "headers", path);
	const body = optionalString(spec, "body", path);
	if (body !== undefined && (method ?? "GET") === "GET") {
		throw optionError(`${path}.body`, "is not allowed with GET.");
	}
	optionalOneOf(spec, "credentials", ["omit", "same-origin", "include"], path);
	optionalBoolean(spec, "authHeaders", path);
	if (optionalString(spec, "parser", path) === "") {
		throw optionError(`${path}.parser`, "must not be empty.");
	}
	optionalBoolean(spec, "repeatable", path);
	optionalOneOf(spec, "malformed", ["error", "skip"], path);
	if (spec.heartbeat !== undefined) {
		const heartbeatPath = `${path}.heartbeat`;
		assertRecord(spec.heartbeat, heartbeatPath);
		assertKeys(spec.heartbeat, ["expectInboundWithinMs"], heartbeatPath);
		const within = optionalPositiveInteger(
			spec.heartbeat,
			"expectInboundWithinMs",
			heartbeatPath,
			{ min: 100, max: 3_600_000 },
		);
		if (within === undefined) {
			throw optionError(
				`${heartbeatPath}.expectInboundWithinMs`,
				"is required.",
			);
		}
	}
}

/** The parser a stream uses when it names none. */
export const DEFAULT_STREAM_PARSER = "ndjson";

/**
 * The canonical connection: an omitted parser is written out, so omitting it
 * and passing `parser: "ndjson"` share one identity (NT:39).
 */
export function canonicalStreamConnection(
	spec: StreamConnectionSpec,
): StreamConnectionSpec {
	return spec.parser === undefined
		? { ...spec, parser: DEFAULT_STREAM_PARSER }
		: spec;
}

export function validateStreamSubscription(
	spec: unknown,
	path = "subscription",
): asserts spec is StreamSubscriptionSpec {
	assertRecord(spec, path);
	assertKeys(spec, [], path);
}
