import { act, createElement, StrictMode, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import {
	batch,
	createRenderEffect,
	createSignal,
	createRoot as createSolidRoot,
} from "solid-js";
import { createApp, defineComponent, nextTick, shallowRef } from "vue";
import {
	type UseLiveResult,
	useLive,
} from "../../../src/bindings/react/index.ts";
import type {
	LiveOptions,
	LiveSnapshot,
} from "../../../src/bindings/shared/live.ts";
import {
	createLive,
	type LiveResource,
} from "../../../src/bindings/solid/index.ts";
import {
	type LiveStore,
	liveStore,
} from "../../../src/bindings/svelte/index.ts";
import {
	useLive as useVueLive,
	type UseLiveResult as VueLiveResult,
} from "../../../src/bindings/vue/index.ts";
import type {
	Source,
	SpinetabClient,
	Subscription,
	SubscriptionStatus,
} from "../../../src/core/types.ts";
import { feed, macrotask } from "./fake-client.ts";

/**
 * Table-driven drivers for the value hooks (lane A identity matrix, A3's
 * regression matrix ID-01..ID-17), so one row runs unchanged across React
 * `useLive`, Vue `useLive`, Solid `createLive` and Svelte `liveStore`.
 *
 * Every driver follows the same `LiveBinding` contract:
 * - `mount` subscribes as the framework does (React: a root; Vue: a
 * component, so live work starts in `onMounted`; Solid: a root; Svelte: one
 * store subscriber) and resolves after the first flush.
 * - `update` applies a new topic, options or client and flushes (React:
 * `act`; Vue: `nextTick`; Solid: one `batch`; Svelte: a new store for a new
 * topic or options, subscribed before the old one is unsubscribed).
 * Bindings that take the client once leave `switchesClient` false and
 * refuse a new client; their ID-10 tests mount a second value hook instead.
 * - `deliver(run)` runs an outside change (an event) and flushes.
 * - `settle(run)` is `deliver` that also waits one macrotask, for the promise
 * reactions the change starts (a refresh's reconcile), inside React's async
 * `act`.
 * - `renders` records every value the view produced, in order (React and
 * Vue: each component render; Solid: each render effect run, synchronous;
 * Svelte: each published value, synchronous); `read()` is the value a
 * component would show now.
 */
export type Topic = string | false | null;
export type Tick = { n: number };

export interface LiveRead {
	data: unknown;
	/** The error's code, or `null`. */
	error: string | null;
	needs: boolean;
	subscription: Subscription<unknown> | null;
	status: SubscriptionStatus;
}

export interface LiveState {
	client: SpinetabClient;
	topic: Topic;
	options?: LiveOptions<Tick, unknown>;
}

export interface LiveDriver {
	read(): LiveRead;
	readonly renders: LiveRead[];
	update(change: Partial<LiveState>): Promise<void>;
	deliver(run: () => void): Promise<void>;
	settle(run?: () => void): Promise<void>;
	markReconciled(options?: { pending?: boolean }): void;
	retry(): void;
	dispose(): Promise<void>;
}

export interface LiveBinding {
	name: "react" | "vue" | "solid" | "svelte";
	/** Whether one mounted value hook can switch clients. */
	switchesClient: boolean;
	mount(
		initial: LiveState,
		extra?: {
			/** React only: wrap in `<StrictMode>`. */
			strict?: boolean;
			/** Builds the source for a topic; default `feed(topic)`. */
			build?: (topic: string) => Source<Tick>;
		},
	): Promise<LiveDriver>;
}

const open = new Set<LiveDriver>();

/** For `afterEach`: disposes every driver still mounted. */
export async function disposeDrivers(): Promise<void> {
	for (const driver of [...open]) await driver.dispose();
}

const react: LiveBinding = {
	name: "react",
	switchesClient: true,
	async mount(initial, extra = {}) {
		(
			globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
		).IS_REACT_ACT_ENVIRONMENT = true;
		const build = extra.build ?? feed;
		const renders: LiveRead[] = [];
		let committed: UseLiveResult<Tick, unknown> | undefined;
		let state = initial;
		function View(props: LiveState) {
			const result = useLive<Tick, unknown>(
				props.client,
				typeof props.topic === "string" ? build(props.topic) : props.topic,
				props.options,
			);
			renders.push(snapshot(result));
			useLayoutEffect(() => {
				committed = result;
			});
			return null;
		}
		const tree = () => {
			const view = createElement(View, state);
			return extra.strict ? createElement(StrictMode, null, view) : view;
		};
		const container = document.createElement("div");
		const root = createRoot(container);
		act(() => root.render(tree()));
		const driver: LiveDriver = {
			read() {
				if (!committed) throw new Error("nothing committed");
				return snapshot(committed);
			},
			renders,
			async update(change) {
				state = { ...state, ...change };
				act(() => root.render(tree()));
			},
			async deliver(run) {
				act(run);
			},
			async settle(run = () => {}) {
				await act(async () => {
					run();
					await macrotask();
				});
			},
			markReconciled(options) {
				committed?.markReconciled(options);
			},
			retry() {
				committed?.retry();
			},
			async dispose() {
				if (!open.delete(driver)) return;
				act(() => root.unmount());
			},
		};
		open.add(driver);
		return driver;
	},
};

function snapshot(result: UseLiveResult<Tick, unknown>): LiveRead {
	return {
		data: result.data ?? null,
		error: result.error?.code ?? null,
		needs: result.needsReconcile,
		subscription: result.subscription as Subscription<unknown> | null,
		status: result.status,
	};
}

const refuseClient =
	(name: string, current: SpinetabClient) => (change: Partial<LiveState>) => {
		if (change.client !== undefined && change.client !== current) {
			throw new Error(`${name} takes its client once`);
		}
	};

const vue: LiveBinding = {
	name: "vue",
	switchesClient: false,
	async mount(initial, extra = {}) {
		const build = extra.build ?? feed;
		const renders: LiveRead[] = [];
		const check = refuseClient("vue", initial.client);
		const topic = shallowRef<Topic>(initial.topic);
		const options = shallowRef(initial.options);
		let result: VueLiveResult<Tick, unknown> | undefined;
		const Probe = defineComponent({
			setup() {
				// biome-ignore lint/correctness/useHookAtTopLevel: Vue composable in setup(), not a React hook.
				const live = useVueLive<Tick, unknown>(
					initial.client,
					() =>
						typeof topic.value === "string" ? build(topic.value) : topic.value,
					() => options.value,
				);
				result = live;
				return () => {
					renders.push(vueSnapshot(live));
					return null;
				};
			},
		});
		const app = createApp(Probe);
		app.mount(document.createElement("div"));
		await nextTick();
		const driver: LiveDriver = {
			read() {
				if (!result) throw new Error("nothing mounted");
				return vueSnapshot(result);
			},
			renders,
			async update(change) {
				check(change);
				if ("options" in change) options.value = change.options;
				if ("topic" in change) topic.value = change.topic as Topic;
				await nextTick();
			},
			async deliver(run) {
				run();
				await nextTick();
			},
			async settle(run = () => {}) {
				run();
				await macrotask();
				await nextTick();
			},
			markReconciled(markOptions) {
				result?.markReconciled(markOptions);
			},
			retry() {
				result?.retry();
			},
			async dispose() {
				if (!open.delete(driver)) return;
				app.unmount();
				await nextTick();
			},
		};
		open.add(driver);
		return driver;
	},
};

function vueSnapshot(result: VueLiveResult<Tick, unknown>): LiveRead {
	return {
		data: result.data.value ?? null,
		error: result.error.value?.code ?? null,
		needs: result.needsReconcile.value,
		subscription: result.subscription.value as Subscription<unknown> | null,
		status: result.status.value,
	};
}

const solid: LiveBinding = {
	name: "solid",
	switchesClient: false,
	async mount(initial, extra = {}) {
		const build = extra.build ?? feed;
		const renders: LiveRead[] = [];
		const check = refuseClient("solid", initial.client);
		let setTopic!: (topic: Topic) => void;
		let setOptions!: (options: LiveState["options"]) => void;
		let result!: LiveResource<Tick, unknown>;
		const disposeRoot = createSolidRoot((dispose) => {
			const [topic, writeTopic] = createSignal<Topic>(initial.topic);
			const [options, writeOptions] = createSignal(initial.options);
			setTopic = (next) => writeTopic(() => next);
			setOptions = (next) => writeOptions(() => next);
			result = createLive<Tick, unknown>(
				initial.client,
				() => {
					const current = topic();
					return typeof current === "string" ? build(current) : current;
				},
				options,
			);
			// Stands in for JSX: render effects run before the resource's effects.
			createRenderEffect(() => {
				renders.push(solidSnapshot(result));
			});
			return dispose;
		});
		const driver: LiveDriver = {
			read: () => solidSnapshot(result),
			renders,
			async update(change) {
				check(change);
				batch(() => {
					if ("options" in change) setOptions(change.options);
					if ("topic" in change) setTopic(change.topic as Topic);
				});
			},
			async deliver(run) {
				run();
			},
			async settle(run = () => {}) {
				run();
				await macrotask();
			},
			markReconciled(markOptions) {
				result.markReconciled(markOptions);
			},
			retry() {
				result.retry();
			},
			async dispose() {
				if (!open.delete(driver)) return;
				disposeRoot();
			},
		};
		open.add(driver);
		return driver;
	},
};

function solidSnapshot(result: LiveResource<Tick, unknown>): LiveRead {
	return {
		data: result.data() ?? null,
		error: result.error()?.code ?? null,
		needs: result.needsReconcile(),
		subscription: result.subscription() as Subscription<unknown> | null,
		status: result.status(),
	};
}

const svelte: LiveBinding = {
	name: "svelte",
	switchesClient: false,
	async mount(initial, extra = {}) {
		const build = extra.build ?? feed;
		const renders: LiveRead[] = [];
		const check = refuseClient("svelte", initial.client);
		let state = initial;
		let store: LiveStore<Tick, unknown> | undefined;
		let latest: LiveRead | undefined;
		let off = () => {};
		// As `$derived(liveStore(…))` read with `$store`: a new store per input.
		const swap = () => {
			const next = liveStore<Tick, unknown>(
				state.client,
				typeof state.topic === "string" ? build(state.topic) : state.topic,
				state.options,
			);
			const stop = next.subscribe((value) => {
				latest = svelteSnapshot(value, next);
				renders.push(latest);
			});
			off();
			off = stop;
			store = next;
		};
		swap();
		const driver: LiveDriver = {
			read() {
				if (!latest) throw new Error("nothing published");
				return latest;
			},
			renders,
			async update(change) {
				check(change);
				state = { ...state, ...change };
				swap();
			},
			async deliver(run) {
				run();
			},
			async settle(run = () => {}) {
				run();
				await macrotask();
			},
			markReconciled(markOptions) {
				store?.markReconciled(markOptions);
			},
			retry() {
				store?.retry();
			},
			async dispose() {
				if (!open.delete(driver)) return;
				off();
			},
		};
		open.add(driver);
		return driver;
	},
};

function svelteSnapshot(
	value: LiveSnapshot<unknown>,
	store: LiveStore<Tick, unknown>,
): LiveRead {
	return {
		data: value.data ?? null,
		error: value.error?.code ?? null,
		needs: value.needsReconcile,
		subscription: store.subscription as Subscription<unknown> | null,
		status: value.status,
	};
}

export const liveDrivers: Record<LiveBinding["name"], LiveBinding> = {
	react,
	vue,
	solid,
	svelte,
};
