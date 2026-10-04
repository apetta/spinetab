import {
	batch,
	catchError,
	createEffect,
	createMemo,
	createRenderEffect,
	createRoot,
	createSignal,
	on,
} from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createLive,
	createSubscription,
	INACTIVE_STATUS,
	type LiveResource,
} from "../../src/bindings/solid/index.ts";
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

// Render effects stand in for JSX and run before the resource's own effects.

type Tick = { n: number };
type Topic = string | false;

const roots: Array<() => void> = [];
let core: RealCore | undefined;
afterEach(async () => {
	for (const dispose of roots.splice(0)) dispose();
	await disposeDrivers();
	core?.dispose();
	core = undefined;
});

function owned<T>(run: () => T): { value: T; dispose(): void } {
	let value!: T;
	const dispose = createRoot((done) => {
		value = run();
		return done;
	});
	roots.push(dispose);
	return { value, dispose };
}

const read = (live: LiveResource<Tick, unknown>) => ({
	data: live.data() ?? null,
	error: live.error()?.code ?? null,
	needs: live.needsReconcile(),
});

interface Render {
	topic: Topic;
	data: unknown;
	error: string | null;
	handle: string | null;
	continuity: string;
}

/** `createLive` over a topic signal, with a render effect recording every view. */
function liveWithRenders(
	client: FakeClient,
	options?: Parameters<typeof createLive<Tick, unknown>>[2],
) {
	const renders: Render[] = [];
	let setTopic!: (topic: Topic) => void;
	const root = owned(() => {
		const [topic, write] = createSignal<Topic>("a");
		setTopic = (next) => write(() => next);
		const live = createLive<Tick, unknown>(
			client,
			() => {
				const current = topic();
				return current === false ? false : feed(current);
			},
			options,
		);
		createRenderEffect(() => {
			renders.push({
				topic: topic(),
				...read(live),
				handle: live.subscription()?.id ?? null,
				continuity: live.status().continuity.state,
			});
		});
		return live;
	});
	return { ...root, renders, setTopic };
}

describe("DOM-ID-SO matrix (A3) on the Solid driver", () => {
	for (const [name, row] of rowsFor("solid")) {
		it(name, () => row(liveDrivers.solid.mount, false));
	}
});

describe("DOM-ID-SO identity (A2, guards)", () => {
	for (const middle of ["b", false] as const) {
		it(`a -> ${middle} -> a without an intervening event: no render shows a's old value`, () => {
			const client = createFakeClient();
			const r = liveWithRenders(client);
			client.emit({ n: 7 });
			expect(read(r.value).data).toEqual({ n: 7 });
			const from = r.renders.length;
			r.setTopic(middle);
			expect(read(r.value).data).toBeNull();
			r.setTopic("a");
			expect(read(r.value).data).toBeNull();
			expect(r.renders.slice(from).map((x) => x.data)).not.toContainEqual({
				n: 7,
			});
			expect(client.counts.subscribes).toBe(middle === false ? 2 : 3);
			expect(client.active()).toHaveLength(1);
		});
	}

	it("a terminal error is reset on a -> b -> a", () => {
		const client = createFakeClient();
		const r = liveWithRenders(client);
		client.fail(upstream);
		expect(read(r.value).error).toBe("upstream-error");
		r.setTopic("b");
		expect(read(r.value).error).toBeNull();
		r.setTopic("a");
		expect(read(r.value).error).toBeNull();
	});

	it("initial is restored on each identity change", () => {
		const client = createFakeClient();
		const r = liveWithRenders(client, {
			initial: 0,
			map: (tick: Tick) => tick.n * 10,
		});
		client.emit({ n: 7 });
		expect(read(r.value).data).toBe(70);
		for (const next of ["b", false, "a"] as const) {
			r.setTopic(next);
			expect(read(r.value).data).toBe(0);
		}
		client.emit({ n: 2 });
		expect(read(r.value).data).toBe(20);
	});

	it("throwOnError: caught once for a; nothing rethrown or shown after a -> b -> a", () => {
		const client = createFakeClient();
		const caught: unknown[] = [];
		let setTopic!: (topic: string) => void;
		let live!: LiveResource<Tick>;
		owned(() =>
			catchError(
				() => {
					const [topic, write] = createSignal("a");
					setTopic = (next) => write(next);
					live = createLive<Tick>(client, () => feed(topic()), {
						throwOnError: true,
					});
				},
				(error) => caught.push(error),
			),
		);
		client.fail({ code: "subscribe-rejected", message: "no" });
		expect(caught).toHaveLength(1);
		setTopic("b");
		setTopic("a");
		expect(live.error()).toBeUndefined();
		expect(caught).toHaveLength(1);
	});

	it("batch: an old-identity event inside the batch that switches source never shows; a -> b -> a in one batch keeps the subscription", () => {
		const client = createFakeClient();
		const r = liveWithRenders(client);
		client.emit({ n: 7 });
		batch(() => {
			r.setTopic("b");
			client.emit({ n: 8 });
			expect(read(r.value).data).toBeNull();
		});
		expect(read(r.value).data).toBeNull();
		expect(client.counts.subscribes).toBe(2);
		batch(() => {
			r.setTopic("a");
			r.setTopic("b");
		});
		expect(client.counts.subscribes).toBe(2);
	});

	it("markReconciled and retry reach only the current handle; after dispose nothing", () => {
		const client = createFakeClient();
		const r = liveWithRenders(client);
		r.setTopic("b");
		r.value.markReconciled();
		r.value.retry();
		expect(client.consumers.map((c) => [c.reconciled, c.retries])).toEqual([
			[0, 0],
			[1, 1],
		]);
		r.dispose();
		r.value.markReconciled();
		r.value.retry();
		expect(client.consumers.map((c) => [c.reconciled, c.retries])).toEqual([
			[0, 0],
			[1, 1],
		]);
		expect(client.active()).toHaveLength(0);
	});

	it("owner disposal (nested in a parent owner) releases; a leaky client reaches nothing afterwards", () => {
		const client = createFakeClient({ leaky: true });
		const seen: unknown[] = [];
		const parent = owned(() => {
			const live = createLive<Tick>(client, feed("a"));
			createEffect(() => seen.push(live.data()));
			return live;
		});
		client.emit({ n: 1 });
		parent.dispose();
		client.emit({ n: 2 });
		expect(client.active()).toHaveLength(0);
		expect(seen).toEqual([undefined, { n: 1 }]);
	});

	it("an accessor rebuilding its feed and an unrelated signal read never resubscribe", () => {
		const client = createFakeClient();
		const [noise, setNoise] = createSignal(0);
		owned(() =>
			createLive<Tick>(client, () => {
				noise();
				return feed("a");
			}),
		);
		for (let index = 1; index <= 3; index += 1) setNoise(index);
		expect(client.counts.subscribes).toBe(1);
	});

	it("an old-identity event reaches the observer only until the effect applies the change", () => {
		const client = createFakeClient({ leaky: true });
		const seen: unknown[] = [];
		let setTopic!: (topic: string) => void;
		owned(() => {
			const [topic, write] = createSignal("a");
			setTopic = (next) => write(next);
			return createSubscription<Tick>(
				client,
				() => feed(topic()),
				(event) => seen.push(event),
			);
		});
		batch(() => {
			setTopic("b");
			client.emit({ n: 1 }, byTopic("a"));
		});
		client.emit({ n: 2 }, byTopic("a"));
		client.emit({ n: 3 }, byTopic("b"));
		expect(seen).toEqual([{ n: 1 }, { n: 3 }]);
	});
});

describe("DOM-ID-SO render effects during a switch (A2-2)", () => {
	it("A2-2 a render effect during the switch never pairs the new identity with the old status, error or handle", () => {
		const client = createFakeClient();
		const r = liveWithRenders(client);
		client.emit({ n: 7 });
		client.setContinuity("gap", "overflow");
		expect(read(r.value).error).toBe("continuity-lost");
		const from = r.renders.length;
		r.setTopic("b");
		const later = r.renders.slice(from);
		const b = client.consumers[1]?.id;
		expect(later.length).toBeGreaterThan(0);
		for (const render of later) {
			expect(render).toMatchObject({
				topic: "b",
				data: null,
				error: null,
				continuity: "continuous",
			});
			expect([null, b]).toContain(render.handle);
		}
		expect(later.at(-1)?.handle).toBe(b);
	});

	it("A2-2 markReconciled and retry from a render effect on the new identity reach no old handle", () => {
		const client = createFakeClient();
		let setTopic!: (topic: string) => void;
		owned(() => {
			const [topic, write] = createSignal("a");
			setTopic = (next) => write(next);
			const live = createLive<Tick>(client, () => feed(topic()));
			createRenderEffect(
				on(
					topic,
					(current) => {
						if (current !== "b") return;
						live.markReconciled();
						live.retry();
					},
					{ defer: true },
				),
			);
			return live;
		});
		client.setContinuity("gap", "overflow");
		setTopic("b");
		expect(client.consumers.map((c) => [c.reconciled, c.retries])).toEqual([
			[0, 0],
			[0, 0],
		]);
	});
});

describe("DOM-ID-SO disposal drops the value (A2-3)", () => {
	it("A2-3 owner disposal drops the value and the held error: initial, inactive, no handle", () => {
		const client = createFakeClient();
		const root = owned(() =>
			createLive<Tick>(client, feed("a"), { initial: { n: 0 } }),
		);
		client.emit({ n: 7 });
		client.fail(upstream);
		expect(read(root.value)).toEqual({
			data: { n: 7 },
			error: "upstream-error",
			needs: false,
		});
		root.dispose();
		expect(read(root.value)).toEqual({
			data: { n: 0 },
			error: null,
			needs: false,
		});
		expect(root.value.status()).toBe(INACTIVE_STATUS);
		expect(root.value.subscription()).toBeNull();
		expect(client.active()).toHaveLength(0);
	});

	it("A2-3 a bare dispose() drops the value, and an outer observer follows", () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const client = createFakeClient();
		const live = createLive<Tick>(client, feed("a"));
		const seen: unknown[] = [];
		owned(() => {
			createRenderEffect(() => seen.push(live.data()));
		});
		client.emit({ n: 9 });
		expect(seen.at(-1)).toEqual({ n: 9 });
		live.dispose();
		expect(live.data()).toBeUndefined();
		expect(seen.at(-1)).toBeUndefined();
		expect(live.status()).toBe(INACTIVE_STATUS);
		expect(client.active()).toHaveLength(0);
	});
});

describe("DOM-ID-SO client replacement (ID-10, the client is taken once)", () => {
	it("ID-10 a new client needs a new primitive (a keyed owner): it starts at initial and reaches only the new handle", () => {
		const first = createFakeClient();
		const second = createFakeClient();
		const renders: Array<{
			client: FakeClient;
			data: unknown;
			handle: Subscription<unknown> | null;
		}> = [];
		let setClient!: (client: FakeClient) => void;
		let current!: () => LiveResource<Tick>;
		owned(() => {
			const [client, write] = createSignal<FakeClient>(first);
			setClient = (next) => write(() => next);
			// As `<Show when={client()} keyed>`: one owner per client.
			const resource = createMemo(() => {
				const value = client();
				return {
					client: value,
					live: createLive<Tick>(value, feed("a"), { initial: { n: 0 } }),
				};
			});
			current = () => resource().live;
			createRenderEffect(() => {
				const { client: value, live } = resource();
				renders.push({
					client: value,
					data: live.data() ?? null,
					handle: live.subscription() as Subscription<unknown> | null,
				});
			});
		});
		first.emit({ n: 7 });
		first.fail(upstream);
		expect(read(current())).toMatchObject({
			data: { n: 7 },
			error: "upstream-error",
		});
		const from = renders.length;
		setClient(second);
		expect(read(current())).toEqual({
			data: { n: 0 },
			error: null,
			needs: false,
		});
		const old = new Set(first.consumers.map((c) => c.status));
		for (const render of renders.slice(from)) {
			expect(render.client).toBe(second);
			expect(render.data).toEqual({ n: 0 });
			expect(old.has(render.handle?.status as never)).toBe(false);
		}
		expect(first.active()).toHaveLength(0);
		expect(second.active()).toHaveLength(1);
		current().markReconciled();
		current().retry();
		expect(first.consumers.map((c) => [c.reconciled, c.retries])).toEqual([
			[0, 0],
		]);
		expect(second.active()[0]).toMatchObject({ reconciled: 1, retries: 1 });
		second.emit({ n: 1 });
		expect(read(current()).data).toEqual({ n: 1 });
	});
});

describe("DOM-ID-SOC real page client and runtime", () => {
	const coreRead = (live: LiveResource<CoreTick, unknown>) => ({
		data: live.data() ?? null,
		error: live.error()?.code ?? null,
		needs: live.needsReconcile(),
	});

	it("SOC-15 (ID-15) an oversized event without a policy is error continuity-lost and no loud report", async () => {
		core = createRealCore();
		const { client, sinks, reports } = core;
		const live = owned(() =>
			createLive<CoreTick>(client, coreRequest("a")),
		).value;
		await waitFor(() => sinks.has("a"), "a registered");
		sinks.get("a")?.next(oversized);
		await waitFor(
			() => coreRead(live).error === "continuity-lost",
			"loss shown",
		);
		await pause();
		expect({ shown: coreRead(live).error, reports }).toEqual({
			shown: "continuity-lost",
			reports: [],
		});
	});

	it("SOC-15b (guard) createSubscription without a status hook keeps core's loud report", async () => {
		core = createRealCore();
		const { client, sinks, reports } = core;
		owned(() =>
			createSubscription<CoreTick>(client, coreRequest("a"), () => {}),
		);
		await waitFor(() => sinks.has("a"), "a registered");
		sinks.get("a")?.next(oversized);
		await waitFor(() => reports.length > 0, "loss reported");
		expect(reports).toEqual(["continuity-lost"]);
	});

	it("SOC-16 (ID-16) after setScope the previous principal's data is gone; the loss stays visible", async () => {
		core = createRealCore();
		const { client, sinks } = core;
		const live = owned(() =>
			createLive<CoreTick>(client, coreRequest("a")),
		).value;
		await waitFor(() => sinks.has("a"), "a registered");
		sinks.get("a")?.next({ n: 7 });
		await waitFor(() => (coreRead(live).data as CoreTick)?.n === 7, "a event");
		sinks.delete("a");
		client.setScope("user-b");
		await waitFor(() => sinks.has("a"), "a re-registered under the new scope");
		await pause();
		expect(coreRead(live)).toEqual({
			data: null,
			error: "continuity-lost",
			needs: true,
		});
		sinks.get("a")?.next({ n: 8 });
		await waitFor(
			() => (coreRead(live).data as CoreTick)?.n === 8,
			"new principal's event",
		);
	});

	it("SOC-16b (ID-16) with reconcile latest, after setScope data is initial and no error shows", async () => {
		core = createRealCore();
		const { client, sinks } = core;
		const live = owned(() =>
			createLive<CoreTick>(client, coreRequest("a"), { reconcile: "latest" }),
		).value;
		await waitFor(() => sinks.has("a"), "a registered");
		sinks.get("a")?.next({ n: 7 });
		await waitFor(() => (coreRead(live).data as CoreTick)?.n === 7, "a event");
		sinks.delete("a");
		client.setScope("user-b");
		await waitFor(() => sinks.has("a"), "a re-registered under the new scope");
		await pause();
		expect(coreRead(live)).toEqual({ data: null, error: null, needs: true });
		sinks.get("a")?.next({ n: 8 });
		await waitFor(() => coreRead(live).needs === false, "reconciled");
		expect(coreRead(live)).toEqual({
			data: { n: 8 },
			error: null,
			needs: false,
		});
	});
});
