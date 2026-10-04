import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { CORE } from "./allowlist.ts";
import { distDir, packageRoot } from "./dist.ts";
import { areasOf, walk } from "./graph.ts";

/**
 * No storage-based coordination: core, runtime and worker code
 * and their emitted files never name `localStorage`, `sessionStorage`,
 * `indexedDB`, `document.cookie`, `cookieStore` or `BroadcastChannel`.
 * Checked on the AST (identifiers, property names, string keys), not text.
 */
const FORBIDDEN = new Set([
	"localStorage",
	"sessionStorage",
	"indexedDB",
	"cookieStore",
	"BroadcastChannel",
]);

function storageUses(fileName: string, text: string): string[] {
	const source = ts.createSourceFile(
		fileName,
		text,
		ts.ScriptTarget.Latest,
		true,
	);
	const found: string[] = [];
	const visit = (node: ts.Node) => {
		if (ts.isIdentifier(node) && FORBIDDEN.has(node.text)) {
			found.push(`${node.text} @${node.getStart()}`);
		} else if (
			(ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
			FORBIDDEN.has(node.text)
		) {
			found.push(`"${node.text}" @${node.getStart()}`);
		} else if (
			ts.isPropertyAccessExpression(node) &&
			node.name.text === "cookie" &&
			/(^|\.)document$/.test(node.expression.getText())
		) {
			found.push(`document.cookie @${node.getStart()}`);
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return found;
}

describe("storage-free coordination", () => {
	it("core, runtime and worker sources never use storage or BroadcastChannel", () => {
		const offending = ["src/core", "src/runtime", "src/worker"].flatMap((dir) =>
			walk(join(packageRoot, dir))
				.filter((file) => file.endsWith(".ts"))
				.flatMap((file) =>
					storageUses(
						file,
						readFileSync(join(packageRoot, dir, file), "utf8"),
					).map((use) => `${dir}/${file}: ${use}`),
				),
		);
		expect(offending).toEqual([]);
	});

	it("core-only emitted files never use storage or BroadcastChannel", () => {
		const offending = walk(distDir)
			.filter((file) => /\.c?js$/.test(file))
			.filter((file) => areasOf(distDir, file).every((area) => area === CORE))
			.flatMap((file) =>
				storageUses(file, readFileSync(join(distDir, file), "utf8")).map(
					(use) => `${file}: ${use}`,
				),
			);
		expect(offending).toEqual([]);
	});
});
