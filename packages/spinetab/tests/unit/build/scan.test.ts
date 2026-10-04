import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { generateWorker } from "../../../src/build/generate.ts";
import {
	inferAdapters,
	peerResolves,
	scanProject,
	scanRootsFor,
	scanSource,
} from "../../../src/build/scan.ts";
import { cleanTrees, installPackage, link, makeTree } from "./tree.ts";

afterEach(cleanTrees);

const kindsOf = (code: string, path = "x.ts") => [
	...scanSource(code, path).kinds,
];

describe("scanSource", () => {
	it("matches static, dynamic, re-export, require and bare imports", () => {
		expect(kindsOf('import { polling } from "spinetab/polling";')).toEqual([
			"polling",
		]);
		expect(kindsOf('const m = await import("spinetab/sse");')).toEqual(["sse"]);
		expect(kindsOf('export { websocket } from "spinetab/websocket";')).toEqual([
			"websocket",
		]);
		expect(kindsOf("const s = require('spinetab/stream');")).toEqual([
			"stream",
		]);
		expect(kindsOf('import "spinetab/ai-sdk";')).toEqual(["ai-sdk"]);
		expect(kindsOf("import(`spinetab/socket-io`)")).toEqual(["socket-io"]);
	});

	it("reads through comments, including quotes and apostrophes in them", () => {
		expect(
			kindsOf('import(/* webpackChunkName: "feed" */ "spinetab/sse")'),
		).toEqual(["sse"]);
		expect(kindsOf('import(/* @vite-ignore */ "spinetab/sse")')).toEqual([
			"sse",
		]);
		expect(
			kindsOf('import { polling /* don\'t */ } from "spinetab/polling";'),
		).toEqual(["polling"]);
		expect(
			kindsOf(
				'import {\n\t// it\'s the SSE link\n\tspinetabSseLink,\n} from "spinetab/trpc";',
			),
		).toEqual(["trpc-sse"]);
		expect(
			kindsOf('const s = require(\n\t// "x"\n\t"spinetab/stream");'),
		).toEqual(["stream"]);
		expect(kindsOf('import /* "x" */ type { X } from "spinetab/sse";')).toEqual(
			[],
		);
		// A string between a keyword and a specifier still ends the clause.
		expect(kindsOf('import a from "react"; const s = "spinetab/sse";')).toEqual(
			[],
		);
	});

	it("skips type-only imports and exports", () => {
		expect(kindsOf('import type { X } from "spinetab/polling";')).toEqual([]);
		expect(kindsOf('export type { X } from "spinetab/polling";')).toEqual([]);
		expect(
			kindsOf('import { type A, type B } from "spinetab/graphql-ws";'),
		).toEqual([]);
		expect(kindsOf('import { type A, sse } from "spinetab/sse";')).toEqual([
			"sse",
		]);
	});

	it("skips worker-side specifiers and non-adapter entries", () => {
		expect(
			kindsOf(
				[
					'import { pollingAdapter } from "spinetab/polling/runtime";',
					'import { defineWorker } from "spinetab/worker";',
					'import { createRuntime } from "spinetab/runtime";',
					'import { bindClient } from "spinetab/react";',
					'import { createSpinetab } from "spinetab";',
					'import x from "spinetab/unknown";',
				].join("\n"),
			),
		).toEqual([]);
	});

	it("selects tRPC kinds by named import", () => {
		expect(kindsOf('import { spinetabWsLink } from "spinetab/trpc";')).toEqual([
			"trpc-ws",
		]);
		expect(
			kindsOf('import { spinetabSseLink as link } from "spinetab/trpc";'),
		).toEqual(["trpc-sse"]);
		expect(
			kindsOf(
				'import { spinetabSseLink, spinetabWsLink } from "spinetab/trpc";',
			).sort(),
		).toEqual(["trpc-sse", "trpc-ws"]);
		expect(kindsOf('import * as trpc from "spinetab/trpc";').sort()).toEqual([
			"trpc-sse",
			"trpc-ws",
		]);
		expect(kindsOf('await import("spinetab/trpc");').sort()).toEqual([
			"trpc-sse",
			"trpc-ws",
		]);
		expect(
			kindsOf('import { type SpinetabLinkOptions } from "spinetab/trpc";'),
		).toEqual([]);
	});

	it("reads .astro frontmatter and scripts", () => {
		const astro = [
			"---",
			'import Live from "../components/Live.astro";',
			"---",
			"<script>",
			'  import { polling } from "spinetab/polling";',
			"</script>",
		].join("\n");
		expect(kindsOf(astro, "page.astro")).toEqual(["polling"]);
	});

	it("strips fenced code blocks from .mdx only", () => {
		const mdx = [
			'import { sse } from "spinetab/sse";',
			"",
			"```ts",
			'import { websocket } from "spinetab/websocket";',
			"```",
			"",
			"~~~js",
			'import { stream } from "spinetab/stream";',
			"~~~",
		].join("\n");
		expect(kindsOf(mdx, "doc.mdx")).toEqual(["sse"]);
		// In a.ts file the ``` lines are template literals, so the websocket
		// line is text and the ~~~ line is code.
		expect(kindsOf(mdx, "doc.ts").sort()).toEqual(["sse", "stream"]);
	});

	it("never matches across statements", () => {
		expect(
			kindsOf('import a from "a";\nconst s = "spinetab/polling";'),
		).toEqual([]);
	});
});

describe("scanProject", () => {
	it("walks the root with the documented extensions and excludes", () => {
		const root = makeTree({
			"src/main.ts": 'import { polling } from "spinetab/polling";',
			"src/view.vue": '<script>import { sse } from "spinetab/sse";</script>',
			"src/page.svelte":
				'<script>import { stream } from "spinetab/stream";</script>',
			"index.html":
				'<script type="module">import "spinetab/websocket";</script>',
			"src/notes.md": 'import { x } from "spinetab/ai-sdk";',
			"src/live.test.ts": 'import { a } from "spinetab/graphql-ws";',
			"src/live.spec.tsx": 'import { a } from "spinetab/graphql-ws";',
			"src/live.stories.tsx": 'import { a } from "spinetab/graphql-ws";',
			"src/__tests__/a.ts": 'import { a } from "spinetab/graphql-sse";',
			"src/__mocks__/a.ts": 'import { a } from "spinetab/graphql-sse";',
			"e2e/a.ts": 'import { a } from "spinetab/socket-io";',
			"dist/a.js": 'import { a } from "spinetab/socket-io";',
			"build/a.js": 'import { a } from "spinetab/socket-io";',
			"out/a.js": 'import { a } from "spinetab/socket-io";',
			"coverage/a.js": 'import { a } from "spinetab/socket-io";',
			".next/a.js": 'import { a } from "spinetab/socket-io";',
			"node_modules/x/a.js": 'import { a } from "spinetab/socket-io";',
			"www/bundle.js": 'import { a } from "spinetab/ai-sdk";',
		});
		expect(
			scanProject([root], { excludes: [join(root, "www")] }).kinds,
		).toEqual(["polling", "sse", "stream", "websocket"]);
	});

	it("never follows a symlink out of the root", () => {
		const outside = makeTree({
			"feed.ts": 'import { sse } from "spinetab/sse";',
		});
		const root = makeTree({
			"src/main.ts": 'import { polling } from "spinetab/polling";',
		});
		link(outside, join(root, "src", "linked"));
		expect(scanProject([root]).kinds).toEqual(["polling"]);
	});

	it("adds declared workspace packages that depend on spinetab, including dist", () => {
		const workspace = makeTree({
			"packages/feeds/package.json": JSON.stringify({
				name: "feeds",
				peerDependencies: { spinetab: "*" },
			}),
			"packages/feeds/src/index.ts": 'import { sse } from "spinetab/sse";',
			"packages/feeds/dist/index.js":
				'import { stream } from "spinetab/stream";',
			"packages/feeds/node_modules/x/a.js": 'import "spinetab/websocket";',
			"packages/other/package.json": JSON.stringify({ name: "other" }),
			"packages/other/a.ts": 'import "spinetab/ai-sdk";',
			"apps/web/package.json": JSON.stringify({
				name: "web",
				dependencies: { feeds: "workspace:*", other: "workspace:*" },
			}),
			"apps/web/app/page.ts": 'import { polling } from "spinetab/polling";',
		});
		const web = join(workspace, "apps", "web");
		link(
			join(workspace, "packages", "feeds"),
			join(web, "node_modules", "feeds"),
		);
		link(
			join(workspace, "packages", "other"),
			join(web, "node_modules", "other"),
		);
		const roots = scanRootsFor(web);
		expect(roots).toEqual([web, join(workspace, "packages", "feeds")]);
		expect(scanProject(roots).kinds).toEqual(["polling", "sse", "stream"]);
	});

	it("finds workspace links hoisted to an ancestor node_modules (npm, Yarn, Bun)", () => {
		const workspace = makeTree({
			"package.json": JSON.stringify({ workspaces: ["apps/*", "packages/*"] }),
			"packages/feeds/package.json": JSON.stringify({
				name: "@consumer/feeds",
				dependencies: { spinetab: "*" },
			}),
			"packages/feeds/src/index.ts": 'import { sse } from "spinetab/sse";',
			"apps/web/package.json": JSON.stringify({
				name: "web",
				dependencies: { "@consumer/feeds": "*", spinetab: "*" },
			}),
			"apps/web/src/main.ts": 'import { polling } from "spinetab/polling";',
		});
		const web = join(workspace, "apps", "web");
		link(
			join(workspace, "packages", "feeds"),
			join(workspace, "node_modules", "@consumer", "feeds"),
		);
		const roots = scanRootsFor(web);
		expect(roots).toEqual([web, join(workspace, "packages", "feeds")]);
		expect(inferAdapters(roots).kinds).toEqual(["polling", "sse"]);
	});

	it("takes the nearest install, as Node does", () => {
		const workspace = makeTree({
			"packages/feeds/package.json": JSON.stringify({
				dependencies: { spinetab: "*" },
			}),
			"packages/feeds/a.ts": 'import "spinetab/sse";',
			"apps/web/package.json": JSON.stringify({
				dependencies: { feeds: "*" },
			}),
			// The app's own installed copy shadows the hoisted link.
			"apps/web/node_modules/feeds/package.json": JSON.stringify({
				dependencies: { spinetab: "*" },
			}),
		});
		link(
			join(workspace, "packages", "feeds"),
			join(workspace, "node_modules", "feeds"),
		);
		const web = join(workspace, "apps", "web");
		expect(scanRootsFor(web)).toEqual([web]);
	});

	it("ignores dependencies installed inside node_modules", () => {
		const root = makeTree({
			"package.json": JSON.stringify({ dependencies: { lib: "1.0.0" } }),
			"node_modules/lib/package.json": JSON.stringify({
				dependencies: { spinetab: "*" },
			}),
			"node_modules/lib/index.js": 'import "spinetab/sse";',
		});
		expect(scanRootsFor(root)).toEqual([root]);
	});
});

describe("peer guard", () => {
	it("resolves peers through ancestor node_modules", () => {
		const root = makeTree({ "apps/web/package.json": "{}" });
		installPackage(root, "graphql-ws");
		expect(peerResolves(join(root, "apps", "web"), "graphql-ws")).toBe(true);
		expect(peerResolves(join(root, "apps", "web"), "@trpc/client")).toBe(false);
	});

	it("leaves out adapters whose peer is missing and reports them", () => {
		const root = makeTree({
			"src/a.ts": [
				'import { graphqlWs } from "spinetab/graphql-ws";',
				'import { spinetabWsLink } from "spinetab/trpc";',
				'import { polling } from "spinetab/polling";',
			].join("\n"),
		});
		installPackage(root, "graphql-ws");
		const inferred = inferAdapters([root]);
		expect(inferred.kinds).toEqual(["graphql-ws", "polling"]);
		expect(inferred.missingPeers).toEqual([
			{ kind: "trpc-ws", peer: "@trpc/client" },
		]);
		expect(inferred.entries).toEqual(["graphql-ws", "polling", "trpc"]);
	});
});

const POLL = 'import { polling } from "spinetab/polling";\n';
const lines = (count: number, line: (index: number) => string) =>
	Array.from({ length: count }, (_, index) => line(index)).join("\n");

/** shapes whose JSDoc runs made the old pattern backtrack. */
const LONG_FORMS: Record<string, (members: number) => string> = {
	enum: (members) =>
		`${POLL}\nexport enum Code {\n${lines(members, (i) => `\t/** Code ${i}. */\n\tC${i} = ${i},`)}\n}\n`,
	object: (members) =>
		`${POLL}\nexport const intervals = {\n${lines(members, (i) => `\t/** Interval ${i} in ms. */\n\tf${i}: ${i * 1000},`)}\n};\n`,
	parameters: (members) =>
		`${POLL}\nexport function make(\n${lines(members, (i) => `\t/** Arg ${i}. */ a${i}: number,`)}\n) {\n\treturn members;\n}\n`,
	interface: (members) =>
		`${POLL}\nexport interface Options {\n${lines(members, (i) => `\t/** Option ${i}. */\n\to${i}: number`)}\n}\n`,
	// JSX elements, TSX type parameters and import text in JSX children.
	tsx: (members) =>
		`${POLL}\n${lines(members, (i) => `/** Row ${i}. */\nexport const Row${i} = <T,>(p: { v: T }) => (\n\t<li title="${i}">{/* cell */ String(p.v)} import("spinetab/sse")</li>\n);`)}\n`,
};

// A generous process deadline catches backtracking hangs without benchmarking CI.
function scanAdversarial(inputs: Array<{ code: string; path: string }>) {
	return JSON.parse(
		execFileSync(
			process.execPath,
			[fileURLToPath(new URL("./scan-probe.ts", import.meta.url))],
			{ input: JSON.stringify(inputs), encoding: "utf8", timeout: 10_000 },
		),
	) as Array<{ kinds: string[]; fallback: boolean }>;
}

describe("scanSource adversarial inputs", () => {
	it("reads MDX ESM with blank lines inside unfinished code", () => {
		const inputs = [1000, 2000, 4000].map((entries) => {
			const items = Array.from(
				{ length: entries },
				(_, n) => `  { id: ${n}, note: "spinetab/ docs" },`,
			).join("\n\n");
			return {
				code: `export const items = [\n\n${items}\n]\n\n# Items\n\n${POLL}`,
				path: "items.mdx",
			};
		});
		for (const result of scanAdversarial(inputs)) {
			expect(result.kinds).toEqual(["polling"]);
			expect(result.fallback).toBe(false);
		}
	}, 15_000);

	it("handles unmatched MDX backtick runs", () => {
		const inputs = [250, 500, 1000].map((runs) => {
			const prose = Array.from(
				{ length: runs },
				(_, n) => `x ${"`".repeat(n + 1)} y`,
			).join(" ");
			return { code: `${prose}\n\n{import("spinetab/sse")}\n`, path: "a.mdx" };
		});
		for (const result of scanAdversarial(inputs))
			expect(result.kinds).toEqual(["sse"]);
	}, 15_000);

	it("handles near-matching MDX block lines and escaped backticks", () => {
		const inputs = [2, 32, 1024, 16384].map((marks) => {
			const blocks = [
				`${"- ".repeat(marks)}x`,
				`${"*\t".repeat(marks)}x`,
				`${"=".repeat(marks)}x`,
				`${"#".repeat(marks)} x`,
			];
			const runs = Array.from(
				{ length: Math.min(marks, 256) },
				(_, n) => `x \\${"`".repeat(n + 2)} y`,
			).join(" ");
			return {
				code: `${blocks.join("\n")}\n\n${runs}\n\n{import("spinetab/sse")}\n`,
				path: "a.mdx",
			};
		});
		for (const result of scanAdversarial(inputs))
			expect(result.kinds).toEqual(["sse"]);
	}, 15_000);

	it("handles long comment runs in TypeScript and TSX", () => {
		const inputs = Object.entries(LONG_FORMS).flatMap(([form, make]) =>
			[2, 32, 200].map((members) => ({
				code: make(members),
				path: form === "tsx" ? "long.tsx" : "long.ts",
			})),
		);
		for (const result of scanAdversarial(inputs))
			expect(result.kinds).toEqual(["polling"]);
	}, 15_000);

	it("reports type-only entries for the graph check", () => {
		const scan = scanSource(
			[
				'import { type SseSource } from "spinetab/sse";',
				'export { type PollingOptions } from "spinetab/polling";',
				'import type { StreamOptions } from "spinetab/stream";',
				'import { websocket } from "spinetab/websocket";',
			].join("\n"),
			"a.ts",
		);
		expect([...scan.typeOnly].sort()).toEqual(["polling", "sse", "stream"]);
		expect([...scan.entries]).toEqual(["websocket"]);
		expect([...scan.kinds]).toEqual(["websocket"]);
		expect(scan.fallback).toBe(false);
	});

	it("falls back to the entries a region names when it cannot be closed", () => {
		for (const [code, path, kinds] of [
			[
				'import { sse } from "spinetab/sse";\n/* never closed\n',
				"a.ts",
				["sse"],
			],
			[
				'const t = `\nimport { polling } from "spinetab/polling";\n',
				"a.ts",
				["polling"],
			],
			['function f() {\n\tconst s = "spinetab/stream";\n', "a.ts", ["stream"]],
			[
				'export const A = () => <Lazy load={() => import("spinetab/sse")',
				"a.tsx",
				["sse"],
			],
			['<p>{import("spinetab/sse")</p>\n', "a.svelte", ["sse"]],
		] as const) {
			const scan = scanSource(code, path);
			expect(scan.fallback, code).toBe(true);
			expect([...scan.kinds].sort(), code).toEqual(kinds);
		}
		expect(scanSource(POLL, "a.ts").fallback).toBe(false);
	});

	it("falls back for the unclosable region only", () => {
		const vue = [
			"<script>",
			'// import { websocket } from "spinetab/websocket";',
			'import { polling } from "spinetab/polling";',
			"</script>",
			"<script setup>",
			'const s = "spinetab/sse"; /* never closed',
			"</script>",
		].join("\n");
		const scan = scanSource(vue, "a.vue");
		expect([...scan.kinds].sort()).toEqual(["polling", "sse"]);
		expect(scan.fallback).toBe(true);
	});
});

describe("scanProject reach", () => {
	it("lists files read by fallback by project-relative path", () => {
		const root = makeTree({
			"src/ok.ts": POLL,
			"src/broken.ts": 'import { sse } from "spinetab/sse";\n/* never closed\n',
		});
		const inferred = inferAdapters([root]);
		expect(inferred.kinds).toEqual(["polling", "sse"]);
		expect(inferred.fallbacks).toEqual(["src/broken.ts"]);
		expect(inferAdapters([join(root, "src")]).fallbacks).toEqual(["broken.ts"]);
	});

	it("skips dist, build, out, coverage and e2e only at a root's top level", () => {
		const root = makeTree({
			"src/main.ts": POLL,
			"app/dist/page.ts": 'import { sse } from "spinetab/sse";',
			"app/build/page.tsx": 'import { stream } from "spinetab/stream";',
			"src/out/a.ts": 'import { websocket } from "spinetab/websocket";',
			"src/coverage/a.ts": 'import "spinetab/ai-sdk";',
			"src/e2e/a.ts": 'import "spinetab/graphql-sse";',
			"dist/a.js": 'import "spinetab/socket-io";',
			"build/a.js": 'import "spinetab/socket-io";',
			"out/a.js": 'import "spinetab/socket-io";',
			"coverage/a.js": 'import "spinetab/socket-io";',
			"e2e/a.ts": 'import "spinetab/socket-io";',
			"src/__tests__/a.ts": 'import "spinetab/graphql-ws";',
			"src/deep/__mocks__/a.ts": 'import "spinetab/graphql-ws";',
			"src/deep/node_modules/x/a.js": 'import "spinetab/graphql-ws";',
			"src/deep/.cache/a.js": 'import "spinetab/graphql-ws";',
		});
		expect(scanProject([root]).kinds).toEqual([
			"ai-sdk",
			"graphql-sse",
			"polling",
			"sse",
			"stream",
			"websocket",
		]);
	});

	it("never scans declaration files, including a workspace dist", () => {
		const workspace = makeTree({
			"packages/feeds/package.json": JSON.stringify({
				name: "feeds",
				dependencies: { spinetab: "*" },
			}),
			"packages/feeds/dist/index.js":
				'import { stream } from "spinetab/stream";',
			"packages/feeds/dist/index.d.ts":
				'export declare const o: import("spinetab/sse").SseOptions;',
			"apps/web/package.json": JSON.stringify({
				dependencies: { feeds: "workspace:*" },
			}),
			"apps/web/src/main.ts": POLL,
			"apps/web/src/types.d.ts": 'import { SseOptions } from "spinetab/sse";',
			"apps/web/src/esm.d.mts":
				'export declare const o: import("spinetab/websocket").WebSocketOptions;',
			"apps/web/src/cjs.d.cts": 'import W = require("spinetab/ai-sdk");',
			"apps/web/src/styles.d.css.ts": 'import "spinetab/graphql-sse";',
		});
		const web = join(workspace, "apps", "web");
		link(
			join(workspace, "packages", "feeds"),
			join(web, "node_modules", "feeds"),
		);
		expect(scanProject(scanRootsFor(web)).kinds).toEqual(["polling", "stream"]);
	});
});

describe("consumer control fixture (cell a)", () => {
	it("vanilla-polling selects polling alone, so its worker holds only the polling adapter", () => {
		const fixture = fileURLToPath(
			new URL("../../fixtures/consumers/vanilla-polling", import.meta.url),
		);
		// The control names socket-io in a comment and websocket in a string.
		const control = readFileSync(join(fixture, "src", "examples.js"), "utf8");
		expect(control).toContain(
			'// import { socketIo } from "spinetab/socket-io";',
		);
		expect(control).toContain(
			`'import { websocket } from "spinetab/websocket";'`,
		);
		expect(peerResolves(fixture, "socket.io-client")).toBe(true);
		const inferred = inferAdapters(scanRootsFor(fixture));
		expect(inferred.kinds).toEqual(["polling"]);
		expect(inferred.missingPeers).toEqual([]);
		expect(inferred.fallbacks).toEqual([]);
		expect(generateWorker(inferred.kinds)).toBe(generateWorker(["polling"]));
	});
});
