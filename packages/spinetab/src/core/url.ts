import { SpinetabError } from "./errors.ts";

/**
 * Resolve an endpoint against the application's intended base in the page. The worker asset URL is never the base. URLs carrying
 * userinfo are rejected so credentials never travel in URLs.
 */
export function resolveEndpoint(url: string, base?: string): string {
	if (typeof url !== "string" || url.length === 0) {
		throw invalid("Endpoint must be a non-empty string.");
	}
	let resolved: URL;
	try {
		resolved = base === undefined ? new URL(url) : new URL(url, base);
	} catch {
		throw invalid(
			base === undefined
				? "Endpoint is not an absolute URL; pass a base or an absolute URL."
				: "Endpoint cannot be resolved against the base URL.",
		);
	}
	if (resolved.username !== "" || resolved.password !== "") {
		throw invalid(
			"Endpoint must not contain userinfo; supply credentials through the credentials provider.",
		);
	}
	return resolved.href;
}

/** Runtime-side check: endpoints crossing the bridge must already be absolute. */
export function assertAbsoluteEndpoint(url: unknown, path: string): void {
	if (typeof url !== "string") {
		throw invalid(`${path} must be a string.`, path);
	}
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw invalid(
			`${path} must be an absolute URL; the page resolves relative endpoints before they reach the runtime.`,
			path,
		);
	}
	if (parsed.username !== "" || parsed.password !== "") {
		throw invalid(`${path} must not contain userinfo.`, path);
	}
}

function invalid(message: string, path?: string): SpinetabError {
	return new SpinetabError(
		"invalid-endpoint",
		message,
		path ? { detail: { path } } : {},
	);
}
