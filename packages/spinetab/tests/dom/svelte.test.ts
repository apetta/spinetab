import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { flushSync, mount, unmount } from "svelte";
import { compile } from "svelte/compiler";
import { derived, get } from "svelte/store";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
	INACTIVE_STATUS,
	statusStore,
	subscriptionStore,
} from "../../src/bindings/svelte/index.ts";
import type { SubscriptionStatus } from "../../src/core/types.ts";
import {
	createFakeClient,
	feed,
	macrotask,
	request,
} from "./helpers/fake-client.ts";

// DOM-S-01…03: the store contract with the real svelte/store helpers and a
// real Svelte 5.57 component compiled at test time.

const here = dirname(fileURLToPath(import.meta.url));
const generated = join(here, ".generated");
afterAll(() => rmSync(generated, { recursive: true, force: true }));

describe("subscriptionStore", () => {
	it("DOM-S-01 creation is inert; the first subscriber starts, the last releases (0→1→0)", async () => {
		const client = createFakeClient();
		const store = subscriptionStore(client, request("a"), { next: vi.fn() });
		expect(client.counts.subscribes).toBe(0);
		const values: SubscriptionStatus[] = [];
		const stopA = store.subscribe((value) => values.push(value));
		// The store contract: the current value synchronously on subscribe.
		expect(values).toHaveLength(1);
		expect(values[0]).toBe(INACTIVE_STATUS);
		const stopB = store.subscribe(() => {});
		await Promise.resolve();
		expect(client.active()).toHaveLength(1);
		expect(get(store).connection.state).toBe("connecting");
		expect(client.active()).toHaveLength(1);
		client.setConnection("connected");
		expect(values.at(-1)?.connection.state).toBe("connected");
		stopA();
		expect(client.active()).toHaveLength(1);
		stopB();
		stopB();
		expect(client.active()).toHaveLength(0);
		expect(client.counts.unsubscribes).toBe(1);
		await macrotask();
		expect(client.upstream()).toEqual([]);
		// A transient subscriber cancels its pending start.
		expect(get(store)).toBe(INACTIVE_STATUS);
		await Promise.resolve();
		expect(client.active()).toHaveLength(0);
		expect(client.counts.subscribes).toBe(client.counts.unsubscribes);
		expect(store.subscription).toBeNull();
	});

	it("DOM-S-02 a new store per input releases the old one; derived stores compose", async () => {
		const client = createFakeClient({ leaky: true });
		const next = vi.fn();
		const first = subscriptionStore(client, request("a"), { next });
		const state = derived(first, (status) => status.connection.state);
		const seen: string[] = [];
		const stop = state.subscribe((value) => seen.push(value));
		await Promise.resolve();
		const second = subscriptionStore(client, request("b"), { next });
		const stopSecond = second.subscribe(() => {});
		await Promise.resolve();
		stop();
		expect(client.active().map((c) => c.request.subscription)).toEqual([
			{ topic: "b" },
		]);
		client.emit({ n: 1 }, (consumer) => consumer.closed);
		expect(next).not.toHaveBeenCalled();
		expect(seen).toEqual(["inactive", "connecting"]);
		stopSecond();
		const disabled: SubscriptionStatus[] = [];
		subscriptionStore(client, null, { next }).subscribe((value) =>
			disabled.push(value),
		)();
		expect(disabled).toEqual([INACTIVE_STATUS]);
		expect(client.counts.subscribes).toBe(2);
	});

	it("DOM-S-03 works as $store in a compiled Svelte 5 component", async () => {
		const client = createFakeClient();
		const source = `<script>
	let { store, status } = $props();
</script>
<output>{$store.connection.state}/{$store.continuity.state}/{$status.mode}</output>`;
		const { js } = compile(source, {
			generate: "client",
			filename: "Probe.svelte",
			dev: false,
		});
		mkdirSync(generated, { recursive: true });
		const file = join(generated, `probe-${Date.now()}.js`);
		writeFileSync(file, js.code);
		const { default: Probe } = await import(/* @vite-ignore */ file);
		const store = subscriptionStore(client, request("a"), { next: vi.fn() });
		const status = statusStore(client);
		const target = document.createElement("div");
		expect(client.counts.subscribes).toBe(0);
		const component = mount(Probe, { target, props: { store, status } });
		flushSync();
		await Promise.resolve();
		flushSync();
		expect(client.active()).toHaveLength(1);
		expect(target.textContent).toBe("connecting/continuous/shared");
		client.setConnection("connected");
		client.setContinuity("gap", "overflow");
		flushSync();
		await Promise.resolve();
		flushSync();
		expect(target.textContent).toBe("connected/gap/shared");
		unmount(component);
		flushSync();
		await Promise.resolve();
		flushSync();
		expect(client.active()).toHaveLength(0);
		expect(client.counts.unsubscribes).toBe(1);
	});
});

// a source is a request or a feed, and an observer is a function
// or an object. A store normalises its source once, at creation.
describe("subscriptionStore with a source and a function observer", () => {
	it("a function observer on a feed receives each event and its meta", async () => {
		const client = createFakeClient();
		const seen: Array<[unknown, unknown]> = [];
		const store = subscriptionStore(client, feed("a"), (event, meta) => {
			seen.push([event, meta]);
		});
		expect(client.counts.subscribes).toBe(0);
		const stop = store.subscribe(() => {});
		await Promise.resolve();
		expect(client.active().map((consumer) => consumer.request)).toEqual([
			request("a"),
		]);
		client.emit({ n: 1 });
		expect(seen).toEqual([[{ n: 1 }, { seq: 1 }]]);
		stop();
		expect(client.counts.unsubscribes).toBe(1);
	});

	it("an inline feed in a compiled component does not resubscribe when it re-renders", async () => {
		const client = createFakeClient();
		const next = vi.fn();
		const source = `<script>
	let { client, feed, next, subscriptionStore } = $props();
	let renders = $state(0);
	let topic = $state("a");
	export function rerender() { renders += 1; }
	export function retarget(value) { topic = value; }
	const store = $derived(subscriptionStore(client, feed(topic), (event) => next(event)));
</script>
<output>{renders}/{$store.connection.state}</output>`;
		const { js } = compile(source, {
			generate: "client",
			filename: "InlineFeed.svelte",
			dev: false,
		});
		mkdirSync(generated, { recursive: true });
		const file = join(generated, `inline-feed-${Date.now()}.js`);
		writeFileSync(file, js.code);
		const { default: InlineFeed } = await import(/* @vite-ignore */ file);
		const target = document.createElement("div");
		const component = mount(InlineFeed, {
			target,
			props: { client, feed, next, subscriptionStore },
		}) as { rerender(): void; retarget(value: string): void };
		flushSync();
		await Promise.resolve();
		flushSync();
		for (let index = 0; index < 3; index += 1) {
			component.rerender();
			flushSync();
			await Promise.resolve();
			flushSync();
		}
		expect(target.textContent).toBe("3/connecting");
		expect(client.counts.subscribes).toBe(1);
		client.emit({ n: 1 });
		expect(next).toHaveBeenCalledWith({ n: 1 });
		component.retarget("b");
		flushSync();
		await Promise.resolve();
		flushSync();
		expect(client.counts.subscribes).toBe(2);
		expect(client.counts.unsubscribes).toBe(1);
		expect(client.active().map((consumer) => consumer.request)).toEqual([
			request("b"),
		]);
		unmount(component);
		flushSync();
		await Promise.resolve();
		flushSync();
		expect(client.active()).toHaveLength(0);
	});

	it("an object observer on a feed keeps next, error and status", async () => {
		const client = createFakeClient();
		const observer = { next: vi.fn(), error: vi.fn(), status: vi.fn() };
		const stop = subscriptionStore(client, feed("a"), observer).subscribe(
			() => {},
		);
		await Promise.resolve();
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
		stop();
	});
});

describe("statusStore", () => {
	it("DOM-S-01 mirrors client status through the store contract", async () => {
		const client = createFakeClient();
		const store = statusStore(client);
		const seen: string[] = [];
		const stop = store.subscribe((value) => seen.push(value.health));
		await Promise.resolve();
		client.setClientStatus({ health: "checking" });
		stop();
		client.setClientStatus({ health: "healthy" });
		expect(seen).toEqual(["unknown", "healthy", "checking"]);
	});
});
