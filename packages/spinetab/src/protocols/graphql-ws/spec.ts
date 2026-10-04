import type { Json } from "../../core/types.ts";
import {
	assertAbsoluteUrl,
	assertBoolean,
	assertInteger,
	assertJson,
	assertKnownKeys,
	assertPlainObject,
	assertString,
	refuseCredentialCarriers,
	refuseUrlCredentials,
} from "../shared/validate.ts";

/**
 * Connection options for `graphqlWs()`. All values are identity-bearing,
 * non-secret and cloneable; credentials come from the scope's credentials
 * callback (`credentials.connectionParams`), never from these options.
 */
export interface GraphqlWsConnection {
	/** `ws:`/`wss:` endpoint (`http:`/`https:` are mapped to the WebSocket scheme). */
	url: string;
	/** Non-secret ConnectionInit payload members; credentials are merged over them. */
	connectionParams?: Record<string, Json>;
	/** Client ping interval. Default 15 000 ms. */
	keepAliveMs?: number;
	/** Missing-pong deadline before `terminate()`. Default 5 000 ms. */
	pongTimeoutMs?: number;
	/** Upstream retry budget. Default 5 (upstream default). */
	retryAttempts?: number;
	/** Upstream lazy close; default the runtime's `idleCloseMs`. */
	lazyCloseTimeoutMs?: number;
	/** ConnectionAck wait. Default 10 000 ms; 0 (wait forever) is rejected. */
	connectionAckWaitTimeoutMs?: number;
	/** Declare that the endpoint needs no credentials. */
	anonymous?: boolean;
}

export const GRAPHQL_WS_DEFAULTS = Object.freeze({
	keepAliveMs: 15_000,
	pongTimeoutMs: 5_000,
	retryAttempts: 5,
	connectionAckWaitTimeoutMs: 10_000,
});

const KEYS = [
	"url",
	"connectionParams",
	"keepAliveMs",
	"pongTimeoutMs",
	"retryAttempts",
	"lazyCloseTimeoutMs",
	"connectionAckWaitTimeoutMs",
	"anonymous",
] as const;

export function validateGraphqlWsConnection(
	spec: unknown,
	options: { absolute: boolean },
	path = "connection",
): asserts spec is GraphqlWsConnection {
	assertPlainObject(spec, path);
	assertKnownKeys(spec, KEYS, path);
	assertString(spec.url, `${path}.url`, { nonEmpty: true });
	if (options.absolute) {
		assertAbsoluteUrl(spec.url, `${path}.url`, [
			"ws:",
			"wss:",
			"http:",
			"https:",
		]);
	}
	refuseUrlCredentials(spec.url, `${path}.url`);
	if (spec.connectionParams !== undefined) {
		assertPlainObject(spec.connectionParams, `${path}.connectionParams`);
		assertJson(spec.connectionParams, `${path}.connectionParams`);
		refuseCredentialCarriers(spec.connectionParams, `${path}.connectionParams`);
	}
	assertInteger(spec.keepAliveMs, `${path}.keepAliveMs`, {
		min: 100,
		max: 300_000,
	});
	assertInteger(spec.pongTimeoutMs, `${path}.pongTimeoutMs`, {
		min: 100,
		max: 60_000,
	});
	assertInteger(spec.retryAttempts, `${path}.retryAttempts`, {
		min: 0,
		max: 50,
	});
	assertInteger(spec.lazyCloseTimeoutMs, `${path}.lazyCloseTimeoutMs`, {
		min: 0,
		max: 60_000,
	});
	assertInteger(
		spec.connectionAckWaitTimeoutMs,
		`${path}.connectionAckWaitTimeoutMs`,
		{ min: 100, max: 120_000 },
	);
	assertBoolean(spec.anonymous, `${path}.anonymous`);
}
