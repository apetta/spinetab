import {
	BRIDGE_VERSION,
	bool,
	errorRecord,
	hasEnvelope,
	int,
	matches,
	object,
	optional,
	type RuntimeAnnounce,
	type RuntimeMessage,
	revision,
	shapeOf,
	str,
	type Validator,
} from "./bridge.ts";

/**
 * Page side of bridge v1: validation of
 * runtime→page messages. Only page code imports this module, so runtime
 * entries never carry the runtime-message shape table.
 */

const consumerList = (value: unknown): boolean =>
	str(value) || (Array.isArray(value) && value.length > 0 && value.every(str));
const countList = (value: unknown): boolean =>
	Array.isArray(value) && value.length > 0 && value.every(int);

const runtimeShapes: Record<RuntimeMessage["t"], Validator> = {
	welcome: {
		runtime: str,
		limits: object,
		adapters: (value) =>
			Array.isArray(value) &&
			value.every(
				(item) => object(item) && str(item.kind) && int(item.version),
			),
		lease: int,
	},
	reject: {
		code: (value) => value === "incompatible-version",
		supported: (value) => Array.isArray(value) && value.every(int),
	},
	startupError: { code: str, message: str },
	event: {
		c: str,
		seq: int,
		kind: (value) =>
			value === "next" || value === "error" || value === "complete",
	},
	status: {
		k: int,
		c: consumerList,
		connection: (value) =>
			object(value) && str(value.state) && typeof value.since === "number",
		repeatable: optional(bool),
	},
	continuity: {
		k: int,
		c: consumerList,
		continuity: (value) =>
			object(value) && str(value.state) && typeof value.since === "number",
		missed: optional(countList),
		pending: optional(bool),
	},
	commandResult: {
		k: int,
		id: str,
		outcome: (value) => object(value) && str(value.status),
	},
	credentialsRequest: { k: int, id: str, scope: str, revision, reason: str },
	probeResult: { k: int, id: str, runtime: str },
	detached: { code: str },
	error: {
		k: int,
		c: optional(str),
		id: optional(str),
		code: str,
		message: str,
	},
	diagnostic: { k: int, event: object },
};

/** Validate a runtime→page envelope; `undefined` means drop and count it. */
export function parseRuntimeMessage(
	value: unknown,
): RuntimeMessage | undefined {
	if (!hasEnvelope(value)) return undefined;
	const type = value.t as RuntimeMessage["t"];
	if (!matches(value, shapeOf(runtimeShapes, type))) return undefined;
	if (
		type === "continuity" &&
		value.missed !== undefined &&
		!(
			Array.isArray(value.c) &&
			(value.missed as unknown[]).length === value.c.length
		)
	) {
		return undefined;
	}
	if (type === "event") {
		if (value.kind === "error" && !(int(value.k) && errorRecord(value.error))) {
			return undefined;
		}
		if (value.kind === "complete" && !int(value.k)) return undefined;
		if (
			value.kind === "next" &&
			!(optional(str)(value.eventId) && optional(str)(value.event))
		) {
			return undefined;
		}
	}
	return value as unknown as RuntimeMessage;
}

/** Validate a port-level `announce`; `undefined` for anything else. */
export function parseAnnounce(value: unknown): RuntimeAnnounce | undefined {
	return object(value) &&
		value.v === BRIDGE_VERSION &&
		value.t === "announce" &&
		str(value.runtime) &&
		value.runtime.length > 0 &&
		int(value.generation)
		? (value as unknown as RuntimeAnnounce)
		: undefined;
}

/**
 * A well-formed v1 runtime envelope whose type this page does not know (an
 * additive message from a newer runtime): ignored rather than treated as a
 * foreign peer, so it never fails a handshake.
 */
export function isUnknownRuntimeType(value: unknown): boolean {
	return (
		hasEnvelope(value) &&
		shapeOf(runtimeShapes, value.t) === undefined &&
		value.t !== "announce"
	);
}

export function consumerIds(value: string | string[]): string[] {
	return typeof value === "string" ? [value] : value;
}
