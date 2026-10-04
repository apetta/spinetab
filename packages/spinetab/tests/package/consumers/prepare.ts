import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { appRoot, CONSUMERS, type ConsumerSpec } from "./catalogue.ts";
import {
	consumerDir,
	contaminatedAncestors,
	distDir,
	packageRoot,
	packDir,
	packRecordPath,
	repoRoot,
	TARBALL,
	templatesDir,
	workRoot,
} from "./paths.ts";
import { run } from "./run.ts";

/**
 * Pack pipeline for packed-consumer acceptance.
 *
 * node tests/package/consumers/prepare.ts [--dry-run] [--only a,b]
 *
 * 1. Lock the out-of-tree work root (atomic mkdir, pid inside).
 * 2. Hash `dist/**` (sorted paths and contents).
 * 3. `pnpm pack` into W/pack; the listing is read from the tarball itself.
 * 4. Record the candidate in W/pack/pack.json.
 * 5. Copy each template to W/<name> and install it with pnpm (hoist: false).
 * 6. Check the lockfile diff, the tarball integrity and the installed dist.
 * 7. Release the lock.
 *
 * Every later stage calls `assertFreshPack()` before and after it runs.
 */

export interface PackRecord {
	file: string;
	sha256: string;
	integrity: string;
	size: number;
	unpackedSize: number;
	files: Array<{ path: string; size: number }>;
	distHash: string;
	gitHead: string;
	dirty: boolean;
	sourceHash: string;
	node: string;
	pnpm: string;
	createdAt: string;
}

export interface PrepareRecord {
	consumer: string;
	integrity: string | null;
	installedDistHash: string;
	lockfile: { template: boolean; unexpected: string[] };
	installMs: number;
}

const STALE = "re-run consumers:prepare";

/** sha256 over sorted relative paths and file contents. */
export function computeDistHash(root: string = distDir): string {
	const hash = createHash("sha256");
	for (const file of listFiles(root)) {
		hash.update(file);
		hash.update("\0");
		hash.update(readFileSync(join(root, file)));
		hash.update("\0");
	}
	return hash.digest("hex");
}

export function listFiles(root: string): string[] {
	const files: string[] = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (entry.isFile())
				files.push(relative(root, path).replace(/\\/g, "/"));
		}
	};
	walk(root);
	return files.sort();
}

export interface TarballListing {
	unpackedSize: number;
	files: Array<{ path: string; size: number }>;
}

/**
 * The regular files of a packed `.tgz` below `package/`, with their sizes,
 * read from the tar headers (ustar prefix and PAX `path`/`size` included).
 * This is what consumers install: pnpm rewrites `package.json` while
 * packing, so npm's working-tree dry run misstates it.
 */
export function tarballListing(tgz: Buffer): TarballListing {
	const tar = gunzipSync(tgz);
	const files: Array<{ path: string; size: number }> = [];
	let pax: Record<string, string> = {};
	for (let offset = 0; offset + 512 <= tar.length; ) {
		const header = tar.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) break;
		const text = (start: number, length: number) => {
			const bytes = header.subarray(start, start + length);
			const end = bytes.indexOf(0);
			return bytes.subarray(0, end === -1 ? length : end).toString("utf8");
		};
		const size = Number.parseInt(text(124, 12).trim() || "0", 8);
		const type = text(156, 1);
		const body = tar.subarray(offset + 512, offset + 512 + size);
		offset += 512 + Math.ceil(size / 512) * 512;
		if (type === "x") {
			pax = paxRecords(body);
			continue;
		}
		if (type === "g") continue;
		const prefix = text(345, 155);
		const name =
			pax.path ?? (prefix ? `${prefix}/${text(0, 100)}` : text(0, 100));
		const fileSize = pax.size === undefined ? size : Number(pax.size);
		pax = {};
		// Regular files only ("0", or NUL in old archives).
		if (type !== "0" && type !== "") continue;
		files.push({ path: name.replace(/^package\//, ""), size: fileSize });
	}
	files.sort((a, b) => a.path.localeCompare(b.path));
	return {
		unpackedSize: files.reduce((sum, file) => sum + file.size, 0),
		files,
	};
}

/** PAX extended header records: `<length> <key>=<value>\n`. */
function paxRecords(body: Buffer): Record<string, string> {
	const records: Record<string, string> = {};
	let offset = 0;
	while (offset < body.length) {
		const space = body.indexOf(0x20, offset);
		if (space === -1) break;
		const length = Number.parseInt(body.subarray(offset, space).toString(), 10);
		if (!Number.isFinite(length) || length <= 0) break;
		const record = body
			.subarray(space + 1, offset + length - 1)
			.toString("utf8");
		const equals = record.indexOf("=");
		if (equals > 0) records[record.slice(0, equals)] = record.slice(equals + 1);
		offset += length;
	}
	return records;
}

export function readPackRecord(): PackRecord {
	const path = packRecordPath();
	if (!existsSync(path)) {
		throw new Error(`No packed candidate at ${path}: ${STALE}.`);
	}
	return JSON.parse(readFileSync(path, "utf8")) as PackRecord;
}

/**
 * Stale-pack guard: the packed candidate must match the current `dist`. Also
 * catches a `tsdown --watch` rewriting `dist` mid-run.
 */
export function assertFreshPack(stage: string): PackRecord {
	const record = readPackRecord();
	if (!existsSync(distDir)) {
		throw new Error(`${stage}: dist/ is missing; build, then ${STALE}.`);
	}
	const current = computeDistHash();
	if (current !== record.distHash) {
		throw new Error(
			`${stage}: dist/ changed since packing (${record.distHash.slice(0, 12)} → ${current.slice(0, 12)}); ${STALE}.`,
		);
	}
	if (!existsSync(join(packDir(), record.file))) {
		throw new Error(`${stage}: ${record.file} is missing; ${STALE}.`);
	}
	return record;
}

/** Integrity pnpm recorded for the packed tarball, or null. */
export function lockfileSpinetabIntegrity(lockText: string): string | null {
	for (const line of lockText.split("\n")) {
		if (!line.includes(`tarball: file:../pack/${TARBALL}`)) continue;
		const match = /integrity: (sha512-[A-Za-z0-9+/=]+)/.exec(line);
		if (match?.[1]) return match[1];
	}
	return null;
}

/**
 * Lines that differ between the template lockfile and the installed one,
 * ignoring every line that mentions Spinetab (its resolution and integrity
 * change with each pack). Anything left is an unexpected dependency change.
 */
export function lockfileDiff(template: string, actual: string): string[] {
	const relevant = (text: string) =>
		text
			.split("\n")
			.map((line) => line.trimEnd())
			.filter((line) => line.length > 0 && !line.includes("spinetab"));
	const before = relevant(template);
	const after = relevant(actual);
	const counts = new Map<string, number>();
	for (const line of before) counts.set(line, (counts.get(line) ?? 0) + 1);
	const unexpected: string[] = [];
	for (const line of after) {
		const left = counts.get(line) ?? 0;
		if (left > 0) counts.set(line, left - 1);
		else unexpected.push(`+ ${line}`);
	}
	for (const [line, left] of counts) {
		for (let index = 0; index < left; index += 1) unexpected.push(`- ${line}`);
	}
	return unexpected;
}

/** Package names present anywhere in an installed pnpm lockfile (v9). */
export function lockfilePackages(lockText: string): Set<string> {
	const names = new Set<string>();
	let section = "";
	for (const line of lockText.split("\n")) {
		const top = /^([a-zA-Z]+):\s*$/.exec(line);
		if (top?.[1]) {
			section = top[1];
			continue;
		}
		if (section !== "packages" && section !== "snapshots") continue;
		const key = /^ {2}'?((?:@[^/@\s']+\/)?[^@\s']+)@/.exec(line);
		if (key?.[1]) names.add(key[1]);
	}
	return names;
}

export interface LockfileDependant {
	/** Installed package that lists the dependency. */
	name: string;
	version: string;
	field: "dependencies" | "optionalDependencies";
	/** Version of the dependency it is bound to. */
	dependencyVersion: string;
}

/** `name@version(peer…)` snapshot key → name and version. */
function snapshotKey(key: string): { name: string; version: string } | null {
	const match = /^((?:@[^/@\s]+\/)?[^@\s]+)@([^(]+)/.exec(key);
	return match?.[1] && match[2] ? { name: match[1], version: match[2] } : null;
}

/**
 * Installed packages (pnpm v9 `snapshots`) that depend on `dependency`, as
 * provenance for an upstream-installed peer. Spinetab's own optional peer
 * binding appears here too, under `optionalDependencies`.
 */
export function lockfileDependants(
	lockText: string,
	dependency: string,
): LockfileDependant[] {
	const found: LockfileDependant[] = [];
	let section = "";
	let owner: { name: string; version: string } | null = null;
	let field: LockfileDependant["field"] | null = null;
	for (const line of lockText.split("\n")) {
		const top = /^([a-zA-Z]+):\s*$/.exec(line);
		if (top?.[1]) {
			section = top[1];
			owner = null;
			field = null;
			continue;
		}
		if (section !== "snapshots") continue;
		const key = /^ {2}'?([^'\s][^']*?)'?:(?:\s*\{\})?\s*$/.exec(line);
		if (key?.[1]) {
			owner = snapshotKey(key[1]);
			field = null;
			continue;
		}
		const block = /^ {4}(dependencies|optionalDependencies):\s*$/.exec(line);
		if (block?.[1]) {
			field = block[1] as LockfileDependant["field"];
			continue;
		}
		if (/^ {4}\S/.test(line)) {
			field = null;
			continue;
		}
		const entry = /^ {6}'?([^':\s]+)'?:\s*(\S+)\s*$/.exec(line);
		if (owner && field && entry?.[1] === dependency && entry[2]) {
			found.push({
				name: owner.name,
				version: owner.version,
				field,
				dependencyVersion: entry[2].replace(/\(.*$/, ""),
			});
		}
	}
	return found;
}

export function readPrepareRecord(name: string): PrepareRecord {
	const path = join(consumerDir(name), ".prepare.json");
	if (!existsSync(path)) {
		throw new Error(`${name} was not installed: ${STALE}.`);
	}
	return JSON.parse(readFileSync(path, "utf8")) as PrepareRecord;
}

/** Environment for child pnpm installs: no workspace settings leak in. */
function isolatedEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined) continue;
		if (/^(npm_config_|npm_package_|npm_lifecycle_)/i.test(key)) continue;
		if (key === "INIT_CWD" || key === "PNPM_SCRIPT_SRC_DIR") continue;
		env[key] = value;
	}
	return env;
}

function git(args: string[]): string {
	return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

function sourceHash(): string {
	const files = git([
		"ls-files",
		"-co",
		"--exclude-standard",
		"packages/spinetab",
	])
		.split("\n")
		.filter(Boolean)
		.sort();
	const hash = createHash("sha256");
	for (const file of files) {
		const path = join(repoRoot, file);
		if (!existsSync(path) || !statSync(path).isFile()) continue;
		hash.update(file);
		hash.update("\0");
		hash.update(readFileSync(path));
		hash.update("\0");
	}
	return hash.digest("hex");
}

function acquireLock(root: string): () => void {
	mkdirSync(root, { recursive: true });
	const lock = join(root, ".lock");
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			mkdirSync(lock);
			writeFileSync(join(lock, "pid"), String(process.pid));
			return () => rmSync(lock, { recursive: true, force: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const pid = Number(
				existsSync(join(lock, "pid"))
					? readFileSync(join(lock, "pid"), "utf8")
					: Number.NaN,
			);
			if (Number.isInteger(pid) && isAlive(pid)) {
				throw new Error(
					`${lock} is held by live process ${pid}; wait for it to finish.`,
				);
			}
			rmSync(lock, { recursive: true, force: true });
		}
	}
	throw new Error(`Could not acquire ${lock}.`);
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function sri(bytes: Buffer): string {
	return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

const EXCLUDED =
	/(^|\/)(node_modules|dist(-[^/]*)?|\.next(-[^/]*)?|out|reports)(\/|$)/;

/** Replace the consumer's files with the template's; keep its node_modules. */
function copyTemplate(spec: ConsumerSpec): void {
	const source = join(templatesDir, spec.name);
	const target = consumerDir(spec.name);
	mkdirSync(target, { recursive: true });
	for (const entry of readdirSync(target)) {
		if (entry === "node_modules") continue;
		rmSync(join(target, entry), { recursive: true, force: true });
	}
	cpSync(source, target, {
		recursive: true,
		filter: (path) =>
			!EXCLUDED.test(relative(source, path).replace(/\\/g, "/")),
	});
}

async function install(
	spec: ConsumerSpec,
	record: PackRecord,
): Promise<PrepareRecord> {
	const target = consumerDir(spec.name);
	const started = Date.now();
	const result = await run(
		"pnpm",
		[
			"install",
			"--dir",
			target,
			"--no-frozen-lockfile",
			"--prefer-offline",
			"--ignore-scripts",
			"--reporter=append-only",
		],
		{
			cwd: target,
			env: isolatedEnv(),
			timeoutMs: 900_000,
			logFile: join(target, "reports/install.log"),
		},
	);
	if (result.code !== 0) {
		throw new Error(
			`pnpm install failed for ${spec.name} (${result.code}):\n${result.output.slice(-4000)}`,
		);
	}
	const lockPath = join(target, "pnpm-lock.yaml");
	const lockText = readFileSync(lockPath, "utf8");
	const integrity = lockfileSpinetabIntegrity(lockText);
	if (integrity !== record.integrity) {
		throw new Error(
			`${spec.name}: lockfile integrity ${integrity} does not match the packed tarball ${record.integrity}.`,
		);
	}
	const templateLock = join(templatesDir, spec.name, "pnpm-lock.yaml");
	const hasTemplate = existsSync(templateLock);
	const unexpected = hasTemplate
		? lockfileDiff(readFileSync(templateLock, "utf8"), lockText)
		: [];
	if (process.env.SPINETAB_CONSUMERS_UPDATE_LOCK === "1") {
		cpSync(lockPath, templateLock);
	} else if (unexpected.length > 0) {
		throw new Error(
			`${spec.name}: the lockfile changed beyond Spinetab's lines; review and re-run with SPINETAB_CONSUMERS_UPDATE_LOCK=1:\n${unexpected.slice(0, 40).join("\n")}`,
		);
	}
	// A workspace consumer links Spinetab into its app (and packages), not
	// into the root (`hoist: false`).
	const installedDistHash = computeDistHash(
		join(appRoot(spec, target), "node_modules/spinetab/dist"),
	);
	if (installedDistHash !== record.distHash) {
		throw new Error(
			`${spec.name}: installed spinetab/dist does not match the packed dist.`,
		);
	}
	const prepared: PrepareRecord = {
		consumer: spec.name,
		integrity,
		installedDistHash,
		lockfile: { template: hasTemplate, unexpected },
		installMs: Date.now() - started,
	};
	writeFileSync(
		join(target, ".prepare.json"),
		`${JSON.stringify(prepared, null, "\t")}\n`,
	);
	return prepared;
}

async function pack(): Promise<PackRecord> {
	const distHash = computeDistHash();
	const destination = packDir();
	rmSync(destination, { recursive: true, force: true });
	mkdirSync(destination, { recursive: true });
	const packed = await run(
		"pnpm",
		["pack", "--pack-destination", destination],
		{
			cwd: packageRoot,
			env: isolatedEnv(),
			timeoutMs: 120_000,
			logFile: join(destination, "pack.log"),
		},
	);
	if (packed.code !== 0) {
		throw new Error(`pnpm pack failed:\n${packed.output.slice(-4000)}`);
	}
	const tarballs = readdirSync(destination).filter((file) =>
		file.endsWith(".tgz"),
	);
	if (tarballs.length !== 1 || tarballs[0] !== TARBALL) {
		throw new Error(
			`Expected ${TARBALL} in ${destination}, found ${tarballs.join(", ")}`,
		);
	}
	const bytes = readFileSync(join(destination, TARBALL));
	// sizes and paths of what was packed, not of the working tree.
	const listing = tarballListing(bytes);
	if (computeDistHash() !== distHash) {
		throw new Error("dist/ changed while packing; stop any watcher and retry.");
	}
	const record: PackRecord = {
		file: TARBALL,
		sha256: createHash("sha256").update(bytes).digest("hex"),
		integrity: sri(bytes),
		size: bytes.length,
		unpackedSize: listing.unpackedSize,
		files: listing.files,
		distHash,
		gitHead: git(["rev-parse", "HEAD"]),
		dirty: git(["status", "--porcelain"]).length > 0,
		sourceHash: sourceHash(),
		node: process.version,
		pnpm: execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim(),
		createdAt: new Date().toISOString(),
	};
	writeFileSync(packRecordPath(), `${JSON.stringify(record, null, "\t")}\n`);
	return record;
}

function selected(only: string | undefined): ConsumerSpec[] {
	if (!only) return [...CONSUMERS];
	const names = only.split(",").filter(Boolean);
	for (const name of names) {
		if (!CONSUMERS.some((spec) => spec.name === name)) {
			throw new Error(`Unknown consumer ${name}`);
		}
	}
	return CONSUMERS.filter((spec) => names.includes(spec.name));
}

export async function prepare(options: {
	dryRun: boolean;
	only?: string;
}): Promise<void> {
	const root = workRoot();
	const consumers = selected(options.only);
	const contaminated = contaminatedAncestors(root);
	if (options.dryRun) {
		console.log(
			[
				`work root: ${root}`,
				contaminated.length
					? `ancestor markers (would abort): ${contaminated.join(", ")}`
					: "ancestors: clean",
				`lock: ${join(root, ".lock")}`,
				"hash: dist/** (sorted paths and contents)",
				`pack: pnpm pack --pack-destination ${packDir()} (cwd ${packageRoot})`,
				"list: the tarball's own entries (paths and sizes)",
				...consumers.map(
					(spec) =>
						`install ${spec.name}: copy ${join(templatesDir, spec.name)} → ${consumerDir(spec.name)}; pnpm install --dir ${consumerDir(spec.name)} --no-frozen-lockfile --prefer-offline --ignore-scripts --reporter=append-only`,
				),
			].join("\n"),
		);
		return;
	}
	if (contaminated.length > 0) {
		throw new Error(
			`The work root ${root} has project markers above it (${contaminated.join(", ")}); set SPINETAB_CONSUMERS_DIR to a clean location.`,
		);
	}
	if (!existsSync(distDir) || listFiles(distDir).length === 0) {
		throw new Error("dist/ is empty: run the package build first.");
	}
	const release = acquireLock(root);
	try {
		const record = await pack();
		console.log(
			`packed ${record.file} ${record.sha256.slice(0, 12)} (${record.size} B, dist ${record.distHash.slice(0, 12)})`,
		);
		for (const spec of consumers) {
			copyTemplate(spec);
			const prepared = await install(spec, record);
			console.log(
				`installed ${spec.name} in ${Math.round(prepared.installMs / 1000)} s${prepared.lockfile.template ? "" : " (no template lockfile yet: re-run with SPINETAB_CONSUMERS_UPDATE_LOCK=1 to record one)"}`,
			);
		}
		assertFreshPack("prepare");
	} finally {
		release();
	}
}

const isMain =
	process.argv[1] !== undefined &&
	fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
	const args = process.argv.slice(2);
	const onlyIndex = args.indexOf("--only");
	try {
		await prepare({
			dryRun: args.includes("--dry-run"),
			...(onlyIndex >= 0 && args[onlyIndex + 1]
				? { only: args[onlyIndex + 1] }
				: {}),
		});
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}
