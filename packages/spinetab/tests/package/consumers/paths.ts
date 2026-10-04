import { existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Locations shared by the packed-consumer pipeline. The
 * work root lives outside the repository so Node resolution can never walk up
 * into the workspace's `node_modules`.
 */
export const packageRoot = fileURLToPath(new URL("../../../", import.meta.url));
export const repoRoot = resolve(packageRoot, "../..");
export const distDir = join(packageRoot, "dist");
export const templatesDir = join(packageRoot, "tests/fixtures/consumers");

/** Markers that make a directory part of a Node/pnpm project. */
export const PROJECT_MARKERS = [
	"node_modules",
	"package.json",
	"pnpm-workspace.yaml",
	"pnpm-lock.yaml",
] as const;

export function workRoot(): string {
	const configured = process.env.SPINETAB_CONSUMERS_DIR;
	const base = configured
		? resolve(configured)
		: join(tmpdir(), "spinetab-consumers");
	return base;
}

export const packDir = () => join(workRoot(), "pack");
export const packRecordPath = () => join(packDir(), "pack.json");
export const TARBALL = "spinetab-0.1.0.tgz";
export const consumerDir = (name: string) => join(workRoot(), name);
export const reportsDir = (name: string) => join(consumerDir(name), "reports");

/**
 * Ancestors of the work root that contain a project marker. Any hit means a
 * consumer could resolve packages it did not install.
 */
export function contaminatedAncestors(root: string): string[] {
	const hits: string[] = [];
	let current = dirname(existingRealpath(root));
	for (;;) {
		for (const marker of PROJECT_MARKERS) {
			const candidate = join(current, marker);
			if (existsSync(candidate)) hits.push(candidate);
		}
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return hits;
}

/** Realpath of the nearest existing ancestor, joined with the missing tail. */
function existingRealpath(path: string): string {
	let current = resolve(path);
	const tail: string[] = [];
	while (!existsSync(current)) {
		const parent = dirname(current);
		if (parent === current) break;
		tail.unshift(current.slice(parent.length + 1));
		current = parent;
	}
	return join(realpathSync(current), ...tail);
}

/** Evidence written under the package's git-ignored `test-results/`. */
export function evidenceDir(runId: string): string {
	return join(packageRoot, "test-results/consumers", runId);
}

export function consumerRunId(): string {
	const configured = process.env.SPINETAB_CONSUMERS_RUN_ID;
	const latest = join(packageRoot, "test-results/consumers/latest-run.json");
	const id =
		configured ??
		(existsSync(latest)
			? (JSON.parse(readFileSync(latest, "utf8")) as { runId: string }).runId
			: undefined);
	if (!id || !/^[a-zA-Z0-9_-]+$/.test(id))
		throw new Error(
			"No valid consumer run identity; run e2e:consumers first or set SPINETAB_CONSUMERS_RUN_ID.",
		);
	return id;
}

export const matrixDir = () => join(evidenceDir(consumerRunId()), "matrix");
