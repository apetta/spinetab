import {
	afterEach,
	beforeEach,
	describe,
	expect,
	expectTypeOf,
	it,
	vi,
} from "vitest";
import type { SinkNextMeta } from "../../../src/core/adapter.ts";
import type {
	Feed,
	SpinetabClient,
	Subscription,
} from "../../../src/core/types.ts";
import * as ssePage from "../../../src/transports/sse/index.ts";
import { type SseFeed, sse } from "../../../src/transports/sse/index.ts";
import * as sseRuntime from "../../../src/transports/sse/runtime.ts";
import {
	type SseAdapterOptions,
	sseAdapter,
} from "../../../src/transports/sse/runtime.ts";
import {
	eventStream,
	FakeEventSource,
	fakeContext,
	flush,
	recordingSink,
	type ScriptedBody,
	type ScriptedRequest,
	scriptedBody,
	scriptedFetch,
} from "./helpers.ts";

// SSE decodes JSON by default and delivers each event as its
// data, with the envelope fields in `meta`. the resume URL hook's output
// keeps the connection's origin and carries no userinfo.

const URL_BASE = "https://api.test/sse";

function ok(body: ScriptedBody) {
	return (request: ScriptedRequest) =>
		eventStream(body, {}, request.init.signal ?? undefined);
}

function open(
	options: Record<string, unknown> = {},
	responders: Parameters<typeof scriptedFetch>[0] = [],
	adapterOptions: SseAdapterOptions = {},
	subscribeOptions: { event?: string; cursor?: string } = {},
) {
	const scripted = scriptedFetch(responders);
	vi.stubGlobal("fetch", scripted.fetch);
	const adapter = sseAdapter(adapterOptions);
	const connection = sse(URL_BASE, options).connection;
	adapter.validateConnection?.(connection);
	const fake = fakeContext();
	const conn = adapter.connect(connection, fake.ctx);
	const record = recordingSink<unknown>();
	conn.subscribe(
		subscribeOptions.event === undefined
			? {}
			: { event: subscribeOptions.event },
		record.sink,
		{
			key: "s",
			repeatable: true,
			...(subscribeOptions.cursor === undefined
				? {}
				: { cursor: subscribeOptions.cursor }),
		},
	);
	return { adapter, conn, fake, record, requests: scripted.requests };
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("SSE payloads", () => {
	it("decodes JSON by default and delivers the data with meta.eventId and meta.event", async () => {
		const body = scriptedBody();
		const { record } = open({}, [ok(body)]);
		await flush(20);
		body.write('id: 7\ndata: {"n":1}\n\n');
		body.write('data: {"n":2}\n\n');
		await flush(20);
		expect(record.events).toEqual([{ n: 1 }, { n: 2 }]);
		// The second event inherits the last event ID (NT:303-306).
		expect(record.metas).toEqual<Array<SinkNextMeta>>([
			{ eventId: "7", event: "message" } as SinkNextMeta,
			{ eventId: "7", event: "message" } as SinkNextMeta,
		]);
	});

	it("a named event carries its name in meta.event; an event without an ID has none", async () => {
		const body = scriptedBody();
		const { record } = open({}, [ok(body)], {}, { event: "tick" });
		await flush(20);
		body.write("event: tick\ndata: [1,2]\n\n");
		await flush(20);
		expect(record.events).toEqual([[1, 2]]);
		expect(record.metas).toEqual([{ event: "tick" }]);
	});

	it('decoder "text" delivers the raw string', async () => {
		const body = scriptedBody();
		const { record } = open({ decoder: "text" }, [ok(body)]);
		await flush(20);
		body.write("data: plain words\n\n");
		await flush(20);
		expect(record.events).toEqual(["plain words"]);
	});

	it("a JSON parse failure is a loud decode-error plus a gap, and the stream continues", async () => {
		const body = scriptedBody();
		const { record, fake } = open({}, [ok(body)]);
		await flush(20);
		body.write("data: not json\n\n");
		body.write('data: {"n":3}\n\n');
		await flush(20);
		expect(record.continuity).toEqual([{ reason: "decode-error" }]);
		expect(fake.diagnostics.map((event) => event.type)).toContain(
			"decode-error",
		);
		expect(record.events).toEqual([{ n: 3 }]);
		expect(fake.last()).toMatchObject({ state: "connected" });
	});

	it("the EventSource mode decodes JSON by default as well", async () => {
		FakeEventSource.reset();
		vi.stubGlobal("EventSource", FakeEventSource);
		const { record } = open({ mode: "eventsource" });
		const source = FakeEventSource.last();
		source.open();
		source.emit("message", '{"ok":true}', "e1");
		expect(record.events).toEqual([{ ok: true }]);
		expect(record.metas).toEqual([{ eventId: "e1", event: "message" }]);
	});

	it("the decoder id is in identity; omitted equals json", () => {
		const adapter = sseAdapter();
		const key = (options: Record<string, unknown>) =>
			adapter.connectionKey?.(sse(URL_BASE, options).connection);
		expect(key({})).toBe(key({ decoder: "json" }));
		expect(key({})).not.toBe(key({ decoder: "text" }));
		// An object-form spec from an older page keys the same way.
		expect(adapter.connectionKey?.({ url: URL_BASE })).toBe(key({}));
		expect(sse(URL_BASE).connection.decoder).toBe("json");
	});

	it("SseEvent is no longer a public type or value", () => {
		expect("SseEvent" in ssePage).toBe(false);
		expect("SseEvent" in sseRuntime).toBe(false);
	});

	it("sse<E>(url) is typed E; decoder text is typed string", () => {
		interface Tick {
			n: number;
		}
		const client = {} as SpinetabClient;
		const ticks = sse<Tick>("/api/ticks");
		expectTypeOf(ticks).toEqualTypeOf<SseFeed<Tick>>();
		expectTypeOf(ticks).toExtend<Feed<Tick>>();
		if (Math.random() > 2) {
			expectTypeOf(
				client.subscribe(ticks, (tick, meta) => {
					expectTypeOf(tick).toEqualTypeOf<Tick>();
					expectTypeOf(meta.event).toEqualTypeOf<string | undefined>();
				}),
			).toEqualTypeOf<Subscription<Tick>>();
		}
		expectTypeOf(sse("/s")).toEqualTypeOf<SseFeed<unknown>>();
		expectTypeOf(sse("/s", { decoder: "text" })).toEqualTypeOf<
			SseFeed<string>
		>();
		expectTypeOf(sse({ url: "/s", decoder: "text" })).toEqualTypeOf<
			SseFeed<string>
		>();
		expectTypeOf(
			sse("/s").subscription<Tick>({ event: "tick" }).subscription,
		).toEqualTypeOf<{ event?: string }>();
	});
});

describe("SSE resume URL hook output", () => {
	for (const [name, hookUrl] of [
		["another origin", "https://evil.example/sse?c="],
		["userinfo", "https://user:pass@api.test/sse?c="],
	] as const) {
		it(`a hook that returns ${name} fails the connection and sends nothing`, async () => {
			const { record, fake, requests } = open(
				{ resume: { url: "custom" } },
				[],
				{ resumeUrls: { custom: (_url, cursor) => `${hookUrl}${cursor}` } },
				{ cursor: "c1" },
			);
			await flush(20);
			expect(requests).toEqual([]);
			expect(fake.last()).toMatchObject({
				state: "failed",
				reason: "permanent-error",
				code: "unsupported-option",
			});
			expect(record.errors.map((error) => error.code)).toEqual([
				"unsupported-option",
			]);
		});
	}

	it("a hook that keeps the origin is used as is", async () => {
		const body = scriptedBody();
		const { requests } = open(
			{ resume: { url: "custom" } },
			[ok(body)],
			{
				resumeUrls: {
					custom: (url, cursor) => {
						url.searchParams.set("from", cursor);
						return url;
					},
				},
			},
			{ cursor: "c1" },
		);
		await flush(20);
		expect(requests[0]?.url).toBe(`${URL_BASE}?from=c1`);
	});
});
