import type { SubscriptionSink } from "../../../src/core/adapter.ts";
import {
	browserEnv,
	type ClientEnv,
	createClientWithEnv,
} from "../../../src/core/client.ts";
import { createRuntime, type Runtime } from "../../../src/core/runtime.ts";
import type {
	SpinetabClient,
	SubscriptionRequest,
} from "../../../src/core/types.ts";

/**
 * The REAL page client over `createRuntime` in-process (bridge protocol on a
 * MessageChannel, `sharing: "off"`), with a controlled adapter that exposes
 * one sink per subscription key, for binding tests that must not depend on
 * the fake client (lane A, DOM-ID-RC; setup as tests/dom/swr-runtime.test.ts).
 * Events larger than 128 bytes stop delivery (`gap/message-too-large`).
 * `reports` records the codes core's callback guard reports (loud path).
 * Framework-neutral: pass a `tick` that flushes the framework (React:
 * `(run) => act(run)`) to `waitFor`.
 */
export type Tick = { n: number | string };

export interface RealCore {
	client: SpinetabClient;
	runtime: Runtime;
	/** The upstream sink per subscription key; the latest subscribe wins. */
	sinks: Map<string, SubscriptionSink<Tick>>;
	/** Codes passed to `onCallbackError`. */
	reports: string[];
	dispose(): void;
}

const env: ClientEnv = {
	...browserEnv,
	isBrowser: () => true,
	hasSharedWorker: () => false,
	visible: () => true,
	baseUri: () => "https://example.test/",
	listen: () => () => {},
};

export function createRealCore(): RealCore {
	const sinks = new Map<string, SubscriptionSink<Tick>>();
	const reports: string[] = [];
	const runtime = createRuntime({
		adapters: [
			{
				kind: "controlled",
				version: 1,
				connect(_spec, context) {
					context.setStatus({ state: "connected" });
					return {
						subscribe(spec, sink) {
							sinks.set(
								(spec as { key: string }).key,
								sink as SubscriptionSink<Tick>,
							);
							return { unsubscribe() {} };
						},
						retry() {},
						dispose() {},
					};
				},
			},
		],
		limits: { maxMessageBytes: 128, lingerMs: 1, idleCloseMs: 1 },
	});
	const client = createClientWithEnv(
		{
			sharing: "off",
			anonymous: true,
			local: async () => ({ runtime: () => runtime }),
			onCallbackError: (error) =>
				reports.push((error as { code?: string }).code ?? String(error)),
		},
		env,
	);
	return {
		client,
		runtime,
		sinks,
		reports,
		dispose() {
			client.dispose();
			runtime.dispose();
		},
	};
}

/** A request for the controlled adapter; `key` names its sink. */
export const coreRequest = (key: string): SubscriptionRequest<Tick> => ({
	adapter: "controlled",
	connection: {},
	subscription: { key },
});

/** Larger than the runtime's 128-byte limit: stops that consumer's delivery. */
export const oversized: Tick = { n: "x".repeat(1000) };

export const pause = () =>
	new Promise<void>((resolve) => setTimeout(resolve, 25));

/** Polls `check` every 25 ms (through `tick`) for at most 2 s. */
export async function waitFor(
	check: () => boolean,
	label: string,
	tick: (run: () => Promise<void>) => Promise<void> | void = (run) => run(),
): Promise<void> {
	const end = Date.now() + 2000;
	while (!check()) {
		if (Date.now() > end) throw new Error(`Timed out: ${label}`);
		await tick(pause);
	}
}
