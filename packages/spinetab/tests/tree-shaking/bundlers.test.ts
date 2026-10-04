import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { rspack } from "@rspack/core";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import webpack from "webpack";
import {
	assertFresh,
	baseline,
	fixture,
	peerPattern,
	probes,
	unused,
} from "./fixture.ts";

type Bundler = "vite" | "webpack" | "rspack";
let root: string;
beforeAll(async () => {
	// Vite follows NODE_ENV, which Vitest sets to "test".
	vi.stubEnv("NODE_ENV", "production");
	root = await fixture("bundlers");
});
afterAll(() => {
	try {
		if (root) assertFresh(root);
	} finally {
		vi.unstubAllEnvs();
	}
});

async function bundle(
	bundler: Bundler,
	name: string,
	source: string,
	worker = false,
): Promise<string> {
	const input = worker
		? join(root, "node_modules/spinetab/dist/auto/worker.js")
		: join(root, `${name}.js`);
	const out = join(root, bundler, name);
	if (!worker) writeFileSync(input, source);
	const alias: Record<string, string> = worker
		? { "spinetab/worker-config": join(root, "live.worker.js") }
		: {};
	if (bundler === "vite") {
		await build({
			configFile: false,
			root,
			mode: "production",
			logLevel: "silent",
			resolve: { alias },
			build: {
				outDir: out,
				emptyOutDir: true,
				minify: true,
				rolldownOptions: {
					input,
					external: peerPattern,
					output: { entryFileNames: "bundle.js" },
				},
			},
		});
	} else {
		const options = {
			mode: "production" as const,
			context: root,
			entry: input,
			resolve: { alias },
			externals: [peerPattern],
			output: { path: out, filename: "bundle.js" },
		};
		const compiler = bundler === "webpack" ? webpack(options) : rspack(options);
		await new Promise<void>((resolve, reject) => {
			compiler.run((error, stats) =>
				compiler.close((closeError) => {
					if (error || closeError || !stats || stats.hasErrors())
						reject(
							error ??
								closeError ??
								new Error(stats?.toString({ all: false, errors: true })),
						);
					else resolve();
				}),
			);
		});
	}
	return readFileSync(join(out, "bundle.js"), "utf8");
}

describe.each<Bundler>([
	"vite",
	"webpack",
	"rspack",
])("%s production tree shaking", (bundler) => {
	it("removes unused named and bare imports of every page entry", async () => {
		const control = await bundle(bundler, "baseline", baseline);
		const code = await bundle(bundler, "unused", unused);
		expect(code).toBe(control);
		const context = createContext({ URL });
		runInContext(code, context);
		expect(context.keep).toBe("tree-shaking-witness");
	});
	for (const [name, probe] of Object.entries(probes)) {
		it(`${name}: retains working exports and removes unrelated implementations`, async () => {
			const code = await bundle(bundler, name, probe.source);
			for (const marker of probe.forbidden) expect(code).not.toContain(marker);
			const context = createContext({ URL });
			runInContext(code, context);
			expect(runInContext(probe.check, context)).toEqual(probe.result);
		});
	}
	for (const kind of ["websocket", "sse", "stream", "polling"]) {
		it(`${kind}: importing its constant prunes the adapter builder`, async () => {
			const source = `import { ${kind.toUpperCase()}_ADAPTER } from "spinetab/${kind}"; globalThis.keep = ${kind.toUpperCase()}_ADAPTER;`;
			const code = await bundle(bundler, `${kind}-constant`, source);
			const control = await bundle(
				bundler,
				`${kind}-literal`,
				`globalThis.keep = ${JSON.stringify(kind)};`,
			);
			expect(code).toBe(control);
		});
	}
	for (const entry of [
		"spinetab",
		"spinetab/react",
		"spinetab/vue",
		"spinetab/svelte",
		"spinetab/solid",
	]) {
		it(`${entry}: a single snapshot excludes bindings, peers and other snapshots`, async () => {
			const code = await bundle(
				bundler,
				`${entry.replace("/", "-")}-status`,
				`import { SERVER_STATUS } from ${JSON.stringify(entry)}; globalThis.keep = SERVER_STATUS;`,
			);
			expect(code.match(/Object\.freeze\(/g)).toHaveLength(1);
			const context = createContext({ URL });
			runInContext(code, context);
			expect(
				runInContext(
					"[Object.isFrozen(keep), keep.mode, keep.reason]",
					context,
				),
			).toEqual([true, "inactive", "server"]);
		});
	}
	it("retains the worker entry's registration when its exports are unused", async () => {
		writeFileSync(
			join(root, "live.worker.js"),
			'import { defineWorker } from "spinetab/worker"; import { pollingAdapter } from "spinetab/polling/runtime"; export default defineWorker(() => [pollingAdapter()]);',
		);
		const code = await bundle(
			bundler,
			"worker",
			'import "spinetab/auto/worker";',
			true,
		);
		const context = createContext({
			URL,
			setTimeout: () => 1,
			clearTimeout: () => {},
			setInterval: () => 1,
			clearInterval: () => {},
			queueMicrotask,
			performance: { now: () => 0 },
			crypto: { randomUUID: () => "tree-shaking-worker" },
			location: { origin: "https://example.com" },
		});
		runInContext(
			'globalThis.connects = 0; globalThis.SharedWorkerGlobalScope = class { static [Symbol.hasInstance]() { return true; } }; globalThis.addEventListener = (type) => { if (type === "connect") connects++; };',
			context,
		);
		runInContext(code, context);
		expect(context.connects).toBe(1);
		expect(code).toContain("polling");
		expect(code).not.toContain("graphql-ws");
	});
});
