import { createRoot, createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import {
	createSpinetabStatus,
	createSubscription,
	INACTIVE_STATUS,
	SERVER_STATUS,
} from "../../src/bindings/solid/index.ts";
import type { SubscriptionRequest } from "../../src/core/types.ts";
import {
	createFakeClient,
	feed,
	macrotask,
	request,
} from "./helpers/fake-client.ts";

// DOM-SO-01…02: the real solid-js 1.9 client build (browser condition).

describe("createSubscription (Solid)", () => {
	it("DOM-SO-01 accessor identity changes resubscribe once; owner disposal releases", async () => {
		const client = createFakeClient({ leaky: true });
		const next = vi.fn();
		const [input, setInput] = createSignal<SubscriptionRequest<{
			n: number;
		}> | null>(request("a"));
		let resource:
			| ReturnType<typeof createSubscription<{ n: number }>>
			| undefined;
		const dispose = createRoot((dispose) => {
			resource = createSubscription(client, input, { next });
			return dispose;
		});
		expect(client.active()).toHaveLength(1);
		expect(resource?.status().connection.state).toBe("connecting");
		client.setConnection("connected");
		expect(resource?.status().connection.state).toBe("connected");
		setInput({ ...request("a") });
		expect(client.counts.subscribes).toBe(1);
		setInput(request("b"));
		expect(client.counts.subscribes).toBe(2);
		expect(client.counts.unsubscribes).toBe(1);
		client.emit({ n: 1 }, (consumer) => consumer.closed);
		expect(next).not.toHaveBeenCalled();
		setInput(null);
		expect(resource?.status()).toBe(INACTIVE_STATUS);
		expect(resource?.subscription()).toBeNull();
		setInput(request("c"));
		expect(client.active()).toHaveLength(1);
		dispose();
		expect(client.active()).toHaveLength(0);
		expect(client.counts.subscribes).toBe(client.counts.unsubscribes);
		await macrotask();
		expect(client.upstream()).toEqual([]);
	});

	it("DOM-SO-02 without an owner it warns and needs an explicit dispose; the latest callback receives events", () => {
		const client = createFakeClient();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const observer = { next: vi.fn() };
		const resource = createSubscription(client, () => request("a"), observer);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(client.active()).toHaveLength(1);
		const replacement = vi.fn();
		observer.next = replacement;
		client.emit({ n: 3 });
		expect(replacement).toHaveBeenCalledWith({ n: 3 }, expect.anything());
		resource.markReconciled();
		expect(client.active()[0]?.reconciled).toBe(1);
		resource.retry();
		// The handle's retry, never the whole client's.
		expect(client.active()[0]?.retries).toBe(1);
		expect(client.counts.retries).toBe(0);
		resource.dispose();
		resource.dispose();
		expect(client.counts.unsubscribes).toBe(1);
		warn.mockRestore();
	});

	it("DOM-SO-01 createSpinetabStatus starts from SERVER_STATUS and then follows the client", () => {
		const client = createFakeClient();
		let seenFirst: unknown;
		const dispose = createRoot((dispose) => {
			const { status } = createSpinetabStatus(client);
			seenFirst = status();
			return () => {
				dispose();
			};
		});
		expect(seenFirst).toBe(SERVER_STATUS);
		dispose();
		const resource = createRoot((dispose) => {
			const value = createSpinetabStatus(client);
			return { ...value, disposeRoot: dispose };
		});
		expect(resource.status().mode).toBe("shared");
		client.setClientStatus({ health: "unreachable" });
		expect(resource.status().health).toBe("unreachable");
		resource.disposeRoot();
		client.setClientStatus({ health: "healthy" });
		expect(resource.status().health).toBe("unreachable");
	});
});

// a source is a request or a feed, and an observer is a function
// or an object. The key comes from the normalised request.
describe("createSubscription (Solid) with a source and a function observer", () => {
	it("a function observer on a feed receives each event and its meta", () => {
		const client = createFakeClient();
		const seen: Array<[unknown, unknown]> = [];
		const dispose = createRoot((dispose) => {
			createSubscription(
				client,
				() => feed("a"),
				(event, meta) => {
					seen.push([event, meta]);
				},
			);
			return dispose;
		});
		expect(client.active().map((consumer) => consumer.request)).toEqual([
			request("a"),
		]);
		client.emit({ n: 1 });
		expect(seen).toEqual([[{ n: 1 }, { seq: 1 }]]);
		dispose();
		expect(client.counts.unsubscribes).toBe(1);
	});

	it("an accessor that rebuilds its feed on every run does not resubscribe", () => {
		const client = createFakeClient();
		const [topic, setTopic] = createSignal("a");
		const [tick, setTick] = createSignal(0);
		let runs = 0;
		const next = vi.fn();
		const dispose = createRoot((dispose) => {
			createSubscription(
				client,
				() => {
					runs += 1;
					tick();
					return feed(topic());
				},
				next,
			);
			return dispose;
		});
		for (const value of [1, 2, 3]) setTick(value);
		expect(runs).toBe(4);
		expect(client.counts.subscribes).toBe(1);
		setTopic("b");
		expect(client.counts.subscribes).toBe(2);
		expect(client.counts.unsubscribes).toBe(1);
		expect(client.active().map((consumer) => consumer.request)).toEqual([
			request("b"),
		]);
		client.emit({ n: 1 });
		expect(next).toHaveBeenCalledWith({ n: 1 }, expect.anything());
		dispose();
	});

	it("an object observer on a feed keeps next, error and status", () => {
		const client = createFakeClient();
		const observer = { next: vi.fn(), error: vi.fn(), status: vi.fn() };
		const dispose = createRoot((dispose) => {
			createSubscription(client, () => feed("a"), observer);
			return dispose;
		});
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
		dispose();
	});
});
