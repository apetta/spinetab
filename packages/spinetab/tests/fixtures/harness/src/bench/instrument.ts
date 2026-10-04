/**
 * Handle instrumentation for the bench realms. Imported first by the bench page and the bench worker so every
 * later timer and listener goes through the wrappers.
 *
 * - Timers: a map of live handles. `setTimeout` adds and removes on fire or
 * clear; `setInterval` adds and removes only on clear (an interval stays
 * live after firing). `clearTimeout`/`clearInterval` share one pool, as in
 * the platform.
 * - Listeners: live `addEventListener` registrations per target, deduplicated
 * by (type, listener, capture) as the platform does, removed by
 * `removeEventListener`, after a `once` listener fires, or when its `signal`
 * aborts. Targets are held weakly: listeners of a collected target (a
 * closed socket nobody references) are not counted, so read counts after a
 * forced GC. `on<event>` handler properties are not counted.
 *
 * Bench-owned work runs inside `untracked()` and is excluded.
 */

export interface HandleCounts {
	timeouts: number;
	intervals: number;
	listeners: number;
	/** Live listeners by target constructor name. */
	byTarget: Record<string, number>;
	/** Cumulative timers created (for rate checks). */
	createdTimers: number;
}

type Kind = "timeout" | "interval";

interface Registration {
	readonly target: WeakRef<EventTarget>;
	readonly name: string;
	/** Registration keys only: never the listener, so targets stay collectable. */
	readonly keys: Set<string>;
}

interface Instrumented {
	counts(): HandleCounts;
	untracked<T>(fn: () => T): T;
}

const KEY = Symbol.for("spinetab.bench.instrument");
type Scope = typeof globalThis & { [KEY]?: Instrumented };

function install(): Instrumented {
	const scope = globalThis as Scope;
	const existing = scope[KEY];
	if (existing) return existing;

	const timers = new Map<unknown, Kind>();
	let createdTimers = 0;
	let paused = 0;
	const tracking = () => paused === 0;

	const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
	const nativeClearTimeout = globalThis.clearTimeout.bind(globalThis);
	const nativeSetInterval = globalThis.setInterval.bind(globalThis);
	const nativeClearInterval = globalThis.clearInterval.bind(globalThis);

	const wrappedSetTimeout = ((
		handler: TimerHandler,
		timeout?: number,
		...args: unknown[]
	) => {
		if (!tracking() || typeof handler !== "function") {
			return nativeSetTimeout(handler as () => void, timeout, ...args);
		}
		createdTimers += 1;
		const id = nativeSetTimeout(
			(...inner: unknown[]) => {
				timers.delete(id);
				(handler as (...values: unknown[]) => void)(...inner);
			},
			timeout,
			...args,
		);
		timers.set(id, "timeout");
		return id;
	}) as typeof setTimeout;

	const wrappedSetInterval = ((
		handler: TimerHandler,
		timeout?: number,
		...args: unknown[]
	) => {
		const id = nativeSetInterval(handler as () => void, timeout, ...args);
		if (tracking()) {
			createdTimers += 1;
			timers.set(id, "interval");
		}
		return id;
	}) as typeof setInterval;

	const clear = (id: unknown) => {
		timers.delete(id);
	};

	globalThis.setTimeout = wrappedSetTimeout;
	globalThis.setInterval = wrappedSetInterval;
	globalThis.clearTimeout = ((id?: Parameters<typeof clearTimeout>[0]) => {
		clear(id);
		nativeClearTimeout(id);
	}) as typeof clearTimeout;
	globalThis.clearInterval = ((id?: Parameters<typeof clearInterval>[0]) => {
		clear(id);
		nativeClearInterval(id);
	}) as typeof clearInterval;

	const registrations = new WeakMap<EventTarget, Registration>();
	const live = new Set<Registration>();
	const proto = EventTarget.prototype;
	const nativeAdd = proto.addEventListener;
	const nativeRemove = proto.removeEventListener;
	const onceWrappers = new WeakMap<object, Map<string, EventListener>>();

	const captureOf = (options?: boolean | EventListenerOptions) =>
		typeof options === "boolean" ? options : options?.capture === true;
	const keyOf = (type: string, capture: boolean, id: number) =>
		`${type}\u0000${capture ? 1 : 0}\u0000${id}`;
	const ids = new WeakMap<object, number>();
	let nextId = 1;
	const idOf = (listener: object) => {
		let id = ids.get(listener);
		if (id === undefined) {
			id = nextId++;
			ids.set(listener, id);
		}
		return id;
	};

	function registration(target: EventTarget): Registration {
		let entry = registrations.get(target);
		if (!entry) {
			entry = {
				target: new WeakRef(target),
				name: target.constructor?.name ?? "EventTarget",
				keys: new Set(),
			};
			registrations.set(target, entry);
			live.add(entry);
		}
		return entry;
	}

	function forget(target: EventTarget, key: string): void {
		const entry = registrations.get(target);
		if (!entry) return;
		entry.keys.delete(key);
		if (entry.keys.size === 0) {
			live.delete(entry);
			registrations.delete(target);
		}
	}

	proto.addEventListener = function addEventListener(
		this: EventTarget,
		type: string,
		listener: EventListenerOrEventListenerObject | null,
		options?: boolean | AddEventListenerOptions,
	): void {
		if (!listener || !tracking()) {
			nativeAdd.call(this, type, listener, options);
			return;
		}
		const capture = captureOf(options);
		const key = keyOf(type, capture, idOf(listener));
		const entry = registration(this);
		if (entry.keys.has(key)) {
			// The platform ignores duplicate registrations.
			return;
		}
		const once = typeof options === "object" && options?.once === true;
		const signal = typeof options === "object" ? options?.signal : undefined;
		if (signal?.aborted) return;
		const target = this;
		let registered: EventListenerOrEventListenerObject = listener;
		if (once) {
			const wrapper: EventListener = function (this: unknown, event: Event) {
				forget(target, key);
				if (typeof listener === "function") listener.call(this, event);
				else listener.handleEvent(event);
			};
			let wrappers = onceWrappers.get(target);
			if (!wrappers) {
				wrappers = new Map();
				onceWrappers.set(target, wrappers);
			}
			wrappers.set(key, wrapper);
			registered = wrapper;
		}
		entry.keys.add(key);
		if (signal) {
			nativeAdd.call(signal, "abort", () => forget(target, key), {
				once: true,
			});
		}
		nativeAdd.call(this, type, registered, options);
	};

	proto.removeEventListener = function removeEventListener(
		this: EventTarget,
		type: string,
		listener: EventListenerOrEventListenerObject | null,
		options?: boolean | EventListenerOptions,
	): void {
		if (!listener) {
			nativeRemove.call(this, type, listener, options);
			return;
		}
		const capture = captureOf(options);
		const key = keyOf(type, capture, idOf(listener));
		const wrapper = onceWrappers.get(this)?.get(key);
		if (wrapper) onceWrappers.get(this)?.delete(key);
		forget(this, key);
		nativeRemove.call(this, type, wrapper ?? listener, options);
	};

	const instrumented: Instrumented = {
		counts() {
			let timeouts = 0;
			let intervals = 0;
			for (const kind of timers.values()) {
				if (kind === "timeout") timeouts += 1;
				else intervals += 1;
			}
			let listeners = 0;
			const byTarget: Record<string, number> = {};
			for (const entry of [...live]) {
				if (!entry.target.deref()) {
					live.delete(entry);
					continue;
				}
				listeners += entry.keys.size;
				byTarget[entry.name] = (byTarget[entry.name] ?? 0) + entry.keys.size;
			}
			return { timeouts, intervals, listeners, byTarget, createdTimers };
		},
		untracked<T>(fn: () => T): T {
			paused += 1;
			try {
				return fn();
			} finally {
				paused -= 1;
			}
		},
	};
	scope[KEY] = instrumented;
	return instrumented;
}

const instrumented = install();

export const handleCounts = (): HandleCounts => instrumented.counts();
export const untracked = <T>(fn: () => T): T => instrumented.untracked(fn);
