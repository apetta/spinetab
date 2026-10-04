import { aiSdkAdapter } from "spinetab/ai-sdk/runtime";
import * as sseRuntime from "spinetab/sse/runtime";
import * as streamRuntime from "spinetab/stream/runtime";
import * as websocketRuntime from "spinetab/websocket/runtime";
import { graphqlSseHarnessAdapter } from "./adapters/graphql-sse";
import { graphqlWsHarnessAdapter } from "./adapters/graphql-ws";
import { pollingAdapter } from "./adapters/polling";
import { socketIoHarnessAdapter } from "./adapters/socket-io";
import { sseAdapter } from "./adapters/sse";
import { streamAdapter } from "./adapters/stream";
import { trpcSseHarnessAdapter, trpcWsHarnessAdapter } from "./adapters/trpc";
import { websocketAdapter } from "./adapters/websocket";

// Runtime adapters shared by the harness worker (live.worker.ts) and the lazy
// local runtime (live.local.ts): every slice's adapter, selected explicitly as
// an application's worker entry would.
export const adapters = [
	pollingAdapter,
	websocketAdapter(websocketRuntime),
	sseAdapter(sseRuntime),
	streamAdapter(streamRuntime),
	graphqlWsHarnessAdapter,
	graphqlSseHarnessAdapter,
	socketIoHarnessAdapter,
	trpcWsHarnessAdapter,
	trpcSseHarnessAdapter,
	aiSdkAdapter(),
];
