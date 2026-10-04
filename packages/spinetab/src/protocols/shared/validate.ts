import { SpinetabError } from "../../core/errors.ts";
import type { Json } from "../../core/types.ts";
import { refuseCredentialCarriers } from "../../core/validate.ts";

export { refuseCredentialCarriers };

/**
 * An endpoint URL whose query names a credential (`?token=`, `?jwt=`, …)
 * is refused like a token-named option key. Relative URLs are read against a
 * placeholder base; the message names the path, never the value.
 */
export function refuseUrlCredentials(url: unknown, path: string): void {
	if (typeof url !== "string") return;
	let names: Iterable<string>;
	try {
		names = new URL(url, "http://base.invalid").searchParams.keys();
	} catch {
		return;
	}
	for (const name of names) refuseCredentialCarriers(name, path);
}

/**
 * Realm-neutral option validation shared by the protocol page builders and
 * runtime adapters. Every failure is `unsupported-option` with the offending
 * path in `detail.path`, so applications can fix the named option. Messages
 * never echo option values (they may be credentials).
 */
export function invalid(path: string, message: string): SpinetabError {
	return new SpinetabError("unsupported-option", `${path}: ${message}`, {
		detail: { path },
	});
}

export function isPlainObject(
	value: unknown,
): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

export function assertPlainObject(
	value: unknown,
	path: string,
): asserts value is Record<string, unknown> {
	if (!isPlainObject(value)) throw invalid(path, "must be a plain object.");
}

/** Reject keys outside the documented allow-list; never pass them through. */
export function assertKnownKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
	path: string,
): void {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) {
			throw invalid(
				`${path}.${key}`,
				`unsupported option. Supported options: ${allowed.join(", ")}.`,
			);
		}
	}
}

export function assertString(
	value: unknown,
	path: string,
	options: { optional?: boolean; nonEmpty?: boolean } = {},
): void {
	if (value === undefined && options.optional) return;
	if (typeof value !== "string") throw invalid(path, "must be a string.");
	if (options.nonEmpty && value.length === 0) {
		throw invalid(path, "must not be empty.");
	}
}

export function assertBoolean(value: unknown, path: string): void {
	if (value === undefined) return;
	if (typeof value !== "boolean") throw invalid(path, "must be a boolean.");
}

/** Finite integer within bounds; `undefined` is allowed (option omitted). */
export function assertInteger(
	value: unknown,
	path: string,
	bounds: { min: number; max?: number },
): void {
	if (value === undefined) return;
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value < bounds.min ||
		(bounds.max !== undefined && value > bounds.max)
	) {
		const range =
			bounds.max === undefined
				? `>= ${bounds.min}`
				: `between ${bounds.min} and ${bounds.max}`;
		throw invalid(path, `must be an integer ${range}.`);
	}
}

export function assertOneOf<T extends string>(
	value: unknown,
	allowed: readonly T[],
	path: string,
	options: { optional?: boolean } = {},
): void {
	if (value === undefined && options.optional) return;
	if (typeof value !== "string" || !allowed.includes(value as T)) {
		throw invalid(path, `must be one of ${allowed.join(", ")}.`);
	}
}

/**
 * Absolute endpoint URL with an allowed scheme and no userinfo. Relative URLs
 * are resolved by the page client before crossing the bridge;
 * the runtime never resolves against the worker script location.
 */
export function assertAbsoluteUrl(
	value: unknown,
	path: string,
	schemes: readonly string[],
): URL {
	if (typeof value !== "string") throw invalid(path, "must be a URL string.");
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new SpinetabError(
			"invalid-endpoint",
			`${path}: must be an absolute URL; the page client resolves relative endpoints.`,
			{ detail: { path } },
		);
	}
	if (url.username || url.password) {
		throw new SpinetabError(
			"invalid-endpoint",
			`${path}: URLs must not contain credentials.`,
			{ detail: { path } },
		);
	}
	if (!schemes.includes(url.protocol)) {
		throw new SpinetabError(
			"invalid-endpoint",
			`${path}: scheme must be one of ${schemes.join(", ")}.`,
			{ detail: { path } },
		);
	}
	return url;
}

/**
 * Strict JSON data: plain objects, arrays, strings, finite numbers, booleans
 * and null. `undefined` object members are allowed (dropped on the wire and
 * in identity). Dates, Maps, BigInts, NaN and class instances are rejected
 * because their wire form differs from their identity.
 */
export function assertJson(
	value: unknown,
	path: string,
): asserts value is Json {
	checkJson(value, path, new Set());
}

function checkJson(value: unknown, path: string, stack: Set<object>): void {
	switch (typeof value) {
		case "string":
		case "boolean":
			return;
		case "number":
			if (!Number.isFinite(value)) throw invalid(path, "must be finite.");
			return;
		case "object":
			break;
		default:
			throw invalid(path, `${typeof value} is not JSON data.`);
	}
	if (value === null) return;
	if (stack.has(value)) throw invalid(path, "cyclic data is not supported.");
	stack.add(value);
	try {
		if (Array.isArray(value)) {
			for (let index = 0; index < value.length; index += 1) {
				if (!Object.hasOwn(value, index) || value[index] === undefined) {
					throw invalid(`${path}[${index}]`, "arrays must not contain holes.");
				}
				checkJson(value[index], `${path}[${index}]`, stack);
			}
			return;
		}
		if (!isPlainObject(value)) {
			throw invalid(path, "only plain objects are JSON data.");
		}
		for (const [key, item] of Object.entries(value)) {
			if (item === undefined) continue;
			checkJson(item, `${path}.${key}`, stack);
		}
	} finally {
		stack.delete(value);
	}
}

/**
 * URL-first builder arguments: `(url, options)` and `({ url,...options })`
 * give one connection object. The first argument wins over a `url` option.
 */
export function withUrl<T extends { url: string }>(
	input: string | T,
	options?: Omit<T, "url">,
): T {
	return typeof input === "string" ? ({ ...options, url: input } as T) : input;
}

/** Copy JSON data, dropping `undefined` members as JSON serialisation does. */
export function toJson<T>(value: T): T {
	if (Array.isArray(value)) return value.map((item) => toJson(item)) as T;
	if (isPlainObject(value)) {
		const result: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) {
			if (item !== undefined) result[key] = toJson(item);
		}
		return result as T;
	}
	return value;
}

/**
 * Non-secret, response-affecting headers enter connection identity. Credential
 * header names are refused by core's `refuseCredentialCarriers`, whose
 * message names the credentials provider.
 */
export function assertHeaders(value: unknown, path: string): void {
	if (value === undefined) return;
	assertPlainObject(value, path);
	for (const [name, item] of Object.entries(value)) {
		if (typeof item !== "string") {
			throw invalid(`${path}.${name}`, "header values must be strings.");
		}
	}
	refuseCredentialCarriers(value, path);
}
