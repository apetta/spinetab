import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { ENTRY_RULES } from "./allowlist.ts";
import { packageRoot, readManifest } from "./dist.ts";

/** Check source table entries against built exports so generated workers cannot name missing imports or factories. */
interface AdapterRow {
	entry: string;
	kinds: readonly string[];
	runtime: string;
	factories: Readonly<Record<string, string>>;
	peer?: string;
	namedImports?: Readonly<Record<string, string>>;
}
interface AdapterTable {
	ADAPTER_TABLE: readonly AdapterRow[];
	ADAPTER_NAMES: readonly string[];
}

// Public adapter inventory, independent of the table used to generate workers.
const EXPECTED: AdapterRow[] = [
	{
		entry: "websocket",
		kinds: ["websocket"],
		runtime: "spinetab/websocket/runtime",
		factories: { websocket: "websocketAdapter" },
	},
	{
		entry: "sse",
		kinds: ["sse"],
		runtime: "spinetab/sse/runtime",
		factories: { sse: "sseAdapter" },
	},
	{
		entry: "stream",
		kinds: ["stream"],
		runtime: "spinetab/stream/runtime",
		factories: { stream: "streamAdapter" },
	},
	{
		entry: "polling",
		kinds: ["polling"],
		runtime: "spinetab/polling/runtime",
		factories: { polling: "pollingAdapter" },
	},
	{
		entry: "graphql-ws",
		kinds: ["graphql-ws"],
		runtime: "spinetab/graphql-ws/runtime",
		factories: { "graphql-ws": "graphqlWsAdapter" },
		peer: "graphql-ws",
	},
	{
		entry: "graphql-sse",
		kinds: ["graphql-sse"],
		runtime: "spinetab/graphql-sse/runtime",
		factories: { "graphql-sse": "graphqlSseAdapter" },
		peer: "graphql-sse",
	},
	{
		entry: "socket-io",
		kinds: ["socket-io"],
		runtime: "spinetab/socket-io/runtime",
		factories: { "socket-io": "socketIoAdapter" },
		peer: "socket.io-client",
	},
	{
		entry: "trpc",
		kinds: ["trpc-ws", "trpc-sse"],
		runtime: "spinetab/trpc/runtime",
		factories: { "trpc-ws": "trpcWsAdapter", "trpc-sse": "trpcSseAdapter" },
		peer: "@trpc/client",
		namedImports: {
			"trpc-ws": "spinetabWsLink",
			"trpc-sse": "spinetabSseLink",
		},
	},
	{
		entry: "ai-sdk",
		kinds: ["ai-sdk"],
		runtime: "spinetab/ai-sdk/runtime",
		factories: { "ai-sdk": "aiSdkAdapter" },
	},
];
const manifest = readManifest();
const tableSource = join(packageRoot, "src/build/adapters.ts");
const subpathOf = (specifier: string) =>
	`./${specifier.slice("spinetab/".length)}`;
const exportsOf = async (subpath: string) => {
	const target = manifest.exports[subpath]?.import.default;
	if (!target) throw new Error(`${subpath} is not exported`);
	return (await import(
		new URL(target, pathToFileURL(packageRoot)).href
	)) as Record<string, unknown>;
};
const loadTable = async () =>
	(await import(pathToFileURL(tableSource).href)) as AdapterTable;
/** Plain copies, so frozen arrays and absent keys compare by value. */
const plain = (rows: readonly AdapterRow[]) =>
	JSON.parse(JSON.stringify(rows)) as AdapterRow[];

describe("against the built runtime entries", () => {
	// Derive this check independently of the build adapter table so matching mistakes cannot pass.
	for (const row of EXPECTED) {
		it(`${row.runtime} exports ${Object.values(row.factories).join(", ")}`, async () => {
			const subpath = subpathOf(row.runtime);
			expect(ENTRY_RULES[subpath]?.realm).toBe("runtime");
			const runtime = await exportsOf(subpath);
			const types = readFileSync(
				new URL(
					manifest.exports[subpath]?.import.types ?? "",
					pathToFileURL(packageRoot),
				),
				"utf8",
			);
			for (const factory of Object.values(row.factories)) {
				expect(typeof runtime[factory], factory).toBe("function");
				expect(types, `${factory} declaration`).toMatch(
					new RegExp(`\\b${factory}\\b`),
				);
			}
		});
	}

	it("covers every exported runtime adapter entry, and only those", () => {
		const adapterRuntimes = Object.keys(manifest.exports)
			.filter((subpath) => /^\.\/[^/]+\/runtime$/.test(subpath))
			.sort();
		expect(EXPECTED.map((row) => subpathOf(row.runtime)).sort()).toEqual(
			adapterRuntimes,
		);
	});

	it("pairs every row with a dual page entry and names its peer as the runtime rule does", () => {
		for (const row of EXPECTED) {
			const page = `./${row.entry}`;
			expect(ENTRY_RULES[page]?.realm, page).toBe("page");
			expect(manifest.exports[page]?.require, page).toBeDefined();
			const runtimePeers = ENTRY_RULES[subpathOf(row.runtime)]?.jsPeers ?? [];
			if (row.peer) {
				expect(runtimePeers, row.runtime).toContain(row.peer);
				expect(manifest.peerDependencies?.[row.peer], row.peer).toBeDefined();
				expect(manifest.peerDependenciesMeta?.[row.peer]?.optional).toBe(true);
			} else {
				expect(runtimePeers, row.runtime).toEqual([]);
			}
		}
	});

	it("selects tRPC kinds by the page entry's named link exports", async () => {
		const trpc = await exportsOf("./trpc");
		expect(typeof trpc.spinetabWsLink).toBe("function");
		expect(typeof trpc.spinetabSseLink).toBe("function");
	});
});

describe("src/build/adapters.ts matches (build owner's table)", () => {
	it("names exactly the ten adapters, each once", async () => {
		const { ADAPTER_NAMES } = await loadTable();
		expect(ADAPTER_NAMES).toEqual(EXPECTED.flatMap((row) => row.kinds).sort());
	});

	it("holds exactly the rows", async () => {
		const { ADAPTER_TABLE } = await loadTable();
		const byEntry = (rows: AdapterRow[]) =>
			[...rows].sort((a, b) => a.entry.localeCompare(b.entry));
		expect(byEntry(plain(ADAPTER_TABLE))).toEqual(byEntry(plain(EXPECTED)));
	});
});
