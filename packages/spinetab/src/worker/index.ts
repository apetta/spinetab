// SharedWorker host entry (`spinetab/worker`). Importing it registers nothing;
// the application's worker file calls `defineWorker` (or `serveSharedWorker`)
// explicitly, before any top-level await, so the first page's `connect` is
// never missed.

import { SpinetabError } from "../core/errors.ts";
import {
	type ConnectScope,
	isSharedWorkerScope,
	type RuntimeSource,
	type ServeOptions,
	serve,
} from "../core/host.ts";
import {
	type AnyRuntimeAdapter,
	createRuntime,
	type RuntimeOptions,
} from "../core/runtime.ts";
import type { RuntimeHandle, RuntimeLimits } from "../core/types.ts";

export type { RuntimeSource, ServeOptions };

export interface DefineWorkerOptions {
	limits?: Partial<RuntimeLimits>;
	diagnostics?: RuntimeOptions["diagnostics"];
	/**
	 * Exact `https:` origins, besides the worker's own, that may receive
	 * provider credentials. Only worker code, or build configuration
	 * compiled into the worker by the Spinetab plugin, can widen the audience.
	 */
	credentialOrigins?: readonly string[];
	/** SharedWorker only: how long async setup may take (default 10 s). */
	setupTimeoutMs?: number;
	/** SharedWorker only: pages buffered before the runtime is ready (default 64). */
	maxEarlyPorts?: number;
}

/**
 * One worker file for both realms. Export the result as the module's
 * default: in a SharedWorker global this call also serves the runtime,
 * synchronously, to every page that connects; anywhere else it registers
 * nothing. The client's `local: () => import("./live.worker")` then calls the
 * default export to build an in-page runtime with the same adapters.
 *
 * `adapters` is a function so that every runtime gets its own adapter
 * instances. Returns the local-runtime factory.
 */
export function defineWorker(
	adapters: () => readonly AnyRuntimeAdapter[],
	options: DefineWorkerOptions = {},
): () => RuntimeHandle {
	if (typeof adapters !== "function") {
		throw new SpinetabError(
			"unsupported-option",
			"defineWorker.adapters must be a function returning the adapter list, for example () => [pollingAdapter()].",
			{ detail: { path: "defineWorker.adapters" } },
		);
	}
	const { limits, diagnostics, credentialOrigins } = options;
	const factory = (): RuntimeHandle =>
		createRuntime({
			adapters: adapters(),
			...(limits === undefined ? {} : { limits }),
			...(diagnostics === undefined ? {} : { diagnostics }),
			...(credentialOrigins === undefined ? {} : { credentialOrigins }),
		});
	if (isSharedWorkerScope(globalThis)) {
		serve(globalThis as unknown as ConnectScope, factory, {
			...(options.setupTimeoutMs === undefined
				? {}
				: { setupTimeoutMs: options.setupTimeoutMs }),
			...(options.maxEarlyPorts === undefined
				? {}
				: { maxEarlyPorts: options.maxEarlyPorts }),
		});
	}
	return factory;
}

/**
 * Serve a runtime to every page that connects to this SharedWorker: the
 * escape hatch behind `defineWorker`, for async setup and custom runtimes.
 * Accepts a runtime, a promise of one, or a factory (recommended: setup errors
 * thrown by the factory are reported to pages as `worker-startup-error`
 * instead of leaving them to time out). Early ports are buffered (64) and
 * answered with `startupError` if setup has not finished within 10 s. Serving
 * twice in one worker (for example with `defineWorker` too) turns every page
 * away with `worker-startup-error`.
 */
export function serveSharedWorker(
	runtime: RuntimeSource,
	options?: Omit<ServeOptions, "clock">,
): void {
	serve(globalThis as unknown as ConnectScope, runtime, options);
}
