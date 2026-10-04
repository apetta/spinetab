import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SWRConfig } from "swr";
import useSWRSubscription from "swr/subscription";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SubscriptionSink } from "../../src/core/adapter.ts";
import {
	browserEnv,
	type ClientEnv,
	createClientWithEnv,
} from "../../src/core/client.ts";
import { isSpinetabError } from "../../src/core/errors.ts";
import { createRuntime, type Runtime } from "../../src/core/runtime.ts";
import type { Continuity, SpinetabClient } from "../../src/core/types.ts";
import {
	type SwrSubscriptionControls,
	swrSubscription,
} from "../../src/integrations/swr/index.ts";

// DOM-SWR-06…07, 10…11: the SWR helper over the REAL page client, bridge protocol
// (MessageChannel) and `createRuntime`, with a controlled upstream adapter.
// After an oversized event the runtime stops that consumer until
// `markReconciled()`; `client.retry()` restarts connections, not consumers.

type Tick = { n: number | string };

beforeAll(() => {
	(
		globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
	).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | undefined;
let client: SpinetabClient | undefined;
let runtime: Runtime | undefined;
afterEach(() => {
	act(() => root?.unmount());
	root = undefined;
	client?.dispose();
	runtime?.dispose();
	client = undefined;
	runtime = undefined;
});

const env: ClientEnv = {
	...browserEnv,
	isBrowser: () => true,
	hasSharedWorker: () => false,
	visible: () => true,
	baseUri: () => "https://example.test/",
	listen: () => () => {},
};

function setup() {
	const upstream: { sink?: SubscriptionSink<Tick>; subscriptions: number } = {
		subscriptions: 0,
	};
	const shared = createRuntime({
		adapters: [
			{
				kind: "controlled",
				version: 1,
				connect(_spec, context) {
					context.setStatus({ state: "connected" });
					return {
						subscribe(_spec, sink) {
							upstream.sink = sink as SubscriptionSink<Tick>;
							upstream.subscriptions += 1;
							return { unsubscribe() {} };
						},
						retry() {},
						dispose() {},
					};
				},
			},
		],
		limits: { maxMessageBytes: 128, lingerMs: 1, idleCloseMs: 1 },
	});
	runtime = shared;
	const page = createClientWithEnv(
		{ sharing: "off", local: async () => ({ runtime: () => shared }) },
		env,
	);
	client = page;
	return { client: page, runtime: shared, upstream };
}

const request = (key: string) => ({
	adapter: "controlled",
	connection: {},
	subscription: { key },
});
const oversized = { n: "x".repeat(1000) };
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 25));
async function until(check: () => boolean, label: string) {
	const end = Date.now() + 2000;
	while (!check()) {
		if (Date.now() > end) throw new Error(`Timed out: ${label}`);
		await act(pause);
	}
}

describe("swrSubscription over the real client and runtime", () => {
	it("DOM-SWR-06 message-too-large stops delivery; client.retry() does not resume it; the helper's markReconciled does", async () => {
		const { client, runtime, upstream } = setup();
		const received: Array<{ error?: unknown; value?: unknown }> = [];
		const notices: Array<[Continuity, string, SwrSubscriptionControls]> = [];
		const subscribe = swrSubscription<string, Tick>(client, request, {
			onContinuity: (continuity, key, controls) =>
				notices.push([continuity, key, controls]),
		});
		const dispose = subscribe("same-feed", {
			next: (error, value) => received.push({ error, value }),
		});
		expect(dispose).toBeTypeOf("function");

		await until(() => upstream.sink !== undefined, "registration");
		upstream.sink?.next({ n: 1 });
		await until(() => received.length === 1, "first event");
		upstream.sink?.next(oversized);
		await until(() => notices.length === 1, "oversized-event gap");
		expect(notices[0]?.[0]).toMatchObject({
			state: "gap",
			reason: "message-too-large",
		});
		expect(notices[0]?.[1]).toBe("same-feed");
		upstream.sink?.next({ n: 2 });
		await pause();
		expect(received).toHaveLength(1);

		client.retry();
		await pause();
		upstream.sink?.next({ n: 3 });
		await pause();
		expect(received).toHaveLength(1);

		// The application reconciles through the public helper route.
		notices[0]?.[2].markReconciled();
		await pause();
		upstream.sink?.next({ n: 4 });
		await until(() => received.length === 2, "delivery after reconciliation");
		expect(received.map((entry) => entry.value)).toEqual([{ n: 1 }, { n: 4 }]);
		expect(received.every((entry) => entry.error === null)).toBe(true);
		expect(notices).toHaveLength(1);
		expect(upstream.subscriptions).toBe(1);

		dispose();
		// Inert after synchronous disposal.
		notices[0]?.[2].markReconciled();
		await until(
			() => runtime.stats().consumers === 0,
			"consumer released on dispose",
		);
	});

	it("DOM-SWR-07 real useSWRSubscription hooks on one key resume together after the app reconciles, without remounting", async () => {
		const { client, runtime, upstream } = setup();
		let controls: SwrSubscriptionControls | undefined;
		const subscribe = swrSubscription<string, Tick>(client, request, {
			onContinuity: (_continuity, _key, tools) => {
				controls = tools;
			},
		});
		function View({ id }: { id: string }) {
			const { data, error } = useSWRSubscription(id, subscribe);
			return createElement(
				"output",
				null,
				JSON.stringify({ data: data ?? null, error: error ? "error" : null }),
			);
		}
		const container = document.createElement("div");
		root = createRoot(container);
		act(() =>
			root?.render(
				createElement(
					SWRConfig,
					{ value: { provider: () => new Map() } },
					createElement(
						StrictMode,
						null,
						createElement(View, { id: "same-feed" }),
						createElement(View, { id: "same-feed" }),
					),
				),
			),
		);
		const views = () =>
			Array.from(container.querySelectorAll("output"), (node) =>
				JSON.parse(node.textContent ?? ""),
			);
		const showing = (value: unknown) =>
			views().every(
				(view) => JSON.stringify(view.data) === JSON.stringify(value),
			);

		await until(() => upstream.sink !== undefined, "registration");
		await act(async () => upstream.sink?.next({ n: 1 }));
		await until(() => showing({ n: 1 }), "first event rendered");
		await act(async () => upstream.sink?.next(oversized));
		await until(() => controls !== undefined, "oversized-event gap");
		await act(async () => upstream.sink?.next({ n: 2 }));
		await act(pause);
		await act(async () => controls?.retry());
		await act(pause);
		await act(async () => upstream.sink?.next({ n: 3 }));
		await act(pause);
		expect(views()).toEqual([
			{ data: { n: 1 }, error: null },
			{ data: { n: 1 }, error: null },
		]);

		await act(async () => controls?.markReconciled());
		await act(pause);
		await act(async () => upstream.sink?.next({ n: 4 }));
		await until(() => showing({ n: 4 }), "delivery after reconciliation");
		expect(views()).toEqual([
			{ data: { n: 4 }, error: null },
			{ data: { n: 4 }, error: null },
		]);
		expect(upstream.subscriptions).toBe(1);
		expect(runtime.stats().consumers).toBe(1);

		act(() => root?.unmount());
		root = undefined;
		await until(
			() => runtime.stats().consumers === 0,
			"consumer released on unmount",
		);
	});

	it("DOM-SWR-10 inline onContinuity → markReconciled recovers every same-reason gap, not only the first", async () => {
		const { client, runtime, upstream } = setup();
		const received: unknown[] = [];
		const notices: Continuity[] = [];
		let last: Continuity | undefined;
		const subscribe = swrSubscription<string, Tick>(client, request, {
			onStatus: (status) => {
				last = status.continuity;
			},
			onContinuity: (continuity, _key, controls) => {
				notices.push(continuity);
				controls.markReconciled();
			},
		});
		const dispose = subscribe("same-feed", {
			next: (error, value) => {
				if (!error) received.push(value);
			},
		});
		await until(() => upstream.sink !== undefined, "registration");
		upstream.sink?.next({ n: 1 });
		await until(() => received.length === 1, "first event");
		for (const episode of [1, 2]) {
			upstream.sink?.next(oversized);
			await until(() => notices.length === episode, `gap ${episode} reported`);
			expect(notices[episode - 1]).toMatchObject({
				state: "gap",
				reason: "message-too-large",
			});
			await until(
				() => last?.state === "continuous",
				`reconciled status ${episode}`,
			);
			await pause();
			upstream.sink?.next({ n: episode + 1 });
			await until(
				() => received.length === episode + 1,
				`delivery after reconciliation ${episode}`,
			);
		}
		expect(received).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
		expect(upstream.subscriptions).toBe(1);
		dispose();
		await until(
			() => runtime.stats().consumers === 0,
			"consumer released on dispose",
		);
	});

	it("DOM-SWR-11 inline onStatus → markReconciled (no onContinuity) raises continuity-lost per episode and resumes delivery each time", async () => {
		const { client, runtime, upstream } = setup();
		const received: unknown[] = [];
		const errors: unknown[] = [];
		// Status states and SWR errors in the order the application saw them.
		const log: string[] = [];
		const subscribe = swrSubscription<string, Tick>(client, request, {
			onStatus: (status, _key, controls) => {
				log.push(status.continuity.state);
				if (status.continuity.state === "gap") controls.markReconciled();
			},
		});
		const dispose = subscribe("same-feed", {
			next: (error, value) => {
				if (error) {
					errors.push(error);
					log.push("error");
				} else received.push(value);
			},
		});
		await until(() => upstream.sink !== undefined, "registration");
		upstream.sink?.next({ n: 1 });
		await until(() => received.length === 1, "first event");
		for (const episode of [1, 2]) {
			upstream.sink?.next(oversized);
			await until(() => errors.length === episode, `gap ${episode} error`);
			expect(isSpinetabError(errors[episode - 1], "continuity-lost")).toBe(
				true,
			);
			await pause();
			upstream.sink?.next({ n: episode + 1 });
			await until(
				() => received.length === episode + 1,
				`delivery after reconciliation ${episode}`,
			);
		}
		expect(received).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
		expect(errors).toHaveLength(2);
		// The loss is never reported after the application reconciled it.
		expect(log.filter((entry) => entry !== "continuous")).toEqual([
			"error",
			"gap",
			"error",
			"gap",
		]);
		expect(log.at(-1)).toBe("continuous");
		dispose();
		await until(
			() => runtime.stats().consumers === 0,
			"consumer released on dispose",
		);
	});
});
