import {
	act,
	createElement,
	StrictMode,
	Suspense,
	startTransition,
	useState,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
	INACTIVE_STATUS,
	SERVER_STATUS,
	type UseSubscriptionResult,
	useSpinetabStatus,
	useSubscription,
} from "../../src/bindings/react/index.ts";
import type {
	ClientStatus,
	SubscriptionObserver,
	SubscriptionRequest,
} from "../../src/core/types.ts";
import {
	createFakeClient,
	type FakeClient,
	feed,
	macrotask,
	request,
} from "./helpers/fake-client.ts";

// DOM-R-01…10: the real React 19.3 runtime (react-dom/client) in happy-dom.

beforeAll(() => {
	(
		globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
	).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | undefined;
let container: HTMLElement;
afterEach(() => {
	act(() => root?.unmount());
	root = undefined;
	container?.remove();
});

function render(element: ReturnType<typeof createElement>) {
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	act(() => root?.render(element));
}

interface ProbeProps {
	client: FakeClient;
	request: SubscriptionRequest<{ n: number }> | null;
	observer: SubscriptionObserver<{ n: number }>;
	consumer?: { intervalMs: number };
	onResult?: (result: UseSubscriptionResult<{ n: number }>) => void;
}

function Probe(props: ProbeProps) {
	const result = useSubscription(
		props.client,
		props.request,
		props.observer,
		props.consumer ? { consumer: props.consumer } : undefined,
	);
	props.onResult?.(result);
	return createElement(
		"output",
		null,
		`${result.status.connection.state}/${result.status.continuity.state}`,
	);
}

describe("useSubscription", () => {
	it("DOM-R-01 N mounts share one client and one upstream, with N consumers", async () => {
		const client = createFakeClient();
		const observer = { next: vi.fn() };
		render(
			createElement(
				"div",
				null,
				...[1, 2, 3].map((index) =>
					createElement(Probe, {
						key: index,
						client,
						request: request("a"),
						observer,
					}),
				),
			),
		);
		expect(client.active()).toHaveLength(3);
		expect(client.counts.upstreamStarts).toBe(1);
		act(() => client.emit({ n: 1 }));
		expect(observer.next).toHaveBeenCalledTimes(3);
	});

	it("DOM-R-02 resubscribes only when the canonical identity changes", async () => {
		const client = createFakeClient();
		const observer = { next: vi.fn() };
		render(createElement(Probe, { client, request: request("a"), observer }));
		// Structurally equal new object: no resubscribe.
		act(() =>
			root?.render(
				createElement(Probe, {
					client,
					request: {
						...request("a"),
						connection: { url: "wss://example.test/feed" },
					},
					observer,
				}),
			),
		);
		expect(client.counts.subscribes).toBe(1);
		act(() =>
			root?.render(
				createElement(Probe, { client, request: request("b"), observer }),
			),
		);
		expect(client.counts.subscribes).toBe(2);
		expect(client.counts.unsubscribes).toBe(1);
		expect(
			client.active().map((consumer) => consumer.request.subscription),
		).toEqual([{ topic: "b" }]);
		// Old identity events are not delivered even by a leaky runtime.
		const leaky = createFakeClient({ leaky: true });
		const seen = vi.fn();
		act(() =>
			root?.render(
				createElement(Probe, {
					client: leaky,
					request: request("a"),
					observer: { next: seen },
				}),
			),
		);
		act(() =>
			root?.render(
				createElement(Probe, {
					client: leaky,
					request: request("b"),
					observer: { next: seen },
				}),
			),
		);
		act(() => leaky.emit({ n: 1 }, (consumer) => consumer.closed));
		expect(seen).not.toHaveBeenCalled();
	});

	it("DOM-R-03 new callbacks are used without resubscribing", () => {
		const client = createFakeClient();
		const first = vi.fn();
		const second = vi.fn();
		render(
			createElement(Probe, {
				client,
				request: request("a"),
				observer: { next: first },
			}),
		);
		act(() =>
			root?.render(
				createElement(Probe, {
					client,
					request: request("a"),
					observer: { next: second },
				}),
			),
		);
		act(() => client.emit({ n: 2 }));
		expect(first).not.toHaveBeenCalled();
		expect(second).toHaveBeenCalledWith({ n: 2 }, { seq: 1 });
		expect(client.counts.subscribes).toBe(1);
	});

	it("DOM-R-04 unmount releases exactly once and nothing runs afterwards", async () => {
		const client = createFakeClient({ leaky: true });
		const observer = { next: vi.fn(), status: vi.fn() };
		render(createElement(Probe, { client, request: request("a"), observer }));
		act(() => root?.unmount());
		root = undefined;
		expect(client.counts.unsubscribes).toBe(1);
		client.emit({ n: 1 });
		client.setConnection("connected");
		expect(observer.next).not.toHaveBeenCalled();
		expect(observer.status).not.toHaveBeenCalled();
		await macrotask();
		expect(client.upstream()).toEqual([]);
	});

	it("DOM-R-05 Strict Mode leaves one consumer and one upstream with balanced counters", async () => {
		const client = createFakeClient();
		render(
			createElement(
				StrictMode,
				null,
				createElement(Probe, {
					client,
					request: request("a"),
					observer: { next: vi.fn() },
				}),
			),
		);
		await act(macrotask);
		expect(client.active()).toHaveLength(1);
		expect(client.counts.subscribes - client.counts.unsubscribes).toBe(1);
		expect(client.counts.upstreamStarts).toBe(1);
		expect(client.upstream()).toHaveLength(1);
		act(() => root?.unmount());
		root = undefined;
		await macrotask();
		expect(client.counts.subscribes).toBe(client.counts.unsubscribes);
		expect(client.upstream()).toEqual([]);
	});

	it("DOM-R-06 status follows the store with stable snapshots", () => {
		const client = createFakeClient();
		const results: Array<UseSubscriptionResult<{ n: number }>> = [];
		render(
			createElement(Probe, {
				client,
				request: request("a"),
				observer: { next: vi.fn() },
				onResult: (result) => results.push(result),
			}),
		);
		expect(container.textContent).toBe("connecting/continuous");
		const renders = results.length;
		act(() => client.setConnection("connected"));
		expect(container.textContent).toBe("connected/continuous");
		act(() => client.setContinuity("gap", "overflow"));
		expect(container.textContent).toBe("connected/gap");
		expect(results.length).toBe(renders + 2);
		const last = results.at(-1);
		const previous = results.at(-2);
		expect(last?.markReconciled).toBe(previous?.markReconciled);
		expect(last?.retry).toBe(previous?.retry);
		act(() => last?.markReconciled());
		expect(client.active()[0]?.reconciled).toBe(1);
	});

	it("DOM-R-07 a null request holds no subscription and reports inactive", () => {
		const client = createFakeClient();
		let result: UseSubscriptionResult<{ n: number }> | undefined;
		render(
			createElement(Probe, {
				client,
				request: null,
				observer: { next: vi.fn() },
				onResult: (value) => {
					result = value;
				},
			}),
		);
		expect(client.counts.subscribes).toBe(0);
		expect(result?.status).toBe(INACTIVE_STATUS);
		expect(result?.subscription).toBeNull();
	});

	it("DOM-R-08 a late mount receives nothing until upstream emits (no second cache)", () => {
		const client = createFakeClient();
		const early = vi.fn();
		const late = vi.fn();
		function Late() {
			const [show, setShow] = useState(false);
			(globalThis as { showLate?: () => void }).showLate = () => setShow(true);
			return createElement(
				"div",
				null,
				createElement(Probe, {
					client,
					request: request("a"),
					observer: { next: early },
				}),
				show
					? createElement(Probe, {
							client,
							request: request("a"),
							observer: { next: late },
						})
					: null,
			);
		}
		render(createElement(Late));
		act(() => client.emit({ n: 1 }));
		act(() => (globalThis as { showLate?: () => void }).showLate?.());
		expect(late).not.toHaveBeenCalled();
		act(() => client.emit({ n: 2 }));
		expect(late).toHaveBeenCalledTimes(1);
		expect(late).toHaveBeenCalledWith({ n: 2 }, expect.anything());
	});

	it("DOM-R-09 retry is stable and retries only this handle; consumer option changes update without resubscribing", () => {
		const client = createFakeClient();
		let result: UseSubscriptionResult<{ n: number }> | undefined;
		const props = {
			client,
			request: request("poll"),
			observer: { next: vi.fn() },
			onResult: (value: UseSubscriptionResult<{ n: number }>) => {
				result = value;
			},
		};
		render(createElement(Probe, { ...props, consumer: { intervalMs: 1000 } }));
		act(() => result?.retry());
		expect(client.active()[0]?.retries).toBe(1);
		expect(client.counts.retries).toBe(0);
		act(() =>
			root?.render(
				createElement(Probe, { ...props, consumer: { intervalMs: 1000 } }),
			),
		);
		expect(client.active()[0]?.updates).toEqual([]);
		act(() =>
			root?.render(
				createElement(Probe, { ...props, consumer: { intervalMs: 5000 } }),
			),
		);
		expect(client.counts.subscribes).toBe(1);
		expect(client.active()[0]?.updates).toEqual([{ intervalMs: 5000 }]);
		expect(client.active()[0]?.options?.consumer).toEqual({ intervalMs: 1000 });
	});

	it("DOM-R-10 a suspended transition keeps the committed actions live; nothing reaches the handle after unmount", async () => {
		const client = createFakeClient({ leaky: true });
		const observer = { next: vi.fn(), status: vi.fn() };
		const never = new Promise<never>(() => {});
		const committed: Array<UseSubscriptionResult<{ n: number }>> = [];
		let switchTopic: ((topic: string) => void) | undefined;
		let suspendedRenders = 0;
		function Screen() {
			const [topic, setTopic] = useState("a");
			switchTopic = setTopic;
			const binding = useSubscription(client, request(topic), observer);
			if (topic === "b") {
				suspendedRenders += 1;
				throw never;
			}
			committed.push(binding);
			return createElement(
				"div",
				null,
				createElement(
					"button",
					{ type: "button", onClick: binding.markReconciled },
					topic,
				),
				createElement(
					"button",
					{ type: "button", onClick: binding.retry },
					"retry",
				),
			);
		}
		render(
			createElement(
				Suspense,
				{ fallback: createElement("span", null, "loading") },
				createElement(Screen),
			),
		);
		const [reconcile, retry] = Array.from(container.querySelectorAll("button"));
		const click = (button: Element | undefined) =>
			act(() => {
				button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			});
		const a = client.active()[0];
		click(reconcile);
		expect(a?.reconciled).toBe(1);

		// B renders (handle null for its identity) and suspends inside a
		// transition: React keeps A displayed, subscribed and interactive.
		await act(async () => startTransition(() => switchTopic?.("b")));
		expect(suspendedRenders).toBeGreaterThan(0);
		expect(container.textContent).toBe("aretry");
		expect(client.counts.subscribes).toBe(1);
		expect(client.active()).toEqual([a]);
		click(reconcile);
		click(retry);
		expect(a?.reconciled).toBe(2);
		expect(a?.retries).toBe(1);
		expect(new Set(committed.map((result) => result.markReconciled)).size).toBe(
			1,
		);

		const { markReconciled } = committed.at(-1) ?? {};
		act(() => root?.unmount());
		root = undefined;
		expect(client.counts.unsubscribes).toBe(1);
		const calls = observer.status.mock.calls.length;
		markReconciled?.();
		client.emit({ n: 1 });
		client.setConnection("connected");
		expect(a?.reconciled).toBe(2);
		expect(observer.next).not.toHaveBeenCalled();
		expect(observer.status).toHaveBeenCalledTimes(calls);
	});

	it("DOM-R-01 refuses to run without an application client", () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		expect(() =>
			render(
				createElement(Probe, {
					client: undefined as unknown as FakeClient,
					request: request("a"),
					observer: { next: vi.fn() },
				}),
			),
		).toThrowError(expect.objectContaining({ code: "unsupported-option" }));
		errors.mockRestore();
	});
});

// a source is a request or a feed, and an observer is a function
// or an object. The key comes from the normalised request.
function InlineFeed(props: {
	client: FakeClient;
	topic: string;
	render: number;
	next: (event: { n: number }) => void;
}) {
	useSubscription(props.client, feed(props.topic), (event) =>
		props.next(event),
	);
	return createElement("output", null, String(props.render));
}

describe("useSubscription with a source and a function observer", () => {
	it("a function observer on a feed receives each event and its meta", () => {
		const client = createFakeClient();
		const seen: Array<[unknown, unknown]> = [];
		function View() {
			useSubscription(client, feed("a"), (event, meta) => {
				seen.push([event, meta]);
			});
			return null;
		}
		render(createElement(View));
		expect(client.active().map((consumer) => consumer.request)).toEqual([
			request("a"),
		]);
		act(() => client.emit({ n: 1 }));
		act(() => client.emit({ n: 2 }));
		expect(seen).toEqual([
			[{ n: 1 }, { seq: 1 }],
			[{ n: 2 }, { seq: 2 }],
		]);
	});

	it("an inline feed rebuilt on every render does not resubscribe", () => {
		const client = createFakeClient();
		const next = vi.fn();
		render(createElement(InlineFeed, { client, topic: "a", render: 0, next }));
		for (const count of [1, 2, 3]) {
			act(() =>
				root?.render(
					createElement(InlineFeed, {
						client,
						topic: "a",
						render: count,
						next,
					}),
				),
			);
		}
		expect(container.textContent).toBe("3");
		expect(client.counts.subscribes).toBe(1);
		// The newest inline closure receives events without resubscribing.
		act(() => client.emit({ n: 1 }));
		expect(next).toHaveBeenCalledWith({ n: 1 });
		act(() =>
			root?.render(
				createElement(InlineFeed, { client, topic: "b", render: 4, next }),
			),
		);
		expect(client.counts.subscribes).toBe(2);
		expect(client.counts.unsubscribes).toBe(1);
		expect(client.active().map((consumer) => consumer.request)).toEqual([
			request("b"),
		]);
	});

	it("an object observer on a feed keeps next, error and status", () => {
		const client = createFakeClient();
		const observer = { next: vi.fn(), error: vi.fn(), status: vi.fn() };
		function View() {
			useSubscription(client, feed("a"), observer);
			return null;
		}
		render(createElement(View));
		act(() => client.emit({ n: 1 }));
		act(() => client.setConnection("connected"));
		act(() => client.fail({ code: "upstream-error", message: "boom" }));
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
	});
});

describe("useSpinetabStatus", () => {
	it("DOM-R-06 follows client status; stable snapshot and server snapshot constant", () => {
		const client = createFakeClient();
		const seen: ClientStatus[] = [];
		function Status() {
			const status = useSpinetabStatus(client);
			seen.push(status);
			return createElement("span", null, status.mode);
		}
		render(createElement(Status));
		expect(container.textContent).toBe("shared");
		act(() => client.setClientStatus({ health: "reattaching" }));
		expect(seen.at(-1)?.health).toBe("reattaching");
		expect(seen.every((status) => status !== SERVER_STATUS)).toBe(true);
		expect(Object.isFrozen(SERVER_STATUS)).toBe(true);
	});
});
