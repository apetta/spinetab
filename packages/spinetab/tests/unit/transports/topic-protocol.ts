import type { Json } from "../../../src/core/types.ts";
import * as sseRuntime from "../../../src/transports/sse/runtime.ts";
import * as streamRuntime from "../../../src/transports/stream/runtime.ts";
import type { WebSocketProtocol } from "../../../src/transports/websocket/runtime.ts";
import * as websocketRuntime from "../../../src/transports/websocket/runtime.ts";
import { sseAdapter } from "../../fixtures/harness/src/adapters/sse.ts";
import { streamAdapter } from "../../fixtures/harness/src/adapters/stream.ts";
import {
	createTopicProtocol as harnessTopicProtocol,
	websocketAdapter,
} from "../../fixtures/harness/src/adapters/websocket.ts";

/**
 * The `ws` fixture's topic protocol as the harness worker defines it, typed
 * against the real `WebSocketProtocol` so the compiler proves the harness
 * definition is a valid protocol.
 */
export function createTopicProtocol(
	options: Parameters<typeof harnessTopicProtocol>[0] = {},
): WebSocketProtocol<string, unknown, Json, Json> {
	return harnessTopicProtocol(options);
}

/** The harness adapter factories, built against the source runtime modules. */
export function harnessAdapters() {
	return [
		websocketAdapter(websocketRuntime),
		sseAdapter(sseRuntime),
		streamAdapter(streamRuntime),
	];
}
