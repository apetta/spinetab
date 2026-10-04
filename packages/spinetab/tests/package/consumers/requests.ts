import type { FrontLog, LoggedRequest } from "./front.ts";

/**
 * Request attribution for the packed-consumer cells: a
 * logged request names an emitted chunk by its output-relative path, never
 * by base name alone, and belongs to the page or the worker realm by its
 * destination, so one module serving as both the worker entry and the lazy
 * local runtime is counted where it was fetched. Pure; no Playwright.
 */

/** Which realm fetched a request, by destination. */
export type RequestRealm = "page" | "worker";

const WORKER_DESTS = new Set(["sharedworker", "worker"]);
const pathname = (path: string) => path.replace(/[?#].*$/, "");

/**
 * Worker-realm requests by destination: `sharedworker`/`worker` (a module
 * worker's static imports carry it too), plus every script a worker-realm
 * script requested (`importScripts`, a worker's dynamic `import()`), found
 * by `Referer` to a fixpoint. Everything else was fetched by a page.
 */
export function requestRealm(log: FrontLog): Map<LoggedRequest, RequestRealm> {
	const workerPaths = new Set(
		log.requests
			.filter((request) => WORKER_DESTS.has(request.dest ?? ""))
			.map((request) => pathname(request.path)),
	);
	for (let grew = true; grew; ) {
		grew = false;
		for (const request of log.requests) {
			const path = pathname(request.path);
			if (
				request.referrer &&
				workerPaths.has(request.referrer) &&
				!workerPaths.has(path)
			) {
				workerPaths.add(path);
				grew = true;
			}
		}
	}
	const realms = new Map<LoggedRequest, RequestRealm>();
	for (const request of log.requests) {
		const worker =
			WORKER_DESTS.has(request.dest ?? "") ||
			(request.referrer !== null &&
				request.referrer !== undefined &&
				workerPaths.has(request.referrer));
		realms.set(request, worker ? "worker" : "page");
	}
	return realms;
}

/**
 * Whether a request path names an emitted chunk: its output-relative path
 * (`assets/live.worker-1.js`, `static/chunks/x.js`, `src/live.local.js` on a
 * dev server) must end the request's path, never its base name alone, and the
 * query must match when the chunk names one (Vite's dev worker entry is
 * `src/live.worker.js?worker_file&type=module`, its lazy import the bare path).
 */
export function namesChunk(path: string, file: string): boolean {
	const [filePath, fileQuery] = file.split("?") as [string, string?];
	const [requestPath, requestQuery] = path.split(/[?#]/) as [string, string?];
	const tail = filePath.replace(/^\/+/, "");
	if (requestPath !== `/${tail}` && !requestPath.endsWith(`/${tail}`)) {
		return false;
	}
	return fileQuery === undefined || fileQuery === (requestQuery ?? "");
}

/**
 * Logged requests for any of the emitted chunks, by chunk identity (`namesChunk`)
 * and, unless `realm` is `any`, by the destination realm that fetched them:
 * a fallback chunk fetched by a page is a fallback download, while the same
 * module loaded by the worker is not.
 */
export function chunkRequests(
	log: FrontLog,
	files: readonly string[],
	realm: RequestRealm | "any" = "any",
): LoggedRequest[] {
	const realms = realm === "any" ? undefined : requestRealm(log);
	return log.requests.filter(
		(request) =>
			(!realms || realms.get(request) === realm) &&
			files.some((file) => namesChunk(request.path, file)),
	);
}

/** `chunkRequests` as request paths (no query). */
export function requestsFor(
	log: FrontLog,
	files: readonly string[],
	realm: RequestRealm | "any" = "any",
): string[] {
	return chunkRequests(log, files, realm).map((request) =>
		pathname(request.path),
	);
}
