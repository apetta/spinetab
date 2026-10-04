import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { flushSync, mount, unmount } from "svelte";
import { compile } from "svelte/compiler";
import { get } from "svelte/store";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
	type LiveSnapshot,
	liveStore,
	subscriptionStore,
} from "../../src/bindings/svelte/index.ts";
import { createFakeClient, feed } from "./helpers/fake-client.ts";
import { append, rowsFor, upstream } from "./helpers/identity-rows.ts";
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

// Each rebuilt Svelte store starts a fresh subscription and value.

type Tick = { n: number };

const here = dirname(fileURLToPath(import.meta.url));
const generated = join(here, ".generated-identity");
afterAll(() => rmSync(generated, { recursive: true, force: true }));

const views: Array<ReturnType<typeof mount>> = [];
const stops: Array<() => void> = [];
let core: RealCore | undefined;
afterEach(async () => {
	for (const view of views.splice(0)) unmount(view);
	flushSync();
	await Promise.resolve();
	flushSync();
	for (const stop of stops.splice(0)) stop();
	await disposeDrivers();
	core?.dispose();
	core = undefined;
});

let serial = 0;
/** Compiles one component; `imports` maps a `.svelte` import to a compiled file. */
function emit(
	name: string,
	source: string,
	imports: Record<string, string> = {},
): string {
	const { js } = compile(source, {
		generate: "client",
		filename: `${name}.svelte`,
		dev: false,
	});
	mkdirSync(generated, { recursive: true });
	serial += 1;
	const file = join(generated, `${name}-${process.pid}-${serial}.js`);
	let code = js.code;
	for (const [from, to] of Object.entries(imports)) {
		code = code.replaceAll(from, `./${basename(to)}`);
	}
	writeFileSync(file, code);
	return file;
}

async function show<T>(
	name: string,
	source: string,
	props: Record<string, unknown>,
	imports?: Record<string, string>,
) {
	const file = emit(name, source, imports);
	const { default: Component } = await import(/* @vite-ignore */ file);
	const target = document.createElement("div");
	const view = mount(Component, { target, props }) as T;
	views.push(view as ReturnType<typeof mount>);
	flushSync();
	await Promise.resolve();
	flushSync();
	return { view, target };
}

const LIVE = `<script>
	let { client, feed, liveStore, options } = $props();
	let topic = $state("a");
	export function retarget(value) { topic = value; }
	const live = $derived(liveStore(client, topic === false ? false : feed(topic), options));
</script>
<output>{JSON.stringify({ data: $live.data ?? null, error: $live.error?.code ?? null })}</output>`;

describe("DOM-ID-SV matrix (A3) on the Svelte driver", () => {
	for (const [name, row] of rowsFor("svelte")) {
		it(name, () => row(liveDrivers.svelte.mount, false));
	}
});

describe("DOM-ID-SV compiled components (A2, guards)", () => {
	for (const middle of ["b", false] as const) {
		it(`a -> ${middle} -> a without an intervening event shows initial`, async () => {
			const client = createFakeClient();
			const { view, target } = await show<{ retarget(v: unknown): void }>(
				"Live",
				LIVE,
				{ client, feed, liveStore, options: undefined },
			);
			const shown = () => JSON.parse(target.textContent ?? "{}");
			client.emit({ n: 7 });
			flushSync();
			await Promise.resolve();
			flushSync();
			expect(shown().data).toEqual({ n: 7 });
			view.retarget(middle);
			flushSync();
			await Promise.resolve();
			flushSync();
			expect(shown().data).toBeNull();
			view.retarget("a");
			flushSync();
			await Promise.resolve();
			flushSync();
			expect(shown().data).toBeNull();
			expect(client.counts.subscribes).toBe(middle === false ? 2 : 3);
			expect(client.active()).toHaveLength(1);
		});
	}

	it("a terminal error and the value reset on a -> b -> a", async () => {
		const client = createFakeClient();
		const { view, target } = await show<{ retarget(v: unknown): void }>(
			"LiveError",
			LIVE,
			{
				client,
				feed,
				liveStore,
				options: { initial: 0, map: (tick: Tick) => tick.n * 10 },
			},
		);
		const shown = () => JSON.parse(target.textContent ?? "{}");
		client.emit({ n: 7 });
		client.fail(upstream);
		flushSync();
		await Promise.resolve();
		flushSync();
		expect(shown()).toEqual({ data: 70, error: "upstream-error" });
		for (const next of ["b", "a"]) {
			view.retarget(next);
			flushSync();
			await Promise.resolve();
			flushSync();
			expect(shown()).toEqual({ data: 0, error: null });
		}
	});
});

describe("DOM-ID-SV $derived re-runs (A2-1): stores are never compared", () => {
	it("A2-1 (documented form, guard) the identity primitive derived first keeps one subscription and its value", async () => {
		const client = createFakeClient();
		const { view, target } = await show<{ nextPage(): void }>(
			"Keyed",
			`<script>
	let { client, feed, liveStore, reduce } = $props();
	let topic = $state("a");
	let page = $state(1);
	export function nextPage() { page += 1; }
	const filter = $derived({ topic, page });
	const current = $derived(filter.topic);
	const live = $derived(liveStore(client, feed(current), { reduce }));
</script>
<output>{page}|{JSON.stringify($live.data ?? null)}</output>`,
			{ client, feed, liveStore, reduce: append.reduce },
		);
		client.emit({ n: 1 });
		flushSync();
		await Promise.resolve();
		flushSync();
		view.nextPage();
		flushSync();
		await Promise.resolve();
		flushSync();
		expect(target.textContent).toBe("2|[1]");
		expect(client.counts.subscribes).toBe(1);
	});

	it("A2-1 (documented form, guard) a primitive derived first keeps the subscription through a -> b -> a in one flush", async () => {
		const client = createFakeClient();
		const { view, target } = await show<{ flip(): void }>(
			"KeyedFlip",
			`<script>
	let { client, feed, liveStore, reduce } = $props();
	let topic = $state("a");
	export function flip() { topic = "b"; topic = "a"; }
	const current = $derived(topic);
	const live = $derived(liveStore(client, feed(current), { reduce }));
</script>
<output>{JSON.stringify($live.data ?? null)}</output>`,
			{ client, feed, liveStore, reduce: append.reduce },
		);
		client.emit({ n: 1 });
		flushSync();
		await Promise.resolve();
		flushSync();
		view.flip();
		flushSync();
		await Promise.resolve();
		flushSync();
		expect(target.textContent).toBe("[1]");
		expect(client.counts.subscribes).toBe(1);
	});

	it("A2-1 (documented form, guard) a child deriving its primitive from an inline object prop keeps its subscription", async () => {
		const client = createFakeClient();
		const child = emit(
			"KeyedChild",
			`<script>
	let { client, feed, liveStore, reduce, params } = $props();
	const room = $derived(params.room);
	const live = $derived(liveStore(client, feed(room), { reduce }));
</script>
<output>{JSON.stringify($live.data ?? null)}</output>`,
		);
		const { view, target } = await show<{ nextPage(): void }>(
			"KeyedParent",
			`<script>
	import Child from "./Child.svelte";
	let { client, feed, liveStore, reduce } = $props();
	let room = $state("a");
	let page = $state(1);
	export function nextPage() { page += 1; }
</script>
<p>{page}</p><Child {client} {feed} {liveStore} {reduce} params={{ room, page }} />`,
			{ client, feed, liveStore, reduce: append.reduce },
			{ "./Child.svelte": child },
		);
		client.emit({ n: 1 });
		client.emit({ n: 2 });
		flushSync();
		await Promise.resolve();
		flushSync();
		view.nextPage();
		flushSync();
		await Promise.resolve();
		flushSync();
		expect(target.textContent).toBe("2[1,2]");
		expect(client.counts.subscribes).toBe(1);
	});

	it("A2-1 (pinned) an inline object prop read in the store's $derived: a new subscription and a fresh value", async () => {
		const client = createFakeClient();
		const child = emit(
			"InlineChild",
			`<script>
	let { client, feed, liveStore, reduce, params } = $props();
	const live = $derived(liveStore(client, feed(params.room), { reduce }));
</script>
<output>{JSON.stringify($live.data ?? null)}</output>`,
		);
		const { view, target } = await show<{ nextPage(): void }>(
			"InlineParent",
			`<script>
	import Child from "./Child.svelte";
	let { client, feed, liveStore, reduce } = $props();
	let room = $state("a");
	let page = $state(1);
	export function nextPage() { page += 1; }
</script>
<p>{page}</p><Child {client} {feed} {liveStore} {reduce} params={{ room, page }} />`,
			{ client, feed, liveStore, reduce: append.reduce },
			{ "./Child.svelte": child },
		);
		client.emit({ n: 1 });
		client.emit({ n: 2 });
		flushSync();
		await Promise.resolve();
		flushSync();
		expect(target.textContent).toBe("1[1,2]");
		view.nextPage();
		flushSync();
		await Promise.resolve();
		flushSync();
		expect(target.textContent).toBe("2null");
		expect(client.counts).toMatchObject({ subscribes: 2, unsubscribes: 1 });
	});

	it("A2-1 (pinned) a derived filter object read in the store's $derived: a new subscription and a fresh value", async () => {
		const client = createFakeClient();
		const { view, target } = await show<{ nextPage(): void }>(
			"Filtered",
			`<script>
	let { client, feed, liveStore, reduce } = $props();
	let topic = $state("a");
	let page = $state(1);
	export function nextPage() { page += 1; }
	const filter = $derived({ topic, page });
	const live = $derived(liveStore(client, feed(filter.topic), { reduce }));
</script>
<output>{page}|{JSON.stringify($live.data ?? null)}</output>`,
			{ client, feed, liveStore, reduce: append.reduce },
		);
		client.emit({ n: 1 });
		client.emit({ n: 2 });
		flushSync();
		await Promise.resolve();
		flushSync();
		expect(target.textContent).toBe("1|[1,2]");
		view.nextPage();
		flushSync();
		await Promise.resolve();
		flushSync();
		expect(target.textContent).toBe("2|null");
		expect(client.counts).toMatchObject({ subscribes: 2, unsubscribes: 1 });
	});

	it("A2-1 (pinned) a -> b -> a in one flush with the store built from the $state: a new subscription and a fresh value", async () => {
		const client = createFakeClient();
		const { view, target } = await show<{ flip(): void }>(
			"Flip",
			`<script>
	let { client, feed, liveStore, reduce } = $props();
	let topic = $state("a");
	export function flip() { topic = "b"; topic = "a"; }
	const live = $derived(liveStore(client, feed(topic), { reduce }));
</script>
<output>{JSON.stringify($live.data ?? null)}</output>`,
			{ client, feed, liveStore, reduce: append.reduce },
		);
		client.emit({ n: 1 });
		flushSync();
		await Promise.resolve();
		flushSync();
		expect(target.textContent).toBe("[1]");
		view.flip();
		flushSync();
		await Promise.resolve();
		flushSync();
		expect(target.textContent).toBe("null");
		expect(client.counts).toMatchObject({ subscribes: 2, unsubscribes: 1 });
	});
});

describe("DOM-ID-SV store contract (A2, guards)", () => {
	it("one store re-subscribed after its last unsubscribe starts from initial with no error", async () => {
		const client = createFakeClient();
		const store = liveStore<Tick, number>(client, feed("a"), {
			initial: 0,
			map: (tick) => tick.n,
		});
		const stop = store.subscribe(() => {});
		await Promise.resolve();
		client.emit({ n: 7 });
		client.fail(upstream);
		stop();
		let last: LiveSnapshot<number> | undefined;
		const again = store.subscribe((value) => {
			last = value;
		});
		expect(last).toMatchObject({ data: 0, error: undefined });
		again();
		expect(client.active()).toHaveLength(0);
	});

	it("throwOnError: the throwing value is dropped at the last unsubscribe; a fresh subscriber reads initial", async () => {
		const client = createFakeClient();
		const store = liveStore<Tick>(client, feed("a"), { throwOnError: true });
		const stop = store.subscribe(() => {});
		await Promise.resolve();
		client.fail({ code: "subscribe-rejected", message: "no" });
		expect(() => get(store).data).toThrow();
		stop();
		expect(get(store).data).toBeUndefined();
	});

	it("markReconciled, retry and update reach nothing after the last unsubscribe, and only the new handle after a restart", async () => {
		const client = createFakeClient();
		const store = liveStore<Tick>(client, feed("a"));
		store.subscribe(() => {})();
		store.markReconciled();
		store.retry();
		store.update({ every: 1 });
		expect(
			client.consumers.map((c) => [c.reconciled, c.retries, c.updates.length]),
		).toEqual([]);
		const again = store.subscribe(() => {});
		await Promise.resolve();
		store.markReconciled();
		store.retry();
		expect(client.consumers.map((c) => [c.reconciled, c.retries])).toEqual([
			[1, 1],
		]);
		again();
	});

	it("a leaky client reaches no subscriber after the last unsubscribe", async () => {
		const client = createFakeClient({ leaky: true });
		const store = liveStore<Tick>(client, feed("a"));
		const seen: unknown[] = [];
		const stop = store.subscribe((value) => seen.push(value.data));
		stop();
		client.emit({ n: 1 });
		expect(seen).toEqual([undefined]);
	});

	it("(documented) a terminal error is the subscription's, so a later subscriber of the same store sees it", async () => {
		const client = createFakeClient();
		const store = liveStore<Tick>(client, feed("a"));
		stops.push(store.subscribe(() => {}));
		await Promise.resolve();
		client.fail(upstream);
		let late: LiveSnapshot<Tick> | undefined;
		stops.push(
			store.subscribe((value) => {
				late = value;
			}),
		);
		expect(late?.error?.code).toBe("upstream-error");
	});
});

describe("DOM-ID-SV client replacement (ID-10, the client is taken once)", () => {
	it("ID-10 a new store with a second client starts at initial and reaches only the new handle", async () => {
		const first = createFakeClient();
		const second = createFakeClient();
		const values: Array<LiveSnapshot<Tick>> = [];
		const a = liveStore<Tick>(first, feed("a"), { initial: { n: 0 } });
		const offA = a.subscribe((value) => values.push(value));
		await Promise.resolve();
		first.emit({ n: 7 });
		first.fail(upstream);
		expect(values.at(-1)).toMatchObject({ data: { n: 7 } });
		// As `$derived(liveStore(client, …))` with a new client: a new store.
		const b = liveStore<Tick>(second, feed("a"), { initial: { n: 0 } });
		const from = values.length;
		const offB = b.subscribe((value) => values.push(value));
		offA();
		stops.push(offB);
		expect(values.slice(from)).toHaveLength(1);
		await Promise.resolve();
		expect(values.at(-1)).toMatchObject({
			data: { n: 0 },
			error: undefined,
			needsReconcile: false,
		});
		expect(b.subscription?.status).toBe(second.active()[0]?.status);
		expect(first.active()).toHaveLength(0);
		expect(second.active()).toHaveLength(1);
		for (const store of [a, b]) {
			store.markReconciled();
			store.retry();
		}
		expect(first.consumers.map((c) => [c.reconciled, c.retries])).toEqual([
			[0, 0],
		]);
		expect(second.active()[0]).toMatchObject({ reconciled: 1, retries: 1 });
		second.emit({ n: 1 });
		expect(values.at(-1)?.data).toEqual({ n: 1 });
	});
});

describe("DOM-ID-SV principal change (A3-09)", () => {
	it("ID-16 every subscriber of one liveStore restarts at initial on a principal change, then folds from it", async () => {
		const client = createFakeClient();
		const store = liveStore<Tick, number[]>(client, feed("a"), append);
		const first: unknown[] = [];
		const second: unknown[] = [];
		stops.push(store.subscribe((value) => first.push(value.data)));
		stops.push(store.subscribe((value) => second.push(value.data)));
		await Promise.resolve();
		client.emit({ n: 1 });
		const from = [first.length, second.length];
		client.setContinuity("unknown", "scope-changed");
		expect([first.slice(from[0]), second.slice(from[1])]).toEqual([
			[undefined],
			[undefined],
		]);
		client.emit({ n: 2 });
		expect([first.at(-1), second.at(-1)]).toEqual([[2], [2]]);
	});
});

describe("DOM-ID-SVC real page client and runtime", () => {
	function subscribe<T>(store: {
		subscribe(run: (value: LiveSnapshot<T>) => void): () => void;
	}) {
		let value: LiveSnapshot<T> | undefined;
		stops.push(
			store.subscribe((next) => {
				value = next;
			}),
		);
		return () => ({
			data: value?.data ?? null,
			error: value?.error?.code ?? null,
			needs: value?.needsReconcile ?? false,
		});
	}

	it("SVC-15 (ID-15) an oversized event without a policy is error continuity-lost and no loud report", async () => {
		core = createRealCore();
		const { client, sinks, reports } = core;
		const read = subscribe(liveStore<CoreTick>(client, coreRequest("a")));
		await waitFor(() => sinks.has("a"), "a registered");
		sinks.get("a")?.next(oversized);
		await waitFor(() => read().error === "continuity-lost", "loss shown");
		await pause();
		expect({ shown: read().error, reports }).toEqual({
			shown: "continuity-lost",
			reports: [],
		});
	});

	it("SVC-15b (guard) subscriptionStore without a status hook keeps core's loud report", async () => {
		core = createRealCore();
		const { client, sinks, reports } = core;
		stops.push(
			subscriptionStore<CoreTick>(client, coreRequest("a"), () => {}).subscribe(
				() => {},
			),
		);
		await waitFor(() => sinks.has("a"), "a registered");
		sinks.get("a")?.next(oversized);
		await waitFor(() => reports.length > 0, "loss reported");
		expect(reports).toEqual(["continuity-lost"]);
	});

	it("SVC-16 (ID-16) after setScope the previous principal's data is gone; the loss stays visible", async () => {
		core = createRealCore();
		const { client, sinks } = core;
		const read = subscribe(liveStore<CoreTick>(client, coreRequest("a")));
		await waitFor(() => sinks.has("a"), "a registered");
		sinks.get("a")?.next({ n: 7 });
		await waitFor(() => (read().data as CoreTick)?.n === 7, "a event");
		sinks.delete("a");
		client.setScope("user-b");
		await waitFor(() => sinks.has("a"), "a re-registered under the new scope");
		await pause();
		expect(read()).toEqual({
			data: null,
			error: "continuity-lost",
			needs: true,
		});
		sinks.get("a")?.next({ n: 8 });
		await waitFor(
			() => (read().data as CoreTick)?.n === 8,
			"new principal's event",
		);
	});

	it("SVC-16b (ID-16) with reconcile latest, after setScope data is initial and no error shows", async () => {
		core = createRealCore();
		const { client, sinks } = core;
		const read = subscribe(
			liveStore<CoreTick>(client, coreRequest("a"), { reconcile: "latest" }),
		);
		await waitFor(() => sinks.has("a"), "a registered");
		sinks.get("a")?.next({ n: 7 });
		await waitFor(() => (read().data as CoreTick)?.n === 7, "a event");
		sinks.delete("a");
		client.setScope("user-b");
		await waitFor(() => sinks.has("a"), "a re-registered under the new scope");
		await pause();
		expect(read()).toEqual({ data: null, error: null, needs: true });
		sinks.get("a")?.next({ n: 8 });
		await waitFor(() => read().needs === false, "reconciled");
		expect(read()).toEqual({ data: { n: 8 }, error: null, needs: false });
	});
});
