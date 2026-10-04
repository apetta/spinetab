import type { Json } from "../../core/types.ts";
import {
	assertAbsoluteUrl,
	assertBoolean,
	assertInteger,
	assertJson,
	assertKnownKeys,
	assertPlainObject,
	assertString,
	invalid,
	isPlainObject,
	refuseCredentialCarriers,
	refuseUrlCredentials,
} from "../../protocols/shared/validate.ts";

/**
 * Specs crossing the bridge for the tRPC links. Realm-neutral:
 * no `@trpc/*` imports. Subscription identity is `{ path, input }` without
 * `lastEventId`, plus the starting cursor, so consumers at different stream
 * positions never share.
 */
export interface TrpcWsConnection {
	url: string;
	/**
	 * Non-secret connection params (string values: the tRPC server rejects
	 * others); `credentials.connectionParams` is merged over them.
	 */
	connectionParams?: Record<string, string>;
	/** Consecutive failed sockets before `retry-exhausted`; default 10. */
	retryAttempts?: number;
	/** Upstream lazy close (`lazy.closeMs`); default the runtime's `idleCloseMs`. */
	lazyCloseMs?: number;
	/** Upstream keep-alive; default `{ intervalMs: 5000, pongTimeoutMs: 1000 }`. */
	keepAlive?: { intervalMs: number; pongTimeoutMs: number };
	/** Declare that the endpoint needs no credentials. */
	anonymous?: boolean;
	/**
	 * the router uses a data transformer. Plain JSON, never the
	 * transformer itself; the page link sends it only as `true`, and an
	 * adapter constructed without a transformer refuses the request.
	 */
	transformer?: boolean;
}

export interface TrpcSseConnection {
	url: string;
	/**
	 * Non-secret connection params only: upstream JSON-encodes them into the
	 * URL query. Credentials are never placed here.
	 */
	connectionParams?: Record<string, string>;
	/** Cross-origin cookies for the EventSource. */
	withCredentials?: boolean;
	/** Consecutive failed attempts before `retry-exhausted`; default 10. */
	retryAttempts?: number;
	/** Declare that the endpoint needs no credentials (cookie recipe is the default). */
	anonymous?: boolean;
	/**
	 * the router uses a data transformer. Plain JSON, never the
	 * transformer itself; the page link sends it only as `true`, and an
	 * adapter constructed without a transformer refuses the request.
	 */
	transformer?: boolean;
}

export interface TrpcSubscriptionSpec {
	path: string;
	/** Procedure input without `lastEventId`. */
	input?: Json;
	/** Starting cursor forwarded as `lastEventId`; part of identity. */
	lastEventId?: string;
	/** The application declared that this procedure replays from `lastEventId`. */
	replay?: boolean;
}

/** One delivered result, in upstream's shape (`{ id, data }` for tracked events). */
export interface TrpcEvent<TData = unknown> {
	id?: string;
	data: TData;
}

export const TRPC_DEFAULTS = Object.freeze({
	retryAttempts: 10,
	keepAlive: Object.freeze({ intervalMs: 5_000, pongTimeoutMs: 1_000 }),
});

export function validateTrpcWsConnection(
	spec: unknown,
	options: { absolute: boolean },
	path = "connection",
): asserts spec is TrpcWsConnection {
	assertPlainObject(spec, path);
	assertKnownKeys(
		spec,
		[
			"url",
			"connectionParams",
			"retryAttempts",
			"lazyCloseMs",
			"keepAlive",
			"anonymous",
			"transformer",
		],
		path,
	);
	assertString(spec.url, `${path}.url`, { nonEmpty: true });
	refuseUrlCredentials(spec.url, `${path}.url`);
	if (options.absolute) {
		assertAbsoluteUrl(spec.url, `${path}.url`, [
			"ws:",
			"wss:",
			"http:",
			"https:",
		]);
	}
	validateParams(spec.connectionParams, `${path}.connectionParams`);
	assertInteger(spec.retryAttempts, `${path}.retryAttempts`, {
		min: 1,
		max: 1_000,
	});
	assertInteger(spec.lazyCloseMs, `${path}.lazyCloseMs`, {
		min: 0,
		max: 60_000,
	});
	if (spec.keepAlive !== undefined) {
		assertPlainObject(spec.keepAlive, `${path}.keepAlive`);
		assertKnownKeys(
			spec.keepAlive,
			["intervalMs", "pongTimeoutMs"],
			`${path}.keepAlive`,
		);
		assertInteger(spec.keepAlive.intervalMs, `${path}.keepAlive.intervalMs`, {
			min: 100,
			max: 300_000,
		});
		assertInteger(
			spec.keepAlive.pongTimeoutMs,
			`${path}.keepAlive.pongTimeoutMs`,
			{
				min: 100,
				max: 60_000,
			},
		);
		if (
			spec.keepAlive.intervalMs === undefined ||
			spec.keepAlive.pongTimeoutMs === undefined
		) {
			throw invalid(`${path}.keepAlive`, "needs intervalMs and pongTimeoutMs.");
		}
	}
	assertBoolean(spec.anonymous, `${path}.anonymous`);
	assertBoolean(spec.transformer, `${path}.transformer`);
}

export function validateTrpcSseConnection(
	spec: unknown,
	options: { absolute: boolean },
	path = "connection",
): asserts spec is TrpcSseConnection {
	assertPlainObject(spec, path);
	assertKnownKeys(
		spec,
		[
			"url",
			"connectionParams",
			"withCredentials",
			"retryAttempts",
			"anonymous",
			"transformer",
		],
		path,
	);
	assertString(spec.url, `${path}.url`, { nonEmpty: true });
	refuseUrlCredentials(spec.url, `${path}.url`);
	if (options.absolute) {
		assertAbsoluteUrl(spec.url, `${path}.url`, ["http:", "https:"]);
	}
	validateParams(spec.connectionParams, `${path}.connectionParams`);
	assertBoolean(spec.withCredentials, `${path}.withCredentials`);
	assertInteger(spec.retryAttempts, `${path}.retryAttempts`, {
		min: 1,
		max: 1_000,
	});
	assertBoolean(spec.anonymous, `${path}.anonymous`);
	assertBoolean(spec.transformer, `${path}.transformer`);
}

function validateParams(value: unknown, path: string): void {
	if (value === undefined) return;
	assertPlainObject(value, path);
	for (const [key, item] of Object.entries(value)) {
		assertString(item, `${path}.${key}`);
	}
	refuseCredentialCarriers(value, path);
}

export function validateTrpcSubscription(
	spec: unknown,
	path = "subscription",
): asserts spec is TrpcSubscriptionSpec {
	assertPlainObject(spec, path);
	assertKnownKeys(spec, ["path", "input", "lastEventId", "replay"], path);
	assertString(spec.path, `${path}.path`, { nonEmpty: true });
	if (spec.input !== undefined) {
		assertJson(spec.input, `${path}.input`);
		if (isPlainObject(spec.input) && "lastEventId" in spec.input) {
			throw invalid(
				`${path}.input.lastEventId`,
				"the cursor is not identity; pass it as subscription.lastEventId.",
			);
		}
	}
	assertString(spec.lastEventId, `${path}.lastEventId`, {
		optional: true,
		nonEmpty: true,
	});
	assertBoolean(spec.replay, `${path}.replay`);
}

/**
 * Input sent upstream: tRPC servers merge `lastEventId` into object inputs;
 * non-object inputs cannot carry a cursor.
 */
export function inputWithCursor(
	input: Json | undefined,
	cursor: string | undefined,
): unknown {
	if (!cursor) return input;
	if (input === undefined || input === null) return { lastEventId: cursor };
	if (isPlainObject(input)) return { ...input, lastEventId: cursor };
	return input;
}

/**
 * Whether `inputWithCursor` can convey a cursor for this input: `undefined`,
 * `null` and plain objects can; any other input cannot, so a start with it is
 * never reported as resumed.
 */
export function carriesCursor(input: Json | undefined): boolean {
	return input === undefined || input === null || isPlainObject(input);
}

/** Split an op input into identity input and starting cursor (page links). */
export function splitCursor(input: unknown): {
	input?: Json;
	lastEventId?: string;
} {
	if (!isPlainObject(input) || !("lastEventId" in input)) {
		return input === undefined ? {} : { input: input as Json };
	}
	const { lastEventId, ...rest } = input;
	const result: { input?: Json; lastEventId?: string } = {};
	if (Object.keys(rest).length > 0) result.input = rest as Json;
	if (typeof lastEventId === "string" && lastEventId)
		result.lastEventId = lastEventId;
	return result;
}
