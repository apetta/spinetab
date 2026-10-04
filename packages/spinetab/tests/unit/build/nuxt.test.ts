import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import spinetabNuxt, { type NuxtManifest } from "../../../src/build/nuxt.ts";
import type { SpinetabVitePlugin } from "../../../src/build/vite-plugin.ts";
import { cleanTrees, installSpinetab, makeTree } from "./tree.ts";

afterEach(cleanTrees);

function setup() {
	const root = makeTree();
	const installed = installSpinetab(root);
	type Config = { plugins?: unknown[] };
	const listeners: {
		vite?: (config: Config, env: { isClient: boolean }) => void;
		manifest?: (manifest: NuxtManifest) => void;
	} = {};
	spinetabNuxt(
		{ adapters: ["sse"] },
		{
			options: { rootDir: root, app: { buildAssetsDir: "/custom/" } },
			hook(name, listener) {
				if (name === "vite:extendConfig")
					listeners.vite = listener as NonNullable<typeof listeners.vite>;
				else
					listeners.manifest = listener as NonNullable<
						typeof listeners.manifest
					>;
			},
		},
	);
	const client: Config = { plugins: [{ name: "existing" }] };
	listeners.vite?.(client, { isClient: true });
	const plugin = client.plugins?.[1] as SpinetabVitePlugin;
	return { root, installed, listeners, plugin, client };
}

describe("spinetab/nuxt", () => {
	it("adds the Vite plugin only to the client using Nuxt's root and adapter options", () => {
		const { installed, listeners, plugin, client } = setup();
		const server = { plugins: [{ name: "existing" }] };
		listeners.vite?.(server, { isClient: false });
		expect(server.plugins).toEqual([{ name: "existing" }]);
		expect(client.plugins).toHaveLength(2);
		expect(
			plugin.config({ root: "/elsewhere" }, { command: "build" }).optimizeDeps
				.include,
		).toEqual(["spinetab/worker", "spinetab/sse/runtime"]);
		expect(plugin.resolveId("spinetab/wiring")).toBe(
			join(installed, "dist/auto/wiring.js"),
		);
	});

	it("suppresses only Spinetab's emitted worker and lazy runtime hints, with custom output names", () => {
		const { installed, listeners, plugin } = setup();
		const [worker] = plugin.config({}, { command: "build" }).worker.plugins();
		const facadeModuleId = join(installed, "dist/auto/worker.js");
		worker?.generateBundle?.(
			{},
			{
				ours: {
					type: "chunk",
					fileName: "custom/live-channel.js",
					isEntry: true,
					facadeModuleId: `${facadeModuleId}?worker_file&type=module`,
				},
				other: {
					type: "chunk",
					fileName: "worker-other.js",
					isEntry: true,
					facadeModuleId: "/app/other.worker.ts",
				},
			},
		);
		plugin.generateBundle?.(
			{},
			{
				ours: {
					type: "chunk",
					fileName: "custom/chunks/lazy-runtime.js",
					facadeModuleId,
				},
				other: {
					type: "chunk",
					fileName: "worker-looking-name.js",
					facadeModuleId: "/app/page.ts",
				},
			},
		);
		const manifest: NuxtManifest = {
			entry: {
				file: "entry.js",
				dynamicImports: ["runtime", "route", "unrelated"],
			},
			worker: { file: "live-channel.js", preload: true, prefetch: true },
			runtime: { file: "chunks/lazy-runtime.js" },
			route: { file: "page.js", preload: true, prefetch: true },
			unrelated: { file: "worker-looking-name.js" },
			otherWorker: { file: "worker-other.js", preload: true, prefetch: true },
		};
		listeners.manifest?.(manifest);
		expect(manifest.entry?.dynamicImports).toEqual(["route", "unrelated"]);
		expect(manifest.worker).toEqual({
			file: "live-channel.js",
			preload: false,
			prefetch: false,
		});
		expect(manifest.route).toEqual({
			file: "page.js",
			preload: true,
			prefetch: true,
		});
		expect(manifest.otherWorker).toEqual({
			file: "worker-other.js",
			preload: true,
			prefetch: true,
		});
		expect(manifest.runtime).toEqual({ file: "chunks/lazy-runtime.js" });
		// A later build without these resources cannot suppress an old filename.
		plugin.config({}, { command: "build" });
		const rebuilt: NuxtManifest = {
			worker: { file: "live-channel.js", preload: true },
		};
		listeners.manifest?.(rebuilt);
		expect(rebuilt.worker?.preload).toBe(true);
	});
});
