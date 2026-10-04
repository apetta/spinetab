// Path helpers. Windows-style inputs must yield the same POSIX project-relative
// text as POSIX inputs, because that text reaches Turbopack aliases and
// build messages.

import { realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, win32 } from "node:path";
import { SpinetabBuildError } from "./messages.ts";

export function toPosix(path: string): string {
	return path.replace(/\\/g, "/");
}

export function isAnyAbsolute(path: string): boolean {
	return isAbsolute(path) || win32.isAbsolute(path);
}

/**
 * `file` relative to `root` as POSIX text without a leading `./`.
 * Works for mixed separators: both sides are normalised to POSIX first and
 * compared case-sensitively except for a Windows drive letter.
 */
export function relativePosix(root: string, file: string): string {
	const from = toPosix(root).replace(
		/^([a-zA-Z]):/,
		(_, d: string) => `${d.toLowerCase()}:`,
	);
	const to = toPosix(file).replace(
		/^([a-zA-Z]):/,
		(_, d: string) => `${d.toLowerCase()}:`,
	);
	if (/^[a-z]:/.test(from) || /^[a-z]:/.test(to)) {
		return toPosix(win32.relative(from, to));
	}
	return toPosix(relative(from, to));
}

/** `./`-prefixed POSIX project-relative specifier (Turbopack alias targets). */
export function dotRelative(root: string, file: string): string {
	const rel = relativePosix(root, file);
	return rel.startsWith("../") ? rel : `./${rel}`;
}

export function inNodeModules(path: string): boolean {
	return /[\\/]node_modules[\\/]/.test(path);
}

/**
 * The installed package directory as bundlers name module ids (real path),
 * found by Node's lookup from the project root. The Vite plugin keeps the
 * seams path-shaped; webpack and Rspack alias `spinetab/wiring` to a
 * file path, so a CommonJS request resolves it too. Throws
 * `package-not-installed` when the lookup finds none.
 */
export function findPackageDir(root: string): string {
	let dir = root;
	for (;;) {
		const candidate = join(dir, "node_modules", "spinetab");
		try {
			if (statSync(join(candidate, "package.json")).isFile()) {
				return realpathSync(candidate);
			}
		} catch {}
		const parent = dirname(dir);
		if (parent === dir) {
			// A SpinetabBuildError carries no stack frames.
			throw new SpinetabBuildError({ code: "package-not-installed" });
		}
		dir = parent;
	}
}
