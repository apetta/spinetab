import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { decode } from "@jridgewell/sourcemap-codec";
import { expect } from "vitest";
import { stubCopyEvidence } from "../package/consumers/generated.ts";
import { computeDistHash, listFiles } from "../package/consumers/prepare.ts";
import { childEnv, run } from "../package/consumers/run.ts";
import { packageRoot, readManifest, specifierOf } from "../package/dist.ts";

export const peers = Object.keys(readManifest().peerDependencies ?? {});
export const peerPattern = new RegExp(
	`^(?:${peers.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?:/|$)`,
);
const pageEntries = Object.entries(readManifest().exports)
	.filter(([, target]) => /^\.\/dist\/[^/]+\.js$/.test(target.import.default))
	.map(([entry]) => specifierOf(entry));

export const baseline = 'globalThis.keep = "tree-shaking-witness";';
export const unused = `${pageEntries.map((entry, i) => `import * as unused${i} from ${JSON.stringify(entry)};`).join("\n")}\n${pageEntries.map((entry) => `import ${JSON.stringify(entry)};`).join("\n")}\n${baseline}`;

export const probes = {
	errorGuard: {
		source:
			'import { isSpinetabError } from "spinetab"; globalThis.keep = isSpinetabError;',
		check:
			'keep({ name: "SpinetabError", code: "invalid-endpoint" }, "invalid-endpoint")',
		result: true,
		forbidden: [
			"Object.freeze",
			"This Spinetab client has been disposed",
			"adapter-not-registered",
		],
	},
	error: {
		source:
			'import { SpinetabError } from "spinetab"; globalThis.keep = SpinetabError;',
		check: 'new keep("invalid-endpoint", "test").toJSON()',
		result: { code: "invalid-endpoint", message: "test" },
		forbidden: [
			"Object.freeze",
			"This Spinetab client has been disposed",
			"adapter-not-registered",
		],
	},
	latest: {
		source:
			'import { reconcileLatest } from "spinetab"; globalThis.keep = reconcileLatest;',
		check:
			'(() => { const h = keep({ status: { get: () => ({ active: true, connection: { state: "connected" }, continuity: { state: "continuous" } }), subscribe: () => () => {} }, markReconciled() {} }); h.onEvent(); h.stop(); return typeof h.onEvent; })()',
		result: "function",
		forbidden: [
			"Object.freeze",
			"AbortController",
			"This Spinetab client has been disposed",
		],
	},
	refresh: {
		source:
			'import { reconcileOnLoss } from "spinetab"; globalThis.keep = reconcileOnLoss;',
		check:
			'(() => { const stop = keep({ status: { get: () => ({ active: true, connection: { state: "connected" }, continuity: { state: "continuous" } }), subscribe: () => () => {} }, markReconciled() {} }, () => {}); stop(); return typeof stop; })()',
		result: "function",
		forbidden: [
			"Object.freeze",
			"This Spinetab client has been disposed",
			"onEvent",
		],
	},
	aiError: {
		source:
			'import { SpinetabInterruptedError } from "spinetab/ai-sdk"; globalThis.keep = SpinetabInterruptedError;',
		check: 'new keep("stream-interrupted").detail.reason',
		result: "stream-interrupted",
		forbidden: [
			"sendMessages",
			"WeakMap",
			"new Set",
			"This Spinetab client has been disposed",
		],
	},
	summary: {
		source:
			'import { summariseStatus } from "spinetab"; globalThis.keep = summariseStatus;',
		check:
			'keep({ active: true, connection: { state: "connected" }, continuity: { state: "gap" } })',
		result: { phase: "live", needsReconcile: true },
		forbidden: [
			"Object.freeze",
			"This Spinetab client has been disposed",
			"Endpoint must",
		],
	},
	endpoint: {
		source:
			'import { resolveEndpoint } from "spinetab"; globalThis.keep = resolveEndpoint;',
		check: 'keep("/feed", "https://example.com/base")',
		result: "https://example.com/feed",
		forbidden: [
			"Object.freeze",
			"This Spinetab client has been disposed",
			"needsReconcile",
		],
	},
	status: {
		source:
			'import { SERVER_STATUS, INACTIVE_STATUS, createSpinetab } from "spinetab"; globalThis.keep = () => { const c = createSpinetab({ anonymous: true }); const sub = c.subscribe({ adapter: "polling", connection: {}, subscription: {} }, () => {}); const s = sub.status.get(); const result = [Object.isFrozen(SERVER_STATUS), Object.isFrozen(INACTIVE_STATUS), Object.isFrozen(s), Object.isFrozen(s.connection), Object.isFrozen(s.continuity), c.status.get() === SERVER_STATUS]; sub.unsubscribe(); c.dispose(); return result; };',
		check: "keep()",
		result: [true, true, true, true, true, true],
		forbidden: [],
	},
	polling: {
		source:
			'import { pollEvery } from "spinetab/polling"; globalThis.keep = pollEvery;',
		check: "keep(2000)",
		result: { consumer: { intervalMs: 2000 } },
		forbidden: [
			"polling.url",
			"This Spinetab client has been disposed",
			"fetch(",
		],
	},
} as const;

export async function fixture(label: string): Promise<string> {
	const root = realpathSync(
		mkdtempSync(join(tmpdir(), `spinetab-tree-shaking-${label}-`)),
	);
	const pack = join(root, "pack");
	mkdirSync(pack);
	const before = computeDistHash();
	const packed = await run("pnpm", ["pack", "--pack-destination", pack], {
		cwd: packageRoot,
		logFile: join(pack, "pack.log"),
		timeoutMs: 120_000,
	});
	expect(packed.code, packed.output).toBe(0);
	const archives = readdirSync(pack).filter((name) => name.endsWith(".tgz"));
	expect(archives).toHaveLength(1);
	const archive = join(pack, archives[0] as string);
	const installed = join(root, "node_modules/spinetab");
	mkdirSync(installed, { recursive: true });
	execFileSync("tar", [
		"-xzf",
		archive,
		"--strip-components=1",
		"-C",
		installed,
	]);
	expect(computeDistHash(join(installed, "dist"))).toBe(before);
	expect(computeDistHash()).toBe(before);
	writeFileSync(
		join(root, "candidate.json"),
		JSON.stringify({
			label,
			distHash: before,
			sourceHash: computeDistHash(join(packageRoot, "src")),
			node: process.version,
			createdAt: new Date().toISOString(),
			sha256: createHash("sha256").update(readFileSync(archive)).digest("hex"),
		}),
	);
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({
			name: "tree-shaking-consumer",
			private: true,
			type: "module",
			sideEffects: false,
		}),
	);
	return root;
}

export function assertFresh(root: string): void {
	const record = JSON.parse(readFileSync(join(root, "candidate.json"), "utf8"));
	const evidence = join(packageRoot, "test-results/tree-shaking", record.label);
	mkdirSync(evidence, { recursive: true });
	for (const name of readdirSync(root).filter(
		(name) => name === "candidate.json" || name.endsWith(".log"),
	))
		cpSync(join(root, name), join(evidence, name));
	expect(computeDistHash()).toBe(record.distHash);
	expect(computeDistHash(join(packageRoot, "src"))).toBe(record.sourceHash);
	expect(computeDistHash(join(root, "node_modules/spinetab/dist"))).toBe(
		record.distHash,
	);
}

interface SourceMap {
	sources: string[];
	sourcesContent?: Array<string | null>;
	mappings: string;
	sections?: Array<{
		offset: { line: number; column: number };
		map: SourceMap;
	}>;
}

// `sourcesContent` can include code removed from the bundle.
export function packageText(
	code: string,
	map: SourceMap,
	lineOffset = 0,
	columnOffset = 0,
	end?: { line: number; column: number },
): string {
	if (map.sections)
		return map.sections
			.map((section, index) =>
				packageText(
					code,
					section.map,
					lineOffset + section.offset.line,
					section.offset.column +
						(section.offset.line === 0 ? columnOffset : 0),
					map.sections?.[index + 1]
						? {
								line: lineOffset + (map.sections[index + 1]?.offset.line ?? 0),
								column:
									(map.sections[index + 1]?.offset.column ?? 0) +
									(map.sections[index + 1]?.offset.line === 0
										? columnOffset
										: 0),
							}
						: end,
				),
			)
			.join("");
	const lines = code.split("\n");
	return decode(map.mappings)
		.flatMap((segments, line) => {
			const absoluteLine = line + lineOffset;
			if (end && absoluteLine > end.line) return [];
			const text =
				end && absoluteLine === end.line
					? (lines[absoluteLine] ?? "").slice(0, end.column)
					: (lines[absoluteLine] ?? "");
			const offset = line === 0 ? columnOffset : 0;
			return segments.flatMap((segment, i) => {
				if (segment.length < 4) return [];
				const source = map.sources[segment[1] as number] ?? "";
				if (
					!/spinetab\/(?:dist|src)\/|\/src\/(?:core|transports|protocols|integrations|bindings)\//.test(
						source,
					)
				)
					return [];
				return text.slice(
					segment[0] + offset,
					(segments[i + 1]?.[0] ?? text.length - offset) + offset,
				);
			});
		})
		.join("");
}

export function browserPackageText(dir: string, installedDist: string): string {
	return listFiles(dir)
		.filter((file) => file.endsWith(".js"))
		.map((file) => {
			const path = join(dir, file);
			const code = readFileSync(path, "utf8");
			if (stubCopyEvidence(`static/${file}`, Buffer.from(code), installedDist))
				return "";
			const reference = /\/\/# sourceMappingURL=([^\s]+)\s*$/.exec(code)?.[1];
			if (!reference) return "";
			return packageText(
				code,
				JSON.parse(readFileSync(join(dirname(path), reference), "utf8")),
			);
		})
		.join("\n");
}
export { childEnv, packageRoot, run };
