import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { spinetabClosure } from "../../performance/size/attribute.ts";

// the allowed-source closure of the size harness must follow the
// dist files' bare self-imports (`spinetab`, `spinetab/<sub>`) through the
// packed manifest's exports and must ignore import text inside comments.

const pkg = fileURLToPath(new URL("../../../", import.meta.url));
const CORE = [".", "runtime", "worker"];

describe("the packed package's own closure (repro, candidate dist)", () => {
	it("dist/index.js reaches spinetab/wiring by a bare self-import", () => {
		const text = readFileSync(join(pkg, "dist/index.js"), "utf8");
		expect(text).toMatch(/from\s*["']spinetab\/wiring["']/);
	});

	it("the core closure includes the wiring module the root entry imports", () => {
		const allowed = spinetabClosure(pkg, CORE);
		expect(allowed.has("dist/wiring.js")).toBe(true);
		expect(allowed.has("src/wiring.ts")).toBe(true);
	});

	it("control: an explicitly selected wiring subpath is allowed", () => {
		const allowed = spinetabClosure(pkg, [...CORE, "wiring"]);
		expect(allowed.has("src/wiring.ts")).toBe(true);
	});

	it("auto/worker reaches worker-config through its bare self-import", () => {
		const allowed = spinetabClosure(pkg, ["auto/worker"]);
		expect(allowed.has("dist/worker-config.js")).toBe(true);
	});

	it("a JSDoc example import in dist/worker.js is not followed", () => {
		const text = readFileSync(join(pkg, "dist/worker.js"), "utf8");
		expect(text).toContain('import("./live.worker")');
		expect(spinetabClosure(pkg, ["worker"]).has("dist/live.worker")).toBe(
			false,
		);
	});
});

describe("closure rules (synthetic package)", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0))
			rmSync(dir, { recursive: true, force: true });
	});

	/** A packed-looking package: `files` under the package root, plus maps. */
	const fixture = (
		exports: Record<string, unknown>,
		files: Record<string, string>,
		maps: Record<string, string[]> = {},
	) => {
		const dir = mkdtempSync(join(tmpdir(), "spinetab-size-closure-c7-"));
		dirs.push(dir);
		writeFileSync(join(dir, "package.json"), JSON.stringify({ exports }));
		for (const [file, code] of Object.entries(files)) {
			mkdirSync(dirname(join(dir, file)), { recursive: true });
			writeFileSync(join(dir, file), code);
		}
		for (const [file, sources] of Object.entries(maps)) {
			writeFileSync(
				join(dir, `${file}.map`),
				JSON.stringify({ version: 3, sources, mappings: "" }),
			);
		}
		return dir;
	};

	const exports = {
		".": { import: { types: "./dist/index.d.ts", default: "./dist/index.js" } },
		"./wiring": { import: { default: "./dist/wiring.js" } },
		"./extra": { import: "./dist/extra.js" },
		"./other": { import: { default: "./dist/other.js" } },
	};

	it("follows `spinetab/<sub>` and bare `spinetab` through the exports, maps included", () => {
		const dir = fixture(
			exports,
			{
				"dist/index.js": 'import { wiring } from "spinetab/wiring";\n',
				"dist/wiring.js": 'export * from "./seam-A.js";\n',
				"dist/seam-A.js": "export const wiring = 1;\n",
				"dist/extra.js":
					'import "spinetab";\nexport const x = await import("spinetab/other");\n',
				"dist/other.js": "export const other = 1;\n",
			},
			{ "dist/wiring.js": ["../src/wiring.ts"] },
		);
		expect([...spinetabClosure(dir, ["."])].sort()).toEqual([
			"dist/index.js",
			"dist/seam-A.js",
			"dist/wiring.js",
			"src/wiring.ts",
		]);
		expect([...spinetabClosure(dir, ["extra"])].sort()).toEqual([
			"dist/extra.js",
			"dist/index.js",
			"dist/other.js",
			"dist/seam-A.js",
			"dist/wiring.js",
			"src/wiring.ts",
		]);
	});

	it("ignores import text in line, block and JSDoc comments", () => {
		const dir = fixture(exports, {
			"dist/index.js": [
				'// import "./ghost.js";',
				'/* export * from "./phantom.js"; */',
				"/**",
				' * import { live } from "spinetab/other";',
				' * const local = () => import("./lazy.js");',
				" */",
				'const text = "import \\"./quoted.js\\"";',
				"export const real = text;",
				"",
			].join("\n"),
			"dist/ghost.js": "",
			"dist/phantom.js": "",
			"dist/lazy.js": "",
			"dist/quoted.js": "",
			"dist/other.js": "",
		});
		expect([...spinetabClosure(dir, ["."])]).toEqual(["dist/index.js"]);
	});

	it("does not follow peer or built-in specifiers", () => {
		const dir = fixture(exports, {
			"dist/index.js":
				'import "graphql-ws";\nimport "spinetab-extra";\nimport "node:fs";\nimport "@spinetab/x";\n',
		});
		expect([...spinetabClosure(dir, ["."])]).toEqual(["dist/index.js"]);
	});

	it("fails closed on a self-import the manifest does not export", () => {
		const dir = fixture(exports, {
			"dist/index.js": 'import "spinetab/missing";\n',
		});
		expect(() => spinetabClosure(dir, ["."])).toThrow(
			/spinetab\/missing .*dist\/index\.js.*not found in the packed manifest/,
		);
	});

	it("fails closed on a file whose imports cannot be read", () => {
		const dir = fixture(exports, {
			"dist/index.js": 'import "./a.js";\n/* never closed\n',
		});
		expect(() => spinetabClosure(dir, ["."])).toThrow(
			/dist\/index\.js: imports could not be read/,
		);
	});
});
