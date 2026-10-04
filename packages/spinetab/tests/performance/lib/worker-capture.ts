import type { Variant } from "../../fixtures/harness/src/bench/types.ts";
import type { CdpTarget, WorkerAttach } from "./cdp.ts";
import type { Recorded } from "./record.ts";

/**
 * SharedWorker observation for the privacy scenario. An empty worker capture is only evidence of
 * "no leak" when the capture provably works: on Chromium the scenario needs
 * a SharedWorker CDP attach, `Runtime` and `Network` enabled on it, and a
 * positive control (the bench worker's own upstream connection and a seeded
 * console line) observed through the same listeners. Firefox and WebKit have
 * no CDP worker capture, so their worker rows are recorded as not measured,
 * never as zero. Node-runnable; no Playwright runtime import.
 */

export interface Capture {
	/** Page console lines (`page.on("console")`, `pageerror`). */
	console: string[];
	/** Page request and WebSocket URLs. */
	requests: string[];
	/** Worker console and exception events, excluding the seeded control. */
	workerConsole: string[];
	/** Worker console events carrying the positive-control token. */
	workerControlConsole: string[];
	/** Worker request and WebSocket URLs (for the unexpected-URL scan). */
	workerRequests: string[];
	/** Worker network events with their CDP event name (positive control). */
	workerNetwork: Array<{ event: string; url: string }>;
}

export function emptyCapture(): Capture {
	return {
		console: [],
		requests: [],
		workerConsole: [],
		workerControlConsole: [],
		workerRequests: [],
		workerNetwork: [],
	};
}

/** Which worker CDP domains are enabled; errors keyed by CDP method. */
export interface WorkerCapability {
	runtime: boolean;
	network: boolean;
	errors: Record<string, string>;
}

/**
 * Register the worker listeners, then enable `Runtime` and `Network`. A
 * rejected `Runtime.enable` propagates (the row fails). A rejected
 * `Network.enable` is not swallowed: it is recorded as `network: false` with
 * its error, and `requireWorkerCapture` fails the row.
 */
export async function watchWorker(
	target: CdpTarget,
	captured: Capture,
	controlToken?: string,
): Promise<WorkerCapability> {
	target.on("Runtime.consoleAPICalled", (params) => {
		const line = JSON.stringify(params.args ?? []);
		if (controlToken && line.includes(controlToken)) {
			captured.workerControlConsole.push(line);
		} else captured.workerConsole.push(line);
	});
	target.on("Runtime.exceptionThrown", (params) => {
		captured.workerConsole.push(JSON.stringify(params.exceptionDetails ?? {}));
	});
	const network = (event: string, url: string) => {
		captured.workerRequests.push(url);
		captured.workerNetwork.push({ event, url });
	};
	target.on("Network.requestWillBeSent", (params) => {
		network("Network.requestWillBeSent", String(params.request?.url ?? ""));
	});
	target.on("Network.webSocketCreated", (params) => {
		network("Network.webSocketCreated", String(params.url ?? ""));
	});
	const capability: WorkerCapability = {
		runtime: false,
		network: false,
		errors: {},
	};
	await target.send("Runtime.enable");
	capability.runtime = true;
	try {
		await target.send("Network.enable");
		capability.network = true;
	} catch (error) {
		capability.errors["Network.enable"] = (error as Error).message;
	}
	return capability;
}

/**
 * Chromium precondition before any worker zero is trusted: a SharedWorker
 * target was attached and both domains are enabled. Throws with the recorded
 * attach and capability errors otherwise.
 */
export function requireWorkerCapture(
	attach: Pick<WorkerAttach, "target" | "errors">,
	capability?: WorkerCapability,
): asserts capability is WorkerCapability {
	if (!attach.target) {
		throw new Error(
			`worker capture unavailable: no SharedWorker CDP attach ${JSON.stringify(attach.errors)}`,
		);
	}
	if (!capability?.runtime || !capability.network) {
		throw new Error(
			`worker capture incomplete: runtime ${capability?.runtime ?? false}, network ${capability?.network ?? false} ${JSON.stringify(capability?.errors ?? {})}`,
		);
	}
}

/**
 * The bench worker's upstream request per variant (bench page `feedFor`:
 * `/bench/ws`, `/bench/graphql-ws`; both are WebSockets opened by the worker
 * runtime). An HTTP variant would name `Network.requestWillBeSent` here.
 */
export const UPSTREAM: Record<Variant, { event: string; path: string }> = {
	ws: { event: "Network.webSocketCreated", path: "/bench/ws" },
	"graphql-ws": {
		event: "Network.webSocketCreated",
		path: "/bench/graphql-ws",
	},
};

export interface PositiveControl {
	ok: boolean;
	expected: { event: string; path: string; origin: string };
	/** Worker network events that match the expected upstream request. */
	upstream: Array<{ event: string; url: string }>;
	/** Seeded worker console events observed (`null` when none was seeded). */
	console: number | null;
	missing: string[];
}

function sameEndpoint(raw: string, origin: string, path: string): boolean {
	let url: URL;
	try {
		url = new URL(raw, origin);
	} catch {
		return false;
	}
	const normalised = url.origin.replace(/^ws(s?):/, "http$1:");
	return normalised === origin && url.pathname === path;
}

/**
 * Positive control: the capture must contain the worker's own upstream
 * request for the variant and, when a console line was seeded, at least one
 * seeded console event. Otherwise zero counts prove nothing.
 */
export function workerPositiveControl(
	variant: Variant,
	captured: Pick<Capture, "workerNetwork" | "workerControlConsole">,
	origin: string,
	consoleSeeded: boolean,
): PositiveControl {
	const expected = { ...UPSTREAM[variant], origin };
	const upstream = captured.workerNetwork.filter(
		(entry) =>
			entry.event === expected.event &&
			sameEndpoint(entry.url, origin, expected.path),
	);
	const missing: string[] = [];
	if (upstream.length === 0) {
		missing.push(`${expected.event} ${origin}${expected.path}`);
	}
	const seeded = consoleSeeded ? captured.workerControlConsole.length : null;
	if (seeded === 0) missing.push("seeded worker console event");
	return {
		ok: missing.length === 0,
		expected,
		upstream,
		console: seeded,
		missing,
	};
}

export function assertPositiveControl(control: PositiveControl): void {
	if (!control.ok) {
		throw new Error(
			`worker capture positive control missing: ${control.missing.join("; ")}`,
		);
	}
}

/** Worker-side privacy rows (measured only where the worker is observable). */
export const workerKeys = (key: string) => [
	`${key}.worker-markers`,
	`${key}.worker-console`,
	`${key}.worker-network-unexpected`,
];

export const noWorkerCapture = (engine: string) =>
	`no CDP worker capture on ${engine}`;

/** Firefox/WebKit: worker rows are not measured, never zero. */
export function skipWorkerRows(out: Recorded, key: string, engine: string) {
	for (const id of workerKeys(key)) out.skip(id, noWorkerCapture(engine));
}

/**
 * Probe stage: a CDP route whose worker console and worker network
 * attempts both succeeded and delivered at least one event, the network one
 * including the probe's own `/__fixture/bench/clock` fetch.
 */
export function workerEventsObserved(route: Record<string, unknown>): boolean {
	const consoleEvents = route.consoleEvents as
		| { ok?: boolean; value?: { received?: number } }
		| undefined;
	const networkEvents = route.networkEvents as
		| { ok?: boolean; value?: { received?: number; urls?: string[] } }
		| undefined;
	return (
		consoleEvents?.ok === true &&
		(consoleEvents.value?.received ?? 0) > 0 &&
		networkEvents?.ok === true &&
		(networkEvents.value?.received ?? 0) > 0 &&
		(networkEvents.value?.urls ?? []).some((url) =>
			url.includes("/__fixture/bench/clock"),
		)
	);
}
