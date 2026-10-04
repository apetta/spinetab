import { SpinetabError } from "./errors.ts";

/**
 * Deterministic canonical form for identity-bearing specs: object keys sorted,
 * array order preserved, `undefined` properties dropped, no other
 * normalisation. Only plain JSON-like data is canonicalisable; anything else
 * (functions, symbols, class instances, Dates, Maps, buffers) throws so that a
 * request is rejected or given a unique identity rather than partially keyed.
 */
export function stableStringify(value: unknown, path = "$"): string {
	return stringify(value, path, new Set());
}

function stringify(value: unknown, path: string, stack: Set<object>): string {
	switch (typeof value) {
		case "string":
			return JSON.stringify(value);
		case "number":
			if (!Number.isFinite(value)) {
				throw notCanonical(path, "non-finite number");
			}
			return String(value);
		case "boolean":
			return value ? "true" : "false";
		case "bigint":
			return `${value.toString()}n`;
		case "undefined":
			return "null";
		case "object":
			break;
		default:
			throw notCanonical(path, typeof value);
	}
	if (value === null) return "null";
	if (stack.has(value)) throw notCanonical(path, "cyclic reference");
	stack.add(value);
	try {
		if (Array.isArray(value)) {
			const parts: string[] = [];
			for (let index = 0; index < value.length; index += 1) {
				if (!Object.hasOwn(value, index)) {
					throw notCanonical(`${path}[${index}]`, "sparse array hole");
				}
				parts.push(stringify(value[index], `${path}[${index}]`, stack));
			}
			return `[${parts.join(",")}]`;
		}
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw notCanonical(path, "non-plain object");
		}
		const keys = Object.keys(value as Record<string, unknown>).sort();
		const parts: string[] = [];
		for (const key of keys) {
			const item = (value as Record<string, unknown>)[key];
			if (item === undefined) continue;
			parts.push(
				`${JSON.stringify(key)}:${stringify(item, `${path}.${key}`, stack)}`,
			);
		}
		return `{${parts.join(",")}}`;
	} finally {
		stack.delete(value);
	}
}

function notCanonical(path: string, kind: string): SpinetabError {
	return new SpinetabError(
		"unsupported-option",
		`Value at ${path} (${kind}) cannot be part of a canonical identity; use plain JSON data or give the request a unique identity.`,
		{ detail: { path, kind } },
	);
}

/**
 * Connection identity: adapter kind, auth scope, the page's credential mode and
 * canonical connection spec. An anonymous page's key carries `+anonymous` as
 * its own component straight after the JSON-quoted scope. A quoted scope
 * cannot spell it, and every other key has `|` in that position, so no scope
 * or canonical spec can make an anonymous key equal a provider page's key.
 */
export function connectionKey(
	adapter: string,
	scope: string,
	canonicalSpec: string,
	anonymous = false,
): string {
	return `${adapter}|${JSON.stringify(scope)}${anonymous ? "+anonymous" : ""}|${canonicalSpec}`;
}

/** Subscription identity: connection identity plus canonical subscription spec. */
export function subscriptionKey(
	connection: string,
	canonicalSpec: string,
): string {
	return `${connection}|${canonicalSpec}`;
}

let uniqueCounter = 0;

/** A key that never matches another request. */
export function uniqueKey(prefix = "unique"): string {
	uniqueCounter += 1;
	return `${prefix}:${uniqueCounter.toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
}

export function isUniqueKey(key: string): boolean {
	return key.startsWith("unique:");
}
