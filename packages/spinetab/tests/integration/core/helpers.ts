import {
	type ClientEnv,
	createClientWithEnv,
} from "../../../src/core/client.ts";
import { randomId, systemClock } from "../../../src/core/clock.ts";
import type { Runtime } from "../../../src/core/runtime.ts";
import type {
	SpinetabClient,
	SpinetabOptions,
} from "../../../src/core/types.ts";

/** A browser-like environment for Node integration tests (real timers). */
export function nodeEnv(baseUri: string) {
	let visible = true;
	const listeners = new Map<string, Set<(event: Event) => void>>();
	const env: ClientEnv = {
		clock: systemClock,
		isBrowser: () => true,
		hasSharedWorker: () => true,
		visible: () => visible,
		baseUri: () => baseUri,
		listen(target, type, listener) {
			const key = `${target}:${type}`;
			const set = listeners.get(key) ?? new Set();
			listeners.set(key, set);
			set.add(listener);
			return () => set.delete(listener);
		},
		createChannel: () => new MessageChannel(),
		randomId,
		random: Math.random,
		reportError: (error) => {
			throw error;
		},
	};
	return {
		env,
		setVisible(next: boolean) {
			visible = next;
			for (const listener of listeners.get("document:visibilitychange") ?? []) {
				listener(new Event("visibilitychange"));
			}
		},
	};
}

/**
 * Node stand-in for one SharedWorker instance: every construction returns a
 * new port to the same runtime, as the browser does for a matching worker.
 */
export function sharedWorker(runtime: Runtime): () => SharedWorker {
	return () => {
		const channel = new MessageChannel();
		runtime.accept(channel.port2);
		return {
			port: channel.port1,
			addEventListener() {},
			removeEventListener() {},
		} as unknown as SharedWorker;
	};
}

export function tab(
	runtime: Runtime,
	origin: string,
	options: Partial<SpinetabOptions> = {},
): { client: SpinetabClient; setVisible(visible: boolean): void } {
	const { env, setVisible } = nodeEnv(`${origin}/app/`);
	const client = createClientWithEnv(
		{ worker: sharedWorker(runtime), sharing: "require", ...options },
		env,
	);
	return { client, setVisible };
}

export interface PollingCounters {
	requests: Array<{
		id: string;
		method: string;
		hasAuth: boolean;
		scope: string | null;
		at: number;
		status: number;
		aborted: boolean;
	}>;
	byId: Record<
		string,
		{
			requests: number;
			inFlight: number;
			maxInFlight: number;
			aborted: number;
			completed: number;
			n: number;
		}
	>;
}

export async function pollingCounters(
	origin: string,
): Promise<PollingCounters> {
	const response = await fetch(`${origin}/__fixture/counters`);
	return ((await response.json()) as { polling: PollingCounters }).polling;
}

export async function byId(origin: string, id: string) {
	const counters = await pollingCounters(origin);
	return {
		stats: counters.byId[id] ?? {
			requests: 0,
			inFlight: 0,
			maxInFlight: 0,
			aborted: 0,
			completed: 0,
			n: 0,
		},
		requests: counters.requests.filter((request) => request.id === id),
	};
}

export async function fault(
	origin: string,
	action: string,
	value: unknown,
): Promise<void> {
	await fetch(`${origin}/__fixture/fault`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ target: "polling", action, value }),
	});
}

export const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function waitFor(
	check: () => boolean | Promise<boolean>,
	timeoutMs = 8_000,
	stepMs = 25,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await check()) return;
		if (Date.now() > deadline) throw new Error("waitFor timed out");
		await sleep(stepMs);
	}
}

let counter = 0;
export function uniqueId(label: string): string {
	counter += 1;
	return `${label}-${process.pid}-${Date.now().toString(36)}-${counter}`;
}
