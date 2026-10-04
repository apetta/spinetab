// Module-worker realm: peers first, then spies, then every Spinetab entry
// (static imports evaluate in this order). Reports one aggregate snapshot.
import "./peers.js";
import * as root from "spinetab";
import * as aiSdk from "spinetab/ai-sdk";
import * as aiSdkRuntime from "spinetab/ai-sdk/runtime";
import * as apollo from "spinetab/apollo";
import * as graphqlSse from "spinetab/graphql-sse";
import * as graphqlSseRuntime from "spinetab/graphql-sse/runtime";
import * as graphqlWs from "spinetab/graphql-ws";
import * as graphqlWsRuntime from "spinetab/graphql-ws/runtime";
import * as polling from "spinetab/polling";
import * as pollingRuntime from "spinetab/polling/runtime";
import * as react from "spinetab/react";
import * as runtime from "spinetab/runtime";
import * as socketIo from "spinetab/socket-io";
import * as socketIoRuntime from "spinetab/socket-io/runtime";
import * as solid from "spinetab/solid";
import * as sse from "spinetab/sse";
import * as sseRuntime from "spinetab/sse/runtime";
import * as stream from "spinetab/stream";
import * as streamRuntime from "spinetab/stream/runtime";
import * as svelte from "spinetab/svelte";
import * as swr from "spinetab/swr";
import * as tanstackQuery from "spinetab/tanstack-query";
import * as trpc from "spinetab/trpc";
import * as trpcRuntime from "spinetab/trpc/runtime";
import * as vue from "spinetab/vue";
import * as websocket from "spinetab/websocket";
import * as websocketRuntime from "spinetab/websocket/runtime";
import * as worker from "spinetab/worker";
import { probeDefineWorker } from "./define-worker.js";
import { snapshot } from "./spies.js";

const result = snapshot();
const defineWorkerCall = probeDefineWorker(worker.defineWorker, snapshot);
const entries = {
	root,
	aiSdk,
	aiSdkRuntime,
	apollo,
	graphqlSse,
	graphqlSseRuntime,
	graphqlWs,
	graphqlWsRuntime,
	polling,
	pollingRuntime,
	react,
	runtime,
	socketIo,
	socketIoRuntime,
	solid,
	sse,
	sseRuntime,
	stream,
	streamRuntime,
	svelte,
	swr,
	tanstackQuery,
	trpc,
	trpcRuntime,
	vue,
	websocket,
	websocketRuntime,
	worker,
};
self.postMessage({
	realm: "worker",
	...result,
	onconnect: typeof self.onconnect,
	defineWorker: defineWorkerCall,
	exports: Object.fromEntries(
		Object.entries(entries).map(([name, module]) => [
			name,
			Object.keys(module).length,
		]),
	),
});
