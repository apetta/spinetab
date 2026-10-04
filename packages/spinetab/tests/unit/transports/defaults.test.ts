import {
	afterEach,
	beforeEach,
	describe,
	expect,
	expectTypeOf,
	it,
	vi,
} from "vitest";
import { isSpinetabError } from "../../../src/core/errors.ts";
import { isUniqueKey } from "../../../src/core/identity.ts";
import {
	type PollingConsumerOptions,
	pollEvery,
	polling,
} from "../../../src/transports/polling/index.ts";
import * as pollingRuntime from "../../../src/transports/polling/runtime.ts";
import { sse } from "../../../src/transports/sse/index.ts";
import * as sseRuntime from "../../../src/transports/sse/runtime.ts";
import { stream } from "../../../src/transports/stream/index.ts";
import * as streamRuntime from "../../../src/transports/stream/runtime.ts";
import * as websocketRuntime from "../../../src/transports/websocket/runtime.ts";
import {
	eventStream,
	fakeContext,
	flush,
	recordingSink,
	type ScriptedBody,
	type ScriptedRequest,
	scriptedBody,
	scriptedFetch,
} from "./helpers.ts";

// working defaults and one adapter naming pattern.
// Omitting a value and passing its default give one canonical identity
// (NT:39).

const ABSOLUTE = "https://api.test/feed";

function errorOf(action: () => unknown): unknown {
	try {
		action();
	} catch (error) {
		return error;
	}
	return undefined;
}

function pathOf(action: () => unknown): string | undefined {
	return (errorOf(action) as { detail?: { path?: string } } | undefined)?.detail
		?.path;
}

describe("pollEvery validates on the page", () => {
	it("rejects a non-integer or sub-second interval synchronously with its path", () => {
		for (const bad of [999, 0, -1_000, 1_500.5, Number.NaN, "5000"]) {
			const error = errorOf(() => pollEvery(bad as number));
			expect(isSpinetabError(error, "unsupported-option"), String(bad)).toBe(
				true,
			);
			expect(pathOf(() => pollEvery(bad as number))).toBe(
				"pollEvery.intervalMs",
			);
		}
		expect(pathOf(() => pollEvery(86_400_001))).toBe("pollEvery.intervalMs");
	});

	it("keeps the consumer options it builds", () => {
		expect(pollEvery(1_000)).toEqual({ consumer: { intervalMs: 1_000 } });
		expect(pollEvery(30_000, { whileHidden: true })).toEqual({
			consumer: { whileHidden: true, intervalMs: 30_000 },
		});
		const adapter = pollingRuntime.pollingAdapter();
		expect(() =>
			adapter.validateConsumer?.(
				pollEvery(5_000, { onJoin: "await" }).consumer,
			),
		).not.toThrow();
	});

	it("leaves the interval out of identity: a default consumer shares the connection", () => {
		const adapter = pollingRuntime.pollingAdapter();
		const feed = polling(ABSOLUTE);
		expect(adapter.connectionKey?.(feed.connection)).toBe(
			adapter.connectionKey?.(polling({ url: ABSOLUTE }).connection),
		);
		expect(feed.subscription()).not.toHaveProperty("consumer");
	});

	it("fix: spinetab/polling and spinetab/polling/runtime declare one PollingConsumerOptions", () => {
		// The runtime defaults the interval, so neither entry may require it.
		expectTypeOf<pollingRuntime.PollingConsumerOptions>().toEqualTypeOf<PollingConsumerOptions>();
		const withoutInterval: pollingRuntime.PollingConsumerOptions = {
			whileHidden: true,
		};
		expect(() =>
			pollingRuntime.pollingAdapter().validateConsumer?.(withoutInterval),
		).not.toThrow();
	});
});

describe("SSE mode defaults to fetch", () => {
	it("fills mode: fetch in the canonical connection for both builder forms", () => {
		const explicit = sse({ url: "/s", mode: "fetch" }).subscription();
		expect(sse({ url: "/s" }).subscription()).toEqual(explicit);
		expect(sse("/s").subscription()).toEqual(explicit);
		// writes the default decoder out as well.
		expect(sse("/s").connection).toEqual({
			url: "/s",
			mode: "fetch",
			decoder: "json",
		});
		expect(sse("/s").subscription().repeatable).toBe(true);
	});

	it("applies fetch-mode rules when the mode is omitted", () => {
		expect(pathOf(() => sse({ url: "/s", withCredentials: true }))).toBe(
			"connection.withCredentials",
		);
		expect(
			sse("/s", { method: "POST", body: "{}" }).subscription().repeatable,
		).toBe(false);
		expect(
			sse("/s", { authHeaders: true, headers: { "x-a": "1" } }).connection,
		).toEqual({
			url: "/s",
			mode: "fetch",
			decoder: "json",
			authHeaders: true,
			headers: { "x-a": "1" },
		});
	});

	it("keys an omitted mode and mode: fetch as one identity in the runtime", () => {
		const adapter = sseRuntime.sseAdapter();
		expect(() => adapter.validateConnection?.({ url: ABSOLUTE })).not.toThrow();
		expect(adapter.connectionKey?.({ url: ABSOLUTE })).toBe(
			adapter.connectionKey?.({ url: ABSOLUTE, mode: "fetch" }),
		);
		expect(adapter.connectionKey?.({ url: ABSOLUTE })).not.toBe(
			adapter.connectionKey?.({ url: ABSOLUTE, mode: "eventsource" }),
		);
	});

	it("streams in fetch mode when a request arrives without a mode", async () => {
		const body = scriptedBody();
		const scripted = scriptedFetch([
			(request: ScriptedRequest) =>
				eventStream(body, {}, request.init.signal ?? undefined),
		]);
		vi.stubGlobal("fetch", scripted.fetch);
		const conn = sseRuntime
			.sseAdapter()
			.connect({ url: ABSOLUTE }, fakeContext().ctx);
		const record = recordingSink();
		conn.subscribe({}, record.sink, { key: "message", repeatable: true });
		await flush(20);
		expect(scripted.requests).toHaveLength(1);
		body.write('id: 1\ndata: "hello"\n\n');
		await flush(20);
		// The JSON default, delivered as the data with the envelope in meta.
		expect(record.events).toEqual(["hello"]);
		expect(record.metas).toEqual([{ eventId: "1", event: "message" }]);
		conn.dispose();
	});
});

describe("streams parse NDJSON by default", () => {
	function ndjson(body: ScriptedBody) {
		return (request: ScriptedRequest) =>
			eventStream(
				body,
				{ headers: { "content-type": "application/x-ndjson" } },
				request.init.signal ?? undefined,
			);
	}

	async function run(
		adapter: ReturnType<typeof streamRuntime.streamAdapter>,
		parser: string | undefined,
		chunk: string,
	) {
		const body = scriptedBody();
		const scripted = scriptedFetch([ndjson(body)]);
		vi.stubGlobal("fetch", scripted.fetch);
		const spec = {
			url: ABSOLUTE,
			repeatable: true,
			...(parser === undefined ? {} : { parser }),
		};
		adapter.validateConnection?.(spec);
		const conn = adapter.connect(spec, fakeContext().ctx);
		const record = recordingSink();
		conn.subscribe({}, record.sink, { key: "s", repeatable: true });
		await flush(20);
		body.write(chunk);
		body.end();
		await flush(20);
		conn.dispose();
		return record.events;
	}

	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("fills parser: ndjson in the canonical connection for both builder forms", () => {
		const explicit = stream({
			url: "/o",
			parser: "ndjson",
			repeatable: true,
		}).subscription();
		expect(stream({ url: "/o", repeatable: true }).subscription()).toEqual(
			explicit,
		);
		expect(stream("/o", { repeatable: true }).subscription()).toEqual(explicit);
		expect(stream("/o").connection).toEqual({ url: "/o", parser: "ndjson" });
		expect(stream("/o").subscription().repeatable).toBe(false);
		expect(pathOf(() => stream({ url: "/o", parser: "" }))).toBe(
			"connection.parser",
		);
		expect(pathOf(() => stream({ url: "/o", parser: 1 as never }))).toBe(
			"connection.parser",
		);
	});

	it("keys an omitted parser and parser: ndjson as one identity in the runtime", () => {
		const adapter = streamRuntime.streamAdapter();
		const read = { url: ABSOLUTE, repeatable: true };
		expect(adapter.connectionKey?.(read)).toBe(
			adapter.connectionKey?.({ ...read, parser: "ndjson" }),
		);
		expect(adapter.connectionKey?.(read)).not.toBe(
			adapter.connectionKey?.({ ...read, parser: "lines" }),
		);
		expect(
			isUniqueKey(adapter.connectionKey?.({ url: ABSOLUTE }) as string),
		).toBe(true);
	});

	it("registers built-in ndjson and lines parsers with no argument", async () => {
		for (const adapter of [
			streamRuntime.streamAdapter(),
			streamRuntime.streamAdapter(),
			streamRuntime.streamAdapter({}),
		]) {
			expect(await run(adapter, undefined, '{"a":1}\n\n{"b":2}\n')).toEqual([
				{ a: 1 },
				{ b: 2 },
			]);
			expect(await run(adapter, "ndjson", '{"a":1}\n')).toEqual([{ a: 1 }]);
			expect(await run(adapter, "lines", "one\r\ntwo\n")).toEqual([
				"one",
				"two",
			]);
		}
	});

	it("lets an explicit parser under a built-in name win and keeps both built-ins beside custom ones", async () => {
		const upper: streamRuntime.Parser<string> = (context) => {
			const inner = streamRuntime.lineFramer()(context);
			return {
				push: (chunk) => inner.push(chunk).map((line) => line.toUpperCase()),
				end: () => inner.end().map((line) => line.toUpperCase()),
				pendingBytes: () => inner.pendingBytes?.() ?? 0,
			};
		};
		const custom = streamRuntime.streamAdapter({
			parsers: { ndjson: upper, csv: upper },
		});
		expect(await run(custom, undefined, "a\nb\n")).toEqual(["A", "B"]);
		expect(await run(custom, "csv", "c\n")).toEqual(["C"]);
		expect(await run(custom, "lines", "d\n")).toEqual(["d"]);
		expect(
			pathOf(() =>
				custom.validateConnection?.({ url: ABSOLUTE, parser: "xml" }),
			),
		).toBe("connection.parser");
		expect(
			pathOf(() => streamRuntime.streamAdapter({ parsers: [] as never })),
		).toBe("streamAdapter.parsers");
	});
});

describe("native adapter kinds", () => {
	it("each default factory reports its transport kind", () => {
		expect(pollingRuntime.pollingAdapter().kind).toBe("polling");
		expect(sseRuntime.sseAdapter().kind).toBe("sse");
		expect(streamRuntime.streamAdapter().kind).toBe("stream");
		expect(websocketRuntime.websocketAdapter().kind).toBe("websocket");
	});
});
