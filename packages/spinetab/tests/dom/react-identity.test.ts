import {
	Activity,
	act,
	Component,
	createElement,
	Fragment,
	type ReactNode,
	StrictMode,
	Suspense,
	startTransition,
	useEffect,
	useLayoutEffect,
	useState,
} from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
	bindClient,
	useLive,
	useSubscription,
} from "../../src/bindings/react/index.ts";
import type { SpinetabClient } from "../../src/core/types.ts";
import {
	byTopic,
	createFakeClient,
	type FakeClient,
	feed,
} from "./helpers/fake-client.ts";
import { append, rowsFor, upstream } from "./helpers/identity-rows.ts";
import {
	disposeDrivers,
	type LiveBinding,
	liveDrivers,
} from "./helpers/live-drivers.ts";
import {
	type Tick as CoreTick,
	coreRequest,
	createRealCore,
	oversized,
	pause,
	type RealCore,
	waitFor,
} from "./helpers/real-core.ts";

beforeAll(() => {
	(
		globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
	).IS_REACT_ACT_ENVIRONMENT = true;
});

type Tick = { n: number };

let root: Root | undefined;
let container: HTMLElement;
let core: RealCore | undefined;
afterEach(async () => {
	act(() => root?.unmount());
	root = undefined;
	container?.remove();
	await disposeDrivers();
	core?.dispose();
	core = undefined;
});

function mount(element: ReturnType<typeof createElement>) {
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	act(() => root?.render(element));
}
const show = (element: ReturnType<typeof createElement>) =>
	act(() => root?.render(element));
const shown = () => JSON.parse(container.textContent ?? "{}");
const silence = () => vi.spyOn(console, "error").mockImplementation(() => {});
/** `<Activity mode>` around one child (its props type requires `children`). */
const activity = (
	mode: "visible" | "hidden",
	children: ReturnType<typeof createElement>,
) => createElement(Activity, { mode, children });
const tickReact = (run: () => Promise<void>) => act(run);

class Boundary extends Component<{ children: ReactNode }, { error: unknown }> {
	override state = { error: undefined as unknown };
	static getDerivedStateFromError(error: unknown) {
		return { error };
	}
	override render() {
		const { error } = this.state;
		return error
			? createElement("p", null, `caught:${(error as { code?: string }).code}`)
			: this.props.children;
	}
}

interface Snapshot {
	data: unknown;
	error: string | null;
	needs: boolean;
	handleOf: string | null;
}
function LiveView(props: {
	client: FakeClient;
	topic: string | false;
	options?: Record<string, unknown>;
	clients?: Record<string, FakeClient>;
	log?: Snapshot[];
}) {
	const live = useLive<Tick, unknown>(
		props.client,
		props.topic === false ? false : feed(props.topic),
		props.options as never,
	);
	// Which client's consumer the returned handle belongs to (fake handles share ids).
	let handleOf: string | null = null;
	for (const [name, client] of Object.entries(props.clients ?? {})) {
		if (client.consumers.some((c) => c.status === live.subscription?.status)) {
			handleOf = name;
		}
	}
	const snapshot: Snapshot = {
		data: live.data ?? null,
		error: live.error?.code ?? null,
		needs: live.needsReconcile,
		handleOf,
	};
	props.log?.push(snapshot);
	return createElement("output", null, JSON.stringify(snapshot));
}

/** Runs `run` from a sibling's layout effect: after LiveView's layout effect
 * (latest ref) and before its passive effect (release + attach). */
function Injector({ run }: { run?: () => void }) {
	useLayoutEffect(() => {
		run?.();
	});
	return null;
}

/** Runs `run` from a sibling's passive effect: after LiveView's attach and
 * before the re-render that commits the new attachment. */
function Later({ run }: { run?: () => void }) {
	useEffect(() => {
		run?.();
	});
	return null;
}

/** The fake consumer behind a handle and whether it is released. */
function handleLabel(client: FakeClient, handle: unknown): string | null {
	const status = (handle as { status?: unknown } | null)?.status;
	const consumer = client.consumers.find((c) => c.status === status);
	return consumer
		? `${consumer.id}:${consumer.closed ? "released" : "live"}`
		: null;
}

interface SegmentRender {
	data: unknown;
	error: string | null;
	handle: string | null;
}
/** One route segment's `useLive`; logs every render, handle included. */
function Segment(props: {
	client: FakeClient;
	topic: string;
	seen: SegmentRender[];
	options?: Record<string, unknown>;
}) {
	const live = useLive<Tick, unknown>(
		props.client,
		feed(props.topic),
		(props.options ?? append) as never,
	);
	const render: SegmentRender = {
		data: live.data ?? null,
		error: live.error?.code ?? null,
		handle: handleLabel(props.client, live.subscription),
	};
	props.seen.push(render);
	return createElement("output", null, JSON.stringify(render));
}

/** A Next-style layout router (Cache Components navigation): every visited
 * segment stays mounted under a keyed `<Activity>`; only the route is visible. */
function LayoutRouter(props: {
	client: FakeClient;
	route: string;
	visited: string[];
	seen: Record<string, SegmentRender[]>;
}) {
	return createElement(
		Fragment,
		null,
		...props.visited.map((segment) =>
			createElement(
				Fragment,
				{ key: segment },
				activity(
					segment === props.route ? "visible" : "hidden",
					createElement(Segment, {
						client: props.client,
						topic: segment,
						seen: props.seen[segment] as SegmentRender[],
					}),
				),
			),
		),
	);
}

describe("DOM-ID-R root review cases", () => {
	for (const middle of ["b", false] as const) {
		it(`does not resurrect old data after a -> ${middle} -> a without an intervening event`, () => {
			const client = createFakeClient();
			function View({ topic }: { topic: string | false }) {
				const live = useLive(client, topic === false ? false : feed(topic));
				return createElement(
					"output",
					null,
					JSON.stringify({
						data: live.data ?? null,
						error: live.error?.code ?? null,
					}),
				);
			}
			mount(createElement(View, { topic: "a" }));
			act(() => client.emit({ n: 7 }));
			expect(shown().data).toEqual({ n: 7 });
			show(createElement(View, { topic: middle }));
			expect(shown().data).toBeNull();
			show(createElement(View, { topic: "a" }));
			expect(shown().data).toBeNull();
		});
	}

	it("resets data when the client is replaced with the same source", () => {
		const first = createFakeClient();
		const second = createFakeClient();
		function View({ client }: { client: FakeClient }) {
			const live = useLive(client, feed("a"));
			return createElement("output", null, JSON.stringify(live.data ?? null));
		}
		mount(createElement(View, { client: first }));
		act(() => first.emit({ n: 7 }));
		show(createElement(View, { client: second }));
		expect(second.counts.subscribes).toBe(1);
		expect(shown()).toBeNull();
	});
});

describe("DOM-ID-R class (A1): value bound to the committed attachment", () => {
	it("A1 a -> b -> a with reduce: the new a subscription's first event does not fold onto the old a value", () => {
		const client = createFakeClient();
		const view = (topic: string | false) =>
			createElement(LiveView, { client, topic, options: append });
		mount(view("a"));
		act(() => client.emit({ n: 7 }));
		show(view("b"));
		show(view("a"));
		act(() => client.emit({ n: 1 }, byTopic("a")));
		expect(shown().data).toEqual([1]);
	});

	it("A2 a -> false -> a returns initial in the first render with a again", () => {
		const client = createFakeClient();
		const log: Snapshot[] = [];
		const view = (topic: string | false) =>
			createElement(LiveView, {
				client,
				topic,
				options: { initial: { n: 0 } },
				log,
			});
		mount(view("a"));
		act(() => client.emit({ n: 7 }));
		show(view(false));
		log.length = 0;
		show(view("a"));
		expect(log[0]?.data).toEqual({ n: 0 });
		expect(shown().data).toEqual({ n: 0 });
	});

	it("A3 the bindClient path starts from initial too (a -> false -> a)", () => {
		const client = createFakeClient();
		const bound = bindClient(client);
		function Bound({ on }: { on: boolean }) {
			const live = bound.useLive(on && feed("a"));
			return createElement(
				"output",
				null,
				JSON.stringify({ data: live.data ?? null }),
			);
		}
		mount(createElement(Bound, { on: true }));
		act(() => client.emit({ n: 7 }));
		show(createElement(Bound, { on: false }));
		show(createElement(Bound, { on: true }));
		expect(shown().data).toBeNull();
	});
});

describe("DOM-ID-R class (A1): the client joins every identity comparison", () => {
	it("B1 the first render with a new client returns no handle and inactive status, never the old client's", () => {
		const first = createFakeClient();
		const second = createFakeClient();
		const log: Snapshot[] = [];
		const clients = { first, second };
		mount(createElement(LiveView, { client: first, topic: "a", clients, log }));
		act(() => first.setContinuity("unknown", "reconnected"));
		log.length = 0;
		show(createElement(LiveView, { client: second, topic: "a", clients, log }));
		expect(log[0]?.handleOf).toBeNull();
		expect(log[0]?.error).toBeNull();
		expect(log[0]?.needs).toBe(false);
		expect(log.some((s) => s.handleOf === "first")).toBe(false);
	});

	it("B2 the old client's terminal error does not follow the new client, even after its events", () => {
		const first = createFakeClient();
		const second = createFakeClient();
		mount(createElement(LiveView, { client: first, topic: "a" }));
		act(() => first.fail(upstream));
		expect(shown().error).toBe("upstream-error");
		show(createElement(LiveView, { client: second, topic: "a" }));
		const afterSwitch = shown();
		act(() => second.emit({ n: 1 }));
		expect(afterSwitch.error).toBeNull();
		expect(shown()).toMatchObject({ data: { n: 1 }, error: null });
	});

	it("B3 with reduce the new client's first event does not fold onto the old client's value", () => {
		const first = createFakeClient();
		const second = createFakeClient();
		mount(
			createElement(LiveView, { client: first, topic: "a", options: append }),
		);
		act(() => first.emit({ n: 7 }));
		show(
			createElement(LiveView, { client: second, topic: "a", options: append }),
		);
		act(() => second.emit({ n: 1 }));
		expect(shown().data).toEqual([1]);
	});

	it("B4 (ID-13 client) an old-client event between commit and the passive effect is not taken as the new client's", () => {
		const first = createFakeClient();
		const second = createFakeClient();
		const tree = (client: FakeClient, run?: () => void) =>
			createElement(
				Fragment,
				null,
				createElement(LiveView, { client, topic: "a" }),
				createElement(Injector, { run }),
			);
		mount(tree(first));
		show(tree(second, () => first.emit({ n: 99 })));
		expect(first.counts.unsubscribes).toBe(1);
		expect(shown().data).toBeNull();
	});

	it("B5 (ID-13 key, guard) an old-key event in the same window after a -> b is dropped", () => {
		const client = createFakeClient();
		const tree = (topic: string, run?: () => void) =>
			createElement(
				Fragment,
				null,
				createElement(LiveView, { client, topic }),
				createElement(Injector, { run }),
			);
		mount(tree("a"));
		show(tree("b", () => client.emit({ n: 99 }, byTopic("a"))));
		expect(shown().data).toBeNull();
	});

	it("B6 useSubscription: an old-client error in that window does not reach the new render's hook", () => {
		const first = createFakeClient();
		const second = createFakeClient();
		const hook = vi.fn();
		function Sub({ client }: { client: FakeClient }) {
			useSubscription(client, feed("a"), { next() {}, error: hook });
			return null;
		}
		const tree = (client: FakeClient, run?: () => void) =>
			createElement(
				Fragment,
				null,
				createElement(Sub, { client }),
				createElement(Injector, { run }),
			);
		mount(tree(first));
		show(tree(second, () => first.fail(upstream)));
		expect(hook).not.toHaveBeenCalled();
	});

	it("B7 client and consumer change in one render: no update() on the released old handle", () => {
		const first = createFakeClient();
		const second = createFakeClient();
		function Sub({ client, ms }: { client: FakeClient; ms: number }) {
			useSubscription(client, feed("a"), () => {}, {
				consumer: { intervalMs: ms },
			});
			return null;
		}
		mount(createElement(Sub, { client: first, ms: 1_000 }));
		show(createElement(Sub, { client: second, ms: 2_000 }));
		expect(first.consumers[0]?.updates).toEqual([]);
		expect(second.consumers[0]?.options?.consumer).toEqual({
			intervalMs: 2_000,
		});
		expect(second.consumers[0]?.updates).toEqual([]);
	});
});

describe("DOM-ID-R class (A1) and ID-11: the throwOnError failure is owned by its attachment", () => {
	function Sub(props: {
		client: FakeClient;
		topic: string;
		onError?: () => void;
	}) {
		useSubscription(
			props.client,
			feed(props.topic),
			{ next() {}, error: props.onError ?? (() => {}) },
			{ throwOnError: true },
		);
		return createElement("p", null, `ok:${props.topic}`);
	}

	it("an error hook that switches source leaves no failure to throw when the source returns", () => {
		silence();
		const client = createFakeClient();
		let setTopic: ((topic: string) => void) | undefined;
		function Parent() {
			const [topic, set] = useState("a");
			setTopic = set;
			return createElement(
				Boundary,
				null,
				createElement(Sub, { client, topic, onError: () => set("b") }),
			);
		}
		mount(createElement(Parent));
		act(() => client.fail(upstream, byTopic("a")));
		const afterError = container.textContent;
		act(() => setTopic?.("a"));
		expect(afterError).toBe("ok:b");
		expect(container.textContent).toBe("ok:a");
		expect(client.active()).toHaveLength(1);
	});

	it("useLive: an error batched with a -> b is not thrown on b -> a", () => {
		silence();
		const client = createFakeClient();
		const tree = (topic: string) =>
			createElement(
				Boundary,
				null,
				createElement(LiveView, {
					client,
					topic,
					options: { throwOnError: true },
				}),
			);
		mount(tree("a"));
		act(() => {
			client.fail(upstream, byTopic("a"));
			root?.render(tree("b"));
		});
		expect(shown()).toMatchObject({ data: null, error: null });
		show(tree("a"));
		expect(container.textContent).not.toContain("caught:");
		expect(client.active()).toHaveLength(1);
	});

	it("useSubscription: an error batched with a -> b is not thrown on b -> a", () => {
		silence();
		const client = createFakeClient();
		const tree = (topic: string) =>
			createElement(Boundary, null, createElement(Sub, { client, topic }));
		mount(tree("a"));
		act(() => {
			client.fail(upstream, byTopic("a"));
			root?.render(tree("b"));
		});
		expect(container.textContent).toBe("ok:b");
		show(tree("a"));
		expect(container.textContent).toBe("ok:a");
		expect(client.active()).toHaveLength(1);
	});

	it("useLive: an old client's error batched with a client switch is not thrown for the new client", () => {
		silence();
		const first = createFakeClient();
		const second = createFakeClient();
		const tree = (client: FakeClient) =>
			createElement(
				Boundary,
				null,
				createElement(LiveView, {
					client,
					topic: "a",
					options: { throwOnError: true },
				}),
			);
		mount(tree(first));
		act(() => {
			first.fail(upstream);
			root?.render(tree(second));
		});
		expect(container.textContent).not.toContain("caught:");
		expect(second.active()).toHaveLength(1);
	});

	it("useSubscription: a latent failure is not thrown after a client change", () => {
		silence();
		const first = createFakeClient();
		const second = createFakeClient();
		const tree = (client: FakeClient) =>
			createElement(Boundary, null, createElement(Sub, { client, topic: "a" }));
		mount(tree(first));
		act(() => {
			first.fail(upstream);
			root?.render(tree(second));
		});
		expect(container.textContent).toBe("ok:a");
		expect(second.active()).toHaveLength(1);
	});

	it("(guard) throwOnError still throws on the render after a same-identity error", () => {
		silence();
		const client = createFakeClient();
		mount(
			createElement(
				Boundary,
				null,
				createElement(LiveView, {
					client,
					topic: "a",
					options: { throwOnError: true },
				}),
			),
		);
		act(() => client.fail(upstream));
		expect(container.textContent).toBe("caught:upstream-error");
	});
});

describe("DOM-ID-R class (A1): error and initial after an identity change", () => {
	for (const middle of ["b", false] as const) {
		it(`D1 a terminal error on a does not return after a -> ${middle} -> a, nor stay after new events`, () => {
			const client = createFakeClient();
			const view = (topic: string | false) =>
				createElement(LiveView, {
					client,
					topic,
					options: { initial: { n: 0 } },
				});
			mount(view("a"));
			act(() => client.emit({ n: 7 }));
			act(() => client.fail(upstream));
			show(view(middle));
			show(view("a"));
			const back = shown();
			act(() => client.emit({ n: 1 }, byTopic("a")));
			expect(back).toMatchObject({ data: { n: 0 }, error: null });
			expect(shown()).toMatchObject({ data: { n: 1 }, error: null });
		});
	}

	it("E1 a client switch returns initial in the same render", () => {
		const first = createFakeClient();
		const second = createFakeClient();
		const log: Snapshot[] = [];
		const options = { initial: { n: 0 } };
		mount(createElement(LiveView, { client: first, topic: "a", options, log }));
		act(() => first.emit({ n: 7 }));
		log.length = 0;
		show(createElement(LiveView, { client: second, topic: "a", options, log }));
		expect(log[0]?.data).toEqual({ n: 0 });
		expect(shown().data).toEqual({ n: 0 });
	});
});

describe("DOM-ID-R class (A1): Strict Mode and Activity", () => {
	it("(guard) Strict Mode useLive: one consumer, one delivery per event, balanced counters", () => {
		const client = createFakeClient();
		mount(
			createElement(
				StrictMode,
				null,
				createElement(LiveView, { client, topic: "a", options: append }),
			),
		);
		expect(client.active()).toHaveLength(1);
		act(() => client.emit({ n: 1 }));
		act(() => client.emit({ n: 2 }));
		expect(shown().data).toEqual([1, 2]);
		act(() => root?.unmount());
		root = undefined;
		expect(client.counts.subscribes).toBe(client.counts.unsubscribes);
	});

	it("Strict Mode a -> false -> a starts from initial", () => {
		const client = createFakeClient();
		const view = (topic: string | false) =>
			createElement(
				StrictMode,
				null,
				createElement(LiveView, { client, topic }),
			);
		mount(view("a"));
		act(() => client.emit({ n: 7 }));
		show(view(false));
		show(view("a"));
		expect(client.active()).toHaveLength(1);
		expect(shown().data).toBeNull();
	});

	it("(guard) Strict Mode throwOnError reaches the boundary once per error", () => {
		silence();
		const client = createFakeClient();
		const errorHook = vi.fn();
		function Sub() {
			useSubscription(
				client,
				feed("a"),
				{ next() {}, error: errorHook },
				{ throwOnError: true },
			);
			return createElement("p", null, "ok");
		}
		mount(
			createElement(
				StrictMode,
				null,
				createElement(Boundary, null, createElement(Sub)),
			),
		);
		act(() => client.fail(upstream));
		expect(container.textContent).toBe("caught:upstream-error");
		expect(errorHook).toHaveBeenCalledTimes(1);
	});

	it("(ID-A) Activity hide/show re-creates the subscription at initial; the released value is not continued", () => {
		const client = createFakeClient();
		const log: Snapshot[] = [];
		const view = (mode: "visible" | "hidden") =>
			activity(
				mode,
				createElement(LiveView, { client, topic: "a", options: append, log }),
			);
		mount(view("visible"));
		act(() => client.emit({ n: 7 }));
		show(view("hidden"));
		const hiddenActive = client.active().length;
		act(() => client.emit({ n: 8 })); // missed: nothing is subscribed
		log.length = 0;
		show(view("visible"));
		const reshown = shown();
		act(() => client.emit({ n: 9 }));
		expect(hiddenActive).toBe(0);
		expect(client.counts.subscribes).toBe(2);
		expect(reshown).toMatchObject({ data: null, error: null });
		expect(log.map((s) => s.data)).not.toContainEqual([7]);
		expect(shown().data).toEqual([9]);
	});

	it("ID-A the reveal render never returns the released handle", () => {
		const client = createFakeClient();
		const seen: Array<string | null> = [];
		function View() {
			const live = useLive(client, feed("a"));
			const consumer = client.consumers.find(
				(c) => c.status === live.subscription?.status,
			);
			seen.push(
				consumer
					? `${consumer.id}:${consumer.closed ? "released" : "live"}`
					: null,
			);
			return null;
		}
		const view = (mode: "visible" | "hidden") =>
			activity(mode, createElement(View));
		mount(view("visible"));
		show(view("hidden"));
		seen.length = 0;
		show(view("visible"));
		expect(seen.some((s) => s?.endsWith(":released"))).toBe(false);
		expect(seen.at(-1)).toBe("consumer-2:live");
	});

	it("ID-A a terminal error before hiding is cleared for the re-created subscription", () => {
		const client = createFakeClient();
		const log: Snapshot[] = [];
		const view = (mode: "visible" | "hidden") =>
			activity(mode, createElement(LiveView, { client, topic: "a", log }));
		mount(view("visible"));
		act(() => client.fail(upstream));
		expect(shown().error).toBe("upstream-error");
		show(view("hidden"));
		log.length = 0;
		show(view("visible"));
		// Every render from the reveal on, not only the settled one.
		expect(log.length).toBeGreaterThan(0);
		expect(log.filter((s) => s.error !== null)).toEqual([]);
		expect(shown()).toMatchObject({ data: null, error: null });
	});

	it("ID-A a reveal committed right after the hide (no idle flush between) never shows the released error or handle", () => {
		const client = createFakeClient();
		const seen: SegmentRender[] = [];
		const view = (mode: "visible" | "hidden") =>
			activity(
				mode,
				createElement(Segment, { client, topic: "a", seen, options: {} }),
			);
		mount(view("visible"));
		act(() => client.fail(upstream));
		expect(seen.at(-1)?.error).toBe("upstream-error");
		seen.length = 0;
		act(() => {
			flushSync(() => root?.render(view("hidden")));
			flushSync(() => root?.render(view("visible")));
		});
		expect(seen.length).toBeGreaterThan(0);
		expect(
			seen.filter((s) => s.error !== null || s.handle?.endsWith(":released")),
		).toEqual([]);
		expect(seen.at(-1)).toEqual({
			data: null,
			error: null,
			handle: "consumer-2:live",
		});
	});

	it('Next-style layout router with <Activity mode="hidden">: back-navigation re-creates a segment at initial, never shows a released handle and folds only new events', () => {
		const client = createFakeClient();
		const seen = { a: [] as SegmentRender[], b: [] as SegmentRender[] };
		const at = (route: string, visited: string[]) =>
			createElement(LayoutRouter, { client, route, visited, seen });
		mount(at("a", ["a"]));
		act(() => client.emit({ n: 7 }, byTopic("a")));
		expect(seen.a.at(-1)?.data).toEqual([7]);
		// Forward to b: a stays mounted, hidden, and its subscription is released.
		show(at("b", ["a", "b"]));
		act(() => client.emit({ n: 1 }, byTopic("b")));
		act(() => client.emit({ n: 8 }, byTopic("a"))); // missed: a is hidden
		expect(client.active().map((c) => c.request.subscription)).toEqual([
			{ topic: "b" },
		]);
		expect(seen.b.at(-1)?.data).toEqual([1]);
		// Back to a: a new subscription at initial; only later events fold.
		seen.a.length = 0;
		show(at("a", ["a", "b"]));
		act(() => client.emit({ n: 9 }, byTopic("a")));
		expect(seen.a[0]).toEqual({ data: null, error: null, handle: null });
		expect(seen.a.filter((s) => s.handle?.endsWith(":released"))).toEqual([]);
		expect(seen.a.filter((s) => /[78]/.test(JSON.stringify(s.data)))).toEqual(
			[],
		);
		expect(seen.a.at(-1)).toMatchObject({ data: [9], error: null });
		// Forward to b again: b is re-created at initial too.
		seen.b.length = 0;
		show(at("b", ["a", "b"]));
		expect(seen.b.length).toBeGreaterThan(0);
		expect(seen.b.filter((s) => s.handle?.endsWith(":released"))).toEqual([]);
		expect(seen.b.filter((s) => s.data !== null)).toEqual([]);
		expect(client.active().map((c) => c.request.subscription)).toEqual([
			{ topic: "b" },
		]);
		expect(client.counts.subscribes).toBe(4);
		expect(client.counts.subscribes - client.counts.unsubscribes).toBe(1);
	});
});

describe("DOM-ID-R class (A1): concurrent and suspended renders (guards)", () => {
	it("a suspended transition to b keeps a displayed, delivered and unchanged; nothing subscribes b", async () => {
		const client = createFakeClient();
		const never = new Promise<never>(() => {});
		let setTopic: ((topic: string) => void) | undefined;
		function Screen() {
			const [topic, set] = useState("a");
			setTopic = set;
			const live = useLive<Tick, Tick>(client, feed(topic));
			if (topic === "b") throw never;
			return createElement("output", null, JSON.stringify(live.data ?? null));
		}
		mount(
			createElement(
				Suspense,
				{ fallback: createElement("span", null, "loading") },
				createElement(Screen),
			),
		);
		act(() => client.emit({ n: 7 }));
		await act(async () => startTransition(() => setTopic?.("b")));
		const during = container.textContent;
		act(() => client.emit({ n: 8 }));
		expect(during).toBe('{"n":7}');
		expect(container.textContent).toBe('{"n":8}');
		expect(client.counts.subscribes).toBe(1);
	});

	it("a suspended transition to a new client neither subscribes it nor redirects the old delivery", async () => {
		const first = createFakeClient();
		const second = createFakeClient();
		const never = new Promise<never>(() => {});
		let setClient: ((client: FakeClient) => void) | undefined;
		function Screen() {
			const [client, set] = useState<FakeClient>(first);
			setClient = set;
			const live = useLive<Tick, Tick>(client, feed("a"));
			if (client === second) throw never;
			return createElement("output", null, JSON.stringify(live.data ?? null));
		}
		mount(
			createElement(
				Suspense,
				{ fallback: createElement("span", null, "loading") },
				createElement(Screen),
			),
		);
		act(() => first.emit({ n: 7 }));
		await act(async () => startTransition(() => setClient?.(second)));
		act(() => first.emit({ n: 8 }));
		expect(container.textContent).toBe('{"n":8}');
		expect(second.counts.subscribes).toBe(0);
	});

	it("returning from a discarded transition keeps the same live subscription and its value", async () => {
		const client = createFakeClient();
		const never = new Promise<never>(() => {});
		let setTopic: ((topic: string) => void) | undefined;
		function Screen() {
			const [topic, set] = useState("a");
			setTopic = set;
			const live = useLive<Tick, Tick>(client, feed(topic));
			if (topic === "b") throw never;
			return createElement("output", null, JSON.stringify(live.data ?? null));
		}
		mount(
			createElement(
				Suspense,
				{ fallback: createElement("span", null, "loading") },
				createElement(Screen),
			),
		);
		act(() => client.emit({ n: 7 }));
		await act(async () => startTransition(() => setTopic?.("b")));
		await act(async () => startTransition(() => setTopic?.("a")));
		expect(container.textContent).toBe('{"n":7}');
		expect(client.counts.subscribes).toBe(1);
		expect(client.counts.unsubscribes).toBe(0);
	});

	it("I1 (guard) key and consumer change together: b subscribes with the new consumer; no update() anywhere", () => {
		const client = createFakeClient();
		function Sub({ topic, ms }: { topic: string; ms: number }) {
			useSubscription(client, feed(topic), () => {}, {
				consumer: { intervalMs: ms },
			});
			return null;
		}
		mount(createElement(Sub, { topic: "a", ms: 1_000 }));
		show(createElement(Sub, { topic: "b", ms: 2_000 }));
		show(createElement(Sub, { topic: "b", ms: 2_000 }));
		expect(client.consumers.map((c) => c.updates)).toEqual([[], []]);
		expect(client.consumers[1]?.options?.consumer).toEqual({
			intervalMs: 2_000,
		});
	});
});

describe("DOM-ID-R extra (A1 W1-W4): properties the repair keeps", () => {
	function View(props: {
		client: FakeClient;
		topic: string | false;
		initial?: unknown;
	}) {
		const live = useLive<Tick, unknown>(
			props.client,
			props.topic === false ? false : feed(props.topic),
			props.initial === undefined
				? undefined
				: ({ initial: props.initial } as never),
		);
		return createElement(
			"output",
			null,
			JSON.stringify({
				data: live.data ?? null,
				error: live.error?.code ?? null,
			}),
		);
	}

	it("an event between the new attachment and its committed re-render is kept", () => {
		const client = createFakeClient();
		const tree = (topic: string, run?: () => void) =>
			createElement(
				Fragment,
				null,
				createElement(View, { client, topic }),
				createElement(Later, { run }),
			);
		mount(tree("a"));
		act(() => client.emit({ n: 7 }));
		show(tree("b", () => client.emit({ n: 5 }, byTopic("b"))));
		expect(shown().data).toEqual({ n: 5 });
	});

	it("SSR renders initial and subscribes nothing", () => {
		const client = createFakeClient();
		const html = renderToString(
			createElement(View, { client, topic: "a", initial: { n: 0 } }),
		);
		expect(html).toContain("{&quot;n&quot;:0}");
		expect(client.counts.subscribes).toBe(0);
	});

	it("no React warnings across switches, a client change, Strict Mode and unmount", () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
		const first = createFakeClient();
		const second = createFakeClient();
		const tree = (client: FakeClient, topic: string | false) =>
			createElement(StrictMode, null, createElement(View, { client, topic }));
		mount(tree(first, "a"));
		act(() => first.emit({ n: 1 }));
		show(tree(first, "b"));
		show(tree(first, false));
		show(tree(second, "a"));
		act(() => second.emit({ n: 2 }));
		act(() => root?.unmount());
		root = undefined;
		expect(errors).not.toHaveBeenCalled();
		expect(warns).not.toHaveBeenCalled();
		expect(first.counts.subscribes).toBe(first.counts.unsubscribes);
		expect(second.counts.subscribes).toBe(second.counts.unsubscribes);
	});

	it("a -> b (event) -> a shows initial, then only the new a data", () => {
		const client = createFakeClient();
		mount(createElement(View, { client, topic: "a" }));
		act(() => client.emit({ n: 7 }));
		show(createElement(View, { client, topic: "b" }));
		act(() => client.emit({ n: 8 }, byTopic("b")));
		show(createElement(View, { client, topic: "a" }));
		expect(shown().data).toBeNull();
		act(() => client.emit({ n: 9 }, byTopic("a")));
		expect(shown().data).toEqual({ n: 9 });
	});

	it("SYNC an event delivered synchronously inside subscribe belongs to the new attachment", () => {
		const client = createFakeClient({
			onSubscribe(consumer) {
				if (byTopic("b")(consumer))
					consumer.observer.next({ n: 5 }, { seq: 1 });
			},
		});
		mount(createElement(View, { client, topic: "a" }));
		act(() => client.emit({ n: 7 }));
		show(createElement(View, { client, topic: "b" }));
		expect(shown().data).toEqual({ n: 5 });
	});

	it("KEYS the results keep their public shape: no internal owner leaks", () => {
		const client = createFakeClient();
		const keys: string[][] = [];
		function Both() {
			keys.push(
				Object.keys(useSubscription(client, feed("a"), () => {})).sort(),
			);
			keys.push(Object.keys(useLive(client, feed("b"))).sort());
			return null;
		}
		mount(createElement(Both));
		expect(keys.at(-2)).toEqual([
			"markReconciled",
			"retry",
			"status",
			"subscription",
		]);
		expect(keys.at(-1)).toEqual([
			"data",
			"error",
			"markReconciled",
			"needsReconcile",
			"retry",
			"status",
			"subscription",
		]);
	});
});

// A3's matrix on the shared drivers and rows (helpers/live-drivers.ts,
// helpers/identity-rows.ts); owner 2 runs the same rows for Vue, Solid and Svelte.
const reactBinding = liveDrivers.react as LiveBinding;
const rows = rowsFor("react");

describe("DOM-ID-R matrix (A3) on the React driver", () => {
	for (const [name, row] of rows) {
		it(name, () => row(reactBinding.mount, false));
	}
});

describe("DOM-ID-R ID-08 Strict Mode variants", () => {
	const strict: LiveBinding["mount"] = (state, extra) =>
		reactBinding.mount(state, { ...extra, strict: true });
	for (const [name, row] of rows.filter(([id]) =>
		/^ID-(01|02|04|10|14) /.test(id),
	)) {
		it(`ID-08 ${name}`, () => row(strict, true));
	}
});

describe("DOM-ID-R ID-09 suspended transitions", () => {
	function harness() {
		const client = createFakeClient();
		let gate:
			| { promise: Promise<void>; open(): void; done: boolean }
			| undefined;
		const newGate = () => {
			let open!: () => void;
			const promise = new Promise<void>((resolve) => {
				open = resolve;
			});
			const result = { promise, open, done: false };
			promise.then(() => {
				result.done = true;
			});
			return result;
		};
		let switchTopic!: (topic: string) => void;
		function Screen() {
			const [topic, setTopic] = useState("a");
			switchTopic = setTopic;
			const live = useLive<Tick>(client, feed(topic));
			if (topic === "b" && gate && !gate.done) throw gate.promise;
			return createElement(
				"output",
				null,
				JSON.stringify({ topic, data: live.data ?? null }),
			);
		}
		mount(
			createElement(Suspense, { fallback: "loading" }, createElement(Screen)),
		);
		return {
			client,
			suspendNext: () => {
				gate = newGate();
				return gate;
			},
			switchTo: (topic: string) =>
				act(async () => startTransition(() => switchTopic(topic))),
		};
	}

	it("ID-09a (guard) an abandoned suspended transition keeps the committed identity and its value", async () => {
		const h = harness();
		act(() => h.client.emit({ n: 7 }));
		h.suspendNext();
		await h.switchTo("b");
		expect(shown()).toEqual({ topic: "a", data: { n: 7 } });
		expect(h.client.counts.subscribes).toBe(1);
		act(() => h.client.emit({ n: 8 }));
		expect(shown()).toEqual({ topic: "a", data: { n: 8 } });
		await h.switchTo("a");
		expect(shown()).toEqual({ topic: "a", data: { n: 8 } });
		expect(h.client.counts.subscribes).toBe(1);
	});

	it("ID-09b a transition-committed a -> b -> a returns initial", async () => {
		const h = harness();
		act(() => h.client.emit({ n: 7 }));
		const gate = h.suspendNext();
		await h.switchTo("b");
		await act(async () => {
			gate.open();
			await gate.promise;
		});
		expect(shown()).toEqual({ topic: "b", data: null });
		await h.switchTo("a");
		expect(h.client.counts.subscribes).toBe(3);
		expect(shown()).toEqual({ topic: "a", data: null });
	});
});

describe("DOM-ID-R rule for useSubscription (guard)", () => {
	it("without a status hook core still reports stopped delivery; with one it does not", () => {
		for (const observer of [() => {}, { next() {}, status() {} }]) {
			const client = createFakeClient({ reportUnhandledErrors: true });
			function Sub() {
				useSubscription(client, feed("a"), observer);
				return null;
			}
			mount(createElement(Sub));
			act(() => client.setContinuity("gap", "overflow"));
			expect(client.reports).toEqual(
				typeof observer === "function" ? ["continuity-lost"] : [],
			);
			act(() => root?.unmount());
			root = undefined;
			container.remove();
		}
	});
});

describe("DOM-ID-RC real page client and runtime", () => {
	function CoreView(props: {
		client: SpinetabClient;
		topic: string | false;
		reconcile?: "latest";
	}) {
		const live = useLive<CoreTick>(
			props.client,
			props.topic === false ? false : coreRequest(props.topic),
			props.reconcile ? { reconcile: props.reconcile } : undefined,
		);
		return createElement(
			"output",
			null,
			JSON.stringify({
				data: live.data ?? null,
				error: live.error?.code ?? null,
				needs: live.needsReconcile,
			}),
		);
	}
	const until = (check: () => boolean, label: string) =>
		waitFor(check, label, tickReact);

	it("RC-01 a -> b -> a without an event on b: a's old value does not return", async () => {
		core = createRealCore();
		const { client, sinks } = core;
		mount(createElement(CoreView, { client, topic: "a" }));
		await until(() => sinks.has("a"), "a registered");
		sinks.get("a")?.next({ n: 7 });
		await until(() => shown().data?.n === 7, "a event");
		show(createElement(CoreView, { client, topic: "b" }));
		await until(() => sinks.has("b"), "b registered");
		sinks.delete("a");
		show(createElement(CoreView, { client, topic: "a" }));
		await until(() => sinks.has("a"), "a re-registered");
		await act(pause);
		expect(shown().data).toBeNull();
	});

	it("RC-02 a terminal upstream error on a does not reappear after a -> b -> a", async () => {
		core = createRealCore();
		const { client, sinks } = core;
		mount(createElement(CoreView, { client, topic: "a" }));
		await until(() => sinks.has("a"), "a registered");
		sinks.get("a")?.error(upstream);
		await until(() => shown().error === "upstream-error", "a error");
		show(createElement(CoreView, { client, topic: "b" }));
		await until(() => sinks.has("b"), "b registered");
		sinks.delete("a");
		show(createElement(CoreView, { client, topic: "a" }));
		await until(() => sinks.has("a"), "a re-registered");
		await act(pause);
		expect(shown().error).toBeNull();
	});

	it("RC-03 (ID-15) an oversized event without a policy is error continuity-lost and no loud report", async () => {
		core = createRealCore();
		const { client, sinks, reports } = core;
		mount(createElement(CoreView, { client, topic: "a" }));
		await until(() => sinks.has("a"), "a registered");
		sinks.get("a")?.next(oversized);
		await until(() => shown().error === "continuity-lost", "loss shown");
		await act(pause);
		expect({ shown: shown().error, reports }).toEqual({
			shown: "continuity-lost",
			reports: [],
		});
	});

	it("RC-04 (guard) with reconcile latest an oversized event is no error and no report", async () => {
		core = createRealCore();
		const { client, sinks, reports } = core;
		mount(createElement(CoreView, { client, topic: "a", reconcile: "latest" }));
		await until(() => sinks.has("a"), "a registered");
		sinks.get("a")?.next(oversized);
		await until(() => shown().needs === true, "loss flagged");
		await act(pause);
		expect({ shown: shown().error, reports }).toEqual({
			shown: null,
			reports: [],
		});
	});

	it("RC-04b (guard) useSubscription without a status hook keeps core's loud report", async () => {
		core = createRealCore();
		const { client, sinks, reports } = core;
		function Sub() {
			useSubscription<CoreTick>(client, coreRequest("a"), () => {});
			return null;
		}
		mount(createElement(Sub));
		await until(() => sinks.has("a"), "a registered");
		sinks.get("a")?.next(oversized);
		await until(() => reports.length > 0, "loss reported");
		expect(reports).toEqual(["continuity-lost"]);
	});

	it("RC-05 (ID-16) after setScope the previous principal's data is gone; the loss stays visible", async () => {
		core = createRealCore();
		const { client, sinks } = core;
		mount(createElement(CoreView, { client, topic: "a" }));
		await until(() => sinks.has("a"), "a registered");
		sinks.get("a")?.next({ n: 7 });
		await until(() => shown().data?.n === 7, "a event");
		sinks.delete("a");
		act(() => client.setScope("user-b"));
		await until(() => sinks.has("a"), "a re-registered under the new scope");
		await act(pause);
		expect(shown()).toEqual({
			data: null,
			error: "continuity-lost",
			needs: true,
		});
		sinks.get("a")?.next({ n: 8 });
		await until(() => shown().data?.n === 8, "new principal's event");
	});

	it("RC-06 (ID-16) with reconcile latest, after setScope data is initial and no error shows", async () => {
		core = createRealCore();
		const { client, sinks } = core;
		mount(createElement(CoreView, { client, topic: "a", reconcile: "latest" }));
		await until(() => sinks.has("a"), "a registered");
		sinks.get("a")?.next({ n: 7 });
		await until(() => shown().data?.n === 7, "a event");
		sinks.delete("a");
		act(() => client.setScope("user-b"));
		await until(() => sinks.has("a"), "a re-registered under the new scope");
		await act(pause);
		expect(shown()).toEqual({ data: null, error: null, needs: true });
		sinks.get("a")?.next({ n: 8 });
		await until(() => shown().needs === false, "reconciled by the next event");
		expect(shown()).toEqual({ data: { n: 8 }, error: null, needs: false });
	});
});
