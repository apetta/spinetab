import type { Json } from "../../core/types.ts";
import { refuseCredentialCarriers } from "../../core/validate.ts";
import {
	assertEndpoint,
	assertKeys,
	assertRecord,
	optionalBoolean,
	optionalOneOf,
	optionalString,
	optionError,
	WS_PROTOCOLS,
} from "../shared/options.ts";

/** Credentials belong in cookies or the authenticate hook, never the URL or subprotocols. */
export interface WebSocketConnectionSpec {
	url: string;
	/**
	 * Worker protocol name registered in `websocketAdapter({ protocols })`.
	 * Omitted: raw connection-scoped feed delivering every frame unchanged.
	 */
	protocol?: string;
	/** Ordered WebSocket subprotocols offered in the handshake. */
	subprotocols?: string[];
	/** Binary frame representation; default "arraybuffer". "blob" only without a protocol. */
	binaryType?: "arraybuffer" | "blob";
	/**
	 * Raw connections only: "json" parses each text frame, and each
	 * binary frame as UTF-8, before delivery; a frame that does not parse is
	 * a `decode-error` gap and the socket stays open. Omitted: frames pass
	 * through as `string | ArrayBuffer`. With a protocol, its codec decides.
	 */
	decoder?: "json";
}

/** A topic routed by the protocol, or no topic for the whole connection feed. */
export interface WebSocketSubscriptionSpec {
	topic?: Json;
}

export interface WebSocketCommandPayload {
	data: Json;
	/** Override the protocol's acknowledgement expectation. */
	expectsAck?: boolean;
}

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export function validateWebSocketConnection(
	spec: unknown,
	options: { requireAbsolute: boolean },
	path = "connection",
): asserts spec is WebSocketConnectionSpec {
	assertRecord(spec, path);
	assertKeys(
		spec,
		["url", "protocol", "subprotocols", "binaryType", "decoder"],
		path,
	);
	assertEndpoint(spec, "url", path, WS_PROTOCOLS, options);
	const protocol = optionalString(spec, "protocol", path);
	if (protocol === "")
		throw optionError(`${path}.protocol`, "must not be empty.");
	const subprotocols = spec.subprotocols;
	if (subprotocols !== undefined) {
		if (!Array.isArray(subprotocols)) {
			throw optionError(`${path}.subprotocols`, "must be an array of tokens.");
		}
		const seen = new Set<string>();
		subprotocols.forEach((entry, index) => {
			if (typeof entry !== "string" || !TOKEN.test(entry) || seen.has(entry)) {
				throw optionError(
					`${path}.subprotocols[${index}]`,
					"must be a unique protocol token.",
				);
			}
			seen.add(entry);
		});
		// Over 64 characters or containing "bearer" looks like a token.
		refuseCredentialCarriers(subprotocols, `${path}.subprotocols`);
	}
	const binaryType = optionalOneOf(
		spec,
		"binaryType",
		["arraybuffer", "blob"],
		path,
	);
	if (binaryType === "blob" && protocol !== undefined) {
		throw optionError(
			`${path}.binaryType`,
			'"blob" is only supported without a protocol: asynchronous Blob decoding would reorder frames.',
		);
	}
	const decoder = optionalOneOf(spec, "decoder", ["json"], path);
	if (decoder !== undefined && protocol !== undefined) {
		throw optionError(
			`${path}.decoder`,
			"is for raw connections; with a protocol, its decode hook decides.",
		);
	}
	if (decoder !== undefined && binaryType === "blob") {
		throw optionError(
			`${path}.decoder`,
			'needs binaryType "arraybuffer": asynchronous Blob decoding would reorder frames.',
		);
	}
}

export function validateWebSocketSubscription(
	spec: unknown,
	path = "subscription",
): asserts spec is WebSocketSubscriptionSpec {
	assertRecord(spec, path);
	assertKeys(spec, ["topic"], path);
}

export function validateWebSocketCommand(
	payload: unknown,
	path = "command",
): asserts payload is WebSocketCommandPayload {
	assertRecord(payload, path);
	assertKeys(payload, ["data", "expectsAck"], path);
	if (!("data" in payload)) throw optionError(`${path}.data`, "is required.");
	optionalBoolean(payload, "expectsAck", path);
}
