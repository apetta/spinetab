import { SpinetabError } from "./errors.ts";
import type { LocalRuntimeModule, RuntimeHandle } from "./types.ts";

/**
 * Local mode hosts the same runtime behind an in-page `MessageChannel`, so
 * cloning, envelope validation, ordering and bounds match shared mode. The cost is one structured clone per delivery.
 */
export interface LocalRuntime {
	readonly runtime: RuntimeHandle;
	connect(): MessagePort;
	dispose(): void;
}

export function createLocalRuntime(
	runtime: RuntimeHandle,
	createChannel: () => MessageChannel = () => new MessageChannel(),
): LocalRuntime {
	return {
		runtime,
		connect() {
			const channel = createChannel();
			runtime.accept(channel.port2);
			return channel.port1;
		},
		dispose() {
			runtime.dispose();
		},
	};
}

/** Resolve the application's lazily imported local-runtime module. */
export function runtimeFromModule(module: unknown): RuntimeHandle {
	const record = module as Partial<Record<"default" | "runtime", unknown>>;
	const factory =
		typeof record?.default === "function" ? record.default : record?.runtime;
	if (typeof factory !== "function") {
		throw new SpinetabError(
			"runtime-unavailable",
			"The local runtime module must export a default function (or `runtime`) returning createRuntime(...).",
		);
	}
	const runtime = (factory as () => unknown)();
	if (
		!runtime ||
		typeof (runtime as RuntimeHandle).accept !== "function" ||
		typeof (runtime as RuntimeHandle).dispose !== "function"
	) {
		throw new SpinetabError(
			"runtime-unavailable",
			"The local runtime factory did not return a runtime.",
		);
	}
	return runtime as RuntimeHandle;
}

export type { LocalRuntimeModule };
