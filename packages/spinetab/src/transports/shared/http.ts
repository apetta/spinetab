import type { ConnectionContext } from "../../core/adapter.ts";
import { isSpinetabError } from "../../core/errors.ts";
import type {
	ConnectionReason,
	CredentialRequest,
	Credentials,
} from "../../core/types.ts";
import { isHeaderValue } from "./options.ts";

/** Retry-After values above this are clamped. */
export const RETRY_AFTER_CAP_MS = 300_000;

export type HttpOutcome =
	| { kind: "ok" }
	/** 401: the attached grant, if any, is rejected. */
	| { kind: "unauthorised" }
	/** 403: ends as `permanent-error` code `forbidden`; rejects nothing. */
	| { kind: "forbidden" }
	/** A redirect that was not followed; status 0 is an opaque redirect. */
	| { kind: "redirect" }
	| { kind: "permanent" }
	| { kind: "transient"; retryAfterMs?: number };

/**
 * Classify a response before any body is parsed: 401 blocks on
 * credentials, 403 and redirects are permanent, 408/429/5xx are transient,
 * every other non-2xx is permanent. Error bodies are never read.
 */
export function classifyStatus(
	status: number,
	headers?: { get(name: string): string | null },
	now: number = Date.now(),
): HttpOutcome {
	if (status >= 200 && status < 300) return { kind: "ok" };
	if (status === 401) return { kind: "unauthorised" };
	if (status === 403) return { kind: "forbidden" };
	if (status === 0 || (status >= 300 && status < 400 && status !== 304)) {
		return { kind: "redirect" };
	}
	if (status === 408 || status === 429 || status >= 500) {
		const retryAfterMs = parseRetryAfter(headers?.get("retry-after"), now);
		return retryAfterMs === undefined
			? { kind: "transient" }
			: { kind: "transient", retryAfterMs };
	}
	return { kind: "permanent" };
}

/** The status code an auth outcome carries: codes only, never upstream text. */
export const httpCode = (status: number): string => `http:${status}`;

/** Delay-seconds or HTTP-date; clamped to 5 minutes; invalid values ignored. */
export function parseRetryAfter(
	value: string | null | undefined,
	now: number = Date.now(),
): number | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	if (/^\d+$/.test(trimmed)) {
		return Math.min(Number(trimmed) * 1_000, RETRY_AFTER_CAP_MS);
	}
	const date = Date.parse(trimmed);
	if (Number.isNaN(date)) return undefined;
	return Math.min(Math.max(date - now, 0), RETRY_AFTER_CAP_MS);
}

/** `text/event-stream`, parameters allowed, case-insensitive. */
export function isEventStream(contentType: string | null): boolean {
	if (!contentType) return false;
	const essence = contentType.split(";")[0]?.trim().toLowerCase();
	return essence === "text/event-stream";
}

export type BlockedReason = Extract<
	ConnectionReason,
	| "credentials-missing"
	| "credentials-rejected"
	| "no-credential-source"
	| "credentials-audience"
>;

export type CredentialsOutcome =
	| { kind: "ok"; credentials: Credentials }
	| { kind: "blocked"; reason: BlockedReason }
	| { kind: "aborted" };

/**
 * Request the scope's credentials for `url` from the broker.
 * Failures map to `auth-blocked` reasons and nothing is sent
 * upstream. A credential timeout (`credentials-timeout`) and a failed
 * provider (`credentials-failed`) are both `auth-blocked/credentials-missing`; only a scope without any provider is
 * `no-credential-source`. A URL outside the worker's credential audience is
 * `credentials-audience`, which is permanent: rotation never restarts it.
 */
export async function obtainCredentials(
	ctx: ConnectionContext,
	reason: CredentialRequest["reason"],
	url: string,
): Promise<CredentialsOutcome> {
	try {
		const credentials = await ctx.credentials(reason, url);
		if (ctx.signal.aborted) return { kind: "aborted" };
		return { kind: "ok", credentials };
	} catch (error) {
		if (ctx.signal.aborted) return { kind: "aborted" };
		for (const code of [
			"no-credential-source",
			"credentials-rejected",
			"credentials-audience",
		] as const) {
			if (isSpinetabError(error, code))
				return { kind: "blocked", reason: code };
		}
		return { kind: "blocked", reason: "credentials-missing" };
	}
}

/** `authHeaders` on polling, fetch-mode SSE and fetch streams; unset is auto. */
export type AuthHeaders = boolean | undefined;

/**
 * The worker's own origin, read at call time from `globalThis.location`.
 * Node tests stub that global; nothing here is exported from a public entry.
 */
function workerOrigin(): string | undefined {
	const origin = (globalThis as { location?: { origin?: unknown } }).location
		?.origin;
	return typeof origin === "string" && origin !== "null" ? origin : undefined;
}

/** Exact `URL.origin` equality with the worker's origin, never a suffix match. */
export function isWorkerOrigin(url: string): boolean {
	const origin = workerOrigin();
	if (origin === undefined) return false;
	try {
		return new URL(url).origin === origin;
	} catch {
		return false;
	}
}

export type CredentialHeadersOutcome =
	| {
			kind: "ok";
			/** Provider headers to merge; absent when nothing is attached. */
			headers?: Record<string, string>;
			/** The grant the headers came from, for `rejectCredentials` on a 401. */
			attached?: Credentials;
	  }
	| { kind: "blocked"; reason: BlockedReason }
	| { kind: "aborted" };

/**
 * One credential-header rule for the HTTP transports, per
 * connection identity:
 *
 * - `false`: never asks, never merges;
 * - unset (auto): asks and merges only for a URL on the worker's own origin,
 * and reads without headers when the scope has no provider, unless this
 * identity already sent provider headers (no downgrade: it blocks
 * `credentials-missing` instead);
 * - `true`: always asks and requires `credentials.headers`; a cross-origin
 * URL must be in the worker's `credentialOrigins`, which the runtime judges
 * through `ctx.credentials(reason, url)`.
 *
 * Header values never leave as anything but request headers.
 */
export function credentialHeaders(
	ctx: ConnectionContext,
	authHeaders: AuthHeaders,
): (
	reason: CredentialRequest["reason"],
	url: string,
) => Promise<CredentialHeadersOutcome> {
	let sentBefore = false;
	// One origin judgement: the runtime's (it honours its test seam); the
	// location-based check is only for contexts that predate `ownOrigin`.
	const own = (target: string) =>
		ctx.ownOrigin ? ctx.ownOrigin(target) : isWorkerOrigin(target);
	return async (reason, url) => {
		const required = authHeaders === true;
		if (authHeaders === false || (!required && !own(url))) {
			return { kind: "ok" };
		}
		const nothing = (): CredentialHeadersOutcome =>
			required || sentBefore
				? { kind: "blocked", reason: "credentials-missing" }
				: { kind: "ok" };
		const outcome = await obtainCredentials(ctx, reason, url);
		if (outcome.kind === "aborted") return outcome;
		if (outcome.kind === "blocked") {
			return !required && outcome.reason === "no-credential-source"
				? nothing()
				: outcome;
		}
		const headers = outcome.credentials?.headers;
		if (headers === undefined) return nothing();
		// Values fetch would refuse block here, before any request;
		// the page and the broker already check the header names.
		if (
			typeof headers !== "object" ||
			headers === null ||
			Array.isArray(headers) ||
			!Object.values(headers).every(
				(value) => typeof value === "string" && isHeaderValue(value),
			)
		) {
			ctx.diagnostic({
				type: "credentials-invalid",
				detail: {
					expected:
						"credentials.headers: Record<string, string> of valid header values",
				},
			});
			return { kind: "blocked", reason: "credentials-missing" };
		}
		if (Object.keys(headers).length === 0) return nothing();
		sentBefore = true;
		return {
			kind: "ok",
			headers: headers as Record<string, string>,
			attached: outcome.credentials,
		};
	};
}

/**
 * Request options for a request that carries provider material: redirects
 * are never followed, so the origin judged above is the only one that
 * receives the headers. `manual` rather than `error`, because a rejected
 * fetch cannot be told apart from a network failure while an unfollowed
 * redirect can (`opaqueredirect`, or a 3xx outside browsers).
 */
export const NO_REDIRECT = {
	redirect: "manual",
} as const satisfies RequestInit;

/** Later sources win, compared case-insensitively. */
export function mergeHeaders(
	...sources: Array<Record<string, string> | undefined>
): Headers {
	const headers = new Headers();
	for (const source of sources) {
		if (!source) continue;
		for (const [name, value] of Object.entries(source)) {
			headers.set(name, value);
		}
	}
	return headers;
}

/** Map a thrown fetch/read failure to a payload-free description. */
export function describeFailure(error: unknown): string {
	if (error instanceof Error) {
		return error.name === "Error" ? "network error" : error.name;
	}
	return "network error";
}
