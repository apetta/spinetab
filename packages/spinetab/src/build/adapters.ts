// Generated imports and factory names must come from this closed table.

export type SpinetabAdapterName =
	| "polling"
	| "sse"
	| "stream"
	| "websocket"
	| "graphql-ws"
	| "graphql-sse"
	| "socket-io"
	| "trpc-ws"
	| "trpc-sse"
	| "ai-sdk";

export interface AdapterRow {
	/** Page entry suffix, e.g. "polling" for `spinetab/polling`. */
	entry: string;
	kinds: readonly SpinetabAdapterName[];
	/** Runtime specifier, e.g. "spinetab/polling/runtime". */
	runtime: string;
	/** Factory export per kind, e.g. { polling: "pollingAdapter" }. */
	factories: Readonly<Partial<Record<SpinetabAdapterName, string>>>;
	/** Optional peer the runtime entry imports, e.g. "graphql-ws". */
	peer?: string;
	/** tRPC only: named page imports that select a kind. */
	namedImports?: Readonly<Partial<Record<SpinetabAdapterName, string>>>;
}

export const ADAPTER_TABLE: readonly AdapterRow[] = [
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

export const ADAPTER_NAMES: readonly SpinetabAdapterName[] =
	ADAPTER_TABLE.flatMap((row) => row.kinds).sort(compareText);

export function rowOfKind(kind: SpinetabAdapterName): AdapterRow {
	const row = ADAPTER_TABLE.find((candidate) => candidate.kinds.includes(kind));
	if (!row) throw new Error(`spinetab: no adapter table row for ${kind}.`);
	return row;
}

export function rowOfEntry(entry: string): AdapterRow | undefined {
	return ADAPTER_TABLE.find((row) => row.entry === entry);
}

export function isAdapterName(value: unknown): value is SpinetabAdapterName {
	return (
		typeof value === "string" &&
		(ADAPTER_NAMES as readonly string[]).includes(value)
	);
}

/** Code-unit order, identical on every machine and locale. */
export function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
