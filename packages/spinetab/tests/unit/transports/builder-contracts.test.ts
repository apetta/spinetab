import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	AdapterSubscription,
	ConnectionContext,
	SubscriptionSink,
} from "../../../src/core/adapter.ts";
import { SpinetabError } from "../../../src/core/errors.ts";
import { stableStringify } from "../../../src/core/identity.ts";
import { DEFAULT_LIMITS } from "../../../src/core/limits.ts";
import { toRequest } from "../../../src/core/source.ts";
import type {
	ConnectionStatus,
	Credentials,
	EventMeta,
	Feed,
	Json,
} from "../../../src/core/types.ts";
import { createSpinetab } from "../../../src/index.ts";
import { createRuntime } from "../../../src/runtime/index.ts";
import { pollEvery, polling } from "../../../src/transports/polling/index.ts";
import { pollingAdapter } from "../../../src/transports/polling/runtime.ts";
import { sse } from "../../../src/transports/sse/index.ts";
import { sseAdapter } from "../../../src/transports/sse/runtime.ts";
import { stream } from "../../../src/transports/stream/index.ts";
import {
	lineFramer,
	ndjsonParser,
	type Parser,
	streamAdapter,
} from "../../../src/transports/stream/runtime.ts";
import { websocket } from "../../../src/transports/websocket/index.ts";
import {
	eventStream,
	fakeContext,
	flush,
	recordingSink,
	type ScriptedBody,
	type ScriptedRequest,
	scriptedBody,
	scriptedFetch,
	waitFor,
} from "./helpers.ts";

const ABSOLUTE = "https://api.test/feed";

function errorOf(action: () => unknown): SpinetabError | undefined {
	try {
		action();
	} catch (error) {
		return error as SpinetabError;
	}
	return undefined;
}

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("the first-argument url is never lost", () => {
	// `Omit<Spec, "url">` accepts any non-literal object that carries
	// `url?: string` (for example a shared `Partial<Spec>`), so `url: undefined`
	// reaches the builder. The URL-first form must still use its first argument.
	const noUrl = { url: undefined } as never;

	it("polling(url, { url: undefined }) equals polling({ url })", () => {
		expect(errorOf(() => polling("/q", noUrl))).toBeUndefined();
		expect(polling("/q", noUrl).connection).toEqual(
			polling({ url: "/q" }).connection,
		);
	});

	it("sse(url, { url: undefined }) equals sse({ url })", () => {
		expect(errorOf(() => sse("/s", noUrl))).toBeUndefined();
		expect(sse("/s", noUrl).connection).toEqual(sse({ url: "/s" }).connection);
	});

	it("stream(url, { url: undefined }) equals stream({ url })", () => {
		expect(errorOf(() => stream("/o", noUrl))).toBeUndefined();
		expect(stream("/o", noUrl).connection).toEqual(
			stream({ url: "/o" }).connection,
		);
	});

	it("websocket(url, { url: undefined }) equals websocket({ url })", () => {
		expect(errorOf(() => websocket("/ws", noUrl))).toBeUndefined();
		expect(websocket("/ws", noUrl).connection).toEqual(
			websocket({ url: "/ws" }).connection,
		);
	});
});

describe("non-object options fail like the other builders", () => {
	// sse, stream and websocket reject non-object options at `connection`
	// (unsupported input fails at definition); polling should too.
	it.each([
		["null", null],
		["an array", []],
		["a number", 5],
	])("polling(url, %s) is unsupported-option", (_label, value) => {
		expect(errorOf(() => sse("/s", value as never))?.code).toBe(
			"unsupported-option",
		);
		expect(errorOf(() => polling("/q", value as never))?.code).toBe(
			"unsupported-option",
		);
	});
});

describe("feeds as sources through core's normaliser", () => {
	const key = (source: Parameters<typeof toRequest>[0]) =>
		stableStringify(toRequest(source, "source"));

	it("an inline feed rebuilt on every render gives the same request key", () => {
		const builds: Array<() => Feed<unknown>> = [
			() => polling<{ open: number }>("/api/queue"),
			() => sse("/api/ticks"),
			() => stream<{ id: number }>("/api/orders", { repeatable: true }),
			() => websocket("/ws", { protocol: "p" }),
		];
		for (const build of builds) {
			expect(key(build())).toBe(key(build()));
			expect(key(build())).toBe(key(build().subscription()));
		}
	});

	it("a feed whose default selection is not total fails in its builder, naming the path", () => {
		const error = errorOf(() =>
			toRequest(sse("/api/ticks", { events: ["tick"] }), "source"),
		);
		expect(error?.code).toBe("unsupported-option");
		expect(error?.detail).toMatchObject({ path: "subscription.event" });
	});
});

describe("both forms and the explicit default are one identity", () => {
	const resolve = <C extends { url: string }>(connection: C): C => ({
		...connection,
		url: new URL(connection.url, "https://app.test/").href,
	});

	it("stream: omitted parser, URL-first and parser: ndjson share the page request and runtime key", () => {
		const forms = [
			stream("/o", { repeatable: true }),
			stream({ url: "/o", repeatable: true }),
			stream({ url: "/o", parser: "ndjson", repeatable: true }),
			stream("/o", { parser: "ndjson", repeatable: true }),
		];
		const requests = forms.map((feed) => stableStringify(feed.subscription()));
		expect(new Set(requests).size).toBe(1);
		const adapter = streamAdapter();
		const keys = forms.map((feed) =>
			adapter.connectionKey?.(resolve(feed.connection)),
		);
		expect(new Set(keys).size).toBe(1);
		// A request that reached the runtime without a parser keys the same.
		expect(
			adapter.connectionKey?.({
				url: "https://app.test/o",
				repeatable: true,
			}),
		).toBe(keys[0]);
	});

	it("sse: omitted mode, mode: undefined, URL-first and mode: fetch share the page request and runtime key", () => {
		const forms = [
			sse("/s"),
			sse({ url: "/s" }),
			sse({ url: "/s", mode: undefined }),
			sse("/s", { mode: undefined }),
			sse({ url: "/s", mode: "fetch" }),
			sse("/s", { mode: "fetch" }),
		];
		const requests = forms.map((feed) => stableStringify(feed.subscription()));
		expect(new Set(requests).size).toBe(1);
		const adapter = sseAdapter();
		const keys = forms.map((feed) =>
			adapter.connectionKey?.(resolve(feed.connection)),
		);
		expect(new Set(keys).size).toBe(1);
		expect(
			adapter.connectionKey?.({ url: "https://app.test/s", mode: undefined }),
		).toBe(keys[0]);
		// The explicit EventSource form is unchanged and stays its own identity.
		const eventsource = sse({ url: "/s", mode: "eventsource" });
		expect(eventsource.connection).toEqual({
			url: "/s",
			mode: "eventsource",
			decoder: "json",
		});
		expect(adapter.connectionKey?.(resolve(eventsource.connection))).not.toBe(
			keys[0],
		);
	});

	it("polling and websocket: URL-first and options forms share the page request", () => {
		expect(
			stableStringify(polling("/q", { timeoutMs: 10_000 }).subscription()),
		).toBe(
			stableStringify(polling({ url: "/q", timeoutMs: 10_000 }).subscription()),
		);
		expect(
			stableStringify(websocket("/ws", { protocol: "p" }).subscription("t")),
		).toBe(
			stableStringify(
				websocket({ url: "/ws", protocol: "p" }).subscription("t"),
			),
		);
	});
});

describe("pollEvery validates on the page with the exact text", () => {
	const MESSAGE =
		"polling: pollEvery.intervalMs must be an integer between 1000 and 86400000.";

	it.each([
		999,
		0,
		-1_000,
		1_000.5,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		86_400_001,
		"5000",
		undefined,
	])("rejects %s synchronously", (value) => {
		const error = errorOf(() => pollEvery(value as never));
		expect(error?.code).toBe("unsupported-option");
		expect(error?.message).toBe(MESSAGE);
		expect(error?.detail).toMatchObject({ path: "pollEvery.intervalMs" });
	});

	it("accepts both bounds and keeps its options", () => {
		expect(pollEvery(1_000)).toEqual({ consumer: { intervalMs: 1_000 } });
		expect(pollEvery(86_400_000, { whileHidden: true })).toEqual({
			consumer: { whileHidden: true, intervalMs: 86_400_000 },
		});
	});
});

describe("the default interval is per consumer", () => {
	interface Call {
		url: string;
		resolve(response: Response): void;
	}

	function harness(provider?: () => Promise<Credentials>) {
		const calls: Call[] = [];
		const fetchImpl = vi.fn(
			(url: string | URL | Request) =>
				new Promise<Response>((resolve) => {
					calls.push({ url: String(url), resolve });
				}),
		) as unknown as typeof fetch;
		const statuses: Array<Omit<ConnectionStatus, "since">> = [];
		const ctx: ConnectionContext = {
			scope: "",
			key: "k",
			limits: DEFAULT_LIMITS,
			signal: new AbortController().signal,
			credentials: vi.fn(
				provider ??
					(async () => {
						throw new SpinetabError("no-credential-source", "none");
					}),
			),
			rejectCredentials: vi.fn(),
			setStatus: (status) => statuses.push(status),
			diagnostic: vi.fn(),
			now: () => Date.now(),
		};
		const connection = pollingAdapter({ fetch: fetchImpl }).connect(
			polling(ABSOLUTE).connection,
			ctx,
		);
		const sink: SubscriptionSink<unknown> = {
			next: vi.fn(),
			error: vi.fn(),
			complete: vi.fn(),
			continuity: vi.fn(),
			started: vi.fn(),
		};
		const handle = connection.subscribe({}, sink, {
			key: "poll",
			repeatable: true,
		}) as Required<AdapterSubscription<Json>>;
		const answer = async () => {
			const call = calls.at(-1);
			call?.resolve(
				new Response("{}", {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			);
			await vi.advanceTimersByTimeAsync(0);
		};
		return { calls, handle, statuses, answer, fetchImpl };
	}

	beforeEach(() => {
		vi.useFakeTimers();
		// Same origin as the polled URL, so auto mode asks the provider.
		vi.stubGlobal("location", { origin: new URL(ABSOLUTE).origin });
	});

	it("a default consumer beside a 2 s consumer polls at 2 s, and at 5 s once the fast one leaves", async () => {
		const { calls, handle, answer } = harness();
		handle.consumerAdded("slow", undefined, { visible: true });
		await vi.advanceTimersByTimeAsync(0);
		expect(calls).toHaveLength(1);
		await answer();
		handle.consumerAdded("fast", pollEvery(2_000).consumer as Json, {
			visible: true,
		});
		// The joiner gets one coalesced read spaced at most 1 s from the last start.
		await vi.advanceTimersByTimeAsync(1_000);
		expect(calls).toHaveLength(2);
		await answer();
		await vi.advanceTimersByTimeAsync(2_000);
		expect(calls).toHaveLength(3);
		await answer();
		handle.consumerRemoved("fast");
		await vi.advanceTimersByTimeAsync(4_999);
		expect(calls).toHaveLength(3);
		await vi.advanceTimersByTimeAsync(1);
		expect(calls).toHaveLength(4);
	});

	it("a consumer updated to {} or { intervalMs: undefined } falls back to 5 s", async () => {
		const { calls, handle, answer } = harness();
		handle.consumerAdded("a", pollEvery(1_000).consumer as Json, {
			visible: true,
		});
		await vi.advanceTimersByTimeAsync(0);
		await answer();
		handle.consumerUpdated("a", {} as Json);
		await vi.advanceTimersByTimeAsync(4_999);
		expect(calls).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(calls).toHaveLength(2);
		await answer();
		handle.consumerUpdated("a", { intervalMs: undefined } as unknown as Json);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(calls).toHaveLength(3);
	});

	it("the runtime still rejects a sub-second interval and a non-object consumer", () => {
		const adapter = pollingAdapter();
		expect(errorOf(() => adapter.validateConsumer?.(undefined))).toBe(
			undefined,
		);
		expect(errorOf(() => adapter.validateConsumer?.({}))).toBe(undefined);
		expect(
			errorOf(() => adapter.validateConsumer?.({ intervalMs: 999 }))?.detail,
		).toMatchObject({ path: "consumer.intervalMs" });
		for (const value of [null, 5_000, "5000", []]) {
			expect(
				errorOf(() => adapter.validateConsumer?.(value as never))?.detail,
			).toMatchObject({ path: "consumer" });
		}
	});

	it("a failed provider produces exactly the statuses of a timed-out one and never fetches", async () => {
		const run = async (code: "credentials-failed" | "credentials-timeout") => {
			const { calls, handle, statuses } = harness(async () => {
				throw new SpinetabError(code, code);
			});
			handle.consumerAdded("a", undefined, { visible: true });
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(60_000);
			return { fetched: calls.length, statuses };
		};
		const failed = await run("credentials-failed");
		const timedOut = await run("credentials-timeout");
		expect(failed.fetched).toBe(0);
		expect(timedOut.fetched).toBe(0);
		expect(failed.statuses).toEqual(timedOut.statuses);
		expect(failed.statuses.at(-1)).toMatchObject({
			state: "auth-blocked",
			reason: "credentials-missing",
		});
	});
});

describe("stream built-in parsers and explicit registrations", () => {
	function ndjsonResponse(body: ScriptedBody) {
		return (request: ScriptedRequest) =>
			eventStream(
				body,
				{ headers: { "content-type": "application/x-ndjson" } },
				request.init.signal ?? undefined,
			);
	}

	async function run(
		adapter: ReturnType<typeof streamAdapter>,
		parser: string | undefined,
		chunk: string,
	) {
		const body = scriptedBody();
		vi.stubGlobal("fetch", scriptedFetch([ndjsonResponse(body)]).fetch);
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

	it("an explicit lines parser wins over the built-in lines framer", async () => {
		const reversed: Parser<string> = (context) => {
			const inner = lineFramer()(context);
			return {
				push: (chunk) =>
					inner.push(chunk).map((line) => [...line].reverse().join("")),
				end: () => inner.end().map((line) => [...line].reverse().join("")),
				pendingBytes: () => inner.pendingBytes?.() ?? 0,
			};
		};
		const adapter = streamAdapter({ parsers: { lines: reversed } });
		expect(await run(adapter, "lines", "abc\n")).toEqual(["cba"]);
		// The other built-in stays registered and remains the default.
		expect(await run(adapter, undefined, '{"a":1}\n')).toEqual([{ a: 1 }]);
	});

	it("the fixture form streamAdapter({ parsers: { ndjson: ndjsonParser() } }) still parses", async () => {
		const adapter = streamAdapter({
			parsers: { ndjson: ndjsonParser() },
		});
		expect(await run(adapter, "ndjson", '{"b":2}\n')).toEqual([{ b: 2 }]);
		expect(await run(adapter, undefined, '{"c":3}\n')).toEqual([{ c: 3 }]);
	});
});

describe("aliases are the same function", () => {
	it("pollingAdapter, sseAdapter and streamAdapter are the factories themselves", () => {
		expect(pollingAdapter).toBe(pollingAdapter);
		expect(sseAdapter).toBe(sseAdapter);
		expect(streamAdapter).toBe(streamAdapter);
	});
});

describe("Transport builders end to end through createSpinetab (local mode, function observers)", () => {
	function stubBrowser(baseURI: string) {
		const target = () => ({ addEventListener() {}, removeEventListener() {} });
		vi.stubGlobal("window", target());
		vi.stubGlobal("document", {
			...target(),
			visibilityState: "visible",
			baseURI,
		});
	}

	it("subscribe(polling<Queue>(url), fn) reads on join and then every 5 000 ms", async () => {
		stubBrowser("https://app.test/app/");
		const starts: Array<{ url: string; at: number }> = [];
		let n = 0;
		const fetchImpl = (async (input: RequestInfo | URL) => {
			starts.push({ url: String(input), at: Date.now() });
			n += 1;
			return new Response(JSON.stringify({ open: n }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch;
		const client = createSpinetab({
			sharing: "off",
			local: async () => ({
				default: () =>
					createRuntime({
						adapters: [pollingAdapter({ fetch: fetchImpl })],
					}),
			}),
		});
		type Queue = { open: number };
		const seen: number[] = [];
		const handle = client.subscribe(polling<Queue>("/api/queue"), (queue) =>
			seen.push(queue.open),
		);
		await waitFor(() => seen.length >= 2, 8_000);
		expect(seen.slice(0, 2)).toEqual([1, 2]);
		expect(starts[0]?.url).toBe("https://app.test/api/queue");
		const gap = (starts[1]?.at ?? 0) - (starts[0]?.at ?? 0);
		expect(gap).toBeGreaterThanOrEqual(4_900);
		expect(gap).toBeLessThan(6_500);
		handle.unsubscribe();
		client.dispose();
	}, 15_000);

	it("subscribe(sse<T>(url), fn) streams in fetch mode and delivers the decoded data with meta.eventId and meta.event", async () => {
		stubBrowser("https://app.test/app/");
		const body = scriptedBody();
		const scripted = scriptedFetch([
			(request) => eventStream(body, {}, request.init.signal ?? undefined),
		]);
		vi.stubGlobal("fetch", scripted.fetch);
		const client = createSpinetab({
			sharing: "off",
			local: async () => ({
				default: () => createRuntime({ adapters: [sseAdapter()] }),
			}),
		});
		const seen: Array<{
			tick: { n: number };
			eventId?: string;
			event?: string;
		}> = [];
		// One callback for two event names: `meta.event` tells them apart.
		const record = (tick: { n: number }, meta: EventMeta) =>
			seen.push({ tick, eventId: meta.eventId, event: meta.event });
		const feed = sse<{ n: number }>("/api/ticks");
		const handles = [
			client.subscribe(feed, record),
			client.subscribe(feed.subscription({ event: "alert" }), record),
		];
		await waitFor(() => scripted.requests.length >= 1, 3_000);
		expect(scripted.requests).toHaveLength(1);
		expect(scripted.requests[0]?.url).toBe("https://app.test/api/ticks");
		body.write('id: 1\ndata: {"n":1}\n\n');
		body.write('id: 2\nevent: alert\ndata: {"n":2}\n\n');
		await waitFor(() => seen.length >= 2, 3_000);
		expect(seen).toEqual([
			{ tick: { n: 1 }, eventId: "1", event: "message" },
			{ tick: { n: 2 }, eventId: "2", event: "alert" },
		]);
		for (const handle of handles) handle.unsubscribe();
		client.dispose();
	}, 10_000);

	it("subscribe(stream<Order>(url, { repeatable: true }), fn) parses NDJSON with streamAdapter()", async () => {
		stubBrowser("https://app.test/app/");
		const body = scriptedBody();
		const scripted = scriptedFetch([
			(request) =>
				eventStream(
					body,
					{ headers: { "content-type": "application/x-ndjson" } },
					request.init.signal ?? undefined,
				),
		]);
		vi.stubGlobal("fetch", scripted.fetch);
		const client = createSpinetab({
			sharing: "off",
			local: async () => ({
				default: () => createRuntime({ adapters: [streamAdapter()] }),
			}),
		});
		type Order = { id: number };
		const seen: number[] = [];
		const handle = client.subscribe(
			stream<Order>("/api/orders", { repeatable: true }),
			(order) => seen.push(order.id),
		);
		await waitFor(() => scripted.requests.length >= 1, 3_000);
		body.write('{"id":1}\n{"id":2}\n');
		await waitFor(() => seen.length >= 2, 3_000);
		expect(seen).toEqual([1, 2]);
		handle.unsubscribe();
		client.dispose();
	}, 10_000);
});

describe("Notes verify: every message in the notes table matches the code exactly", () => {
	it.each([
		[
			"polling runtime, consumer not an object",
			() => pollingAdapter().validateConsumer?.(null as never),
			"polling: consumer must be a plain object.",
		],
		[
			"stream() with parser: ''",
			() => stream({ url: "/o", parser: "" }),
			"connection.parser: must not be empty.",
		],
		[
			"pollEvery(ms) out of range",
			() => pollEvery(999),
			"polling: pollEvery.intervalMs must be an integer between 1000 and 86400000.",
		],
		[
			"polling(url, { url })",
			() => polling("/q", { url: "/r" } as never),
			"polling: polling.url is the first argument; remove it from the options.",
		],
		[
			"sse(url, { url })",
			() => sse("/s", { url: "/t" } as never),
			"connection.url: is the first argument; remove it from the options.",
		],
		[
			"stream(url, { url })",
			() => stream("/o", { url: "/p" } as never),
			"connection.url: is the first argument; remove it from the options.",
		],
		[
			"websocket(url, { url })",
			() => websocket("/ws", { url: "/wt" } as never),
			"connection.url: is the first argument; remove it from the options.",
		],
	])("%s", (_label, action, message) => {
		const error = errorOf(action);
		expect(error?.code).toBe("unsupported-option");
		expect(error?.message).toBe(message);
	});

	it("sse() without mode no longer throws", () => {
		expect(errorOf(() => sse({ url: "/s" }))).toBeUndefined();
	});
});
