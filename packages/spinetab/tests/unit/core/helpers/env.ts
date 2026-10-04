import { vi } from "vitest";
import type { ClientEnv } from "../../../../src/core/client.ts";
import type { ManualClock } from "./clock.ts";

let envCounter = 0;

/** Browser-like client environment with a manual clock and observable listeners. */
export function createTestEnv(
	clock: ManualClock,
	overrides: Partial<ClientEnv> = {},
) {
	const listeners = new Map<string, Set<(event: Event) => void>>();
	let visible = true;
	let ids = 0;
	envCounter += 1;
	const prefix = `env${envCounter}`;
	const reportError = vi.fn();
	const env: ClientEnv = {
		clock,
		isBrowser: () => true,
		hasSharedWorker: () => true,
		visible: () => visible,
		baseUri: () => "https://app.test/base/",
		listen(target, type, listener) {
			const key = `${target}:${type}`;
			let set = listeners.get(key);
			if (!set) {
				set = new Set();
				listeners.set(key, set);
			}
			set.add(listener);
			return () => set?.delete(listener);
		},
		createChannel: () => new MessageChannel(),
		randomId: () => {
			ids += 1;
			return `${prefix}-id-${ids}`;
		},
		random: () => 0.5,
		reportError,
		...overrides,
	};
	return {
		env,
		reportError,
		listenerCount: () =>
			[...listeners.values()].reduce((sum, set) => sum + set.size, 0),
		fire(
			target: "window" | "document",
			type: string,
			init: Record<string, unknown> = {},
		) {
			const event = Object.assign(new Event(type), init);
			for (const listener of [...(listeners.get(`${target}:${type}`) ?? [])])
				listener(event);
		},
		setVisible(next: boolean) {
			visible = next;
		},
	};
}
