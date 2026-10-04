import { SpinetabError } from "./errors.ts";
import { isPlainObject } from "./plain-object.ts";
import type { Credentials } from "./types.ts";

export { isPlainObject };

export function unsupported(
	path: string,
	message: string,
	adapter?: string,
): SpinetabError {
	return new SpinetabError(
		"unsupported-option",
		`${adapter ? `${adapter}: ` : ""}${path} ${message}`,
		{ detail: adapter ? { path, adapter } : { path } },
	);
}

/** Reject any own key not in `allowed` (unknown options are never ignored). */
export function assertKnownKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
	path: string,
	adapter?: string,
): void {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) {
			throw unsupported(
				`${path}.${key}`,
				"is not a supported option.",
				adapter,
			);
		}
	}
}

export function assertObject(
	value: unknown,
	path: string,
	adapter?: string,
): asserts value is Record<string, unknown> {
	if (!isPlainObject(value)) {
		throw unsupported(path, "must be a plain object.", adapter);
	}
}

export function assertPositiveInteger(
	value: unknown,
	path: string,
	options: { min?: number; max?: number; adapter?: string } = {},
): asserts value is number {
	const min = options.min ?? 1;
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value < min ||
		(options.max !== undefined && value > options.max)
	) {
		const range =
			options.max === undefined
				? `an integer of at least ${min}`
				: `an integer between ${min} and ${options.max}`;
		throw unsupported(path, `must be ${range}.`, options.adapter);
	}
}

export function assertOneOf<T extends string>(
	value: unknown,
	allowed: readonly T[],
	path: string,
	adapter?: string,
): asserts value is T {
	if (typeof value !== "string" || !allowed.includes(value as T)) {
		throw unsupported(
			path,
			`must be one of ${allowed.map((item) => JSON.stringify(item)).join(", ")}.`,
			adapter,
		);
	}
}

/** Query, `connectionParams` and `auth` keys that name a credential. */
const TOKEN_KEYS = new Set([
	"access_token",
	"id_token",
	"refresh_token",
	"token",
	"api_key",
	"apikey",
	"jwt",
	"auth",
	"authorization",
	"password",
	"secret",
]);
/** Headers that carry credentials or a replay cursor, never static options. */
const CREDENTIAL_HEADERS = new Set([
	"authorization",
	"proxy-authorization",
	"cookie",
	"x-api-key",
	"x-auth-token",
	"last-event-id",
]);
const FIX = "return tokens from the credentials provider on createSpinetab.";

/**
 * Refuse token-shaped credential carriers in static, identity-bearing options, for page builders and worker validators alike. A guard against
 * accidents, not a security boundary. The last segment of `path` selects the
 * rule: `headers` refuses credential header names; `subprotocols` refuses
 * entries longer than 64 characters or containing "bearer"; any other path
 * (query, `connectionParams`, `auth`) refuses token-named keys at any depth,
 * and a string is checked as one key name (a query parameter name). Messages
 * name the path, never the value.
 */
export function refuseCredentialCarriers(
	value: unknown,
	path: string,
	adapter?: string,
): void {
	const rule = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
	if (rule === "headers") {
		if (!isPlainObject(value)) return;
		for (const name of Object.keys(value)) {
			if (CREDENTIAL_HEADERS.has(name.toLowerCase()))
				throw unsupported(
					`${path}.${name}`,
					`must not carry credentials; ${FIX}`,
					adapter,
				);
		}
		return;
	}
	if (rule === "subprotocols") {
		for (const entry of [value].flat()) {
			if (
				typeof entry === "string" &&
				(entry.length > 64 || /bearer/i.test(entry))
			)
				throw unsupported(
					path,
					`must not carry a token (an entry over 64 characters or containing "bearer"); ${FIX}`,
					adapter,
				);
		}
		return;
	}
	if (typeof value === "string" && TOKEN_KEYS.has(value.toLowerCase()))
		throw unsupported(path, `looks like a credential; ${FIX}`, adapter);
	// Iterative, so no depth is too deep to check; `seen` stops cycles.
	const seen = new Set<object>();
	const pending: Array<[unknown, string]> = [[value, path]];
	for (let next = pending.pop(); next; next = pending.pop()) {
		const [node, at] = next;
		if (typeof node !== "object" || node === null || seen.has(node)) continue;
		seen.add(node);
		for (const [key, child] of Object.entries(node)) {
			const here = `${at}.${key}`;
			if (TOKEN_KEYS.has(key.toLowerCase()))
				throw unsupported(here, `looks like a credential; ${FIX}`, adapter);
			pending.push([child, here]);
		}
	}
}

/** RFC 9110 token: a valid header field name. */
const HTTP_TOKEN = /^[!#$%&'*+.^_`|~\w-]+$/;
/** Forbidden request headers (Fetch), plus `last-event-id`, the replay cursor. */
const FORBIDDEN_HEADER =
	/^(?:accept-(?:charset|encoding)|access-control-request-.*|connection|content-length|cookie2?|date|dnt|expect|host|keep-alive|last-event-id|origin|referer|set-cookie|te|trailer|transfer-encoding|upgrade|via|proxy-.*|sec-.*)$/i;

/**
 * Strict JSON data: plain objects, dense arrays, strings, finite numbers,
 * booleans and null; no `undefined` member, no cycle. A value reused in two
 * places is fine.
 */
function isJson(value: unknown, stack: Set<object> = new Set()): boolean {
	if (value === null || typeof value === "string" || typeof value === "boolean")
		return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (typeof value !== "object" || stack.has(value)) return false;
	const array = Array.isArray(value);
	if (!array && !isPlainObject(value)) return false;
	stack.add(value);
	const items = array ? Array.from(value) : Object.values(value);
	const ok = items.every((item) => isJson(item, stack));
	stack.delete(value);
	return ok;
}

/**
 * The closed credentials shape: `{ headers?, connectionParams?, auth? }`
 * with string header values under header names that are HTTP tokens other
 * than `cookie`, `last-event-id` or a forbidden request header, and
 * `connectionParams` and `auth` as `Record<string, Json>`. Checked on the page
 * before the reply and usable on broker replies.
 */
export function isCredentials(value: unknown): value is Credentials {
	if (!isPlainObject(value)) return false;
	for (const [key, entry] of Object.entries(value)) {
		if (key !== "headers" && key !== "connectionParams" && key !== "auth")
			return false;
		if (entry === undefined) continue;
		if (!isPlainObject(entry)) return false;
		if (key !== "headers") {
			if (!isJson(entry)) return false;
		} else {
			for (const [name, header] of Object.entries(entry)) {
				if (
					typeof header !== "string" ||
					!HTTP_TOKEN.test(name) ||
					FORBIDDEN_HEADER.test(name)
				)
					return false;
			}
		}
	}
	return true;
}
