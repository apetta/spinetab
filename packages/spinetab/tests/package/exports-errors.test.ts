import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { packageRoot, specifierOf, targets } from "./dist.ts";

/**
 * Unexported paths fail with `ERR_PACKAGE_PATH_NOT_EXPORTED`: deep `dist`/`src` paths and `package.json` for both `import()`
 * and `require()`, and `require()` of every ESM-only entry. Child Node
 * processes resolve the package by self-reference from its root, so Vitest's
 * resolver cannot mask the export map. The packed copy is checked by the
 * cjs-node consumer.
 */
function codeOf(kind: "import" | "require", specifier: string): string {
	const script =
		kind === "import"
			? `import(${JSON.stringify(specifier)}).then(() => process.stdout.write("loaded"), (error) => process.stdout.write(String(error.code)))`
			: `try { require(${JSON.stringify(specifier)}); process.stdout.write("loaded") } catch (error) { process.stdout.write(String(error.code)) }`;
	return execFileSync(
		process.execPath,
		kind === "import"
			? ["--input-type=module", "-e", script]
			: ["--input-type=commonjs", "-e", script],
		{ cwd: packageRoot, encoding: "utf8" },
	);
}

const DEEP = [
	"spinetab/dist/index.js",
	"spinetab/dist/index.cjs",
	"spinetab/src/index.ts",
	"spinetab/package.json",
];

describe("unexported paths", () => {
	for (const specifier of DEEP) {
		it(`${specifier} is not exported to import() or require()`, () => {
			expect(codeOf("import", specifier)).toBe("ERR_PACKAGE_PATH_NOT_EXPORTED");
			expect(codeOf("require", specifier)).toBe(
				"ERR_PACKAGE_PATH_NOT_EXPORTED",
			);
		});
	}

	for (const target of targets().filter((entry) => !entry.require)) {
		const specifier = specifierOf(target.subpath);
		it(`${specifier} is ESM-only: require() is not exported`, () => {
			expect(codeOf("require", specifier)).toBe(
				"ERR_PACKAGE_PATH_NOT_EXPORTED",
			);
		});
	}
});
