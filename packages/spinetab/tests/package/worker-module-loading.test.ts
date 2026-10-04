import {
	copyFileSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FrontLog, LoggedRequest } from "./consumers/front.ts";
import {
	chunkRequests,
	namesChunk,
	requestRealm,
	requestsFor,
} from "./consumers/requests.ts";
import { WORKER_EXPRESSION } from "./consumers/workarounds.ts";

const packageRoot = join(import.meta.dirname, "../..");
const dist = join(packageRoot, "dist");
const fixtures = join(packageRoot, "tests/fixtures/consumers");

let at = 0;
function request(
	path: string,
	dest: string | null,
	referrer: string | null,
): LoggedRequest {
	at += 1;
	return {
		method: "GET",
		path,
		dest,
		referrer,
		status: 200,
		csp: null,
		bytes: 1,
		at,
		contentType: null,
		contentTypeOptions: null,
	};
}
const log = (requests: LoggedRequest[]): FrontLog => ({
	requests,
	proxied: {},
	misrouted: [],
});

describe("requests.ts", () => {
	it("Next one-file: the worker's importScripts of the shared module is worker realm; the page's fetch of it is page realm", () => {
		const fallback = "static/chunks/0mwv.js";
		const worker = request(
			"/_next/static/chunks/turbopack-worker-x.js?v=1",
			"sharedworker",
			"/",
		);
		const imported = request(
			"/_next/static/chunks/0mwv.js",
			"script",
			"/_next/static/chunks/turbopack-worker-x.js",
		);
		const shared = log([worker, imported]);
		expect(requestsFor(shared, [fallback], "page")).toEqual([]);
		// The bug the shared-mode proof exists for: the page downloads it too.
		const leaked = request("/_next/static/chunks/0mwv.js", "script", "/");
		const both = log([worker, imported, leaked]);
		expect(chunkRequests(both, [fallback], "page")).toEqual([leaked]);
		expect(requestRealm(both).get(imported)).toBe("worker");
	});

	it("Vite dev one-file: the ?worker_file entry and the page's bare lazy import split by realm", () => {
		const file = "src/live.worker.js";
		const entry = request(
			"/src/live.worker.js?worker_file&type=module",
			"sharedworker",
			"/",
		);
		const lazy = request("/src/live.worker.js", "script", "/src/main.js");
		expect(requestsFor(log([entry]), [file], "page")).toEqual([]);
		expect(requestsFor(log([entry, lazy]), [file], "page")).toEqual([
			"/src/live.worker.js",
		]);
	});

	it("a missing Sec-Fetch-Dest or Referer fails closed (counted as page)", () => {
		const worker = request("/assets/live.worker-1.js", null, null);
		expect(
			requestsFor(log([worker]), ["assets/live.worker-1.js"], "page"),
		).toHaveLength(1);
	});

	it("never matches by base name alone", () => {
		expect(namesChunk("/assets/live.worker-1.js", "live.worker-1.js")).toBe(
			true,
		);
		expect(
			namesChunk("/other/live.worker-1.js", "assets/live.worker-1.js"),
		).toBe(false);
		expect(namesChunk("/17.js", "7.js")).toBe(false);
		// Output-root chunks (webpack `7.js`) have no directory to anchor on.
		expect(namesChunk("/nested/7.js", "7.js")).toBe(true);
	});
});

const SPECIFIERS: Record<string, string> = {
	"spinetab/worker": "worker.js",
	"spinetab/polling/runtime": "polling/runtime.js",
	"spinetab/sse/runtime": "sse/runtime.js",
	"spinetab/websocket/runtime": "websocket/runtime.js",
	"spinetab/ai-sdk/runtime": "ai-sdk/runtime.js",
};

/** Copy a fixture worker module into a temp dir with dist specifiers. */
function stage(fixture: string, file: string, extra: string[] = []): string {
	const dir = mkdtempSync(join(tmpdir(), "spinetab-verify-"));
	staged.push(dir);
	let text = readFileSync(join(fixtures, fixture, file), "utf8");
	for (const [specifier, target] of Object.entries(SPECIFIERS)) {
		text = text.replaceAll(
			`"${specifier}"`,
			JSON.stringify(pathToFileURL(join(dist, target)).href),
		);
	}
	text = text.replace('from "./protocol"', 'from "./protocol.ts"');
	const name = file.split("/").pop() as string;
	writeFileSync(join(dir, name), text);
	for (const other of extra) {
		copyFileSync(
			join(fixtures, fixture, other),
			join(dir, other.split("/").pop() as string),
		);
	}
	return join(dir, name);
}
const staged: string[] = [];

afterEach(() => {
	vi.unstubAllGlobals();
	for (const dir of staged.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

// The one-file fixtures after the plugin wave:
// `react-ai-sdk` on Vite, webpack and Rspack, `next-ai` on Next.
describe("one-file worker modules in a page realm", () => {
	for (const [fixture, file, extra] of [
		["react-ai-sdk", "src/live.worker.js", []],
		["next-ai", "app/live.worker.ts", []],
	] as const) {
		it(`${fixture}: importing the worker module in a page registers no listener and yields the local factory`, async () => {
			const addEventListener = vi.fn();
			vi.stubGlobal("addEventListener", addEventListener);
			const path = stage(fixture, file, [...extra]);
			const module = (await import(pathToFileURL(path).href)) as {
				default: () => { dispose?: () => void };
			};
			expect(addEventListener).not.toHaveBeenCalled();
			expect((globalThis as { onconnect?: unknown }).onconnect).toBeUndefined();
			expect(typeof module.default).toBe("function");
			const runtime = module.default();
			expect(runtime).toBeTruthy();
			runtime.dispose?.();
			expect(addEventListener).not.toHaveBeenCalled();
		});
	}

	it("react-ai-sdk: the same module serves once in a SharedWorker global", async () => {
		const addEventListener = vi.fn();
		const SharedWorkerGlobalScope = Object.defineProperty(
			() => undefined,
			Symbol.hasInstance,
			{ value: (value: unknown) => value === globalThis },
		);
		vi.stubGlobal("SharedWorkerGlobalScope", SharedWorkerGlobalScope);
		vi.stubGlobal("addEventListener", addEventListener);
		const path = stage("react-ai-sdk", "src/live.worker.js");
		await import(pathToFileURL(path).href);
		expect(addEventListener.mock.calls.map((call) => call[0])).toEqual([
			"connect",
		]);
	});
});

describe("fixture recipes", () => {
	it("one-file fixtures: no name, no live.local/live.adapters, local imports the worker module", () => {
		for (const [fixture, dir, ext, entry] of [
			["react-ai-sdk", "src", "js", "src/main.js"],
			["next-ai", "app", "ts", "app/chat-view.tsx"],
		] as const) {
			const text = readFileSync(join(fixtures, fixture, entry), "utf8");
			expect(text, fixture).toMatch(WORKER_EXPRESSION);
			expect(text, fixture).not.toMatch(/name:\s*["']/);
			expect(text, fixture).toMatch(
				/local:\s*\(\)\s*=>\s*import\(["']\.\/live\.worker(\.js)?["']\)/,
			);
			expect(
				existsSync(join(fixtures, fixture, dir, `live.local.${ext}`)),
			).toBe(false);
			expect(
				existsSync(join(fixtures, fixture, dir, `live.adapters.${ext}`)),
			).toBe(false);
			expect(
				readFileSync(
					join(fixtures, fixture, dir, `live.worker.${ext}`),
					"utf8",
				),
			).toMatch(/export default defineWorker\(\(\) => \[/);
		}
	});

	it("next-app live.ts is not a client module and the bound variant imports it from a Server Component", () => {
		const live = readFileSync(join(fixtures, "next-app/app/live.ts"), "utf8");
		expect(live).not.toMatch(/^\s*["']use client["']/);
		expect(live).toMatch(/bindClient\(spinetab\)/);
		const bound = readFileSync(
			join(fixtures, "next-negative/variants/bound/page.tsx"),
			"utf8",
		);
		expect(bound).not.toMatch(/["']use client["']/);
		expect(bound).toMatch(/from "\.\/live"/);
	});

	it("pinned update line is restored verbatim", () => {
		const check = readFileSync(
			join(fixtures, "vanilla-polling/types/check.ts"),
			"utf8",
		);
		expect(check).toContain(
			'subscription.update({ intervalMs: slower.intervalMs, onJoin: "await" });',
		);
	});

	it("the worker expression refuses another literal name", () => {
		const base = `new SharedWorker(new URL("./live.worker.js", import.meta.url), { type: "module"`;
		expect(`${base} })`).toMatch(WORKER_EXPRESSION);
		expect(`${base}, name: "spinetab" })`).toMatch(WORKER_EXPRESSION);
		expect(`${base}, name: "other" })`).not.toMatch(WORKER_EXPRESSION);
	});
});
