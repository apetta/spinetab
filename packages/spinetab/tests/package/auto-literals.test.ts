import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { distDir, packageRoot, readManifest } from "./dist.ts";
import { dynamicImportsOf, importsOf } from "./graph.ts";

/** Bundlers recognise these literal worker expressions; tree shaking must retain the worker binding even with application sideEffects: false. */
const manifest = readManifest();
const read = (file: string) => readFileSync(join(distDir, file), "utf8");
/** Emitted code without tsdown's region markers and the map reference. */
const code = (text: string) =>
	text
		.split("\n")
		.filter(
			(line) =>
				!/^\/\/#(region|endregion)\b/.test(line) &&
				!/^\/\/# sourceMappingURL=/.test(line) &&
				line.trim() !== "",
		)
		.join("\n");
const count = (text: string, needle: string) => text.split(needle).length - 1;

const WORKER_LITERAL =
	'\tworker: () => new SharedWorker(new URL("./worker.js", import.meta.url), { type: "module" }),';
const LOCAL_LITERAL = '\tlocal: () => import("./worker.js")';

describe("dist/auto/wiring.js: the shipped literals", () => {
	const text = read("auto/wiring.js");

	it("is exactly the two literals in a named `wiring` export", () => {
		expect(code(text)).toBe(
			[
				"const wiring = {",
				WORKER_LITERAL,
				LOCAL_LITERAL,
				"};",
				"export { wiring };",
			].join("\n"),
		);
	});

	it("names the worker once, the module type once and the lazy import once", () => {
		expect(count(text, "new SharedWorker(")).toBe(1);
		expect(count(text, 'new URL("./worker.js", import.meta.url)')).toBe(1);
		expect(count(text, "import.meta.url")).toBe(1);
		// The development transform replaces exactly this text.
		expect(count(text, '{ type: "module" }')).toBe(1);
		expect(count(text, "name:")).toBe(0);
		expect(dynamicImportsOf("auto/wiring.js", text)).toEqual(["./worker.js"]);
		// No static import: the literals must not pull runtime code eagerly.
		expect(importsOf(text)).toEqual(["./worker.js"]);
	});

	it("points both literals at the keep stub, the ./auto/worker export", () => {
		expect(manifest.exports["./auto/worker"]?.import.default).toBe(
			"./dist/auto/worker.js",
		);
		expect(existsSync(join(distDir, "auto/worker.js"))).toBe(true);
	});

	it("ships ESM only: no CommonJS copy and no require condition", () => {
		expect(manifest.exports["./auto/wiring"]?.require).toBeUndefined();
		expect(existsSync(join(distDir, "auto/wiring.cjs"))).toBe(false);
		expect(existsSync(join(distDir, "auto/worker.cjs"))).toBe(false);
	});

	it("declares the export as SpinetabWiring", () => {
		expect(read("auto/wiring.d.ts")).toMatch(
			/export declare const wiring: SpinetabWiring;/,
		);
	});
});

describe("dist/auto/worker.js: the keep stub", () => {
	const text = read("auto/worker.js");

	it("imports the worker-config default and guards on its binding", () => {
		expect(code(text)).toBe(
			[
				'import worker from "spinetab/worker-config";',
				'if (typeof worker !== "function") throw new TypeError("spinetab: the worker file must export default defineWorker(…).");',
				"var worker_default = worker;",
				"export { worker_default as default };",
			].join("\n"),
		);
		expect(importsOf(text)).toEqual(["spinetab/worker-config"]);
	});

	/**
	 * The keep stub copied beside a fake `spinetab/worker-config`, loaded by a
	 * child Node process so Node's own resolution (not Vitest's) applies.
	 */
	function keepWith(config: string, label: string): string {
		const dir = join(packageRoot, "test-results/auto-literals", label);
		rmSync(dir, { recursive: true, force: true });
		const fake = join(dir, "node_modules/spinetab");
		mkdirSync(fake, { recursive: true });
		// Its own package scope, so Node's self-reference to the enclosing
		// `spinetab` manifest cannot answer for the fake.
		writeFileSync(
			join(dir, "package.json"),
			JSON.stringify({ name: "keep-probe", private: true, type: "module" }),
		);
		writeFileSync(
			join(fake, "package.json"),
			JSON.stringify({
				name: "spinetab",
				type: "module",
				exports: { "./worker-config": "./config.js" },
			}),
		);
		writeFileSync(join(fake, "config.js"), config);
		writeFileSync(join(dir, "keep.mjs"), code(text));
		const script = `import(${JSON.stringify(pathToFileURL(join(dir, "keep.mjs")).href)}).then((keep) => process.stdout.write(typeof keep.default === "function" ? "function:" + keep.default() : typeof keep.default), (error) => process.stdout.write(error.name + ": " + error.message))`;
		return execFileSync(
			process.execPath,
			["--input-type=module", "-e", script],
			{ cwd: dir, encoding: "utf8" },
		);
	}

	it("re-exports a function default unchanged", () => {
		expect(
			keepWith("export default function factory() { return 1; }\n", "function"),
		).toBe("function:1");
	});

	it("throws the fixed sentence when the worker module has no function default", () => {
		expect(keepWith("export default 1;\n", "number")).toBe(
			"TypeError: spinetab: the worker file must export default defineWorker(…).",
		);
	});
});

describe("dist/worker-config.js: the stub", () => {
	it("exports a function default that fails only when called", async () => {
		const stub = (await import(
			pathToFileURL(join(distDir, "worker-config.js")).href
		)) as Record<string, unknown>;
		expect(Object.keys(stub)).toEqual(["default"]);
		expect(typeof stub.default).toBe("function");
		expect(() => (stub.default as () => unknown)()).toThrow(
			"spinetab: the bundler plugin redirected the wiring but supplied no worker module.",
		);
		expect(importsOf(read("worker-config.js"))).toEqual([]);
	});
});

describe("dist/wiring.{js,cjs}: the plugin-absent default", () => {
	it("exports a named `wiring` that is undefined in both formats", async () => {
		const esm = (await import(
			pathToFileURL(join(distDir, "wiring.js")).href
		)) as Record<string, unknown>;
		expect(Object.keys(esm)).toEqual(["wiring"]);
		expect(esm.wiring).toBeUndefined();
		const cjs = createRequire(import.meta.url)(
			join(distDir, "wiring.cjs"),
		) as Record<string, unknown>;
		expect(Object.keys(cjs)).toEqual(["wiring"]);
		expect(cjs.wiring).toBeUndefined();
		expect(importsOf(read("wiring.js"))).toEqual([]);
		expect(importsOf(read("wiring.cjs"))).toEqual([]);
	});
});
