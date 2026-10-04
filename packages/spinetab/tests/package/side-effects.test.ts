import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	allowlistedSelfImports,
	ENTRY_RULES,
	isBareSpecifier,
} from "./allowlist.ts";
import { distDir, packageRoot, specifierOf, targets } from "./dist.ts";
import { closureOf, distRelative } from "./graph.ts";

/** Load peers before installing spies so their import effects are not attributed to Spinetab. Package self-imports remain under the spies. */
const selfImports = new Set(allowlistedSelfImports());
const probe = fileURLToPath(new URL("./import-probe.ts", import.meta.url));

interface ProbeResult {
	calls: Record<string, number>;
	added: string[];
	addedSymbols: string[];
	error: { code?: string; message: string } | null;
	exportsCount: number;
}

function runProbe(
	mode: "import" | "require",
	specifier: string,
	peers: string[],
	marker?: string,
) {
	return JSON.parse(
		execFileSync(
			process.execPath,
			[probe, mode, specifier, peers.join(","), ...(marker ? [marker] : [])],
			{ cwd: packageRoot, encoding: "utf8" },
		),
	) as ProbeResult;
}

describe("Node import side effects", () => {
	for (const target of targets()) {
		const specifier = specifierOf(target.subpath);
		const modes: Array<["import" | "require", string]> = [
			["import", target.import.default],
		];
		if (target.require) modes.push(["require", target.require.default]);
		for (const [mode, file] of modes) {
			it(`${mode} ${specifier} (${ENTRY_RULES[target.subpath]?.realm ?? "no rule"}) has no effect`, () => {
				expect(ENTRY_RULES[target.subpath], "allow-list rule").toBeDefined();
				const peers = [...closureOf(distDir, distRelative(file)).bare.keys()]
					.filter(isBareSpecifier)
					.filter((peer) => !selfImports.has(peer));
				const result = runProbe(mode, specifier, peers);
				expect(result.error).toBeNull();
				expect(result.exportsCount).toBeGreaterThan(0);
				expect(result.calls).toEqual({});
				expect(result.added).toEqual([]);
				expect(result.addedSymbols).toEqual([]);
			});
		}
	}
});

describe("the probe bites (control)", () => {
	// A space and a non-ASCII character make ESM frames (percent-encoded
	// `file:` URLs) and CommonJS frames (raw paths) spell the directory
	// differently; the probe must attribute both.
	const dir = join(packageRoot, "test-results/side-effects control ü");
	const marker = `${dir}/`;

	function fixture() {
		rmSync(dir, { recursive: true, force: true });
		mkdirSync(dir, { recursive: true });
		const effects = join(dir, "effects.mjs");
		writeFileSync(
			effects,
			[
				'import fs, { writeFileSync } from "node:fs";',
				'writeFileSync(new URL("./sync.txt", import.meta.url), "x");',
				'await fs.promises.writeFile(new URL("./promise.txt", import.meta.url), "x");',
				"export const home = process.env.HOME;",
				"",
			].join("\n"),
		);
		const cjs = join(dir, "effects.cjs");
		writeFileSync(
			cjs,
			[
				'const { mkdirSync } = require("node:fs");',
				'mkdirSync(require("node:path").join(__dirname, "made"), { recursive: true });',
				'exports.keys = "SPINETAB_PROBE" in process.env;',
				"",
			].join("\n"),
		);
		return { effects, cjs };
	}

	it("counts fs writes and process.env reads made at import", () => {
		const { effects, cjs } = fixture();
		const esm = runProbe("import", pathToFileURL(effects).href, [], marker);
		expect(esm.error).toBeNull();
		expect(esm.calls["fs.writeFileSync"]).toBe(1);
		expect(esm.calls["fs.promises.writeFile"]).toBe(1);
		expect(esm.calls["process.env"]).toBeGreaterThanOrEqual(1);
		const required = runProbe("require", cjs, [], marker);
		expect(required.error).toBeNull();
		expect(required.calls["fs.mkdirSync"]).toBe(1);
		expect(required.calls["process.env"]).toBeGreaterThanOrEqual(1);
	});
});

/**
 * `defineWorker` called outside a SharedWorker global
 * registers nothing. The browser page and module worker run the fixture's
 * `define-worker.js` probe (consumers-side-effects.spec.ts); this checks the
 * probe against the built `defineWorker` and shows that it detects a listener.
 */
describe("condition 2: the defineWorker probe", () => {
	type Probe = (
		defineWorker: (adapters: () => readonly never[]) => () => unknown,
		snapshot: () => { calls: Record<string, number> },
	) => { calls: Record<string, number>; factory: string; onconnect: string };

	async function load() {
		const fixture = join(
			packageRoot,
			"tests/fixtures/consumers/side-effects/src/define-worker.js",
		);
		const { probeDefineWorker } = (await import(
			pathToFileURL(fixture).href
		)) as { probeDefineWorker: Probe };
		const { defineWorker } = (await import(
			pathToFileURL(join(distDir, "worker.js")).href
		)) as { defineWorker: Parameters<Probe>[0] };
		const calls: Record<string, number> = {};
		vi.stubGlobal("addEventListener", () => {
			calls.addEventListener = (calls.addEventListener ?? 0) + 1;
		});
		const snapshot = () => {
			const result = { calls: { ...calls } };
			for (const key of Object.keys(calls)) delete calls[key];
			return result;
		};
		return () => probeDefineWorker(defineWorker, snapshot);
	}

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it(".2: in a page-like global it registers nothing and returns the factory", async () => {
		const probe = await load();
		expect(probe()).toEqual({
			calls: {},
			factory: "function",
			onconnect: "undefined",
		});
	});

	it(".2: the probe bites: a SharedWorker global gets one connect listener", async () => {
		vi.stubGlobal(
			"SharedWorkerGlobalScope",
			Object.defineProperty(() => undefined, Symbol.hasInstance, {
				value: (value: unknown) => value === globalThis,
			}),
		);
		const probe = await load();
		expect(probe().calls).toEqual({ addEventListener: 1 });
	});
});
