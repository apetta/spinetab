import type { SubscriptionRequest } from "../../core/types.ts";
import { withUrl } from "../shared/options.ts";
import {
	canonicalSseConnection,
	checkSubscriptionAgainst,
	isSseRepeatable,
	type SseConnectionSpec,
	type SseSubscriptionSpec,
	validateSseConnection,
	validateSseSubscription,
} from "./spec.ts";

export type { SseConnectionSpec, SseSubscriptionSpec };

export const SSE_ADAPTER = "sse";

/**
 * An SSE feed is its own source for its default event:
 * `subscribe(sse<T>(url), (data, meta) =>...)`. `E` is the decoded `data`
 * of each event: JSON by default, a string with `decoder: "text"`. The
 * event ID and name arrive as `meta.eventId` and `meta.event`.
 */
export interface SseFeed<E = unknown> {
	readonly connection: SseConnectionSpec;
	/**
	 * Subscribe to one event type (default `message`). Consumers selecting
	 * different types on the same identity share one upstream stream.
	 */
	subscription<E2 = E>(
		spec?: SseSubscriptionSpec,
	): SubscriptionRequest<E2, SseConnectionSpec, SseSubscriptionSpec>;
	/**
	 * The default event without a type argument. Listed last because
	 * TypeScript infers from the last signature, so `subscribe(feed, fn)`
	 * infers `E`.
	 */
	subscription(): SubscriptionRequest<
		E,
		SseConnectionSpec,
		SseSubscriptionSpec
	>;
}

type SseOptions = Omit<SseConnectionSpec, "url">;

/**
 * Describe an SSE stream. Options are validated here, synchronously, so an
 * unsupported option fails at definition. Relative URLs are kept
 * as written; the client resolves them against its base at subscribe time.
 * `mode` defaults to "fetch" and `decoder` to "json". Custom
 * decoders and resume URL hooks are registered in the worker's `sseAdapter`
 * and referenced by name. `sse(url, options)` and `sse({ url,...options })`
 * are one connection.
 *
 * `decoder: "text"` delivers each event's data as a string.
 */
export function sse(
	url: string,
	options: SseOptions & { decoder: "text" },
): SseFeed<string>;
/** JSON (the default) or a named worker decoder: `sse<T>(url)` types the data as `T`. */
export function sse<E = unknown>(url: string, options?: SseOptions): SseFeed<E>;
export function sse(
	connection: SseConnectionSpec & { decoder: "text" },
): SseFeed<string>;
export function sse<E = unknown>(connection: SseConnectionSpec): SseFeed<E>;
export function sse(
	target: string | SseConnectionSpec,
	options?: SseOptions,
): SseFeed<unknown> {
	const input =
		typeof target === "string"
			? withUrl(target, options, "connection")
			: target;
	validateSseConnection(input, { requireAbsolute: false });
	const connection = canonicalSseConnection(input);
	const repeatable = isSseRepeatable(connection);
	return {
		connection,
		subscription(spec: SseSubscriptionSpec = {}) {
			validateSseSubscription(spec);
			checkSubscriptionAgainst(connection, spec);
			return {
				adapter: SSE_ADAPTER,
				connection,
				subscription: spec,
				repeatable,
			};
		},
	};
}
