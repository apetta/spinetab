import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { spinetab } from "../../../src/build/astro.ts";
import { buildMessage } from "../../../src/build/messages.ts";
import type { SpinetabVitePlugin } from "../../../src/build/vite-plugin.ts";
import { cleanTrees, makeTree } from "./tree.ts";

afterEach(cleanTrees);

const SHIPPED_WIRING =
	'const wiring = { worker: () => new SharedWorker(new URL("./worker.js", import.meta.url), { type: "module" }) };\n';

function project(files: Record<string, string>): string {
	return makeTree({
		"node_modules/spinetab/package.json": '{"name":"spinetab"}',
		"node_modules/spinetab/dist/auto/wiring.js": SHIPPED_WIRING,
		"node_modules/spinetab/dist/worker-config.js":
			"export default function () {}",
		...files,
	});
}

/** Runs `astro:config:setup` and returns what the integration contributed. */
function setup(
	integration: ReturnType<typeof spinetab>,
	root: string,
	command: string,
) {
	const updateConfig = vi.fn();
	integration.hooks["astro:config:setup"]({
		// Astro's `config.root` is a directory URL with a trailing slash.
		config: { root: pathToFileURL(`${root}/`) },
		command,
		updateConfig,
	});
	expect(updateConfig).toHaveBeenCalledTimes(1);
	const [contributed] = updateConfig.mock.calls[0] as [
		{ vite: { plugins: SpinetabVitePlugin[] } },
	];
	return contributed;
}

describe("spinetab/astro", () => {
	it("is one integration with one hook", () => {
		const integration = spinetab();
		expect(integration.name).toBe("spinetab");
		expect(Object.keys(integration.hooks)).toEqual(["astro:config:setup"]);
	});

	it("contributes exactly one Vite plugin and nothing else", () => {
		const root = project({
			"src/pages/index.astro":
				'---\n---\n<script>import { polling } from "spinetab/polling";</script>',
		});
		const contributed = setup(spinetab(), root, "build");
		expect(Object.keys(contributed)).toEqual(["vite"]);
		expect(Object.keys(contributed.vite)).toEqual(["plugins"]);
		const [plugin, ...rest] = contributed.vite.plugins;
		expect(rest).toEqual([]);
		expect(plugin).toMatchObject({ name: "spinetab", enforce: "pre" });
		// The project is Astro's root, not Vite's own `root` or the cwd.
		const vite = plugin?.config({ root: "/elsewhere" }, { command: "build" });
		expect(vite).toMatchObject({
			optimizeDeps: {
				exclude: ["spinetab/wiring"],
				include: ["spinetab/worker", "spinetab/polling/runtime"],
			},
		});
		expect(plugin?.resolveId("spinetab/wiring")).toBe(
			join(root, "node_modules", "spinetab", "dist", "auto", "wiring.js"),
		);
	});

	it("passes the plugin options through", () => {
		const root = project({});
		const [plugin] = setup(spinetab({ adapters: ["sse"] }), root, "build").vite
			.plugins;
		expect(
			plugin?.config({}, { command: "build" }).optimizeDeps.include,
		).toEqual(["spinetab/worker", "spinetab/sse/runtime"]);
	});

	it("fails on an unknown option key in dev and build", () => {
		const root = project({ "src/main.ts": 'import "spinetab/sse";' });
		for (const command of ["dev", "build"]) {
			const [plugin] = setup(
				spinetab({ adapter: ["sse"] } as never),
				root,
				command,
			).vite.plugins;
			expect(() => plugin?.config({}, { command: "build" })).toThrow(
				buildMessage({ code: "unknown-option" }),
			);
		}
	});

	it("only astro build is a production build: sync, check and preview warn", () => {
		// The integration is added before any source imports exist. `astro
		// sync` (also run by `astro check`) and `astro preview` set it up
		// with command "sync" or "preview"; neither writes a worker.
		const root = project({
			"src/pages/index.astro": "<h1>No live data yet</h1>",
		});
		for (const command of ["sync", "preview"]) {
			const [plugin] = setup(spinetab(), root, command).vite.plugins;
			const warnings: string[] = [];
			expect(
				() => plugin?.config({}, { command: "serve" }),
				command,
			).not.toThrow();
			plugin?.configResolved({ logger: { warn: (m) => warnings.push(m) } });
			expect(warnings, command).toEqual([
				buildMessage({ code: "no-adapters" }),
			]);
		}
		// `astro build` still fails an empty set.
		const [built] = setup(spinetab(), root, "build").vite.plugins;
		expect(() => built?.config({}, { command: "build" })).toThrow(
			buildMessage({ code: "no-adapters" }),
		);
	});

	it("takes development from Astro's command, not Vite's", () => {
		const root = project({ "src/main.ts": "export {};" });
		// `astro build`: an empty set fails even when Vite reports `serve`.
		const [built] = setup(spinetab(), root, "build").vite.plugins;
		expect(() => built?.config({}, { command: "serve" })).toThrow(
			buildMessage({ code: "no-adapters" }),
		);
		// `astro dev`: a warning, and the development worker name.
		const [dev] = setup(spinetab({ adapters: ["polling"] }), root, "dev").vite
			.plugins;
		dev?.config({}, { command: "build" });
		const wiring = join(
			root,
			"node_modules",
			"spinetab",
			"dist",
			"auto",
			"wiring.js",
		);
		expect(dev?.transform(SHIPPED_WIRING, wiring)).toMatch(
			/\{ type: "module", name: "spinetab-[0-9a-f]{12}" \}/,
		);
	});
});
