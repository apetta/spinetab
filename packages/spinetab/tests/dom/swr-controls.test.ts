import { describe, expect, it, vi } from "vitest";
import { swrSubscription } from "../../src/integrations/swr/index.ts";
import { createFakeClient, feed, macrotask } from "./helpers/fake-client.ts";

// Drive the subscribe callback directly, as useSWRSubscription does.

type Tick = { n: number };

function drive<Data = Tick>(
	subscribe: ReturnType<typeof swrSubscription<string, Tick, Data>>,
	key = "k",
) {
	const calls: Array<[unknown, unknown?]> = [];
	const dispose = subscribe(key, {
		next: (error: unknown, data?: unknown) => calls.push([error, data]),
	} as never);
	return {
		dispose,
		calls,
		errors: () => calls.filter(([error]) => error).map(([error]) => error),
		data: () => calls.filter(([error]) => !error).map(([, data]) => data),
	};
}

describe("swrSubscription flat options", () => {
	it("consumer and resume are flat, passed to subscribe as the bindings do", () => {
		const client = createFakeClient();
		const resume = () => undefined;
		drive(
			swrSubscription<string, Tick>(client, (key) => feed(key), {
				consumer: { intervalMs: 30_000 },
				resume,
			}),
		);
		drive(swrSubscription<string, Tick>(client, (key) => feed(key)));
		expect(client.consumers[0]?.options).toEqual({
			consumer: { intervalMs: 30_000 },
			resume,
		});
		expect(client.consumers[1]?.options).toEqual({});
	});
});

describe("swrSubscription reconcile", () => {
	it("a reconcile function refreshes the key while connected, then declares it reconciled", async () => {
		const client = createFakeClient();
		const mutate = vi.fn(async (_key: string) => {});
		const view = drive(
			swrSubscription<string, Tick>(client, (key) => feed(key), {
				reconcile: (key) => mutate(key),
			}),
			"orders",
		);
		client.setContinuity("unknown", "reconnected");
		await macrotask();
		expect(mutate).not.toHaveBeenCalled();
		client.setConnection("connected");
		await vi.waitFor(() =>
			expect(client.consumers[0]?.status.get().continuity.state).toBe(
				"continuous",
			),
		);
		expect(mutate).toHaveBeenCalledWith("orders");
		// A configured policy is the confirmation: no continuity-lost error.
		expect(view.errors()).toEqual([]);
	});

	it("a failed refresh reaches SWR's error and keeps continuity lost", async () => {
		const client = createFakeClient();
		const view = drive(
			swrSubscription<string, Tick>(client, (key) => feed(key), {
				reconcile: async () => {
					throw new Error("reload failed");
				},
			}),
		);
		client.setConnection("connected");
		client.setContinuity("gap", "overflow");
		await vi.waitFor(() => expect(view.errors()).toHaveLength(1));
		expect(view.errors()[0]).toMatchObject({ code: "upstream-error" });
		expect(client.consumers[0]?.status.get().continuity.state).toBe("gap");
		// Delivery was restarted before the refresh, so nothing is lost meanwhile.
		expect(client.consumers[0]?.pendingReconciles).toBe(1);
	});

	it('reconcile "latest": the next event is the reconciled value', () => {
		const client = createFakeClient();
		const view = drive(
			swrSubscription<string, Tick>(client, (key) => feed(key), {
				reconcile: "latest",
			}),
		);
		client.setContinuity("gap", "overflow");
		expect(view.errors()).toEqual([]);
		client.emit({ n: 5 });
		expect(view.data()).toEqual([{ n: 5 }]);
		expect(client.consumers[0]?.status.get().continuity.state).toBe(
			"continuous",
		);
	});

	it("dispose stops the engine", async () => {
		const client = createFakeClient();
		const mutate = vi.fn();
		const view = drive(
			swrSubscription<string, Tick>(client, (key) => feed(key), {
				reconcile: mutate,
			}),
		);
		view.dispose();
		client.consumers[0]?.status.set({
			active: true,
			connection: { state: "connected", since: 2 },
			continuity: { state: "unknown", reason: "reconnected", since: 2 },
		});
		await macrotask();
		expect(mutate).not.toHaveBeenCalled();
	});
});

describe("swrSubscription controls", () => {
	it("controls.retry retries this subscription only", () => {
		const client = createFakeClient();
		let retry: (() => void) | undefined;
		drive(
			swrSubscription<string, Tick>(client, (key) => feed(key), {
				onStatus: (_status, _key, controls) => {
					retry = controls.retry;
				},
			}),
		);
		client.setConnection("retry-exhausted");
		retry?.();
		expect(client.consumers[0]?.retries).toBe(1);
		expect(client.counts.retries).toBe(0);
	});
});

describe("swrSubscription refresh failures and cancellation", () => {
	it("an unknown reconcile is refused when the bridge is created, so a loss is never silenced", () => {
		const client = createFakeClient();
		for (const reconcile of ["invalidate", null, { queryKey: ["a"] }]) {
			expect(() =>
				swrSubscription(client, () => feed("a"), {
					reconcile: reconcile as never,
				}),
			).toThrow(expect.objectContaining({ code: "unsupported-option" }));
		}
		expect(client.counts.subscribes).toBe(0);
	});
});
