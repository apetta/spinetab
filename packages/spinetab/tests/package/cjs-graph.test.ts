import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
	allowlistedPeers,
	ENTRY_RULES,
	isBareSpecifier,
	isNodeBuiltin,
	packageName,
} from "./allowlist.ts";
import { distDir, packageRoot, targets } from "./dist.ts";
import {
	closureOf,
	distRelative,
	importsOf,
	resolveRelative,
	walk,
} from "./graph.ts";

/** CommonJS closures require CommonJS relatives in both JavaScript and declarations. Errors from either module format must remain recognisable by code. */
const require = createRequire(join(packageRoot, "package.json"));
const peers = new Set(allowlistedPeers());

/** Per `.cjs` file: the self-imports and built-in allowance of the entries reaching it. */
function cjsAllowances() {
	const allowances = new Map<
		string,
		{ selfImports: Set<string>; builtins: boolean; realms: Set<string> }
	>();
	for (const target of targets()) {
		const rule = ENTRY_RULES[target.subpath];
		if (!rule || !target.require) continue;
		for (const file of closureOf(distDir, distRelative(target.require.default))
			.files) {
			const entry = allowances.get(file) ?? {
				selfImports: new Set<string>(),
				builtins: true,
				realms: new Set<string>(),
			};
			for (const specifier of rule.selfImports ?? []) {
				entry.selfImports.add(specifier);
			}
			// Every entry reaching the file must allow built-ins.
			entry.builtins &&= rule.nodeBuiltins === true;
			entry.realms.add(rule.realm);
			allowances.set(file, entry);
		}
	}
	return allowances;
}
/** The emitted ESM copy, loaded by file URL (native `require` self-references). */
const loadEsm = (file: string) =>
	import(pathToFileURL(join(distDir, file)).href);

interface ErrorLike {
	code: string;
}
interface RootModule {
	resolveEndpoint(url: string, base?: string): string;
	SpinetabError: new (code: string, message: string) => ErrorLike;
	isSpinetabError(error: unknown, code?: string): boolean;
}
interface SseModule {
	sse(options: unknown): unknown;
}
interface AiModule {
	SpinetabInterruptedError: new (reason: string) => ErrorLike;
}

describe("CommonJS graph", () => {
	it("requires only .cjs files, allow-listed peers, declared self-imports and build built-ins", () => {
		const allowances = cjsAllowances();
		const offending: string[] = [];
		for (const file of walk(distDir).filter((name) => name.endsWith(".cjs"))) {
			const allowance = allowances.get(file);
			if (!allowance) {
				offending.push(`${file}: reached by no CommonJS export`);
				continue;
			}
			for (const specifier of importsOf(
				readFileSync(join(distDir, file), "utf8"),
			)) {
				if (isNodeBuiltin(specifier)) {
					if (!allowance.builtins) offending.push(`${file}: ${specifier}`);
				} else if (isBareSpecifier(specifier)) {
					if (
						!peers.has(packageName(specifier)) &&
						!allowance.selfImports.has(specifier)
					) {
						offending.push(`${file}: ${specifier}`);
					}
				} else if (!specifier.endsWith(".cjs")) {
					offending.push(`${file}: ${specifier}`);
				}
			}
		}
		expect(offending).toEqual([]);
	});

	it("declares .d.cts files against .d.cts relatives only", () => {
		const declarations = walk(distDir).filter((name) =>
			name.endsWith(".d.cts"),
		);
		expect(declarations.length).toBeGreaterThan(0);
		const offending = declarations.flatMap((file) =>
			importsOf(readFileSync(join(distDir, file), "utf8"))
				.filter((specifier) => !isBareSpecifier(specifier))
				.filter((specifier) => !isNodeBuiltin(specifier))
				.flatMap((specifier) => {
					// TypeScript maps `./x.js` to `x.d.ts` even beside an `x.d.cts`,
					// so the specifier itself must name the CommonJS form.
					const target = resolveRelative(distDir, file, specifier);
					return /\.(cjs|d\.cts)$/.test(specifier) && target?.endsWith(".d.cts")
						? []
						: [`${file}: ${specifier} → ${target ?? "unresolved"}`];
				}),
		);
		expect(offending).toEqual([]);
	});

	it("never shares a .cjs file between build and browser entries", () => {
		const mixed = [...cjsAllowances().entries()]
			.filter(([, allowance]) => allowance.realms.has("build"))
			.filter(([, allowance]) => allowance.realms.size > 1)
			.map(([file]) => file);
		expect(mixed).toEqual([]);
	});

	it("resolves the root's spinetab/wiring self-import to the dual default under require", () => {
		// `require("spinetab")` loads `index.cjs`, which requires the bare
		// `spinetab/wiring` (a named export, since a default-only CommonJS
		// module would be `module.exports = undefined`).
		const wiring = require("spinetab/wiring") as { wiring?: unknown };
		expect(Object.keys(wiring)).toEqual(["wiring"]);
		expect(wiring.wiring).toBeUndefined();
	});

	it("keeps error codes identical across the ESM and CommonJS copies", async () => {
		const esm = (await loadEsm("index.js")) as RootModule;
		const cjs = require("spinetab") as RootModule;
		const esmSse = (await loadEsm("sse.js")) as SseModule;
		const cjsSse = require("spinetab/sse") as SseModule;
		const codeOf = (action: () => unknown) => {
			try {
				action();
				return "no error";
			} catch (error) {
				return (error as { code?: string }).code;
			}
		};
		expect(codeOf(() => cjs.resolveEndpoint(""))).toBe("invalid-endpoint");
		expect(codeOf(() => esm.resolveEndpoint(""))).toBe("invalid-endpoint");
		const badSse = { url: "/x", mode: "unknown" };
		expect(codeOf(() => cjsSse.sse(badSse))).toBe("unsupported-option");
		expect(codeOf(() => esmSse.sse(badSse))).toBe("unsupported-option");
		const cjsError = new cjs.SpinetabError("timeout", "cjs");
		const esmError = new esm.SpinetabError("timeout", "esm");
		expect(cjsError.code).toBe(esmError.code);
		expect(esm.isSpinetabError(cjsError, "timeout")).toBe(true);
		expect(cjs.isSpinetabError(esmError, "timeout")).toBe(true);
	});

	it("keeps the AI interruption error code across copies", async () => {
		const esm = (await loadEsm("ai-sdk.js")) as AiModule;
		const cjs = require("spinetab/ai-sdk") as AiModule;
		expect(new cjs.SpinetabInterruptedError("x").code).toBe("interrupted");
		expect(new esm.SpinetabInterruptedError("x").code).toBe("interrupted");
	});
});
