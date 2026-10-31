import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { bindDeclarationMaps } from "./declaration-maps.ts";
import { packageRoot } from "./dist.ts";
import { areasOf, type DeclarationMaps, sourcesOf } from "./graph.ts";

/**
 * Synthetic controls for declaration provenance. The real dist/ is bound in
 * dist-closure and dist-specifiers; these show that missing, stale, unrelated
 * or comment-only evidence fails instead of yielding no sources.
 */
const control = join(packageRoot, "test-results/declaration-maps-control");
const candidate = join(control, "dist");
const built = join(control, "maps/dist");

const write = (path: string, text: string) => {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
};
/** A declaration in both trees; `map` sources are relative to the build. */
function declaration(
	file: string,
	text: string,
	options: { built?: string; reference?: string; map?: object } = {},
) {
	write(join(candidate, file), text);
	const reference = options.reference ? `\n${options.reference}` : "";
	write(join(built, file), `${options.built ?? text}${reference}`);
	if (options.map) {
		write(join(built, `${file}.map`), JSON.stringify(options.map));
	}
}
const mapOf = (file: string, sources: string[]) => ({
	version: 3,
	file,
	names: [],
	sources,
	mappings: "",
});

rmSync(control, { recursive: true, force: true });
for (const source of [
	"src/core/types.ts",
	"src/transports/sse/index.ts",
	"outside/helper.ts",
]) {
	write(join(control, source), "export {};\n");
}
declaration("types.d.ts", "export type T = 1;", {
	map: mapOf("types.d.ts", ["../../src/core/types.ts"]),
});
// CommonJS declarations keep their own map reference in the build.
declaration("types.d.cts", "export type T = 1;", {
	reference: "//# sourceMappingURL=types.d.cts.map",
	map: mapOf("types.d.cts", ["../../src/core/types.ts"]),
});
declaration(
	"entry.d.ts",
	'import type { T } from "./types.js";\nexport type X = T;\n',
	{ map: mapOf("entry.d.ts", ["../../src/transports/sse/index.ts"]) },
);
declaration("reexport.d.ts", 'export { T } from "./types.js";\n');
// Old-style region markers, but no map: comments are not provenance.
declaration(
	"marked.d.ts",
	"//#region src/core/types.d.ts\nexport type M = 1;\n//#endregion\n",
);
declaration("stale.d.ts", "export type S = 1;\n", {
	built: "export type S = 2;\n",
	map: mapOf("stale.d.ts", ["../../src/core/types.ts"]),
});
declaration("rerouted.d.ts", "export type R = 1;", {
	reference: "//# sourceMappingURL=types.d.ts.map",
	map: mapOf("rerouted.d.ts", ["../../src/core/types.ts"]),
});
declaration("unrelated.d.ts", "export type U = 1;\n", {
	map: mapOf("types.d.ts", ["../../src/core/types.ts"]),
});
declaration("empty.d.ts", "export type E = 1;\n", {
	map: mapOf("empty.d.ts", []),
});
declaration("outside.d.ts", "export type O = 1;\n", {
	map: mapOf("outside.d.ts", ["../../outside/helper.ts"]),
});
declaration("gone.d.ts", "export type G = 1;\n", {
	map: mapOf("gone.d.ts", ["../../src/core/gone.ts"]),
});
// Shipped, but never rebuilt.
write(join(candidate, "absent.d.ts"), "export {};\n");
const maps: DeclarationMaps = { candidate, dir: built };

describe("declaration sources from a bound declaration-map build", () => {
	it("reads sources from the map beside an identical declaration", () => {
		expect(sourcesOf(candidate, "entry.d.ts", maps)).toEqual([
			"src/transports/sse/index.ts",
		]);
		expect(areasOf(candidate, "entry.d.ts", maps)).toEqual(["transports/sse"]);
		expect(sourcesOf(candidate, "types.d.ts", maps)).toEqual([
			"src/core/types.ts",
		]);
		expect(sourcesOf(candidate, "types.d.cts", maps)).toEqual([
			"src/core/types.ts",
		]);
	});

	it("gives a re-export-only declaration without a map no area", () => {
		expect(sourcesOf(candidate, "reexport.d.ts", maps)).toEqual([]);
		expect(areasOf(candidate, "reexport.d.ts", maps)).toEqual([]);
	});

	it("names a source outside src/ as unknown", () => {
		expect(areasOf(candidate, "outside.d.ts", maps)).toEqual([
			"unknown:outside/helper.ts",
		]);
	});

	it.each([
		["entry.d.ts", undefined, /needs? declaration-map evidence/],
		["marked.d.ts", maps, /no declaration map/],
		["stale.d.ts", maps, /differs from the candidate/],
		["rerouted.d.ts", maps, /references another map: types\.d\.ts\.map/],
		["unrelated.d.ts", maps, /does not describe this file/],
		["empty.d.ts", maps, /does not describe this file/],
		["gone.d.ts", maps, /missing source/],
		["absent.d.ts", maps, /not in the declaration-map build/],
	])("rejects %s (%#)", (file, evidence, message) => {
		expect(() => sourcesOf(candidate, file, evidence)).toThrow(message);
		expect(() => areasOf(candidate, file, evidence)).toThrow(message);
	});

	it("accepts the evidence only for the candidate it was checked against", () => {
		const other = join(control, "other/dist");
		write(join(other, "entry.d.ts"), "export type X = 1;\n");
		expect(() => sourcesOf(other, "entry.d.ts", maps)).toThrow(
			/maps were checked against/,
		);
	});
});

describe("binding a declaration-map build to its candidate", () => {
	it("lists every differing, missing or extra declaration", () => {
		const root = join(control, "bind");
		const pair = (name: string, shipped?: string, rebuilt?: string) => {
			if (shipped !== undefined) write(join(root, "dist", name), shipped);
			if (rebuilt !== undefined) write(join(root, "maps/dist", name), rebuilt);
		};
		pair("same.d.ts", "export type A = 1;\n", "export type A = 1;\n");
		pair(
			"same.d.cts",
			"export type A = 1;",
			"export type A = 1;\n//# sourceMappingURL=same.d.cts.map",
		);
		pair("changed.d.ts", "export type B = 1;\n", "export type B = 2;\n");
		pair("missing.d.ts", "export type C = 1;\n");
		pair("extra.d.ts", undefined, "export type D = 1;\n");
		let message = "";
		try {
			bindDeclarationMaps(join(root, "dist"), join(root, "maps/dist"));
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message.split("\n").slice(1).sort()).toEqual([
			"changed.d.ts: differs from the candidate",
			"extra.d.ts: not in the candidate",
			"missing.d.ts: not in the declaration-map build",
		]);
	});

	it("rejects a candidate without declarations", () => {
		const root = join(control, "bind-empty");
		write(join(root, "dist/index.js"), "export {};\n");
		mkdirSync(join(root, "maps/dist"), { recursive: true });
		expect(() =>
			bindDeclarationMaps(join(root, "dist"), join(root, "maps/dist")),
		).toThrow(/the candidate has no declarations/);
	});

	it("binds an identical build", () => {
		const root = join(control, "bind-good");
		write(join(root, "dist/a.d.ts"), "export type A = 1;\n");
		write(join(root, "maps/dist/a.d.ts"), "export type A = 1;\n");
		expect(
			bindDeclarationMaps(join(root, "dist"), join(root, "maps/dist")),
		).toEqual({ candidate: join(root, "dist"), dir: join(root, "maps/dist") });
	});
});
