import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BUILD_ENTRIES } from "./catalogue.ts";
import { consumerDir, reportsDir } from "./paths.ts";
import { assertFreshPack } from "./prepare.ts";
import { run } from "./run.ts";

/**
 * Packed CommonJS consumer. Runs
 * `check.cjs` in the installed `cjs-node` consumer.
 */
interface CjsReport {
	page: Array<{
		id: string;
		loaded: boolean;
		error: { code?: string; message: string } | null;
		esmError?: { code?: string; message: string };
		cjs: string[];
		esm: string[];
	}>;
	build: Array<{
		id: string;
		loaded: boolean;
		error: { code?: string; message: string } | null;
		esmError?: { code?: string; message: string };
		cjs: string[];
		esm: string[];
		cjsType: string | null;
		cjsFunctions: string[];
		esmDefaultType: string | null;
		esmFunctions: string[];
	}>;
	esmOnly: Array<{ id: string; require: { code?: string } | null }>;
	deep: Array<{
		id: string;
		require: { code?: string } | null;
		import: { code?: string } | null;
	}>;
	codes: Record<
		string,
		{ cjs: { code?: string } | null; esm: { code?: string } | null }
	>;
	crossRecognition: {
		esmRecognisesCjs: boolean;
		cjsRecognisesEsm: boolean;
		sameClass: boolean;
	};
}

/** The one runtime export of each build entry (`default` = the loader). */
const BUILD_FACTORIES: Record<(typeof BUILD_ENTRIES)[number], string> = {
	"./vite": "spinetab",
	"./webpack": "spinetab",
	"./rspack": "spinetab",
	"./next": "withSpinetab",
	"./astro": "spinetab",
	"./nuxt": "default",
	"./loader": "default",
};

let report: CjsReport;

beforeAll(async () => {
	assertFreshPack("consumers:cjs");
	const root = consumerDir("cjs-node");
	const result = await run(process.execPath, ["check.cjs"], {
		cwd: root,
		timeoutMs: 120_000,
		logFile: join(reportsDir("cjs-node"), "check.log"),
	});
	if (result.code !== 0) throw new Error(result.output);
	const json = result.output.slice(result.output.indexOf("{"));
	report = JSON.parse(json) as CjsReport;
});

afterAll(() => {
	assertFreshPack("consumers:cjs (end)");
});

describe("cjs-node", () => {
	it("requires every page entry without ERR_REQUIRE_ESM or ERR_REQUIRE_ASYNC_MODULE", () => {
		const failed = report.page.filter((entry) => !entry.loaded);
		expect(failed).toEqual([]);
	});

	it("exposes the same names from the CommonJS and ESM copies", () => {
		for (const entry of report.page) {
			expect(entry.esmError, entry.id).toBeUndefined();
			expect(entry.cjs, entry.id).toEqual(entry.esm);
		}
	});

	it("requires and imports every build entry with its one factory", () => {
		const expected = Object.fromEntries(
			BUILD_ENTRIES.map((subpath) => [
				`spinetab/${subpath.slice(2)}`,
				BUILD_FACTORIES[subpath],
			]),
		);
		expect(report.build.map((entry) => entry.id).sort()).toEqual(
			Object.keys(expected).sort(),
		);
		for (const entry of report.build) {
			const factory = expected[entry.id];
			expect(entry.error, entry.id).toBeNull();
			expect(entry.loaded, entry.id).toBe(true);
			expect(entry.esmError, entry.id).toBeUndefined();
			if (factory === "default") {
				// `spinetab/loader`: webpack and Turbopack require the module
				// itself as the loader function; ESM has it as the default.
				expect(entry.cjsType, entry.id).toBe("function");
				expect(entry.esmDefaultType, entry.id).toBe("function");
				expect(entry.esm, entry.id).toEqual([]);
				continue;
			}
			expect(entry.cjs, entry.id).toEqual([factory]);
			expect(entry.esm, entry.id).toEqual([factory]);
			expect(entry.cjsFunctions, entry.id).toEqual([factory]);
			expect(entry.esmFunctions, entry.id).toEqual([factory]);
			// Named exports only.
			expect(entry.esmDefaultType, entry.id).toBeNull();
		}
	});

	it("does not export runtime entries, the worker entry, deep paths or package.json", () => {
		for (const entry of report.esmOnly) {
			expect(entry.require?.code, entry.id).toBe(
				"ERR_PACKAGE_PATH_NOT_EXPORTED",
			);
		}
		for (const entry of report.deep) {
			expect(entry.require?.code, entry.id).toBe(
				"ERR_PACKAGE_PATH_NOT_EXPORTED",
			);
			expect(entry.import?.code, entry.id).toBe(
				"ERR_PACKAGE_PATH_NOT_EXPORTED",
			);
		}
	});

	it("identifies errors by code across the dual copies", () => {
		for (const [name, codes] of Object.entries(report.codes)) {
			expect(codes.cjs?.code, name).toBeDefined();
			expect(codes.cjs?.code, name).toBe(codes.esm?.code);
		}
		expect(report.codes["invalid-endpoint"]?.cjs?.code).toBe(
			"invalid-endpoint",
		);
		expect(report.codes["unsupported-option"]?.cjs?.code).toBe(
			"unsupported-option",
		);
		expect(report.crossRecognition.esmRecognisesCjs).toBe(true);
		expect(report.crossRecognition.cjsRecognisesEsm).toBe(true);
	});
});
