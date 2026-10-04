import { describe, expect, it } from "vitest";
import { allowlistedPeers, BUNDLER_PACKAGES } from "./allowlist.ts";
import { readManifest } from "./dist.ts";

/**
 * Manifest rules. The packed copy of
 * this manifest is checked by the consumers stage (installs.test.ts).
 */
const manifest = readManifest() as ReturnType<typeof readManifest> & {
	devDependencies?: Record<string, string>;
};

/** The optional peers before the bundler plugins; the plugins add none. */
const PEERS = [
	"@apollo/client",
	"@tanstack/query-core",
	"@trpc/client",
	"@trpc/server",
	"ai",
	"graphql",
	"graphql-sse",
	"graphql-ws",
	"react",
	"rxjs",
	"socket.io-client",
	"solid-js",
	"svelte",
	"swr",
	"vue",
];

describe("package manifest", () => {
	it("is publishable after release acceptance", () => {
		expect(manifest.private).toBeUndefined();
		expect(manifest.version).not.toBe("0.0.0");
		expect(manifest).toMatchObject({
			repository: {
				type: "git",
				url: "git+https://github.com/apetta/spinetab.git",
				directory: "packages/spinetab",
			},
			homepage: "https://spinetab.com",
			bugs: { url: "https://github.com/apetta/spinetab/issues" },
		});
	});

	it("has no runtime dependencies", () => {
		expect(Object.keys(manifest.dependencies ?? {})).toEqual([]);
	});

	it("declares sideEffects: false", () => {
		expect(manifest.sideEffects).toBe(false);
	});

	it("keeps the peer set unchanged by the bundler plugins", () => {
		expect(Object.keys(manifest.peerDependencies ?? {}).sort()).toEqual(PEERS);
		expect(Object.keys(manifest.peerDependenciesMeta ?? {}).sort()).toEqual(
			PEERS,
		);
	});

	it("keeps the bundler packages as devDependencies only", () => {
		for (const name of BUNDLER_PACKAGES) {
			expect(manifest.peerDependencies?.[name], `${name} peer`).toBeUndefined();
			expect(
				manifest.dependencies?.[name],
				`${name} dependency`,
			).toBeUndefined();
			expect(manifest.devDependencies?.[name], `${name} devDependency`).toMatch(
				/^\d+\.\d+\.\d+$/,
			);
		}
	});

	it("declares exactly the allow-listed peers, all optional", () => {
		const peers = Object.keys(manifest.peerDependencies ?? {}).sort();
		expect(peers).toEqual(allowlistedPeers());
		for (const peer of peers) {
			expect(manifest.peerDependenciesMeta?.[peer]?.optional, peer).toBe(true);
		}
	});

	it("lists `types` first in every condition and exports no wildcard, deep path or package.json", () => {
		for (const [subpath, conditions] of Object.entries(manifest.exports)) {
			expect(subpath).not.toMatch(/\*|^\.\/dist|package\.json/);
			for (const [condition, target] of Object.entries(conditions)) {
				expect(Object.keys(target)[0], `${subpath} ${condition}`).toBe("types");
				expect(Object.keys(target), `${subpath} ${condition}`).toEqual([
					"types",
					"default",
				]);
			}
		}
	});

	it("publishes only dist, README, CHANGELOG and LICENSE", () => {
		expect([...(manifest.files ?? [])].sort()).toEqual(
			["CHANGELOG.md", "LICENSE", "README.md", "dist"].sort(),
		);
	});
});
