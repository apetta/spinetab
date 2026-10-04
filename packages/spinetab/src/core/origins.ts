// Keep credential-origin validation import-free: both the browser runtime and Node build plugins use it.

export const CREDENTIAL_ORIGIN_SENTENCE =
	'must be an exact https: origin such as "https://api.example.com" (http: only for loopback), without a path, query, fragment or userinfo.';

export type OriginCheck =
	| { ok: true; origin: string }
	| { ok: false; reason: "type" | "syntax" | "scheme" | "path" | "userinfo" };

/**
 * Loopback hosts, which may use `http:`. The runtime judges request URLs
 * with the same predicate, so the two rules cannot drift apart.
 */
export const isLoopbackHost = (host: string): boolean =>
	host === "localhost" ||
	host.endsWith(".localhost") ||
	host === "[::1]" ||
	/^127\.\d+\.\d+\.\d+$/.test(host);

/**
 * The credential-origin rule used by `createRuntime`: an `https:` origin, or
 * `http:` on a loopback host, with no path, query, fragment or userinfo.
 * The query and fragment test reads the raw text, because `URL` drops an
 * empty `?` or `#`.
 */
export function checkCredentialOrigin(value: unknown): OriginCheck {
	if (typeof value !== "string") return { ok: false, reason: "type" };
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return { ok: false, reason: "syntax" };
	}
	if (
		!(
			url.protocol === "https:" ||
			(url.protocol === "http:" && isLoopbackHost(url.hostname))
		)
	) {
		return { ok: false, reason: "scheme" };
	}
	if (url.username || url.password) return { ok: false, reason: "userinfo" };
	if (/[?#]/.test(value) || url.pathname !== "/") {
		return { ok: false, reason: "path" };
	}
	return { ok: true, origin: url.origin };
}

/**
 * Normalised (`URL.origin`), de-duplicated and sorted by code unit, so the
 * result is identical on every machine. Throws nothing: an entry that fails
 * `checkCredentialOrigin` is left out (the audience only ever narrows), and
 * callers report such entries themselves before calling this.
 */
export function normaliseCredentialOrigins(
	values: readonly string[],
): readonly string[] {
	const origins = new Set<string>();
	for (const value of values) {
		const check = checkCredentialOrigin(value);
		if (check.ok) origins.add(check.origin);
	}
	return [...origins].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
