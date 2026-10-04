import { join } from "node:path";
import { inspect } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { SpinetabBuildError } from "../../../src/build/messages.ts";
import {
	dotRelative,
	findPackageDir,
	inNodeModules,
	relativePosix,
	toPosix,
} from "../../../src/build/paths.ts";
import {
	adapterEntryOfPath,
	isDefaultWiringPath,
} from "../../../src/build/plan.ts";
import { cleanTrees, installSpinetab, link, makeTree } from "./tree.ts";

afterEach(cleanTrees);

describe("POSIX relative emission", () => {
	it("gives the same text for Windows-style and POSIX inputs", () => {
		expect(
			relativePosix("C:\\work\\app", "C:\\work\\app\\src\\spinetab.worker.ts"),
		).toBe("src/spinetab.worker.ts");
		expect(
			relativePosix("c:/work/app", "C:\\work\\app\\app\\spinetab.worker.ts"),
		).toBe("app/spinetab.worker.ts");
		expect(relativePosix("/work/app", "/work/app/src/spinetab.worker.ts")).toBe(
			"src/spinetab.worker.ts",
		);
		expect(
			dotRelative("D:\\repo\\apps\\web", "D:\\repo\\apps\\web\\lib\\w.ts"),
		).toBe("./lib/w.ts");
		expect(dotRelative("/repo/apps/web", "/repo/packages/w.ts")).toBe(
			"../../packages/w.ts",
		);
		expect(toPosix("a\\b\\c")).toBe("a/b/c");
	});

	it("recognises package paths on either separator", () => {
		expect(inNodeModules("C:\\app\\node_modules\\x\\a.js")).toBe(true);
		expect(inNodeModules("/app/src/node_modules_like/a.js")).toBe(false);
		expect(
			isDefaultWiringPath("C:\\a\\node_modules\\spinetab\\dist\\wiring.js"),
		).toBe(true);
		expect(
			isDefaultWiringPath("/a/node_modules/spinetab/dist/auto/wiring.js"),
		).toBe(false);
		expect(adapterEntryOfPath("/a/node_modules/spinetab/dist/polling.js")).toBe(
			"polling",
		);
		expect(adapterEntryOfPath("/a/node_modules/spinetab/dist/react.js")).toBe(
			undefined,
		);
	});
});

describe("findPackageDir (shared by the Vite and webpack plugins)", () => {
	it("returns the real installed directory, walking up from the root", () => {
		const root = makeTree({ "apps/web/src/a.ts": "export {};" });
		const installed = installSpinetab(root);
		expect(findPackageDir(join(root, "apps", "web"))).toBe(installed);
		// A pnpm-style link: the real path, as bundlers name module ids.
		const store = makeTree();
		const real = installSpinetab(store);
		const app = makeTree();
		link(real, join(app, "node_modules", "spinetab"));
		expect(findPackageDir(app)).toBe(real);
	});

	it("throws package-not-installed, stackless and naming no path, when the package is missing", () => {
		const root = makeTree();
		let caught: unknown;
		try {
			findPackageDir(root);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(SpinetabBuildError);
		const error = caught as SpinetabBuildError;
		expect(error.code).toBe("package-not-installed");
		expect(error.message).toBe(
			"[spinetab] package-not-installed: the spinetab package is not installed in this project.",
		);
		expect(error.hideStack).toBe(true);
		expect(error.stack).toBe(`SpinetabBuildError: ${error.message}`);
		expect(inspect(error)).not.toContain(root);
		expect(inspect(error)).not.toMatch(/\bat\s/);
	});
});
