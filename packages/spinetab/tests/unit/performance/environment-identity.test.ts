import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computeDistHash } from "../../package/consumers/prepare.ts";
import { evaluateRun } from "../../performance/aggregate.ts";
import { repEligibility } from "../../performance/lib/eligibility.ts";
import {
	collectEnvironment,
	DIST_HASH_METHOD,
	ensureEnvironment,
	treeHash,
} from "../../performance/lib/environment.ts";
import type { RawRecord } from "../../performance/lib/evidence.ts";
import type { BudgetRow } from "../../performance/lib/stats.ts";

// the performance manifest must identify the candidate it
// measured. collectEnvironment records the package and harness dist tree
// hashes (the candidate `distHash` method) and the tarball sha256; the pinned
// profile needs a tarball or its repetitions are ineligible; ensureEnvironment
// re-hashes both trees at each repetition start and a mismatch makes that
// repetition ineligible ("dist changed"); aggregate.ts reports the identity.

const packageDir = fileURLToPath(new URL("../../../", import.meta.url));
const HEX = /^[0-9a-f]{64}$/;

const dirs: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
	const dir = mkdtempSync(join(tmpdir(), "spinetab-perf-identity-"));
	dirs.push(dir);
	return dir;
}

function tree(root: string, files: Record<string, string>): string {
	for (const [file, text] of Object.entries(files)) {
		mkdirSync(join(root, file, ".."), { recursive: true });
		writeFileSync(join(root, file), text);
	}
	return root;
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

describe("tree hash", () => {
	it("is the candidate distHash method (computeDistHash) on any tree", () => {
		const root = tree(join(temp(), "dist"), {
			"index.js": "a",
			"sub/runtime.js": "b",
			"sub/z.d.ts": "c",
		});
		expect(treeHash(root)).toEqual({
			sha256: computeDistHash(root),
			files: 3,
		});
		expect(DIST_HASH_METHOD).toContain("computeDistHash");
	});

	it("matches the frozen package dist's candidate distHash", () => {
		const dist = join(packageDir, "dist");
		const hash = treeHash(dist);
		expect(hash.sha256).toMatch(HEX);
		expect(hash.sha256).toBe(computeDistHash(dist));
	});

	it("records an absent tree as null with a reason", () => {
		const missing = join(temp(), "nowhere");
		expect(treeHash(missing)).toEqual({
			sha256: null,
			files: null,
			reason: `absent: ${missing}`,
		});
	});
});

describe("collectEnvironment and ensureEnvironment", () => {
	const browser = { name: "chromium", version: "1", headless: true };

	function setup() {
		const root = temp();
		const paths = {
			manifest: join(root, "run", "environment.json"),
			packageDist: tree(join(root, "package-dist"), { "index.js": "one" }),
			harnessDist: tree(join(root, "harness-dist"), { "bench.html": "h" }),
		};
		const tarball = join(root, "spinetab-0.0.0.tgz");
		writeFileSync(tarball, "tarball bytes");
		vi.stubEnv("SPINETAB_PERF_PROFILE", "pinned");
		vi.stubEnv("SPINETAB_PERF_IGNORE_LOAD", "1");
		vi.stubEnv("SPINETAB_PERF_TARBALL", tarball);
		return { paths, tarball };
	}

	interface Manifest {
		identity: { packageDist: { sha256: string } };
		identityCheck: Record<
			string,
			{
				project: string;
				packageDist: string | null;
				harnessDist: string | null;
			}
		>;
		[key: string]: unknown;
	}
	const read = (path: string) =>
		JSON.parse(readFileSync(path, "utf8")) as Manifest;

	it("records the package and harness dist hashes and the tarball sha256", () => {
		const { paths, tarball } = setup();
		const manifest = collectEnvironment(paths);
		expect(manifest.identity).toEqual({
			method: DIST_HASH_METHOD,
			packageDist: {
				path: paths.packageDist,
				sha256: computeDistHash(paths.packageDist),
				files: 1,
			},
			harnessDist: {
				path: paths.harnessDist,
				sha256: computeDistHash(paths.harnessDist),
				files: 1,
			},
		});
		expect(manifest.tarball).toEqual({
			path: tarball,
			sha256: { value: sha("tarball bytes") },
		});
	}, 30_000);

	it("re-hashes at each repetition start and records the change", () => {
		const { paths } = setup();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.stubEnv("SPINETAB_PERF_REP", "01");
		ensureEnvironment(browser, "chromium-perf", paths);
		const first = computeDistHash(paths.packageDist);
		writeFileSync(join(paths.packageDist, "index.js"), "two");
		// Same repetition: the check made at its start stands.
		ensureEnvironment(browser, "chromium-perf", paths);
		vi.stubEnv("SPINETAB_PERF_REP", "02");
		ensureEnvironment(browser, "chromium-perf", paths);
		const manifest = read(paths.manifest);
		expect(manifest.identity.packageDist.sha256).toBe(first);
		expect(manifest.identityCheck["01"]).toMatchObject({
			project: "chromium-perf",
			packageDist: first,
			harnessDist: computeDistHash(paths.harnessDist),
		});
		expect(manifest.identityCheck["02"]).toMatchObject({
			packageDist: computeDistHash(paths.packageDist),
			harnessDist: computeDistHash(paths.harnessDist),
		});
		expect(manifest.identityCheck["02"]?.packageDist).not.toBe(first);
		expect(warn).toHaveBeenCalledWith(
			expect.stringMatching(/repetition 02: dist changed/),
		);
		// With passed load gates, 01 counts and 02 does not.
		const passed = {
			passed: true,
			ignored: false,
			loadAverage: [1, 1, 1],
			project: "chromium-perf",
			at: "2026-09-30T00:00:00.000Z",
		};
		const environment = {
			...manifest,
			loadGate: { "01": passed, "02": passed },
		};
		expect(repEligibility(environment, "01").eligible).toBe(true);
		expect(repEligibility(environment, "02")).toEqual({
			eligible: false,
			reason: expect.stringMatching(
				/^ineligible: dist changed since the run's identity was recorded \(package dist [0-9a-f]{12} → [0-9a-f]{12}\)$/,
			),
		});
	}, 30_000);
});

const PACKAGE = "a".repeat(64);
const HARNESS = "b".repeat(64);
const passedGate = {
	passed: true,
	ignored: false,
	loadAverage: [1, 1, 1],
	project: "chromium-perf",
	at: "2026-09-30T00:00:00.000Z",
};

function pinned(
	reps: string[],
	overrides: Record<string, unknown> = {},
	check: (rep: string) => unknown = () => ({
		at: "2026-09-30T00:00:00.000Z",
		project: "chromium-perf",
		packageDist: PACKAGE,
		harnessDist: HARNESS,
	}),
) {
	return {
		schema: 1,
		profile: "pinned",
		tarball: {
			path: "/t/spinetab-0.0.0.tgz",
			sha256: { value: "c".repeat(64) },
		},
		identity: {
			method: DIST_HASH_METHOD,
			packageDist: { path: "/p/dist", sha256: PACKAGE, files: 313 },
			harnessDist: { path: "/h/dist", sha256: HARNESS, files: 42 },
		},
		loadGate: Object.fromEntries(reps.map((rep) => [rep, passedGate])),
		identityCheck: Object.fromEntries(reps.map((rep) => [rep, check(rep)])),
		...overrides,
	};
}

describe("pinned eligibility needs the candidate identity", () => {
	it("accepts a rep with a tarball, both dist hashes and a matching check", () => {
		expect(repEligibility(pinned(["01"]), "01").eligible).toBe(true);
	});

	it.each([
		[
			"no tarball configured",
			{
				tarball: {
					path: null,
					sha256: { value: null, reason: "no tarball configured" },
				},
			},
			/^ineligible: no candidate tarball recorded \(the pinned profile needs SPINETAB_PERF_TARBALL\)$/,
		],
		[
			"absent tarball",
			{
				tarball: {
					path: "/x.tgz",
					sha256: { value: null, reason: "absent: /x.tgz" },
				},
			},
			/no candidate tarball recorded/,
		],
		[
			"no tarball field",
			{ tarball: undefined },
			/no candidate tarball recorded/,
		],
		[
			"no identity",
			{ identity: undefined },
			/^ineligible: no dist identity recorded \(package and harness dist hashes\)$/,
		],
		[
			"harness dist not hashed",
			{
				identity: {
					method: DIST_HASH_METHOD,
					packageDist: { path: "/p", sha256: PACKAGE, files: 1 },
					harnessDist: {
						path: "/h",
						sha256: null,
						files: null,
						reason: "absent: /h",
					},
				},
			},
			/no dist identity recorded/,
		],
		[
			"no check for the rep",
			{ identityCheck: {} },
			/^ineligible: no dist identity check for rep 01$/,
		],
	])("%s: ineligible", (_label, overrides, reason) => {
		const verdict = repEligibility(pinned(["01"], overrides), "01");
		expect(verdict.eligible).toBe(false);
		expect(verdict.eligible ? "" : verdict.reason).toMatch(reason);
	});

	it("names each tree that changed", () => {
		const changed = pinned(["01"], {}, () => ({
			at: "2026-09-30T00:00:00.000Z",
			project: "chromium-perf",
			packageDist: "d".repeat(64),
			harnessDist: "e".repeat(64),
		}));
		expect(repEligibility(changed, "01")).toEqual({
			eligible: false,
			reason:
				"ineligible: dist changed since the run's identity was recorded (package dist aaaaaaaaaaaa → dddddddddddd; harness dist bbbbbbbbbbbb → eeeeeeeeeeee)",
		});
		const unhashed = pinned(["01"], {}, () => ({
			at: "2026-09-30T00:00:00.000Z",
			project: "chromium-perf",
			packageDist: PACKAGE,
			harnessDist: null,
		}));
		expect(repEligibility(unhashed, "01")).toEqual({
			eligible: false,
			reason:
				"ineligible: dist changed since the run's identity was recorded (harness dist bbbbbbbbbbbb → none)",
		});
	});

	it("keeps the load gate reasons first", () => {
		const ignored = pinned(["01"], {
			tarball: undefined,
			loadGate: { "01": { ...passedGate, ignored: true } },
		});
		const verdict = repEligibility(ignored, "01");
		expect(verdict.eligible ? "" : verdict.reason).toMatch(/load gate ignored/);
	});
});

describe("aggregate reports the identity", () => {
	const row: BudgetRow = {
		id: "env.pinned-runs",
		behaviour: "memory-overhead",
		owner: "performance",
		unit: "count",
		comparator: ">=",
		target: 10,
		targetState: "provisional",
		reason: "",
		evidence: "",
		kind: "structural",
	};
	const record = (rep: string): RawRecord => ({
		schema: 1,
		run: "SYNTHETIC",
		rep,
		profile: "pinned",
		project: "chromium-perf",
		scenario: "tabs",
		config: "spinetab-ws-n1",
		writtenAt: `2026-09-30T00:00:${rep}.000Z`,
		metrics: {},
		detail: { synthetic: true },
	});

	it("excludes a changed rep and lists the hashes and per-rep verdicts", () => {
		const environment = pinned(["01", "02"], {}, (rep) => ({
			at: "2026-09-30T00:00:00.000Z",
			project: "chromium-perf",
			packageDist: rep === "02" ? "d".repeat(64) : PACKAGE,
			harnessDist: HARNESS,
		}));
		const run = evaluateRun({
			records: [record("01"), record("02")],
			environment,
			rows: [row],
		});
		expect(run.pinnedReps).toEqual(["01"]);
		expect(run.identity).toEqual({
			method: DIST_HASH_METHOD,
			tarball: { path: "/t/spinetab-0.0.0.tgz", sha256: "c".repeat(64) },
			packageDist: PACKAGE,
			harnessDist: HARNESS,
			reps: {
				"01": { packageDist: PACKAGE, harnessDist: HARNESS, matches: true },
				"02": {
					packageDist: "d".repeat(64),
					harnessDist: HARNESS,
					matches: false,
				},
			},
		});
		expect(run.eligibility.reps.ineligible).toEqual([
			{
				rep: "02",
				reason:
					"ineligible: dist changed since the run's identity was recorded (package dist aaaaaaaaaaaa → dddddddddddd)",
			},
		]);
	});

	it("reports an unidentified run as such", () => {
		const run = evaluateRun({
			records: [record("01")],
			environment: { schema: 1, profile: "pinned" },
			rows: [row],
		});
		expect(run.identity).toEqual({
			method: null,
			tarball: { path: null, sha256: null },
			packageDist: null,
			harnessDist: null,
			reps: {},
		});
	});
});
