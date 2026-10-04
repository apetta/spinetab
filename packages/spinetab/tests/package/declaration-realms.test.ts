import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { ENTRY_RULES, packageName } from "./allowlist.ts";
import {
	distDir,
	packageRoot,
	readManifest,
	specifierOf,
	targets,
} from "./dist.ts";
import { closureOf, distRelative } from "./graph.ts";

/**
 * Realm type-checks of the built declarations, each with
 * `strict` and `skipLibCheck: false` unless stated. The package resolves
 * itself through its own `exports`, so every realm exercises the shipped
 * entry conditions; peers resolve from the package's devDependencies.
 *
 * - worker: every runtime entry under the `WebWorker` lib only, no ambient
 *   `@types`. The declarations may not name DOM-only types
 *   or import a peer whose declarations need DOM or Node.
 * - page: page entries without type peers under the DOM lib, no ambient
 *   `@types`, zero errors.
 * - page with peers: every page entry, peer-typed ones included,
 *   under `bundler` and `nodenext`, with every type peer installed. Each
 *   error is attributed to the file that holds it: an error in a Spinetab
 *   declaration, in the entry or in no file fails; an error inside a
 *   third-party package passes only when a peer-only control, importing
 *   exactly the bare specifiers the page declarations import, reports it
 *   too, so it is the peer's own.
 * - build: build entries in a Node realm (`ES2022`, `types: ["node"]`, no
 *   DOM).
 * - commonjs: a `node16` CommonJS entry (`entry.cts`) resolves the `require`
 *   condition of every dual entry without type peers, build entries
 *   included, as a `webpack.config.cts` or `next.config.ts` compiled to
 *   CommonJS sees it. Peer-typed entries are not judged under CommonJS
 *   resolution (`ai` and `solid-js` ship ESM-only types).
 * - build entries plug into each bundler's own config types, with
 *   `skipLibCheck: true`: the bundlers are devDependencies only and
 *   their declarations are not Spinetab's.
 *
 * Not covered here: TypeScript releases other than the installed one (the
 * floor is derived and executed with the pinned floor compiler in
 * typescript-floor.test.ts) and consumers with only their selected peers
 * installed (the packed consumers). An exported subpath without a rule fails
 * (entry-rules).
 */
const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
const workDir = join(packageRoot, "test-results/declaration-realms");

interface Realm {
	name: string;
	lib: string[];
	types: string[];
	subpaths: string[];
	/** `node16` compiles a CommonJS `entry.cts` against the `require` condition. */
	module?: "preserve" | "node16";
}

const PAGE_LIB = ["ES2022", "DOM", "DOM.Iterable", "DOM.AsyncIterable"];

function realms(): Realm[] {
	const manifest = readManifest();
	const exported = new Set(Object.keys(manifest.exports));
	const runtime: string[] = [];
	const page: string[] = [];
	const build: string[] = [];
	const commonjs: string[] = [];
	for (const target of targets()) {
		const rule = ENTRY_RULES[target.subpath];
		// entry-rules.test.ts fails an unruled export; never judge it here.
		if (!rule) throw new Error(`No allow-list rule for ${target.subpath}`);
		if (!exported.has(target.subpath)) continue;
		if (rule.realm === "runtime") runtime.push(target.subpath);
		else if (rule.realm === "build") build.push(target.subpath);
		else if (rule.typePeers.length === 0) page.push(target.subpath);
		// Peer-typed entries need the peer installed; the page realm skips
		// them for the same reason.
		if (target.require && rule.typePeers.length === 0) {
			commonjs.push(target.subpath);
		}
	}
	return [
		{
			name: "worker",
			lib: ["ES2022", "WebWorker"],
			types: [],
			subpaths: runtime,
		},
		{ name: "page", lib: PAGE_LIB, types: [], subpaths: page },
		{ name: "build", lib: ["ES2022"], types: ["node"], subpaths: build },
		{
			name: "commonjs",
			lib: PAGE_LIB,
			types: ["node"],
			subpaths: commonjs,
			module: "node16",
		},
	];
}

function compile(
	name: string,
	lib: string[],
	source: string,
	options: {
		types?: string[];
		skipLibCheck?: boolean;
		module?: "preserve" | "node16" | "nodenext";
	} = {},
) {
	const dir = join(workDir, name);
	const module = options.module ?? "preserve";
	// `.cts` makes the entry CommonJS and `.mts` ESM whatever the package
	// `type` says.
	const entry = {
		preserve: "entry.ts",
		node16: "entry.cts",
		nodenext: "entry.mts",
	}[module];
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, entry), source);
	writeFileSync(
		join(dir, "tsconfig.json"),
		JSON.stringify(
			{
				compilerOptions: {
					target: "ES2022",
					lib,
					module,
					moduleResolution: module === "preserve" ? "bundler" : module,
					strict: true,
					skipLibCheck: options.skipLibCheck ?? false,
					noEmit: true,
					types: options.types ?? [],
				},
				include: [entry],
			},
			null,
			"\t",
		),
	);
	const result = spawnSync(
		process.execPath,
		[tsc, "-p", join(dir, "tsconfig.json"), "--pretty", "false"],
		{ cwd: dir, encoding: "utf8", env: { ...process.env, NODE_PATH: "" } },
	);
	return {
		code: result.status,
		output: `${result.stdout}${result.stderr}`,
		dir,
	};
}

const namespaceImports = (specifiers: string[]) =>
	`${specifiers
		.map(
			(specifier, index) =>
				`import * as entry${index} from "${specifier}";\nexport { entry${index} };`,
		)
		.join("\n")}\n`;

/** Every page entry, peer-typed ones included. */
function pageEntries(): string[] {
	return targets()
		.map((target) => target.subpath)
		.filter((subpath) => ENTRY_RULES[subpath]?.realm === "page");
}

/** Third-party bare specifiers the entries' declarations import: the peer-only control imports exactly these. */
function peerSpecifiers(subpaths: string[]): string[] {
	const found = new Set<string>();
	for (const target of targets()) {
		if (!subpaths.includes(target.subpath)) continue;
		const closure = closureOf(distDir, distRelative(target.import.types));
		expect(closure.unresolved, target.subpath).toEqual([]);
		for (const specifier of closure.bare.keys()) {
			if (packageName(specifier) !== "spinetab") found.add(specifier);
		}
	}
	return [...found].sort();
}

interface Diagnostic {
	/** `spinetab`, `entry`, `package:<name>`, or `none` (no file, or unattributable). */
	owner: string;
	/** Location (real path, relative to the package) and message. */
	text: string;
}

const realDist = realpathSync(distDir);

function realPathOf(path: string): string | undefined {
	try {
		return realpathSync(path);
	} catch {
		return undefined;
	}
}

/** The file's holder: Spinetab's `dist`, the realm's own entry, or a package. */
function ownerOf(path: string | undefined, cwd: string): string {
	if (!path) return "none";
	if (path.startsWith(realDist + sep)) return "spinetab";
	if (path.startsWith(realpathSync(cwd) + sep)) return "entry";
	const marker = `${sep}node_modules${sep}`;
	const at = path.lastIndexOf(marker);
	if (at === -1) return "none";
	const rest = path
		.slice(at + marker.length)
		.split(sep)
		.join("/");
	return `package:${packageName(rest)}`;
}

/** `--pretty false` output as diagnostics, each attributed to the file that holds it. */
function diagnosticsOf(output: string, cwd: string): Diagnostic[] {
	const found: Diagnostic[] = [];
	for (const line of output.split(/\r?\n/)) {
		// Indented lines continue a chained message.
		if (line.trim() === "" || /^\s/.test(line)) continue;
		const match = /^(.+)\((\d+),(\d+)\): (error TS\d+: .*)$/.exec(line);
		if (!match) {
			found.push({ owner: "none", text: line });
			continue;
		}
		const [, file = "", row, column, message] = match;
		const path = realPathOf(resolve(cwd, file));
		const where = path
			? relative(packageRoot, path).split(sep).join("/")
			: file;
		found.push({
			owner: ownerOf(path, cwd),
			text: `${where}(${row},${column}): ${message}`,
		});
	}
	return found;
}

/**
 * A realm against its peer-only control: an error outside third-party
 * packages fails, and third-party errors must be the control's, exactly.
 */
function judge(realm: Diagnostic[], control: Diagnostic[]) {
	const thirdParty = (diagnostic: Diagnostic) =>
		diagnostic.owner.startsWith("package:");
	const show = (diagnostic: Diagnostic) =>
		`${diagnostic.owner} ${diagnostic.text}`;
	const expected = new Set(control.filter(thirdParty).map(show));
	const reported = new Set(realm.filter(thirdParty).map(show));
	return {
		ours: realm.filter((diagnostic) => !thirdParty(diagnostic)).map(show),
		unexplained: [...reported].filter((text) => !expected.has(text)),
		missing: [...expected].filter((text) => !reported.has(text)),
		control: control.filter((diagnostic) => !thirdParty(diagnostic)).map(show),
		explained: [...reported].filter((text) => expected.has(text)),
	};
}

describe("declaration realms", () => {
	for (const realm of realms()) {
		it(`${realm.name} entries type-check with the ${realm.lib.join("+")} lib and types [${realm.types.join(", ")}]`, () => {
			expect(realm.subpaths.length).toBeGreaterThan(0);
			// Namespace imports make the checker resolve every exported declaration.
			const source = namespaceImports(realm.subpaths.map(specifierOf));
			const result = compile(realm.name, realm.lib, source, {
				types: realm.types,
				module: realm.module,
			});
			expect(result.code, result.output).toBe(0);
		});
	}

	it("the commonjs realm covers every build entry and resolves the require condition (control)", () => {
		const commonjs = realms().find((realm) => realm.name === "commonjs");
		const build = realms().find((realm) => realm.name === "build");
		expect(commonjs?.subpaths).toEqual(
			expect.arrayContaining(build?.subpaths ?? []),
		);
		// The ESM-only keep stub has no require condition: node16 CommonJS
		// resolution must refuse it, which proves the realm is not bundler's.
		const result = compile(
			"commonjs-control",
			PAGE_LIB,
			'import * as stub from "spinetab/auto/wiring";\nexport { stub };\n',
			{ types: ["node"], module: "node16" },
		);
		expect(result.code).not.toBe(0);
		expect(result.output).toMatch(/entry\.cts.*TS(1479|2307|1541|2305)/);
	});

	it("the CommonJS loader has the default export its declaration names", () => {
		// `loader.d.cts` declares `export default`, which a CommonJS consumer
		// reads as `require("spinetab/loader").default`; loader runners read
		// `module.exports`. Both must be the loader function.
		const require = createRequire(join(packageRoot, "package.json"));
		const path = require.resolve("spinetab/loader");
		expect(path).toBe(join(packageRoot, "dist", "build", "loader.cjs"));
		const loader = require(path) as { default?: unknown };
		expect(typeof loader).toBe("function");
		expect(loader.default).toBe(loader);
		const result = compile(
			"commonjs-loader-default",
			PAGE_LIB,
			[
				'import loader = require("spinetab/loader");',
				"export const run: (source: string) => string = (source) =>",
				"\tloader.default.call({} as never, source);",
				"",
			].join("\n"),
			{ types: ["node"], module: "node16" },
		);
		expect(result.code, result.output).toBe(0);
	});

	it("build realm has no DOM: a build declaration naming a DOM type would fail (control)", () => {
		const result = compile(
			"build-control",
			["ES2022"],
			'import "spinetab/vite";\nexport declare const w: Window;\n',
			{ types: ["node"] },
		);
		expect(result.code).not.toBe(0);
		expect(result.output).toMatch(/TS2304: Cannot find name 'Window'/);
	});

	it("worker realm has no Node types: a declaration naming Buffer would fail (control)", () => {
		const result = compile(
			"worker-node-control",
			["ES2022", "WebWorker"],
			'import "spinetab/worker";\nexport declare const b: Buffer;\n',
		);
		expect(result.code).not.toBe(0);
		expect(result.output).toMatch(/TS(2304|2591): Cannot find name 'Buffer'/);
	});

	it("build entries plug into each bundler's own config types", () => {
		// The bundler packages are devDependencies only. Their own
		// declarations are skipped; this checks the assignments in the entry.
		const source = [
			'import type { AstroIntegration } from "astro";',
			'import type { NextConfig } from "next";',
			'import type { RspackOptions } from "@rspack/core";',
			'import type { PluginOption } from "vite";',
			'import type { Configuration } from "webpack";',
			'import { spinetab as astro } from "spinetab/astro";',
			'import { withSpinetab } from "spinetab/next";',
			'import { spinetab as rspack } from "spinetab/rspack";',
			'import { spinetab as vite } from "spinetab/vite";',
			'import { spinetab as webpack } from "spinetab/webpack";',
			"",
			"export const a: PluginOption = [vite()];",
			'export const b: Configuration["plugins"] = [webpack()];',
			'export const c: RspackOptions["plugins"] = [rspack()];',
			"export const d: AstroIntegration = astro();",
			"export const e: (",
			"\tphase: string,",
			"\tcontext: { defaultConfig: NextConfig },",
			") => Promise<NextConfig> = withSpinetab({ reactStrictMode: true });",
			'export const f = withSpinetab(async () => ({ basePath: "/x" }));',
			"export const g = withSpinetab((phase: string) => ({ distDir: phase }));",
			"// options, every one optional.",
			"vite({",
			'\tworker: "src/spinetab.worker.ts",',
			'\tadapters: ["polling", "sse", "stream", "websocket", "graphql-ws", "graphql-sse", "socket-io", "trpc-ws", "trpc-sse", "ai-sdk"],',
			'\tcredentialOrigins: ["https://api.example.com"],',
			"});",
			"withSpinetab({}, { adapters: [] });",
			"// the Next project directory, for withSpinetab only.",
			'withSpinetab({}, { dir: "/work/apps/web", adapters: ["sse"] });',
			"// @ts-expect-error: dir belongs to withSpinetab.",
			'vite({ dir: "/work/app" });',
			"// @ts-expect-error: nothing beyond worker, adapters and credentialOrigins.",
			"vite({ limits: {} });",
			"// @ts-expect-error: adapters are the table's names only.",
			'webpack({ adapters: ["graphql"] });',
			"",
		].join("\n");
		const result = compile("build-configs", [...PAGE_LIB], source, {
			types: ["node"],
			skipLibCheck: true,
		});
		expect(result.code, result.output).toBe(0);
	});

	it("detects a DOM-only type in the worker realm (control)", () => {
		const result = compile(
			"worker-control",
			["ES2022", "WebWorker"],
			'import "spinetab/worker";\nexport declare const w: SharedWorker;\n',
		);
		expect(result.code).not.toBe(0);
		expect(result.output).toMatch(/TS2304: Cannot find name 'SharedWorker'/);
	});

	it("every page entry is compiled with skipLibCheck: false, peer-typed ones included", () => {
		const pages = targets()
			.map((target) => target.subpath)
			.filter((subpath) => ENTRY_RULES[subpath]?.realm === "page");
		expect(
			pages.some((subpath) => ENTRY_RULES[subpath]?.typePeers.length),
		).toBe(true);
		const checked = new Set([
			...realms().flatMap((realm) => realm.subpaths),
			...pageEntries(),
		]);
		expect(pages.filter((subpath) => !checked.has(subpath))).toEqual([]);
	});

	for (const module of ["preserve", "nodenext"] as const) {
		const resolution = module === "preserve" ? "bundler" : module;
		it(`page entries with every type peer installed type-check under ${resolution}; errors are attributed to Spinetab or the peer`, () => {
			const subpaths = pageEntries();
			const peers = [
				...new Set(
					subpaths.flatMap((subpath) => ENTRY_RULES[subpath]?.typePeers ?? []),
				),
			].sort();
			// Every type peer is installed, so no entry is judged without its peer.
			const missingPeers = peers.filter(
				(peer) =>
					!existsSync(join(packageRoot, "node_modules", peer, "package.json")),
			);
			expect(missingPeers).toEqual([]);
			const specifiers = peerSpecifiers(subpaths);
			expect(
				specifiers.filter(
					(specifier) => !peers.includes(packageName(specifier)),
				),
			).toEqual([]);
			const realm = compile(
				`page-peers-${resolution}`,
				PAGE_LIB,
				namespaceImports(subpaths.map(specifierOf)),
				{ module },
			);
			const control = compile(
				`page-peers-${resolution}-control`,
				PAGE_LIB,
				namespaceImports(specifiers),
				{ module },
			);
			const tsconfig = JSON.parse(
				readFileSync(join(realm.dir, "tsconfig.json"), "utf8"),
			) as { compilerOptions: { skipLibCheck: boolean } };
			expect(tsconfig.compilerOptions.skipLibCheck).toBe(false);
			const found = diagnosticsOf(realm.output, realm.dir);
			const expected = diagnosticsOf(control.output, control.dir);
			// tsc exits 0 when clean and 2 with errors; anything else is a crash.
			expect(realm.code === 0 || (realm.code === 2 && found.length > 0)).toBe(
				true,
			);
			expect(
				control.code === 0 || (control.code === 2 && expected.length > 0),
			).toBe(true);
			const verdict = judge(found, expected);
			console.info(
				`[declaration realms] page with peers (${resolution}): ${verdict.explained.length} third-party errors, each reported by the peer-only control too${verdict.explained.map((text) => `\n  ${text}`).join("")}`,
			);
			expect({
				ours: verdict.ours,
				unexplained: verdict.unexplained,
				missing: verdict.missing,
				control: verdict.control,
			}).toEqual({ ours: [], unexplained: [], missing: [], control: [] });
		});
	}

	it("attributes each error to Spinetab or the peer that holds it (control)", () => {
		// Without the DOM lib `spinetab/apollo` fails both in Spinetab's own
		// declarations (AbortSignal, MessagePort, Event) and inside Apollo and
		// its dependencies; only Spinetab's errors are judged against it.
		const lib = ["ES2022"];
		const realm = compile(
			"page-peers-attribution-control",
			lib,
			namespaceImports(["spinetab/apollo"]),
		);
		const control = compile(
			"page-peers-attribution-control-peers",
			lib,
			namespaceImports(peerSpecifiers(["./apollo"])),
		);
		const found = diagnosticsOf(realm.output, realm.dir);
		const expected = diagnosticsOf(control.output, control.dir);
		const verdict = judge(found, expected);
		expect(verdict.ours.length).toBeGreaterThan(0);
		for (const text of verdict.ours) {
			expect(text).toMatch(
				/^spinetab dist\/[\w./-]+\.d\.ts\(\d+,\d+\): error TS2304: Cannot find name '\w+'\.$/,
			);
		}
		expect(
			found.some((diagnostic) => diagnostic.owner === "package:@apollo/client"),
		).toBe(true);
		expect({
			unexplained: verdict.unexplained,
			missing: verdict.missing,
			control: verdict.control,
		}).toEqual({ unexplained: [], missing: [], control: [] });
		// Without the control every third-party error would be unexplained, and
		// an empty realm would miss every one of the control's.
		expect(judge(found, []).unexplained).toHaveLength(verdict.explained.length);
		expect(judge([], expected).missing).toHaveLength(verdict.explained.length);
		expect(verdict.explained.length).toBeGreaterThan(0);
	});

	it("an error without a file, or a line tsc does not write, fails the realm (control)", () => {
		const found = diagnosticsOf(
			"error TS5023: Unknown compiler option 'x'.\nSegmentation fault\n    at frame (tsc.js:1:1)\n",
			workDir,
		);
		expect(found.map((diagnostic) => diagnostic.owner)).toEqual([
			"none",
			"none",
		]);
		// The control reporting the same lines never excuses them.
		expect(judge(found, found).ours).toHaveLength(2);
	});
});
