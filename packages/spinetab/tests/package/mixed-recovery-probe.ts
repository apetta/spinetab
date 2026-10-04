import { createRequire } from "node:module";
import type {
	ConnectionContext,
	RuntimeAdapter,
} from "../../src/core/adapter.ts";
import type { SpinetabClient } from "../../src/core/types.ts";

// Native loaders must see separate emitted ESM/CJS copies. A test runner's
// module transforms would otherwise hide this mixed-consumer failure.
const require = createRequire(import.meta.url);
const esm = await import("spinetab");
const cjs = require("spinetab") as typeof esm;
const { createRuntime } = await import("spinetab/runtime");
const [clientFormat, helperFormat, scenario] = process.argv.slice(2);
const api = clientFormat === "esm" ? esm : cjs;
const helper = helperFormat === "esm" ? esm : cjs;
Object.defineProperty(globalThis, "window", { value: new EventTarget() });
Object.defineProperty(globalThis, "document", {
	value: Object.assign(new EventTarget(), {
		visibilityState: "visible",
		baseURI: "https://app.test/",
	}),
});
const callbackErrors: string[] = [];
const globalErrors: string[] = [];
Object.defineProperty(globalThis, "reportError", {
	value: (error: Error) => globalErrors.push(error.message),
});
const contexts: ConnectionContext[] = [];
const adapter: RuntimeAdapter = {
	kind: "test",
	version: 1,
	connect(_spec, context) {
		contexts.push(context);
		return {
			subscribe: () => ({ unsubscribe() {} }),
			dispose() {},
		};
	},
};
const runtime = createRuntime({ adapters: [adapter] });
let client: SpinetabClient | undefined;
let stop: (() => void) | undefined;
async function until(predicate: () => boolean): Promise<void> {
	const deadline = performance.now() + 5_000;
	while (!predicate()) {
		if (performance.now() > deadline) throw Error("Probe condition timed out");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}
try {
	client = api.createSpinetab({
		scope: "a",
		sharing: "off",
		anonymous: true,
		onCallbackError: (error) => callbackErrors.push((error as Error).message),
		local: async () => ({ default: () => runtime }),
	});
	const handle = client.subscribe(
		{
			adapter: "test",
			connection: { url: "https://api.test/" },
			subscription: {},
		},
		{
			next() {},
			error(error) {
				throw error;
			},
		},
	);
	await until(() => contexts.length === 1);
	contexts[0]?.setStatus({ state: "connected" });
	await until(() => handle.status.get().connection.state === "connected");
	const keys = Object.keys(handle.status);
	const refreshes: string[] = [];
	stop = helper.reconcileOnLoss(handle, () => {
		refreshes.push(contexts.at(-1)?.scope ?? "missing");
		if (scenario === "failure") throw Error("refresh failed");
	});
	client.setScope("b");
	const early = [...refreshes];
	const pendingKeys = Object.keys(handle.status);
	await until(() => contexts.length === 2);
	contexts[1]?.setStatus({ state: "connected" });
	await until(() =>
		scenario === "failure"
			? callbackErrors.length + globalErrors.length > 0
			: handle.status.get().continuity.state === "continuous",
	);
	const symbolsAfterRecovery = Object.getOwnPropertySymbols(handle.status).map(
		String,
	);
	client.dispose();
	process.stdout.write(
		JSON.stringify({
			clientFormat,
			helperFormat,
			callbackErrors,
			globalErrors,
			early,
			refreshes,
			keys,
			pendingKeys,
			symbolsAfterRecovery,
			symbolsAfterDispose: Object.getOwnPropertySymbols(handle.status).map(
				String,
			),
		}),
	);
} finally {
	stop?.();
	client?.dispose();
	runtime.dispose();
}
