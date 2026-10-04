// Temporary project trees for the build-realm tests. Every tree lives under
// the OS temporary directory and is removed by `cleanTrees()`.

import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const created: string[] = [];

/** Writes `files` (path → content) under a fresh directory; returns its real path. */
export function makeTree(files: Record<string, string> = {}): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "spinetab-build-")));
	created.push(root);
	writeTree(root, files);
	return root;
}

export function writeTree(root: string, files: Record<string, string>): void {
	for (const [path, content] of Object.entries(files)) {
		const file = join(root, path);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, content);
	}
}

export function link(target: string, path: string): void {
	mkdirSync(dirname(path), { recursive: true });
	symlinkSync(target, path, "dir");
}

/** A fake installed package so peer lookups and `node_modules` checks pass. */
export function installPackage(root: string, name: string): void {
	writeTree(root, {
		[`node_modules/${name}/package.json`]: JSON.stringify({ name }),
	});
}

const manifest = JSON.parse(
	readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
) as { exports: Record<string, unknown>; type: string };

/**
 * A fake installed `spinetab` whose `exports` and `type` are the real
 * manifest's, with stub `dist` files for the wiring seams and the root, so a
 * real resolver sees the shipped conditions (`./auto/wiring` has `import`
 * only). Returns the installed directory.
 */
export function installSpinetab(root: string): string {
	const dir = join(root, "node_modules", "spinetab");
	writeTree(dir, {
		"package.json": JSON.stringify({
			name: "spinetab",
			version: "0.0.0",
			type: manifest.type,
			exports: manifest.exports,
		}),
		"dist/index.js":
			'import { wiring } from "spinetab/wiring";\nexport { wiring };\n',
		"dist/index.cjs":
			'const w = require("spinetab/wiring");\nmodule.exports = { wiring: w.wiring };\n',
		"dist/wiring.js": "export const wiring = {};\n",
		"dist/wiring.cjs": "module.exports = { wiring: {} };\n",
		"dist/auto/wiring.js":
			'export const wiring = { worker: () => new SharedWorker(new URL("./worker.js", import.meta.url), { type: "module" }) };\n',
		"dist/auto/worker.js": "export default undefined;\n",
		"dist/worker-config.js": "export default undefined;\n",
	});
	return dir;
}

export function cleanTrees(): void {
	for (const root of created.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
}
