import { spawnSync } from "node:child_process";
import {
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NPM_HOISTED_CELL } from "./catalogue.ts";
import { packDir, workRoot } from "./paths.ts";
import { assertFreshPack, type PackRecord } from "./prepare.ts";
import { childEnv, run } from "./run.ts";

/**
 * Hoisted npm install control cell. pnpm's
 * isolated layout is not the only one consumers use: with npm's flat
 * `node_modules` the root entry's bare `spinetab/wiring` self-import must
 * still resolve inside the installed package, to the inert default
 * (`wiring === undefined`) that the plugin replaces. Offline and without
 * scripts: the tarball has no dependencies and every peer is optional.
 */
const CHECK = `import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const kind = (value) => (value === undefined ? "undefined" : typeof value);
const esmRoot = await import("spinetab");
const esmWiring = await import("spinetab/wiring");
const cjsRoot = require("spinetab");
const cjsWiring = require("spinetab/wiring");
const where = (specifier) => realpathSync(fileURLToPath(import.meta.resolve(specifier)));
process.stdout.write(JSON.stringify({
	esm: { root: where("spinetab"), wiring: where("spinetab/wiring"), createSpinetab: kind(esmRoot.createSpinetab), names: Object.keys(esmWiring).sort(), value: kind(esmWiring.wiring) },
	cjs: { root: realpathSync(require.resolve("spinetab")), wiring: realpathSync(require.resolve("spinetab/wiring")), createSpinetab: kind(cjsRoot.createSpinetab), names: Object.keys(cjsWiring).sort(), value: kind(cjsWiring.wiring) },
	status: esmRoot.createSpinetab().status.get(),
	server: esmRoot.SERVER_STATUS,
}));
`;

interface Side {
	root: string;
	wiring: string;
	createSpinetab: string;
	names: string[];
	value: string;
}

let record: PackRecord;
const root = join(workRoot(), NPM_HOISTED_CELL.dir);

beforeAll(() => {
	record = assertFreshPack("consumers:npm");
});

afterAll(() => {
	assertFreshPack("consumers:npm (end)");
});

describe(`${NPM_HOISTED_CELL.id} control cell`, () => {
	it("resolves the root's spinetab/wiring self-import to the inert default from ESM and CommonJS", async () => {
		rmSync(root, { recursive: true, force: true });
		mkdirSync(root, { recursive: true });
		writeFileSync(
			join(root, "package.json"),
			`${JSON.stringify({ name: "consumer-npm-hoisted", version: "0.0.0", private: true }, null, "\t")}\n`,
		);
		writeFileSync(join(root, "check.mjs"), CHECK);
		// npm reads `npm_config_*` from the environment; the pnpm script
		// running this suite sets some, so the child gets none of them.
		const env = Object.fromEntries(
			Object.entries(childEnv()).filter(
				([key]) => !/^npm_(config|package)_/i.test(key),
			),
		);
		const install = spawnSync(
			"npm",
			[
				"install",
				"--ignore-scripts",
				"--no-audit",
				"--no-fund",
				"--offline",
				"--install-strategy=hoisted",
				"--cache",
				join(root, ".npm-cache"),
				join(packDir(), record.file),
			],
			{ cwd: root, env, encoding: "utf8", timeout: 120_000 },
		);
		const installLog = `${install.stdout ?? ""}${install.stderr ?? ""}`;
		writeFileSync(join(root, "install.log"), installLog);
		expect(install.status, installLog).toBe(0);
		// A real directory in a flat node_modules, not a pnpm link.
		const installed = join(root, "node_modules/spinetab");
		expect(lstatSync(installed).isDirectory()).toBe(true);
		const lock = JSON.parse(
			readFileSync(join(root, "package-lock.json"), "utf8"),
		) as { packages: Record<string, { integrity?: string }> };
		expect(lock.packages["node_modules/spinetab"]?.integrity).toBe(
			record.integrity,
		);
		// The installed root imports its seam by the bare self-import.
		expect(readFileSync(join(installed, "dist/index.js"), "utf8")).toContain(
			'from "spinetab/wiring"',
		);
		expect(readFileSync(join(installed, "dist/index.cjs"), "utf8")).toContain(
			'require("spinetab/wiring")',
		);

		const result = await run(process.execPath, ["check.mjs"], {
			cwd: root,
			timeoutMs: 60_000,
			logFile: join(root, "check.log"),
		});
		expect(result.code, result.output).toBe(0);
		const report = JSON.parse(
			result.output.slice(result.output.indexOf("{")),
		) as {
			esm: Side;
			cjs: Side;
			status: unknown;
			server: unknown;
		};
		const dist = realpathSync(join(installed, "dist"));
		for (const [format, side, ext] of [
			["esm", report.esm, "js"],
			["cjs", report.cjs, "cjs"],
		] as const) {
			expect(side.root, format).toBe(join(dist, `index.${ext}`));
			expect(side.wiring, format).toBe(join(dist, `wiring.${ext}`));
			expect(side.createSpinetab, format).toBe("function");
			expect(side.names, format).toEqual(["wiring"]);
			expect(side.value, `${format}: the inert default`).toBe("undefined");
		}
		// Node is the server realm: construction stays inert.
		expect(report.status).toEqual(report.server);
	});
});
