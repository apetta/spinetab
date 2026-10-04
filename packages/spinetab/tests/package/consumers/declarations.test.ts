import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { allowsSpecifier, ENTRY_RULES } from "../allowlist.ts";
import { closureOf, distRelative, exportTargets } from "../graph.ts";
import { CONSUMERS } from "./catalogue.ts";
import { consumerDir, reportsDir } from "./paths.ts";
import { assertFreshPack } from "./prepare.ts";
import { run } from "./run.ts";

/**
 * Declaration isolation. Each
 * consumer type-checks its `types/` against the packed declarations with
 * `strict` and `skipLibCheck: false` under `bundler`, `nodenext` (`.d.ts`
 * and `.d.cts`) and a `WebWorker`-only realm, with only its selected peers
 * and types installed. `expect-type` assertions check payload inference.
 */
beforeAll(() => {
	assertFreshPack("consumers:declarations");
});

afterAll(() => {
	assertFreshPack("consumers:declarations (end)");
});

const TSCONFIGS = [
	"tsconfig.bundler.json",
	"tsconfig.nodenext.json",
	"tsconfig.worker.json",
];

for (const spec of CONSUMERS.filter((entry) => entry.declarations)) {
	describe(spec.name, () => {
		const root = consumerDir(spec.name);

		for (const tsconfig of TSCONFIGS) {
			it(`type-checks ${tsconfig} with skipLibCheck: false`, async () => {
				const result = await run(
					process.execPath,
					[
						join(root, "node_modules/typescript/bin/tsc"),
						"-p",
						tsconfig,
						"--pretty",
						"false",
					],
					{
						cwd: root,
						timeoutMs: 300_000,
						logFile: join(reportsDir(spec.name), `tsc-${tsconfig}.log`),
					},
				);
				expect(result.code, result.output).toBe(0);
			});
		}

		it("installs declarations free of Node types and unrelated peers", () => {
			const dist = realpathSync(join(root, "node_modules/spinetab"));
			const manifest = JSON.parse(
				readFileSync(join(dist, "package.json"), "utf8"),
			) as Parameters<typeof exportTargets>[0];
			const problems: string[] = [];
			for (const target of exportTargets(manifest)) {
				if (!spec.entries.includes(target.subpath)) continue;
				const rule = ENTRY_RULES[target.subpath];
				if (!rule) throw new Error(`No rule for ${target.subpath}`);
				const typeFiles = [target.import.types, target.require?.types].filter(
					(file): file is string => typeof file === "string",
				);
				for (const types of typeFiles) {
					const closure = closureOf(join(dist, "dist"), distRelative(types));
					problems.push(
						...closure.unresolved.map((line) => `unresolved ${line}`),
					);
					for (const file of closure.files) {
						const text = readFileSync(join(dist, "dist", file), "utf8");
						if (/\/\/\/\s*<reference\s+types=["']node["']/.test(text)) {
							problems.push(`${file}: references Node types`);
						}
						if (/\bNodeJS\./.test(text))
							problems.push(`${file}: uses NodeJS.*`);
					}
					for (const [specifier, files] of closure.bare) {
						// Type peers plus the rule's declared self-imports.
						// `spinetab/wiring` for the root, `spinetab/worker-config`
						// for `./auto/worker`).
						if (!allowsSpecifier(rule, specifier, "types")) {
							problems.push(
								`${target.subpath}: ${specifier} imported by ${[...files].join(", ")}`,
							);
						}
					}
				}
			}
			expect(problems).toEqual([]);
		});
	});
}
