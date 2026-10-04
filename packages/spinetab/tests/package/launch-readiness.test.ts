import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type StartResult,
	SUBJECTS,
	startResult,
	summarise,
} from "./consumers/clean-start.ts";
import {
	archiveNextDevLogs,
	BODY_EXCERPT_BYTES,
	clearNextDevOutput,
	logTail,
	nextDevOutput,
	openStartEvidence,
	type Readiness,
	upstreamEnv,
	waitForUrl,
} from "./consumers/launch.ts";

/**
 * The consumer launcher's readiness and evidence rules.
 * Failed readiness responses and earlier startup logs must be preserved even
 * when a later probe succeeds. These checks run in the
 * `package` project (no packed consumer needed) against a loopback server on
 * an ephemeral port.
 */

const servers: Server[] = [];
const dirs: string[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) {
		await new Promise<void>((done) => server.close(() => done()));
	}
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "spinetab-launch-"));
	dirs.push(dir);
	return dir;
}

/** Answers each request with the next scripted response (the last repeats). */
async function scripted(
	responses: { status: number; body: string }[],
): Promise<{ url: string; requests: () => number }> {
	let count = 0;
	const server = createServer((_request, response) => {
		const next = responses[Math.min(count, responses.length - 1)];
		count += 1;
		response.writeHead(next?.status ?? 500, { "content-type": "text/html" });
		response.end(next?.body ?? "");
	});
	servers.push(server);
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const { port } = server.address() as AddressInfo;
	return { url: `http://127.0.0.1:${port}/`, requests: () => count };
}

async function failure(run: () => Promise<unknown>): Promise<Error> {
	try {
		await run();
	} catch (error) {
		return error as Error;
	}
	throw new Error("expected a readiness failure");
}

const ERROR_PAGE = `<!DOCTYPE html><title>500</title><pre>Error: module factory is not available</pre>${"x".repeat(6_000)}AFTER-4-KIB`;

describe("waitForUrl records every status", () => {
	it("records a 500 then a 200, with the 500 body excerpt", async () => {
		const server = await scripted([
			{ status: 500, body: ERROR_PAGE },
			{ status: 200, body: "<h1>ok</h1>" },
		]);
		const records: Readiness[] = [];
		const record = await waitForUrl(server.url, 10_000, {
			intervalMs: 20,
			onRecord: (value) => records.push(value),
		});
		expect(record.ready).toBe(true);
		expect(record.attempts.map((attempt) => attempt.status)).toEqual([
			500, 200,
		]);
		expect(record.attempts[0]?.body).toBe(
			ERROR_PAGE.slice(0, BODY_EXCERPT_BYTES),
		);
		expect(record.attempts[0]?.body).toContain(
			"module factory is not available",
		);
		expect(record.attempts[1]?.body).toBeUndefined();
		for (const attempt of record.attempts) {
			expect(attempt.ms).toBeGreaterThanOrEqual(0);
		}
		expect(records).toEqual([record]);
	});

	it("a 5xx during Next dev readiness fails at once with the status, a 4 KiB excerpt and the last 40 upstream lines", async () => {
		const server = await scripted([
			{ status: 500, body: ERROR_PAGE },
			{ status: 200, body: "<h1>ok</h1>" },
		]);
		const tail = logTail();
		for (let line = 1; line <= 100; line += 1)
			tail.push(`upstream line ${line}\n`);
		const records: Readiness[] = [];
		const error = await failure(() =>
			waitForUrl(server.url, 10_000, {
				failOn5xx: true,
				intervalMs: 20,
				tail: tail.text,
				onRecord: (value) => records.push(value),
			}),
		);
		// Never "not ready yet": the 200 that followed was never requested.
		expect(server.requests()).toBe(1);
		expect(error.message).toContain(
			`${server.url} answered 500 during Next dev readiness (1 probes)`,
		);
		expect(error.message).toMatch(/statuses: \d+ms 500\n/);
		expect(error.message).toContain(ERROR_PAGE.slice(0, BODY_EXCERPT_BYTES));
		expect(error.message).not.toContain("AFTER-4-KIB");
		expect(error.message).toContain("last 40 upstream lines:");
		expect(error.message).toContain("upstream line 61\n");
		expect(error.message).toMatch(/upstream line 100$/);
		expect(error.message).not.toContain("upstream line 60\n");
		expect(records).toHaveLength(1);
		expect(records[0]?.ready).toBe(false);
		expect(records[0]?.attempts.map((attempt) => attempt.status)).toEqual([
			500,
		]);
	});

	it("keeps each distinct >= 400 body once and names the timeout", async () => {
		const server = await scripted([
			{ status: 404, body: "not yet" },
			{ status: 404, body: "not yet" },
			{ status: 503, body: "warming up" },
		]);
		const records: Readiness[] = [];
		// A 404 is an answer (ready, as before); only a 5xx is retried.
		const ready = await waitForUrl(server.url, 5_000, { intervalMs: 10 });
		expect(ready.attempts.map((attempt) => attempt.status)).toEqual([404]);
		const retried = await scripted([
			{ status: 503, body: "warming up" },
			{ status: 503, body: "warming up" },
		]);
		const error = await failure(() =>
			waitForUrl(retried.url, 300, {
				intervalMs: 20,
				tail: () => "no upstream output",
				onRecord: (value) => records.push(value),
			}),
		);
		expect(error.message).toContain(`${retried.url} not ready within 300 ms`);
		expect(error.message).toContain("warming up");
		expect(error.message).toContain("no upstream output");
		const attempts = records[0]?.attempts ?? [];
		expect(attempts.length).toBeGreaterThan(1);
		expect(attempts[0]?.body).toBe("warming up");
		expect(attempts[1]?.body).toBeUndefined();
		expect(attempts[1]?.sameBodyAs).toBe(1);
		expect(server.requests()).toBe(1);
	});

	it("records connection failures and stops when abandoned", async () => {
		const server = await scripted([{ status: 200, body: "" }]);
		const url = server.url;
		await new Promise<void>((done) => servers.pop()?.close(() => done()));
		const controller = new AbortController();
		const records: Readiness[] = [];
		const pending = failure(() =>
			waitForUrl(url, 10_000, {
				intervalMs: 20,
				signal: controller.signal,
				onRecord: (value) => records.push(value),
			}),
		);
		await new Promise((done) => setTimeout(done, 100));
		controller.abort();
		const error = await pending;
		expect(error.message).toContain("was abandoned (the upstream exited)");
		expect(records[0]?.attempts.length).toBeGreaterThan(0);
		expect(records[0]?.attempts[0]?.error).toBeDefined();
	});
});

describe("start evidence", () => {
	it("each start keeps its own upstream log and never truncates an earlier one", () => {
		const evidence = join(tempDir(), "cell");
		const first = openStartEvidence(evidence);
		writeFileSync(first.log, "first start: GET / 500\n");
		const second = openStartEvidence(evidence);
		expect([first.n, second.n]).toEqual([1, 2]);
		expect(second.log).toBe(join(evidence, "upstream-2.log"));
		expect(second.readiness).toBe(join(evidence, "readiness-2.json"));
		expect(readFileSync(first.log, "utf8")).toBe("first start: GET / 500\n");
		expect(readFileSync(second.log, "utf8")).toBe("");
	});

	it("<distDir>/dev is removed before a Next dev start; production output stays", () => {
		const app = tempDir();
		for (const file of [".next/dev/trace", ".next/static/chunks/a.js"]) {
			mkdirSync(join(app, file, ".."), { recursive: true });
			writeFileSync(join(app, file), "x");
		}
		expect(nextDevOutput(app)).toBe(join(app, ".next", "dev"));
		expect(nextDevOutput(app, ".next-dev")).toBe(join(app, ".next-dev", "dev"));
		clearNextDevOutput(nextDevOutput(app));
		expect(existsSync(join(app, ".next", "dev"))).toBe(false);
		expect(existsSync(join(app, ".next", "static", "chunks", "a.js"))).toBe(
			true,
		);
	});

	it("archives next-development.log and the trace of a failed start", () => {
		const dev = join(tempDir(), ".next", "dev");
		mkdirSync(join(dev, "logs"), { recursive: true });
		writeFileSync(join(dev, "logs", "next-development.log"), "GET / 500\n");
		writeFileSync(join(dev, "trace"), '[{"name":"compile-path"}]\n');
		const target = join(tempDir(), "next-dev-1");
		expect(archiveNextDevLogs(dev, target)).toEqual([
			"logs/next-development.log",
			"trace",
		]);
		expect(
			readFileSync(join(target, "logs", "next-development.log"), "utf8"),
		).toBe("GET / 500\n");
		expect(readFileSync(join(target, "trace"), "utf8")).toContain(
			"compile-path",
		);
		expect(archiveNextDevLogs(join(tempDir(), "none"), target)).toEqual([]);
	});
});

describe("upstream environment", () => {
	it("is allow-listed, with the cell's variables and NEXT_TELEMETRY_DISABLED=1", () => {
		const env = upstreamEnv(
			{ CONSUMER_MODE: "development", NEXT_TELEMETRY_DISABLED: "0" },
			{
				PATH: "/usr/bin",
				Path: "C:\\bin",
				HOME: "/home/ci",
				TMPDIR: "/tmp/ci",
				LC_ALL: "C",
				CI: "true",
				NODE_ENV: "test",
				NODE_OPTIONS: "--import ./loader.mjs",
				NODE_PATH: "/virtual-store",
				GITHUB_TOKEN: "secret",
				CUSTOM_TOOL_SESSION: "1",
				VITEST: "true",
				npm_config_registry: "https://registry.example",
			},
		);
		expect(env).toEqual({
			PATH: "/usr/bin",
			Path: "C:\\bin",
			HOME: "/home/ci",
			TMPDIR: "/tmp/ci",
			LC_ALL: "C",
			CI: "true",
			CONSUMER_MODE: "development",
			NEXT_TELEMETRY_DISABLED: "1",
		});
	});
});

describe("clean-start gate", () => {
	it("runs 's subjects: 20 cold and 10 warm next-app, 10 from the monorepo root, 10 no-plugin control", () => {
		expect(
			SUBJECTS.map(({ id, consumer, runs, warm, plugin }) => ({
				id,
				consumer,
				runs,
				warm,
				plugin,
			})),
		).toEqual([
			{
				id: "next-app-cold",
				consumer: "next-app",
				runs: 20,
				warm: false,
				plugin: true,
			},
			{
				id: "next-app-warm",
				consumer: "next-app",
				runs: 10,
				warm: true,
				plugin: true,
			},
			{
				id: "next-monorepo-from-root-cold",
				consumer: "next-monorepo",
				runs: 10,
				warm: false,
				plugin: true,
			},
			{
				id: "next-ai-control-cold",
				consumer: "next-ai",
				runs: 10,
				warm: false,
				plugin: false,
			},
		]);
	});

	it("records every status and the first answer, and fails a plugin subject on any 5xx", () => {
		const readiness = (statuses: number[]): Readiness => ({
			url: "http://127.0.0.1:4741/",
			startedAt: "2026-09-30T00:00:00.000Z",
			ready: statuses.at(-1) === 200,
			attempts: [
				{ at: 0, ms: 2, error: "TypeError: fetch failed" },
				...statuses.map((status, index) => ({
					at: 250 * (index + 1),
					ms: 900,
					status,
				})),
			],
		});
		const cold = startResult(
			{ subject: "next-app-cold", run: 0, kind: "cold" },
			readiness([200]),
			null,
		);
		expect(cold).toEqual({
			subject: "next-app-cold",
			run: 0,
			kind: "cold",
			ok: true,
			statuses: [200],
			first: { status: 200, ms: 900 },
			error: null,
		});
		const failed = startResult(
			{ subject: "next-app-cold", run: 1, kind: "cold" },
			null,
			"answered 500 during Next dev readiness",
		);
		const control: StartResult = {
			...startResult(
				{ subject: "next-ai-control-cold", run: 0, kind: "cold" },
				readiness([500, 200]),
				null,
			),
		};
		const prime = startResult(
			{ subject: "next-app-warm", run: 0, kind: "prime" },
			readiness([500]),
			"answered 500",
		);
		expect(summarise(SUBJECTS, [cold, control, prime])).toMatchObject({
			pass: true,
			rows: [
				{ subject: "next-app-cold", starts: 1, failed: 0, serverErrors: 0 },
				{ subject: "next-app-warm", starts: 0, failed: 0, serverErrors: 0 },
				{ subject: "next-monorepo-from-root-cold", starts: 0 },
				{ subject: "next-ai-control-cold", starts: 1, serverErrors: 1 },
			],
		});
		expect(summarise(SUBJECTS, [cold, failed]).pass).toBe(false);
	});
});
