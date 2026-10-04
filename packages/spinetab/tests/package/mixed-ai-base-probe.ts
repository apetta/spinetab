import { createRequire } from "node:module";
import type { RuntimeAdapter } from "../../src/core/adapter.ts";

// Use native loaders and the public entries so separate ESM/CJS module
// instances cannot silently lose the client's private endpoint metadata.
const require = createRequire(import.meta.url);
const esm = await import("spinetab");
const cjs = require("spinetab") as typeof esm;
const aiEsm = await import("spinetab/ai-sdk");
const aiCjs = require("spinetab/ai-sdk") as typeof aiEsm;
const { createRuntime } = await import("spinetab/runtime");
const [clientFormat, helperFormat] = process.argv.slice(2);
const api = clientFormat === "esm" ? esm : cjs;
const helper = helperFormat === "esm" ? aiEsm : aiCjs;
Object.defineProperty(globalThis, "window", { value: new EventTarget() });
Object.defineProperty(globalThis, "document", {
	value: Object.assign(new EventTarget(), {
		visibilityState: "visible",
		baseURI: "https://app.test/",
	}),
});
const specs: unknown[] = [];
const adapter: RuntimeAdapter = {
	kind: "ai-sdk",
	version: 1,
	connect(spec, context) {
		specs.push(spec);
		context.setStatus({ state: "connected" });
		return { subscribe: () => ({ unsubscribe() {} }), dispose() {} };
	},
};
const runtime = createRuntime({ adapters: [adapter] });
const client = api.createSpinetab({
	scope: "a",
	sharing: "off",
	anonymous: true,
	baseUrl: "https://custom.test/app/",
	local: async () => ({ default: () => runtime }),
});
const transport = new helper.SpinetabChatTransport({ client, api: "chat" });
const stop = transport.observe("chat-1");
try {
	const deadline = performance.now() + 5_000;
	while (specs.length === 0) {
		if (performance.now() > deadline) throw Error("Probe condition timed out");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	process.stdout.write(JSON.stringify(specs[0]));
} finally {
	stop();
	client.dispose();
	runtime.dispose();
}
