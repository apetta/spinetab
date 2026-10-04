import { SpinetabError } from "../../core/errors.ts";
import { refuseCredentialCarriers } from "../../core/validate.ts";

/**
 * Option validation shared by the transport page builders and runtime
 * adapters. Every failure is `unsupported-option` with the offending path in
 * `detail.path`; messages never echo option values, which may be secrets.
 */
export function optionError(path: string, message: string): SpinetabError {
	return new SpinetabError("unsupported-option", `${path}: ${message}`, {
		detail: { path },
	});
}

export type PlainRecord = Record<string, unknown>;

export function assertRecord(
	value: unknown,
	path: string,
): asserts value is PlainRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw optionError(path, "must be a plain object.");
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw optionError(path, "must be a plain object.");
	}
}

/**
 * The URL-first builder form: `builder(url, options)` is
 * `builder({...options, url })`. A `url` repeated in `options` is rejected
 * rather than one of the two being ignored; `url: undefined` (from a shared
 * partial spec) never replaces the first argument.
 */
export function withUrl(
	url: string,
	options: unknown,
	path: string,
): PlainRecord {
	if (options === undefined) return { url };
	assertRecord(options, path);
	if (options.url !== undefined) {
		throw optionError(
			`${path}.url`,
			"is the first argument; remove it from the options.",
		);
	}
	return { ...options, url };
}

/** Reject own keys outside `allowed`; unknown options are never ignored. */
export function assertKeys(
	value: PlainRecord,
	allowed: readonly string[],
	path: string,
): void {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) {
			throw optionError(`${path}.${key}`, "is not a supported option.");
		}
	}
}

export function optionalString(
	value: PlainRecord,
	key: string,
	path: string,
): string | undefined {
	const item = value[key];
	if (item === undefined) return undefined;
	if (typeof item !== "string") {
		throw optionError(`${path}.${key}`, "must be a string.");
	}
	return item;
}

export function requiredString(
	value: PlainRecord,
	key: string,
	path: string,
): string {
	const item = optionalString(value, key, path);
	if (item === undefined || item === "") {
		throw optionError(`${path}.${key}`, "is required.");
	}
	return item;
}

export function optionalBoolean(
	value: PlainRecord,
	key: string,
	path: string,
): boolean | undefined {
	const item = value[key];
	if (item === undefined) return undefined;
	if (typeof item !== "boolean") {
		throw optionError(`${path}.${key}`, "must be a boolean.");
	}
	return item;
}

export function optionalOneOf<T extends string>(
	value: PlainRecord,
	key: string,
	allowed: readonly T[],
	path: string,
): T | undefined {
	const item = value[key];
	if (item === undefined) return undefined;
	if (typeof item !== "string" || !allowed.includes(item as T)) {
		throw optionError(
			`${path}.${key}`,
			`must be one of ${allowed.map((entry) => `"${entry}"`).join(", ")}.`,
		);
	}
	return item as T;
}

export function optionalPositiveInteger(
	value: PlainRecord,
	key: string,
	path: string,
	bounds: { min?: number; max?: number } = {},
): number | undefined {
	const item = value[key];
	if (item === undefined) return undefined;
	if (
		typeof item !== "number" ||
		!Number.isInteger(item) ||
		item <= 0 ||
		(bounds.min !== undefined && item < bounds.min) ||
		(bounds.max !== undefined && item > bounds.max)
	) {
		const range =
			bounds.min !== undefined || bounds.max !== undefined
				? ` between ${bounds.min ?? 1} and ${bounds.max ?? "∞"}`
				: "";
		throw optionError(`${path}.${key}`, `must be a positive integer${range}.`);
	}
	return item;
}

/** Absolute http(s)/ws(s) URL without userinfo. Relative URLs are resolved by the page client. */
/**
 * A URL whose query names a credential (`?access_token=`, `?auth=`, …) is
 * refused like a token-named option key. Relative URLs are read against a
 * placeholder base; the error names the path, never the value.
 */
export function refuseQueryCarriers(
	url: string,
	path: string,
	adapter?: string,
): void {
	let names: Iterable<string>;
	try {
		names = new URL(url, "http://base.invalid").searchParams.keys();
	} catch {
		return;
	}
	for (const name of names) refuseCredentialCarriers(name, path, adapter);
}

export function assertEndpoint(
	value: PlainRecord,
	key: string,
	path: string,
	protocols: readonly string[],
	options: { requireAbsolute: boolean },
): string {
	const url = requiredString(value, key, path);
	refuseQueryCarriers(url, `${path}.${key}`);
	let parsed: URL | undefined;
	try {
		parsed = new URL(url);
	} catch {
		if (options.requireAbsolute) {
			throw new SpinetabError(
				"invalid-endpoint",
				`${path}.${key}: must be an absolute URL in the runtime.`,
				{ detail: { path: `${path}.${key}` } },
			);
		}
		return url;
	}
	if (parsed.username || parsed.password) {
		throw new SpinetabError(
			"invalid-endpoint",
			`${path}.${key}: credentials in URLs are not supported.`,
			{ detail: { path: `${path}.${key}` } },
		);
	}
	if (!protocols.includes(parsed.protocol)) {
		throw new SpinetabError(
			"invalid-endpoint",
			`${path}.${key}: protocol must be one of ${protocols.join(", ")}.`,
			{ detail: { path: `${path}.${key}` } },
		);
	}
	return url;
}

/** Header names that carry credentials; they belong in `ctx.credentials()`. */
const CREDENTIAL_HEADERS = new Set([
	"authorization",
	"cookie",
	"proxy-authorization",
]);

/**
 * The fetch header-value grammar in ByteString form: every code unit
 * at most 0xFF and no NUL, CR or LF. Leading and trailing spaces and tabs are
 * valid; fetch strips them before sending. core/http.ts keeps a copy for
 * polling (core never imports transports); a unit test keeps them in parity.
 */
export function isHeaderValue(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const unit = value.charCodeAt(index);
		if (unit > 0xff || unit === 0x00 || unit === 0x0a || unit === 0x0d) {
			return false;
		}
	}
	return true;
}

/**
 * Identity-bearing request headers: a plain record of string values without
 * credential-bearing names. Names are compared case-insensitively and must be
 * unique ignoring case; values follow the fetch header-value grammar.
 */
export function optionalHeaders(
	value: PlainRecord,
	key: string,
	path: string,
): Record<string, string> | undefined {
	const item = value[key];
	if (item === undefined) return undefined;
	assertRecord(item, `${path}.${key}`);
	const seen = new Set<string>();
	for (const [name, headerValue] of Object.entries(item)) {
		const lower = name.toLowerCase();
		const headerPath = `${path}.${key}.${name}`;
		if (typeof headerValue !== "string") {
			throw optionError(headerPath, "must be a string.");
		}
		if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
			throw optionError(headerPath, "is not a valid header name.");
		}
		if (CREDENTIAL_HEADERS.has(lower)) {
			throw optionError(
				headerPath,
				"credentials never enter identity; set authHeaders: true and supply credentials.headers from the page's credentials provider.",
			);
		}
		if (lower === "last-event-id") {
			throw optionError(
				headerPath,
				"is managed by the adapter from the stream cursor.",
			);
		}
		if (!isHeaderValue(headerValue)) {
			throw optionError(
				headerPath,
				"must be a valid header value: characters up to U+00FF, without NUL, CR or LF.",
			);
		}
		if (seen.has(lower)) {
			throw optionError(headerPath, "duplicates another header name.");
		}
		seen.add(lower);
	}
	// The shared list: also `x-api-key` and `x-auth-token`.
	refuseCredentialCarriers(item, `${path}.${key}`);
	return item as Record<string, string>;
}

export const HTTP_PROTOCOLS = ["http:", "https:"] as const;
export const WS_PROTOCOLS = ["ws:", "wss:", "http:", "https:"] as const;
