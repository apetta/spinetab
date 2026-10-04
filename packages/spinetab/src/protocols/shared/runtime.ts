import type {
	ConnectionReason,
	Credentials,
	SerialisedError,
} from "../../core/types.ts";
import { isPlainObject } from "./validate.ts";

/**
 * A promise that never settles. Used to park an upstream connect hook when
 * credentials are unavailable so the upstream opens no socket and runs no
 * retry loop; the adapter then replaces the whole client on unblock.
 */
export function parked<T>(): Promise<T> {
	return new Promise<T>(() => {});
}

/**
 * Map a rejected credential request to the auth-blocked reason. A provider
 * that failed (`credentials-failed`) or did not answer in time
 * (`credentials-timeout`) is transient and maps to `credentials-missing`, as
 * does any other failure: never an anonymous attempt.
 * `credentials-audience` (the URL is outside the worker's credential
 * audience) is permanent: adapters never retry it on their own.
 */
export function credentialFailureReason(error: unknown): ConnectionReason {
	const code = (error as { code?: unknown } | null)?.code;
	if (code === "credentials-rejected") return "credentials-rejected";
	if (code === "no-credential-source") return "no-credential-source";
	if (code === "credentials-audience") return "credentials-audience";
	return "credentials-missing";
}

/**
 * A 403-equivalent: the connection ends as `permanent-error` with the
 * fixed code `forbidden`, and no credential revision is rejected.
 */
export const FORBIDDEN = Object.freeze({
	state: "failed",
	reason: "permanent-error",
	code: "forbidden",
} as const);

/**
 * The grant to name in `rejectCredentials`: the credentials object when
 * `attached` (the provider material actually sent) is non-empty, otherwise
 * `undefined`, so nothing is rejected for a request that carried none.
 */
export function attachedGrant(
	credentials: Credentials | undefined,
	attached: Record<string, unknown>,
): Credentials | undefined {
	return credentials && Object.keys(attached).length > 0
		? credentials
		: undefined;
}

/** Read one documented credential channel (`headers`, `connectionParams`, `auth`). */
export function credentialChannel(
	credentials: Credentials | undefined,
	key: "headers" | "connectionParams" | "auth",
): Record<string, unknown> {
	const value = credentials?.[key];
	return isPlainObject(value) ? value : {};
}

/** Header values must be strings; anything else is dropped rather than coerced. */
export function stringHeaders(
	...sources: Array<Record<string, unknown> | undefined>
): Record<string, string> {
	const headers: Record<string, string> = {};
	for (const source of sources) {
		if (!source) continue;
		for (const [name, value] of Object.entries(source)) {
			if (typeof value === "string") headers[name] = value;
		}
	}
	return headers;
}

/**
 * Whether a response to a request sent with `redirect: "manual"` is a redirect
 * that was not followed: status 0 is a browser `opaqueredirect`; outside
 * browsers the 3xx itself arrives. The same rule as transports'.
 */
export function isRefusedRedirect(status: number): boolean {
	return status === 0 || (status >= 300 && status < 400 && status !== 304);
}

/** Bounded, single-line reason text for statuses and errors (close reasons ≤ 123 bytes). */
export function boundedText(value: unknown, fallback = ""): string {
	const text = typeof value === "string" ? value : fallback;
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

export function upstreamError(
	message: string,
	detail?: SerialisedError["detail"],
): SerialisedError {
	return detail === undefined
		? { code: "upstream-error", message }
		: { code: "upstream-error", message, detail };
}

/** Error-like values never cross the bridge; keep only a bounded message. */
export function errorMessage(error: unknown, fallback: string): string {
	if (error instanceof Error && error.message)
		return boundedText(error.message);
	if (typeof error === "string") return boundedText(error);
	return fallback;
}
