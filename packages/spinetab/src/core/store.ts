import type { Store } from "./types.ts";

export interface WritableStore<T> extends Store<T> {
	/** Replace the snapshot; listeners run only when the reference changes. */
	set(value: T): void;
	/** Merge a partial update into an object snapshot; no-op when nothing changes. */
	patch(update: Partial<T>): void;
	clear(): void;
}

/**
 * Minimal external store with referentially stable snapshots. `get()` returns
 * the same object until `set`/`patch` changes content, which is what
 * `useSyncExternalStore` and the other bindings require.
 */
export function createStore<T extends object>(initial: T): WritableStore<T> {
	let current = initial;
	const listeners = new Set<(value: T) => void>();
	const notify = () => {
		for (const listener of [...listeners]) {
			try {
				listener(current);
			} catch (error) {
				reportListenerError(error);
			}
		}
	};
	return {
		get: () => current,
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		set(value) {
			if (value === current) return;
			current = value;
			notify();
		},
		patch(update) {
			let changed = false;
			for (const key of Object.keys(update) as Array<keyof T>) {
				if (!Object.is(update[key], current[key])) {
					changed = true;
					break;
				}
			}
			if (!changed) return;
			current = { ...current, ...update };
			notify();
		},
		clear() {
			listeners.clear();
		},
	};
}

function reportListenerError(error: unknown): void {
	if (typeof reportError === "function") {
		reportError(error);
	} else {
		setTimeout(() => {
			throw error;
		}, 0);
	}
}
