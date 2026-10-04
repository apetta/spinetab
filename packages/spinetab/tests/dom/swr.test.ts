import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SWRConfig } from "swr";
import useSWRSubscription from "swr/subscription";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { isSpinetabError } from "../../src/core/errors.ts";
import type { Continuity, SubscriptionStatus } from "../../src/core/types.ts";
import {
	type SwrSubscriptionControls,
	swrSubscription,
} from "../../src/integrations/swr/index.ts";
import {
	createFakeClient,
	type FakeClient,
	feed,
	macrotask,
	request,
} from "./helpers/fake-client.ts";

// DOM-SWR-01…05, 08…09, 12: the real swr 2.5.1 `useSWRSubscription` on React 19.

beforeAll(() => {
	(
		globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
	).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | undefined;
afterEach(() => {
	act(() => root?.unmount());
	root = undefined;
});

function render(element: ReturnType<typeof createElement>) {
	const container = document.createElement("div");
	root = createRoot(container);
	act(() => root?.render(element));
	return container;
}

/** A fresh SWR cache, so data from another test's key cannot leak in. */
const isolated = (element: ReturnType<typeof createElement>) =>
	createElement(SWRConfig, { value: { provider: () => new Map() } }, element);

type Tick = { n: number };
const results: Array<{ data?: unknown; error?: unknown }> = [];

function makeView(
	subscribe: ReturnType<typeof swrSubscription<string, Tick, unknown>>,
) {
	return function View({ id }: { id: string }) {
		const { data, error } = useSWRSubscription(id, subscribe);
		results.push({ data, error });
		return createElement(
			"output",
			null,
			JSON.stringify({
				data,
				error: error ? String((error as Error).message) : null,
			}),
		);
	};
}

const bridge = (
	client: FakeClient,
	options: Parameters<typeof swrSubscription<string, Tick, unknown>>[2] = {},
) =>
	swrSubscription<string, Tick, unknown>(
		client,
		(key) => request(key),
		options,
	);

describe("swrSubscription", () => {
	it("DOM-SWR-01 returns dispose synchronously; disposing before any event means next is never called", () => {
		const client = createFakeClient({ leaky: true });
		const next = vi.fn();
		const dispose = bridge(client)("a", { next });
		expect(dispose).toBeTypeOf("function");
		dispose();
		client.emit({ n: 1 });
		client.fail({ code: "upstream-error", message: "x" });
		expect(next).not.toHaveBeenCalled();
		expect(client.counts.unsubscribes).toBe(1);
	});

	it("DOM-SWR-01 consumer count follows SWR's reference count, including Strict Mode", async () => {
		const client = createFakeClient();
		const View = makeView(bridge(client));
		render(
			createElement(
				StrictMode,
				null,
				createElement(View, { id: "a" }),
				createElement(View, { id: "a" }),
			),
		);
		expect(client.active()).toHaveLength(1);
		act(() => root?.unmount());
		root = undefined;
		expect(client.active()).toHaveLength(0);
		await macrotask();
		expect(client.upstream()).toEqual([]);
	});

	it("DOM-SWR-02 separate cache providers get separate consumers on one upstream", () => {
		const client = createFakeClient();
		const View = makeView(bridge(client));
		const provider = () => new Map();
		render(
			createElement(
				"div",
				null,
				createElement(
					SWRConfig,
					{ value: { provider } },
					createElement(View, { id: "a" }),
				),
				createElement(
					SWRConfig,
					{ value: { provider } },
					createElement(View, { id: "a" }),
				),
			),
		);
		expect(client.active()).toHaveLength(2);
		expect(client.upstream()).toHaveLength(1);
	});

	it("DOM-SWR-03 maps events and updaters to data; errors only on terminal outcomes", () => {
		const client = createFakeClient();
		const View = makeView(
			bridge(client, {
				map: (event) => (current?: unknown) => [
					...((current as Tick[]) ?? []),
					event,
				],
			}),
		);
		const container = render(createElement(View, { id: "a" }));
		act(() => client.emit({ n: 1 }));
		act(() => client.emit({ n: 2 }));
		expect(JSON.parse(container.textContent ?? "")).toEqual({
			data: [{ n: 1 }, { n: 2 }],
			error: null,
		});
		for (const state of [
			"reconnecting",
			"retry-exhausted",
			"auth-blocked",
		] as const) {
			act(() => client.setConnection(state));
			expect(JSON.parse(container.textContent ?? "").error).toBeNull();
		}
		act(() => client.setConnection("failed", "permanent-error"));
		expect(JSON.parse(container.textContent ?? "").error).toContain("failed");
		// Data is kept alongside the error.
		expect(JSON.parse(container.textContent ?? "").data).toHaveLength(2);
		act(() =>
			client.fail({
				code: "subscribe-rejected",
				message: "Rejected by server",
			}),
		);
		expect(JSON.parse(container.textContent ?? "").error).toBe(
			"Rejected by server",
		);
		expect(client.active()).toHaveLength(1);
	});

	it("DOM-SWR-04 continuity loss is an error until the next data, while the status stays sticky", () => {
		const client = createFakeClient();
		const View = makeView(bridge(client));
		results.length = 0;
		const container = render(isolated(createElement(View, { id: "a" })));
		// A gap that does not stop delivery (runtime replacement).
		act(() => client.setContinuity("gap", "runtime-replaced"));
		const lost = results.at(-1)?.error;
		expect(isSpinetabError(lost, "continuity-lost")).toBe(true);
		act(() => client.setContinuity("gap", "runtime-replaced"));
		act(() => client.emit({ n: 5 }));
		expect(JSON.parse(container.textContent ?? "")).toEqual({
			data: { n: 5 },
			error: null,
		});
		expect(client.active()[0]?.status.get().continuity.state).toBe("gap");
		const errors = results.filter((result) =>
			isSpinetabError(result.error, "continuity-lost"),
		);
		expect(new Set(errors.map((result) => result.error)).size).toBe(1);
		expect(client.active()[0]?.reconciled).toBe(0);
	});

	it("DOM-SWR-04 with onContinuity the loss goes to the callback with recovery controls, not to SWR error; the helper never reconciles", () => {
		const client = createFakeClient();
		const onContinuity = vi.fn();
		const View = makeView(bridge(client, { onContinuity }));
		const container = render(isolated(createElement(View, { id: "a" })));
		// The same notice twice (same since) is reported once.
		const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
		act(() => client.setContinuity("unknown", "reconnected"));
		act(() => client.setContinuity("unknown", "reconnected"));
		now.mockRestore();
		expect(onContinuity).toHaveBeenCalledTimes(1);
		expect(onContinuity).toHaveBeenCalledWith(
			expect.objectContaining({ state: "unknown", reason: "reconnected" }),
			"a",
			{ markReconciled: expect.any(Function), retry: expect.any(Function) },
		);
		expect(JSON.parse(container.textContent ?? "").error).toBeNull();
		act(() => client.emit({ n: 1 }));
		expect(client.active()[0]?.reconciled).toBe(0);
		expect(client.counts.retries).toBe(0);
	});

	it("DOM-SWR-05 after an oversized event delivery stays stopped (retry included) until the app calls markReconciled; every hook on the key resumes without remounting", () => {
		const client = createFakeClient();
		const seen = new Set<SwrSubscriptionControls>();
		let controls: SwrSubscriptionControls | undefined;
		const onContinuity = vi.fn(
			(
				_continuity: Continuity,
				_key: string,
				tools: SwrSubscriptionControls,
			) => {
				controls = tools;
				seen.add(tools);
			},
		);
		const onStatus = vi.fn(
			(
				_status: SubscriptionStatus,
				_key: string,
				tools: SwrSubscriptionControls,
			) => seen.add(tools),
		);
		const View = makeView(bridge(client, { onContinuity, onStatus }));
		const container = render(
			isolated(
				createElement(
					StrictMode,
					null,
					createElement(View, { id: "feed" }),
					createElement(View, { id: "feed" }),
				),
			),
		);
		const text = () =>
			Array.from(container.querySelectorAll("output"), (node) =>
				JSON.parse(node.textContent ?? ""),
			);
		expect(client.active()).toHaveLength(1);
		act(() => client.emit({ n: 1 }));
		act(() => client.setContinuity("gap", "message-too-large"));
		expect(onContinuity).toHaveBeenCalledTimes(1);
		act(() => client.emit({ n: 2 }));
		act(() => controls?.retry());
		// The controls retry this subscription only, never the whole client.
		expect(client.consumers[0]?.retries).toBe(1);
		expect(client.counts.retries).toBe(0);
		act(() => client.emit({ n: 3 }));
		expect(text()).toEqual([
			{ data: { n: 1 }, error: null },
			{ data: { n: 1 }, error: null },
		]);
		expect(client.active()[0]?.reconciled).toBe(0);

		// The application reconciles its own data, then resumes delivery.
		act(() => controls?.markReconciled());
		expect(client.active()[0]?.status.get().continuity).toMatchObject({
			state: "continuous",
			reason: "reconciled",
		});
		act(() => client.emit({ n: 4 }));
		expect(text()).toEqual([
			{ data: { n: 4 }, error: null },
			{ data: { n: 4 }, error: null },
		]);
		expect(client.counts.subscribes).toBe(1);
		expect(client.active()[0]?.reconciled).toBe(1);
		// One controls object per subscription, shared by both callbacks.
		expect(seen.size).toBe(1);

		// A later episode reaches onContinuity again.
		act(() => client.setContinuity("gap", "overflow"));
		expect(onContinuity).toHaveBeenCalledTimes(2);

		// Disposal is synchronous and leaves the controls inert.
		act(() => root?.unmount());
		root = undefined;
		expect(client.active()).toHaveLength(0);
		controls?.markReconciled();
		controls?.retry();
		expect(client.consumers[0]?.reconciled).toBe(1);
		expect(client.consumers[0]?.retries).toBe(1);
	});

	it("DOM-SWR-05 without onContinuity the continuity-lost error stays until the app reconciles through the onStatus controls", () => {
		const client = createFakeClient();
		let controls: SwrSubscriptionControls | undefined;
		const View = makeView(
			bridge(client, {
				onStatus: (_status, _key, tools) => {
					controls = tools;
				},
			}),
		);
		const container = render(isolated(createElement(View, { id: "b" })));
		const state = () => JSON.parse(container.textContent ?? "");
		act(() => client.emit({ n: 1 }));
		act(() => client.setContinuity("gap", "overflow"));
		act(() => client.emit({ n: 2 }));
		expect(state().data).toEqual({ n: 1 });
		expect(state().error).toContain("markReconciled()");
		act(() => controls?.markReconciled());
		// Reconciling does not raise another error; the next data clears it.
		expect(state().error).toContain("markReconciled()");
		act(() => client.emit({ n: 3 }));
		expect(state()).toEqual({ data: { n: 3 }, error: null });
	});

	it("DOM-SWR-08 inline markReconciled from onContinuity handles every same-reason gap, not only the first", () => {
		const client = createFakeClient();
		const onContinuity = vi.fn(
			(_continuity: Continuity, _key: string, tools: SwrSubscriptionControls) =>
				tools.markReconciled(),
		);
		const View = makeView(bridge(client, { onContinuity }));
		const container = render(isolated(createElement(View, { id: "inline" })));
		const state = () => JSON.parse(container.textContent ?? "");
		act(() => client.emit({ n: 1 }));
		for (const episode of [1, 2]) {
			act(() => client.setContinuity("gap", "message-too-large"));
			expect(onContinuity).toHaveBeenCalledTimes(episode);
			expect(client.active()[0]?.status.get().continuity).toMatchObject({
				state: "continuous",
				reason: "reconciled",
			});
			act(() => client.emit({ n: episode + 1 }));
			expect(state()).toEqual({ data: { n: episode + 1 }, error: null });
		}
		// Only the application's two inline calls reconciled.
		expect(client.active()[0]?.reconciled).toBe(2);
		expect(client.counts.retries).toBe(0);
	});

	it("DOM-SWR-09 onStatus re-entry: inline markReconciled re-arms the next same-reason gap; a resolved loss is not reported late; a nested same-gap status keeps the notice", () => {
		// Without onContinuity: each episode raises its own continuity-lost error.
		const client = createFakeClient();
		const statuses: string[] = [];
		const View = makeView(
			bridge(client, {
				onStatus: (status, _key, tools) => {
					statuses.push(status.continuity.state);
					if (status.continuity.state === "gap") tools.markReconciled();
				},
			}),
		);
		results.length = 0;
		const container = render(isolated(createElement(View, { id: "status" })));
		const state = () => JSON.parse(container.textContent ?? "");
		act(() => client.emit({ n: 1 }));
		for (const episode of [1, 2]) {
			act(() => client.setContinuity("gap", "overflow"));
			act(() => client.emit({ n: episode + 1 }));
			expect(state()).toEqual({ data: { n: episode + 1 }, error: null });
		}
		const lost = new Set(
			results
				.map((result) => result.error)
				.filter((error) => isSpinetabError(error, "continuity-lost")),
		);
		expect(lost.size).toBe(2);
		expect(statuses).toEqual(["gap", "continuous", "gap", "continuous"]);
		expect(client.active()[0]?.reconciled).toBe(2);

		// With onContinuity too: a loss onStatus already reconciled is not
		// reported afterwards, and the next gap is still reported.
		const second = createFakeClient();
		const onContinuity = vi.fn();
		let reconcileInline = true;
		const dispose = bridge(second, {
			onContinuity,
			onStatus: (status, _key, tools) => {
				if (reconcileInline && status.continuity.state === "gap")
					tools.markReconciled();
			},
		})("resolved", { next: vi.fn() });
		second.setContinuity("gap", "overflow");
		expect(onContinuity).not.toHaveBeenCalled();
		reconcileInline = false;
		second.setContinuity("gap", "overflow");
		expect(onContinuity).toHaveBeenCalledTimes(1);
		expect(onContinuity).toHaveBeenCalledWith(
			expect.objectContaining({ state: "gap", reason: "overflow" }),
			"resolved",
			expect.anything(),
		);
		dispose();

		// A nested status with the same gap (e.g. a synchronous connection
		// change) neither drops nor duplicates the pending notice.
		const third = createFakeClient();
		const notices = vi.fn();
		let nested = false;
		const disposeThird = bridge(third, {
			onContinuity: notices,
			onStatus: (status) => {
				if (!nested && status.continuity.state === "gap") {
					nested = true;
					third.setConnection("reconnecting");
				}
			},
		})("nested", { next: vi.fn() });
		third.setContinuity("gap", "runtime-replaced");
		expect(notices).toHaveBeenCalledTimes(1);
		expect(notices.mock.calls[0]?.[0]).toMatchObject({
			state: "gap",
			reason: "runtime-replaced",
		});
		disposeThird();
	});

	it("DOM-SWR-12 the reconnect outcome after an early notice with the same state and reason is reported again", () => {
		const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
		// With onContinuity: a reconcile started on the early notice, while the
		// upstream is down, is followed by a second call for the outcome.
		const client = createFakeClient();
		const refetches: Array<() => void> = [];
		const notices: Continuity[] = [];
		const dispose = bridge(client, {
			onContinuity: (continuity, _key, controls) => {
				notices.push(continuity);
				refetches.push(() => controls.markReconciled());
			},
		})("outage", { next: vi.fn() });
		client.setConnection("connected");
		now.mockReturnValue(2_000);
		client.setContinuity("unknown", "reconnected");
		client.setConnection("reconnecting");
		now.mockReturnValue(3_000);
		client.setContinuity("unknown", "reconnected");
		client.setConnection("connected");
		expect(notices).toMatchObject([
			{ state: "unknown", reason: "reconnected", since: 2_000 },
			{ state: "unknown", reason: "reconnected", since: 3_000 },
		]);
		for (const refetched of refetches) refetched();
		expect(client.active()[0]?.reconciled).toBe(2);
		// A genuine duplicate (same since), including a redelivery with a
		// connection change, is reported once.
		now.mockReturnValue(4_000);
		client.setContinuity("unknown", "reconnected");
		client.setContinuity("unknown", "reconnected");
		client.setConnection("reconnecting");
		expect(notices).toHaveLength(3);
		// A same-reason gap repeat (a stopped subscription's missed-count
		// update) stays coalesced until the application reconciles.
		now.mockReturnValue(5_000);
		client.setContinuity("gap", "overflow");
		now.mockReturnValue(6_000);
		client.setContinuity("gap", "overflow");
		expect(notices).toHaveLength(4);
		dispose();

		// Without onContinuity: the outcome raises its own continuity-lost error
		// (a data event may have cleared the first); its repeat does not.
		const plain = createFakeClient();
		const next = vi.fn();
		const disposePlain = bridge(plain)("plain", { next });
		now.mockReturnValue(7_000);
		plain.setContinuity("unknown", "reconnected");
		now.mockReturnValue(8_000);
		plain.setContinuity("unknown", "reconnected");
		plain.setContinuity("unknown", "reconnected");
		const errors = next.mock.calls
			.map(([error]) => error)
			.filter((error) => isSpinetabError(error, "continuity-lost"));
		expect(errors).toHaveLength(2);
		disposePlain();
	});
});

describe("swrSubscription with a source", () => {
	it("requestFor may return a feed; the bridge subscribes its normalised request", () => {
		const client = createFakeClient();
		const View = makeView(
			swrSubscription<string, Tick, unknown>(client, (key) => feed(key)),
		);
		const container = render(isolated(createElement(View, { id: "a" })));
		expect(client.active().map((consumer) => consumer.request)).toEqual([
			request("a"),
		]);
		act(() => client.emit({ n: 1 }));
		expect(JSON.parse(container.textContent ?? "")).toEqual({
			data: { n: 1 },
			error: null,
		});
	});
});
