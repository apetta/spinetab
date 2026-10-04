import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BRIDGE_VERSION } from "../../../src/core/bridge.ts";
import type { RuntimeHandle } from "../../../src/core/types.ts";
import { createTestAdapter } from "./helpers/test-adapter.ts";

// one worker file. `defineWorker(adapters, options?)` serves
// synchronously in a SharedWorker global, registers nothing anywhere else and
// returns the local-runtime factory. Each test imports fresh modules, because
// the host remembers which global it serves (the double-serve guard).

type WorkerEntry = typeof import("../../../src/worker/index.ts");
type HostModule = typeof import("../../../src/core/host.ts");

let entry: WorkerEntry;
let host: HostModule;
const handles: RuntimeHandle[] = [];
const ports: MessagePort[] = [];

beforeEach(async () => {
	vi.resetModules();
	entry = await import("../../../src/worker/index.ts");
	host = await import("../../../src/core/host.ts");
});

afterEach(() => {
	for (const port of ports.splice(0)) port.close();
	for (const handle of handles.splice(0)) handle.dispose();
	vi.unstubAllGlobals();
});

/** Make `globalThis` pass as a SharedWorkerGlobalScope and capture `connect`. */
function sharedWorkerGlobal() {
	const listeners: Array<(event: MessageEvent) => void> = [];
	const addEventListener = vi.fn(
		(type: string, listener: (event: MessageEvent) => void) => {
			if (type === "connect") listeners.push(listener);
		},
	);
	// `globalThis instanceof SharedWorkerGlobalScope` holds, as in the worker.
	const FakeSharedWorkerGlobalScope = Object.defineProperty(
		() => {},
		Symbol.hasInstance,
		{ value: (value: unknown) => value === globalThis },
	);
	vi.stubGlobal("SharedWorkerGlobalScope", FakeSharedWorkerGlobalScope);
	vi.stubGlobal("addEventListener", addEventListener);
	const connect = () => {
		const channel = new MessageChannel();
		ports.push(channel.port1);
		const received: Array<Record<string, unknown>> = [];
		channel.port1.addEventListener("message", (event) =>
			received.push(event.data),
		);
		channel.port1.start();
		const event = new MessageEvent("connect", { ports: [channel.port2] });
		for (const listener of listeners) listener(event);
		channel.port1.postMessage({
			v: BRIDGE_VERSION,
			t: "hello",
			a: `a-${ports.length}`,
			g: 1,
			page: "p",
			scope: "",
			revision: null,
			heartbeatMs: 20_000,
		});
		return received;
	};
	return { addEventListener, listeners, connect };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("defineWorker", () => {
	it("refuses an adapter array: adapters must be a function", () => {
		const { adapter } = createTestAdapter();
		let error: unknown;
		try {
			entry.defineWorker([adapter] as never);
		} catch (caught) {
			error = caught;
		}
		expect(error).toMatchObject({
			code: "unsupported-option",
			detail: { path: "defineWorker.adapters" },
		});
		expect((error as Error).message).toContain(
			"must be a function returning the adapter list",
		);
	});

	it("registers nothing in a page-like global and returns the local-runtime factory", () => {
		const addEventListener = vi.fn();
		vi.stubGlobal("addEventListener", addEventListener);
		vi.stubGlobal("window", globalThis);
		vi.stubGlobal("document", {});
		const adapters = vi.fn(() => [createTestAdapter().adapter]);
		const factory = entry.defineWorker(adapters);
		expect(addEventListener).not.toHaveBeenCalled();
		expect(adapters).not.toHaveBeenCalled();
		const first = factory();
		const second = factory();
		handles.push(first, second);
		expect(typeof first.accept).toBe("function");
		expect(first).not.toBe(second);
		// Every runtime gets its own adapter list (no shared adapter state).
		expect(adapters).toHaveBeenCalledTimes(2);
	});

	it("serves synchronously during the call in a SharedWorker global", async () => {
		const scope = sharedWorkerGlobal();
		const factory = entry.defineWorker(() => [createTestAdapter().adapter], {
			limits: { maxConnections: 7 },
		});
		expect(typeof factory).toBe("function");
		expect(scope.addEventListener).toHaveBeenCalledTimes(1);
		expect(scope.addEventListener.mock.calls[0]?.[0]).toBe("connect");
		const received = scope.connect();
		await tick();
		const welcome = received.find((message) => message.t === "welcome");
		expect(welcome).toMatchObject({ limits: { maxConnections: 7 } });
	});

	it("passes credentialOrigins through: an invalid list is a startup error for every page", async () => {
		const scope = sharedWorkerGlobal();
		const factory = entry.defineWorker(() => [createTestAdapter().adapter], {
			credentialOrigins: ["http://api.test"],
		});
		expect(() => factory()).toThrow(/credentialOrigins/);
		const received = scope.connect();
		await tick();
		expect(
			received.find((message) => message.t === "startupError"),
		).toMatchObject({ code: "worker-startup-error" });
	});

	it("builds the local runtime from the module default, as the client loads it", async () => {
		const factory = entry.defineWorker(() => [createTestAdapter().adapter]);
		const { runtimeFromModule } = await import("../../../src/core/local.ts");
		const runtime = runtimeFromModule({ default: factory });
		handles.push(runtime);
		expect(typeof runtime.dispose).toBe("function");
	});

	it("double serve: defineWorker after serveSharedWorker reports worker-startup-error to every port", async () => {
		const scope = sharedWorkerGlobal();
		const { createRuntime } = await import("../../../src/core/runtime.ts");
		entry.serveSharedWorker(() =>
			createRuntime({ adapters: [createTestAdapter().adapter] }),
		);
		entry.defineWorker(() => [createTestAdapter().adapter]);
		expect(scope.addEventListener).toHaveBeenCalledTimes(1);
		const first = scope.connect();
		const second = scope.connect();
		await expect
			.poll(() =>
				[first, second].every((received) =>
					received.some((message) => message.t === "startupError"),
				),
			)
			.toBe(true);
		for (const received of [first, second]) {
			expect(
				received.find((message) => message.t === "welcome"),
			).toBeUndefined();
			expect(
				received.find((message) => message.t === "startupError"),
			).toMatchObject({ code: "worker-startup-error" });
		}
	});
});

describe("the realm check", () => {
	class Shared {
		SharedWorkerGlobalScope = Shared;
	}
	class Dedicated {
		DedicatedWorkerGlobalScope = Dedicated;
	}

	it("is true only for a SharedWorkerGlobalScope", () => {
		expect(host.isSharedWorkerScope(new Shared())).toBe(true);
		expect(host.isSharedWorkerScope(new Dedicated())).toBe(false);
		expect(host.isSharedWorkerScope({})).toBe(false);
		// A page that defines the name without being that global.
		expect(host.isSharedWorkerScope({ SharedWorkerGlobalScope: Shared })).toBe(
			false,
		);
		expect(host.isSharedWorkerScope(undefined)).toBe(false);
		expect(host.isSharedWorkerScope(globalThis)).toBe(false);
	});

	it("double serve on one scope keeps one listener and answers startupError", async () => {
		class Scope {
			listeners: Array<(event: MessageEvent) => void> = [];
			addEventListener(
				_type: "connect",
				listener: (event: MessageEvent) => void,
			) {
				this.listeners.push(listener);
			}
		}
		const scope = new Scope();
		const { createRuntime } = await import("../../../src/core/runtime.ts");
		const make = () => {
			const runtime = createRuntime({
				adapters: [createTestAdapter().adapter],
			});
			handles.push(runtime);
			return runtime;
		};
		host.serve(scope, make);
		host.serve(scope, make);
		expect(scope.listeners).toHaveLength(1);
		expect(handles).toHaveLength(1);
		const channel = new MessageChannel();
		ports.push(channel.port1);
		const received: Array<Record<string, unknown>> = [];
		channel.port1.addEventListener("message", (event) =>
			received.push(event.data),
		);
		channel.port1.start();
		for (const listener of scope.listeners) {
			listener(new MessageEvent("connect", { ports: [channel.port2] }));
		}
		channel.port1.postMessage({
			v: BRIDGE_VERSION,
			t: "hello",
			a: "a",
			g: 1,
			page: "p",
			scope: "",
			revision: null,
			heartbeatMs: 20_000,
		});
		await tick();
		expect(received).toEqual([
			expect.objectContaining({
				t: "startupError",
				code: "worker-startup-error",
			}),
		]);
	});
});
