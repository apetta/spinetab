import { afterEach, describe, expect, it, vi } from "vitest";
import { BRIDGE_VERSION } from "../../../src/core/bridge.ts";
import { SpinetabError } from "../../../src/core/errors.ts";
import { type ConnectScope, serve } from "../../../src/core/host.ts";
import { createRuntime, type Runtime } from "../../../src/core/runtime.ts";
import { ManualClock, settle } from "./helpers/clock.ts";
import { createTestAdapter } from "./helpers/test-adapter.ts";

// (synchronous connect, bounded early ports, setup errors
// answered with startupError) and (import safety of the entry).

class FakeScope implements ConnectScope {
	listeners: Array<(event: MessageEvent) => void> = [];
	addEventListener(
		_type: "connect",
		listener: (event: MessageEvent) => void,
	): void {
		this.listeners.push(listener);
	}
	connect(): MessagePort {
		const channel = new MessageChannel();
		const event = new MessageEvent("connect", { ports: [channel.port2] });
		for (const listener of this.listeners) listener(event);
		return channel.port1;
	}
}

const ports: MessagePort[] = [];
const runtimes: Runtime[] = [];
afterEach(() => {
	for (const port of ports.splice(0)) port.close();
	for (const runtime of runtimes.splice(0)) runtime.dispose();
});

function pageOn(scope: FakeScope, a: string) {
	const port = scope.connect();
	ports.push(port);
	const received: Array<Record<string, unknown>> = [];
	port.addEventListener("message", (event) => received.push(event.data));
	port.start();
	port.postMessage({
		v: BRIDGE_VERSION,
		t: "hello",
		a,
		g: 1,
		page: a,
		scope: "",
		revision: null,
		heartbeatMs: 20_000,
	});
	return received;
}

function makeRuntime(clock: ManualClock) {
	const runtime = createRuntime({
		adapters: [createTestAdapter().adapter],
		clock,
	});
	runtimes.push(runtime);
	return runtime;
}

describe("serveSharedWorker host", () => {
	it("registers connect synchronously and serves a ready runtime", async () => {
		const clock = new ManualClock();
		const scope = new FakeScope();
		const runtime = makeRuntime(clock);
		serve(scope, runtime, { clock });
		expect(scope.listeners).toHaveLength(1);
		const received = pageOn(scope, "a1");
		await settle(clock);
		// The runtime announces itself on the accepted port before any welcome.
		expect(received[0]).toEqual({
			v: BRIDGE_VERSION,
			t: "announce",
			runtime: runtime.id,
			generation: 1,
		});
		expect(received[1]).toMatchObject({ t: "welcome", a: "a1" });
	});

	it("buffers ports that connect before async setup finishes without losing their hello", async () => {
		const clock = new ManualClock();
		const scope = new FakeScope();
		let resolve: (runtime: Runtime) => void = () => {};
		serve(
			scope,
			new Promise<Runtime>((done) => {
				resolve = done;
			}),
			{ clock },
		);
		const first = pageOn(scope, "early-1");
		const second = pageOn(scope, "early-2");
		await settle(clock);
		expect(first).toHaveLength(0);
		resolve(makeRuntime(clock));
		await settle(clock);
		expect(first[0]).toMatchObject({ t: "announce", generation: 1 });
		expect(second[0]).toMatchObject({ t: "announce", generation: 2 });
		expect(first[1]).toMatchObject({ t: "welcome", a: "early-1" });
		expect(second[1]).toMatchObject({ t: "welcome", a: "early-2" });
	});

	it("answers ports beyond the early bound with startupError", async () => {
		const clock = new ManualClock();
		const scope = new FakeScope();
		serve(scope, new Promise<Runtime>(() => {}), { clock, maxEarlyPorts: 2 });
		pageOn(scope, "p1");
		pageOn(scope, "p2");
		const third = pageOn(scope, "p3");
		await settle(clock);
		expect(third[0]).toEqual({
			v: BRIDGE_VERSION,
			t: "startupError",
			a: "p3",
			g: 1,
			code: "limit-exceeded",
			message: expect.any(String),
		});
	});

	it("answers startupError after the setup timeout for buffered and later ports", async () => {
		const clock = new ManualClock();
		const scope = new FakeScope();
		serve(scope, new Promise<Runtime>(() => {}), { clock });
		const early = pageOn(scope, "p1");
		clock.advance(9_999);
		await settle(clock);
		expect(early).toHaveLength(0);
		clock.advance(1);
		await settle(clock);
		expect(early[0]).toMatchObject({
			t: "startupError",
			code: "worker-startup-error",
		});
		const late = pageOn(scope, "p2");
		await settle(clock);
		expect(late[0]).toMatchObject({
			t: "startupError",
			a: "p2",
			code: "worker-startup-error",
		});
	});

	it("reports a throwing runtime factory without leaking non-Spinetab error text", async () => {
		const clock = new ManualClock();
		const scope = new FakeScope();
		serve(
			scope,
			() =>
				createRuntime({
					adapters: [createTestAdapter().adapter, createTestAdapter().adapter],
				}),
			{ clock },
		);
		const known = pageOn(scope, "p1");
		const other = new FakeScope();
		serve(
			other,
			() => {
				throw new Error("token=secret-value");
			},
			{ clock },
		);
		const unknown = pageOn(other, "p2");
		const rejected = new FakeScope();
		serve(
			rejected,
			Promise.reject(new SpinetabError("unsupported-option", "bad limits")),
			{ clock },
		);
		const viaPromise = pageOn(rejected, "p3");
		await settle(clock);
		expect(known[0]).toMatchObject({
			t: "startupError",
			code: "worker-startup-error",
			message: expect.stringContaining("registered twice"),
		});
		expect(unknown[0]).toMatchObject({
			t: "startupError",
			code: "worker-startup-error",
		});
		expect(String(unknown[0]?.message)).not.toContain("secret");
		expect(viaPromise[0]).toMatchObject({
			t: "startupError",
			message: "bad limits",
		});
	});
});

describe("import safety", () => {
	it("importing the worker, runtime and page entries registers nothing and starts nothing", async () => {
		const addEventListener = vi.fn();
		vi.stubGlobal("addEventListener", addEventListener);
		const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
		const worker = await import("../../../src/worker/index.ts");
		const runtime = await import("../../../src/runtime/index.ts");
		const page = await import("../../../src/index.ts");
		expect(typeof worker.serveSharedWorker).toBe("function");
		expect(typeof runtime.createRuntime).toBe("function");
		expect(typeof page.createSpinetab).toBe("function");
		expect(addEventListener).not.toHaveBeenCalled();
		expect(setTimeoutSpy).not.toHaveBeenCalled();
		vi.unstubAllGlobals();
	});
});
