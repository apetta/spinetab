import { catchError, createRoot, createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import type { SubscriptionOptions } from "../../src/bindings/shared/live.ts";
import {
	bindClient,
	createLive,
	createSubscription,
} from "../../src/bindings/solid/index.ts";
import type { Source } from "../../src/core/types.ts";
import { createFakeClient, feed } from "./helpers/fake-client.ts";

type Tick = { n: number };

function owned<T>(run: () => T): { value: T; dispose(): void } {
	let value!: T;
	const dispose = createRoot((dispose) => {
		value = run();
		return dispose;
	});
	return { value, dispose };
}

describe("bindClient (Solid)", () => {
	it("bindClient returns the primitives with the client applied and starts nothing", () => {
		const client = createFakeClient();
		const bound = bindClient(client);
		expect(Object.keys(bound).sort()).toEqual([
			"createLive",
			"createSpinetabStatus",
			"createSubscription",
		]);
		expect(client.counts.subscribes).toBe(0);
		const next = vi.fn();
		const root = owned(() => ({
			sub: bound.createSubscription(feed("a"), next),
			live: bound.createLive(feed("a")),
			status: bound.createSpinetabStatus(),
		}));
		client.emit({ n: 1 });
		expect(next).toHaveBeenCalledTimes(1);
		expect(root.value.live.data()).toEqual({ n: 1 });
		expect(root.value.status.status().mode).toBe("shared");
		root.dispose();
		expect(client.active()).toHaveLength(0);
	});
});

describe("createSubscription options (Solid)", () => {
	it("accepts a value as well as an accessor", () => {
		const client = createFakeClient();
		const root = owned(() => createSubscription(client, feed("a"), () => {}));
		expect(client.active()).toHaveLength(1);
		expect(root.value.subscription()).not.toBeNull();
		root.dispose();
	});

	it("accessor options update the consumer without resubscribing; equal values never update", () => {
		const client = createFakeClient();
		const [options, setOptions] = createSignal<SubscriptionOptions>({
			consumer: { intervalMs: 1_000 },
		});
		const root = owned(() =>
			createSubscription(client, feed("a"), () => {}, options),
		);
		setOptions({ consumer: { intervalMs: 1_000 } });
		expect(client.active()[0]?.updates).toEqual([]);
		setOptions({ consumer: { intervalMs: 5_000 } });
		expect(client.counts.subscribes).toBe(1);
		expect(client.active()[0]?.updates).toEqual([{ intervalMs: 5_000 }]);
		root.dispose();
	});

	it("removing the consumer option is a change: update({}) restores the defaults", () => {
		const client = createFakeClient();
		const [options, setOptions] = createSignal<SubscriptionOptions>({
			consumer: { intervalMs: 1_000 },
		});
		const root = owned(() =>
			createSubscription(client, feed("a"), () => {}, options),
		);
		setOptions({});
		setOptions({});
		expect(client.counts.subscribes).toBe(1);
		expect(client.active()[0]?.updates).toEqual([{}]);
		root.dispose();
	});

	it("false disables like null", () => {
		const client = createFakeClient();
		const [on, setOn] = createSignal(false);
		const root = owned(() =>
			createSubscription(
				client,
				(): Source<Tick> | false => on() && feed("a"),
				() => {},
			),
		);
		expect(client.counts.subscribes).toBe(0);
		setOn(true);
		expect(client.active()).toHaveLength(1);
		setOn(false);
		expect(client.active()).toHaveLength(0);
		root.dispose();
	});

	it('reconcile "latest": a loss restarts delivery and the next event reconciles', () => {
		const client = createFakeClient();
		const root = owned(() =>
			createSubscription(client, feed("a"), () => {}, { reconcile: "latest" }),
		);
		client.setContinuity("gap", "overflow");
		expect(client.active()[0]?.pendingReconciles).toBe(1);
		client.emit({ n: 1 });
		expect(root.value.status().continuity.state).toBe("continuous");
		root.dispose();
	});

	it.each([
		"observer",
		"connection",
	] as const)("throwOnError throws a terminal error to the error handler, never a loss (%s)", (source) => {
		const client = createFakeClient();
		const caught: unknown[] = [];
		const root = owned(() =>
			catchError(
				() =>
					createSubscription(client, feed("a"), () => {}, {
						throwOnError: true,
					}),
				(error) => caught.push(error),
			),
		);
		client.setContinuity("gap", "overflow");
		client.setConnection("retry-exhausted");
		expect(caught).toEqual([]);
		source === "observer"
			? client.fail({ code: "subscribe-rejected", message: "no" })
			: client.setConnection("failed", "permanent-error");
		expect(caught).toHaveLength(1);
		expect(caught[0]).toMatchObject({
			code: source === "observer" ? "subscribe-rejected" : "upstream-error",
		});
		root.dispose();
	});

	it("without an error hook a terminal error is rethrown into the client's callback guard", () => {
		const client = createFakeClient();
		const hook = vi.fn();
		const root = owned(() => {
			createSubscription(client, feed("a"), () => {});
			createSubscription(client, feed("b"), { next() {}, error: hook });
		});
		const [bare, hooked] = client.active();
		expect(() =>
			bare?.observer.error?.({ code: "subscribe-rejected", message: "no" }),
		).toThrow(expect.objectContaining({ code: "subscribe-rejected" }));
		hooked?.observer.error?.({ code: "subscribe-rejected", message: "no" });
		expect(hook).toHaveBeenCalledTimes(1);
		root.dispose();
	});

	it("retry reaches only its own subscription", () => {
		const client = createFakeClient();
		const root = owned(() => [
			createSubscription(client, feed("a"), () => {}),
			createSubscription(client, feed("b"), () => {}),
		]);
		root.value[0]?.retry();
		expect(client.active().map((consumer) => consumer.retries)).toEqual([1, 0]);
		expect(client.counts.retries).toBe(0);
		root.dispose();
	});
});

describe("createLive (Solid)", () => {
	it("data follows map from initial; an identity change resets it at once", () => {
		const client = createFakeClient();
		const [topic, setTopic] = createSignal("a");
		const root = owned(() =>
			createLive<Tick, number>(client, () => feed(topic()), {
				initial: 0,
				map: (tick) => tick.n * 10,
			}),
		);
		expect(root.value.data()).toBe(0);
		client.emit({ n: 2 });
		expect(root.value.data()).toBe(20);
		setTopic("b");
		expect(root.value.data()).toBe(0);
		client.emit({ n: 3 });
		expect(root.value.data()).toBe(30);
		root.dispose();
	});

	it("reduce accumulates; a second owner is never seeded", () => {
		const client = createFakeClient();
		const reduce = (current: number[] | undefined, tick: Tick) =>
			tick.n < 0 ? undefined : [...(current ?? []), tick.n];
		const first = owned(() => createLive(client, feed("a"), { reduce }));
		client.emit({ n: 1 });
		client.emit({ n: -1 });
		client.emit({ n: 2 });
		expect(first.value.data()).toEqual([1, 2]);
		const late = owned(() => createLive(client, feed("a"), { reduce }));
		expect(late.value.data()).toBeUndefined();
		first.dispose();
		late.dispose();
	});

	it("an unreconciled loss without a policy is continuity-lost; markReconciled clears it", () => {
		const client = createFakeClient();
		const root = owned(() => createLive<Tick>(client, feed("a")));
		client.setContinuity("unknown", "reconnected");
		const live = root.value;
		expect(live.error()?.code).toBe("continuity-lost");
		expect(live.needsReconcile()).toBe(true);
		const first = live.error();
		client.setConnection("connected");
		expect(live.error()).toBe(first);
		live.markReconciled();
		expect(live.error()).toBeUndefined();
		expect(live.needsReconcile()).toBe(false);
		root.dispose();
	});

	it("with a policy a loss is no error; a terminal error is a value", () => {
		const client = createFakeClient();
		const root = owned(() =>
			createLive<Tick>(client, feed("a"), { reconcile: "latest" }),
		);
		client.setContinuity("gap", "overflow");
		expect(root.value.error()).toBeUndefined();
		expect(root.value.needsReconcile()).toBe(true);
		client.fail({ code: "upstream-error", message: "boom" });
		expect(root.value.error()?.code).toBe("upstream-error");
		root.dispose();
	});
});
