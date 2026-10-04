// assignability: the structural plugin types must satisfy each bundler's
// own configuration types. The checks compile in a program of their own:
// `next` and `astro` declare global augmentations (for example
// `NodeJS.ProcessEnv.NODE_ENV`) that must not leak into the package typecheck.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = join(here, "..", "..", "..");
const fixture = join(here, "__assignability__.ts");
const build = "../../../src/build";

const SOURCE = `
import type { RspackOptions } from "@rspack/core";
import type { AstroIntegration } from "astro";
import type { NextConfig } from "next";
import type { PluginOption, UserConfig } from "vite";
import type { Configuration } from "webpack";
import { spinetab as astro } from "${build}/astro.ts";
import { withSpinetab } from "${build}/next.ts";
import { spinetab as rspack } from "${build}/rspack.ts";
import { spinetab as vite } from "${build}/vite.ts";
import { spinetab as webpack } from "${build}/webpack.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assert = <T extends true>(): T => true as T;

// 1. Vite
export const vitePlugins: PluginOption[] = [vite()];
export const viteConfig: UserConfig = { plugins: [vite({ adapters: ["polling"] })] };

// 2. webpack
export const webpackConfig: Configuration = { plugins: [webpack()] };

// 3. Rspack
export const rspackConfig: RspackOptions = { plugins: [rspack()] };

// 4. Next: object and function configs in, NextConfig out. The result fits
// Next's own function-form config, whatever the input's inferred type: a
// literal is narrower than NextConfig and must not leak into the context.
type NextExport = (phase: string, context: { defaultConfig: NextConfig }) => Promise<NextConfig>;
const input: NextConfig = { reactStrictMode: true };
export const nextFromObject = withSpinetab(input);
export const nextFromFunction = withSpinetab(
	(_phase: string, { defaultConfig }: { defaultConfig: NextConfig }) => defaultConfig,
);
assert<Equal<Awaited<ReturnType<typeof nextFromObject>>, NextConfig>>();
assert<Equal<Awaited<ReturnType<typeof nextFromFunction>>, NextConfig>>();
export const nextForms: NextExport[] = [
	withSpinetab(),
	withSpinetab({ reactStrictMode: true }),
	withSpinetab({ turbopack: { resolveAlias: { a: "b" } } }, { adapters: ["sse"] }),
	withSpinetab(async () => ({ basePath: "/x" })),
	withSpinetab((phase: string) => ({ distDir: phase })),
	withSpinetab(async (_phase, { defaultConfig }) => ({...defaultConfig, basePath: "/y" })),
	nextFromObject,
	nextFromFunction,
	// A function-form config as input, such as another wrapper returns.
	withSpinetab(withSpinetab({ reactStrictMode: true })),
];

// 5. Astro
export const integration: AstroIntegration = astro();
export const integrations: AstroIntegration[] = [astro({ adapters: ["sse"] })];

// The option surface is closed.
// @ts-expect-error: no such option
vite({ limits: {} });
// \`dir\` (the Next project directory) is withSpinetab's only.
export const nextWithDir = withSpinetab({}, { dir: "/work/apps/web", adapters: ["sse"] });
// @ts-expect-error: dir belongs to withSpinetab
vite({ dir: "/work/app" });
// @ts-expect-error: dir belongs to withSpinetab
webpack({ dir: "/work/app" });
// @ts-expect-error: dir belongs to withSpinetab
astro({ dir: "/work/app" });
// @ts-expect-error: adapter names are closed
webpack({ adapters: ["mqtt"] });
`;

function diagnose(source: string): string[] {
	const options: ts.CompilerOptions = {
		target: ts.ScriptTarget.ES2022,
		lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		allowImportingTsExtensions: true,
		noEmit: true,
		strict: true,
		skipLibCheck: true,
		types: ["node"],
		typeRoots: [join(packageDir, "node_modules", "@types")],
	};
	const host = ts.createCompilerHost(options);
	const getSourceFile = host.getSourceFile.bind(host);
	host.getSourceFile = (name, version, onError, create) =>
		name === fixture
			? ts.createSourceFile(name, source, version)
			: getSourceFile(name, version, onError, create);
	const fileExists = host.fileExists.bind(host);
	host.fileExists = (name) => name === fixture || fileExists(name);
	const program = ts.createProgram([fixture], options, host);
	return ts
		.getPreEmitDiagnostics(program)
		.map((diagnostic) =>
			ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
		);
}

describe("bundler assignability", () => {
	it("plugins fit Vite, webpack, Rspack, Next and Astro configuration types", () => {
		expect(diagnose(SOURCE)).toEqual([]);
	}, 60_000);

	it("the check itself fails on a wrong type", () => {
		const broken = `import type { Configuration } from "webpack";\nexport const c: Configuration = { plugins: [{ apply: 1 }] };\n`;
		expect(diagnose(broken).length).toBeGreaterThan(0);
	}, 60_000);
});
