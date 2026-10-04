import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ENTRY_RULES } from "./allowlist.ts";
import { distDir, targets } from "./dist.ts";
import { closureOf, distRelative, sourcesOf } from "./graph.ts";

// Each realm ships only the bridge validator it runs. The page
// validates runtime→page messages (`bridge-page.ts`) and the runtime validates
// page→runtime messages (`bridge-runtime.ts`); the core runtime and worker
// entries never reach the page option guards (`validate.ts`). Bundlers that
// keep whole dist modules (Turbopack) would otherwise ship the other realm's
// shape table. Build entries (Node-only plugins) reach no validator at all,
// and an entry without an allow-list rule fails instead of defaulting to the
// page rule. Reads the built `dist/` through its sourcemap sources.

const PAGE_VALIDATOR = "src/core/bridge-page.ts";
const RUNTIME_VALIDATOR = "src/core/bridge-runtime.ts";
const OPTION_GUARDS = "src/core/validate.ts";

function closureSources(entry: string): Map<string, string[]> {
	const sources = new Map<string, string[]>();
	for (const file of closureOf(distDir, distRelative(entry)).files) {
		for (const source of sourcesOf(distDir, file)) {
			sources.set(source, [...(sources.get(source) ?? []), file]);
		}
	}
	return sources;
}

describe("bridge validators per realm (built dist)", () => {
	it("has a built dist to inspect", () => {
		expect(existsSync(distDir), "run the package build first").toBe(true);
	});

	const entries = targets().flatMap((target) =>
		[target.import.default, target.require?.default]
			.filter((file): file is string => typeof file === "string")
			.map((file) => ({
				subpath: target.subpath,
				realm: ENTRY_RULES[target.subpath]?.realm,
				file,
			})),
	);

	// Entries that never validate page options: the engine entries and the
	// plugin seams (the keep stub and its stub target).
	const NO_OPTION_GUARDS = new Set([
		"./runtime",
		"./worker",
		"./auto/worker",
		"./worker-config",
	]);

	for (const { subpath, realm, file } of entries) {
		const forbidden =
			realm === "build"
				? [PAGE_VALIDATOR, RUNTIME_VALIDATOR, OPTION_GUARDS]
				: realm === "runtime"
					? [
							PAGE_VALIDATOR,
							...(NO_OPTION_GUARDS.has(subpath) ? [OPTION_GUARDS] : []),
						]
					: [RUNTIME_VALIDATOR];
		it(`${file} (${realm ?? "no rule"}) does not reach ${forbidden.join(", ")}`, () => {
			expect(realm, `${subpath} has no allow-list rule`).toBeDefined();
			const sources = closureSources(file);
			const reached = forbidden.flatMap((source) =>
				(sources.get(source) ?? []).map((chunk) => `${chunk}: ${source}`),
			);
			expect(reached).toEqual([]);
		});
	}

	it("the core entries still carry their own validator", () => {
		expect(closureSources("./dist/index.js").has(PAGE_VALIDATOR)).toBe(true);
		expect(closureSources("./dist/index.cjs").has(PAGE_VALIDATOR)).toBe(true);
		expect(closureSources("./dist/runtime.js").has(RUNTIME_VALIDATOR)).toBe(
			true,
		);
	});
});
