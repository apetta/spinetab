import {
	assertAbsoluteUrl,
	assertBoolean,
	assertHeaders,
	assertInteger,
	assertKnownKeys,
	assertOneOf,
	assertPlainObject,
	assertString,
	refuseCredentialCarriers,
	refuseUrlCredentials,
} from "../shared/validate.ts";

/**
 * Connection options for `graphqlSse()`. Mode is the application's choice
 * and defaults to `distinct`, as upstream: `distinct` opens one
 * SSE response per subscription identity (recommended for HTTP/2); `single`
 * reserves one stream per connection identity (PUT, then POST per operation
 * and DELETE per stop) for browsers on HTTP/1. Spinetab never probes,
 * switches or falls back.
 */
export interface GraphqlSseConnection {
	url: string;
	/** Default `"distinct"`; omitting it and passing it give one identity. */
	mode?: "distinct" | "single";
	/** Non-credential, response-affecting headers (identity-bearing). */
	headers?: Record<string, string>;
	/** Fetch cookie mode; default `"same-origin"` (upstream default). */
	credentials?: "omit" | "same-origin" | "include";
	/** Upstream retry budget; default 5. */
	retryAttempts?: number;
	/** Single mode lazy close; default the runtime's `idleCloseMs`. */
	lazyCloseTimeoutMs?: number;
	/**
	 * Declared server heartbeat interval. When set, a stream that delivers no
	 * bytes for 2.5 × this value is failed with graphql-sse's `NetworkError`
	 * so the upstream loop reconnects. Comments count.
	 */
	heartbeatMs?: number;
	/** Declare that the endpoint needs no credentials. */
	anonymous?: boolean;
}

const KEYS = [
	"url",
	"mode",
	"headers",
	"credentials",
	"retryAttempts",
	"lazyCloseTimeoutMs",
	"heartbeatMs",
	"anonymous",
] as const;

export function validateGraphqlSseConnection(
	spec: unknown,
	options: { absolute: boolean },
	path = "connection",
): asserts spec is GraphqlSseConnection {
	assertPlainObject(spec, path);
	assertKnownKeys(spec, KEYS, path);
	assertString(spec.url, `${path}.url`, { nonEmpty: true });
	if (options.absolute) {
		assertAbsoluteUrl(spec.url, `${path}.url`, ["http:", "https:"]);
	}
	assertOneOf(spec.mode, ["distinct", "single"], `${path}.mode`, {
		optional: true,
	});
	refuseUrlCredentials(spec.url, `${path}.url`);
	assertHeaders(spec.headers, `${path}.headers`);
	refuseCredentialCarriers(spec.headers, `${path}.headers`);
	assertOneOf(
		spec.credentials,
		["omit", "same-origin", "include"],
		`${path}.credentials`,
		{ optional: true },
	);
	assertInteger(spec.retryAttempts, `${path}.retryAttempts`, {
		min: 0,
		max: 50,
	});
	assertInteger(spec.lazyCloseTimeoutMs, `${path}.lazyCloseTimeoutMs`, {
		min: 0,
		max: 60_000,
	});
	assertInteger(spec.heartbeatMs, `${path}.heartbeatMs`, {
		min: 50,
		max: 300_000,
	});
	assertBoolean(spec.anonymous, `${path}.anonymous`);
}
