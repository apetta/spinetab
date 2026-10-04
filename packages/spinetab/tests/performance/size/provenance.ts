import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { decodeMap } from "../../package/consumers/inspect.ts";

/**
 * Installed-package provenance for composed peer sources. Turbopack composes a package's own input sourcemaps,
 * so a peer whose published maps point outside its package directory yields
 * emitted sources such as
 * `node_modules/.pnpm/graphql@17.0.2/node_modules/src/language/location.ts`
 * (graphql's `language/location.mjs.map` lists `../../src/language/location.ts`)
 * or `…/@apollo+client@4.3.1_…/node_modules/@apollo/src/…`. Classified by
 * path alone these read as packages `src` and `@apollo/src`.
 *
 * A composed source is assigned to an installed package only when that
 * package's own input map provably lists it:
 * - the emitted path names a pnpm virtual-store entry `<name>@<version>[_peers]`
 * of the consumer project, and its package-looking name differs from the
 * entry's own package (otherwise nothing needs resolving);
 * - the emitted map carries the source's body (`sourcesContent`);
 * - within that store entry, the real (non-symlinked) packages' `*.map`
 * files are decoded with the consumer inspector's ECMA-426 `decodeMap`;
 * an input map matches when its resolved source is the same store path and
 * its `sourcesContent` body has the same sha256;
 * - the matches belong to exactly one package, which is the store entry's own
 * package at the entry's version (and the pinned version when pinned).
 *
 * Anything else (no body, no store entry, no input map listing the path, a
 * different body, two packages, a foreign package) stays unresolved: the
 * caller keeps the path-derived key, so an unselected name stays offending.
 * There is no allowlist of `src` or `@apollo/src`.
 */

export interface StoreEntry {
	/** Directory name below `node_modules/.pnpm`. */
	entry: string;
	name: string;
	version: string;
}

export interface InputMapMatch {
	/** The input map, relative to the consumer project. */
	path: string;
	/** Its `sources` entry (with `sourceRoot`) that resolves to the emitted path. */
	source: string;
	mapSha256: string;
}

export interface PeerProvenance {
	package: string;
	version: string;
	storeEntry: string;
	/** sha256 of the emitted (and every matching input) `sourcesContent` body. */
	bodySha256: string;
	inputMaps: InputMapMatch[];
}

export type ProvenanceResult =
	| { ok: true; provenance: PeerProvenance }
	| { ok: false; reason: string };

export interface ProvenanceResolver {
	/** Resolve one emitted source (as the chunk's map names it) with its body. */
	resolve(source: string, body: string | null | undefined): ProvenanceResult;
}

export const sha256 = (input: string | Buffer) =>
	createHash("sha256").update(input).digest("hex");

const STORE = "node_modules/.pnpm/";

/** `@scope+name@1.2.3_peer@4…` → `@scope/name`, `1.2.3`; undefined when not of that form. */
export function parseStoreEntry(entry: string): StoreEntry | undefined {
	const at = entry.indexOf("@", entry.startsWith("@") ? 1 : 0);
	if (at <= 0) return undefined;
	const encoded = entry.slice(0, at);
	const name = encoded.startsWith("@")
		? encoded.replace("+", "/")
		: encoded.includes("+")
			? ""
			: encoded;
	if (!name || (name.startsWith("@") && !/^@[^/]+\/[^/]+$/.test(name))) {
		return undefined;
	}
	const version = /^[0-9A-Za-z.+-]+/.exec(entry.slice(at + 1))?.[0];
	return version ? { entry, name, version } : undefined;
}

/**
 * The pnpm store location an emitted source names: `entry` and the path
 * `rest` below the entry's `node_modules/`, from the last store segment.
 * Scheme prefixes (`turbopack:///[project]/`), relative prefixes and query
 * strings do not matter; `..` segments in `rest` do not resolve.
 */
export function storeLocation(
	source: string,
): { entry: string; rest: string } | undefined {
	const path = source.replaceAll("\\", "/").replace(/[?#].*$/, "");
	const at = path.lastIndexOf(STORE);
	if (at < 0) return undefined;
	const match = /^([^/]+)\/node_modules\/(.+)$/.exec(
		path.slice(at + STORE.length),
	);
	if (!match) return undefined;
	const rest = match[2] as string;
	if (rest.split("/").some((part) => part === ".." || part === ".")) {
		return undefined;
	}
	return { entry: match[1] as string, rest };
}

/** Package-looking name of a store-relative path (`src/x.ts` → `src`). */
export function nameOf(rest: string): string {
	const parts = rest.split("/");
	return rest.startsWith("@")
		? `${parts[0]}/${parts[1] ?? ""}`
		: (parts[0] ?? "");
}

/**
 * True when an emitted source lies in a pnpm store entry but outside that
 * entry's own package: the only case the resolver is asked about.
 */
export function isComposedEscape(source: string): boolean {
	const location = storeLocation(source);
	if (!location) return false;
	const owner = parseStoreEntry(location.entry);
	return owner !== undefined && nameOf(location.rest) !== owner.name;
}

interface IndexedSource {
	package: string;
	version: string;
	path: string;
	source: string;
	mapSha256: string;
	bodySha256: string;
}

/** Real package directories of one store entry (symlinked dependencies skipped). */
function realPackages(modules: string): string[] {
	const packages: string[] = [];
	const isRealDir = (path: string) => {
		const stat = lstatSync(path);
		return stat.isDirectory() && !stat.isSymbolicLink();
	};
	for (const name of readdirSync(modules)) {
		if (name.startsWith(".")) continue;
		const path = join(modules, name);
		if (!isRealDir(path)) continue;
		if (name.startsWith("@")) {
			for (const scoped of readdirSync(path)) {
				const inner = join(path, scoped);
				if (isRealDir(inner) && existsSync(join(inner, "package.json"))) {
					packages.push(inner);
				}
			}
		} else if (existsSync(join(path, "package.json"))) {
			packages.push(path);
		}
	}
	return packages.sort();
}

/** `*.map` files of one package, not descending into nested `node_modules`. */
function mapFiles(dir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name !== "node_modules") files.push(...mapFiles(path));
		} else if (entry.isFile() && entry.name.endsWith(".map")) {
			files.push(path);
		}
	}
	return files.sort();
}

/**
 * Resolver over one consumer project's pnpm store (`<projectDir>/node_modules/.pnpm`).
 * Store entries are indexed lazily, once each. `pinned` maps package names to
 * the versions the run pinned; a pinned package must match exactly.
 */
export function createProvenanceResolver(
	projectDir: string,
	options: { pinned?: Record<string, string> } = {},
): ProvenanceResolver {
	const store = join(projectDir, "node_modules", ".pnpm");
	const indexes = new Map<string, Map<string, IndexedSource[]> | string>();

	const indexEntry = (entry: string) => {
		const cached = indexes.get(entry);
		if (cached !== undefined) return cached;
		const modules = join(store, entry, "node_modules");
		let index: Map<string, IndexedSource[]> | string;
		if (!existsSync(modules)) {
			index = `store entry ${entry} is not installed in ${relative(projectDir, store)}`;
		} else {
			index = new Map();
			for (const root of realPackages(modules)) {
				const manifest = JSON.parse(
					readFileSync(join(root, "package.json"), "utf8"),
				) as { name?: string; version?: string };
				if (!manifest.name || !manifest.version) continue;
				for (const file of mapFiles(root)) {
					const text = readFileSync(file);
					let json: unknown;
					try {
						json = JSON.parse(text.toString("utf8"));
					} catch {
						continue;
					}
					const decoded = decodeMap(json, file);
					for (const source of decoded.sources) {
						if (source.content === null) continue;
						const resolved = relative(modules, source.resolved).replaceAll(
							"\\",
							"/",
						);
						if (resolved.startsWith("../")) continue;
						const list = index.get(resolved) ?? [];
						list.push({
							package: manifest.name,
							version: manifest.version,
							path: relative(projectDir, file).replaceAll("\\", "/"),
							source: source.raw,
							mapSha256: sha256(text),
							bodySha256: sha256(source.content),
						});
						index.set(resolved, list);
					}
				}
			}
		}
		indexes.set(entry, index);
		return index;
	};

	return {
		resolve(source, body) {
			const location = storeLocation(source);
			if (!location) return { ok: false, reason: "not a pnpm store path" };
			const owner = parseStoreEntry(location.entry);
			if (!owner) {
				return {
					ok: false,
					reason: `store entry ${location.entry} has no name@version`,
				};
			}
			if (typeof body !== "string") {
				return {
					ok: false,
					reason: "the emitted map has no sourcesContent for this source",
				};
			}
			const index = indexEntry(location.entry);
			if (typeof index === "string") return { ok: false, reason: index };
			const listed = index.get(location.rest) ?? [];
			if (listed.length === 0) {
				return {
					ok: false,
					reason: `no input map in ${location.entry} lists ${location.rest}`,
				};
			}
			const bodySha256 = sha256(body);
			const matches = listed.filter((entry) => entry.bodySha256 === bodySha256);
			if (matches.length === 0) {
				return {
					ok: false,
					reason: `body ${bodySha256.slice(0, 12)} differs from every input map listing ${location.rest}`,
				};
			}
			const owners = [
				...new Set(matches.map((entry) => `${entry.package}@${entry.version}`)),
			].sort();
			if (owners.length !== 1) {
				return {
					ok: false,
					reason: `ambiguous: the body is in ${owners.length} packages (${owners.join(", ")})`,
				};
			}
			const { package: name, version } = matches[0] as IndexedSource;
			if (name !== owner.name || version !== owner.version) {
				return {
					ok: false,
					reason: `input map belongs to ${name}@${version}, not the store entry's own ${owner.name}@${owner.version}`,
				};
			}
			const pinned = options.pinned?.[name];
			if (pinned !== undefined && pinned !== version) {
				return {
					ok: false,
					reason: `${name}@${version} is not the pinned ${pinned}`,
				};
			}
			return {
				ok: true,
				provenance: {
					package: name,
					version,
					storeEntry: location.entry,
					bodySha256,
					inputMaps: matches
						.map(({ path, source: raw, mapSha256 }) => ({
							path,
							source: raw,
							mapSha256,
						}))
						.sort((a, b) => a.path.localeCompare(b.path)),
				},
			};
		},
	};
}
