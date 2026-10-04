import { BRIDGE_VERSION } from "../../../../src/core/bridge.ts";
import { createRuntime, type Runtime } from "../../../../src/core/runtime.ts";
import type { ManualClock } from "./clock.ts";
import { createTestAdapter, type TestAdapterOptions } from "./test-adapter.ts";

type WorkerMode =
	| "running"
	| "hung"
	| "v0"
	| "startup-error"
	| "garbage"
	| "construct-throws"
	| "error-event";

export interface Relay {
	page: MessagePort;
	host: MessagePort;
	runtimeSide?: MessagePort;
	held: Array<{ toRuntime: boolean; data: unknown }>;
	hold: boolean;
	dead: boolean;
	/** The page closed its side (a retired attachment). */
	closed: boolean;
	drop?: (data: unknown, toRuntime: boolean) => boolean;
}

/**
 * Stands in for the browser's SharedWorker instance matching: every factory
 * call returns a new SharedWorker-like object whose port is relayed to the
 * current runtime. Tests can hang the instance (messages held, as a busy
 * worker would), crash it (ports go silent and the next construction gets a
 * replacement runtime), or make it speak another bridge version.
 */
export class FakeWorkerHost {
	runtime: Runtime;
	readonly runtimes: Runtime[] = [];
	mode: WorkerMode = "running";
	created = 0;
	readonly relays: Relay[] = [];
	readonly errorListeners = new Set<(event: Event) => void>();
	test = createTestAdapter();
	/**
	 * Rewrites every relayed message in both directions (all relays, current
	 * and future), for example to emulate an older runtime build.
	 */
	rewrite?: (data: unknown, toRuntime: boolean) => unknown;
	private readonly makeRuntime: () => Runtime;

	constructor(
		private readonly clock: ManualClock,
		options: {
			limits?: Parameters<typeof createRuntime>[0]["limits"];
			adapters?: () => Parameters<typeof createRuntime>[0]["adapters"];
			test?: TestAdapterOptions;
			/** Runtime sink: history opt-in for tests that read it. */
			diagnostics?: Parameters<typeof createRuntime>[0]["diagnostics"];
		} = {},
	) {
		this.makeRuntime = () => {
			this.test = createTestAdapter(options.test);
			const runtime = createRuntime({
				adapters: options.adapters ? options.adapters() : [this.test.adapter],
				clock: this.clock,
				...(options.limits ? { limits: options.limits } : {}),
				...(options.diagnostics ? { diagnostics: options.diagnostics } : {}),
			});
			this.runtimes.push(runtime);
			return runtime;
		};
		this.runtime = this.makeRuntime();
	}

	factory = (): SharedWorker => {
		this.created += 1;
		if (this.mode === "construct-throws") {
			throw new DOMException("blocked", "SecurityError");
		}
		const pageChannel = new MessageChannel();
		const relay: Relay = {
			page: pageChannel.port1,
			host: pageChannel.port2,
			held: [],
			hold: this.mode === "hung",
			dead: false,
			closed: false,
		};
		this.relays.push(relay);
		relay.host.addEventListener("close", () => {
			relay.closed = true;
		});
		const mode = this.mode;
		if (mode === "running" || mode === "hung") this.connect(relay);
		relay.host.addEventListener("message", (event) => {
			const data = event.data as Record<string, unknown>;
			if (mode === "v0") {
				relay.host.postMessage({
					v: 0,
					t: "welcome",
					a: data.a,
					g: data.g,
					runtime: "v0",
				});
			} else if (mode === "startup-error") {
				relay.host.postMessage({
					v: BRIDGE_VERSION,
					t: "startupError",
					a: data.a,
					g: data.g,
					code: "worker-startup-error",
					message: "setup failed",
				});
			} else if (mode === "garbage") {
				relay.host.postMessage({ hello: "not spinetab" });
			} else if (mode === "running" || mode === "hung") {
				this.forward(relay, data, true);
			}
		});
		relay.host.start();
		const errorListeners = this.errorListeners;
		const worker = {
			port: relay.page,
			addEventListener(type: string, listener: (event: Event) => void) {
				if (type === "error") errorListeners.add(listener);
			},
			removeEventListener(type: string, listener: (event: Event) => void) {
				if (type === "error") errorListeners.delete(listener);
			},
		};
		if (mode === "error-event") {
			queueMicrotask(() => {
				for (const listener of [...errorListeners])
					listener(new Event("error"));
			});
		}
		return worker as unknown as SharedWorker;
	};

	/** Connect a relay's page port to the current runtime (a `connect` event). */
	private connect(relay: Relay): void {
		const runtimeChannel = new MessageChannel();
		const runtimeSide = runtimeChannel.port1;
		relay.runtimeSide = runtimeSide;
		this.runtime.accept(runtimeChannel.port2);
		runtimeSide.addEventListener("message", (event) => {
			if (relay.runtimeSide === runtimeSide) {
				this.forward(relay, event.data, false);
			}
		});
		runtimeSide.start();
	}

	private forward(relay: Relay, data: unknown, toRuntime: boolean): void {
		if (relay.dead) return;
		if (relay.drop?.(data, toRuntime)) return;
		if (relay.hold) {
			relay.held.push({ toRuntime, data });
			return;
		}
		// Applied once, at delivery, so held messages are not rewritten twice.
		const out = this.rewrite ? this.rewrite(data, toRuntime) : data;
		if (toRuntime) relay.runtimeSide?.postMessage(out);
		else relay.host.postMessage(out);
	}

	/** The instance becomes unresponsive; later constructions reuse it. */
	hang(): void {
		this.mode = "hung";
		for (const relay of this.relays) relay.hold = true;
	}

	/** The busy loop ends: held messages are processed in order. */
	unhang(): void {
		this.mode = "running";
		for (const relay of this.relays) {
			relay.hold = false;
			for (const item of relay.held.splice(0))
				this.forward(relay, item.data, item.toRuntime);
		}
	}

	/** Deliver one relay's held messages in order (a delay, not a loss). */
	release(relay: Relay): void {
		relay.hold = false;
		for (const item of relay.held.splice(0))
			this.forward(relay, item.data, item.toRuntime);
	}

	/** The worker dies silently; the next construction gets a new runtime. */
	crash(): void {
		for (const relay of this.relays) relay.dead = true;
		this.runtime.dispose();
		this.runtime = this.makeRuntime();
		this.mode = "running";
	}

	/**
	 * WebKit-style re-initialisation: the worker instance is replaced without
	 * any message to its pages,
	 * and every page port still open is reconnected to the new instance, whose
	 * runtime accepts it like a new connection (and announces itself).
	 */
	reinit(): void {
		const live = this.relays.filter(
			(relay) => !relay.dead && !relay.closed && relay.runtimeSide,
		);
		for (const relay of live) {
			const old = relay.runtimeSide;
			relay.runtimeSide = undefined;
			old?.close();
		}
		this.runtime.dispose();
		this.runtime = this.makeRuntime();
		this.mode = "running";
		for (const relay of live) this.connect(relay);
	}

	fireError(): void {
		for (const listener of [...this.errorListeners])
			listener(new Event("error"));
	}

	lastRelay(): Relay {
		const relay = this.relays[this.relays.length - 1];
		if (!relay) throw new Error("no relay");
		return relay;
	}

	dispose(): void {
		for (const runtime of this.runtimes) runtime.dispose();
		for (const relay of this.relays) {
			relay.page.close();
			relay.host.close();
			relay.runtimeSide?.close();
		}
	}
}
