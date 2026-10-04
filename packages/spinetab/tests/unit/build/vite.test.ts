import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	devNameForGenerated,
	generateWorker,
} from "../../../src/build/generate.ts";
import {
	buildMessage,
	SpinetabBuildError,
} from "../../../src/build/messages.ts";
import { spinetab } from "../../../src/build/vite.ts";
import type { ViteDevServerLike } from "../../../src/build/vite-plugin.ts";
import { cleanTrees, installPackage, makeTree, writeTree } from "./tree.ts";

afterEach(cleanTrees);

const SHIPPED_WIRING = [
	"const wiring = {",
	'\tworker: () => new SharedWorker(new URL("./worker.js", import.meta.url), { type: "module" }),',
	'\tlocal: () => import("./worker.js")',
	"};",
	"export { wiring };",
	"",
].join("\n");

function project(files: Record<string, string>): string {
	return makeTree({
		"node_modules/spinetab/package.json": '{"name":"spinetab"}',
		"node_modules/spinetab/dist/auto/wiring.js": SHIPPED_WIRING,
		"node_modules/spinetab/dist/worker-config.js":
			"export default function () {}",
		...files,
	});
}

const pkg = (root: string, ...path: string[]) =>
	join(root, "node_modules", "spinetab", "dist", ...path);

function buildContext(ids: string[]) {
	return {
		getModuleIds: () => ids[Symbol.iterator](),
		// Vite's `this.error` takes an Error: a string report makes Rolldown
		// fold the caller's stack (absolute paths) into the message.
		error(error: Error): never {
			throw error;
		},
	};
}

describe("spinetab/vite", () => {
	it("contributes exactly the optimiser and worker plugin keys", () => {
		const root = project({
			"src/main.ts":
				'import { polling } from "spinetab/polling";\nimport { sse } from "spinetab/sse";',
		});
		const plugin = spinetab();
		expect(plugin).toMatchObject({ name: "spinetab", enforce: "pre" });
		const contributed = plugin.config({ root }, { command: "build" });
		expect(Object.keys(contributed).sort()).toEqual(["optimizeDeps", "worker"]);
		expect(contributed.optimizeDeps).toEqual({
			exclude: ["spinetab/wiring"],
			include: [
				"spinetab/worker",
				"spinetab/polling/runtime",
				"spinetab/sse/runtime",
			],
		});
		const [worker] = contributed.worker.plugins();
		expect(worker).toMatchObject({ name: "spinetab:worker", enforce: "pre" });
	});

	it("applies to client environments only", () => {
		const plugin = spinetab();
		expect(plugin.applyToEnvironment({ config: { consumer: "client" } })).toBe(
			true,
		);
		expect(plugin.applyToEnvironment({ config: { consumer: "server" } })).toBe(
			false,
		);
	});

	it("redirects exactly the two seams at L3, path-shaped", () => {
		const root = project({
			"src/main.ts": 'import { polling } from "spinetab/polling";',
		});
		const plugin = spinetab();
		const [worker] = plugin
			.config({ root }, { command: "build" })
			.worker.plugins();
		for (const hooks of [plugin, worker]) {
			expect(hooks?.resolveId("spinetab/wiring")).toBe(
				pkg(root, "auto", "wiring.js"),
			);
			expect(hooks?.resolveId("spinetab/worker-config")).toBe(
				pkg(root, "worker-config.js"),
			);
			expect(hooks?.resolveId("spinetab/wiring/x")).toBeUndefined();
			expect(hooks?.resolveId("spinetab")).toBeUndefined();
			expect(hooks?.resolveId("\0spinetab/wiring")).toBeUndefined();
		}
		const text = generateWorker(["polling"]);
		const stub = pkg(root, "worker-config.js");
		expect(plugin.load(stub)).toBe(text);
		expect(worker?.load(`${stub}?worker_file&type=module`)).toBe(text);
		expect(plugin.load(pkg(root, "index.js"))).toBeUndefined();
	});

	it("points the worker-config seam at the developer file at L2", () => {
		const root = project({
			"src/spinetab.worker.ts": "export default defineWorker(() => []);",
		});
		const plugin = spinetab();
		const contributed = plugin.config({ root }, { command: "build" });
		expect(contributed.optimizeDeps.include).toEqual(["spinetab/worker"]);
		expect(plugin.resolveId("spinetab/worker-config")).toBe(
			join(root, "src", "spinetab.worker.ts"),
		);
		expect(plugin.load(pkg(root, "worker-config.js"))).toBeUndefined();
	});

	it("names the development worker in serve only", () => {
		const root = project({
			"src/main.ts": 'import { polling } from "spinetab/polling";',
		});
		const wiring = pkg(root, "auto", "wiring.js");
		const build = spinetab();
		build.config({ root }, { command: "build" });
		expect(build.transform(SHIPPED_WIRING, wiring)).toBeUndefined();
		const serve = spinetab();
		serve.config({ root }, { command: "serve" });
		const name = devNameForGenerated(generateWorker(["polling"]));
		expect(serve.transform(SHIPPED_WIRING, wiring)).toBe(
			SHIPPED_WIRING.replace(
				'{ type: "module" }',
				`{ type: "module", name: "${name}" }`,
			),
		);
		expect(serve.transform("x", join(root, "src", "main.ts"))).toBeUndefined();
	});

	it("fails on an unknown option key in build and serve", () => {
		const root = project({ "src/main.ts": 'import "spinetab/sse";' });
		for (const command of ["build", "serve"]) {
			const plugin = spinetab({ adapter: ["sse"] } as never);
			expect(() => plugin.config({ root }, { command })).toThrow(
				new SpinetabBuildError({ code: "unknown-option" }),
			);
		}
	});

	it("fails a production build with no adapters, warns in serve", () => {
		const root = project({ "src/main.ts": "export {};" });
		expect(() => spinetab().config({ root }, { command: "build" })).toThrow(
			buildMessage({ code: "no-adapters" }),
		);
		const plugin = spinetab();
		plugin.config({ root }, { command: "serve" });
		const warn = vi.fn();
		plugin.configResolved({ logger: { warn } });
		expect(warn).toHaveBeenCalledWith(buildMessage({ code: "no-adapters" }));
	});

	it("runs the graph check and the wiring self-check at buildEnd", () => {
		const root = project({
			"src/main.ts": 'import { polling } from "spinetab/polling";',
		});
		const plugin = spinetab({ adapters: ["polling"] });
		plugin.config({ root }, { command: "build" });
		const importer = join(root, "src", "main.ts");
		plugin.resolveId("spinetab/polling", importer);
		plugin.resolveId("spinetab/sse", join(root, "node_modules", "lib", "a.js"));
		expect(() => plugin.buildEnd.call(buildContext([]))).not.toThrow();
		plugin.resolveId("spinetab/sse", importer);
		expect(() => plugin.buildEnd.call(buildContext([]))).toThrow(
			buildMessage({ code: "adapter-not-generated", entry: "sse" }),
		);
		const reported = (() => {
			try {
				plugin.buildEnd.call(buildContext([]));
			} catch (error) {
				return error;
			}
		})();
		expect(reported).toBeInstanceOf(SpinetabBuildError);
		expect(String((reported as Error).stack)).not.toContain(root);
		expect(String((reported as Error).stack)).not.toMatch(/\bat\s/);
		const clean = spinetab({ adapters: ["polling"] });
		clean.config({ root }, { command: "build" });
		expect(() =>
			clean.buildEnd.call(buildContext([pkg(root, "wiring.js")])),
		).toThrow(buildMessage({ code: "wiring-not-applied" }));
	});

	it("generates a polling-only worker for root's commented and quoted imports", () => {
		const polling = 'import { polling } from "spinetab/polling";';
		for (const [name, main] of [
			["clean", polling],
			[
				"comment",
				`${polling}\n// import { socketIo } from "spinetab/socket-io";`,
			],
			[
				"example",
				`${polling}\nconst example = 'import { socketIo } from "spinetab/socket-io";';`,
			],
		]) {
			const root = project({ "main.ts": `${main}\n` });
			installPackage(root, "socket.io-client");
			const plugin = spinetab();
			plugin.config({ root }, { command: "build" });
			const warn = vi.fn();
			plugin.configResolved({ logger: { warn } });
			expect(plugin.load(pkg(root, "worker-config.js")), name).toBe(
				generateWorker(["polling"]),
			);
			expect(warn, name).not.toHaveBeenCalled();
		}
	});

	it("a commented import neither masks the empty set nor warns missing-peer", () => {
		const commented = project({
			"src/main.ts":
				'// import { polling } from "spinetab/polling";\nexport {};',
		});
		expect(() =>
			spinetab().config({ root: commented }, { command: "build" }),
		).toThrow(buildMessage({ code: "no-adapters" }));
		const root = project({
			"src/main.ts": [
				'import { polling } from "spinetab/polling";',
				'// import { socketIo } from "spinetab/socket-io";',
			].join("\n"),
		});
		for (const command of ["build", "serve"]) {
			const plugin = spinetab();
			plugin.config({ root }, { command });
			const warn = vi.fn();
			plugin.configResolved({ logger: { warn } });
			expect(warn, command).not.toHaveBeenCalled();
		}
	});

	it("scan-fallback reaches the logger in build and serve", () => {
		const root = project({
			"src/main.ts": 'import { polling } from "spinetab/polling";',
			"src/broken.ts": 'const s = "spinetab/sse"; /* never closed\n',
		});
		for (const command of ["build", "serve"]) {
			const plugin = spinetab();
			plugin.config({ root }, { command });
			const warn = vi.fn();
			plugin.configResolved({ logger: { warn } });
			expect(warn.mock.calls, command).toEqual([
				[buildMessage({ code: "scan-fallback", files: ["src/broken.ts"] })],
			]);
		}
	});

	it("adapters [trpc-ws] passes buildEnd with a commented spinetabSseLink import", () => {
		const root = project({
			"src/client.ts": [
				'import { spinetabWsLink } from "spinetab/trpc";',
				'// import { spinetabSseLink } from "spinetab/trpc";',
			].join("\n"),
		});
		installPackage(root, "@trpc/client");
		const plugin = spinetab({ adapters: ["trpc-ws"] });
		plugin.config({ root }, { command: "build" });
		plugin.resolveId("spinetab/trpc", join(root, "src", "client.ts"));
		expect(() => plugin.buildEnd.call(buildContext([]))).not.toThrow();
	});

	it("buildEnd ignores an importer of inline types only", () => {
		const root = project({
			"src/main.ts": 'import { polling } from "spinetab/polling";',
			// verbatimModuleSyntax keeps `import {} from "spinetab/sse"` here.
			"src/describe.ts":
				'import { type SseSource } from "spinetab/sse";\nexport type D = SseSource;',
		});
		const plugin = spinetab();
		plugin.config({ root }, { command: "build" });
		expect(plugin.load(pkg(root, "worker-config.js"))).toBe(
			generateWorker(["polling"]),
		);
		plugin.resolveId("spinetab/polling", join(root, "src", "main.ts"));
		plugin.resolveId("spinetab/sse", join(root, "src", "describe.ts"));
		expect(() => plugin.buildEnd.call(buildContext([]))).not.toThrow();
	});

	it("regenerates on watcher events and reloads every tab", () => {
		const root = project({
			"src/main.ts":
				'import { polling } from "spinetab/polling";\nimport { sse } from "spinetab/sse";',
		});
		const plugin = spinetab();
		plugin.config({ root }, { command: "serve" });
		const listeners: ((event: string, file: string) => void)[] = [];
		const modules = new Map<string, object>();
		const invalidateModule = vi.fn();
		const send = vi.fn();
		const warn = vi.fn();
		const restart = vi.fn(async () => {});
		const server: ViteDevServerLike = {
			watcher: {
				on: (_event, listener) => listeners.push(listener),
			},
			environments: {
				client: {
					moduleGraph: {
						getModuleById: (id) => modules.get(id),
						invalidateModule,
					},
					hot: { send },
				},
			},
			config: { logger: { warn } },
			restart,
		};
		plugin.configureServer(server);
		const emit = (event: string, file: string) => {
			for (const listener of listeners) listener(event, file);
		};
		const stub = pkg(root, "worker-config.js");
		modules.set(stub, { id: stub });

		// An unrelated edit keeps the set: nothing happens.
		writeTree(root, { "src/other.ts": "export const x = 1;" });
		emit("add", join(root, "src", "other.ts"));
		expect(send).not.toHaveBeenCalled();

		// Dropping sse changes the set within the optimised entries: reload.
		writeTree(root, {
			"src/main.ts": 'import { polling } from "spinetab/polling";',
		});
		emit("change", join(root, "src", "main.ts"));
		expect(invalidateModule).toHaveBeenCalledTimes(1);
		expect(send).toHaveBeenCalledWith({ type: "full-reload" });
		expect(plugin.load(stub)).toBe(generateWorker(["polling"]));

		// A new runtime entry needs the optimiser: restart instead.
		writeTree(root, {
			"src/feed.ts": 'import { ws } from "spinetab/websocket";',
		});
		emit("add", join(root, "src", "feed.ts"));
		expect(restart).toHaveBeenCalledTimes(1);

		// Creating the conventional file asks for a restart (level switch).
		writeTree(root, { "src/spinetab.worker.ts": "export default 1;" });
		emit("add", join(root, "src", "spinetab.worker.ts"));
		expect(warn).toHaveBeenCalledWith(
			buildMessage({
				code: "restart-required",
				files: ["src/spinetab.worker.ts"],
			}),
		);
		const message = String(warn.mock.calls.at(-1)?.[0]);
		expect(message).not.toContain(root);
	});

	it("leaves a middleware server healthy until its framework restarts for a new adapter", () => {
		const root = project({
			"src/main.ts": 'import { polling } from "spinetab/polling";',
		});
		const plugin = spinetab();
		plugin.config({ root }, { command: "serve" });
		let watch: ((event: string, file: string) => void) | undefined;
		const warn = vi.fn();
		const restart = vi.fn(async () => {});
		const send = vi.fn();
		const invalidateModule = vi.fn();
		plugin.configureServer({
			watcher: {
				on: (_event, listener) => {
					watch = listener;
				},
			},
			environments: {
				client: {
					moduleGraph: { getModuleById: () => ({}), invalidateModule },
					hot: { send },
				},
			},
			config: { logger: { warn }, server: { middlewareMode: true } },
			restart,
		});
		const before = plugin.load(pkg(root, "worker-config.js"));
		writeTree(root, { "src/feed.ts": 'import { sse } from "spinetab/sse";' });
		watch?.("add", join(root, "src/feed.ts"));
		expect(restart).not.toHaveBeenCalled();
		expect(send).not.toHaveBeenCalled();
		expect(invalidateModule).not.toHaveBeenCalled();
		expect(plugin.load(pkg(root, "worker-config.js"))).toBe(before);
		expect(warn.mock.calls).toEqual([
			[
				"[spinetab] adapter-restart-required: a newly imported adapter needs dependency preparation; restart your framework's dev server.\n  src/feed.ts",
			],
		]);
		// The framework's fresh plugin sees the added runtime after restart.
		const fresh = spinetab();
		fresh.config({ root }, { command: "serve" });
		expect(fresh.load(pkg(root, "worker-config.js"))).toBe(
			generateWorker(["polling", "sse"]),
		);
	});
});
