import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { tarballListing } from "./consumers/prepare.ts";
import { packageRoot, readManifest } from "./dist.ts";

/**
 * Tarball contents: only the manifest, README, CHANGELOG, LICENSE and
 * `dist/**`; every export target is packed; sizes and integrity are recorded.
 * `npm pack --dry-run` lists without writing a tarball.
 */
interface Listing {
	size: number;
	unpackedSize: number;
	integrity: string;
	shasum: string;
	files: Array<{ path: string; size: number }>;
}

const listing = (
	JSON.parse(
		execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
			cwd: packageRoot,
			encoding: "utf8",
		}),
	) as Listing[]
)[0] as Listing;

describe("packed contents", () => {
	it("contains only package.json, README.md, CHANGELOG.md, LICENSE and dist/**", () => {
		const unexpected = listing.files
			.map((file) => file.path)
			.filter(
				(path) =>
					!["package.json", "README.md", "CHANGELOG.md", "LICENSE"].includes(
						path,
					) && !path.startsWith("dist/"),
			);
		expect(unexpected).toEqual([]);
		const leaked = listing.files
			.map((file) => file.path)
			.filter((path) =>
				/(^|\/)(src|tests|docs|fixtures|coverage)\/|\.tsbuildinfo$|\.tgz$/.test(
					path,
				),
			);
		expect(leaked).toEqual([]);
	});

	it("packs every export target", () => {
		const packed = new Set(listing.files.map((file) => file.path));
		const missing: string[] = [];
		for (const [subpath, conditions] of Object.entries(
			readManifest().exports,
		)) {
			for (const condition of Object.values(conditions)) {
				for (const target of [condition.types, condition.default]) {
					const path = target.replace(/^\.\//, "");
					if (!packed.has(path)) missing.push(`${subpath}: ${path}`);
				}
			}
		}
		expect(missing).toEqual([]);
	});

	it("records the packed and unpacked sizes and the integrity", () => {
		expect(listing.size).toBeGreaterThan(0);
		expect(listing.unpackedSize).toBeGreaterThan(listing.size);
		expect(listing.integrity).toMatch(/^sha512-/);
		const dir = join(packageRoot, "test-results/package");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "pack-listing.json"),
			`${JSON.stringify(
				{
					size: listing.size,
					unpackedSize: listing.unpackedSize,
					integrity: listing.integrity,
					shasum: listing.shasum,
					files: listing.files,
				},
				null,
				"\t",
			)}\n`,
		);
	});
});

/** One ustar header block (checksum included) for the synthetic archives. */
function tarHeader(name: string, size: number, type: string, prefix = "") {
	const header = Buffer.alloc(512);
	header.write(name, 0, 100, "utf8");
	header.write("0000644\0", 100);
	header.write("0000000\0", 108);
	header.write("0000000\0", 116);
	header.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
	header.write("00000000000\0", 136);
	header.write("        ", 148);
	header.write(type, 156);
	header.write("ustar\0", 257);
	header.write("00", 263);
	header.write(prefix, 345, 155, "utf8");
	let sum = 0;
	for (const byte of header) sum += byte;
	header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
	return header;
}

function tarEntry(header: Buffer, body: Buffer = Buffer.alloc(0)): Buffer {
	const padding = (512 - (body.length % 512)) % 512;
	return Buffer.concat([header, body, Buffer.alloc(padding)]);
}

/** A PAX `path` record: the length counts itself. */
function paxPath(path: string): Buffer {
	const record = (length: number) => `${length} path=${path}\n`;
	let length = record(0).length;
	while (record(length).length !== length) length = record(length).length;
	return Buffer.from(record(length), "utf8");
}

describe("pack record from the tarball", () => {
	it("reads regular files and sizes below package/, with ustar prefixes and PAX paths", () => {
		const long = `dist/${"nested/".repeat(20)}deep.js`;
		const pax = paxPath(`package/${long}`);
		const archive = Buffer.concat([
			tarEntry(tarHeader("package/", 0, "5")),
			tarEntry(
				tarHeader("package/package.json", 17, "0"),
				Buffer.from('{"name":"x"}\n    '),
			),
			tarEntry(
				tarHeader("wiring.js", 3, "0", "package/dist/auto"),
				Buffer.from("abc"),
			),
			tarEntry(tarHeader("PaxHeader", pax.length, "x"), pax),
			tarEntry(
				tarHeader("package/dist/truncated-name.js", 600, "0"),
				Buffer.alloc(600, 97),
			),
			tarEntry(tarHeader("package/link", 0, "2")),
			Buffer.alloc(1024),
		]);
		expect(tarballListing(gzipSync(archive))).toEqual({
			unpackedSize: 620,
			files: [
				{ path: "dist/auto/wiring.js", size: 3 },
				{ path: long, size: 600 },
				{ path: "package.json", size: 17 },
			].sort((a, b) => a.path.localeCompare(b.path)),
		});
	});

	it("the tarball pnpm packs lists npm's files, with the sizes consumers install", () => {
		const dir = join(packageRoot, "test-results/package/pack-check");
		rmSync(dir, { recursive: true, force: true });
		mkdirSync(dir, { recursive: true });
		// The command prepare.ts runs; no workspace npm settings leak in.
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(process.env)) {
			if (value === undefined) continue;
			if (/^(npm_config_|npm_package_|npm_lifecycle_)/i.test(key)) continue;
			env[key] = value;
		}
		execFileSync("pnpm", ["pack", "--pack-destination", dir], {
			cwd: packageRoot,
			env,
			encoding: "utf8",
		});
		const tarballs = readdirSync(dir).filter((file) => file.endsWith(".tgz"));
		expect(tarballs).toHaveLength(1);
		const packed = tarballListing(
			readFileSync(join(dir, tarballs[0] as string)),
		);
		const byPath = (files: Array<{ path: string; size: number }>) =>
			new Map(files.map((file) => [file.path, file.size]));
		const npm = byPath(listing.files);
		const tar = byPath(packed.files);
		expect([...tar.keys()].sort()).toEqual([...npm.keys()].sort());
		// Only the manifest may differ: pnpm rewrites it while packing.
		const differing = [...tar].filter(([path, size]) => npm.get(path) !== size);
		expect(
			differing.map(([path]) => path).filter((path) => path !== "package.json"),
		).toEqual([]);
		expect(packed.unpackedSize).toBe(
			packed.files.reduce((sum, file) => sum + file.size, 0),
		);
		writeFileSync(
			join(dir, "agreement.json"),
			`${JSON.stringify(
				{
					files: packed.files.length,
					tarballUnpackedSize: packed.unpackedSize,
					npmDryRunUnpackedSize: listing.unpackedSize,
					manifest: {
						tarball: tar.get("package.json"),
						workingTree: npm.get("package.json"),
					},
				},
				null,
				"\t",
			)}\n`,
		);
	});
});
