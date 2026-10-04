import { type ChildProcess, spawn } from "node:child_process";
import {
	closeSync,
	cpSync,
	createWriteStream,
	existsSync,
	mkdirSync,
	openSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { appRoot, type Bundler, consumer, type Mode } from "./catalogue.ts";
import {
	type Front,
	type FrontLog,
	type FrontOptions,
	startFront,
} from "./front.ts";
import { consumerDir } from "./paths.ts";
import { binPath, killGroup } from "./run.ts";

/**
 * Cell launcher. A production cell of Vite, webpack or
 * Rspack is a static front; development and Next cells spawn the upstream in
 * its own process group, wait until it answers, and put the front in front
 * of it. `stop()` closes the front, then SIGTERM → SIGKILL (5 s) on the group.
 *
 * Evidence per start: `upstream-<n>.log` (append-only, never an
 * earlier start's) and `readiness-<n>.json` (every probe status, the first
 * 4 KiB of each distinct >= 400 body). A Next dev cell starts without
 * `<distDir>/dev`, treats any 5xx during readiness as a failure, and on
 * failure copies Next's development log and trace to `next-dev-<n>/`.
 */
export interface CellOptions {
	id: string;
	consumer: string;
	bundler: Bundler;
	mode: Mode;
	frontPort: number;
	upstreamPort?: number;
	/** Static output directory relative to the consumer (production). */
	out?: string;
	/** Next build directory (`next start`). */
	distDir?: string;
	env?: Record<string, string>;
	front?: Omit<FrontOptions, "port" | "static" | "upstream">;
	/** Path whose response proves readiness (default: the mount root). */
	readyPath?: string;
	/**
	 * Next workspace cells: run the CLI from the consumer root with the app
	 * directory as its argument (`next dev apps/web`).
	 */
	fromRoot?: boolean;
	/**
	 * Keep `<distDir>/dev` from an earlier start (a warm restart, for the
	 * clean-start gate only). Default: every Next dev cell starts cold.
	 */
	warm?: boolean;
	evidence: string;
}

export interface RunningCell {
	readonly origin: string;
	readonly front: Front;
	log(): FrontLog;
	command: string[];
	env: Record<string, string>;
	/** The upstream's readiness probes (null for a static front). */
	readiness: Readiness | null;
	stop(): Promise<void>;
}

export async function startCell(options: CellOptions): Promise<RunningCell> {
	const spec = consumer(options.consumer);
	const consumerRoot = consumerDir(options.consumer);
	const root = appRoot(spec, consumerRoot);
	const isNext =
		options.bundler === "next" || options.bundler === "next-webpack";
	const nextDev = isNext && options.mode === "dev";
	const upstreamNeeded = options.mode === "dev" || isNext;
	if (options.fromRoot && !(isNext && spec.appDir)) {
		throw new Error(`${options.id}: fromRoot needs a Next workspace consumer`);
	}
	let child: ChildProcess | undefined;
	let command: string[] = [];
	let readiness: Readiness | null = null;
	const env = { ...options.env };
	if (upstreamNeeded) {
		const port = options.upstreamPort ?? options.frontPort + 100;
		// A server left on the port (a leaked daemon, another run) would answer
		// the readiness probe while ours moved elsewhere or failed to bind.
		await assertPortFree(options.id, port);
		const devOutput = nextDev
			? nextDevOutput(root, options.distDir)
			: undefined;
		// a Next dev cell never inherits an earlier start's dev output.
		if (devOutput && !options.warm) clearNextDevOutput(devOutput);
		const upstream = upstreamCommand(root, options, port, env);
		const cwd = options.fromRoot ? consumerRoot : root;
		if (options.fromRoot && spec.appDir) {
			// `next dev apps/web` from the workspace root.
			upstream.args.splice(2, 0, spec.appDir);
		}
		command = [upstream.command, ...upstream.args];
		const start = openStartEvidence(options.evidence);
		const logFile = createWriteStream(start.log, { flags: "a" });
		child = spawn(upstream.command, upstream.args, {
			cwd,
			env: upstreamEnv(env),
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		});
		const tail = logTail();
		for (const stream of [child.stdout, child.stderr]) {
			stream?.pipe(logFile);
			stream?.on("data", tail.push);
		}
		const exited = new Promise<never>((_resolve, reject) => {
			child?.once("exit", (code, signal) => {
				// Output written just before exit may still be in the pipe.
				setTimeout(
					() =>
						reject(
							new Error(
								`${options.id}: upstream exited early (${code ?? signal}); see ${start.log}\n${tail.text()}`,
							),
						),
					200,
				);
			});
		});
		exited.catch(() => undefined);
		const mount = options.front?.mount ?? "/";
		const probing = new AbortController();
		const ready = waitForUrl(
			`http://127.0.0.1:${port}${options.readyPath ?? mount}`,
			nextDev ? 180_000 : 90_000,
			{
				failOn5xx: nextDev,
				tail: tail.text,
				signal: probing.signal,
				onRecord: (record) =>
					writeFileSync(
						start.readiness,
						`${JSON.stringify(record, null, "\t")}\n`,
					),
			},
		);
		// An early exit wins the race; the abandoned probe then stops quietly.
		ready.catch(() => undefined);
		try {
			readiness = await Promise.race([ready, exited]);
		} catch (error) {
			probing.abort();
			await stopChild(child);
			if (devOutput) {
				archiveNextDevLogs(
					devOutput,
					join(options.evidence, `next-dev-${start.n}`),
				);
			}
			throw error;
		}
	}
	let front: Front;
	try {
		front = await startFront({
			...options.front,
			port: options.frontPort,
			...(upstreamNeeded
				? {
						upstream: `http://127.0.0.1:${options.upstreamPort ?? options.frontPort + 100}`,
					}
				: { static: join(root, options.out ?? "dist") }),
		});
	} catch (error) {
		await stopChild(child);
		throw error;
	}
	let stopped: Promise<void> | undefined;
	return {
		origin: front.origin,
		front,
		log: () => front.log(),
		command,
		env,
		readiness,
		stop: () => {
			stopped ??= (async () => {
				await front.close();
				await stopChild(child);
			})();
			return stopped;
		},
	};
}

/**
 * The upstream's environment: only the operating-system basics a
 * toolchain needs, then the cell's own variables and
 * `NEXT_TELEMETRY_DISABLED=1`. Nothing else of the test runner's reaches the
 * server: not Vitest's `NODE_ENV=test`, `NODE_OPTIONS` loaders, `NODE_PATH`
 * (see `childEnv`), agent markers or credentials.
 */
const INHERITED_ENV =
	/^(?:PATH|PATHEXT|HOME|USER|LOGNAME|SHELL|TMPDIR|TEMP|TMP|LANG|LANGUAGE|LC_[A-Z]+|TZ|CI|SYSTEMROOT|COMSPEC|WINDIR|APPDATA|LOCALAPPDATA|USERPROFILE|HOMEDRIVE|HOMEPATH|PROGRAMDATA|NUMBER_OF_PROCESSORS)$/i;

export function upstreamEnv(
	extra: Record<string, string>,
	source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(source)) {
		if (value !== undefined && INHERITED_ENV.test(key)) env[key] = value;
	}
	return { ...env, ...extra, NEXT_TELEMETRY_DISABLED: "1" };
}

/**
 * The next free start number in a cell's evidence directory, with its
 * upstream log created exclusively: a later start never truncates or
 * appends to an earlier start's log.
 */
export function openStartEvidence(evidence: string): {
	n: number;
	log: string;
	readiness: string;
} {
	mkdirSync(evidence, { recursive: true });
	for (let n = 1; ; n += 1) {
		const log = join(evidence, `upstream-${n}.log`);
		try {
			closeSync(openSync(log, "wx"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
			throw error;
		}
		return { n, log, readiness: join(evidence, `readiness-${n}.json`) };
	}
}

/** `<distDir>/dev`: everything `next dev` writes (Next 16 isolates it). */
export const nextDevOutput = (appRoot: string, distDir = ".next") =>
	join(appRoot, distDir, "dev");

/** Removes a Next dev output directory; production output stays. */
export function clearNextDevOutput(devOutput: string): void {
	rmSync(devOutput, { recursive: true, force: true });
}

/**
 * Copies Next's development log and trace (`<distDir>/dev/logs/
 * next-development.log`, `<distDir>/dev/trace`) into the cell evidence after
 * a failed start, so the failing session's own record survives the next
 * start's clean-up. Returns what was copied.
 */
export function archiveNextDevLogs(
	devOutput: string,
	target: string,
): string[] {
	const copied: string[] = [];
	for (const file of ["logs/next-development.log", "trace"]) {
		const source = join(devOutput, file);
		if (!existsSync(source)) continue;
		const destination = join(target, file);
		cpSync(source, destination, { recursive: true });
		copied.push(file);
	}
	return copied;
}

function upstreamCommand(
	root: string,
	options: CellOptions,
	port: number,
	env: Record<string, string>,
): { command: string; args: string[] } {
	const node = process.execPath;
	switch (options.bundler) {
		case "vite":
			return {
				command: node,
				args: [
					binPath(root, "vite"),
					"--host",
					"127.0.0.1",
					"--port",
					String(port),
					"--strictPort",
				],
			};
		case "webpack":
			env.CONSUMER_MODE = "development";
			env.CONSUMER_PORT = String(port);
			return {
				command: node,
				args: [
					binPath(root, "webpack-cli", "webpack-cli"),
					"serve",
					"--config",
					"webpack.config.mjs",
				],
			};
		case "rspack":
			env.CONSUMER_MODE = "development";
			env.CONSUMER_PORT = String(port);
			return {
				command: node,
				args: [
					binPath(root, "@rspack/cli", "rspack"),
					"dev",
					"--config",
					"rspack.config.mjs",
				],
			};
		case "next":
		case "next-webpack":
			if (options.distDir) env.CONSUMER_DIST_DIR = options.distDir;
			// `next start` serves what `next build [--webpack]` wrote; only the
			// dev server takes the bundler flag.
			return {
				command: node,
				args: [
					binPath(root, "next"),
					options.mode === "dev" ? "dev" : "start",
					...(options.mode === "dev" && options.bundler === "next-webpack"
						? ["--webpack"]
						: []),
					"-H",
					"127.0.0.1",
					"-p",
					String(port),
				],
			};
		case "astro":
			// Production Astro cells are static fronts over `dist/`.
			// Astro 7 backgrounds `astro dev` when it detects an agent and
			// exits 0, leaving a daemon outside our process group;
			// `--ignore-lock` keeps the server in the foreground, so `stop()`
			// ends it with the group and no lock file is written.
			return {
				command: node,
				args: [
					binPath(root, "astro"),
					"dev",
					"--ignore-lock",
					"--host",
					"127.0.0.1",
					"--port",
					String(port),
				],
			};
	}
}

/**
 * Fails when something still listens on the loopback port after 10 s (the
 * grace lets the previous engine's process group release it).
 */
async function assertPortFree(id: string, port: number): Promise<void> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		const server = createServer();
		const outcome = await new Promise<string | undefined>((resolve) => {
			server.once("error", (error: NodeJS.ErrnoException) =>
				resolve(error.code ?? String(error)),
			);
			server.listen(port, "127.0.0.1", () => resolve(undefined));
		});
		if (outcome === undefined) {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			return;
		}
		if (Date.now() >= deadline) {
			throw new Error(
				`${id}: upstream port ${port} is already in use (${outcome}); stop the process listening there and rerun`,
			);
		}
		await delay(250);
	}
}

/** The last 40 lines of the upstream output, for readiness errors. */
export function logTail(maxChars = 32_000): {
	push: (chunk: Buffer | string) => void;
	text: () => string;
} {
	let text = "";
	return {
		push: (chunk) => {
			text = (text + chunk.toString()).slice(-maxChars);
		},
		text: () => {
			const lines = text.trimEnd().split("\n").slice(-TAIL_LINES);
			return lines.length > 0 && lines[0] !== ""
				? `last ${lines.length} upstream lines:\n${lines.join("\n")}`
				: "no upstream output";
		},
	};
}

const TAIL_LINES = 40;
/** Bytes kept of a >= 400 response body. */
export const BODY_EXCERPT_BYTES = 4_096;

export interface ReadinessAttempt {
	/** Milliseconds since the first probe. */
	at: number;
	/** How long this probe took, to its status (and body excerpt). */
	ms?: number;
	status?: number;
	error?: string;
	/**
	 * The first 4 KiB of a >= 400 body, or the attempt number whose
	 * identical excerpt is already recorded.
	 */
	body?: string;
	sameBodyAs?: number;
}

export interface Readiness {
	url: string;
	startedAt: string;
	ready: boolean;
	attempts: ReadinessAttempt[];
}

export interface WaitOptions {
	/**
	 * Next dev: any 5xx is a recorded failure at once, never "not
	 * ready yet". Otherwise a status below 500 is ready and a 5xx is retried.
	 */
	failOn5xx?: boolean;
	/** The upstream's recent output, appended to a readiness error. */
	tail?: () => string;
	/** Receives the record of every probe, on success and on failure. */
	onRecord?: (record: Readiness) => void;
	/** Delay between probes (default 250 ms). */
	intervalMs?: number;
	/** Stops probing (the upstream exited while the probe was waiting). */
	signal?: AbortSignal;
}

/**
 * Probes `url` until it is ready, recording every status. A readiness
 * error names the statuses, the first 4 KiB of the >= 400 bodies and the
 * last 40 upstream lines.
 */
export async function waitForUrl(
	url: string,
	timeoutMs: number,
	options: WaitOptions = {},
): Promise<Readiness> {
	const started = Date.now();
	const deadline = started + timeoutMs;
	const record: Readiness = {
		url,
		startedAt: new Date(started).toISOString(),
		ready: false,
		attempts: [],
	};
	const bodies = new Map<string, number>();
	const fail = (reason: string): Error => {
		options.onRecord?.(record);
		return new Error(readinessError(record, reason, options.tail?.()));
	};
	while (Date.now() < deadline) {
		if (options.signal?.aborted)
			throw fail("was abandoned (the upstream exited)");
		const attempt: ReadinessAttempt = { at: Date.now() - started };
		record.attempts.push(attempt);
		let response: Response;
		const probeStarted = Date.now();
		try {
			response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
		} catch (error) {
			attempt.error = String(error);
			attempt.ms = Date.now() - probeStarted;
			await delay(options.intervalMs ?? 250);
			continue;
		}
		attempt.status = response.status;
		if (response.status >= 400) {
			const body = await bodyExcerpt(response);
			const seen = bodies.get(body);
			if (seen === undefined) {
				bodies.set(body, record.attempts.length);
				attempt.body = body;
			} else {
				attempt.sameBodyAs = seen;
			}
		} else {
			await response.body?.cancel().catch(() => undefined);
		}
		attempt.ms = Date.now() - probeStarted;
		if (response.status < 500) {
			record.ready = true;
			options.onRecord?.(record);
			return record;
		}
		if (options.failOn5xx) {
			throw fail(`answered ${response.status} during Next dev readiness`);
		}
		await delay(options.intervalMs ?? 250);
	}
	throw fail(`not ready within ${timeoutMs} ms`);
}

/** The first 4 KiB of a body, decoded as UTF-8; never throws. */
async function bodyExcerpt(response: Response): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) return "";
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (size < BODY_EXCERPT_BYTES) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			size += value.byteLength;
		}
	} catch (error) {
		chunks.push(new TextEncoder().encode(`\n(body read failed: ${error})`));
	} finally {
		await reader.cancel().catch(() => undefined);
	}
	const bytes = Buffer.concat(chunks).subarray(0, BODY_EXCERPT_BYTES);
	return new TextDecoder().decode(bytes);
}

/** The readiness error: reason, statuses, >= 400 bodies, upstream tail. */
export function readinessError(
	record: Readiness,
	reason: string,
	tail = "no upstream output",
): string {
	const statuses = record.attempts.map(
		(attempt) => `${attempt.at}ms ${attempt.status ?? attempt.error}`,
	);
	const shown =
		statuses.length > 12
			? [
					...statuses.slice(0, 6),
					`… ${statuses.length - 12} more …`,
					...statuses.slice(-6),
				]
			: statuses;
	const bodies = record.attempts
		.filter((attempt) => attempt.body !== undefined)
		.map(
			(attempt) =>
				`first ${BODY_EXCERPT_BYTES} bytes of the ${attempt.status} body at ${attempt.at}ms:\n${attempt.body}`,
		);
	return [
		`${record.url} ${reason} (${record.attempts.length} probes)`,
		`statuses: ${shown.join(", ")}`,
		...bodies,
		tail,
	].join("\n");
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
	if (!child || child.exitCode !== null || child.signalCode !== null) return;
	const exited = new Promise<"exited">((resolve) =>
		child.once("exit", () => resolve("exited")),
	);
	killGroup(child.pid, "SIGTERM");
	const grace = new AbortController();
	const timeout = delay(5_000, "timeout" as const, {
		signal: grace.signal,
	}).catch(() => "exited" as const);
	const outcome = await Promise.race([exited, timeout]);
	grace.abort();
	if (outcome === "timeout") {
		killGroup(child.pid, "SIGKILL");
		await exited;
	}
}
