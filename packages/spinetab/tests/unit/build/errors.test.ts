import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type BuildMessageCode,
	buildMessage,
	SpinetabBuildError,
} from "../../../src/build/messages.ts";
import { validateOptions } from "../../../src/build/options.ts";
import {
	checkGraph,
	findConventionalWorkerFiles,
	hasDefaultExport,
	isConventionalWorkerPath,
	resolveAdapterSet,
	resolvePlan,
} from "../../../src/build/plan.ts";
import { CREDENTIAL_ORIGIN_SENTENCE } from "../../../src/core/origins.ts";
import { cleanTrees, installPackage, makeTree } from "./tree.ts";

afterEach(cleanTrees);

const WORKER =
	'import { defineWorker } from "spinetab/worker";\nexport default defineWorker(() => []);\n';

function codeOf(run: () => unknown): BuildMessageCode | undefined {
	try {
		run();
	} catch (error) {
		if (error instanceof SpinetabBuildError) return error.code;
		throw error;
	}
	return undefined;
}

function messageOf(run: () => unknown): string {
	try {
		run();
	} catch (error) {
		return (error as Error).message;
	}
	return "";
}

const plan = (root: string, options: unknown = {}) =>
	resolvePlan(root, validateOptions(options));

describe("build messages", () => {
	it("uses the fixed prefix and sentences", () => {
		expect(buildMessage({ code: "worker-file-missing" })).toBe(
			"[spinetab] worker-file-missing: the file named by the worker option does not exist.",
		);
		expect(buildMessage({ code: "invalid-credential-origin", index: 2 })).toBe(
			`[spinetab] invalid-credential-origin: credentialOrigins[2] ${CREDENTIAL_ORIGIN_SENTENCE}`,
		);
		expect(
			buildMessage({
				code: "missing-peer",
				kind: "graphql-ws",
				peer: "graphql-ws",
			}),
		).toBe(
			"[spinetab] missing-peer: the graphql-ws adapter needs the graphql-ws package; install it.",
		);
		expect(buildMessage({ code: "adapter-not-generated", entry: "sse" })).toBe(
			"[spinetab] adapter-not-generated: the app imports spinetab/sse but the generated worker lacks its adapter; set the adapters option, or add a worker file.",
		);
	});

	it("adds one path line for file codes only", () => {
		expect(
			buildMessage({ code: "worker-file-conflict", files: ["a", "b"] }),
		).toBe(
			"[spinetab] worker-file-conflict: found two spinetab.worker files; keep one, or name it with the worker option.\n  a, b",
		);
		expect(
			buildMessage({ code: "no-adapters", files: ["x"] } as never),
		).not.toContain("\n");
	});

	it("option-shape and Next project-directory codes use fixed sentences", () => {
		expect(buildMessage({ code: "invalid-options" })).toBe(
			"[spinetab] invalid-options: the spinetab plugin options must be an object.",
		);
		expect(buildMessage({ code: "invalid-worker-option" })).toBe(
			"[spinetab] invalid-worker-option: the worker option must be a file path relative to the project root.",
		);
		expect(buildMessage({ code: "invalid-dir-option" })).toBe(
			"[spinetab] invalid-dir-option: the dir option must be the absolute path of the directory that holds next.config.",
		);
		expect(buildMessage({ code: "project-directory-unknown" })).toBe(
			"[spinetab] project-directory-unknown: neither or both of the current directory and the directory given to next hold a next.config file; run next from the project directory or set the dir option.",
		);
		// The loader's safety net names the dir option: the worker option is
		// resolved against the project directory, so it cannot fix a wrong one.
		expect(
			buildMessage({
				code: "worker-file-not-wired",
				files: ["app/spinetab.worker.ts"],
			}),
		).toBe(
			"[spinetab] worker-file-not-wired: a spinetab.worker file exists but was not wired; run next from the project directory or set the dir option.\n  app/spinetab.worker.ts",
		);
		// None of them is a file code: no path line.
		for (const code of [
			"invalid-options",
			"invalid-worker-option",
			"invalid-dir-option",
			"project-directory-unknown",
		] as const) {
			expect(buildMessage({ code, files: ["x"] } as never)).not.toContain("\n");
		}
	});

	it("package-not-installed uses a fixed sentence and no path line", () => {
		expect(buildMessage({ code: "package-not-installed" })).toBe(
			"[spinetab] package-not-installed: the spinetab package is not installed in this project.",
		);
		expect(
			buildMessage({ code: "package-not-installed", files: ["x"] } as never),
		).not.toContain("\n");
	});

	it("scan-fallback names the files by project-relative path", () => {
		expect(
			buildMessage({
				code: "scan-fallback",
				files: ["src/broken.ts", "../ui/src/a.tsx"],
			}),
		).toBe(
			"[spinetab] scan-fallback: a source file could not be read to its end, so every spinetab entry it names counts as imported; check it for an unclosed comment, template, bracket or JSX element, or set the adapters option.\n  src/broken.ts, ../ui/src/a.tsx",
		);
	});
});

describe("option validation", () => {
	it("accepts nothing, an explicit empty set and valid origins", () => {
		expect(validateOptions(undefined)).toEqual({
			worker: undefined,
			adapters: undefined,
			credentialOrigins: [],
			hasCredentialOrigins: false,
		});
		expect(validateOptions({ adapters: [] }).adapters).toEqual([]);
		expect(
			validateOptions({
				adapters: ["sse", "polling", "sse"],
				credentialOrigins: ["https://B.example/", "https://a.example"],
			}),
		).toMatchObject({
			adapters: ["polling", "sse"],
			credentialOrigins: ["https://a.example", "https://b.example"],
		});
	});

	it("unknown-option for any key besides the three options", () => {
		expect(buildMessage({ code: "unknown-option" })).toBe(
			"[spinetab] unknown-option: the spinetab plugin accepts worker, adapters and credentialOrigins; withSpinetab also accepts dir.",
		);
		for (const options of [
			{ adapter: ["polling"] },
			{ adapters: ["polling"], credentialOrigin: ["https://a.example"] },
			{ workers: "src/live.ts" },
			{ limits: {} },
			{ adapters: undefined, extra: undefined },
		]) {
			expect(codeOf(() => validateOptions(options))).toBe("unknown-option");
		}
		// Checked before the other rules, and the key itself is never echoed.
		const message = messageOf(() =>
			validateOptions({ adapters: ["mqtt"], secretKey: "hunter2" }),
		);
		expect(message).toBe(buildMessage({ code: "unknown-option" }));
		expect(message).not.toContain("secretKey");
		expect(message).not.toContain("hunter2");
		// Known keys with `undefined` values stay valid.
		expect(
			validateOptions({
				worker: undefined,
				adapters: undefined,
				credentialOrigins: undefined,
			}).adapters,
		).toBeUndefined();
	});

	it("unknown-adapter", () => {
		expect(
			codeOf(() => validateOptions({ adapters: ["polling", "mqtt"] })),
		).toBe("unknown-adapter");
		expect(codeOf(() => validateOptions({ adapters: "polling" }))).toBe(
			"unknown-adapter",
		);
	});

	it("invalid-credential-origin names the index and never echoes the value", () => {
		const secret = "https://user:hunter2@api.example.com";
		const message = messageOf(() =>
			validateOptions({
				credentialOrigins: ["https://ok.example", secret],
			}),
		);
		expect(message).toBe(
			`[spinetab] invalid-credential-origin: credentialOrigins[1] ${CREDENTIAL_ORIGIN_SENTENCE}`,
		);
		expect(message).not.toContain("hunter2");
		for (const bad of [
			"http://api.example.com",
			"https://api.example.com/path",
			"https://api.example.com?",
			"https://api.example.com#x",
			"not a url",
			42,
		]) {
			expect(codeOf(() => validateOptions({ credentialOrigins: [bad] }))).toBe(
				"invalid-credential-origin",
			);
		}
		expect(
			validateOptions({ credentialOrigins: ["http://127.0.0.1:8080"] })
				.credentialOrigins,
		).toEqual(["http://127.0.0.1:8080"]);
	});

	it("option-shape errors are SpinetabBuildErrors without stack frames", async () => {
		const { inspect } = await import("node:util");
		const cases: [unknown, BuildMessageCode, "plugin" | "next"][] = [
			["src/w.ts", "invalid-options", "plugin"],
			[["sse"], "invalid-options", "plugin"],
			[42, "invalid-options", "next"],
			[{ worker: "" }, "invalid-worker-option", "plugin"],
			[{ worker: 42 }, "invalid-worker-option", "plugin"],
			[{ worker: ["w.ts"] }, "invalid-worker-option", "next"],
			[{ dir: "apps/web" }, "invalid-dir-option", "next"],
			[{ dir: "" }, "invalid-dir-option", "next"],
			[{ dir: 42 }, "invalid-dir-option", "next"],
			// `dir` belongs to withSpinetab only.
			[{ dir: "/work/app" }, "unknown-option", "plugin"],
		];
		for (const [options, code, surface] of cases) {
			let caught: unknown;
			try {
				validateOptions(options, surface);
			} catch (error) {
				caught = error;
			}
			const label = `${surface} ${JSON.stringify(options)}`;
			expect(caught, label).toBeInstanceOf(SpinetabBuildError);
			const error = caught as SpinetabBuildError;
			expect(error.code, label).toBe(code);
			expect(error.message, label).toBe(buildMessage({ code } as never));
			expect(error.stack, label).toBe(`SpinetabBuildError: ${error.message}`);
			const printed = inspect(error);
			expect(printed, label).not.toMatch(
				/\bat\s|file:|[\\/]src[\\/]build[\\/]/,
			);
			expect(printed, label).not.toContain(process.cwd());
		}
		// A valid dir is kept for withSpinetab, as given.
		expect(validateOptions({ dir: "/work/app" }, "next").dir).toBe("/work/app");
		expect(validateOptions(undefined, "next").dir).toBeUndefined();
	});

	it("worker-file-with-options for the worker option", () => {
		expect(
			codeOf(() => validateOptions({ worker: "w.ts", adapters: ["polling"] })),
		).toBe("worker-file-with-options");
		expect(
			codeOf(() => validateOptions({ worker: "w.ts", credentialOrigins: [] })),
		).toBe("worker-file-with-options");
	});
});

describe("plan resolution", () => {
	it("prefers the worker option over the convention", () => {
		const root = makeTree({
			"src/spinetab.worker.ts": WORKER,
			"workers/live.ts": WORKER,
		});
		expect(plan(root, { worker: "workers/live.ts" })).toEqual({
			level: "L2",
			root,
			workerFile: join(root, "workers", "live.ts"),
			relative: "workers/live.ts",
		});
	});

	it("finds a conventional file in src/, app/ or the root", () => {
		for (const path of [
			"src/spinetab.worker.ts",
			"app/spinetab.worker.mts",
			"spinetab.worker.js",
			"src/spinetab.worker.mjs",
		]) {
			const root = makeTree({ [path]: WORKER });
			expect(plan(root)).toMatchObject({ level: "L2", relative: path });
			expect(isConventionalWorkerPath(root, join(root, path))).toBe(true);
		}
		const root = makeTree({ "lib/spinetab.worker.ts": WORKER });
		expect(findConventionalWorkerFiles(root)).toEqual([]);
		expect(plan(root)).toMatchObject({ level: "L3", adapters: null });
	});

	it("worker-file-conflict lists both project-relative paths", () => {
		const root = makeTree({
			"src/spinetab.worker.ts": WORKER,
			"app/spinetab.worker.ts": WORKER,
		});
		const message = messageOf(() => plan(root));
		expect(message).toBe(
			`${buildMessage({ code: "worker-file-conflict" })}\n  src/spinetab.worker.ts, app/spinetab.worker.ts`,
		);
		expect(message).not.toContain(root);
	});

	it("worker-file-missing", () => {
		const root = makeTree();
		const message = messageOf(() => plan(root, { worker: "src/nope.ts" }));
		expect(message).toBe(
			`${buildMessage({ code: "worker-file-missing" })}\n  src/nope.ts`,
		);
	});

	it("worker-file-no-default", () => {
		const root = makeTree({
			"src/spinetab.worker.ts":
				"// export default nothing\nexport const worker = 1;\n/* export default */",
		});
		expect(codeOf(() => plan(root))).toBe("worker-file-no-default");
		expect(hasDefaultExport(WORKER)).toBe(true);
		expect(hasDefaultExport("const w = 1;\nexport { w as default };")).toBe(
			true,
		);
		expect(hasDefaultExport('export { default } from "./real.ts";')).toBe(true);
	});

	it("reads no default export out of strings, templates or comments", () => {
		for (const code of [
			'const text = "; export default x";',
			"const text = '{ export default x }';",
			"const text = `\nexport default x`;",
			'const text = "export { w as default }";',
			"/* it's\nexport default x */ export const w = 1;",
			'// "export default"\nexport const w = 1;',
		]) {
			expect(hasDefaultExport(code), code).toBe(false);
		}
		// A string or URL holding `//` does not hide the real export.
		expect(
			hasDefaultExport(
				'const url = "https://api.example.com";\nexport default url;',
			),
		).toBe(true);
	});

	it("worker-file-with-options for a conventional file", () => {
		const root = makeTree({ "src/spinetab.worker.ts": WORKER });
		expect(codeOf(() => plan(root, { adapters: [] }))).toBe(
			"worker-file-with-options",
		);
		expect(
			codeOf(() => plan(root, { credentialOrigins: ["https://a.example"] })),
		).toBe("worker-file-with-options");
	});

	it("missing-peer for an explicit adapter without its peer", () => {
		const root = makeTree();
		expect(codeOf(() => plan(root, { adapters: ["socket-io"] }))).toBe(
			"missing-peer",
		);
		installPackage(root, "socket.io-client");
		expect(plan(root, { adapters: ["socket-io"] })).toMatchObject({
			level: "L3",
			adapters: ["socket-io"],
		});
	});
});

describe("adapter set and the empty-set rule", () => {
	const l3 = (root: string, options: unknown = {}) => {
		const result = plan(root, options);
		if (result.level !== "L3") throw new Error("expected L3");
		return result;
	};

	it("no-adapters fails production builds and warns in development", () => {
		const root = makeTree({ "src/main.ts": "export {};" });
		expect(codeOf(() => resolveAdapterSet(l3(root), { dev: false }))).toBe(
			"no-adapters",
		);
		const set = resolveAdapterSet(l3(root), { dev: true });
		expect(set.kinds).toEqual([]);
		expect(set.warnings).toEqual([buildMessage({ code: "no-adapters" })]);
	});

	it("an explicit empty set builds without a warning", () => {
		const root = makeTree();
		const set = resolveAdapterSet(l3(root, { adapters: [] }), { dev: false });
		expect(set).toMatchObject({ kinds: [], explicit: true, warnings: [] });
		expect(set.text).toContain("defineWorker(() => [])");
	});

	it("the adapters option replaces inference", () => {
		const root = makeTree({
			"src/main.ts": 'import { sse } from "spinetab/sse";',
		});
		const set = resolveAdapterSet(l3(root, { adapters: ["polling"] }), {
			dev: false,
		});
		expect(set.kinds).toEqual(["polling"]);
	});

	it("a set emptied only by missing peers fails production with missing-peer", () => {
		const root = makeTree({
			"src/main.ts": [
				'import { socketIo } from "spinetab/socket-io";',
				'import { graphqlWs } from "spinetab/graphql-ws";',
			].join("\n"),
		});
		const first = {
			code: "missing-peer",
			kind: "graphql-ws",
			peer: "graphql-ws",
		} as const;
		const second = {
			code: "missing-peer",
			kind: "socket-io",
			peer: "socket.io-client",
		} as const;
		// Production: the first missing peer by kind order is the failure.
		expect(messageOf(() => resolveAdapterSet(l3(root), { dev: false }))).toBe(
			buildMessage(first),
		);
		// Development: the missing-peer lines, without a no-adapters line.
		const set = resolveAdapterSet(l3(root), { dev: true });
		expect(set.kinds).toEqual([]);
		expect(set.warnings).toEqual([buildMessage(first), buildMessage(second)]);
	});

	it("scan-fallback warns in development and production, never fails", () => {
		const root = makeTree({
			"src/main.ts": 'import { polling } from "spinetab/polling";',
			"src/broken.ts": 'const s = "spinetab/sse"; /* never closed\n',
		});
		for (const dev of [true, false]) {
			const set = resolveAdapterSet(l3(root), { dev });
			expect(set.kinds).toEqual(["polling", "sse"]);
			expect(set.warnings).toEqual([
				buildMessage({ code: "scan-fallback", files: ["src/broken.ts"] }),
			]);
			expect(set.warnings.join("\n")).not.toContain(root);
		}
	});

	it("warns about a missing peer and leaves the adapter out", () => {
		const root = makeTree({
			"src/main.ts":
				'import { polling } from "spinetab/polling";\nimport { graphqlWs } from "spinetab/graphql-ws";',
		});
		const set = resolveAdapterSet(l3(root), { dev: false });
		expect(set.kinds).toEqual(["polling"]);
		expect(set.warnings).toEqual([
			buildMessage({
				code: "missing-peer",
				kind: "graphql-ws",
				peer: "graphql-ws",
			}),
		]);
	});
});

describe("graph check", () => {
	const set = {
		kinds: ["polling", "trpc-ws"] as const,
		missingPeers: [{ kind: "graphql-ws" as const, peer: "graphql-ws" }],
	};

	it("passes when every imported adapter entry is generated", () => {
		expect(checkGraph(set, ["polling", "trpc", "react", "worker"])).toBe(
			undefined,
		);
	});

	it("adapter-not-generated names the entry", () => {
		const failure = checkGraph(set, ["polling", "sse"]);
		expect(failure?.code).toBe("adapter-not-generated");
		expect(failure?.message).toBe(
			buildMessage({ code: "adapter-not-generated", entry: "sse" }),
		);
	});

	it("missing-peer when the entry's adapter was left out for its peer", () => {
		expect(checkGraph(set, ["graphql-ws"])?.code).toBe("missing-peer");
	});

	it("needs every tRPC kind the importing files name", () => {
		const root = makeTree({
			"src/ws.ts": 'import { spinetabWsLink } from "spinetab/trpc";',
			"src/sse.ts":
				'import { spinetabSseLink /* the SSE link */ } from "spinetab/trpc";',
			"src/any.ts": 'import * as trpc from "spinetab/trpc";',
		});
		const importers = (...files: string[]) =>
			new Map([["trpc", new Set(files.map((file) => join(root, file)))]]);
		// `adapters: ["trpc-ws"]` with a page on `spinetabSseLink` fails here.
		expect(checkGraph(set, importers("src/ws.ts"))).toBe(undefined);
		const failure = checkGraph(set, importers("src/ws.ts", "src/sse.ts"));
		expect(failure?.code).toBe("adapter-not-generated");
		expect(failure?.message).toBe(
			buildMessage({ code: "adapter-not-generated", entry: "trpc" }),
		);
		// A namespace import or an unreadable importer cannot narrow: any
		// one kind passes, as for an entry without importers.
		expect(checkGraph(set, importers("src/any.ts"))).toBe(undefined);
		expect(checkGraph(set, importers("src/gone.ts"))).toBe(undefined);
		expect(
			checkGraph(
				{ kinds: ["trpc-sse"], missingPeers: [] },
				importers("src/sse.ts"),
			),
		).toBe(undefined);
	});

	it("ignores tRPC link names in comments and strings", () => {
		const root = makeTree({
			"src/comment.ts": [
				'import { spinetabWsLink } from "spinetab/trpc";',
				'// import { spinetabSseLink } from "spinetab/trpc";',
			].join("\n"),
			"src/string.ts": [
				'import { spinetabWsLink } from "spinetab/trpc";',
				"const example = 'import { spinetabSseLink } from \"spinetab/trpc\";';",
			].join("\n"),
		});
		const wsOnly = { kinds: ["trpc-ws"] as const, missingPeers: [] };
		for (const file of ["src/comment.ts", "src/string.ts"]) {
			expect(
				checkGraph(wsOnly, new Map([["trpc", new Set([join(root, file)])]])),
				file,
			).toBe(undefined);
		}
	});

	it("ignores importers whose only import of an entry is type-only", () => {
		const root = makeTree({
			"src/describe.ts":
				'import { type SseSource } from "spinetab/sse";\nexport type D = SseSource;',
			"src/reexport.ts": 'export { type SseOptions } from "spinetab/sse";',
			"src/link.ts":
				'import { type SpinetabLinkOptions } from "spinetab/trpc";\nexport type L = SpinetabLinkOptions;',
			"src/live.ts": 'import { sse } from "spinetab/sse";',
		});
		const polling = { kinds: ["polling"] as const, missingPeers: [] };
		const graph = (entry: string, ...files: string[]) =>
			new Map([[entry, new Set(files)]]);
		const at = (file: string) => join(root, file);
		expect(
			checkGraph(
				polling,
				graph("sse", at("src/describe.ts"), at("src/reexport.ts")),
			),
		).toBe(undefined);
		// A tRPC entry imported only for types needs no kind.
		expect(checkGraph(polling, graph("trpc", at("src/link.ts")))).toBe(
			undefined,
		);
		// One value importer still needs the adapter.
		expect(
			checkGraph(
				polling,
				graph("sse", at("src/describe.ts"), at("src/live.ts")),
			)?.code,
		).toBe("adapter-not-generated");
		// An unreadable or virtual importer stays conservative.
		for (const unknown of [at("src/gone.ts"), "\0virtual:spinetab-sse"]) {
			expect(
				checkGraph(polling, graph("sse", at("src/describe.ts"), unknown))?.code,
				unknown,
			).toBe("adapter-not-generated");
		}
	});
});

describe("printed build errors", () => {
	const inputs = [
		{ code: "worker-file-conflict", files: ["src/a.ts", "app/b.ts"] },
		{ code: "worker-file-with-options" },
		{ code: "no-adapters" },
		{ code: "invalid-credential-origin", index: 0 },
		{ code: "missing-peer", kind: "graphql-ws", peer: "graphql-ws" },
		{ code: "adapter-not-generated", entry: "sse" },
		{ code: "invalid-options" },
		{ code: "invalid-worker-option" },
		{ code: "invalid-dir-option" },
		{ code: "project-directory-unknown" },
		{ code: "package-not-installed" },
	] as const;

	it("carry no stack frames, so no absolute path, in stack or inspection", async () => {
		const { inspect } = await import("node:util");
		for (const input of inputs) {
			const error = new SpinetabBuildError(input);
			expect(error.stack).toBe(`SpinetabBuildError: ${error.message}`);
			expect(error.hideStack).toBe(true);
			// Vite and Next print a thrown config error through Node's inspection.
			const printed = inspect(error);
			expect(printed).not.toMatch(/\bat\s|file:|[\\/]src[\\/]build[\\/]/);
			expect(printed).not.toContain(process.cwd());
			expect(printed).not.toContain("hideStack");
		}
	});

	it("a thrown plan error names the project only by relative path", () => {
		const root = makeTree({
			"src/spinetab.worker.ts": WORKER,
			"app/spinetab.worker.ts": WORKER,
		});
		try {
			plan(root);
			expect.unreachable();
		} catch (error) {
			const { message, stack } = error as Error;
			expect(message).toContain(
				"\n  src/spinetab.worker.ts, app/spinetab.worker.ts",
			);
			expect(`${message}\n${stack}`).not.toContain(root);
		}
	});

	it("stay path-free through webpack's ModuleBuildError (loader errors)", async () => {
		const { createRequire } = await import("node:module");
		const require = createRequire(import.meta.url);
		let ModuleBuildError: new (error: Error) => Error & { details?: string };
		try {
			ModuleBuildError = require("webpack/lib/errors/ModuleBuildError");
		} catch {
			return; // webpack is a devDependency; without it there is nothing to wrap.
		}
		const wrapped = new ModuleBuildError(
			new SpinetabBuildError({ code: "no-adapters" }),
		);
		expect(wrapped.message).toContain(buildMessage({ code: "no-adapters" }));
		expect(`${wrapped.message}\n${wrapped.details ?? ""}`).not.toMatch(
			/\bat\s|file:|[\\/]src[\\/]build[\\/]/,
		);
	});
});
