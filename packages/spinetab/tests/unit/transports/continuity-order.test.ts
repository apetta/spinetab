import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	ConnectionContext,
	SubscriptionSink,
} from "../../../src/core/adapter.ts";
import {
	type SseConnectionSpec,
	sseAdapter,
} from "../../../src/transports/sse/runtime.ts";
import {
	ndjsonParser,
	type StreamConnectionSpec,
	streamAdapter,
} from "../../../src/transports/stream/runtime.ts";
import {
	type WebSocketConnectionSpec,
	websocketAdapter,
} from "../../../src/transports/websocket/runtime.ts";
import {
	eventStream,
	FakeEventSource,
	FakeWebSocket,
	fakeContext,
	flush,
	type ScriptedBody,
	type ScriptedRequest,
	scriptedBody,
	scriptedFetch,
} from "./helpers.ts";
import { createTopicProtocol } from "./topic-protocol.ts";

// Report detection before reconnecting and the outcome before connected; a deliberate reopen has only the outcome.

const OPTIONS = { key: "k", repeatable: true } as const;

let dispose: Array<() => void> = [];

beforeEach(() => {
	FakeWebSocket.reset();
	vi.stubGlobal("WebSocket", FakeWebSocket);
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	// Backoff delays are then half their ceiling: 500 ms, 1 s, 2 s, …
	vi.spyOn(Math, "random").mockReturnValue(0.5);
});

afterEach(() => {
	for (const release of dispose) release();
	dispose = [];
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

/** One ordered log of connection statuses and continuity notices. */
function orderedLog() {
	const log: string[] = [];
	const fake = fakeContext();
	const ctx: ConnectionContext = {
		...fake.ctx,
		setStatus(status) {
			log.push(`status:${status.state}`);
			fake.ctx.setStatus(status);
		},
	};
	const sink: SubscriptionSink<unknown> = {
		next() {},
		error(error) {
			log.push(`error:${error.code}`);
		},
		complete() {
			log.push("complete");
		},
		continuity(reason) {
			log.push(`continuity:${reason}`);
		},
		started() {},
	};
	/** Repeated statuses collapse; every continuity notice stays visible. */
	const transitions = () =>
		log.filter(
			(entry, index) =>
				!entry.startsWith("status:") || entry !== log[index - 1],
		);
	return { ctx, sink, transitions };
}

const TWO_INTERRUPTIONS = [
	"status:connecting",
	"status:connected",
	"continuity:reconnected",
	"status:reconnecting",
	"continuity:reconnected",
	"status:connected",
	"continuity:reconnected",
	"status:reconnecting",
	"continuity:reconnected",
	"status:connected",
];

/** A deliberate reopen: one notice, immediately before the new `connected`. */
const ONE_REOPEN = [
	"status:connecting",
	"status:connected",
	"status:connecting",
	"continuity:reopened",
	"status:connected",
];

describe("websocket: continuity before status", () => {
	function connect(spec: Partial<WebSocketConnectionSpec> = {}) {
		const context = orderedLog();
		const protocol = createTopicProtocol({
			heartbeat: { expectInboundWithinMs: 5_000 },
		});
		const connection = websocketAdapter({
			protocols: { topics: protocol },
		}).connect(
			{ url: "wss://api.test/ws", protocol: "topics", ...spec },
			context.ctx,
		);
		dispose.push(() => connection.dispose());
		connection.subscribe({}, context.sink, OPTIONS);
		return context;
	}

	it("reports the early notice before reconnecting and the outcome before connected, per unplanned close or liveness loss", async () => {
		const { transitions } = connect();
		await flush();
		FakeWebSocket.last().serverOpen();

		// Unplanned close; the first retry fails before it opens.
		FakeWebSocket.last().serverClose(1006);
		await vi.advanceTimersByTimeAsync(500);
		expect(FakeWebSocket.instances).toHaveLength(2);
		FakeWebSocket.last().serverClose(1006);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(FakeWebSocket.instances).toHaveLength(3);
		FakeWebSocket.last().serverOpen();

		// Liveness loss: nothing inbound within 5 s.
		await vi.advanceTimersByTimeAsync(5_000);
		expect(FakeWebSocket.instances[2]?.closedWith?.code).toBe(4000);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(FakeWebSocket.instances).toHaveLength(4);
		FakeWebSocket.last().serverOpen();

		expect(transitions()).toEqual(TWO_INTERRUPTIONS);
	});

	it("reports a deliberate reopen once, before the replacement socket connects", async () => {
		const context = orderedLog();
		const connection = websocketAdapter().connect(
			{ url: "wss://api.test/ws" },
			context.ctx,
		);
		dispose.push(() => connection.dispose());
		connection.subscribe({}, context.sink, OPTIONS);
		await flush();
		FakeWebSocket.last().serverOpen();
		connection.probe?.();
		expect(FakeWebSocket.instances).toHaveLength(2);
		FakeWebSocket.last().serverOpen();

		expect(context.transitions()).toEqual(ONE_REOPEN);
	});

	it("reports the early notice when a deliberate reopen fails, then the outcome before connected", async () => {
		const context = orderedLog();
		const connection = websocketAdapter().connect(
			{ url: "wss://api.test/ws" },
			context.ctx,
		);
		dispose.push(() => connection.dispose());
		connection.subscribe({}, context.sink, OPTIONS);
		await flush();
		FakeWebSocket.last().serverOpen();
		connection.probe?.();
		FakeWebSocket.last().serverClose(1006);
		await vi.advanceTimersByTimeAsync(500);
		expect(FakeWebSocket.instances).toHaveLength(3);
		FakeWebSocket.last().serverOpen();

		expect(context.transitions()).toEqual([
			"status:connecting",
			"status:connected",
			"status:connecting",
			"continuity:reopened",
			"status:reconnecting",
			"continuity:reopened",
			"status:connected",
		]);
	});
});

function streamed(body: ScriptedBody, contentType: string) {
	return (request: ScriptedRequest) =>
		eventStream(
			body,
			{ headers: { "content-type": contentType } },
			request.init.signal ?? undefined,
		);
}

const networkFailure = () => {
	throw new TypeError("network");
};

describe("stream: continuity before status", () => {
	function connect(
		spec: Partial<StreamConnectionSpec>,
		responders: Parameters<typeof scriptedFetch>[0],
	) {
		const context = orderedLog();
		const scripted = scriptedFetch(responders);
		vi.stubGlobal("fetch", scripted.fetch);
		const connection = streamAdapter({
			parsers: { ndjson: ndjsonParser() },
		}).connect(
			{
				url: "https://api.test/stream",
				parser: "ndjson",
				repeatable: true,
				...spec,
			},
			context.ctx,
		);
		dispose.push(() => connection.dispose());
		connection.subscribe({}, context.sink, OPTIONS);
		return { ...context, connection, requests: scripted.requests };
	}

	it("reports the early notice before reconnecting and the outcome before connected, per cut-off or liveness loss", async () => {
		const first = scriptedBody();
		const second = scriptedBody();
		const third = scriptedBody();
		const ndjson = "application/x-ndjson";
		const { transitions, requests } = connect(
			{ heartbeat: { expectInboundWithinMs: 5_000 } },
			[
				streamed(first, ndjson),
				networkFailure,
				streamed(second, ndjson),
				streamed(third, ndjson),
			],
		);
		await flush(20);
		first.write('{"n":1}\n');
		await flush(20);

		// The body is cut off; the first retry fails before a response.
		first.fail();
		await flush(20);
		await vi.advanceTimersByTimeAsync(500);
		await flush(20);
		expect(requests).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(1_000);
		await flush(20);
		expect(requests).toHaveLength(3);

		// Liveness loss: nothing inbound within 5 s.
		await vi.advanceTimersByTimeAsync(5_000);
		await vi.advanceTimersByTimeAsync(2_000);
		await flush(20);
		expect(requests).toHaveLength(4);

		expect(transitions()).toEqual(TWO_INTERRUPTIONS);
	});

	it("reports a deliberate reopen once, before the replacement request connects", async () => {
		const first = scriptedBody();
		const second = scriptedBody();
		const ndjson = "application/x-ndjson";
		const { transitions, connection, requests } = connect({}, [
			streamed(first, ndjson),
			streamed(second, ndjson),
		]);
		await flush(20);
		connection.probe?.();
		await flush(20);
		expect(requests).toHaveLength(2);

		expect(transitions()).toEqual(ONE_REOPEN);
	});

	it("reports the early notice when a deliberate reopen fails, then the outcome before connected", async () => {
		const first = scriptedBody();
		const third = scriptedBody();
		const ndjson = "application/x-ndjson";
		const { transitions, connection, requests } = connect({}, [
			streamed(first, ndjson),
			networkFailure,
			streamed(third, ndjson),
		]);
		await flush(20);
		connection.probe?.();
		await flush(20);
		await vi.advanceTimersByTimeAsync(500);
		await flush(20);
		expect(requests).toHaveLength(3);

		expect(transitions()).toEqual([
			"status:connecting",
			"status:connected",
			"status:connecting",
			"continuity:reopened",
			"status:reconnecting",
			"continuity:reopened",
			"status:connected",
		]);
	});
});

describe("fetch-mode SSE: continuity before status", () => {
	function connect(
		spec: Partial<SseConnectionSpec>,
		responders: Parameters<typeof scriptedFetch>[0],
	) {
		const context = orderedLog();
		const scripted = scriptedFetch(responders);
		vi.stubGlobal("fetch", scripted.fetch);
		const adapter = sseAdapter();
		const connection = {
			url: "https://api.test/sse",
			mode: "fetch",
			heartbeat: { expectInboundWithinMs: 5_000 },
			...spec,
		} as SseConnectionSpec;
		adapter.validateConnection?.(connection);
		const conn = adapter.connect(connection, context.ctx);
		dispose.push(() => conn.dispose());
		conn.subscribe({ event: "tick" }, context.sink, OPTIONS);
		return { ...context, requests: scripted.requests };
	}

	/** Server close, a failed retry, a reconnect; then a liveness loss and a reconnect. */
	async function twoInterruptions(spec: Partial<SseConnectionSpec>) {
		const first = scriptedBody();
		const second = scriptedBody();
		const third = scriptedBody();
		const sse = "text/event-stream";
		const { transitions, requests } = connect(spec, [
			streamed(first, sse),
			networkFailure,
			streamed(second, sse),
			streamed(third, sse),
		]);
		await flush(20);
		first.write("id: 1\nevent: tick\ndata: 1\n\n");
		await flush(20);

		first.end();
		await flush(20);
		await vi.advanceTimersByTimeAsync(500);
		await flush(20);
		expect(requests).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(1_000);
		await flush(20);
		expect(requests).toHaveLength(3);
		second.write("id: 2\nevent: tick\ndata: 2\n\n");
		await flush(20);

		await vi.advanceTimersByTimeAsync(5_000);
		await vi.advanceTimersByTimeAsync(2_000);
		await flush(20);
		expect(requests).toHaveLength(4);
		return transitions();
	}

	it("without replay: the early notice before reconnecting and the outcome before connected", async () => {
		expect(await twoInterruptions({})).toEqual(TWO_INTERRUPTIONS);
	});

	it("with replay: the early notice at detection, then the resumed outcome before connected", async () => {
		expect(await twoInterruptions({ replay: "last-event-id" })).toEqual([
			"status:connecting",
			"status:connected",
			"continuity:reconnected",
			"status:reconnecting",
			"continuity:resumed-with-cursor",
			"status:connected",
			"continuity:reconnected",
			"status:reconnecting",
			"continuity:resumed-with-cursor",
			"status:connected",
		]);
	});
});

describe("EventSource-mode SSE: continuity before status", () => {
	/** One built-in reconnect: the browser reconnects on its own and resends Last-Event-ID. */
	function builtInReconnect(spec: Partial<SseConnectionSpec>) {
		FakeEventSource.reset();
		vi.stubGlobal("EventSource", FakeEventSource);
		const context = orderedLog();
		const adapter = sseAdapter();
		const connection = {
			url: "https://api.test/sse",
			mode: "eventsource",
			...spec,
		} as SseConnectionSpec;
		adapter.validateConnection?.(connection);
		const conn = adapter.connect(connection, context.ctx);
		dispose.push(() => conn.dispose());
		conn.subscribe({ event: "tick" }, context.sink, OPTIONS);
		const source = FakeEventSource.last();
		source.open();
		source.emit("tick", "1", "1");
		source.networkError();
		source.open();
		expect(FakeEventSource.instances).toHaveLength(1);
		return context.transitions();
	}

	it("without replay: the early notice before reconnecting and the outcome before connected", () => {
		expect(builtInReconnect({})).toEqual([
			"status:connecting",
			"status:connected",
			"continuity:reconnected",
			"status:reconnecting",
			"continuity:reconnected",
			"status:connected",
		]);
	});

	it("with replay: the early notice at detection, then the resumed outcome before connected", () => {
		expect(builtInReconnect({ replay: "last-event-id" })).toEqual([
			"status:connecting",
			"status:connected",
			"continuity:reconnected",
			"status:reconnecting",
			"continuity:resumed-with-cursor",
			"status:connected",
		]);
	});
});
