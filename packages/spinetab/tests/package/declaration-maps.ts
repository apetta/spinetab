import { rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { build } from "tsdown";
import { distDir, packageRoot } from "./dist.ts";
import {
	boundDeclaration,
	type DeclarationMaps,
	isDeclaration,
	walk,
} from "./graph.ts";

/**
 * Declaration provenance without shipping `.d.ts.map` files. Rebuild the
 * package with the same config and sources into
 * `test-results/declaration-maps/<label>/dist`, with declaration maps on, then
 * bind that build to the candidate: the same declaration files, each
 * byte-identical apart from its own map reference. Each caller uses its own
 * label so concurrent test files never share an output directory.
 */
export async function buildDeclarationMaps(
	label: string,
	candidate: string = distDir,
): Promise<DeclarationMaps> {
	const dir = join(packageRoot, "test-results/declaration-maps", label, "dist");
	rmSync(dirname(dir), { recursive: true, force: true });
	await build({
		config: join(packageRoot, "tsdown.config.ts"),
		cwd: packageRoot,
		outDir: dir,
		// The shared tsconfig sets `declaration: false`; rolldown-plugin-dts
		// forces declaration emit, but TypeScript then has no map path and
		// fails with "Debug Failure" unless declarations are enabled here.
		dts: { sourcemap: true, compilerOptions: { declaration: true } },
		logLevel: "warn",
	});
	return bindDeclarationMaps(candidate, dir);
}

/**
 * Check a declaration-map build against `candidate`. Throws when either side
 * has a declaration the other lacks, or any file differs; the returned
 * evidence is only accepted for `candidate`.
 */
export function bindDeclarationMaps(
	candidate: string,
	dir: string,
): DeclarationMaps {
	const maps = { candidate: resolve(candidate), dir: resolve(dir) };
	const shipped = walk(candidate).filter(isDeclaration);
	const built = walk(dir).filter(isDeclaration);
	const problems = [
		...shipped
			.filter((file) => !built.includes(file))
			.map((file) => `${file}: not in the declaration-map build`),
		...built
			.filter((file) => !shipped.includes(file))
			.map((file) => `${file}: not in the candidate`),
		...shipped
			.filter((file) => built.includes(file))
			.flatMap((file) => {
				const bound = boundDeclaration(candidate, file, maps);
				return "problem" in bound ? [`${file}: ${bound.problem}`] : [];
			}),
	];
	if (shipped.length === 0) problems.push("the candidate has no declarations");
	if (problems.length > 0) {
		throw new Error(
			`declaration maps do not describe ${candidate}:\n${problems.join("\n")}`,
		);
	}
	return maps;
}
