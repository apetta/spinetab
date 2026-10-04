import { describe, expect, it, vi } from "vitest";
import {
	createApp,
	defineComponent,
	effectScope,
	h,
	nextTick,
	ref,
	shallowRef,
} from "vue";
import {
	INACTIVE_STATUS,
	useSpinetabStatus,
	useSubscription,
} from "../../src/bindings/vue/index.ts";
import type { SubscriptionRequest } from "../../src/core/types.ts";
import {
	createFakeClient,
	feed,
	macrotask,
	request,
} from "./helpers/fake-client.ts";

// DOM-V-01…03: the real Vue 3.5 runtime (browser build) in happy-dom.

describe("useSubscription (Vue)", () => {
	it("DOM-V-01 an effectScope starts at once and scope.stop() releases", async () => {
		const client = createFakeClient();
		const scope = effectScope();
		const result = scope.run(() =>
			useSubscription(client, request("a"), { next: vi.fn() }),
		);
		expect(client.active()).toHaveLength(1);
		expect(result?.status.value.connection.state).toBe("connecting");
		scope.stop();
		expect(client.counts.unsubscribes).toBe(1);
		expect(result?.status.value).toBe(INACTIVE_STATUS);
		await macrotask();
		expect(client.upstream()).toEqual([]);
	});

	it("DOM-V-01 without a scope it warns and returns an explicit dispose", () => {
		const client = createFakeClient();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const result = useSubscription(client, request("a"), { next: vi.fn() });
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]?.[0]).toContain("without an active effect scope");
		expect(client.active()).toHaveLength(1);
		result.dispose();
		result.dispose();
		expect(client.counts.unsubscribes).toBe(1);
		warn.mockRestore();
	});

	it("DOM-V-02 getter input: identity change swaps once, equal objects do not, callbacks are read at delivery", async () => {
		const client = createFakeClient();
		const input = shallowRef<SubscriptionRequest<{ n: number }> | null>(
			request("a"),
		);
		const observer = { next: vi.fn() };
		const scope = effectScope();
		const result = scope.run(() =>
			useSubscription(client, () => input.value, observer),
		);
		input.value = { ...request("a") };
		await nextTick();
		expect(client.counts.subscribes).toBe(1);
		input.value = request("b");
		await nextTick();
		expect(client.counts.subscribes).toBe(2);
		expect(client.counts.unsubscribes).toBe(1);
		const replacement = vi.fn();
		observer.next = replacement;
		client.emit({ n: 1 });
		expect(replacement).toHaveBeenCalledTimes(1);
		input.value = null;
		await nextTick();
		expect(client.active()).toHaveLength(0);
		expect(result?.status.value).toBe(INACTIVE_STATUS);
		expect(result?.subscription.value).toBeNull();
		scope.stop();
	});

	it("DOM-V-03 a component starts on mount, exposes a reactive status and releases on unmount", async () => {
		const client = createFakeClient({ leaky: true });
		const next = vi.fn();
		const topic = ref("a");
		let setupSubscribes = -1;
		const Probe = defineComponent({
			setup() {
				// biome-ignore lint/correctness/useHookAtTopLevel: Vue composable in setup(), not a React hook.
				const { status } = useSubscription(client, () => request(topic.value), {
					next,
				});
				// biome-ignore lint/correctness/useHookAtTopLevel: Vue composable in setup(), not a React hook.
				const client_ = useSpinetabStatus(client);
				setupSubscribes = client.counts.subscribes;
				return () =>
					h(
						"output",
						`${status.value.connection.state}/${status.value.continuity.state}/${client_.status.value.mode}`,
					);
			},
		});
		const host = document.createElement("div");
		const app = createApp(Probe);
		app.mount(host);
		// Nothing was started during setup: live work begins in onMounted.
		expect(setupSubscribes).toBe(0);
		expect(client.counts.subscribes).toBe(1);
		await nextTick();
		expect(host.textContent).toBe("connecting/continuous/shared");
		client.setConnection("connected");
		client.setContinuity("unknown", "reconnected");
		await nextTick();
		expect(host.textContent).toBe("connected/unknown/shared");
		topic.value = "b";
		await nextTick();
		expect(client.counts.subscribes).toBe(2);
		app.unmount();
		expect(client.counts.unsubscribes).toBe(2);
		client.emit({ n: 9 });
		expect(next).not.toHaveBeenCalled();
	});
});

// a source is a request or a feed, and an observer is a function
// or an object. The key comes from the normalised request.
describe("useSubscription (Vue) with a source and a function observer", () => {
	it("a function observer on a feed receives each event and its meta", () => {
		const client = createFakeClient();
		const seen: Array<[unknown, unknown]> = [];
		const scope = effectScope();
		scope.run(() =>
			useSubscription(client, feed("a"), (event, meta) => {
				seen.push([event, meta]);
			}),
		);
		expect(client.active().map((consumer) => consumer.request)).toEqual([
			request("a"),
		]);
		client.emit({ n: 1 });
		expect(seen).toEqual([[{ n: 1 }, { seq: 1 }]]);
		scope.stop();
		expect(client.counts.unsubscribes).toBe(1);
	});

	it("a getter that rebuilds its feed on every run does not resubscribe", async () => {
		const client = createFakeClient();
		const topic = ref("a");
		const tick = ref(0);
		let runs = 0;
		const next = vi.fn();
		const scope = effectScope();
		scope.run(() =>
			useSubscription(
				client,
				() => {
					runs += 1;
					void tick.value;
					return feed(topic.value);
				},
				next,
			),
		);
		for (const value of [1, 2, 3]) {
			tick.value = value;
			await nextTick();
		}
		expect(runs).toBe(4);
		expect(client.counts.subscribes).toBe(1);
		topic.value = "b";
		await nextTick();
		expect(client.counts.subscribes).toBe(2);
		expect(client.counts.unsubscribes).toBe(1);
		expect(client.active().map((consumer) => consumer.request)).toEqual([
			request("b"),
		]);
		client.emit({ n: 1 });
		expect(next).toHaveBeenCalledWith({ n: 1 }, expect.anything());
		scope.stop();
	});

	it("an object observer on a feed keeps next, error and status", () => {
		const client = createFakeClient();
		const observer = { next: vi.fn(), error: vi.fn(), status: vi.fn() };
		const scope = effectScope();
		scope.run(() => useSubscription(client, feed("a"), observer));
		client.emit({ n: 1 });
		client.setConnection("connected");
		client.fail({ code: "upstream-error", message: "boom" });
		expect(observer.next).toHaveBeenCalledWith({ n: 1 }, { seq: 1 });
		expect(observer.status).toHaveBeenCalledWith(
			expect.objectContaining({
				connection: expect.objectContaining({ state: "connected" }),
			}),
		);
		expect(observer.error).toHaveBeenCalledWith({
			code: "upstream-error",
			message: "boom",
		});
		scope.stop();
	});
});
