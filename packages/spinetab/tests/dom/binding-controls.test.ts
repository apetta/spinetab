import { QueryClient } from "@tanstack/query-core";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { effectScope, nextTick, ref } from "vue";
import * as react from "../../src/bindings/react/index.ts";
import * as svelte from "../../src/bindings/svelte/index.ts";
import * as vue from "../../src/bindings/vue/index.ts";
import type {
	AdapterConnection,
	SubscriptionSink,
} from "../../src/core/adapter.ts";
import {
	browserEnv,
	type ClientEnv,
	createClientWithEnv,
} from "../../src/core/client.ts";
import { createRuntime, type Runtime } from "../../src/core/runtime.ts";
import type { Credentials, SpinetabClient } from "../../src/core/types.ts";
import { aiSdkAdapter } from "../../src/integrations/ai-sdk/runtime.ts";
import type {
	AiCommandPayload,
	AiCommandResult,
	AiSubscriptionSpec,
} from "../../src/integrations/ai-sdk/shared.ts";
import { swrSubscription } from "../../src/integrations/swr/index.ts";
import { bindQuery } from "../../src/integrations/tanstack-query/index.ts";
import {
	fakeContext,
	recordingSink,
} from "../integration/integrations/helpers/fake-context.ts";
import { createFakeClient, macrotask, request } from "./helpers/fake-client.ts";

beforeAll(() => {
	(
		globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
	).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | undefined;
let container: HTMLElement | undefined;
let client: SpinetabClient | undefined;
let runtime: Runtime | undefined;
afterEach(() => {
	act(() => root?.unmount());
	root = undefined;
	container?.remove();
	client?.dispose();
	runtime?.dispose();
	client = undefined;
	runtime = undefined;
	vi.unstubAllGlobals();
});

const env: ClientEnv = {
	...browserEnv,
	isBrowser: () => true,
	hasSharedWorker: () => false,
	visible: () => true,
	baseUri: () => "https://example.test/",
	listen: () => () => {},
};

const SECRET = "SECRET upstream text token=sk-live-123";
const FIXED = "upstream-error: subscription ended with no error handler.";

/** The real page client, bridge and runtime, with a controlled upstream. */
function realClient() {
	const upstream: { sinks: SubscriptionSink<unknown>[] } = { sinks: [] };
	const shared = createRuntime({
		adapters: [
			{
				kind: "controlled",
				version: 1,
				connect(_spec, context) {
					context.setStatus({ state: "connected" });
					return {
						subscribe(_spec, sink) {
							upstream.sinks.push(sink as SubscriptionSink<unknown>);
							return { unsubscribe() {} };
						},
						retry() {},
						dispose() {},
					};
				},
			},
		],
		limits: { maxMessageBytes: 512, lingerMs: 1, idleCloseMs: 1 },
	});
	runtime = shared;
	const reports: unknown[] = [];
	const page = createClientWithEnv(
		{
			sharing: "off",
			local: async () => ({ runtime: () => shared }),
			onCallbackError: (error) => reports.push(error),
		},
		env,
	);
	client = page;
	return { client: page, upstream, reports };
}

const controlled = (key: string) => ({
	adapter: "controlled",
	connection: {},
	subscription: { key },
});

const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 20));
async function until(check: () => boolean, label: string) {
	const end = Date.now() + 2_000;
	while (!check()) {
		if (Date.now() > end) throw new Error(`Timed out: ${label}`);
		await act(pause);
	}
}
const leakyError = () => ({
	code: "upstream-error" as const,
	message: SECRET,
	detail: { url: "https://api.example.test/feed?token=sk-live-123" },
});

function describeReport(error: unknown) {
	const record = error as { code?: string; message?: string; detail?: unknown };
	return { code: record.code, message: record.message, detail: record.detail };
}

describe("default error reporting: a report carries a code and one fixed sentence", () => {
	it("control: core subscribe without an error handler reports the fixed sentence only", async () => {
		const { client, upstream, reports } = realClient();
		client.subscribe(controlled("core"), () => {});
		await until(() => upstream.sinks.length === 1, "registration");
		upstream.sinks[0]?.error(leakyError());
		await until(() => reports.length > 0, "report");
		expect(describeReport(reports[0])).toEqual({
			code: "upstream-error",
			message: FIXED,
			detail: undefined,
		});
	});

	it("Svelte subscriptionStore without an error hook reports like core (no message, no detail)", async () => {
		const { client, upstream, reports } = realClient();
		const store = svelte.subscriptionStore(
			client,
			controlled("svelte"),
			() => {},
		);
		const off = store.subscribe(() => {});
		await until(() => upstream.sinks.length === 1, "registration");
		upstream.sinks[0]?.error(leakyError());
		await until(() => reports.length > 0, "report");
		off();
		expect(JSON.stringify(describeReport(reports[0]))).not.toContain("sk-live");
		expect(describeReport(reports[0])).toEqual({
			code: "upstream-error",
			message: FIXED,
			detail: undefined,
		});
	});

	it("React useSubscription without an error hook reports like core (no message, no detail)", async () => {
		const { client, upstream, reports } = realClient();
		function View() {
			react.useSubscription(client, controlled("react"), () => {});
			return null;
		}
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		act(() => root?.render(createElement(View)));
		await until(() => upstream.sinks.length === 1, "registration");
		upstream.sinks[0]?.error(leakyError());
		await until(() => reports.length > 0, "report");
		expect(JSON.stringify(describeReport(reports[0]))).not.toContain("sk-live");
		expect(describeReport(reports[0])).toEqual({
			code: "upstream-error",
			message: FIXED,
			detail: undefined,
		});
	});

	it("bindQuery without onError reports like core (no message, no detail)", async () => {
		const { client, upstream, reports } = realClient();
		const queryClient = new QueryClient();
		const binding = bindQuery(client, controlled("tq"), {
			queryClient,
			onEvent() {},
		});
		await until(() => upstream.sinks.length === 1, "registration");
		upstream.sinks[0]?.error(leakyError());
		await until(() => reports.length > 0, "report");
		binding.unsubscribe();
		expect(JSON.stringify(describeReport(reports[0]))).not.toContain("sk-live");
		expect(describeReport(reports[0])).toEqual({
			code: "upstream-error",
			message: FIXED,
			detail: undefined,
		});
	});
});

describe("stopped delivery without a status handler is reported once as continuity-lost", () => {
	const oversized = { n: "x".repeat(2_000) };

	it("control: core subscribe with a function observer reports continuity-lost", async () => {
		const { client, upstream, reports } = realClient();
		client.subscribe(controlled("core-stop"), () => {});
		await until(() => upstream.sinks.length === 1, "registration");
		upstream.sinks[0]?.next(oversized);
		await until(() => reports.length > 0, "report");
		expect(describeReport(reports[0]).code).toBe("continuity-lost");
	});

	it("Svelte subscriptionStore with a function observer (no status hook) reports continuity-lost", async () => {
		const { client, upstream, reports } = realClient();
		const store = svelte.subscriptionStore(
			client,
			controlled("svelte-stop"),
			() => {},
		);
		const off = store.subscribe(() => {});
		await until(() => upstream.sinks.length === 1, "registration");
		upstream.sinks[0]?.next(oversized);
		const end = Date.now() + 300;
		while (reports.length === 0 && Date.now() < end) await pause();
		off();
		expect(reports.map((error) => describeReport(error).code)).toContain(
			"continuity-lost",
		);
	});
});

describe("bindQuery and swrSubscription validate reconcile", () => {
	it("bindQuery refuses reconcile: null synchronously and subscribes nothing", () => {
		const fake = createFakeClient();
		const queryClient = new QueryClient();
		let thrown: unknown;
		try {
			bindQuery(fake, request("a"), {
				queryClient,
				onEvent() {},
				reconcile: null as never,
			});
		} catch (error) {
			thrown = error;
		}
		expect({
			name: (thrown as Error | undefined)?.name,
			code: (thrown as { code?: string } | undefined)?.code,
			leaked: fake.active().length,
		}).toEqual({
			name: "SpinetabError",
			code: "unsupported-option",
			leaked: 0,
		});
	});

	it("bindQuery refuses reconcile: { queryKey: undefined } instead of invalidating every query", async () => {
		const fake = createFakeClient();
		const queryClient = new QueryClient();
		const invalidate = vi.spyOn(queryClient, "invalidateQueries");
		let thrown: unknown;
		try {
			const binding = bindQuery(fake, request("b"), {
				queryClient,
				onEvent() {},
				onError() {},
				reconcile: { queryKey: undefined } as never,
			});
			fake.setConnection("connected");
			fake.setContinuity("gap", "overflow");
			await macrotask();
			binding.unsubscribe();
		} catch (error) {
			thrown = error;
		}
		expect(
			invalidate.mock.calls.map(([filters]) => filters),
		).not.toContainEqual({
			queryKey: undefined,
		});
		expect((thrown as { code?: string } | undefined)?.code).toBe(
			"unsupported-option",
		);
	});

	it("swrSubscription refuses an unknown reconcile rather than silencing continuity-lost", () => {
		const fake = createFakeClient();
		const received: unknown[] = [];
		let thrown: unknown;
		try {
			const subscribe = swrSubscription(fake, () => request("c"), {
				reconcile: "invalidate" as never,
			});
			const dispose = subscribe("c", {
				next: (error: unknown) => {
					if (error) received.push(error);
				},
			});
			fake.setConnection("connected");
			fake.setContinuity("gap", "overflow");
			dispose();
		} catch (error) {
			thrown = error;
		}
		const loud =
			(thrown as { code?: string } | undefined)?.code ===
				"unsupported-option" ||
			received.some(
				(error) => (error as { code?: string }).code === "continuity-lost",
			);
		expect(loud).toBe(true);
	});
});

describe("consistency: a changed consumer updates without resubscribing", () => {
	it("Vue: removing the consumer option is a change and reaches subscription.update", async () => {
		const fake = createFakeClient();
		const options = ref<vue.UseSubscriptionOptions>({
			consumer: { intervalMs: 1_000 },
		});
		const scope = effectScope();
		scope.run(() => vue.useSubscription(fake, request("v"), () => {}, options));
		await nextTick();
		options.value = { consumer: { intervalMs: 2_000 } };
		await nextTick();
		options.value = {};
		await nextTick();
		const updates = fake.active()[0]?.updates ?? [];
		scope.stop();
		expect(fake.counts.subscribes).toBe(1);
		expect(updates).toHaveLength(2);
	});
});

describe("a live value is never seeded or shared", () => {
	it("Svelte liveStore: a later subscriber starts at initial, not at another subscriber's value", async () => {
		const fake = createFakeClient();
		const store = svelte.liveStore<{ n: number }>(fake, request("s"), {
			initial: { n: 0 },
		});
		const first: unknown[] = [];
		const offFirst = store.subscribe((value) => first.push(value.data));
		await Promise.resolve();
		fake.emit({ n: 7 });
		const second: unknown[] = [];
		const offSecond = store.subscribe((value) => second.push(value.data));
		offSecond();
		offFirst();
		expect(first.at(-1)).toEqual({ n: 7 });
		expect(second[0]).toEqual({ n: 0 });
	});
});

type Connection = AdapterConnection<
	AiSubscriptionSpec,
	unknown,
	AiCommandPayload,
	AiCommandResult
>;
const API = "https://chat.example/api/chat";
const RESUME = "https://chat.example/api/chat/c1/stream";
const bearer = (): Credentials => ({
	headers: { authorization: "Bearer t-1" },
});
const commandOptions = {
	id: "cmd",
	signal: new AbortController().signal,
	timeoutMs: 30_000,
};

function aiConnect(options: Parameters<typeof fakeContext>[0] = {}) {
	const adapter = aiSdkAdapter();
	const context = fakeContext(options);
	const connection = adapter.connect({ api: API }, context.ctx) as Connection;
	return { connection, context };
}

describe("AI SDK edges", () => {
	it("a resume answered 403 rejects nothing and carries no body", async () => {
		vi.stubGlobal(
			"fetch",
			async () => new Response(`forbidden ${SECRET}`, { status: 403 }),
		);
		const { connection, context } = aiConnect({ credentials: bearer });
		const sink = recordingSink();
		connection.subscribe(
			{ kind: "resume", url: RESUME, nonce: "shared" },
			sink as never,
			{ key: "k", repeatable: false },
		);
		await sink.done;
		expect(context.rejected).toBe(0);
		expect(JSON.stringify(sink)).not.toContain("sk-live");
		connection.dispose();
	});

	it("a browser-style refused redirect (plain TypeError) on a start with provider headers is reported as a redirect", async () => {
		// Browsers reject `redirect: "error"` with a TypeError that has no cause.
		vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
			if (init.redirect === "error") throw new TypeError("Failed to fetch");
			return new Response("", { status: 302 });
		});
		const { connection } = aiConnect({ credentials: bearer });
		const outcome = await connection.command?.(
			{
				type: "start",
				chatId: "c1",
				generationId: "g-redirect",
				body: "{}",
			},
			commandOptions,
		);
		connection.dispose();
		expect(outcome).toMatchObject({
			error: { detail: { reason: "redirect" } },
		});
	});
});
