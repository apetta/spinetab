import { describe, expect, it, vi } from "vitest";
import {
	createApp,
	defineComponent,
	effectScope,
	h,
	nextTick,
	onErrorCaptured,
	ref,
} from "vue";
import {
	bindClient,
	type UseSubscriptionOptions,
	useLive,
	useSubscription,
} from "../../src/bindings/vue/index.ts";
import { createFakeClient, feed } from "./helpers/fake-client.ts";

type Tick = { n: number };

function inScope<T>(run: () => T): { value: T; stop(): void } {
	const scope = effectScope();
	const value = scope.run(run) as T;
	return { value, stop: () => scope.stop() };
}

describe("bindClient (Vue)", () => {
	it("bindClient returns the composables with the client applied and starts nothing", () => {
		const client = createFakeClient();
		const bound = bindClient(client);
		expect(Object.keys(bound).sort()).toEqual([
			"useLive",
			"useSpinetabStatus",
			"useSubscription",
		]);
		expect(client.counts.subscribes).toBe(0);
		const next = vi.fn();
		const scope = inScope(() => ({
			sub: bound.useSubscription(feed("a"), next),
			live: bound.useLive(feed("a")),
			status: bound.useSpinetabStatus(),
		}));
		client.emit({ n: 1 });
		expect(next).toHaveBeenCalledTimes(1);
		expect(scope.value.live.data.value).toEqual({ n: 1 });
		expect(scope.value.status.status.value.mode).toBe("shared");
		scope.stop();
		expect(client.active()).toHaveLength(0);
	});
});

describe("useSubscription options (Vue)", () => {
	it("reactive options update the consumer without resubscribing; equal values never update", async () => {
		const client = createFakeClient();
		const options = ref<UseSubscriptionOptions>({
			consumer: { intervalMs: 1_000 },
		});
		const scope = inScope(() =>
			useSubscription(client, feed("a"), () => {}, options),
		);
		options.value = { consumer: { intervalMs: 1_000 } };
		await nextTick();
		expect(client.active()[0]?.updates).toEqual([]);
		options.value = { consumer: { intervalMs: 5_000 } };
		await nextTick();
		expect(client.counts.subscribes).toBe(1);
		expect(client.active()[0]?.updates).toEqual([{ intervalMs: 5_000 }]);
		scope.stop();
	});

	it("false disables like null", async () => {
		const client = createFakeClient();
		const on = ref(false);
		const scope = inScope(() =>
			useSubscription(
				client,
				() => on.value && feed("a"),
				() => {},
			),
		);
		expect(client.counts.subscribes).toBe(0);
		on.value = true;
		await nextTick();
		expect(client.active()).toHaveLength(1);
		on.value = false;
		await nextTick();
		expect(client.active()).toHaveLength(0);
		scope.stop();
	});

	it('reconcile "latest": a loss restarts delivery and the next event reconciles', () => {
		const client = createFakeClient();
		const scope = inScope(() =>
			useSubscription(client, feed("a"), () => {}, { reconcile: "latest" }),
		);
		client.setContinuity("gap", "overflow");
		expect(client.active()[0]?.pendingReconciles).toBe(1);
		client.emit({ n: 1 });
		expect(scope.value.status.value.continuity.state).toBe("continuous");
		scope.stop();
	});

	it.each([
		"observer",
		"connection",
	] as const)("throwOnError throws a terminal error to onErrorCaptured, never a loss (%s)", async (source) => {
		const client = createFakeClient();
		const captured: unknown[] = [];
		const Child = defineComponent({
			setup() {
				// biome-ignore lint/correctness/useHookAtTopLevel: Vue composable in setup(), not a React hook.
				useSubscription(client, feed("a"), () => {}, { throwOnError: true });
				return () => h("p", "ok");
			},
		});
		const Parent = defineComponent({
			setup() {
				onErrorCaptured((error) => {
					captured.push(error);
					return false;
				});
				return () => h(Child);
			},
		});
		const app = createApp(Parent);
		app.mount(document.createElement("div"));
		client.setContinuity("gap", "overflow");
		client.setConnection("retry-exhausted");
		await nextTick();
		expect(captured).toEqual([]);
		source === "observer"
			? client.fail({ code: "subscribe-rejected", message: "no" })
			: client.setConnection("failed", "permanent-error");
		await nextTick();
		expect(captured).toHaveLength(1);
		expect(captured[0]).toMatchObject({
			code: source === "observer" ? "subscribe-rejected" : "upstream-error",
		});
		app.unmount();
	});

	it("without an error hook a terminal error is rethrown into the client's callback guard", () => {
		const client = createFakeClient();
		const hook = vi.fn();
		const scope = inScope(() => {
			useSubscription(client, feed("a"), () => {});
			useSubscription(client, feed("b"), { next() {}, error: hook });
		});
		const [bare, hooked] = client.active();
		expect(() =>
			bare?.observer.error?.({ code: "subscribe-rejected", message: "no" }),
		).toThrow(expect.objectContaining({ code: "subscribe-rejected" }));
		hooked?.observer.error?.({ code: "subscribe-rejected", message: "no" });
		expect(hook).toHaveBeenCalledTimes(1);
		scope.stop();
	});

	it("retry reaches only its own subscription", () => {
		const client = createFakeClient();
		const scope = inScope(() => [
			useSubscription(client, feed("a"), () => {}),
			useSubscription(client, feed("b"), () => {}),
		]);
		scope.value[0]?.retry();
		expect(client.active().map((consumer) => consumer.retries)).toEqual([1, 0]);
		expect(client.counts.retries).toBe(0);
		scope.stop();
	});
});

describe("useLive (Vue)", () => {
	it("data follows map from initial; an identity change resets it at once", async () => {
		const client = createFakeClient();
		const topic = ref("a");
		const scope = inScope(() =>
			useLive<Tick, number>(client, () => feed(topic.value), {
				initial: 0,
				map: (tick) => tick.n * 10,
			}),
		);
		expect(scope.value.data.value).toBe(0);
		client.emit({ n: 2 });
		expect(scope.value.data.value).toBe(20);
		topic.value = "b";
		// Read before any watcher ran: already the initial value.
		expect(scope.value.data.value).toBe(0);
		await nextTick();
		client.emit({ n: 3 });
		expect(scope.value.data.value).toBe(30);
		scope.stop();
	});

	it("reduce accumulates; a second mount is never seeded", () => {
		const client = createFakeClient();
		const reduce = (current: number[] | undefined, tick: Tick) =>
			tick.n < 0 ? undefined : [...(current ?? []), tick.n];
		const first = inScope(() => useLive(client, feed("a"), { reduce }));
		client.emit({ n: 1 });
		client.emit({ n: -1 });
		client.emit({ n: 2 });
		expect(first.value.data.value).toEqual([1, 2]);
		const late = inScope(() => useLive(client, feed("a"), { reduce }));
		expect(late.value.data.value).toBeUndefined();
		first.stop();
		late.stop();
	});

	it("an unreconciled loss without a policy is continuity-lost with needsReconcile; markReconciled clears it", () => {
		const client = createFakeClient();
		const scope = inScope(() => useLive<Tick>(client, feed("a")));
		client.setContinuity("unknown", "reconnected");
		const live = scope.value;
		expect(live.error.value?.code).toBe("continuity-lost");
		expect(live.needsReconcile.value).toBe(true);
		const first = live.error.value;
		client.setConnection("connected");
		expect(live.error.value).toBe(first);
		live.markReconciled();
		expect(live.error.value).toBeUndefined();
		expect(live.needsReconcile.value).toBe(false);
		scope.stop();
	});

	it("with a policy a loss is no error; a terminal error is a value", () => {
		const client = createFakeClient();
		const scope = inScope(() =>
			useLive<Tick>(client, feed("a"), { reconcile: "latest" }),
		);
		client.setContinuity("gap", "overflow");
		expect(scope.value.error.value).toBeUndefined();
		expect(scope.value.needsReconcile.value).toBe(true);
		client.fail({ code: "upstream-error", message: "boom" });
		expect(scope.value.error.value?.code).toBe("upstream-error");
		scope.stop();
	});
});
