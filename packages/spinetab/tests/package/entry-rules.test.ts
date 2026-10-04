import { describe, expect, it } from "vitest";
import {
	allowlistedSelfImports,
	BUILD,
	ENTRY_RULES,
	isNodeBuiltin,
	SEAM_SUBPATHS,
} from "./allowlist.ts";
import { readManifest, specifierOf } from "./dist.ts";

/**
 * The allow-list covers the export map exactly. Every
 * `exports` subpath has a rule and every rule is exported, so no realm check
 * (closure, specifiers, bridge realms, declaration realms, side effects) can
 * skip an entry or judge it under a default realm. The rule's realm also
 * agrees with the export conditions and target paths.
 */
const manifest = readManifest();
const exported = Object.keys(manifest.exports).sort();
const ruled = Object.keys(ENTRY_RULES).sort();

const BUILD_SUBPATHS = [
	"./vite",
	"./webpack",
	"./rspack",
	"./next",
	"./astro",
	"./nuxt",
	"./loader",
];

describe("allow-list rules cover the export map", () => {
	it("gives every exported subpath a rule", () => {
		expect(exported.filter((subpath) => !ENTRY_RULES[subpath])).toEqual([]);
	});

	it("exports every ruled subpath", () => {
		expect(ruled.filter((subpath) => !manifest.exports[subpath])).toEqual([]);
	});

	it("names every seam and build subpath", () => {
		for (const subpath of [...SEAM_SUBPATHS, ...BUILD_SUBPATHS]) {
			expect(ENTRY_RULES[subpath], subpath).toBeDefined();
			expect(manifest.exports[subpath], subpath).toBeDefined();
		}
		expect(
			ruled.filter((subpath) => ENTRY_RULES[subpath]?.realm === "build"),
		).toEqual([...BUILD_SUBPATHS].sort());
	});
});

describe("rule realms agree with the export conditions", () => {
	for (const subpath of exported) {
		const rule = ENTRY_RULES[subpath];
		const conditions = manifest.exports[subpath];
		it(`${specifierOf(subpath)} (${rule?.realm ?? "no rule"})`, () => {
			expect(rule).toBeDefined();
			if (!rule || !conditions) return;
			const targets = [
				conditions.import.types,
				conditions.import.default,
				conditions.require?.types,
				conditions.require?.default,
			].filter((target): target is string => typeof target === "string");
			const underBuild = targets.filter((target) =>
				target.startsWith("./dist/build/"),
			);
			if (rule.realm === "build") {
				// Dual format: `next.config.ts` is compiled to CommonJS.
				expect(conditions.require, "require condition").toBeDefined();
				expect(underBuild).toEqual(targets);
				expect(rule.areas).toEqual([BUILD]);
				expect(rule.jsPeers).toEqual([]);
				expect(rule.typePeers).toEqual([]);
				expect(rule.nodeBuiltins).toBe(true);
				expect(rule.selfImports ?? []).toEqual([]);
			} else {
				expect(underBuild, "browser entries live outside dist/build").toEqual(
					[],
				);
				expect(rule.nodeBuiltins ?? false, "node: built-ins").toBe(false);
				expect(rule.areas).not.toContain(BUILD);
			}
			if (rule.realm === "runtime") {
				// Runtime entries are modules only (worker and lazy local chunk).
				expect(conditions.require, "require condition").toBeUndefined();
			}
		});
	}

	it("keeps the page entries dual except the ESM-only shipped literals", () => {
		const esmOnlyPage = exported.filter(
			(subpath) =>
				ENTRY_RULES[subpath]?.realm === "page" &&
				!manifest.exports[subpath]?.require,
		);
		expect(esmOnlyPage).toEqual(["./auto/wiring"]);
	});
});

describe("self-imports, built-ins and the runtime edge", () => {
	it("declares exactly the two plugin-owned self-imports", () => {
		const declared = Object.fromEntries(
			ruled
				.filter((subpath) => (ENTRY_RULES[subpath]?.selfImports ?? []).length)
				.map((subpath) => [subpath, ENTRY_RULES[subpath]?.selfImports]),
		);
		expect(declared).toEqual({
			".": ["spinetab/wiring"],
			"./auto/worker": ["spinetab/worker-config"],
		});
		expect(allowlistedSelfImports()).toEqual([
			"spinetab/wiring",
			"spinetab/worker-config",
		]);
	});

	it("points every self-import at an exported subpath of the same format family", () => {
		for (const subpath of ruled) {
			const rule = ENTRY_RULES[subpath];
			for (const specifier of rule?.selfImports ?? []) {
				const target = `./${specifier.slice("spinetab/".length)}`;
				expect(manifest.exports[target], specifier).toBeDefined();
				// A dual entry's CommonJS copy requires the target, so it must be dual too.
				if (manifest.exports[subpath]?.require) {
					expect(manifest.exports[target]?.require, specifier).toBeDefined();
				}
			}
		}
	});

	it("allows node: built-ins only in build rules", () => {
		const withBuiltins = ruled.filter(
			(subpath) => ENTRY_RULES[subpath]?.nodeBuiltins,
		);
		expect(withBuiltins).toEqual([...BUILD_SUBPATHS].sort());
		expect(isNodeBuiltin("node:fs")).toBe(true);
		expect(isNodeBuiltin("fs")).toBe(false);
	});

	it("permits exactly one runtime edge: ./auto/wiring → ./auto/worker", () => {
		const edges = ruled
			.filter((subpath) => ENTRY_RULES[subpath]?.runtimeEdge)
			.map((subpath) => [subpath, ENTRY_RULES[subpath]?.runtimeEdge]);
		expect(edges).toEqual([
			[
				"./auto/wiring",
				{ source: "src/auto/worker.ts", subpath: "./auto/worker" },
			],
		]);
		expect(ENTRY_RULES["./auto/worker"]?.realm).toBe("runtime");
		expect(ENTRY_RULES["./auto/wiring"]?.realm).toBe("page");
	});
});
