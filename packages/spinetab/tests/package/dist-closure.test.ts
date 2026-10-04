import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { describe, expect, it } from "vitest";
import {
	allowedAreas,
	BUILD_SHARED_SOURCES,
	BUILD_SOURCES,
	buildMayReach,
	ENTRY_RULES,
	forbiddenSources,
	type Realm,
} from "./allowlist.ts";
import { distDir, packageRoot, targets } from "./dist.ts";
import {
	areasOf,
	type Closure,
	closureOf,
	distRelative,
	sourcesOf,
	walk,
} from "./graph.ts";

/** Only auto/wiring may cross from the page graph into the runtime graph, through the keep stub. Check JavaScript and declaration closures separately. */

const jsEntries = (target: ReturnType<typeof targets>[number]) =>
	[target.import.default, target.require?.default].filter(
		(file): file is string => typeof file === "string",
	);
const typeEntries = (target: ReturnType<typeof targets>[number]) =>
	[target.import.types, target.require?.types].filter(
		(file): file is string => typeof file === "string",
	);

function crossings(files: readonly string[], forbidden: readonly RegExp[]) {
	return files.flatMap((file) =>
		sourcesOf(distDir, file)
			.filter((source) => forbidden.some((pattern) => pattern.test(source)))
			.map((source) => `${file}: ${source}`),
	);
}

function buildStrays(files: readonly string[]) {
	return files.flatMap((file) =>
		sourcesOf(distDir, file)
			.filter((source) => !buildMayReach(source))
			.map((source) => `${file}: ${source}`),
	);
}

describe("dist closure per entry", () => {
	for (const target of targets()) {
		const rule = ENTRY_RULES[target.subpath];
		const offending = (files: readonly string[]) => {
			const allowed = allowedAreas(target.subpath);
			return files.flatMap((file) =>
				areasOf(distDir, file)
					.filter((area) => !allowed.has(area))
					.map((area) => `${file}: ${area}`),
			);
		};

		it(`${target.subpath}: JavaScript stays within its realm and areas`, () => {
			expect(rule, "allow-list rule").toBeDefined();
			if (!rule) return;
			for (const entry of jsEntries(target)) {
				const full = closureOf(distDir, distRelative(entry));
				expect(full.unresolved).toEqual([]);
				if (rule.realm === "build") {
					expect(
						buildStrays(full.files),
						`${entry} leaves the build realm`,
					).toEqual([]);
					expect(offending(full.files)).toEqual([]);
					continue;
				}
				// Page closures stop at the permitted runtime edge; the runtime
				// subpath's own rule judges the rest (checked in its own test).
				const own = rule.runtimeEdge
					? closureOf(distDir, distRelative(entry), { dynamic: false })
					: full;
				expect(own.unresolved).toEqual([]);
				expect(offending(own.files)).toEqual([]);
				expect(
					crossings(own.files, forbiddenSources(rule.realm)),
					`${entry} crosses a realm boundary`,
				).toEqual([]);
			}
		});

		it(`${target.subpath}: declarations stay within its realm and areas`, () => {
			if (!rule) return;
			for (const entry of typeEntries(target)) {
				const closure = closureOf(distDir, distRelative(entry));
				expect(closure.unresolved).toEqual([]);
				expect(offending(closure.files)).toEqual([]);
				if (rule.realm === "build") {
					expect(buildStrays(closure.files)).toEqual([]);
				} else {
					expect(
						crossings(closure.files, BUILD_SOURCES),
						`${entry} reaches build declarations`,
					).toEqual([]);
				}
			}
		});
	}
});

describe("dynamic edges into the runtime realm", () => {
	const edgesOf = (closure: Closure) =>
		closure.dynamic.map(({ from, to }) => ({
			from,
			to,
			sources: sourcesOf(distDir, to),
		}));

	it("./auto/wiring has exactly one: the lazy local import of the keep stub", () => {
		const rule = ENTRY_RULES["./auto/wiring"];
		const edge = rule?.runtimeEdge;
		expect(edge).toBeDefined();
		if (!edge) return;
		const target = targets().find((entry) => entry.subpath === "./auto/wiring");
		const stub = targets().find((entry) => entry.subpath === edge.subpath);
		expect(target?.require, "ESM only").toBeUndefined();
		if (!target || !stub) throw new Error("seam exports missing");
		const closure = closureOf(distDir, distRelative(target.import.default));
		expect(edgesOf(closure)).toEqual([
			{
				from: distRelative(target.import.default),
				to: distRelative(stub.import.default),
				sources: [edge.source],
			},
		]);
		// Past the edge: exactly the keep stub's own runtime closure.
		const past = closure.files.filter(
			(file) =>
				!closureOf(distDir, distRelative(target.import.default), {
					dynamic: false,
				}).files.includes(file),
		);
		expect(past).toEqual(
			closureOf(distDir, distRelative(stub.import.default)).files,
		);
		expect(
			crossings(past, forbiddenSources("runtime")),
			"the keep stub's closure",
		).toEqual([]);
	});

	it("no other page entry has a dynamic edge into runtime or build code", () => {
		const offending: string[] = [];
		for (const target of targets()) {
			const rule = ENTRY_RULES[target.subpath];
			if (rule?.realm !== "page" || rule.runtimeEdge) continue;
			for (const entry of jsEntries(target)) {
				for (const edge of edgesOf(closureOf(distDir, distRelative(entry)))) {
					const bad = edge.sources.filter((source) =>
						forbiddenSources("page").some((pattern) => pattern.test(source)),
					);
					if (bad.length > 0) {
						offending.push(`${edge.from} → ${edge.to}: ${bad.join(", ")}`);
					}
				}
			}
		}
		expect(offending).toEqual([]);
	});
});

describe("realm partition of the emitted files", () => {
	const emitted = walk(distDir).filter((file) =>
		/\.(c?js|d\.c?ts)$/.test(file),
	);
	const reachedBy = new Map<string, Set<Realm>>();
	for (const target of targets()) {
		const realm = ENTRY_RULES[target.subpath]?.realm;
		if (!realm) continue;
		for (const entry of [...jsEntries(target), ...typeEntries(target)]) {
			for (const file of closureOf(distDir, distRelative(entry)).files) {
				const realms = reachedBy.get(file) ?? new Set<Realm>();
				realms.add(realm);
				reachedBy.set(file, realms);
			}
		}
	}

	it("reaches every emitted file from some export", () => {
		expect(emitted.filter((file) => !reachedBy.has(file))).toEqual([]);
	});

	it("never shares an emitted file between build and browser entries", () => {
		const shared = [...reachedBy.entries()]
			.filter(([, realms]) => realms.has("build") && realms.size > 1)
			.map(([file, realms]) => `${file}: ${[...realms].sort().join("+")}`);
		expect(shared).toEqual([]);
	});

	it("keeps build files under dist/build and browser files outside it", () => {
		const misplaced = [...reachedBy.entries()]
			.filter(
				([file, realms]) => realms.has("build") !== file.startsWith("build/"),
			)
			.map(([file, realms]) => `${file}: ${[...realms].sort().join("+")}`);
		expect(misplaced).toEqual([]);
	});

	it("shares only the declared sources between the build and browser realms", () => {
		const bySource = new Map<string, Set<"build" | "browser">>();
		for (const [file, realms] of reachedBy) {
			for (const source of sourcesOf(distDir, file)) {
				const sides = bySource.get(source) ?? new Set<"build" | "browser">();
				for (const realm of realms) {
					sides.add(realm === "build" ? "build" : "browser");
				}
				bySource.set(source, sides);
			}
		}
		const both = [...bySource.entries()]
			.filter(([, sides]) => sides.size === 2)
			.map(([source]) => source)
			.filter((source) => !BUILD_SHARED_SOURCES.includes(source));
		expect(both).toEqual([]);
	});
});

describe("the closure rules bite (synthetic dist control)", () => {
	const root = join(packageRoot, "test-results/closure-control/dist");
	const emit = (file: string, code: string, sources: string[]) => {
		mkdirSync(dirname(join(root, file)), { recursive: true });
		writeFileSync(
			join(root, file),
			`${code}\n//# sourceMappingURL=${file.split("/").pop()}.map\n`,
		);
		writeFileSync(
			join(root, `${file}.map`),
			JSON.stringify({
				version: 3,
				sources: sources.map((source) =>
					posix.relative(posix.dirname(posix.join("dist", file)), source),
				),
				sourcesContent: sources.map(() => ""),
				mappings: "",
			}),
		);
	};
	rmSync(dirname(root), { recursive: true, force: true });
	emit("page.js", 'export const x = () => import("./engine.js");', [
		"src/transports/polling/index.ts",
	]);
	emit("engine.js", "export const y = 1;", ["src/core/runtime.ts"]);
	emit("build/vite.js", 'import "node:fs";\nimport "./client.js";', [
		"src/build/vite.ts",
	]);
	emit("build/client.js", "export {};", ["src/core/client.ts"]);
	const sourcesIn = (files: readonly string[]) =>
		files.flatMap((file) => sourcesOf(root, file));

	it("a page closure follows a dynamic engine import unless the edge stops it", () => {
		const full = closureOf(root, "page.js");
		expect(full.files).toEqual(["page.js", "engine.js"]);
		expect(full.dynamic).toEqual([{ from: "page.js", to: "engine.js" }]);
		expect(
			sourcesIn(full.files).filter((source) =>
				forbiddenSources("page").some((pattern) => pattern.test(source)),
			),
		).toEqual(["src/core/runtime.ts"]);
		expect(closureOf(root, "page.js", { dynamic: false }).files).toEqual([
			"page.js",
		]);
	});

	it("a build closure may not hold core code beyond the shared validator", () => {
		const closure = closureOf(root, "build/vite.js");
		expect(closure.unresolved).toEqual([]);
		expect([...closure.builtins.keys()]).toEqual(["node:fs"]);
		expect(
			sourcesIn(closure.files).filter((source) => !buildMayReach(source)),
		).toEqual(["src/core/client.ts"]);
		expect(buildMayReach("src/core/origins.ts")).toBe(true);
		expect(buildMayReach("src/build/adapters.ts")).toBe(true);
	});
});
