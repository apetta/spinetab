import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { flushSync, mount, unmount } from "svelte";
import { compile } from "svelte/compiler";
import { get } from "svelte/store";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
	bindClient,
	INACTIVE_STATUS,
	liveStore,
	subscriptionStore,
} from "../../src/bindings/svelte/index.ts";
import { SpinetabError } from "../../src/core/errors.ts";
import { createFakeClient, feed } from "./helpers/fake-client.ts";

type Tick = { n: number };

const here = dirname(fileURLToPath(import.meta.url));
const generated = join(here, ".generated-live");
afterAll(() => rmSync(generated, { recursive: true, force: true }));

async function component(source: string) {
	const { js } = compile(source, {
		generate: "client",
		filename: "Probe.svelte",
		dev: false,
	});
	mkdirSync(generated, { recursive: true });
	const file = join(generated, `probe-${Date.now()}-${Math.random()}.js`);
	writeFileSync(file, js.code);
	return (await import(/* @vite-ignore */ file)).default;
}

describe("bindClient (Svelte)", () => {
	it("bindClient returns the store factories with the client applied and starts nothing", async () => {
		const client = createFakeClient();
		const bound = bindClient(client);
		expect(Object.keys(bound).sort()).toEqual([
			"liveStore",
			"statusStore",
			"subscriptionStore",
		]);
		const next = vi.fn();
		const status = bound.subscriptionStore(feed("a"), next);
		const live = bound.liveStore(feed("a"));
		expect(client.counts.subscribes).toBe(0);
		let data: unknown;
		const offs = [
			status.subscribe(() => {}),
			live.subscribe((value) => {
				data = value.data;
			}),
		];
		await Promise.resolve();
		client.emit({ n: 1 });
		expect(next).toHaveBeenCalledTimes(1);
		// The value is per store subscriber; `get()` would be a new one.
		expect(data).toEqual({ n: 1 });
		expect(get(bound.statusStore()).mode).toBe("inactive");
		for (const off of offs) off();
		expect(client.active()).toHaveLength(0);
	});
});

describe("subscriptionStore options (Svelte)", () => {
	it("false disables like null", async () => {
		const client = createFakeClient();
		const store = subscriptionStore(client, false, () => {});
		const off = store.subscribe(() => {});
		await Promise.resolve();
		expect(client.counts.subscribes).toBe(0);
		expect(get(store)).toBe(INACTIVE_STATUS);
		off();
	});

	it('reconcile "latest": a loss restarts delivery and the next event reconciles', async () => {
		const client = createFakeClient();
		const store = subscriptionStore(client, feed("a"), () => {}, {
			reconcile: "latest",
		});
		const off = store.subscribe(() => {});
		await Promise.resolve();
		client.setContinuity("gap", "overflow");
		expect(client.active()[0]?.pendingReconciles).toBe(1);
		client.emit({ n: 1 });
		expect(get(store).continuity.state).toBe("continuous");
		off();
	});

	it.each([
		"observer",
		"connection",
	] as const)("throwOnError hands a terminal error to <svelte:boundary>, never a loss (%s)", async (source) => {
		const client = createFakeClient();
		const Probe = await component(`<script>
	let { store } = $props();
</script>
<svelte:boundary>
	<output>{$store.connection.state}</output>
	{#snippet failed(error)}<output>caught:{error.code}</output>{/snippet}
</svelte:boundary>`);
		const store = subscriptionStore(client, feed("a"), () => {}, {
			throwOnError: true,
		});
		const target = document.createElement("div");
		const view = mount(Probe, { target, props: { store } });
		flushSync();
		await Promise.resolve();
		flushSync();
		client.setContinuity("gap", "overflow");
		client.setConnection("retry-exhausted");
		flushSync();
		await Promise.resolve();
		flushSync();
		expect(target.textContent).toBe("retry-exhausted");
		source === "observer"
			? client.fail({ code: "subscribe-rejected", message: "no" })
			: client.setConnection("failed", "permanent-error");
		flushSync();
		await Promise.resolve();
		flushSync();
		expect(target.textContent).toBe(
			source === "observer"
				? "caught:subscribe-rejected"
				: "caught:upstream-error",
		);
		unmount(view);
		flushSync();
		await Promise.resolve();
		flushSync();
		expect(client.active()).toHaveLength(0);
	});

	it("without an error hook a terminal error is rethrown into the client's callback guard", async () => {
		const client = createFakeClient();
		const hook = vi.fn();
		const offs = [
			subscriptionStore(client, feed("a"), () => {}).subscribe(() => {}),
			subscriptionStore(client, feed("b"), {
				next() {},
				error: hook,
			}).subscribe(() => {}),
		];
		await Promise.resolve();
		const [bare, hooked] = client.active();
		expect(() =>
			bare?.observer.error?.({ code: "subscribe-rejected", message: "no" }),
		).toThrow(expect.objectContaining({ code: "subscribe-rejected" }));
		hooked?.observer.error?.({ code: "subscribe-rejected", message: "no" });
		expect(hook).toHaveBeenCalledTimes(1);
		for (const off of offs) off();
	});

	it("retry reaches only its own subscription", async () => {
		const client = createFakeClient();
		const first = subscriptionStore(client, feed("a"), () => {});
		const offs = [
			first.subscribe(() => {}),
			subscriptionStore(client, feed("b"), () => {}).subscribe(() => {}),
		];
		await Promise.resolve();
		first.retry();
		expect(client.active().map((consumer) => consumer.retries)).toEqual([1, 0]);
		expect(client.counts.retries).toBe(0);
		for (const off of offs) off();
	});
});

describe("liveStore (Svelte)", () => {
	it("data follows map from initial; nothing survives the last unsubscribe", async () => {
		const client = createFakeClient();
		const store = liveStore<Tick, number>(client, feed("a"), {
			initial: 0,
			map: (tick) => tick.n * 10,
		});
		expect(get(store).data).toBe(0);
		let data: number | undefined;
		const off = store.subscribe((value) => {
			data = value.data;
		});
		await Promise.resolve();
		client.emit({ n: 2 });
		expect(data).toBe(20);
		// Each store subscriber holds its own value: `get()` starts at initial.
		expect(get(store).data).toBe(0);
		off();
		// A later subscription starts from initial, never the earlier value.
		let later: number | undefined;
		const again = store.subscribe((value) => {
			later = value.data;
		});
		expect(later).toBe(0);
		again();
	});

	it("reduce accumulates; separate stores never share", async () => {
		const client = createFakeClient();
		const reduce = (current: number[] | undefined, tick: Tick) =>
			tick.n < 0 ? undefined : [...(current ?? []), tick.n];
		const first = liveStore(client, feed("a"), { reduce });
		let data: number[] | undefined;
		const off = first.subscribe((value) => {
			data = value.data;
		});
		await Promise.resolve();
		client.emit({ n: 1 });
		await Promise.resolve();
		client.emit({ n: -1 });
		await Promise.resolve();
		client.emit({ n: 2 });
		expect(data).toEqual([1, 2]);
		const late = liveStore(client, feed("a"), { reduce });
		let lateData: number[] | undefined = [0];
		const lateOff = late.subscribe((value) => {
			lateData = value.data;
		});
		expect(lateData).toBeUndefined();
		off();
		lateOff();
	});

	it("an unreconciled loss without a policy is continuity-lost; markReconciled clears it; values stay stable", async () => {
		const client = createFakeClient();
		const store = liveStore<Tick>(client, feed("a"));
		const values: unknown[] = [];
		const off = store.subscribe((value) => values.push(value));
		await Promise.resolve();
		client.setContinuity("unknown", "reconnected");
		const lost = get(store);
		expect(lost.error?.code).toBe("continuity-lost");
		expect(lost.needsReconcile).toBe(true);
		client.setConnection("connected");
		expect(get(store).error).toBe(lost.error);
		store.markReconciled();
		expect(get(store).error).toBeUndefined();
		expect(get(store).needsReconcile).toBe(false);
		// One published value per change, never a repeat of the same object.
		expect(new Set(values).size).toBe(values.length);
		off();
	});

	it("with a policy a loss is no error; a terminal error is a value", async () => {
		const client = createFakeClient();
		const store = liveStore<Tick>(client, feed("a"), { reconcile: "latest" });
		const off = store.subscribe(() => {});
		await Promise.resolve();
		client.setContinuity("gap", "overflow");
		expect(get(store).error).toBeUndefined();
		expect(get(store).needsReconcile).toBe(true);
		client.fail({ code: "upstream-error", message: "boom" });
		expect(get(store).error?.code).toBe("upstream-error");
		off();
	});
});

describe("Svelte error reporting and live store lifecycle", () => {
	it("without an error hook the store rethrows core's own error object, never a copy with its message", async () => {
		const client = createFakeClient();
		const store = subscriptionStore(client, feed("a"), () => {});
		const off = store.subscribe(() => {});
		await Promise.resolve();
		const error = new SpinetabError("upstream-error", "upstream text");
		let thrown: unknown;
		try {
			client.fail(error);
		} catch (caught) {
			thrown = caught;
		}
		off();
		expect(thrown).toBe(error);
	});

	it("the observer core sees has a status hook only while the application's has one", async () => {
		const client = createFakeClient();
		const plain = subscriptionStore(client, feed("a"), () => {});
		const withStatus = subscriptionStore(client, feed("b"), {
			next() {},
			status() {},
		});
		const offs = [plain.subscribe(() => {}), withStatus.subscribe(() => {})];
		await Promise.resolve();
		const [first, second] = client.active();
		expect(first?.observer.status).toBeUndefined();
		expect(typeof second?.observer.status).toBe("function");
		for (const off of offs) off();
	});

	it("two subscribers of one liveStore share the subscription, never the value", async () => {
		const client = createFakeClient();
		const store = liveStore<Tick, number>(client, feed("a"), {
			initial: 0,
			reduce: (current, tick) => (current ?? 0) + tick.n,
		});
		let first: number | undefined;
		let second: number | undefined;
		const offFirst = store.subscribe((value) => {
			first = value.data;
		});
		await Promise.resolve();
		client.emit({ n: 5 });
		const offSecond = store.subscribe((value) => {
			second = value.data;
		});
		expect(second).toBe(0);
		client.emit({ n: 1 });
		expect({ first, second }).toEqual({ first: 6, second: 1 });
		expect(client.counts.subscribes).toBe(1);
		offSecond();
		offFirst();
		expect(client.active()).toHaveLength(0);
	});
});
