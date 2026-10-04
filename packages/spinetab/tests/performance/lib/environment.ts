import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import { join, relative } from "node:path";
import {
	hostProblem,
	identityProblem,
	LOAD_LIMIT,
	type LoadGate,
} from "./eligibility.ts";
import {
	evidenceDir,
	packageRoot,
	profile,
	readJson,
	rep,
	repoRoot,
	runId,
	writeJson,
} from "./evidence.ts";

/**
 * Environment manifest. A missing command
 * records `null` with a reason and never fails the run. Node-runnable.
 */

export interface Probe<T> {
	value: T | null;
	reason?: string;
}

function run(command: string, args: string[]): Probe<string> {
	try {
		return {
			value: execFileSync(command, args, {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				timeout: 10_000,
			}).trim(),
		};
	} catch (error) {
		return { value: null, reason: (error as Error).message.split("\n")[0] };
	}
}

function file(path: string): Probe<string> {
	try {
		return { value: readFileSync(path, "utf8").trim() };
	} catch (error) {
		return { value: null, reason: (error as Error).message.split("\n")[0] };
	}
}

function packageVersion(name: string): string | null {
	const manifest = join(packageRoot, "node_modules", name, "package.json");
	const data = readJson<{ version?: string }>(manifest);
	return data?.version ?? null;
}

/** Versions resolved in pnpm-lock.yaml for the spinetab importer. */
function lockVersions(): Record<string, string> {
	const lock = join(repoRoot, "pnpm-lock.yaml");
	if (!existsSync(lock)) return {};
	const text = readFileSync(lock, "utf8");
	const start = text.indexOf("\n  packages/spinetab:\n");
	if (start < 0) return {};
	const rest = text.slice(start + 1);
	const end = rest.search(/\n {2}\S/);
	const section = end < 0 ? rest : rest.slice(0, end);
	const versions: Record<string, string> = {};
	const pattern =
		/\n {6}'?([^:'\n]+)'?:\n {8}specifier: [^\n]+\n {8}version: ([^\n]+)/g;
	for (const match of section.matchAll(pattern)) {
		// Peer suffixes such as `(graphql@17.0.2)` are dropped.
		versions[match[1] as string] = (match[2] as string)
			.trim()
			.split("(")[0] as string;
	}
	return versions;
}

export function tarballSha256(path: string | undefined): Probe<string> {
	if (!path) return { value: null, reason: "no tarball configured" };
	if (!existsSync(path)) return { value: null, reason: `absent: ${path}` };
	return {
		value: createHash("sha256").update(readFileSync(path)).digest("hex"),
	};
}

/** How `identity` tree hashes are computed: the candidate `distHash`. */
export const DIST_HASH_METHOD =
	"sha256 over sorted relative paths and file contents, each followed by NUL (computeDistHash in tests/package/consumers/prepare.ts)";

export interface TreeHash {
	sha256: string | null;
	files: number | null;
	reason?: string;
}

function listFiles(root: string): string[] {
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

/**
 * Tree hash by the candidate `distHash` method (identity record, pack.json),
 * so a manifest's `packageDist` compares directly with the candidate's
 * `distHash`. An absent tree is `null` with the reason.
 */
export function treeHash(root: string): TreeHash {
	if (!existsSync(root)) {
		return { sha256: null, files: null, reason: `absent: ${root}` };
	}
	const hash = createHash("sha256");
	const files = listFiles(root);
	for (const file of files) {
		hash.update(file);
		hash.update("\0");
		hash.update(readFileSync(join(root, file)));
		hash.update("\0");
	}
	return { sha256: hash.digest("hex"), files: files.length };
}

/** Where the manifest lives and which trees identify the candidate. */
export interface EnvironmentPaths {
	manifest: string;
	/** The package build the harness embeds (`packages/spinetab/dist`). */
	packageDist: string;
	/** The fixture harness the suite loads (`tests/fixtures/harness/dist`). */
	harnessDist: string;
}

export function environmentPaths(): EnvironmentPaths {
	return {
		manifest: join(evidenceDir(), "environment.json"),
		packageDist: join(packageRoot, "dist"),
		harnessDist: join(packageRoot, "tests", "fixtures", "harness", "dist"),
	};
}

/** `identityCheck[<rep>]`: the trees hashed when the repetition started. */
export interface IdentityCheck {
	at: string;
	project: string;
	packageDist: string | null;
	harnessDist: string | null;
}

export interface BrowserEntry {
	name: string;
	version: string;
	headless: boolean;
	commandLine?: string[] | null;
}

/**
 * The run's manifest. `identity` binds it to a candidate: the package
 * and harness dist tree hashes by the candidate `distHash` method, beside the
 * tarball sha256 (`SPINETAB_PERF_TARBALL`, required for pinned eligibility).
 */
export function collectEnvironment(
	paths: Pick<
		EnvironmentPaths,
		"packageDist" | "harnessDist"
	> = environmentPaths(),
): Record<string, unknown> {
	const platform = os.platform();
	const git = run("git", ["-C", repoRoot, "rev-parse", "HEAD"]);
	const dirty = run("git", ["-C", repoRoot, "status", "--porcelain"]);
	const manifest: Record<string, unknown> = {
		schema: 1,
		run: runId(),
		profile: profile(),
		createdAt: new Date().toISOString(),
		os: {
			platform,
			release: os.release(),
			arch: os.arch(),
			cpuModel: os.cpus()[0]?.model ?? null,
			cpuCount: os.cpus().length,
			totalMemory: os.totalmem(),
			loadAverage: os.loadavg(),
		},
		node: process.version,
		pnpm: run("pnpm", ["--version"]),
		playwright: packageVersion("@playwright/test"),
		git: {
			sha: git.value,
			dirty: dirty.value === null ? null : dirty.value.length > 0,
			dirtyFiles:
				dirty.value === null
					? null
					: dirty.value.split("\n").filter(Boolean).length,
		},
		tarball: {
			path: process.env.SPINETAB_PERF_TARBALL ?? null,
			sha256: tarballSha256(process.env.SPINETAB_PERF_TARBALL),
		},
		identity: {
			method: DIST_HASH_METHOD,
			packageDist: { path: paths.packageDist, ...treeHash(paths.packageDist) },
			harnessDist: { path: paths.harnessDist, ...treeHash(paths.harnessDist) },
		},
		versions: lockVersions(),
		browsers: {} as Record<string, BrowserEntry>,
	};
	if (platform === "darwin") {
		manifest.macos = {
			model: run("sysctl", ["-n", "hw.model"]),
			swVers: run("sw_vers", []),
			battery: run("pmset", ["-g", "batt"]),
			lowPowerMode: (() => {
				const settings = run("pmset", ["-g"]);
				if (settings.value === null) return settings;
				const line = settings.value
					.split("\n")
					.find((entry) => entry.includes("lowpowermode"));
				return { value: line?.trim() ?? "absent" };
			})(),
		};
	} else if (platform === "linux") {
		manifest.linux = {
			osRelease: file("/etc/os-release"),
			nproc: run("nproc", []),
			cpuMax: file("/sys/fs/cgroup/cpu.max"),
			memoryMax: file("/sys/fs/cgroup/memory.max"),
			power: "n/a (container)",
		};
	}
	return manifest;
}

function observeHost(): LoadGate["host"] {
	if (os.platform() !== "darwin") return undefined;
	const battery = run("pmset", ["-g", "batt"]);
	const power = run("osascript", [
		"-l",
		"JavaScript",
		"-e",
		'ObjC.import("Foundation"); JSON.stringify({lowPowerMode: $.NSProcessInfo.processInfo.isLowPowerModeEnabled, thermalState: Number($.NSProcessInfo.processInfo.thermalState)});',
	]);
	if (!power.value) return undefined;
	let state: { lowPowerMode: boolean; thermalState: number };
	try {
		state = JSON.parse(power.value);
	} catch {
		return undefined;
	}
	const before = os.cpus();
	const start = performance.now();
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_000);
	const after = os.cpus();
	if (!before.length || before.length !== after.length) return undefined;
	let idle = 0;
	let total = 0;
	for (let i = 0; i < before.length; i++) {
		const a = before[i]?.times;
		const b = after[i]?.times;
		if (!a || !b) return undefined;
		idle += b.idle - a.idle;
		for (const key of ["user", "nice", "sys", "idle", "irq"] as const)
			total += b[key] - a[key];
	}
	return {
		platform: os.platform(),
		acPower: battery.value?.includes("AC Power") ?? false,
		lowPowerMode: state.lowPowerMode,
		thermalState: state.thermalState,
		logicalCpus: after.length,
		cpuSampleMs: performance.now() - start,
		cpuIdlePercent: total > 0 ? (idle / total) * 100 : Number.NaN,
	};
}

/**
 * Write `environment.json` once per run and merge this project's browser.
 * The legacy policy requires load below 2. observed-host-v1 instead records
 * CPU activity and requires eligible Mac power/thermal conditions.
 * SPINETAB_PERF_IGNORE_LOAD is always recorded as diagnostic only. The gate
 * applies once per repetition, at its first test: the benchmark's own load
 * must not abort a repetition midway.
 *
 * At the same point the package and harness dist trees are hashed again
 * (`identityCheck[<rep>]`): a repetition whose trees differ from the
 * run's `identity` is ineligible ("dist changed", lib/eligibility.ts), and a
 * pinned run without a tarball is ineligible; both are warned here and never
 * stop the run.
 */
export function ensureEnvironment(
	browser: BrowserEntry,
	project: string,
	paths: EnvironmentPaths = environmentPaths(),
) {
	const path = paths.manifest;
	const existing = readJson<Record<string, unknown>>(path);
	const manifest = existing ?? collectEnvironment(paths);
	const load = os.loadavg()[0] ?? 0;
	const ignoreLoad = process.env.SPINETAB_PERF_IGNORE_LOAD === "1";
	const gates =
		(manifest.loadGate as Record<string, LoadGate> | undefined) ?? {};
	const repetition = rep();
	const policy = process.env.SPINETAB_PERF_HOST_POLICY ?? "load-v1";
	if (policy !== "load-v1" && policy !== "observed-host-v1")
		throw new Error(`Unknown performance host policy: ${policy}`);
	const host =
		!gates[repetition] && policy === "observed-host-v1"
			? observeHost()
			: undefined;
	// A failed gate sticks for the whole repetition: no partial pinned reps.
	const gate: LoadGate = gates[repetition] ?? {
		passed:
			profile() !== "pinned" ||
			ignoreLoad ||
			(policy === "observed-host-v1" ? !hostProblem(host) : load < LOAD_LIMIT),
		loadAverage: os.loadavg(),
		at: new Date().toISOString(),
		project,
		ignored: ignoreLoad,
		policy,
		...(policy === "observed-host-v1" ? { host } : {}),
	};
	gates[repetition] = gate;
	manifest.loadGate = gates;
	const checks =
		(manifest.identityCheck as Record<string, IdentityCheck> | undefined) ?? {};
	if (!checks[repetition]) {
		const check: IdentityCheck = {
			at: new Date().toISOString(),
			project,
			packageDist: treeHash(paths.packageDist).sha256,
			harnessDist: treeHash(paths.harnessDist).sha256,
		};
		checks[repetition] = check;
		manifest.identityCheck = checks;
		const problem = identityProblem(manifest, repetition);
		if (problem && profile() === "pinned") {
			console.warn(
				`[perf] repetition ${repetition}: ${problem}; its values will be informational only.`,
			);
		}
	}
	manifest.identityCheck = checks;
	const browsers = (manifest.browsers as Record<string, BrowserEntry>) ?? {};
	browsers[project] = browser;
	manifest.browsers = browsers;
	writeJson(path, manifest);
	if (!gate.passed) {
		if (gate.policy === "observed-host-v1")
			throw new Error(
				`Performance host precondition failed: ${hostProblem(gate.host)}`,
			);
		throw new Error(
			`Load average was ${(gate.loadAverage[0] ?? 0).toFixed(2)} (≥ ${LOAD_LIMIT}) when repetition ${repetition} started: pinned repetitions start only on an idle machine. Close other apps and rerun with a new SPINETAB_PERF_REP, or set SPINETAB_PERF_IGNORE_LOAD=1 (recorded).`,
		);
	}
	return manifest;
}
