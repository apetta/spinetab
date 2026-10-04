import { act, Component, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
	bindClient,
	type UseLiveResult,
	type UseSubscriptionResult,
	useLive,
	useSubscription,
} from "../../src/bindings/react/index.ts";
import { SpinetabError } from "../../src/core/errors.ts";
import type { Source } from "../../src/core/types.ts";
import {
	createFakeClient,
	type FakeClient,
	feed,
	macrotask,
} from "./helpers/fake-client.ts";

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

type Tick = { n: number };

class Boundary extends Component<{ children: ReactNode }, { error: unknown }> {
	override state = { error: undefined as unknown };
	static getDerivedStateFromError(error: unknown) {
		return { error };
	}
	override render() {
		const { error } = this.state;
		return error
			? createElement("p", null, `caught:${(error as SpinetabError).code}`)
			: this.props.children;
	}
}

describe("bindClient", () => {
	it("bindClient returns the hooks with the client applied and starts nothing", () => {
		const client = createFakeClient();
		const bound = bindClient(client);
		expect(Object.keys(bound).sort()).toEqual([
			"useLive",
			"useSpinetabStatus",
			"useSubscription",
			"useSubscriptionStatus",
		]);
		expect(client.counts.subscribes).toBe(0);
		expect(client.counts.starts).toBe(0);
		const seen: number[] = [];
		function View({ topic }: { topic: string }) {
			bound.useSubscription(feed(topic), (tick) => seen.push(tick.n));
			const live = bound.useLive(feed(topic));
			const mode = bound.useSpinetabStatus().mode;
			return createElement(
				"output",
				null,
				`${mode}/${(live.data as Tick | undefined)?.n ?? "-"}`,
			);
		}
		render(
			createElement(
				"div",
				null,
				createElement(View, { topic: "a" }),
				createElement(View, { topic: "a" }),
			),
		);
		expect(client.active()).toHaveLength(4);
		expect(client.counts.upstreamStarts).toBe(1);
		act(() => client.emit({ n: 1 }));
		expect(seen).toEqual([1, 1]);
		expect(container.textContent).toBe("shared/1shared/1");
	});

	it("bindClient refuses a missing client", () => {
		expect(() => bindClient(undefined as never)).toThrow(SpinetabError);
	});
});

describe("useSubscription options", () => {
	it("false disables like null", () => {
		const client = createFakeClient();
		let result: UseSubscriptionResult<Tick> | undefined;
		function View({ on }: { on: boolean }) {
			result = useSubscription(client, on && feed("a"), () => {});
			return null;
		}
		render(createElement(View, { on: false }));
		expect(client.counts.subscribes).toBe(0);
		expect(result?.subscription).toBeNull();
		act(() => root?.render(createElement(View, { on: true })));
		expect(client.active()).toHaveLength(1);
		act(() => root?.render(createElement(View, { on: false })));
		expect(client.active()).toHaveLength(0);
	});

	it('reconcile "latest": a loss restarts delivery and the next event reconciles', () => {
		const client = createFakeClient();
		function View() {
			useSubscription(client, feed("a"), () => {}, { reconcile: "latest" });
			return null;
		}
		render(createElement(View));
		act(() => client.setContinuity("gap", "overflow"));
		const consumer = client.active()[0];
		expect(consumer?.pendingReconciles).toBe(1);
		act(() => client.emit({ n: 1 }));
		expect(consumer?.status.get().continuity.state).toBe("continuous");
	});

	it("a reconcile function refreshes while connected and then reconciles; the newest closure runs", async () => {
		const client = createFakeClient();
		const first = vi.fn();
		const second = vi.fn(async () => {});
		function View({ refresh }: { refresh: () => Promise<void> | void }) {
			useSubscription(client, feed("a"), () => {}, { reconcile: refresh });
			return null;
		}
		render(createElement(View, { refresh: first }));
		act(() => root?.render(createElement(View, { refresh: second })));
		expect(client.counts.subscribes).toBe(1);
		act(() => {
			client.setConnection("connected");
			client.setContinuity("unknown", "reconnected");
		});
		await act(async () => {
			await vi.waitFor(() =>
				expect(client.active()[0]?.status.get().continuity.state).toBe(
					"continuous",
				),
			);
		});
		expect(first).not.toHaveBeenCalled();
		expect(second).toHaveBeenCalledTimes(1);
	});

	it.each([
		"observer",
		"connection",
	] as const)("throwOnError sends a terminal error to the error boundary, never a loss or a resumable state (%s)", (source) => {
		const client = createFakeClient();
		const errorHook = vi.fn();
		const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
		function View() {
			useSubscription(
				client,
				feed("a"),
				{ next() {}, error: errorHook },
				{ throwOnError: true },
			);
			return createElement("p", null, "ok");
		}
		render(createElement(Boundary, null, createElement(View)));
		act(() => {
			client.setContinuity("gap", "overflow");
			client.setConnection("retry-exhausted");
			client.setConnection("auth-blocked");
		});
		expect(container.textContent).toBe("ok");
		act(() =>
			source === "observer"
				? client.fail({ code: "subscribe-rejected", message: "no" })
				: client.setConnection("failed", "permanent-error"),
		);
		expect(container.textContent).toBe(
			source === "observer"
				? "caught:subscribe-rejected"
				: "caught:upstream-error",
		);
		expect(errorHook).toHaveBeenCalledTimes(source === "observer" ? 1 : 0);
		quiet.mockRestore();
	});

	it("without an error hook a terminal error is rethrown into the client's callback guard; a hook takes it", () => {
		const client = createFakeClient();
		const hook = vi.fn();
		function View() {
			useSubscription(client, feed("a"), () => {});
			useSubscription(client, feed("b"), { next() {}, error: hook });
			return null;
		}
		render(createElement(View));
		const [bare, hooked] = client.active();
		expect(() =>
			bare?.observer.error?.({ code: "subscribe-rejected", message: "no" }),
		).toThrow(expect.objectContaining({ code: "subscribe-rejected" }));
		expect(() =>
			hooked?.observer.error?.({ code: "subscribe-rejected", message: "no" }),
		).not.toThrow();
		expect(hook).toHaveBeenCalledTimes(1);
	});

	it("retry reaches only its own subscription", () => {
		const client = createFakeClient();
		const results: Array<UseSubscriptionResult<Tick>> = [];
		function View({ topic }: { topic: string }) {
			results.push(useSubscription(client, feed(topic), () => {}));
			return null;
		}
		render(
			createElement(
				"div",
				null,
				createElement(View, { topic: "a" }),
				createElement(View, { topic: "b" }),
			),
		);
		act(() => results.at(-2)?.retry());
		expect(client.active().map((consumer) => consumer.retries)).toEqual([1, 0]);
		expect(client.counts.retries).toBe(0);
	});
});

describe("useLive", () => {
	function LiveView<T>(props: {
		client: FakeClient;
		source: Source<Tick> | null | false;
		options?: Parameters<typeof useLive<Tick, T>>[2];
		onResult?: (result: UseLiveResult<Tick, T>) => void;
	}) {
		const result = useLive<Tick, T>(props.client, props.source, props.options);
		props.onResult?.(result);
		return createElement(
			"output",
			null,
			JSON.stringify({
				data: result.data ?? null,
				error: result.error?.code ?? null,
				needs: result.needsReconcile,
			}),
		);
	}
	const shown = () => JSON.parse(container.textContent ?? "{}");

	it("data starts at initial and follows map or reduce", () => {
		const client = createFakeClient();
		render(
			createElement(
				"div",
				null,
				createElement(LiveView<number>, {
					client,
					source: feed("a"),
					options: { initial: 0, map: (tick: Tick) => tick.n * 10 },
				}),
			),
		);
		expect(container.textContent).toContain('"data":0');
		act(() => client.emit({ n: 2 }));
		expect(container.textContent).toContain('"data":20');
		act(() => root?.unmount());
		render(
			createElement(LiveView<number[]>, {
				client,
				source: feed("a"),
				options: {
					reduce: (current: number[] | undefined, tick: Tick) =>
						tick.n < 0 ? undefined : [...(current ?? []), tick.n],
				},
			}),
		);
		act(() => client.emit({ n: 1 }));
		act(() => client.emit({ n: -1 }));
		act(() => client.emit({ n: 2 }));
		expect(shown().data).toEqual([1, 2]);
	});

	it("an identity change resets data in the same render; a late mount is never seeded", () => {
		const client = createFakeClient();
		const renders: Array<unknown> = [];
		const view = (topic: string) =>
			createElement(LiveView<Tick>, {
				client,
				source: feed(topic),
				onResult: (result: UseLiveResult<Tick, Tick>) =>
					renders.push(result.data),
			});
		render(view("a"));
		act(() => client.emit({ n: 7 }));
		expect(shown().data).toEqual({ n: 7 });
		renders.length = 0;
		act(() => root?.render(view("b")));
		// The first render with the new identity already shows no value.
		expect(renders[0]).toBeUndefined();
		expect(shown().data).toBeNull();
		// A second mount of the same identity starts empty (no shared cache).
		const late = document.createElement("div");
		const lateRoot = createRoot(late);
		act(() =>
			lateRoot.render(
				createElement(LiveView<Tick>, { client, source: feed("b") }),
			),
		);
		expect(JSON.parse(late.textContent ?? "{}").data).toBeNull();
		act(() => lateRoot.unmount());
	});

	it("an unreconciled loss without a policy is error continuity-lost with needsReconcile; markReconciled clears it", () => {
		const client = createFakeClient();
		let result: UseLiveResult<Tick, Tick> | undefined;
		render(
			createElement(LiveView<Tick>, {
				client,
				source: feed("a"),
				onResult: (value: UseLiveResult<Tick, Tick>) => {
					result = value;
				},
			}),
		);
		act(() => client.emit({ n: 1 }));
		act(() => client.setContinuity("unknown", "reconnected"));
		expect(shown()).toEqual({
			data: { n: 1 },
			error: "continuity-lost",
			needs: true,
		});
		const first = result?.error;
		// A connection-only change keeps the same error object.
		act(() => client.setConnection("connected"));
		expect(result?.error).toBe(first);
		act(() => result?.markReconciled());
		expect(shown()).toEqual({ data: { n: 1 }, error: null, needs: false });
	});

	it("with a policy a loss is no error; needsReconcile stays true until reconciled", () => {
		const client = createFakeClient();
		render(
			createElement(LiveView<Tick>, {
				client,
				source: feed("a"),
				options: { reconcile: "latest" },
			}),
		);
		act(() => client.setContinuity("gap", "overflow"));
		expect(shown()).toEqual({ data: null, error: null, needs: true });
		act(() => client.emit({ n: 3 }));
		expect(shown()).toEqual({ data: { n: 3 }, error: null, needs: false });
	});

	it.each([
		"observer",
		"connection",
	] as const)("a terminal error is returned as a value; throwOnError sends it to the boundary (%s)", (source) => {
		const client = createFakeClient();
		render(createElement(LiveView<Tick>, { client, source: feed("a") }));
		act(() =>
			source === "observer"
				? client.fail({ code: "upstream-error", message: "boom" })
				: client.setConnection("failed", "permanent-error"),
		);
		expect(shown().error).toBe("upstream-error");
		act(() => root?.unmount());
		const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
		render(
			createElement(
				Boundary,
				null,
				createElement(LiveView<Tick>, {
					client,
					source: feed("a"),
					options: { throwOnError: true },
				}),
			),
		);
		act(() =>
			source === "observer"
				? client.fail({ code: "upstream-error", message: "boom" })
				: client.setConnection("failed", "permanent-error"),
		);
		expect(container.textContent).toBe("caught:upstream-error");
		quiet.mockRestore();
	});

	it("disabled holds nothing; unmount releases once", async () => {
		const client = createFakeClient();
		render(
			createElement(LiveView<Tick>, {
				client,
				source: false,
				options: { initial: { n: 0 } },
			}),
		);
		expect(client.counts.subscribes).toBe(0);
		expect(shown().data).toEqual({ n: 0 });
		act(() =>
			root?.render(
				createElement(LiveView<Tick>, { client, source: feed("a") }),
			),
		);
		act(() => root?.unmount());
		root = undefined;
		expect(client.counts.unsubscribes).toBe(1);
		await macrotask();
		expect(client.upstream()).toEqual([]);
	});
});

describe("useSubscription error reporting and cleanup", () => {
	it("removing the consumer option is a change: update({}) restores the defaults, never a resubscribe", () => {
		const client = createFakeClient();
		const source = feed("a");
		function View({ consumer }: { consumer?: { intervalMs: number } }) {
			useSubscription(client, source, () => {}, consumer ? { consumer } : {});
			return null;
		}
		render(createElement(View, { consumer: { intervalMs: 1_000 } }));
		act(() =>
			root?.render(createElement(View, { consumer: { intervalMs: 2_000 } })),
		);
		act(() => root?.render(createElement(View, {})));
		act(() => root?.render(createElement(View, {})));
		expect(client.counts.subscribes).toBe(1);
		expect(client.active()[0]?.updates).toEqual([{ intervalMs: 2_000 }, {}]);
	});
});
