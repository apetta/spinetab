import { afterEach, describe, expect, it } from "vitest";
import {
	type App,
	createApp,
	defineComponent,
	effectScope,
	h,
	nextTick,
	onErrorCaptured,
	type Ref,
	ref,
	shallowRef,
	watchSyncEffect,
} from "vue";
import {
	INACTIVE_STATUS,
	type UseLiveResult,
	useLive,
	useSubscription,
} from "../../src/bindings/vue/index.ts";
import type { Subscription } from "../../src/core/types.ts";
import {
	byTopic,
	createFakeClient,
	type FakeClient,
	feed,
} from "./helpers/fake-client.ts";
import { rowsFor, upstream } from "./helpers/identity-rows.ts";
import { disposeDrivers, liveDrivers } from "./helpers/live-drivers.ts";
import {
	type Tick as CoreTick,
	coreRequest,
	createRealCore,
	oversized,
	pause,
	type RealCore,
	waitFor,
} from "./helpers/real-core.ts";

type Tick = { n: number };
type Topic = string | false;

const apps: App[] = [];
const scopes: Array<() => void> = [];
let core: RealCore | undefined;
afterEach(async () => {
	for (const app of apps.splice(0)) app.unmount();
	for (const stop of scopes.splice(0)) stop();
	await disposeDrivers();
	core?.dispose();
	core = undefined;
});

function inScope<T>(run: () => T): T {
	const scope = effectScope();
	const value = scope.run(run) as T;
	scopes.push(() => scope.stop());
	return value;
}

const read = (live: UseLiveResult<Tick, unknown>) => ({
	data: live.data.value ?? null,
	error: live.error.value?.code ?? null,
	needs: live.needsReconcile.value,
});

/** A component whose render records every value it shows. */
function mountLive(
	client: FakeClient,
	topic: Ref<Topic>,
	options?: Parameters<typeof useLive<Tick, unknown>>[2],
) {
	const renders: Array<{
		data: unknown;
		error: string | null;
		handle: string | null;
	}> = [];
	let live: UseLiveResult<Tick, unknown> | undefined;
	const Probe = defineComponent({
		setup() {
			// biome-ignore lint/correctness/useHookAtTopLevel: Vue composable in setup(), not a React hook.
			const value = useLive<Tick, unknown>(
				client,
				() => (topic.value === false ? false : feed(topic.value)),
				options,
			);
			live = value;
			return () => {
				renders.push({
					...read(value),
					handle: value.subscription.value?.id ?? null,
				});
				return null;
			};
		},
	});
	const app = createApp(Probe);
	app.mount(document.createElement("div"));
	apps.push(app);
	return {
		app,
		renders,
		live: () => live as UseLiveResult<Tick, unknown>,
	};
}

describe("DOM-ID-V matrix (A3) on the Vue driver", () => {
	for (const [name, row] of rowsFor("vue")) {
		it(name, () => row(liveDrivers.vue.mount, false));
	}
});

describe("DOM-ID-V component identity (A2, guards)", () => {
	for (const middle of ["b", false] as const) {
		it(`a -> ${middle} -> a without an intervening event: no render shows a's old value`, async () => {
			const client = createFakeClient();
			const topic = ref<Topic>("a");
			const m = mountLive(client, topic);
			await nextTick();
			client.emit({ n: 7 });
			await nextTick();
			expect(read(m.live()).data).toEqual({ n: 7 });
			const from = m.renders.length;
			topic.value = middle;
			await nextTick();
			expect(read(m.live()).data).toBeNull();
			topic.value = "a";
			await nextTick();
			expect(read(m.live()).data).toBeNull();
			expect(m.renders.slice(from).map((r) => r.data)).not.toContainEqual({
				n: 7,
			});
			expect(client.counts.subscribes).toBe(middle === false ? 2 : 3);
			expect(client.active()).toHaveLength(1);
		});

		it(`a -> ${middle} -> a through a parent prop: every child render shows the rendered topic's handle`, async () => {
			const client = createFakeClient();
			const topic = ref<Topic>("a");
			const renders: Array<{ topic: unknown; data: unknown; handle: unknown }> =
				[];
			const Child = defineComponent({
				props: { topic: { type: [String, Boolean], required: true } },
				setup(props) {
					// biome-ignore lint/correctness/useHookAtTopLevel: Vue composable in setup(), not a React hook.
					const live = useLive<Tick>(client, () =>
						props.topic === false ? false : feed(props.topic as string),
					);
					return () => {
						renders.push({
							topic: props.topic,
							data: live.data.value ?? null,
							handle: live.subscription.value?.id ?? null,
						});
						return null;
					};
				},
			});
			const Parent = defineComponent({
				setup: () => () => h(Child, { topic: topic.value }),
			});
			const app = createApp(Parent);
			app.mount(document.createElement("div"));
			apps.push(app);
			await nextTick();
			client.emit({ n: 7 });
			await nextTick();
			const from = renders.length;
			topic.value = middle;
			await nextTick();
			topic.value = "a";
			await nextTick();
			const topics = new Map(
				client.consumers.map((c) => [
					c.id,
					(c.request.subscription as { topic: string }).topic,
				]),
			);
			const later = renders.slice(from);
			expect(later.map((r) => r.data)).not.toContainEqual({ n: 7 });
			for (const render of later) {
				if (render.topic === false) expect(render.handle).toBeNull();
				else if (render.handle !== null) {
					expect(topics.get(render.handle as string)).toBe(render.topic);
				}
			}
			expect(later.at(-1)).toMatchObject({ topic: "a", data: null });
		});
	}

	it("a terminal error is reset on a -> b -> a and never shown again", async () => {
		const client = createFakeClient();
		const topic = ref<Topic>("a");
		const m = mountLive(client, topic);
		await nextTick();
		client.fail(upstream);
		await nextTick();
		expect(read(m.live()).error).toBe("upstream-error");
		topic.value = "b";
		await nextTick();
		expect(read(m.live()).error).toBeNull();
		topic.value = "a";
		await nextTick();
		expect(read(m.live()).error).toBeNull();
	});

	it("initial is restored on each identity change, never the previous identity's value", async () => {
		const client = createFakeClient();
		const topic = ref<Topic>("a");
		const m = mountLive(client, topic, {
			initial: 0,
			map: (tick: Tick) => tick.n * 10,
		});
		await nextTick();
		client.emit({ n: 7 });
		await nextTick();
		expect(read(m.live()).data).toBe(70);
		for (const next of ["b", false, "a"] as const) {
			topic.value = next;
			await nextTick();
			expect(read(m.live()).data).toBe(0);
		}
		client.emit({ n: 2 });
		await nextTick();
		expect(read(m.live()).data).toBe(20);
	});

	it("throwOnError: an error captured for a is neither rethrown nor shown after a -> b -> a", async () => {
		const client = createFakeClient();
		const topic = ref<Topic>("a");
		const captured: unknown[] = [];
		let live: UseLiveResult<Tick> | undefined;
		const Child = defineComponent({
			setup() {
				// biome-ignore lint/correctness/useHookAtTopLevel: Vue composable in setup(), not a React hook.
				const value = useLive<Tick>(client, () => feed(topic.value as string), {
					throwOnError: true,
				});
				live = value;
				return () => h("p", value.error.value?.code ?? "none");
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
		apps.push(app);
		await nextTick();
		client.fail({ code: "subscribe-rejected", message: "no" });
		await nextTick();
		expect(captured).toHaveLength(1);
		topic.value = "b";
		await nextTick();
		topic.value = "a";
		await nextTick();
		expect(live?.error.value).toBeUndefined();
		expect(captured).toHaveLength(1);
	});

	it("after unmount a leaky client delivers nothing and nothing stays subscribed", async () => {
		const client = createFakeClient({ leaky: true });
		const topic = ref<Topic>("a");
		const m = mountLive(client, topic);
		await nextTick();
		topic.value = "b";
		await nextTick();
		const before = m.renders.length;
		client.emit({ n: 1 }, (c) => c.closed);
		await nextTick();
		expect(read(m.live()).data).toBeNull();
		m.app.unmount();
		apps.splice(apps.indexOf(m.app), 1);
		client.emit({ n: 2 });
		await nextTick();
		expect(client.active()).toHaveLength(0);
		expect(m.renders.length).toBe(before);
	});
});

describe("DOM-ID-V pre-flush window (A2-2)", () => {
	it("A2-2 useLive: between a source change and the watcher, status, error and subscription describe no identity; markReconciled and retry reach no handle", async () => {
		const client = createFakeClient();
		const topic = ref("a");
		const live = inScope(() => useLive<Tick>(client, () => feed(topic.value)));
		client.emit({ n: 7 });
		client.setContinuity("gap", "overflow");
		expect(live.error.value?.code).toBe("continuity-lost");
		topic.value = "b";
		expect(read(live)).toEqual({ data: null, error: null, needs: false });
		expect(live.status.value).toBe(INACTIVE_STATUS);
		expect(live.subscription.value).toBeNull();
		live.markReconciled();
		live.retry();
		expect(client.consumers.map((c) => [c.reconciled, c.retries])).toEqual([
			[0, 0],
		]);
		await nextTick();
		const b = client.consumers[1];
		expect(live.subscription.value?.status).toBe(b?.status);
		expect(live.status.value).toBe(b?.status.get());
		live.markReconciled();
		expect(client.consumers.map((c) => c.reconciled)).toEqual([0, 1]);
	});

	it("A2-2 useSubscription: the same window shows no status or handle; markReconciled and retry reach no handle", async () => {
		const client = createFakeClient();
		const topic = ref("a");
		const sub = inScope(() =>
			useSubscription<Tick>(
				client,
				() => feed(topic.value),
				() => {},
			),
		);
		client.setContinuity("gap", "overflow");
		topic.value = "b";
		expect(sub.status.value).toBe(INACTIVE_STATUS);
		expect(sub.subscription.value).toBeNull();
		sub.markReconciled();
		sub.retry();
		expect(client.consumers.map((c) => [c.reconciled, c.retries])).toEqual([
			[0, 0],
		]);
		await nextTick();
		expect(sub.subscription.value?.status).toBe(client.consumers[1]?.status);
	});

	it("A2-2 (guard) a -> b -> a within one tick keeps a's subscription, status and value; its events are its own", async () => {
		const client = createFakeClient();
		const topic = ref("a");
		const live = inScope(() => useLive<Tick>(client, () => feed(topic.value)));
		client.emit({ n: 7 });
		const a = live.subscription.value;
		topic.value = "b";
		client.emit({ n: 8 });
		expect(live.data.value).toBeUndefined();
		topic.value = "a";
		expect(live.data.value).toEqual({ n: 8 });
		expect(live.subscription.value).toBe(a);
		expect(live.status.value).toBe(client.consumers[0]?.status.get());
		live.markReconciled();
		expect(client.consumers[0]?.reconciled).toBe(1);
		await nextTick();
		expect(client.counts.subscribes).toBe(1);
		expect(live.data.value).toEqual({ n: 8 });
	});

	it("(guard) markReconciled and retry reach only the current handle; after dispose they reach nothing", async () => {
		const client = createFakeClient();
		const topic = ref("a");
		const live = inScope(() => useLive<Tick>(client, () => feed(topic.value)));
		topic.value = "b";
		await nextTick();
		live.markReconciled();
		live.retry();
		expect(client.consumers.map((c) => [c.reconciled, c.retries])).toEqual([
			[0, 0],
			[1, 1],
		]);
		live.dispose();
		live.markReconciled();
		live.retry();
		expect(client.consumers.map((c) => [c.reconciled, c.retries])).toEqual([
			[0, 0],
			[1, 1],
		]);
	});

	it("(guard) a getter rebuilding its feed and an unrelated reactive read never resubscribe", async () => {
		const client = createFakeClient();
		const noise = ref(0);
		const live = inScope(() =>
			useLive<Tick>(client, () => {
				void noise.value;
				return feed("a");
			}),
		);
		for (let index = 0; index < 3; index += 1) {
			noise.value += 1;
			await nextTick();
		}
		expect(client.counts.subscribes).toBe(1);
		client.emit({ n: 1 });
		expect(live.data.value).toEqual({ n: 1 });
	});

	it("an old-identity event reaches the observer only until the watcher applies the change", async () => {
		const client = createFakeClient({ leaky: true });
		const topic = ref("a");
		const seen: unknown[] = [];
		inScope(() =>
			useSubscription<Tick>(
				client,
				() => feed(topic.value),
				(event) => seen.push(event),
			),
		);
		topic.value = "b";
		client.emit({ n: 1 }, byTopic("a"));
		await nextTick();
		client.emit({ n: 2 }, byTopic("a"));
		client.emit({ n: 3 }, byTopic("b"));
		expect(seen).toEqual([{ n: 1 }, { n: 3 }]);
	});
});

describe("DOM-ID-V dispose drops the value (A2-3)", () => {
	it("A2-3 dispose() drops the value and the held error: data is initial and the status inactive", () => {
		const client = createFakeClient();
		const live = inScope(() =>
			useLive<Tick>(client, feed("a"), { initial: { n: 0 } }),
		);
		client.emit({ n: 7 });
		client.fail(upstream);
		expect(read(live)).toEqual({
			data: { n: 7 },
			error: "upstream-error",
			needs: false,
		});
		live.dispose();
		expect(read(live)).toEqual({ data: { n: 0 }, error: null, needs: false });
		expect(live.status.value).toBe(INACTIVE_STATUS);
		expect(live.subscription.value).toBeNull();
		expect(client.active()).toHaveLength(0);
	});

	it("A2-3 scope.stop() drops the value", () => {
		const client = createFakeClient();
		const scope = effectScope();
		const live = scope.run(() => useLive<Tick>(client, feed("a")));
		client.emit({ n: 7 });
		expect(live?.data.value).toEqual({ n: 7 });
		scope.stop();
		expect(live?.data.value).toBeUndefined();
		expect(live?.status.value).toBe(INACTIVE_STATUS);
	});

	it("A2-3 refs still bound after a component unmounts read initial", async () => {
		const client = createFakeClient();
		const m = mountLive(client, ref<Topic>("a"), { initial: { n: 0 } });
		await nextTick();
		client.emit({ n: 7 });
		await nextTick();
		expect(read(m.live()).data).toEqual({ n: 7 });
		m.app.unmount();
		apps.splice(apps.indexOf(m.app), 1);
		expect(read(m.live())).toEqual({
			data: { n: 0 },
			error: null,
			needs: false,
		});
	});
});

describe("DOM-ID-V client replacement (ID-10, the client is taken once)", () => {
	it("ID-10 a new client re-creates the composable (a keyed child): it starts at initial and reaches only the new handle", async () => {
		const first = createFakeClient();
		const second = createFakeClient();
		const current = shallowRef<FakeClient>(first);
		const renders: Array<{
			client: FakeClient;
			handle: Subscription<unknown> | null;
		}> = [];
		let live: UseLiveResult<Tick> | undefined;
		const Child = defineComponent({
			props: { client: { type: Object, required: true } },
			setup(props) {
				const client = props.client as FakeClient;
				// biome-ignore lint/correctness/useHookAtTopLevel: Vue composable in setup(), not a React hook.
				const value = useLive<Tick>(client, feed("a"), { initial: { n: 0 } });
				live = value;
				return () => {
					renders.push({
						client,
						handle: value.subscription.value as Subscription<unknown> | null,
					});
					return null;
				};
			},
		});
		const Parent = defineComponent({
			setup: () => () =>
				h(Child, {
					client: current.value,
					key: current.value === first ? "first" : "second",
				}),
		});
		const app = createApp(Parent);
		app.mount(document.createElement("div"));
		apps.push(app);
		await nextTick();
		first.emit({ n: 7 });
		first.fail(upstream);
		await nextTick();
		const from = renders.length;
		current.value = second;
		await nextTick();
		const now = live as UseLiveResult<Tick>;
		expect(read(now)).toEqual({ data: { n: 0 }, error: null, needs: false });
		const old = new Set(first.consumers.map((c) => c.status));
		for (const render of renders.slice(from)) {
			expect(render.client).toBe(second);
			expect(old.has(render.handle?.status as never)).toBe(false);
		}
		expect(first.active()).toHaveLength(0);
		expect(second.active()).toHaveLength(1);
		now.markReconciled();
		now.retry();
		expect(first.consumers.map((c) => [c.reconciled, c.retries])).toEqual([
			[0, 0],
		]);
		expect(second.active()[0]).toMatchObject({ reconciled: 1, retries: 1 });
		second.emit({ n: 1 });
		expect(read(now).data).toEqual({ n: 1 });
	});
});

describe("DOM-ID-V principal change (A3-09), synchronous observers", () => {
	it("ID-16 a flush 'sync' watcher never sees the previous principal's value with the scope-changed status", () => {
		const client = createFakeClient();
		const seen: Array<{ data: unknown; reason: unknown }> = [];
		const live = inScope(() => {
			const value = useLive<Tick>(client, feed("a"), { initial: { n: 0 } });
			watchSyncEffect(() => {
				seen.push({
					data: value.data.value,
					reason: value.status.value.continuity.reason,
				});
			});
			return value;
		});
		client.emit({ n: 7 });
		const from = seen.length;
		client.setContinuity("unknown", "scope-changed");
		expect(
			seen
				.slice(from)
				.filter(
					(entry) =>
						entry.reason === "scope-changed" &&
						(entry.data as Tick | undefined)?.n === 7,
				),
		).toEqual([]);
		expect(read(live)).toEqual({
			data: { n: 0 },
			error: "continuity-lost",
			needs: true,
		});
	});
});

describe("DOM-ID-VC real page client and runtime", () => {
	const tick = async (run: () => Promise<void>) => {
		await run();
		await nextTick();
	};
	const until = (check: () => boolean, label: string) =>
		waitFor(check, label, tick);
	const coreRead = (live: UseLiveResult<CoreTick, unknown>) => ({
		data: live.data.value ?? null,
		error: live.error.value?.code ?? null,
		needs: live.needsReconcile.value,
	});

	it("VC-15 (ID-15) an oversized event without a policy is error continuity-lost and no loud report", async () => {
		core = createRealCore();
		const { client, sinks, reports } = core;
		const live = inScope(() => useLive<CoreTick>(client, coreRequest("a")));
		await until(() => sinks.has("a"), "a registered");
		sinks.get("a")?.next(oversized);
		await until(() => coreRead(live).error === "continuity-lost", "loss shown");
		await tick(pause);
		expect({ shown: coreRead(live).error, reports }).toEqual({
			shown: "continuity-lost",
			reports: [],
		});
	});

	it("VC-15b (guard) useSubscription without a status hook keeps core's loud report", async () => {
		core = createRealCore();
		const { client, sinks, reports } = core;
		inScope(() =>
			useSubscription<CoreTick>(client, coreRequest("a"), () => {}),
		);
		await until(() => sinks.has("a"), "a registered");
		sinks.get("a")?.next(oversized);
		await until(() => reports.length > 0, "loss reported");
		expect(reports).toEqual(["continuity-lost"]);
	});

	it("VC-16 (ID-16) after setScope the previous principal's data is gone; the loss stays visible", async () => {
		core = createRealCore();
		const { client, sinks } = core;
		const live = inScope(() => useLive<CoreTick>(client, coreRequest("a")));
		await until(() => sinks.has("a"), "a registered");
		sinks.get("a")?.next({ n: 7 });
		await until(() => (coreRead(live).data as CoreTick)?.n === 7, "a event");
		sinks.delete("a");
		client.setScope("user-b");
		await until(() => sinks.has("a"), "a re-registered under the new scope");
		await tick(pause);
		expect(coreRead(live)).toEqual({
			data: null,
			error: "continuity-lost",
			needs: true,
		});
		sinks.get("a")?.next({ n: 8 });
		await until(
			() => (coreRead(live).data as CoreTick)?.n === 8,
			"new principal's event",
		);
	});

	it("VC-16b (ID-16) with reconcile latest, after setScope data is initial and no error shows", async () => {
		core = createRealCore();
		const { client, sinks } = core;
		const live = inScope(() =>
			useLive<CoreTick>(client, coreRequest("a"), { reconcile: "latest" }),
		);
		await until(() => sinks.has("a"), "a registered");
		sinks.get("a")?.next({ n: 7 });
		await until(() => (coreRead(live).data as CoreTick)?.n === 7, "a event");
		sinks.delete("a");
		client.setScope("user-b");
		await until(() => sinks.has("a"), "a re-registered under the new scope");
		await tick(pause);
		expect(coreRead(live)).toEqual({ data: null, error: null, needs: true });
		sinks.get("a")?.next({ n: 8 });
		await until(
			() => coreRead(live).needs === false,
			"reconciled by the event",
		);
		expect(coreRead(live)).toEqual({
			data: { n: 8 },
			error: null,
			needs: false,
		});
	});
});
