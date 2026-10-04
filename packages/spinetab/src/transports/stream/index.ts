import type { SubscriptionRequest } from "../../core/types.ts";
import { withUrl } from "../shared/options.ts";
import {
	canonicalStreamConnection,
	type StreamConnectionSpec,
	type StreamSubscriptionSpec,
	validateStreamConnection,
} from "./spec.ts";

export type { StreamConnectionSpec, StreamSubscriptionSpec };

export const STREAM_ADAPTER = "stream";

/**
 * A stream feed is its own source: `subscribe(stream<T>(url), fn)`. `E` is
 * the parsed frame type, fixed by the builder; `.subscription<T>()` still
 * overrides it.
 */
export interface StreamFeed<E = unknown> {
	readonly connection: StreamConnectionSpec;
	/**
	 * The response's parsed frames. Non-repeatable requests (the default) are
	 * never shared or restarted; an interruption settles `interrupted`.
	 */
	subscription<E2 = E>(): SubscriptionRequest<
		E2,
		StreamConnectionSpec,
		StreamSubscriptionSpec
	>;
	/**
	 * The same call without a type argument. Listed last because TypeScript
	 * infers from the last signature, so `subscribe(feed, fn)` infers `E`.
	 */
	subscription(): SubscriptionRequest<
		E,
		StreamConnectionSpec,
		StreamSubscriptionSpec
	>;
}

/**
 * Describe a fetch stream parsed by a worker-registered parser, NDJSON by
 * default. Options are validated synchronously; relative URLs are
 * resolved by the client. `stream(url, options)` and
 * `stream({ url,...options })` are one connection.
 */
export function stream<E = unknown>(
	url: string,
	options?: Omit<StreamConnectionSpec, "url">,
): StreamFeed<E>;
export function stream(connection: StreamConnectionSpec): StreamFeed;
export function stream(
	target: string | StreamConnectionSpec,
	options?: Omit<StreamConnectionSpec, "url">,
): StreamFeed {
	const input =
		typeof target === "string"
			? withUrl(target, options, "connection")
			: target;
	validateStreamConnection(input, { requireAbsolute: false });
	const connection = canonicalStreamConnection(input);
	const repeatable = connection.repeatable === true;
	return {
		connection,
		subscription() {
			return {
				adapter: STREAM_ADAPTER,
				connection,
				subscription: {},
				repeatable,
			};
		},
	};
}
