import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ExportTargets, exportTargets } from "./graph.ts";

/**
 * Built-package locations for the `package` Vitest project. These checks read
 * `dist/` and run after the package build (never against a watcher's output).
 */
export const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
export const distDir = join(packageRoot, "dist");

export interface PackageManifest {
	name: string;
	version: string;
	private?: boolean;
	sideEffects?: boolean;
	files?: string[];
	dependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	peerDependenciesMeta?: Record<string, { optional?: boolean }>;
	exports: Record<
		string,
		{
			import: { types: string; default: string };
			require?: { types: string; default: string };
		}
	>;
}

export function readManifest(): PackageManifest {
	return JSON.parse(
		readFileSync(join(packageRoot, "package.json"), "utf8"),
	) as PackageManifest;
}

export function targets(): ExportTargets[] {
	return exportTargets(readManifest());
}

export const specifierOf = (subpath: string) =>
	subpath === "." ? "spinetab" : `spinetab/${subpath.slice(2)}`;
