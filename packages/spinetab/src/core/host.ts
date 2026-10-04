import { BRIDGE_VERSION } from "./bridge.ts";
import { type Clock, systemClock } from "./clock.ts";
import { isSpinetabError } from "./errors.ts";
import type { RuntimeHandle, SpinetabErrorCode } from "./types.ts";

export const MAX_EARLY_PORTS = 64;
export const SETUP_TIMEOUT_MS = 10_000;

export type RuntimeSource =
	| RuntimeHandle
	| Promise<RuntimeHandle>
	| (() => RuntimeHandle | Promise<RuntimeHandle>);

export interface ConnectScope {
	addEventListener(
		type: "connect",
		listener: (event: MessageEvent) => void,
	): void;
}

export interface ServeOptions {
	setupTimeoutMs?: number;
	maxEarlyPorts?: number;
	clock?: Clock;
}

interface Failure {
	code: SpinetabErrorCode;
	message: string;
}

const SERVED_TWICE: Failure = {
	code: "worker-startup-error",
	message:
		"This worker serves Spinetab twice; call defineWorker or serveSharedWorker once.",
};

/** Scopes already served, each with the hook that turns its host away. */
const served = new WeakMap<object, () => void>();

/**
 * Whether `scope` is a SharedWorker global. Called at run time, never at
 * import, and reads nothing it has not checked: a page, a dedicated worker or
 * Node lacks the constructor or is not an instance of it.
 */
export function isSharedWorkerScope(scope: unknown): boolean {
	if (typeof scope !== "object" || scope === null) return false;
	const scopeClass = (scope as { SharedWorkerGlobalScope?: unknown })
		.SharedWorkerGlobalScope;
	return typeof scopeClass === "function" && scope instanceof scopeClass;
}

/**
 * Worker host. Registers the `connect` listener synchronously, buffers up to
 * `maxEarlyPorts` ports (unstarted, so their messages stay queued) until the
 * runtime is ready, and answers every `hello` with `startupError` when setup
 * fails or does not finish within `setupTimeoutMs`. Setup errors never become
 * silent hangs, and error text carries no payloads or secrets. A second serve
 * on the same scope registers nothing and turns every page away with
 * `worker-startup-error` from then on (duplicate-start guard).
 */
export function serve(
	scope: ConnectScope,
	source: RuntimeSource,
	options: ServeOptions = {},
): void {
	const again = served.get(scope);
	if (again) {
		again();
		return;
	}
	const clock = options.clock ?? systemClock;
	const maxEarly = options.maxEarlyPorts ?? MAX_EARLY_PORTS;
	let runtime: RuntimeHandle | undefined;
	let failure: Failure | undefined;
	let timer: unknown;
	let twice = false;
	const early: MessagePort[] = [];
	served.set(scope, () => {
		twice = true;
		clock.clearTimeout(timer);
		for (const port of early.splice(0)) answer(port, SERVED_TWICE);
	});

	const accept = (port: MessagePort) => {
		try {
			(runtime as RuntimeHandle).accept(port);
		} catch {
			answer(port, {
				code: "worker-startup-error",
				message: "The runtime could not accept this page.",
			});
		}
	};
	const ready = (value: RuntimeHandle) => {
		if (runtime || failure) return;
		runtime = value;
		clock.clearTimeout(timer);
		for (const port of early.splice(0)) accept(port);
	};
	const fail = (next: Failure) => {
		if (runtime || failure) return;
		failure = next;
		clock.clearTimeout(timer);
		for (const port of early.splice(0)) answer(port, next);
	};

	scope.addEventListener("connect", (event) => {
		for (const port of event.ports) {
			if (twice) answer(port, SERVED_TWICE);
			else if (runtime) accept(port);
			else if (failure) answer(port, failure);
			else if (early.length >= maxEarly) {
				answer(port, {
					code: "limit-exceeded",
					message: "Too many pages connected before the runtime was ready.",
				});
			} else early.push(port);
		}
	});

	try {
		const value = typeof source === "function" ? source() : source;
		if (value && typeof (value as Promise<RuntimeHandle>).then === "function") {
			timer = clock.setTimeout(
				() =>
					fail({
						code: "worker-startup-error",
						message: "The runtime did not finish setup in time.",
					}),
				options.setupTimeoutMs ?? SETUP_TIMEOUT_MS,
			);
			(value as Promise<RuntimeHandle>).then(ready, (error: unknown) =>
				fail(setupFailure(error)),
			);
		} else {
			ready(value as RuntimeHandle);
		}
	} catch (error) {
		fail(setupFailure(error));
	}
}

function setupFailure(error: unknown): Failure {
	return {
		code: "worker-startup-error",
		message: isSpinetabError(error)
			? error.message
			: `Runtime setup failed (${error instanceof Error ? error.name : "unknown error"}).`,
	};
}

function answer(port: MessagePort, failure: Failure): void {
	port.addEventListener("message", (event) => {
		const data = (event as MessageEvent).data as Record<string, unknown> | null;
		if (
			data &&
			typeof data === "object" &&
			data.t === "hello" &&
			typeof data.a === "string" &&
			typeof data.g === "number"
		) {
			try {
				port.postMessage({
					v: BRIDGE_VERSION,
					t: "startupError",
					a: data.a,
					g: data.g,
					code: failure.code,
					message: failure.message,
				});
			} catch {
				// The page is gone.
			}
		}
	});
	port.start();
}
