import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { allowlistedPeers } from "../allowlist.ts";
import { appRoot, CONSUMERS, unselectedPeers } from "./catalogue.ts";
import {
	consumerDir,
	packageRoot,
	packDir,
	reportsDir,
	templatesDir,
} from "./paths.ts";
import {
	assertFreshPack,
	computeDistHash,
	lockfileDependants,
	lockfilePackages,
	lockfileSpinetabIntegrity,
	type PackRecord,
	readPrepareRecord,
	tarballListing,
} from "./prepare.ts";
import { resolveInChild } from "./run.ts";

/**
 * Installed packed consumers. Reads only the out-of-tree work root written by `consumers:prepare`.
 * Module resolution runs in a plain Node child without `NODE_PATH`
 * (`resolveInChild`): in-process, the pnpm bin shim's `NODE_PATH` lets
 * `createRequire` reach the workspace virtual store.
 */
let record: PackRecord;

beforeAll(() => {
	record = assertFreshPack("consumers:installs");
});

afterAll(() => {
	assertFreshPack("consumers:installs (end)");
});

interface Manifest {
	name: string;
	version: string;
	private?: boolean;
	sideEffects?: boolean;
	dependencies?: Record<string, string>;
	exports: Record<string, unknown>;
	peerDependencies?: Record<string, string>;
	peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

const repoManifest = JSON.parse(
	readFileSync(join(packageRoot, "package.json"), "utf8"),
) as Manifest;

describe("pack record", () => {
	it("lists the tarball's own files and sizes, the manifest pnpm rewrote included", () => {
		const packed = tarballListing(readFileSync(join(packDir(), record.file)));
		expect(record.files).toEqual(packed.files);
		expect(record.unpackedSize).toBe(packed.unpackedSize);
	});
});

/** Node's bare-package lookup: `<ancestor>/node_modules/<name>/package.json`. */
function findPackage(name: string, from: string): string | null {
	let dir = from;
	for (;;) {
		const candidate = join(dir, "node_modules", name, "package.json");
		if (existsSync(candidate)) return candidate;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

function packageVersion(manifest: string): string | undefined {
	return (JSON.parse(readFileSync(manifest, "utf8")) as { version?: string })
		.version;
}

/** The range a directly installed dependant declares for `peer`, if linked. */
function declaredRange(
	root: string,
	dependant: string,
	peer: string,
): string | null {
	const manifest = join(root, "node_modules", dependant, "package.json");
	if (!existsSync(manifest)) return null;
	const { dependencies } = JSON.parse(readFileSync(manifest, "utf8")) as {
		dependencies?: Record<string, string>;
	};
	return dependencies?.[peer] ?? null;
}

/**
 * Workspace packages of a workspace consumer (`packages/*`) whose template
 * manifest depends on Spinetab, relative to the consumer root.
 */
function workspaceDependants(name: string, root: string): string[] {
	const packages = join(templatesDir, name, "packages");
	if (!existsSync(packages)) return [];
	return readdirSync(packages)
		.map((dir) => `packages/${dir}`)
		.filter((dir) => {
			const manifest = join(root, dir, "package.json");
			if (!existsSync(manifest)) return false;
			const { dependencies } = JSON.parse(readFileSync(manifest, "utf8")) as {
				dependencies?: Record<string, string>;
			};
			return dependencies?.spinetab !== undefined;
		});
}

for (const spec of CONSUMERS) {
	describe(spec.name, () => {
		const root = consumerDir(spec.name);
		// A workspace consumer (`next-monorepo`) keeps its lockfile at the root
		// and links Spinetab into its app and packages only (`hoist: false`).
		const app = appRoot(spec, root);
		const installed = () => realpathSync(join(app, "node_modules/spinetab"));

		it("installs the packed tarball, not a link, with a matching hash", () => {
			const prepared = readPrepareRecord(spec.name);
			const manifest = JSON.parse(
				readFileSync(join(app, "package.json"), "utf8"),
			) as { dependencies?: Record<string, string> };
			expect(manifest.dependencies?.spinetab).toBe(
				spec.appDir
					? `file:../../../pack/${record.file}`
					: `file:../pack/${record.file}`,
			);
			const lock = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
			expect(lockfileSpinetabIntegrity(lock)).toBe(record.integrity);
			expect(prepared.integrity).toBe(record.integrity);
			expect(lock).not.toMatch(/spinetab@(link|workspace):/);
			expect(installed()).toMatch(/[/\\]\.pnpm[/\\]spinetab@file\+/);
			expect(computeDistHash(join(installed(), "dist"))).toBe(record.distHash);
			if (existsSync(join(templatesDir, spec.name, "pnpm-lock.yaml"))) {
				expect(prepared.lockfile.unexpected).toEqual([]);
			}
			// Every workspace package linking Spinetab gets the same copy, so
			// the app and its packages never see two (dual-package hazard).
			for (const dir of workspaceDependants(spec.name, root)) {
				expect(
					realpathSync(join(root, dir, "node_modules/spinetab")),
					`${dir} links the app's Spinetab copy`,
				).toBe(installed());
			}
		});

		it("installs the manifest as packed: publishable, dependency-free, optional peers", () => {
			const packed = JSON.parse(
				readFileSync(join(installed(), "package.json"), "utf8"),
			) as Manifest;
			expect(packed.name).toBe(repoManifest.name);
			expect(packed.version).toBe(repoManifest.version);
			expect(packed.exports).toEqual(repoManifest.exports);
			expect(packed.private).toBeUndefined();
			expect(Object.keys(packed.dependencies ?? {})).toEqual([]);
			expect(packed.sideEffects).toBe(false);
			const peers = Object.keys(packed.peerDependencies ?? {}).sort();
			expect(peers).toEqual(allowlistedPeers());
			for (const peer of peers) {
				expect(packed.peerDependenciesMeta?.[peer]?.optional, peer).toBe(true);
			}
		});

		it("links every selected peer to Spinetab and no unselected one", () => {
			const from = installed();
			const inside = `${realpathSync(root)}${sep}`;
			const reachable = [...spec.peers, ...spec.upstreamInstalled];
			const unselected = unselectedPeers(spec);
			for (const peer of reachable) {
				expect(
					findPackage(peer, from),
					`${peer} should resolve`,
				).not.toBeNull();
			}
			for (const peer of unselected) {
				expect(findPackage(peer, from), `${peer} must be absent`).toBeNull();
			}
			const resolved = new Map(
				resolveInChild(from, [...reachable, ...unselected]).map((row) => [
					row.name,
					row,
				]),
			);
			for (const peer of reachable) {
				const row = resolved.get(peer);
				expect(row?.code ?? null, peer).toBeNull();
				expect(
					row?.resolved?.startsWith(inside),
					`${peer} resolves inside ${root}: ${row?.resolved}`,
				).toBe(true);
			}
			for (const peer of unselected) {
				expect(resolved.get(peer)?.code, peer).toBe("MODULE_NOT_FOUND");
			}
		});

		// Upstream-installed peers (plan open risk 2) resolve from Spinetab
		// because pnpm binds an installed package to its optional peer. Record
		// who installed them; Spinetab's own integration for them stays
		// forbidden by the isolation inspection (its entry is not selected).
		it.runIf(spec.upstreamInstalled.length > 0)(
			"records the upstream provenance of each upstream-installed peer",
			() => {
				const from = installed();
				const lock = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
				const records = spec.upstreamInstalled.map((peer) => {
					const manifest = findPackage(peer, from);
					expect(manifest, `${peer} should resolve`).not.toBeNull();
					const version = packageVersion(manifest as string);
					const dependants = lockfileDependants(lock, peer);
					const upstream = dependants.filter(
						(dependant) => dependant.name !== "spinetab",
					);
					expect(
						upstream.map((dependant) => dependant.name),
						`${peer} needs an installed dependant other than Spinetab`,
					).not.toEqual([]);
					expect(
						upstream.some(
							(dependant) => dependant.dependencyVersion === version,
						),
						`${peer}@${version} is the version an upstream dependant installed`,
					).toBe(true);
					return {
						peer,
						version,
						resolvedFromSpinetab: realpathSync(manifest as string),
						upstream: upstream.map((dependant) => ({
							...dependant,
							declaredRange: declaredRange(app, dependant.name, peer),
						})),
						spinetabBinding: dependants.filter(
							(dependant) => dependant.name === "spinetab",
						),
					};
				});
				mkdirSync(reportsDir(spec.name), { recursive: true });
				writeFileSync(
					join(reportsDir(spec.name), "installs-upstream.json"),
					`${JSON.stringify({ consumer: spec.name, peers: records }, null, "\t")}\n`,
				);
			},
		);

		it("installs no unselected Spinetab peer anywhere in its tree", () => {
			const packages = lockfilePackages(
				readFileSync(join(root, "pnpm-lock.yaml"), "utf8"),
			);
			const present = unselectedPeers(spec).filter((peer) =>
				packages.has(peer),
			);
			expect(present).toEqual([]);
			// Upstream-installed peers are recorded, not failed (plan open risk 2).
			for (const peer of spec.upstreamInstalled) {
				expect(packages.has(peer), `${peer} is expected from upstream`).toBe(
					true,
				);
			}
		});
	});
}
