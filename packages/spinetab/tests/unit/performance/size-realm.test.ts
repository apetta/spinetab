import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	categoryKey,
	classifySource,
	gzipBytes,
	spinetabClosure,
	spinetabGzip,
} from "../../performance/size/attribute.ts";
import { destinations, realmOf } from "../../performance/size/realm.ts";
import {
	type LoggedRequest,
	sameOriginPath,
} from "../../performance/size/static-server.ts";

const request = (
	path: string,
	dest: string,
	referrer: string | null,
	status = 200,
): LoggedRequest => ({ path, dest, referrer, status, bytes: 1 });

const realms = (shared: LoggedRequest[], local: LoggedRequest[] = []) => {
	const s = destinations(shared);
	const l = destinations(local);
	const paths = new Set([...s.keys(), ...l.keys()]);
	return Object.fromEntries(
		[...paths].map((path) => [
			path,
			realmOf(s.get(path) ?? new Set(), l.get(path) ?? new Set()),
		]),
	);
};

describe("realm classification", () => {
	it("counts a Turbopack worker's importScripts chunks as worker, not page", () => {
		const worker = "/_next/static/chunks/turbopack-worker-1.js";
		const log = [
			request("/", "document", null),
			request("/_next/static/chunks/page.js", "script", "/"),
			request("/_next/static/chunks/both.js", "script", "/"),
			request(worker, "sharedworker", "/"),
			request("/_next/static/chunks/runtime.js", "script", worker),
			request("/_next/static/chunks/host.js", "script", worker),
			request("/_next/static/chunks/both.js", "script", worker),
		];
		expect(realms(log)).toMatchObject({
			"/_next/static/chunks/page.js": "page",
			"/_next/static/chunks/both.js": "shared",
			[worker]: "worker",
			"/_next/static/chunks/runtime.js": "worker",
			"/_next/static/chunks/host.js": "worker",
		});
	});

	it("follows worker dynamic imports and keeps Vite's module-worker destinations", () => {
		const log = [
			request("/html/core.html", "document", null),
			request("/assets/index.js", "script", "/html/core.html"),
			request("/assets/worker.js", "sharedworker", "/html/core.html"),
			request("/assets/selected.js", "sharedworker", "/assets/worker.js"),
			request("/assets/lazy-in-worker.js", "script", "/assets/selected.js"),
			request("/assets/missing.js", "script", "/assets/worker.js", 404),
		];
		const local = [request("/assets/local.js", "script", "/assets/index.js")];
		expect(realms(log, local)).toMatchObject({
			"/assets/index.js": "page",
			"/assets/worker.js": "worker",
			"/assets/selected.js": "worker",
			"/assets/lazy-in-worker.js": "worker",
			"/assets/local.js": "lazy",
		});
		expect(destinations(log).has("/assets/missing.js")).toBe(false);
	});

	it("keeps page scripts without a worker referrer as page", () => {
		const log = [
			request("/a.js", "script", null),
			request("/b.js", "script", "/a.js"),
		];
		expect(realms(log)).toEqual({ "/a.js": "page", "/b.js": "page" });
	});

	it("reads only same-origin Referer paths", () => {
		expect(
			sameOriginPath("http://127.0.0.1:5173/w.js?x=1", "127.0.0.1:5173"),
		).toBe("/w.js");
		expect(sameOriginPath("http://evil.test/w.js", "127.0.0.1:5173")).toBe(
			null,
		);
		expect(sameOriginPath(undefined, "127.0.0.1:5173")).toBe(null);
		expect(sameOriginPath("not a url", "127.0.0.1:5173")).toBe(null);
	});
});

describe("allowed Spinetab sources", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0))
			rmSync(dir, { recursive: true, force: true });
	});

	const pkg = () => {
		const dir = mkdtempSync(join(tmpdir(), "spinetab-size-closure-"));
		dirs.push(dir);
		mkdirSync(join(dir, "dist"), { recursive: true });
		const write = (file: string, code: string, sources: string[]) => {
			writeFileSync(join(dir, "dist", file), code);
			writeFileSync(
				join(dir, "dist", `${file}.map`),
				JSON.stringify({ version: 3, sources, mappings: "" }),
			);
		};
		writeFileSync(
			join(dir, "package.json"),
			JSON.stringify({
				exports: {
					".": { import: "./dist/index.js" },
					"./websocket": { import: { default: "./dist/websocket.js" } },
				},
			}),
		);
		write("index.js", 'import "./client-A.js";', ["../src/index.ts"]);
		write("client-A.js", "", [
			"../src/core/client.ts",
			"../src/core/bridge.ts",
		]);
		write("websocket.js", 'import "./client-A.js";', [
			"../src/transports/websocket/index.ts",
		]);
		return dir;
	};

	it("allows the sources that selected dist files' maps list (Turbopack composes maps)", () => {
		const core = spinetabClosure(pkg(), ["."]);
		expect([...core].sort()).toEqual([
			"dist/client-A.js",
			"dist/index.js",
			"src/core/bridge.ts",
			"src/core/client.ts",
			"src/index.ts",
		]);
		// An unselected subpath's sources stay offending.
		expect(core.has("src/transports/websocket/index.ts")).toBe(false);
		const websocket = spinetabClosure(pkg(), [".", "websocket"]);
		expect(websocket.has("src/transports/websocket/index.ts")).toBe(true);
	});

	it("keys a composed Next source by its package-relative path", () => {
		const key = categoryKey(
			classifySource(
				"turbopack:///[project]/node_modules/.pnpm/spinetab@file+..+spinetab.tgz_x/node_modules/spinetab/src/core/client.ts",
			),
		);
		expect(key).toBe("spinetab:src/core/client.ts");
	});
});

describe("Spinetab-only gzip", () => {
	it("is zero for a realm without Spinetab spans", () => {
		expect(spinetabGzip([])).toBe(0);
		expect(spinetabGzip(["", "", ""])).toBe(0);
		expect(spinetabGzip(["", "abc", ""])).toBe(gzipBytes("abc"));
		expect(spinetabGzip(["abc", "def"])).toBe(gzipBytes("abc\ndef"));
	});
});
