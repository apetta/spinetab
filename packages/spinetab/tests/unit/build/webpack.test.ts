import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import webpackFactory, { type Compiler } from "webpack";
import {
	GENERATOR_VERSION,
	generateWorker,
} from "../../../src/build/generate.ts";
import spinetabLoader from "../../../src/build/loader.ts";
import { buildMessage } from "../../../src/build/messages.ts";
import { spinetab as rspack } from "../../../src/build/rspack.ts";
import { spinetab as webpack } from "../../../src/build/webpack.ts";
import type {
	CompilationLike,
	CompilerLike,
	ResolveDataLike,
} from "../../../src/build/webpack-plugin.ts";
import { cleanTrees, installSpinetab, makeTree } from "./tree.ts";

afterEach(cleanTrees);

class Hook<Args extends unknown[]> {
	readonly taps: ((...args: Args) => unknown)[] = [];
	tap(_name: string, fn: (...args: Args) => unknown): void {
		this.taps.push(fn);
	}
	call(...args: Args): void {
		for (const fn of this.taps) fn(...args);
	}
}

class FakeError extends Error {}

/** The shipped `auto/wiring.js` of the package installed under `root`. */
const autoWiring = (root: string) =>
	join(root, "node_modules", "spinetab", "dist", "auto", "wiring.js");

function fakeCompiler(
	root: string,
	options: Partial<CompilerLike["options"]> = {},
	extra: Partial<CompilerLike> = {},
) {
	installSpinetab(root);
	const hooks = {
		afterEnvironment: new Hook<[]>(),
		thisCompilation: new Hook<
			[
				CompilationLike,
				{
					normalModuleFactory: {
						hooks: { beforeResolve: Hook<[ResolveDataLike]> };
					};
				},
			]
		>(),
	};
	const compiler: CompilerLike = {
		context: root,
		options: {
			mode: "production",
			resolve: {},
			module: { rules: [] },
			...options,
		},
		platform: { web: true },
		webpack: { WebpackError: FakeError },
		hooks,
		...extra,
	};
	/** Runs one compilation with the given requests and final module resources. */
	const compile = (
		requests: { request: string; issuer: string }[],
		resources: string[] = [],
	) => {
		const finishModules = new Hook<[Iterable<unknown>]>();
		const beforeResolve = new Hook<[ResolveDataLike]>();
		const compilation: CompilationLike = {
			errors: [],
			warnings: [],
			hooks: { finishModules },
		};
		hooks.thisCompilation.call(compilation, {
			normalModuleFactory: { hooks: { beforeResolve } },
		});
		for (const { request, issuer } of requests) {
			beforeResolve.call({ request, contextInfo: { issuer } });
		}
		finishModules.call(resources.map((resource) => ({ resource })));
		return compilation.errors.map((error) => (error as Error).message);
	};
	return { compiler, hooks, compile };
}

const messages = (errors: unknown[]) => errors.map((e) => (e as Error).message);

describe("spinetab/webpack and spinetab/rspack", () => {
	it("returns a SpinetabPlugin instance with named exports only", () => {
		expect(webpack().constructor.name).toBe("SpinetabPlugin");
		expect(rspack().constructor.name).toBe("SpinetabPlugin");
	});

	it("adds exact aliases and the L3 worker rule", () => {
		const root = makeTree({
			"src/main.js": 'import { polling } from "spinetab/polling";',
		});
		const { compiler, hooks } = fakeCompiler(root, {
			resolve: { alias: { react: "preact/compat" } },
		});
		webpack().apply(compiler);
		hooks.afterEnvironment.call();
		expect(compiler.options.resolve).toEqual({
			alias: {
				react: "preact/compat",
				// the absolute real path, so CommonJS requests resolve too.
				"spinetab/wiring$": autoWiring(root),
			},
		});
		expect(compiler.options.module).toEqual({
			rules: [
				{
					test: /[\\/]spinetab[\\/]dist[\\/]worker-config\.js$/,
					use: [
						{
							loader: "spinetab/loader",
							options: {
								role: "worker",
								adapters: null,
								credentialOrigins: [],
								roots: [root],
								excludes: [],
								dev: false,
								version: GENERATOR_VERSION,
								worker: null,
							},
						},
					],
				},
			],
		});
	});

	it("adds the development wiring rule and the L2 alias", () => {
		const root = makeTree({
			"src/spinetab.worker.js": "export default defineWorker(() => []);",
		});
		const { compiler, hooks } = fakeCompiler(root, { mode: "development" });
		rspack().apply(compiler);
		hooks.afterEnvironment.call();
		const worker = join(root, "src", "spinetab.worker.js");
		expect(compiler.options.resolve).toEqual({
			alias: {
				"spinetab/wiring$": autoWiring(root),
				"spinetab/worker-config$": worker,
			},
		});
		const rules = (
			compiler.options.module as {
				rules: {
					test: RegExp;
					use: { options: { role: string; worker: string } }[];
				}[];
			}
		).rules;
		expect(rules).toHaveLength(1);
		expect(rules[0]?.test.source).toContain("auto");
		expect(rules[0]?.use[0]?.options).toMatchObject({
			role: "wiring",
			worker,
			dev: true,
		});
	});

	it("supports the array alias form with onlyModule", () => {
		const root = makeTree({ "src/a.js": 'import "spinetab/sse";' });
		const alias: unknown[] = [];
		const { compiler, hooks } = fakeCompiler(root, { resolve: { alias } });
		webpack().apply(compiler);
		hooks.afterEnvironment.call();
		expect(alias).toEqual([
			{
				name: "spinetab/wiring",
				alias: autoWiring(root),
				onlyModule: true,
			},
		]);
	});

	it("stays inert for non-web targets", () => {
		const root = makeTree({ "src/a.js": 'import "spinetab/sse";' });
		const { compiler, hooks, compile } = fakeCompiler(
			root,
			{},
			{
				platform: { web: false },
			},
		);
		webpack().apply(compiler);
		hooks.afterEnvironment.call();
		expect(compiler.options.resolve).toEqual({});
		expect(
			compile([], [join(root, "node_modules/spinetab/dist/wiring.js")]),
		).toEqual([]);
	});

	it("reports configuration errors as compilation errors", () => {
		const root = makeTree();
		const { compiler, hooks, compile } = fakeCompiler(root);
		webpack({ adapters: ["nope" as never] }).apply(compiler);
		hooks.afterEnvironment.call();
		const errors = compile([]);
		expect(errors).toEqual([buildMessage({ code: "unknown-adapter" })]);
	});

	it("reports an unknown option key on both bundlers", () => {
		for (const factory of [webpack, rspack]) {
			const root = makeTree({ "src/a.js": 'import "spinetab/sse";' });
			const { compiler, hooks, compile } = fakeCompiler(root);
			factory({ adapter: ["sse"] } as never).apply(compiler);
			hooks.afterEnvironment.call();
			expect(compile([])).toEqual([buildMessage({ code: "unknown-option" })]);
			// Nothing is contributed from invalid options.
			expect(compiler.options.resolve).toEqual({});
			expect(compiler.options.module).toEqual({ rules: [] });
		}
	});

	it("worker-parser-disabled", () => {
		const root = makeTree({ "src/a.js": 'import "spinetab/sse";' });
		const { compiler, hooks, compile } = fakeCompiler(root, {
			module: { rules: [], parser: { javascript: { worker: false } } },
		});
		webpack().apply(compiler);
		hooks.afterEnvironment.call();
		expect(compile([])).toEqual([
			buildMessage({ code: "worker-parser-disabled" }),
		]);
	});

	it("worker-parser-disabled reads the effective javascript/esm worker option", () => {
		// The shipped `auto/wiring.js` is `javascript/esm` (a `.js` file of a
		// `"type": "module"` package), so webpack merges `javascript` with
		// `javascript/esm`; a list without "..." or "SharedWorker" parses no
		// SharedWorker and ships the raw worker file as an asset.
		const disabled = [
			{ "javascript/esm": { worker: false } },
			{ javascript: { worker: ["Worker"] } },
			{ "javascript/esm": { worker: ["Worker", "*context.audioWorklet"] } },
			{
				javascript: { worker: ["Worker"] },
				"javascript/esm": { worker: ["..."] },
			},
			{
				javascript: { worker: false },
				"javascript/esm": { worker: ["...", "custom"] },
			},
		];
		const enabled = [
			{},
			{ javascript: { worker: true } },
			{ javascript: { worker: ["...", "custom"] } },
			{ javascript: { worker: ["SharedWorker"] } },
			{ javascript: { worker: false }, "javascript/esm": { worker: true } },
			{ "javascript/esm": { worker: ["..."] } },
			// Not the wiring module's type: webpack never merges them in.
			{ "javascript/auto": { worker: false } },
			{ "javascript/dynamic": { worker: false } },
		];
		for (const [parser, expected] of [
			...disabled.map((item) => [item, true] as const),
			...enabled.map((item) => [item, false] as const),
		]) {
			const root = makeTree({ "src/a.js": 'import "spinetab/sse";' });
			const { compiler, hooks, compile } = fakeCompiler(root, {
				module: { rules: [], parser },
			});
			webpack().apply(compiler);
			hooks.afterEnvironment.call();
			expect(compile([]), JSON.stringify(parser)).toEqual(
				expected ? [buildMessage({ code: "worker-parser-disabled" })] : [],
			);
		}
	});

	it("aliases spinetab/wiring to a path webpack resolves under CommonJS conditions", async () => {
		const root = makeTree({
			"src/main.cjs":
				'const { wiring } = require("spinetab");\nmodule.exports = wiring;\n',
		});
		installSpinetab(root);
		const packageDist = join(root, "node_modules", "spinetab", "dist");
		const resolveIn = (
			compiler: Compiler,
			dependencyType: "esm" | "commonjs",
		) =>
			new Promise<string>((done) => {
				const resolver = compiler.resolverFactory.get("normal", {
					dependencyType,
				});
				// `dist/index.cjs` does `require("spinetab/wiring")`.
				resolver.resolve(
					{},
					packageDist,
					"spinetab/wiring",
					{},
					(error: Error | null, result?: string | false) =>
						done(
							error ? `error: ${error.message.split("\n")[0]}` : String(result),
						),
				);
			});
		const make = (plugins: unknown[]): Compiler =>
			webpackFactory({
				context: root,
				mode: "production",
				target: "web",
				entry: "./src/main.cjs",
				plugins: plugins as never,
			});
		const withPlugin = make([webpack({ adapters: ["polling"] })]);
		expect(await resolveIn(withPlugin, "commonjs")).toBe(autoWiring(root));
		expect(await resolveIn(withPlugin, "esm")).toBe(autoWiring(root));
		// Control: without the plugin, CommonJS takes the inert default.
		expect(await resolveIn(make([]), "commonjs")).toBe(
			join(packageDist, "wiring.cjs"),
		);
		// The package exports `./auto/wiring` under `import` only, so the
		// earlier bare alias target cannot resolve for a CommonJS request.
		const bare = make([
			{
				apply(compiler: { options: { resolve: { alias?: unknown } } }) {
					compiler.options.resolve.alias = {
						"spinetab/wiring$": "spinetab/auto/wiring",
					};
				},
			},
		]);
		expect(await resolveIn(bare, "commonjs")).toMatch(
			/^error: .*"\.\/auto\/wiring" is not exported/,
		);
	});

	it("loader options exclude the output directory from inference", () => {
		const root = makeTree({
			"src/main.js": 'import { polling } from "spinetab/polling";',
			// An earlier unbundled build left in a non-default output directory.
			"public/assets/legacy.js": 'import { sse } from "spinetab/sse";',
		});
		const out = join(root, "public", "assets");
		const { compiler, hooks } = fakeCompiler(root, { output: { path: out } });
		webpack().apply(compiler);
		hooks.afterEnvironment.call();
		const [rule] = (
			compiler.options.module as {
				rules: { use: { options: Record<string, unknown> }[] }[];
			}
		).rules;
		const options = rule?.use[0]?.options;
		expect(options?.excludes).toEqual([out]);
		const warnings: string[] = [];
		const output = spinetabLoader.call(
			{
				getOptions: () => options,
				addContextDependency: () => undefined,
				addDependency: () => undefined,
				cacheable: () => undefined,
				emitWarning: (warning) => warnings.push(warning.message),
				rootContext: root,
			},
			"",
		);
		expect(output).toBe(generateWorker(["polling"]));
		expect(warnings).toEqual([]);
	});

	it("graph check: adapter-not-generated and wiring-not-applied", () => {
		const root = makeTree({ "src/a.js": 'import "spinetab/polling";' });
		const { compiler, hooks, compile } = fakeCompiler(root);
		webpack({ adapters: ["polling"] }).apply(compiler);
		hooks.afterEnvironment.call();
		const app = join(root, "src", "a.js");
		const lib = join(root, "node_modules", "lib", "index.js");
		expect(
			compile([
				{ request: "spinetab/polling", issuer: app },
				{ request: "spinetab/sse", issuer: lib },
			]),
		).toEqual([]);
		expect(compile([{ request: "spinetab/sse", issuer: app }])).toEqual([
			buildMessage({ code: "adapter-not-generated", entry: "sse" }),
		]);
		const errors = compile(
			[],
			[join(root, "node_modules", "spinetab", "dist", "wiring.js")],
		);
		expect(errors).toEqual([buildMessage({ code: "wiring-not-applied" })]);
	});

	it("graph check ignores an importer of inline types only", () => {
		const root = makeTree({
			"src/a.js": 'import "spinetab/polling";',
			"src/describe.ts":
				'import { type SseSource } from "spinetab/sse";\nexport type D = SseSource;',
			"src/live.ts": 'import { sse } from "spinetab/sse";',
		});
		const { compiler, hooks, compile } = fakeCompiler(root);
		webpack({ adapters: ["polling"] }).apply(compiler);
		hooks.afterEnvironment.call();
		const typesOnly = join(root, "src", "describe.ts");
		expect(
			compile([
				{ request: "spinetab/polling", issuer: join(root, "src", "a.js") },
				{ request: "spinetab/sse", issuer: typesOnly },
			]),
		).toEqual([]);
		expect(
			compile([
				{ request: "spinetab/sse", issuer: typesOnly },
				{ request: "spinetab/sse", issuer: join(root, "src", "live.ts") },
			]),
		).toEqual([buildMessage({ code: "adapter-not-generated", entry: "sse" })]);
	});

	it("uses the bundler's WebpackError without a stack", () => {
		const root = makeTree();
		const { compiler, hooks } = fakeCompiler(root);
		webpack({ adapters: ["x" as never] }).apply(compiler);
		hooks.afterEnvironment.call();
		const compilation: CompilationLike = {
			errors: [],
			warnings: [],
			hooks: { finishModules: new Hook() },
		};
		hooks.thisCompilation.call(compilation, {
			normalModuleFactory: { hooks: { beforeResolve: new Hook() } },
		});
		expect(compilation.errors[0]).toBeInstanceOf(FakeError);
		expect(compilation.errors[0]).toMatchObject({ hideStack: true });
		expect(messages(compilation.errors)).toHaveLength(1);
	});
});
