import type { LoggedRequest } from "./static-server.ts";

/**
 * Realm of each served chunk, from one page load's
 * request log. `Sec-Fetch-Dest: script` is a page script, except when a
 * worker requests it: a classic worker's `importScripts` (Turbopack's
 * `turbopack-worker-*.js` loads its chunks this way) also has destination
 * `script`, with the worker's own URL as `Referer`. Such requests become
 * `worker-script`, so worker code is never counted as page code.
 */

export type Realm = "page" | "worker" | "shared" | "lazy" | "unused";

const WORKER_DESTS = new Set(["sharedworker", "worker"]);

/** Destinations per path (status 200), with worker-initiated scripts as `worker-script`. */
export function destinations(
	requests: LoggedRequest[],
): Map<string, Set<string>> {
	const ok = requests.filter((request) => request.status === 200);
	const workerPaths = new Set(
		ok
			.filter((request) => WORKER_DESTS.has(request.dest ?? ""))
			.map((request) => request.path),
	);
	// Fixpoint: a script requested from a worker-loaded script is worker code too.
	for (let grew = true; grew; ) {
		grew = false;
		for (const request of ok) {
			if (
				request.dest === "script" &&
				request.referrer &&
				workerPaths.has(request.referrer) &&
				!workerPaths.has(request.path)
			) {
				workerPaths.add(request.path);
				grew = true;
			}
		}
	}
	const byPath = new Map<string, Set<string>>();
	for (const request of ok) {
		const dest =
			request.dest === "script" &&
			request.referrer &&
			workerPaths.has(request.referrer)
				? "worker-script"
				: (request.dest ?? "");
		const set = byPath.get(request.path) ?? new Set<string>();
		set.add(dest);
		byPath.set(request.path, set);
	}
	return byPath;
}

export function realmOf(shared: Set<string>, local: Set<string>): Realm {
	const page = shared.has("script");
	const worker =
		shared.has("sharedworker") ||
		shared.has("worker") ||
		shared.has("worker-script");
	if (page && worker) return "shared";
	if (worker) return "worker";
	if (page) return "page";
	if (local.has("script")) return "lazy";
	return "unused";
}
