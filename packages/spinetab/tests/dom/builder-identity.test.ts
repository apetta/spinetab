import { act, createElement, useState } from "react";
import { createRoot as createReactRoot, type Root } from "react-dom/client";
import { createSignal, createRoot as createSolidRoot } from "solid-js";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { effectScope, nextTick, ref, shallowRef } from "vue";
import * as react from "../../src/bindings/react/index.ts";
import * as solid from "../../src/bindings/solid/index.ts";
import * as svelte from "../../src/bindings/svelte/index.ts";
import * as vue from "../../src/bindings/vue/index.ts";
import type { Feed, Source } from "../../src/core/types.ts";
import { swrSubscription } from "../../src/integrations/swr/index.ts";
import { bindQuery } from "../../src/integrations/tanstack-query/index.ts";
import { graphqlWs } from "../../src/protocols/graphql-ws/index.ts";
import { socketIo } from "../../src/protocols/socket-io/index.ts";
import { polling } from "../../src/transports/polling/index.ts";
import { sse } from "../../src/transports/sse/index.ts";
import { stream } from "../../src/transports/stream/index.ts";
import { websocket } from "../../src/transports/websocket/index.ts";
import { createFakeClient, type FakeClient } from "./helpers/fake-client.ts";

type Queue = { open: number };

const builders: Array<[string, () => Feed<unknown>]> = [
	["polling", () => polling<Queue>("/api/queue")],
	["sse", () => sse("/api/ticks")],
	["stream", () => stream("/api/orders", { repeatable: true })],
	["websocket", () => websocket("wss://example.test/ws")],
];

beforeAll(() => {
	(
		globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
	).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | undefined;
let container: HTMLElement | undefined;
afterEach(() => {
	act(() => root?.unmount());
	root = undefined;
	container?.remove();
});

function render(element: ReturnType<typeof createElement>) {
	container = document.createElement("div");
	document.body.append(container);
	root = createReactRoot(container);
	act(() => root?.render(element));
}

describe("React with real builders", () => {
	for (const [name, build] of builders) {
		it(`an inline ${name} feed rebuilt on every render subscribes once`, () => {
			const client = createFakeClient();
			function View(props: { tick: number }) {
				react.useSubscription(client, build(), () => {});
				return createElement("output", null, String(props.tick));
			}
			render(createElement(View, { tick: 0 }));
			for (const tick of [1, 2, 3]) {
				act(() => root?.render(createElement(View, { tick })));
			}
			expect(container?.textContent).toBe("3");
			expect(client.counts.subscribes).toBe(1);
			expect(client.counts.unsubscribes).toBe(0);
			expect(client.active()[0]?.request).toEqual(build().subscription());
		});
	}

	it("switching between a feed and its own .subscription() keeps the subscription", () => {
		const client = createFakeClient();
		function View(props: { asRequest: boolean }) {
			const feed = polling<Queue>("/api/queue");
			react.useSubscription(
				client,
				props.asRequest ? feed.subscription() : feed,
				() => {},
			);
			return null;
		}
		render(createElement(View, { asRequest: false }));
		act(() => root?.render(createElement(View, { asRequest: true })));
		act(() => root?.render(createElement(View, { asRequest: false })));
		expect(client.counts.subscribes).toBe(1);
	});

	it("a useState setter as the observer renders each event", () => {
		const client = createFakeClient();
		function View() {
			const [queue, setQueue] = useState<Queue>();
			react.useSubscription(client, polling<Queue>("/api/queue"), setQueue);
			return createElement("output", null, String(queue?.open ?? "none"));
		}
		render(createElement(View));
		expect(container?.textContent).toBe("none");
		act(() => client.emit({ open: 4 }));
		expect(container?.textContent).toBe("4");
		act(() => client.emit({ open: 7 }));
		expect(container?.textContent).toBe("7");
		expect(client.counts.subscribes).toBe(1);
	});

	it("an inline function observer is replaced without resubscribing; the newest receives events", () => {
		const client = createFakeClient();
		const seen: string[] = [];
		function View(props: { label: string }) {
			// SSE delivers the decoded payload itself, no envelope.
			react.useSubscription(client, sse<string>("/api/ticks"), (tick) => {
				seen.push(`${props.label}:${tick}`);
			});
			return null;
		}
		render(createElement(View, { label: "a" }));
		act(() => root?.render(createElement(View, { label: "b" })));
		act(() => client.emit("x"));
		expect(seen).toEqual(["b:x"]);
		expect(client.counts.subscribes).toBe(1);
	});

	it("an observer that switches from a function to an object keeps the subscription", () => {
		const client = createFakeClient();
		const fn = vi.fn();
		const object = { next: vi.fn(), status: vi.fn() };
		function View(props: { asObject: boolean }) {
			react.useSubscription(
				client,
				polling<Queue>("/api/queue"),
				props.asObject ? object : fn,
			);
			return null;
		}
		render(createElement(View, { asObject: false }));
		act(() => root?.render(createElement(View, { asObject: true })));
		act(() => client.emit({ open: 1 }));
		expect(fn).not.toHaveBeenCalled();
		expect(object.next).toHaveBeenCalledWith({ open: 1 }, expect.anything());
		expect(client.counts.subscribes).toBe(1);
	});

	for (const [name, endpoint] of [
		["graphql-ws", () => graphqlWs("/graphql")],
		["socket.io", () => socketIo("/chat", { sharing: "shared" })],
	] as const) {
		it(`a ${name} endpoint as a source fails synchronously with unsupported-option at its path`, () => {
			const client = createFakeClient();
			const errors = vi.spyOn(console, "error").mockImplementation(() => {});
			function View() {
				react.useSubscription(
					client,
					endpoint() as unknown as Source<unknown>,
					() => {},
				);
				return null;
			}
			expect(() => render(createElement(View))).toThrowError(
				expect.objectContaining({
					code: "unsupported-option",
					detail: expect.objectContaining({ path: "subscription" }),
				}),
			);
			expect(client.counts.subscribes).toBe(0);
			errors.mockRestore();
		});
	}
});

describe("Vue, Solid and Svelte with real builders", () => {
	for (const [name, build] of builders) {
		it(`Vue: a getter that rebuilds a ${name} feed on every run subscribes once`, async () => {
			const client = createFakeClient();
			const tick = ref(0);
			const scope = effectScope();
			scope.run(() =>
				vue.useSubscription(
					client,
					() => {
						void tick.value;
						return build();
					},
					() => {},
				),
			);
			for (const value of [1, 2, 3]) {
				tick.value = value;
				await nextTick();
			}
			expect(client.counts.subscribes).toBe(1);
			scope.stop();
			expect(client.counts.unsubscribes).toBe(1);
		});

		it(`Solid: an accessor that rebuilds a ${name} feed on every run subscribes once`, () => {
			const client = createFakeClient();
			const [tick, setTick] = createSignal(0);
			const dispose = createSolidRoot((dispose) => {
				solid.createSubscription(
					client,
					() => {
						tick();
						return build();
					},
					() => {},
				);
				return dispose;
			});
			for (const value of [1, 2, 3]) setTick(value);
			expect(client.counts.subscribes).toBe(1);
			dispose();
			expect(client.counts.unsubscribes).toBe(1);
		});

		it(`Svelte: a ${name} feed subscribes its default selection`, async () => {
			const client = createFakeClient();
			const next = vi.fn();
			const store = svelte.subscriptionStore(client, build(), next);
			const off = store.subscribe(() => {});
			await Promise.resolve();
			expect(client.active()[0]?.request).toEqual(build().subscription());
			client.emit({ open: 1 });
			expect(next).toHaveBeenCalledWith({ open: 1 }, expect.anything());
			off();
			expect(client.counts.unsubscribes).toBe(1);
		});
	}

	it("Vue: a shallowRef replaced by an equivalent new feed does not resubscribe", async () => {
		const client = createFakeClient();
		const source = shallowRef<Source<Queue> | null>(
			polling<Queue>("/api/queue"),
		);
		const scope = effectScope();
		scope.run(() => vue.useSubscription(client, source, () => {}));
		source.value = polling<Queue>("/api/queue");
		await nextTick();
		source.value = polling<Queue>("/api/queue").subscription();
		await nextTick();
		expect(client.counts.subscribes).toBe(1);
		source.value = null;
		await nextTick();
		expect(client.counts.unsubscribes).toBe(1);
		scope.stop();
	});

	it("Vue, Svelte and Solid reject an endpoint source synchronously with unsupported-option", () => {
		const client = createFakeClient();
		const endpoint = socketIo("/chat", {
			sharing: "shared",
		}) as unknown as Source<unknown>;
		const unsupported = expect.objectContaining({
			code: "unsupported-option",
			detail: expect.objectContaining({ path: "subscription" }),
		});
		const scope = effectScope();
		expect(() =>
			scope.run(() => vue.useSubscription(client, endpoint, () => {})),
		).toThrowError(unsupported);
		scope.stop();
		expect(() =>
			svelte.subscriptionStore(client, endpoint, () => {}),
		).toThrowError(unsupported);
		expect(() =>
			createSolidRoot((dispose) => {
				solid.createSubscription(
					client,
					() => endpoint,
					() => {},
				);
				return dispose;
			}),
		).toThrowError(unsupported);
		expect(client.counts.subscribes).toBe(0);
	});

	it("an object observer without next is rejected at observer.next with the existing message", () => {
		const client = createFakeClient();
		const bad = { status: () => {} } as unknown as { next: () => void };
		const rejected = expect.objectContaining({
			code: "unsupported-option",
			message: "observer.next must be a function.",
			detail: { path: "observer.next" },
		});
		expect(() =>
			svelte.subscriptionStore(client, polling("/api/queue"), bad),
		).toThrowError(rejected);
		const scope = effectScope();
		expect(() =>
			scope.run(() => vue.useSubscription(client, polling("/api/queue"), bad)),
		).toThrowError(rejected);
		scope.stop();
		expect(() =>
			createSolidRoot((dispose) => {
				solid.createSubscription(client, () => polling("/api/queue"), bad);
				return dispose;
			}),
		).toThrowError(rejected);
	});
});

describe("bindQuery and SWR with real builders", () => {
	const queryClient = () => ({
		setQueryData: vi.fn(),
		setQueriesData: vi.fn(),
		invalidateQueries: vi.fn(),
		getQueryData: vi.fn(),
	});

	it("bindQuery: a feed and its .subscription() subscribe identical requests", () => {
		const client = createFakeClient();
		const feed = polling<Queue>("/api/queue");
		const options = {
			queryClient: queryClient() as never,
			onEvent: vi.fn(),
		};
		const a = bindQuery(client, feed, options);
		const b = bindQuery(client, feed.subscription(), options);
		const [first, second] = client.active();
		expect(first?.request).toEqual(second?.request);
		expect(client.upstream()).toHaveLength(1);
		client.emit({ open: 3 });
		expect(options.onEvent).toHaveBeenCalledWith(
			{ open: 3 },
			expect.anything(),
			expect.anything(),
		);
		a.unsubscribe();
		b.unsubscribe();
	});

	it("bindQuery: an endpoint source fails synchronously with unsupported-option", () => {
		const client: FakeClient = createFakeClient();
		expect(() =>
			bindQuery(client, graphqlWs("/graphql") as unknown as Source<unknown>, {
				queryClient: queryClient() as never,
				onEvent: vi.fn(),
			}),
		).toThrowError(
			expect.objectContaining({
				code: "unsupported-option",
				detail: expect.objectContaining({ path: "subscription" }),
			}),
		);
		expect(client.counts.subscribes).toBe(0);
	});

	it("SWR: requestFor may return a real feed; null subscribes nothing", () => {
		const client = createFakeClient();
		const subscribe = swrSubscription(client, (key: string | null) =>
			key === null ? null : stream(key, { repeatable: true }),
		);
		const next = vi.fn();
		const none = subscribe(null, { next });
		expect(client.counts.subscribes).toBe(0);
		none();
		const off = subscribe("/api/orders", { next });
		expect(client.active()[0]?.request).toEqual(
			stream("/api/orders", { repeatable: true }).subscription(),
		);
		client.emit({ id: 1 });
		expect(next).toHaveBeenCalledWith(null, { id: 1 });
		off();
		expect(client.counts.unsubscribes).toBe(1);
	});
});
