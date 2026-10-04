import { execFileSync, spawn } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Child-process helpers for the packed-consumer stages. Commands run without a
 * shell, with an explicit timeout, and their combined output is kept so build
 * logs can be scanned and written as evidence.
 *
 * No child inherits `NODE_PATH`: pnpm's bin shims (for example
 * `packages/spinetab/node_modules/.bin/vitest`) export it with the workspace
 * virtual store, and Node's CommonJS resolver consults it after the
 * `node_modules` walk, so a child could resolve packages the consumer never
 * installed.
 */

/** This process's environment plus `extra`, without `NODE_PATH`. */
export function childEnv(
	extra: Record<string, string> = {},
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries({ ...process.env, ...extra })) {
		if (value === undefined || key.toUpperCase() === "NODE_PATH") continue;
		env[key] = value;
	}
	return env;
}

export interface Resolution {
	name: string;
	/** Resolved file, or null when resolution failed. */
	resolved: string | null;
	/** Error code when resolution failed (`MODULE_NOT_FOUND`, …). */
	code: string | null;
}

const RESOLVE_SCRIPT = `
const { createRequire } = require("node:module");
const [from, ...names] = process.argv.slice(1);
const resolve = createRequire(from).resolve;
const rows = names.map((name) => {
	try {
		return { name, resolved: resolve(name), code: null };
	} catch (error) {
		return { name, resolved: null, code: error.code ?? "unknown" };
	}
});
process.stdout.write(JSON.stringify(rows));
`;

/**
 * Resolve `names` as `require.resolve` from `<dir>/package.json` in one plain
 * Node child without `NODE_PATH`: what the consumer's own Node sees, not what
 * the test runner's module paths add.
 */
export function resolveInChild(
	dir: string,
	names: readonly string[],
): Resolution[] {
	const output = execFileSync(
		process.execPath,
		["-e", RESOLVE_SCRIPT, "--", join(dir, "package.json"), ...names],
		{ cwd: dir, env: childEnv(), encoding: "utf8" },
	);
	return JSON.parse(output) as Resolution[];
}

export interface RunResult {
	command: string[];
	env: Record<string, string>;
	code: number | null;
	signal: NodeJS.Signals | null;
	output: string;
	durationMs: number;
	timedOut: boolean;
}

export interface RunOptions {
	cwd: string;
	env?: Record<string, string>;
	timeoutMs?: number;
	/** Also stream output into this file. */
	logFile?: string;
}

export function run(
	command: string,
	args: readonly string[],
	options: RunOptions,
): Promise<RunResult> {
	const started = Date.now();
	const env = options.env ?? {};
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: childEnv(env),
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		});
		let output = "";
		let timedOut = false;
		let log: ReturnType<typeof createWriteStream> | undefined;
		if (options.logFile) {
			mkdirSync(dirname(options.logFile), { recursive: true });
			log = createWriteStream(options.logFile);
		}
		const collect = (chunk: Buffer) => {
			const text = chunk.toString("utf8");
			output += text;
			log?.write(text);
		};
		child.stdout.on("data", collect);
		child.stderr.on("data", collect);
		const timer = setTimeout(() => {
			timedOut = true;
			killGroup(child.pid, "SIGKILL");
		}, options.timeoutMs ?? 600_000);
		child.once("error", (error) => {
			clearTimeout(timer);
			log?.end();
			reject(error);
		});
		child.once("close", (code, signal) => {
			clearTimeout(timer);
			log?.end();
			resolve({
				command: [command, ...args],
				env,
				code,
				signal,
				output,
				durationMs: Date.now() - started,
				timedOut,
			});
		});
	});
}

/** Signal a detached child's whole process group; ignore a finished group. */
export function killGroup(
	pid: number | undefined,
	signal: NodeJS.Signals,
): void {
	if (pid === undefined) return;
	try {
		process.kill(-pid, signal);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}

/**
 * Absolute path of an installed package's bin script, read from its manifest,
 * so tools run as `node <bin>` without shell shims.
 */
export function binPath(
	consumerRoot: string,
	packageName: string,
	binName = packageName.split("/").pop() ?? packageName,
): string {
	const packageDir = join(consumerRoot, "node_modules", packageName);
	const manifest = JSON.parse(
		readFileSync(join(packageDir, "package.json"), "utf8"),
	) as { bin?: string | Record<string, string> };
	const bin =
		typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[binName];
	if (!bin) throw new Error(`${packageName} has no bin named ${binName}`);
	return join(packageDir, bin);
}

/**
 * Tool invocations per bundler. Paths are relative to the
 * consumer. Astro builds into `dist/` (its default), served statically.
 */
export function buildCommand(
	consumerRoot: string,
	bundler: "vite" | "webpack" | "rspack" | "astro",
	out: string,
): { command: string; args: string[] } {
	switch (bundler) {
		case "astro":
			return {
				command: process.execPath,
				args: [binPath(consumerRoot, "astro"), "build"],
			};
		case "vite":
			return {
				command: process.execPath,
				args: [
					binPath(consumerRoot, "vite"),
					"build",
					"--outDir",
					out,
					"--emptyOutDir",
				],
			};
		case "webpack":
			return {
				command: process.execPath,
				args: [
					binPath(consumerRoot, "webpack-cli", "webpack-cli"),
					"build",
					"--config",
					"webpack.config.mjs",
				],
			};
		case "rspack":
			return {
				command: process.execPath,
				args: [
					binPath(consumerRoot, "@rspack/cli", "rspack"),
					"build",
					"--config",
					"rspack.config.mjs",
				],
			};
	}
}

/** `next build`, with `--webpack` for the Next webpack cells. */
export function nextBuildCommand(
	appRoot: string,
	webpack: boolean,
): { command: string; args: string[] } {
	return {
		command: process.execPath,
		args: [
			binPath(appRoot, "next"),
			"build",
			...(webpack ? ["--webpack"] : []),
		],
	};
}

export function installedVersion(
	consumerRoot: string,
	packageName: string,
): string | undefined {
	try {
		const manifest = JSON.parse(
			readFileSync(
				join(consumerRoot, "node_modules", packageName, "package.json"),
				"utf8",
			),
		) as { version?: string };
		return manifest.version;
	} catch {
		return undefined;
	}
}
