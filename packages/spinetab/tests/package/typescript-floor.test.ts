import {
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { ENTRY_RULES } from "./allowlist.ts";
import { distDir, packageRoot, specifierOf, targets } from "./dist.ts";
import { isDeclaration, walk } from "./graph.ts";

// Compile every published declaration with the documented minimum compiler.
// Peer diagnostics are reported separately; package and entry diagnostics fail.

/** The documented floor (compatibility page): TypeScript 5.7 or later. */
const TYPESCRIPT_FLOOR = "5.7";

const PAGE_LIB = ["ES2022", "DOM", "DOM.Iterable", "DOM.AsyncIterable"];
const workDir = join(packageRoot, "test-results/typescript-floor");
const realDist = realpathSync(distDir);

interface Environment {
	name: string;
	lib: string[];
	types: string[];
	module: "preserve" | "node16";
	subpaths: string[];
}

/**
 * The declaration-realms environments, each loading every entry it can
 * resolve: peer-typed page entries included, and every dual entry's
 * `require` declarations under node16 CommonJS.
 */
function environments(): Environment[] {
	const page: string[] = [];
	const runtime: string[] = [];
	const build: string[] = [];
	const commonjs: string[] = [];
	for (const target of targets()) {
		const rule = ENTRY_RULES[target.subpath];
		// entry-rules.test.ts fails an unruled export; never judge it here.
		if (!rule) throw new Error(`No allow-list rule for ${target.subpath}`);
		if (rule.realm === "runtime") runtime.push(target.subpath);
		else if (rule.realm === "build") build.push(target.subpath);
		else page.push(target.subpath);
		if (target.require) commonjs.push(target.subpath);
	}
	return [
		{
			name: "page",
			lib: PAGE_LIB,
			types: [],
			module: "preserve",
			subpaths: page,
		},
		{
			name: "worker",
			lib: ["ES2022", "WebWorker"],
			types: [],
			module: "preserve",
			subpaths: runtime,
		},
		{
			name: "build",
			lib: ["ES2022"],
			types: ["node"],
			module: "preserve",
			subpaths: build,
		},
		{
			name: "commonjs",
			lib: PAGE_LIB,
			types: ["node"],
			module: "node16",
			subpaths: commonjs,
		},
	];
}

function programOf(
	name: string,
	files: Record<string, string>,
	environment: Pick<Environment, "lib" | "types" | "module">,
	compiler: typeof ts = ts,
): ts.Program {
	const dir = join(workDir, name);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	for (const [file, text] of Object.entries(files)) {
		writeFileSync(join(dir, file), text);
	}
	const converted = compiler.convertCompilerOptionsFromJson(
		{
			target: "ES2022",
			lib: environment.lib,
			module: environment.module,
			moduleResolution: environment.module === "node16" ? "node16" : "bundler",
			strict: true,
			skipLibCheck: false,
			noEmit: true,
			types: environment.types,
		},
		dir,
	);
	const [error] = converted.errors;
	if (error) {
		throw new Error(
			compiler.flattenDiagnosticMessageText(error.messageText, "\n"),
		);
	}
	return compiler.createProgram({
		rootNames: Object.keys(files).map((file) => join(dir, file)),
		options: converted.options,
	});
}

const releaseOf = (version: string) => {
	const [major = 0, minor = 0] = version.split(".").map(Number);
	return major * 1000 + minor;
};

const unique = (values: string[]) => [...new Set(values)].sort();

const namespaceImports = (specifiers: string[]) =>
	`${specifiers
		.map(
			(specifier, index) =>
				`import * as entry${index} from "${specifier}";\nexport { entry${index} };`,
		)
		.join("\n")}\n`;

/** The devDependency alias that installs the floor compiler. */
const FLOOR_ALIAS = "typescript-floor";

/**
 * Names another TypeScript package directory in place of the installed floor
 * compiler, for evidence and mutation runs only: the pin row still requires
 * the pinned release, so an override never stands in for it.
 */
const FLOOR_OVERRIDE = "SPINETAB_TYPESCRIPT_FLOOR_DIR";

/** The exact release the alias pins; anything but one release of the floor throws. */
function floorPinOf(devDependencies: Record<string, string> = {}): string {
	const spec = devDependencies[FLOOR_ALIAS];
	const version =
		spec === undefined
			? undefined
			: /^npm:typescript@(\d+\.\d+\.\d+)$/.exec(spec)?.[1];
	if (!version || releaseOf(version) !== releaseOf(TYPESCRIPT_FLOOR)) {
		throw new Error(
			`Expected the devDependency "${FLOOR_ALIAS}": "npm:typescript@${TYPESCRIPT_FLOOR}.<patch>"; found ${spec === undefined ? "none" : `"${spec}"`}.`,
		);
	}
	return version;
}

const requireFromPackage = createRequire(join(packageRoot, "package.json"));

/** The installed alias's directory (never the override). */
function installedFloorDir(): string {
	try {
		return dirname(requireFromPackage.resolve(`${FLOOR_ALIAS}/package.json`));
	} catch {
		throw new Error(
			`The floor compiler is not installed: add the devDependency "${FLOOR_ALIAS}" and run pnpm install.`,
		);
	}
}

interface FloorCompiler {
	ts: typeof ts;
	/** Real path of the compiler's package directory. */
	dir: string;
}

let floor: FloorCompiler | undefined;

/** The compiler the executed rows run: the installed alias, or the override. */
function floorCompiler(): FloorCompiler {
	if (floor) return floor;
	const override = process.env[FLOOR_OVERRIDE];
	const dir = realpathSync(override ? resolve(override) : installedFloorDir());
	floor = { ts: requireFromPackage(dir) as typeof ts, dir };
	return floor;
}

interface FloorEnvironment extends Environment {
	/** `entry.ts` (bundler), `entry.mts` (node16 ESM) or `entry.cts` (node16 CommonJS). */
	entry: string;
}

/** Every environment under bundler and node16 resolution. */
function floorEnvironments(): FloorEnvironment[] {
	return environments().flatMap((environment): FloorEnvironment[] =>
		environment.module === "node16"
			? [
					{
						...environment,
						name: `${environment.name}-node16`,
						entry: "entry.cts",
					},
				]
			: [
					{
						...environment,
						name: `${environment.name}-bundler`,
						entry: "entry.ts",
					},
					{
						...environment,
						name: `${environment.name}-node16`,
						module: "node16",
						entry: "entry.mts",
					},
				],
	);
}

interface FloorDiagnostic {
	/** `spinetab` (a dist declaration), `entry`, `none` (no file) or `peer`. */
	owner: "spinetab" | "entry" | "none" | "peer";
	/** Dist-relative path for `spinetab`, else the real path (empty without a file). */
	file: string;
	/** Location for display. */
	where: string;
	code: number;
	/** Source text the diagnostic points at, such as an import specifier. */
	span: string;
	text: string;
}

function floorDiagnosticsOf(
	compiler: typeof ts,
	program: ts.Program,
	root: string,
): FloorDiagnostic[] {
	return compiler
		.getPreEmitDiagnostics(program)
		.map((diagnostic): FloorDiagnostic => {
			const text = compiler.flattenDiagnosticMessageText(
				diagnostic.messageText,
				" ",
			);
			const { code, file: source, start, length } = diagnostic;
			if (!source) {
				return {
					owner: "none",
					file: "",
					where: "(no file)",
					code,
					span: "",
					text,
				};
			}
			const real = realpathSync(source.fileName);
			const span =
				start === undefined
					? ""
					: source.text.slice(start, start + (length ?? 0));
			const line =
				start === undefined
					? 0
					: source.getLineAndCharacterOfPosition(start).line + 1;
			if (real.startsWith(realDist + sep)) {
				const file = relative(realDist, real).split(sep).join("/");
				return {
					owner: "spinetab",
					file,
					where: `${file}(${line})`,
					code,
					span,
					text,
				};
			}
			const owner = real.startsWith(root + sep) ? "entry" : "peer";
			return { owner, file: real, where: `${real}(${line})`, code, span, text };
		});
}

/**
 * Spinetab diagnostics that every compiler reports and leaves
 * unclaimed: CommonJS (node16) typing of an entry whose peer ships ESM-only
 * types (TS1479 at the peer's specifier). Exact both ways: any other
 * Spinetab diagnostic fails, and so does a listed one that no longer occurs.
 */
const UNCLAIMED: ReadonlyArray<{
	environment: string;
	file: string;
	code: number;
	peer: string;
}> = [
	{
		environment: "commonjs-node16",
		file: "ai-sdk.d.cts",
		code: 1479,
		peer: "ai",
	},
	{
		environment: "commonjs-node16",
		file: "solid.d.cts",
		code: 1479,
		peer: "solid-js",
	},
];

/** An environment's diagnostics judged: a peer's own are reported, not judged. */
function floorVerdict(environment: string, diagnostics: FloorDiagnostic[]) {
	const allowed = UNCLAIMED.filter((row) => row.environment === environment);
	const matches = (
		diagnostic: FloorDiagnostic,
		row: (typeof UNCLAIMED)[number],
	) =>
		diagnostic.owner === "spinetab" &&
		diagnostic.file === row.file &&
		diagnostic.code === row.code &&
		diagnostic.span === JSON.stringify(row.peer);
	const show = (diagnostic: FloorDiagnostic) =>
		`${diagnostic.owner} ${diagnostic.where}: TS${diagnostic.code} ${diagnostic.text}`;
	return {
		unexpected: diagnostics
			.filter(
				(diagnostic) =>
					diagnostic.owner !== "peer" &&
					!allowed.some((row) => matches(diagnostic, row)),
			)
			.map(show),
		unused: allowed
			.filter(
				(row) => !diagnostics.some((diagnostic) => matches(diagnostic, row)),
			)
			.map((row) => `${row.file} TS${row.code} (${row.peer})`),
		peer: diagnostics
			.filter((diagnostic) => diagnostic.owner === "peer")
			.map(show),
	};
}

interface FloorRun {
	version: string;
	/** Real directories of the program's default lib files. */
	libDirs: string[];
	/** Dist-relative Spinetab declaration files in the program. */
	files: string[];
	diagnostics: FloorDiagnostic[];
}

const floorRuns = new Map<string, FloorRun>();

/** One environment compiled by the floor compiler, once per test file. */
function floorRun(environment: FloorEnvironment): FloorRun {
	const cached = floorRuns.get(environment.name);
	if (cached) return cached;
	const compiler = floorCompiler();
	const name = `floor-${environment.name}`;
	const program = programOf(
		name,
		{
			[environment.entry]: namespaceImports(
				environment.subpaths.map(specifierOf),
			),
		},
		environment,
		compiler.ts,
	);
	const files = program
		.getSourceFiles()
		.map((source) => realpathSync(source.fileName));
	const run: FloorRun = {
		version: compiler.ts.version,
		libDirs: unique(
			program
				.getSourceFiles()
				.filter((source) => program.isSourceFileDefaultLibrary(source))
				.map((source) => dirname(realpathSync(source.fileName))),
		),
		files: unique(
			files
				.filter((file) => file.startsWith(realDist + sep))
				.map((file) => relative(realDist, file).split(sep).join("/")),
		),
		diagnostics: floorDiagnosticsOf(
			compiler.ts,
			program,
			realpathSync(join(workDir, name)),
		),
	};
	floorRuns.set(environment.name, run);
	return run;
}

describe("TypeScript floor, executed with the pinned floor compiler", () => {
	it(`the floor compiler is one exact TypeScript ${TYPESCRIPT_FLOOR} release, pinned and installed`, () => {
		const manifest = JSON.parse(
			readFileSync(join(packageRoot, "package.json"), "utf8"),
		) as { devDependencies?: Record<string, string> };
		const pinned = floorPinOf(manifest.devDependencies);
		const installed = JSON.parse(
			readFileSync(join(installedFloorDir(), "package.json"), "utf8"),
		) as { name?: string; version?: string };
		expect([installed.name, installed.version]).toEqual(["typescript", pinned]);
		// An override (evidence and mutation runs) must be the pinned release too.
		expect(floorCompiler().ts.version).toBe(pinned);
	});

	it("a pin is one exact release of the floor (control)", () => {
		expect(
			floorPinOf({
				typescript: "6.0.3",
				[FLOOR_ALIAS]: `npm:typescript@${TYPESCRIPT_FLOOR}.3`,
			}),
		).toBe(`${TYPESCRIPT_FLOOR}.3`);
		const refused: Array<Record<string, string>> = [
			{},
			{ typescript: `${TYPESCRIPT_FLOOR}.3` },
			{ [FLOOR_ALIAS]: `npm:typescript@^${TYPESCRIPT_FLOOR}.3` },
			{ [FLOOR_ALIAS]: `npm:typescript@${TYPESCRIPT_FLOOR}.x` },
			{ [FLOOR_ALIAS]: `npm:typescript@${TYPESCRIPT_FLOOR}.3-rc` },
			{ [FLOOR_ALIAS]: `${TYPESCRIPT_FLOOR}.3` },
			{ [FLOOR_ALIAS]: "npm:typescript@5.6.3" },
			{ [FLOOR_ALIAS]: "npm:typescript@5.8.2" },
			{ [FLOOR_ALIAS]: "npm:typescript@6.0.3" },
			{ "typescript-5.7": `npm:typescript@${TYPESCRIPT_FLOOR}.3` },
		];
		for (const devDependencies of refused) {
			expect(
				() => floorPinOf(devDependencies),
				JSON.stringify(devDependencies),
			).toThrow(
				`"${FLOOR_ALIAS}": "npm:typescript@${TYPESCRIPT_FLOOR}.<patch>"`,
			);
		}
	});

	it("compiles every published declaration file, under bundler and node16 resolution", () => {
		const all = floorEnvironments();
		expect(all.map((environment) => environment.name)).toEqual([
			"page-bundler",
			"page-node16",
			"worker-bundler",
			"worker-node16",
			"build-bundler",
			"build-node16",
			"commonjs-node16",
		]);
		expect(
			unique(all.flatMap((environment) => floorRun(environment).files)),
		).toEqual(walk(distDir).filter(isDeclaration));
	});

	for (const environment of floorEnvironments()) {
		it(`${environment.name}: no diagnostic in a Spinetab declaration or the entry`, () => {
			const compiler = floorCompiler();
			const run = floorRun(environment);
			// The floor compiler built the program: its default libs are its own.
			expect(run.libDirs.length).toBeGreaterThan(0);
			for (const dir of run.libDirs) {
				expect(dir.startsWith(compiler.dir + sep), dir).toBe(true);
			}
			const verdict = floorVerdict(environment.name, run.diagnostics);
			console.info(
				`[typescript floor] TypeScript ${run.version}, ${environment.name}: ${run.files.length} Spinetab declaration files; ${verdict.peer.length} peer diagnostics, not judged${verdict.peer.map((text) => `\n  ${text}`).join("")}`,
			);
			expect({
				unexpected: verdict.unexpected,
				unused: verdict.unused,
			}).toEqual({ unexpected: [], unused: [] });
		});
	}

	it("attributes each diagnostic and judges it; the unclaimed list is exact (control)", () => {
		// The installed compiler without the DOM lib: Spinetab's page
		// declarations fail (TS2304) and an unresolvable entry import fails.
		const program = programOf(
			"floor-control",
			{
				"entry.ts": namespaceImports(["spinetab/apollo", "spinetab/missing"]),
			},
			{ lib: ["ES2022"], types: [], module: "preserve" },
		);
		const diagnostics = floorDiagnosticsOf(
			ts,
			program,
			realpathSync(join(workDir, "floor-control")),
		);
		expect(unique(diagnostics.map((diagnostic) => diagnostic.owner))).toEqual([
			"entry",
			"peer",
			"spinetab",
		]);
		const verdict = floorVerdict("page-bundler", diagnostics);
		expect(verdict.unexpected).toHaveLength(
			diagnostics.filter((diagnostic) => diagnostic.owner !== "peer").length,
		);
		expect(verdict.peer.length).toBeGreaterThan(0);
		const listed = (over: Partial<FloorDiagnostic> = {}): FloorDiagnostic => ({
			owner: "spinetab",
			file: "ai-sdk.d.cts",
			where: "ai-sdk.d.cts(2)",
			code: 1479,
			span: '"ai"',
			text: "TS1479",
			...over,
		});
		const both = [
			listed(),
			listed({ file: "solid.d.cts", span: '"solid-js"' }),
		];
		expect(floorVerdict("commonjs-node16", both)).toMatchObject({
			unexpected: [],
			unused: [],
		});
		for (const other of [
			listed({ code: 2307 }),
			listed({ file: "react.d.cts" }),
			listed({ span: '"react"' }),
			listed({ owner: "entry" }),
			listed({ owner: "none", file: "" }),
		]) {
			expect(
				floorVerdict("commonjs-node16", [...both, other]).unexpected,
				JSON.stringify(other),
			).toHaveLength(1);
		}
		// Unclaimed only in its environment, and a listed row that no longer
		// occurs fails.
		expect(floorVerdict("page-node16", both).unexpected).toHaveLength(2);
		expect(floorVerdict("commonjs-node16", both.slice(1)).unused).toEqual([
			"ai-sdk.d.cts TS1479 (ai)",
		]);
	});
});
