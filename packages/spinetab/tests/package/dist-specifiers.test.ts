import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
	allowlistedSelfImports,
	allowsSpecifier,
	BUILD,
	BUNDLER_PACKAGES,
	CORE,
	ENTRY_RULES,
	FORBIDDEN_SPECIFIERS,
	isBareSpecifier,
	isNodeBuiltin,
	packageName,
} from "./allowlist.ts";
import { distDir, targets } from "./dist.ts";
import {
	areasOf,
	closureOf,
	distRelative,
	importsOf,
	isDeclaration,
	sourcesOf,
	walk,
} from "./graph.ts";

/**
 * Bare specifiers in the emitted package. Core files import nothing third-party, only the declared package
 * self-imports; each entry's closure imports only the peers and self-imports
 * its rule allows; `node:` built-ins appear only in build
 * files; build declarations import no bundler package (structural types); nothing imports `next`, `server-only` or `client-only`. The root and
 * the keep stub keep their self-imports bare, each seam source is emitted
 * only in its own entry, and page code learns the wiring only through
 * `spinetab/wiring` .
 */
const emitted = walk(distDir).filter((file) => /\.(c?js|d\.c?ts)$/.test(file));
const selfImports = new Set(allowlistedSelfImports());
const importsIn = (file: string) =>
	importsOf(readFileSync(join(distDir, file), "utf8"));

describe("bare specifiers in dist", () => {
	it("never imports Next or server/client markers", () => {
		const offending = emitted.flatMap((file) =>
			importsIn(file)
				.filter((specifier) =>
					FORBIDDEN_SPECIFIERS.some((pattern) => pattern.test(specifier)),
				)
				.map((specifier) => `${file}: ${specifier}`),
		);
		expect(offending).toEqual([]);
	});

	it("imports node: built-ins only from build files", () => {
		const offending = emitted.flatMap((file) => {
			const areas = areasOf(distDir, file);
			const build =
				file.startsWith("build/") &&
				areas.length > 0 &&
				areas.every((area) => area === BUILD || area === CORE);
			if (build) return [];
			return importsIn(file)
				.filter(isNodeBuiltin)
				.map((specifier) => `${file} (${areas.join(", ")}): ${specifier}`);
		});
		expect(offending).toEqual([]);
	});

	it("imports Node built-ins only through the node: prefix", () => {
		// A prefix-less `fs` would pass as a bare package name; the prefix keeps
		// the per-realm rule exact.
		const builtins = new Set(builtinModules);
		const offending = emitted.flatMap((file) =>
			importsIn(file)
				.filter(isBareSpecifier)
				.filter((specifier) => builtins.has(packageName(specifier)))
				.map((specifier) => `${file}: ${specifier}`),
		);
		expect(offending).toEqual([]);
	});

	it("keeps core-only files free of third-party imports", () => {
		const offending = emitted.flatMap((file) => {
			const areas = areasOf(distDir, file);
			if (!areas.every((area) => area === CORE)) return [];
			return importsIn(file)
				.filter(isBareSpecifier)
				.filter((specifier) => !selfImports.has(specifier))
				.map((specifier) => `${file}: ${specifier}`);
		});
		expect(offending).toEqual([]);
	});

	it("keeps build declarations free of bundler packages (structural types)", () => {
		const offending = emitted
			.filter((file) => file.startsWith("build/") && isDeclaration(file))
			.flatMap((file) =>
				importsIn(file)
					.filter((specifier) =>
						BUNDLER_PACKAGES.includes(packageName(specifier)),
					)
					.map((specifier) => `${file}: ${specifier}`),
			);
		expect(offending).toEqual([]);
	});

	for (const target of targets()) {
		const rule = ENTRY_RULES[target.subpath];
		it(`${target.subpath}: imports only its own peers, self-imports and built-ins`, () => {
			expect(rule).toBeDefined();
			if (!rule) return;
			const checks: Array<[string, "js" | "types"]> = [
				[target.import.default, "js"],
				[target.import.types, "types"],
			];
			if (target.require) {
				checks.push(
					[target.require.default, "js"],
					[target.require.types, "types"],
				);
			}
			for (const [entry, kind] of checks) {
				const closure = closureOf(distDir, distRelative(entry));
				// Past the permitted runtime edge the runtime subpath's rule applies.
				const own = rule.runtimeEdge
					? new Set(
							closureOf(distDir, distRelative(entry), { dynamic: false }).files,
						)
					: undefined;
				const edgeRule = rule.runtimeEdge
					? ENTRY_RULES[rule.runtimeEdge.subpath]
					: undefined;
				const offending = [...closure.bare, ...closure.builtins].flatMap(
					([specifier, files]) =>
						[...files]
							.filter((file) => {
								const judge =
									own && !own.has(file) && edgeRule ? edgeRule : rule;
								return !allowsSpecifier(judge, specifier, kind);
							})
							.map((file) => `${specifier} ← ${file}`),
				);
				expect(
					offending,
					`${entry}${isDeclaration(entry) ? " (types)" : ""}`,
				).toEqual([]);
			}
		});
	}

	it("keeps each self-import in the entry that declares it", () => {
		// The root's CommonJS and ESM copies both keep `spinetab/wiring` bare;
		// the keep stub keeps `spinetab/worker-config` bare. A self-import
		// anywhere else would be an unredirectable package cycle.
		const importers = new Map<string, Set<string>>();
		for (const file of emitted) {
			for (const specifier of importsIn(file)) {
				if (!specifier.startsWith("spinetab")) continue;
				const files = importers.get(specifier) ?? new Set<string>();
				files.add(file);
				importers.set(specifier, files);
			}
		}
		const unexpected = [...importers.keys()].filter(
			(specifier) => !selfImports.has(specifier),
		);
		expect(unexpected).toEqual([]);
	});

	it("keeps every declared self-import bare in the entry's own JS, both formats", () => {
		// Permitted is not enough: were `src/wiring.ts` inlined into the root,
		// the plugin's redirect would have nothing to replace and every L3 app
		// would end `not-configured` while each closure rule still passed.
		const missing = targets().flatMap((target) => {
			const declared = ENTRY_RULES[target.subpath]?.selfImports ?? [];
			const files = [target.import.default, target.require?.default]
				.filter((file): file is string => file !== undefined)
				.map(distRelative);
			return files.flatMap((file) => {
				const imports = importsIn(file);
				return declared
					.filter((specifier) => !imports.includes(specifier))
					.map((specifier) => `${file}: ${specifier}`);
			});
		});
		expect(missing).toEqual([]);
		// Not vacuous: the root and the keep stub each declare one.
		expect(
			targets().filter(
				(target) => (ENTRY_RULES[target.subpath]?.selfImports ?? []).length,
			).length,
		).toBe(2);
	});

	it("emits each seam source only in its own entry's files", () => {
		const owners: Record<string, string> = {
			"src/wiring.ts": "./wiring",
			"src/worker-config.ts": "./worker-config",
			"src/auto/wiring.ts": "./auto/wiring",
			"src/auto/worker.ts": "./auto/worker",
		};
		const filesOf = (subpath: string) => {
			const target = targets().find((entry) => entry.subpath === subpath);
			if (!target) throw new Error(`${subpath} is not exported`);
			return [
				target.import.default,
				target.import.types,
				target.require?.default,
				target.require?.types,
			]
				.filter((file): file is string => file !== undefined)
				.map(distRelative);
		};
		const offending: string[] = [];
		const found = new Set<string>();
		for (const file of emitted) {
			for (const source of sourcesOf(distDir, file)) {
				const owner = owners[source];
				if (!owner) continue;
				found.add(source);
				if (!filesOf(owner).includes(file)) {
					offending.push(`${file}: ${source}`);
				}
			}
		}
		expect(offending).toEqual([]);
		expect([...found].sort()).toEqual(Object.keys(owners).sort());
	});
});

/**
 * The page learns the wiring only by importing `spinetab/wiring`;
 * no global, `define`, DOM, `document.currentScript` or `location`. Every file
 * in a page closure (JS and declarations) is judged from its AST, so comments
 * never count: no `__SPINETAB`/`SPINETAB_` name or string (a global or a
 * `define` constant), no `currentScript`, no `import.meta.env`. The wiring
 * modules themselves also read no global object, DOM or environment at all.
 */
const WIRING_GLOBALS = new Set([
	"globalThis",
	"window",
	"self",
	"top",
	"parent",
	"frames",
	"document",
	"location",
	"navigator",
	"process",
	"eval",
	"Function",
]);
const INJECTED_NAME = /^(?:__SPINETAB|SPINETAB_)/;

function wiringChannels(
	file: string,
	text: string,
	options: { wiringModule: boolean },
): string[] {
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
	const found: string[] = [];
	const visit = (node: ts.Node) => {
		if (ts.isIdentifier(node)) {
			if (INJECTED_NAME.test(node.text)) found.push(node.text);
			else if (options.wiringModule && WIRING_GLOBALS.has(node.text)) {
				found.push(node.text);
			}
			if (node.text === "currentScript") found.push("currentScript");
		} else if (
			ts.isStringLiteralLike(node) ||
			ts.isTemplateLiteralToken(node)
		) {
			if (/__SPINETAB|\bSPINETAB_/.test(node.text)) {
				found.push(JSON.stringify(node.text));
			}
			if (node.text === "currentScript") found.push('"currentScript"');
		} else if (
			ts.isPropertyAccessExpression(node) &&
			ts.isMetaProperty(node.expression) &&
			node.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
			node.name.text === "env"
		) {
			found.push("import.meta.env");
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return found;
}

describe("security the wiring reaches the page only through spinetab/wiring", () => {
	const wiringModules = new Set(
		targets()
			.filter((target) =>
				["./wiring", "./auto/wiring"].includes(target.subpath),
			)
			.flatMap((target) =>
				[
					target.import.default,
					target.import.types,
					target.require?.default,
					target.require?.types,
				].filter((file): file is string => file !== undefined),
			)
			.map(distRelative),
	);

	it("finds the wiring modules", () => {
		expect([...wiringModules].sort()).toEqual([
			"auto/wiring.d.ts",
			"auto/wiring.js",
			"wiring.cjs",
			"wiring.d.cts",
			"wiring.d.ts",
			"wiring.js",
		]);
	});

	it("page closures read no injected global, define constant, currentScript or import.meta.env", () => {
		const pageFiles = new Set<string>();
		for (const target of targets()) {
			const rule = ENTRY_RULES[target.subpath];
			if (rule?.realm !== "page") continue;
			const entries = [
				target.import.default,
				target.import.types,
				target.require?.default,
				target.require?.types,
			].filter((file): file is string => file !== undefined);
			for (const entry of entries) {
				// `auto/wiring`'s one dynamic edge leads into the runtime realm.
				const closure = closureOf(distDir, distRelative(entry), {
					dynamic: !rule.runtimeEdge,
				});
				for (const file of closure.files) pageFiles.add(file);
			}
		}
		expect(pageFiles.size).toBeGreaterThan(wiringModules.size);
		const offending = [...pageFiles].sort().flatMap((file) =>
			wiringChannels(file, readFileSync(join(distDir, file), "utf8"), {
				wiringModule: wiringModules.has(file),
			}).map((finding) => `${file}: ${finding}`),
		);
		expect(offending).toEqual([]);
	});

	it("the scan bites (control)", () => {
		const page = { wiringModule: false };
		expect(
			wiringChannels(
				"x.js",
				[
					"const a = globalThis.__SPINETAB_WIRING__;",
					'const b = window["__SPINETAB"];',
					"const c = document.currentScript;",
					"const d = import.meta.env.VITE_WORKER;",
					"const e = SPINETAB_WORKER_URL;",
					"// __SPINETAB and document.currentScript in a comment are ignored.",
					"const f = new URL(location.href);",
				].join("\n"),
				page,
			),
		).toEqual([
			"__SPINETAB_WIRING__",
			'"__SPINETAB"',
			"currentScript",
			"import.meta.env",
			"SPINETAB_WORKER_URL",
		]);
		expect(
			wiringChannels(
				"x.d.ts",
				"declare global { var __SPINETAB_WORKER__: string; }\nexport {};\n",
				page,
			),
		).toEqual(["__SPINETAB_WORKER__"]);
		expect(
			wiringChannels(
				"wiring.js",
				"export const wiring = self.location ? { worker: () => process } : void 0;\n",
				{ wiringModule: true },
			),
		).toEqual(["self", "location", "process"]);
	});
});
