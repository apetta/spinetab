import {
	createComponent,
	createRenderEffect,
	createResource,
	createRoot,
	createSignal,
	Show,
	Suspense,
	startTransition,
} from "solid-js";
import { describe, expect, it } from "vitest";
import {
	createLive,
	createSpinetabStatus,
} from "../../src/bindings/solid/index.ts";
import { createFakeClient, feed, macrotask } from "./helpers/fake-client.ts";

function fixture() {
	const client = createFakeClient({ leaky: true });
	const watches = new Set<object>();
	const subscribe = client.status.subscribe.bind(client.status);
	client.status.subscribe = (listener) => {
		const token = {};
		watches.add(token);
		const off = subscribe(listener);
		return () => {
			watches.delete(token);
			off();
		};
	};
	const [mounted, setMounted] = createSignal(true);
	const [identity, setIdentity] = createSignal("a");
	const pending = new Map<string, (value: string) => void>();
	const node = document.createElement("div");
	function Pane() {
		const [ready] = createResource(
			identity,
			(key) =>
				new Promise<string>((resolve) => {
					pending.set(key, resolve);
				}),
		);
		const live = createLive(client, () => feed(identity()));
		createSpinetabStatus(client);
		const element = document.createElement("p");
		createRenderEffect(() => {
			element.textContent = `${ready() ?? "pending"}:${live.data()?.n ?? 0}`;
		});
		return element;
	}
	// The same component/getter shape Solid's JSX compiler emits. The resource
	// read belongs to Suspense, so its user effects wait for the render to commit.
	const dispose = createRoot((disposeRoot) => {
		const output = createComponent(Show, {
			keyed: true,
			get when() {
				return mounted();
			},
			get children() {
				return createComponent(Suspense, {
					fallback: "pending",
					get children() {
						return createComponent(Pane, {});
					},
				});
			},
		});
		createRenderEffect(() => {
			let value: unknown = output;
			while (typeof value === "function") value = value();
			if (value instanceof Node) node.replaceChildren(value);
			else node.textContent = String(value ?? "");
		});
		return disposeRoot;
	});
	return { client, watches, setMounted, setIdentity, pending, node, dispose };
}

describe("Solid Suspense and transitions", () => {
	it("starts nothing when a pending initial render is cancelled", async () => {
		const f = fixture();
		try {
			await macrotask();
			expect(f.client.counts.subscribes).toBe(0);
			expect(f.watches.size).toBe(0);
			f.setMounted(false);
			f.pending.get("a")?.("a");
			await macrotask();
			expect(f.client.counts.subscribes).toBe(0);
			expect(f.watches.size).toBe(0);
		} finally {
			f.dispose();
		}
	});

	it("keeps the old subscription until a transition commits, then resets its value", async () => {
		const f = fixture();
		try {
			f.pending.get("a")?.("a");
			await macrotask();
			f.client.emit({ n: 41 });
			expect(f.node.textContent).toBe("a:41");
			const transition = startTransition(() => f.setIdentity("b"));
			await macrotask();
			expect(f.pending.has("b")).toBe(true);
			expect(f.client.counts.subscribes).toBe(1);
			// This fixture writes DOM directly rather than using Solid's renderer;
			// the browser suite checks the retained UI during the transition.
			expect(f.client.counts.unsubscribes).toBe(0);
			f.pending.get("b")?.("b");
			await transition;
			await macrotask();
			expect(f.client.counts.subscribes).toBe(2);
			expect(f.client.counts.unsubscribes).toBe(1);
			expect(f.node.textContent).toBe("b:0");
			f.client.emit({ n: 99 }, (consumer) => consumer.closed);
			expect(f.node.textContent).toBe("b:0");
			f.setMounted(false);
			await macrotask();
			expect(f.client.active()).toEqual([]);
			expect(f.watches.size).toBe(0);
		} finally {
			f.dispose();
		}
	});

	it("does not run a queued effect after owner disposal during a transition", async () => {
		const f = fixture();
		try {
			f.pending.get("a")?.("a");
			await macrotask();
			expect(f.client.counts.subscribes).toBe(1);
			const transition = startTransition(() => f.setIdentity("b"));
			await macrotask();
			expect(f.pending.has("b")).toBe(true);
			f.setMounted(false);
			f.pending.get("b")?.("b");
			await transition;
			await macrotask();
			expect(f.client.counts.subscribes).toBe(1);
			expect(f.client.counts.unsubscribes).toBe(1);
			expect(f.client.active()).toEqual([]);
			expect(f.client.upstream()).toEqual([]);
			expect(f.watches.size).toBe(0);
		} finally {
			f.dispose();
		}
	});
});
