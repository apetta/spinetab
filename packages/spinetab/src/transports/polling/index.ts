import type { HttpCredentialsMode, HttpMethod } from "../../core/http.ts";
import type {
	ConsumerOptions,
	Json,
	SubscriptionRequest,
} from "../../core/types.ts";
import {
	assertObject,
	assertPositiveInteger,
	unsupported,
} from "../../core/validate.ts";
import { normalisePollingRead, type PollingConnection } from "./spec.ts";

export type { PollingConnection };

export const POLLING_ADAPTER = "polling";
/** The runtime's bounds on `consumer.intervalMs`, checked on the page too. */
const MIN_INTERVAL_MS = 1_000;
const MAX_INTERVAL_MS = 86_400_000;

export interface PollingOptions {
	/** Relative URLs are resolved in the page against the client's base. */
	url: string;
	method?: HttpMethod;
	/** Response-affecting, non-secret headers (part of identity). */
	headers?: Record<string, string>;
	body?: string | Json;
	/** fetch credentials mode for cookies. Bearer tokens come from the provider. */
	credentials?: HttpCredentialsMode;
	/**
	 * Provider `headers` on each read. Unset (auto): merged only for a URL
	 * on the worker's own origin, when a provider exists. `true`: required on
	 * any URL; a cross-origin URL must be in the worker's `credentialOrigins`.
	 * `false`: never.
	 */
	authHeaders?: boolean;
	/** Decoder registered in the runtime: "json" (default), "text" or custom. */
	decoder?: string;
	/** Per-read timeout (identity-bearing); default 30 000 ms. */
	timeoutMs?: number;
}

export type PollingSubscription = Record<string, never>;

/** Per-consumer options; they never split identity. */
export interface PollingConsumerOptions {
	/**
	 * Minimum 1 000 ms; default 5 000 ms when omitted. The shortest
	 * eligible interval drives the schedule.
	 */
	intervalMs?: number;
	/** Application gate; the page's visibility also applies unless `whileHidden`. */
	eligible?: boolean;
	/** Keep polling while the page is hidden (subject to timer throttling). */
	whileHidden?: boolean;
	/** "read" (default): request one coalesced fresh read on join; "await": wait. */
	onJoin?: "read" | "await";
}

/**
 * A polling feed is its own source: `subscribe(polling<T>(url), fn)`. `E` is
 * the decoded body type, fixed by the builder; `.subscription<T>()` still
 * overrides it.
 */
export interface PollingFeed<E = unknown> {
	readonly connection: PollingConnection;
	subscription<E2 = E>(): SubscriptionRequest<
		E2,
		PollingConnection,
		PollingSubscription
	>;
	/**
	 * The same call without a type argument. Listed last because TypeScript
	 * infers from the last signature, so `subscribe(feed, fn)` infers `E`.
	 */
	subscription(): SubscriptionRequest<
		E,
		PollingConnection,
		PollingSubscription
	>;
}

/**
 * Declare a repeatable read shared across tabs. Choosing polling is the
 * application's declaration that the request may be re-issued on a schedule,
 * including non-GET methods. Unsupported options throw `unsupported-option`.
 * `polling(url, options)` and `polling({ url,...options })` are one
 * connection.
 */
export function polling<E = unknown>(
	url: string,
	options?: Omit<PollingOptions, "url">,
): PollingFeed<E>;
export function polling(options: PollingOptions): PollingFeed;
export function polling(
	target: string | PollingOptions,
	options?: Omit<PollingOptions, "url">,
): PollingFeed {
	let input: unknown = target;
	if (typeof target === "string") {
		input = { url: target };
		if (options !== undefined) {
			// Non-object options fail as `polling(null)` does; a repeated `url`
			// is rejected, and `url: undefined` never replaces the first argument.
			const given: unknown = options;
			assertObject(given, "polling", POLLING_ADAPTER);
			if (given.url !== undefined) {
				throw unsupported(
					"polling.url",
					"is the first argument; remove it from the options.",
					POLLING_ADAPTER,
				);
			}
			input = { ...given, url: target };
		}
	}
	const connection = normalisePollingRead(input, "polling", POLLING_ADAPTER);
	return {
		connection,
		subscription: () => ({
			adapter: POLLING_ADAPTER,
			connection,
			subscription: {},
		}),
	};
}

/**
 * Consumer options for `spinetab.subscribe(feed, fn, pollEvery(ms))`. Without
 * them the runtime polls every 5 000 ms. The interval is checked here,
 * synchronously: an integer from 1 000 to 86 400 000 ms.
 */
export function pollEvery(
	intervalMs: number,
	options: Omit<PollingConsumerOptions, "intervalMs"> = {},
): ConsumerOptions {
	assertPositiveInteger(intervalMs, "pollEvery.intervalMs", {
		min: MIN_INTERVAL_MS,
		max: MAX_INTERVAL_MS,
		adapter: POLLING_ADAPTER,
	});
	return { consumer: { ...options, intervalMs } };
}
