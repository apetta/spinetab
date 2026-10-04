import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	devNameForGenerated,
	devNameForWorkerFile,
	GENERATOR_VERSION,
	generateWorker,
} from "../../../src/build/generate.ts";
import spinetabLoader, {
	type SpinetabLoaderContext,
} from "../../../src/build/loader.ts";
import { buildMessage } from "../../../src/build/messages.ts";
import type { SpinetabLoaderOptions } from "../../../src/build/types.ts";
import { cleanTrees, makeTree } from "./tree.ts";

afterEach(cleanTrees);

const SHIPPED =
	'worker: () => new SharedWorker(new URL("./worker.js", import.meta.url), { type: "module" }),';

function run(
	options: Partial<SpinetabLoaderOptions>,
	source = "export default function () {}",
	rootContext?: string,
) {
	const calls = {
		context: [] as string[],
		dependency: [] as string[],
		cacheable: [] as (boolean | undefined)[],
		warnings: [] as string[],
	};
	const context: SpinetabLoaderContext = {
		getOptions: () => ({
			adapters: null,
			credentialOrigins: [],
			roots: [],
			dev: false,
			version: GENERATOR_VERSION,
			...options,
		}),
		addContextDependency: (path) => calls.context.push(path),
		addDependency: (path) => calls.dependency.push(path),
		cacheable: (flag) => calls.cacheable.push(flag),
		emitWarning: (warning) => calls.warnings.push(warning.message),
		...(rootContext === undefined ? {} : { rootContext }),
	};
	const output = spinetabLoader.call(context, source);
	return { output, calls };
}

describe("spinetab/loader, role worker", () => {
	it("ignores its input and returns the generated worker", () => {
		const { output, calls } = run({
			role: "worker",
			adapters: ["sse", "polling"],
			credentialOrigins: ["https://api.example.com"],
		});
		expect(output).toBe(
			generateWorker(["polling", "sse"], ["https://api.example.com"]),
		);
		expect(calls.cacheable).toEqual([false]);
		expect(calls.context).toEqual([]);
	});

	it("scans the roots when adapters is null and depends on them", () => {
		const root = makeTree({
			"src/a.ts": 'import { sse } from "spinetab/sse";',
		});
		const { output, calls } = run({ role: "worker", roots: [root] }, "", root);
		expect(output).toBe(generateWorker(["sse"]));
		expect(calls.context).toEqual([root]);
		expect(output).not.toContain(root);
	});

	it("fails production on an empty scan and warns once in development", () => {
		const root = makeTree({ "src/a.ts": "export {};" });
		expect(() => run({ role: "worker", roots: [root] })).toThrow(
			buildMessage({ code: "no-adapters" }),
		);
		const first = run({ role: "worker", roots: [root], dev: true });
		expect(first.output).toBe(generateWorker([]));
		const second = run({ role: "worker", roots: [root], dev: true });
		expect([...first.calls.warnings, ...second.calls.warnings]).toEqual([
			buildMessage({ code: "no-adapters" }),
		]);
	});

	it("fails production on a peer-only scan with missing-peer; development warns it alone", () => {
		const root = makeTree({
			"src/a.ts": 'import { graphqlWs } from "spinetab/graphql-ws";',
		});
		const missing = buildMessage({
			code: "missing-peer",
			kind: "graphql-ws",
			peer: "graphql-ws",
		});
		expect(() => run({ role: "worker", roots: [root] })).toThrow(missing);
		const { output, calls } = run({ role: "worker", roots: [root], dev: true });
		expect(output).toBe(generateWorker([]));
		expect(calls.warnings).toEqual([missing]);
	});

	it("warns scan-fallback with the project-relative path in both modes", () => {
		const root = makeTree({
			"src/a.ts": 'import { polling } from "spinetab/polling";',
			"src/broken.ts": 'const s = "spinetab/sse"; /* never closed\n',
		});
		const fallback = buildMessage({
			code: "scan-fallback",
			files: ["src/broken.ts"],
		});
		// Development first: it warns once per process, and a production run
		// also records the message.
		for (const dev of [true, false]) {
			const { output, calls } = run({ role: "worker", roots: [root], dev });
			expect(output).toBe(generateWorker(["polling", "sse"]));
			expect(calls.warnings).toEqual([fallback]);
			expect(calls.warnings.join("\n")).not.toContain(root);
		}
	});

	it("skips options.excludes when it scans", () => {
		const root = makeTree({
			"src/a.ts": 'import { polling } from "spinetab/polling";',
			// An output directory the names do not cover.
			"public/assets/old.js": 'import { sse } from "spinetab/sse";',
		});
		const excluded = run({
			role: "worker",
			roots: [root],
			excludes: [join(root, "public", "assets")],
		});
		expect(excluded.output).toBe(generateWorker(["polling"]));
		// Control: without the exclude the stale output selects sse.
		expect(run({ role: "worker", roots: [root] }).output).toBe(
			generateWorker(["polling", "sse"]),
		);
	});

	it("refuses a conventional worker file the plan did not wire", () => {
		const project = makeTree({ "app/spinetab.worker.ts": "export default 1;" });
		const elsewhere = makeTree({ "src/a.ts": 'import "spinetab/sse";' });
		expect(() =>
			run({ role: "worker", roots: [elsewhere] }, "", project),
		).toThrow(
			buildMessage({
				code: "worker-file-not-wired",
				files: ["app/spinetab.worker.ts"],
			}),
		);
		expect(() =>
			run({ role: "worker", roots: [project] }, "", project),
		).toThrow(/^\[spinetab\] restart-required: /);
	});
});

describe("spinetab/loader module shape", () => {
	it("is the default export and its own default, as the CommonJS declaration says", () => {
		// `dist/build/loader.cjs` is `module.exports = spinetabLoader`, which
		// loader runners read, while `loader.d.cts` declares `export default`:
		// both shapes hold when the function carries itself as `default`.
		expect(typeof spinetabLoader).toBe("function");
		expect((spinetabLoader as { default?: unknown }).default).toBe(
			spinetabLoader,
		);
		expect(Object.keys(spinetabLoader)).toEqual([]);
	});
});

describe("spinetab/loader, role wiring", () => {
	it("returns the input unchanged outside development", () => {
		expect(run({ role: "wiring", adapters: ["polling"] }, SHIPPED).output).toBe(
			SHIPPED,
		);
	});

	it("names the worker by the generated text in development", () => {
		const { output } = run(
			{ role: "wiring", adapters: ["polling"], dev: true },
			SHIPPED,
		);
		const name = devNameForGenerated(generateWorker(["polling"]));
		expect(output).toBe(
			SHIPPED.replace(
				'{ type: "module" }',
				`{ type: "module", name: "${name}" }`,
			),
		);
	});

	it("names the worker by the L2 file and depends on it", () => {
		const root = makeTree({ "src/spinetab.worker.ts": "export default 1;\n" });
		const worker = join(root, "src", "spinetab.worker.ts");
		const { output, calls } = run(
			{ role: "wiring", dev: true, roots: [root], worker },
			SHIPPED,
		);
		const name = devNameForWorkerFile(
			"src/spinetab.worker.ts",
			"export default 1;\n",
		);
		expect(output).toContain(`name: "${name}"`);
		expect(output).not.toContain(root);
		expect(calls.dependency).toEqual([worker]);
	});

	it("rejects unknown roles", () => {
		expect(() => run({ role: "other" as never })).toThrow(/role/);
	});
});
