import { existsSync } from "node:fs";
import { join } from "node:path";
import { inspect } from "node:util";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GENERATOR_VERSION } from "../../../src/build/generate.ts";
import { buildMessage } from "../../../src/build/messages.ts";
import { withSpinetab } from "../../../src/build/next.ts";
import {
	cliDirectory,
	projectDirectory,
} from "../../../src/build/next-config.ts";
import { cleanTrees, installSpinetab, makeTree, writeTree } from "./tree.ts";

const PROJECT_DIRECTORY_ENV = "__SPINETAB_NEXT_PROJECT_DIR";

const savedArgv = process.argv;
afterEach(() => {
	process.argv = savedArgv;
	delete process.env[PROJECT_DIRECTORY_ENV];
	cleanTrees();
});

const BUILD = "phase-production-build";
const DEV = "phase-development-server";
const WORKER = "export default defineWorker(() => []);";
const NEXT_CONFIG = "export default {};\n";

// The argv Next 16.3.6 gives the process that evaluates next.config:
// `next build [dir]` runs in the CLI process; `next dev [dir]` forks
// next/dist/server/lib/start-server.js with no arguments and no chdir
// (next-dev.js:303), so the dev child sees neither the command nor the
// directory.
const buildArgv = (...rest: string[]) => [
	"node",
	"/x/node_modules/next/dist/bin/next",
	"build",
	...rest,
];
const devChildArgv = () => [
	"node",
	"/x/node_modules/next/dist/server/lib/start-server.js",
];

type Config = Record<string, unknown> & {
	turbopack?: {
		resolveAlias?: Record<string, unknown>;
		rules?: Record<string, unknown>;
	};
	webpack?: (config: unknown, context: unknown) => unknown;
};

/**
 * Evaluates `withSpinetab` as Next does in the project directory `root`,
 * which gets a next.config file.
 */
async function evaluate(
	root: string,
	config: unknown,
	phase = BUILD,
	options?: Parameters<typeof withSpinetab>[1],
): Promise<Config> {
	installSpinetab(root);
	if (!existsSync(join(root, "next.config.mjs"))) {
		writeTree(root, { "next.config.mjs": NEXT_CONFIG });
	}
	return evaluateIn(root, config, phase, options, [
		"node",
		"next",
		phase === DEV ? "dev" : "build",
	]);
}

/** Evaluates `withSpinetab` with `cwd` and `argv` as the process has them. */
async function evaluateIn(
	cwd: string,
	config: unknown,
	phase: string,
	options: Parameters<typeof withSpinetab>[1] | undefined,
	argv: string[],
): Promise<Config> {
	vi.spyOn(process, "cwd").mockReturnValue(cwd);
	process.argv = argv;
	const fn = withSpinetab(config as Config, options);
	return (await fn(phase, { defaultConfig: {} })) as Config;
}

async function rejection(run: () => Promise<unknown>): Promise<Error> {
	try {
		await run();
	} catch (error) {
		return error as Error;
	}
	throw new Error("expected a rejection");
}

/** The L3 worker-config rule's loader options of an evaluated config. */
const ruleOptions = (config: Config) =>
	(
		config.turbopack?.rules?.["**/spinetab/dist/worker-config.js"] as
			| { loaders: { options: Record<string, unknown> }[] }
			| undefined
	)?.loaders[0]?.options;

/**
 * Evaluates `withSpinetab({})` for `next build` in a real worker thread with
 * `env`, as Next's build worker does: the source runs under Node's own
 * TypeScript support, with the process's real cwd and no CLI arguments.
 */
function inWorkerThread(env: NodeJS.ProcessEnv): Promise<unknown> {
	const source = new URL("../../../src/build/next.ts", import.meta.url).href;
	const code = `
const { parentPort, workerData } = require("node:worker_threads");
import(workerData.source).then(async ({ withSpinetab }) => {
	try {
		const config = await withSpinetab({})("${BUILD}", { defaultConfig: {} });
		const rule = config.turbopack.rules["**/spinetab/dist/worker-config.js"];
		parentPort.postMessage({ ok: true, argv: process.argv.slice(2), options: rule.loaders[0].options });
	} catch (error) {
		parentPort.postMessage({ ok: false, message: String(error && error.message) });
	}
});`;
	return new Promise((resolve, reject) => {
		const worker = new Worker(code, {
			eval: true,
			env,
			execArgv: [],
			workerData: { source },
		});
		worker.once("message", (message) => {
			resolve(message);
			void worker.terminate();
		});
		worker.once("error", reject);
	});
}

interface WebpackConfig {
	resolve: { alias: Record<string, string> };
	module: { rules: { use: { options: Record<string, unknown> }[] }[] };
	plugins: unknown[];
	output?: { path?: string };
}

const clientConfig = (output?: string): WebpackConfig => ({
	resolve: { alias: {} },
	module: { rules: [] },
	plugins: [],
	...(output ? { output: { path: output } } : {}),
});

/** A monorepo root without next.config; the app, installed, in apps/web. */
function monorepo(files: Record<string, string> = {}): string {
	const mono = makeTree({
		"package.json": "{}",
		"apps/web/package.json": "{}",
		"apps/web/next.config.mjs": NEXT_CONFIG,
		...files,
	});
	installSpinetab(join(mono, "apps", "web"));
	return mono;
}

describe("withSpinetab (spinetab/next)", () => {
	it("accepts an object, a function and an async function", async () => {
		const root = makeTree({ "app/page.tsx": 'import "spinetab/polling";' });
		for (const config of [
			{ reactStrictMode: true },
			() => ({ reactStrictMode: true }),
			async () => ({ reactStrictMode: true }),
		]) {
			const result = await evaluate(root, config);
			expect(result.reactStrictMode).toBe(true);
			expect(result).not.toHaveProperty("env");
		}
	});

	it("passes the phase and context to a function config", async () => {
		const root = makeTree({ "app/page.tsx": 'import "spinetab/polling";' });
		const user = vi.fn((phase: string) => ({ phaseSeen: phase }));
		const result = await evaluate(root, user, DEV);
		expect(user).toHaveBeenCalledWith(DEV, { defaultConfig: {} });
		expect(result.phaseSeen).toBe(DEV);
	});

	it("contributes the browser alias and the L3 loader rule", async () => {
		const root = makeTree({ "app/page.tsx": 'import "spinetab/polling";' });
		const result = await evaluate(root, {
			turbopack: {
				resolveAlias: { lodash: "lodash-es" },
				rules: { "*.svg": { loaders: ["@svgr/webpack"], as: "*.js" } },
			},
			experimental: { typedRoutes: true },
		});
		expect(result.experimental).toEqual({ typedRoutes: true });
		expect(result.turbopack?.resolveAlias).toEqual({
			lodash: "lodash-es",
			"spinetab/wiring": {
				browser: "./node_modules/spinetab/dist/auto/wiring.js",
			},
		});
		expect(Object.keys(result.turbopack?.rules ?? {})).toEqual([
			"*.svg",
			"**/spinetab/dist/worker-config.js",
		]);
		expect(
			result.turbopack?.rules?.["**/spinetab/dist/worker-config.js"],
		).toEqual({
			condition: { path: /(^|\/)spinetab\/dist\/worker-config\.js$/ },
			loaders: [
				{
					loader: "spinetab/loader",
					options: {
						role: "worker",
						adapters: null,
						credentialOrigins: [],
						roots: [root],
						// Next's output directory is never scanned.
						excludes: [join(root, ".next")],
						dev: false,
						version: GENERATOR_VERSION,
						worker: null,
					},
				},
			],
		});
		// Loader options are JSON (Turbopack cache keys).
		const rule = result.turbopack?.rules?.[
			"**/spinetab/dist/worker-config.js"
		] as {
			loaders: { options: unknown }[];
		};
		expect(JSON.parse(JSON.stringify(rule.loaders[0]?.options))).toEqual(
			rule.loaders[0]?.options,
		);
	});

	it("adds the wiring rule in development only", async () => {
		const root = makeTree({ "app/page.tsx": 'import "spinetab/polling";' });
		const dev = await evaluate(root, {}, DEV);
		expect(Object.keys(dev.turbopack?.rules ?? {})).toEqual([
			"**/spinetab/dist/worker-config.js",
			"**/spinetab/dist/auto/wiring.js",
		]);
		// names (not `worker-config.js.js`) and their ecmascript type.
		for (const rule of Object.values(dev.turbopack?.rules ?? {})) {
			expect(rule).not.toHaveProperty("as");
		}
		const build = await evaluate(root, {}, BUILD);
		expect(Object.keys(build.turbopack?.rules ?? {})).not.toContain(
			"**/spinetab/dist/auto/wiring.js",
		);
	});

	it("aliases a worker file by a ./ POSIX project-relative path at L2", async () => {
		const root = makeTree({ "app/spinetab.worker.ts": WORKER });
		const result = await evaluate(root, {});
		expect(result.turbopack?.resolveAlias?.["spinetab/worker-config"]).toBe(
			"./app/spinetab.worker.ts",
		);
		expect(result.turbopack?.rules).toEqual({});
		const option = await evaluate(
			makeTree({ "lib/live.ts": WORKER }),
			{},
			BUILD,
			{
				worker: "lib/live.ts",
			},
		);
		expect(option.turbopack?.resolveAlias?.["spinetab/worker-config"]).toBe(
			"./lib/live.ts",
		);
	});

	it("rejects an unknown option key in every phase", async () => {
		const root = makeTree({ "app/page.tsx": 'import "spinetab/sse";' });
		for (const phase of [BUILD, DEV]) {
			await expect(
				evaluate(root, {}, phase, { adapter: ["sse"] } as never),
			).rejects.toThrow(
				"[spinetab] unknown-option: the spinetab plugin accepts worker, adapters and credentialOrigins; withSpinetab also accepts dir.",
			);
		}
	});

	it("applies the webpack hook to client compilers only and chains the user's", async () => {
		const root = makeTree({ "app/spinetab.worker.ts": WORKER });
		installSpinetab(root);
		const userWebpack = vi.fn((config: unknown) => config);
		const result = await evaluate(root, { webpack: userWebpack }, DEV);
		const server = { resolve: {}, module: { rules: [] }, plugins: [] };
		result.webpack?.(server, { isServer: true, dir: root });
		expect(server).toEqual({ resolve: {}, module: { rules: [] }, plugins: [] });
		const client = clientConfig();
		result.webpack?.(client, { isServer: false, dir: root });
		expect(client.resolve.alias).toEqual({
			// File targets resolve under import and require conditions.
			"spinetab/wiring$": join(
				root,
				"node_modules/spinetab/dist/auto/wiring.js",
			),
			"spinetab/worker-config$": join(root, "app/spinetab.worker.ts"),
		});
		expect(client.module.rules).toHaveLength(1);
		expect(client.plugins).toHaveLength(1);
		expect(userWebpack).toHaveBeenCalledTimes(2);
	});
});

describe("Next project directory", () => {
	it("reads the positional directory with Next 16.3.6's option table", () => {
		const root = makeTree({ "apps/web/package.json": "{}" });
		const web = join(root, "apps", "web");
		const at = (...argv: string[]) =>
			cliDirectory(["node", "next", ...argv], root);
		expect(at("build", "--port", "3000", "apps/web")).toBe(web);
		expect(at("build")).toBeUndefined();
		expect(at("dev", "missing")).toBeUndefined();
		// Boolean options keep the directory that follows them.
		expect(at("build", "--debug-prerender", "apps/web")).toBe(web);
		expect(at("build", "--webpack", "--profile", "apps/web")).toBe(web);
		// Options that take a value skip it.
		expect(at("build", "--debug-build-paths", "app/*", "apps/web")).toBe(web);
		expect(
			at(
				"build",
				"--experimental-upload-trace",
				"https://t.example",
				"apps/web",
			),
		).toBe(web);
		expect(at("start", "--keepAliveTimeout", "5000", "apps/web")).toBe(web);
		expect(at("dev", "--experimental-https-key", "key.pem", "apps/web")).toBe(
			web,
		);
		// Optional values are taken unless the next argument is an option.
		expect(
			at("build", "--experimental-build-mode", "compile", "apps/web"),
		).toBe(web);
		expect(
			at("build", "--experimental-build-mode", "--webpack", "apps/web"),
		).toBe(web);
		expect(at("dev", "--inspect", "--webpack", "apps/web")).toBe(web);
		expect(at("dev", "--inspect", "9230", "apps/web")).toBe(web);
		// The `--flag=value` and `--` forms.
		expect(at("build", "--debug-build-paths=app/*", "apps/web")).toBe(web);
		expect(at("build", "--", "apps/web")).toBe(web);
		// Other commands that load next.config for a directory.
		expect(at("typegen", "apps/web")).toBe(web);
		expect(at("experimental-analyze", "--port", "4000", "apps/web")).toBe(web);
	});

	it("plans against the dir option, then a cwd holding next.config, then a positional holding one; a differing pair is ambiguous", () => {
		const mono = monorepo();
		const web = join(mono, "apps", "web");
		// `next build apps/web` from the monorepo root: the positional directory.
		expect(projectDirectory(undefined, mono, buildArgv("apps/web"))).toBe(web);
		// `cd apps/web && next dev`: the invocation directory.
		expect(projectDirectory(undefined, web, devChildArgv())).toBe(web);
		// The dir option comes first, whatever the cwd and argv say.
		const other = makeTree({ "next.config.ts": NEXT_CONFIG });
		expect(projectDirectory(web, other, buildArgv(other))).toBe(web);
		// A cwd and a positional directory that both hold a next.config and
		// differ are ambiguous; the same directory twice is not.
		expect(() => projectDirectory(undefined, other, buildArgv(web))).toThrow(
			buildMessage({ code: "project-directory-unknown" }),
		);
		expect(projectDirectory(undefined, web, buildArgv("."))).toBe(web);
		expect(projectDirectory(undefined, web, buildArgv(web))).toBe(web);
		// A positional directory without next.config is not the project.
		expect(() => projectDirectory(undefined, mono, buildArgv("apps"))).toThrow(
			buildMessage({ code: "project-directory-unknown" }),
		);
		for (const name of [
			"next.config.js",
			"next.config.mjs",
			"next.config.ts",
			"next.config.mts",
		]) {
			const dir = makeTree({ [name]: NEXT_CONFIG });
			expect(projectDirectory(undefined, dir, devChildArgv()), name).toBe(dir);
		}
	});

	it("next.config.cjs marks no project: Next 16.3.6 refuses it", () => {
		// next/dist/server/config.js throws E203 "Configuring Next.js via
		// 'next.config.cjs' is not supported"; CONFIG_FILES holds js, mjs, ts
		// and mts only. A stray one must not outrank the positional directory.
		const mono = monorepo({ "next.config.cjs": "module.exports = {};\n" });
		const web = join(mono, "apps", "web");
		expect(projectDirectory(undefined, mono, buildArgv("apps/web"))).toBe(web);
		const only = makeTree({ "next.config.cjs": "module.exports = {};\n" });
		expect(() => projectDirectory(undefined, only, devChildArgv())).toThrow(
			buildMessage({ code: "project-directory-unknown" }),
		);
	});

	it("later evaluations in the same process tree plan the directory the first one resolved", () => {
		const mono = monorepo();
		const web = join(mono, "apps", "web");
		const other = makeTree({ "next.config.ts": NEXT_CONFIG });
		const handed = { [PROJECT_DIRECTORY_ENV]: web };
		// A build worker: the parent's cwd, argv [node, script], the handed env.
		const worker = [
			"node",
			"/x/node_modules/next/dist/compiled/jest-worker/processChild.js",
		];
		expect(projectDirectory(undefined, mono, worker, handed)).toBe(web);
		// The dir option, a cwd holding next.config and a positional directory
		// holding one all come first.
		expect(
			projectDirectory(web, other, worker, { [PROJECT_DIRECTORY_ENV]: other }),
		).toBe(web);
		expect(projectDirectory(undefined, other, worker, handed)).toBe(other);
		expect(projectDirectory(undefined, mono, buildArgv(other), handed)).toBe(
			other,
		);
		// A handed directory that holds no next.config is no project.
		for (const env of [
			{ [PROJECT_DIRECTORY_ENV]: mono },
			{ [PROJECT_DIRECTORY_ENV]: "apps/web" },
			{},
		]) {
			expect(() => projectDirectory(undefined, mono, worker, env)).toThrow(
				buildMessage({ code: "project-directory-unknown" }),
			);
		}
	});

	it("`next build apps/web` from a parent directory: Next's build worker thread plans apps/web", async () => {
		const mono = monorepo({
			"apps/web/app/page.tsx": 'import "spinetab/sse";',
		});
		const web = join(mono, "apps", "web");
		// Next 16.3.6 evaluates next.config in the CLI process…
		const parent = await evaluateIn(
			mono,
			{},
			BUILD,
			undefined,
			buildArgv("apps/web"),
		);
		expect(ruleOptions(parent)).toMatchObject({
			roots: [web],
			excludes: [join(web, ".next")],
		});
		// …and again in its Turbopack build worker thread (turbopack-build/index.js
		// enableWorkerThreads, impl.js "load the config because it's not
		// serializable"), whose argv holds neither the command nor the directory
		// and whose cwd is the parent's. lib/worker.js builds its env as
		// {...process.env,...forkOptions.env, IS_NEXT_WORKER }.
		const real = process.cwd();
		for (const name of [
			"next.config.js",
			"next.config.mjs",
			"next.config.ts",
			"next.config.mts",
		]) {
			expect(existsSync(join(real, name)), name).toBe(false);
		}
		const answer = await inWorkerThread({
			...process.env,
			NEXT_PRIVATE_BUILD_WORKER: "1",
			IS_NEXT_WORKER: "true",
		});
		expect(answer).toEqual({
			ok: true,
			argv: [],
			options: expect.objectContaining({
				roots: [web],
				excludes: [join(web, ".next")],
			}),
		});
		// Without the handed directory the worker fails loudly, never planning
		// against its cwd.
		const bare = { ...process.env };
		delete bare[PROJECT_DIRECTORY_ENV];
		expect(await inWorkerThread(bare)).toEqual({
			ok: false,
			message: buildMessage({ code: "project-directory-unknown" }),
		});
	});

	it("`next dev apps/web` from a parent directory fails with project-directory-unknown", async () => {
		const mono = monorepo({
			"apps/web/app/spinetab.worker.ts": WORKER,
			"apps/web/app/page.tsx": 'import "spinetab/sse";',
		});
		// The dev child (and a `next build` without a directory) from the
		// monorepo root: never a plan against the root.
		for (const [phase, argv] of [
			[DEV, devChildArgv()],
			[BUILD, buildArgv()],
		] as const) {
			const error = await rejection(() =>
				evaluateIn(mono, {}, phase, undefined, argv),
			);
			expect(error.message).toBe(
				buildMessage({ code: "project-directory-unknown" }),
			);
			expect(
				`${error.message}\n${error.stack}\n${inspect(error)}`,
			).not.toContain(mono);
		}
	});

	it("the dir option plans the dev child against the project", async () => {
		const mono = monorepo({ "apps/web/app/spinetab.worker.ts": WORKER });
		const web = join(mono, "apps", "web");
		const result = await evaluateIn(
			mono,
			{},
			DEV,
			{ dir: web },
			devChildArgv(),
		);
		expect(result.turbopack?.resolveAlias?.["spinetab/worker-config"]).toBe(
			"./app/spinetab.worker.ts",
		);
		expect(Object.keys(result.turbopack?.rules ?? {})).toEqual([
			"**/spinetab/dist/auto/wiring.js",
		]);
	});

	it("the worker option under the dev child resolves against dir, or fails loudly", async () => {
		const mono = monorepo({ "apps/web/lib/live.ts": WORKER });
		const web = join(mono, "apps", "web");
		const error = await rejection(() =>
			evaluateIn(mono, {}, DEV, { worker: "lib/live.ts" }, devChildArgv()),
		);
		expect(error.message).toBe(
			buildMessage({ code: "project-directory-unknown" }),
		);
		for (const worker of ["lib/live.ts", join(web, "lib", "live.ts")]) {
			const result = await evaluateIn(
				mono,
				{},
				DEV,
				{ worker, dir: web },
				devChildArgv(),
			);
			expect(
				result.turbopack?.resolveAlias?.["spinetab/worker-config"],
				worker,
			).toBe("./lib/live.ts");
		}
	});

	it("rejects a dir option that is not an existing absolute directory", async () => {
		const mono = monorepo();
		const web = join(mono, "apps", "web");
		for (const dir of [
			"apps/web",
			"",
			join(mono, "missing"),
			join(web, "next.config.mjs"),
			42,
		]) {
			const error = await rejection(() =>
				evaluateIn(mono, {}, DEV, { dir } as never, devChildArgv()),
			);
			expect(error.message, String(dir)).toBe(
				buildMessage({ code: "invalid-dir-option" }),
			);
		}
	});

	it("the webpack hook plans from ctx.dir", async () => {
		// The config was evaluated in a directory that holds a next.config but
		// is not the one Next compiles (ctx.dir).
		const other = makeTree({
			"next.config.mjs": NEXT_CONFIG,
			"src/a.ts": 'import "spinetab/polling";',
		});
		installSpinetab(other);
		const mono = monorepo({ "apps/web/app/spinetab.worker.ts": WORKER });
		const web = join(mono, "apps", "web");
		const result = await evaluateIn(other, {}, DEV, undefined, devChildArgv());
		// Turbopack plans at config time (L3 for `other`)…
		expect(Object.keys(result.turbopack?.rules ?? {})).toContain(
			"**/spinetab/dist/worker-config.js",
		);
		// …but the webpack hook plans from the directory Next passes it.
		const client = clientConfig();
		result.webpack?.(client, { isServer: false, dev: true, dir: web });
		expect(client.resolve.alias).toEqual({
			"spinetab/wiring$": join(
				web,
				"node_modules/spinetab/dist/auto/wiring.js",
			),
			"spinetab/worker-config$": join(web, "app/spinetab.worker.ts"),
		});
		expect(
			client.module.rules.map((rule) => rule.use[0]?.options.role),
		).toEqual(["wiring"]);
		// An L3 project named by ctx.dir scans ctx.dir.
		const l3 = monorepo({ "apps/web/app/page.tsx": 'import "spinetab/sse";' });
		const l3web = join(l3, "apps", "web");
		const build = await evaluateIn(other, {}, BUILD, undefined, buildArgv());
		const l3client = clientConfig(join(l3web, ".next"));
		build.webpack?.(l3client, { isServer: false, dev: false, dir: l3web });
		expect(l3client.module.rules[0]?.use[0]?.options).toMatchObject({
			role: "worker",
			roots: [l3web],
			excludes: [join(l3web, ".next")],
		});
	});

	it("aliases the ESM wiring file for CommonJS too, keeping Turbopack browser-only", async () => {
		const root = makeTree({ "app/page.tsx": 'import "spinetab/polling";' });
		const installed = installSpinetab(root);
		const result = await evaluate(root, {}, BUILD);
		expect(result.turbopack?.resolveAlias?.["spinetab/wiring"]).toEqual({
			browser: "./node_modules/spinetab/dist/auto/wiring.js",
		});
		const client = clientConfig(join(root, ".next"));
		result.webpack?.(client, { isServer: false, dev: false, dir: root });
		expect(client.resolve.alias["spinetab/wiring$"]).toBe(
			join(installed, "dist", "auto", "wiring.js"),
		);
	});

	it("loader options exclude the distDir on Turbopack and webpack", async () => {
		const root = makeTree({ "app/page.tsx": 'import "spinetab/polling";' });
		installSpinetab(root);
		const result = await evaluate(root, { distDir: "dist-next" }, DEV);
		const rules = Object.values(result.turbopack?.rules ?? {}) as {
			loaders: { options: { excludes?: string[] } }[];
		}[];
		expect(rules).toHaveLength(2);
		for (const rule of rules) {
			expect(rule.loaders[0]?.options.excludes).toEqual([
				join(root, "dist-next"),
			]);
		}
		const client = clientConfig(join(root, "dist-next"));
		result.webpack?.(client, { isServer: false, dev: true, dir: root });
		expect(client.module.rules).toHaveLength(2);
		for (const rule of client.module.rules) {
			expect(rule.use[0]?.options.excludes).toEqual([join(root, "dist-next")]);
		}
	});
});
