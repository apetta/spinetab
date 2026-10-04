import { estimateBytes } from "./estimate.ts";
import type { Json } from "./types.ts";
import {
	assertKnownKeys,
	assertObject,
	assertOneOf,
	assertPositiveInteger,
	unsupported,
} from "./validate.ts";

/**
 * Canonical form of a repeatable HTTP read (polling). Used by the page
 * builder to build the identity-bearing connection spec and by the runtime
 * adapter to validate it again (version skew), so both realms apply the same
 * rules without the runtime importing page code.
 */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type HttpCredentialsMode = "omit" | "same-origin" | "include";

export interface HttpReadSpec {
	url: string;
	method: HttpMethod;
	headers?: Record<string, string>;
	body?: string | Json;
	credentials?: HttpCredentialsMode;
	decoder: string;
	timeoutMs: number;
}

export const DEFAULT_READ_TIMEOUT_MS = 30_000;
export const MAX_READ_TIMEOUT_MS = 300_000;

const KEYS = [
	"url",
	"method",
	"headers",
	"body",
	"credentials",
	"decoder",
	"timeoutMs",
] as const;
const METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];
/** Credentials come from the brokered provider, never from identity-bearing specs. */
const SECRET_HEADERS = new Set([
	"authorization",
	"cookie",
	"proxy-authorization",
]);
/** RFC 9110 token: a valid header field name. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * The fetch header-value grammar in ByteString form: every code unit
 * at most 0xFF and no NUL, CR or LF. A copy of `isHeaderValue` in
 * transports/shared/options.ts (core never imports transports); a unit test
 * keeps the two in parity.
 */
function isHeaderValue(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const unit = value.charCodeAt(index);
		if (unit > 0xff || unit === 0x00 || unit === 0x0a || unit === 0x0d) {
			return false;
		}
	}
	return true;
}

export function normaliseHttpRead(
	input: unknown,
	path: string,
	adapter: string,
): HttpReadSpec {
	assertObject(input, path, adapter);
	assertKnownKeys(input, KEYS, path, adapter);
	const { url, headers, body, credentials, decoder, timeoutMs } = input;
	if (typeof url !== "string" || url.length === 0) {
		throw unsupported(`${path}.url`, "must be a non-empty string.", adapter);
	}
	const method =
		input.method === undefined ? "GET" : String(input.method).toUpperCase();
	assertOneOf(method, METHODS, `${path}.method`, adapter);
	const spec: HttpReadSpec = {
		url,
		method,
		decoder: decoder === undefined ? "json" : (decoder as string),
		timeoutMs:
			timeoutMs === undefined ? DEFAULT_READ_TIMEOUT_MS : (timeoutMs as number),
	};
	if (typeof spec.decoder !== "string" || spec.decoder.length === 0) {
		throw unsupported(
			`${path}.decoder`,
			"must be a non-empty string.",
			adapter,
		);
	}
	assertPositiveInteger(spec.timeoutMs, `${path}.timeoutMs`, {
		max: MAX_READ_TIMEOUT_MS,
		adapter,
	});
	if (headers !== undefined) {
		assertObject(headers, `${path}.headers`, adapter);
		const normalised: Record<string, string> = {};
		for (const [name, value] of Object.entries(headers)) {
			const lower = name.toLowerCase();
			if (typeof value !== "string") {
				throw unsupported(
					`${path}.headers.${name}`,
					"must be a string.",
					adapter,
				);
			}
			if (!HEADER_NAME.test(name)) {
				throw unsupported(
					`${path}.headers.${name}`,
					"is not a valid header name.",
					adapter,
				);
			}
			if (SECRET_HEADERS.has(lower)) {
				throw unsupported(
					`${path}.headers.${name}`,
					"must not carry credentials; return them from the credentials provider as `headers`.",
					adapter,
				);
			}
			if (!isHeaderValue(value)) {
				throw unsupported(
					`${path}.headers.${name}`,
					"must be a valid header value: characters up to U+00FF, without NUL, CR or LF.",
					adapter,
				);
			}
			normalised[lower] = value;
		}
		if (Object.keys(normalised).length > 0) spec.headers = normalised;
	}
	if (body !== undefined) {
		if (method === "GET") {
			throw unsupported(`${path}.body`, "is not allowed with GET.", adapter);
		}
		if (typeof body !== "string" && estimateBytes(body) === undefined) {
			throw unsupported(
				`${path}.body`,
				"must be a string or plain JSON data.",
				adapter,
			);
		}
		spec.body = body as string | Json;
	}
	if (credentials !== undefined) {
		assertOneOf(
			credentials,
			["omit", "same-origin", "include"],
			`${path}.credentials`,
			adapter,
		);
		spec.credentials = credentials;
	}
	return spec;
}
