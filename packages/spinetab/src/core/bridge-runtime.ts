import {
	BRIDGE_VERSION,
	bool,
	errorRecord,
	hasEnvelope,
	int,
	matches,
	object,
	optional,
	type PageMessage,
	revision,
	shapeOf,
	str,
	type Validator,
} from "./bridge.ts";

/**
 * Runtime side of bridge v1: validation
 * of page→runtime messages. Only the runtime imports this module, so page
 * entries never carry the page-message shape table.
 */

const request = (value: unknown): boolean =>
	object(value) &&
	str(value.adapter) &&
	"connection" in value &&
	optional(str)(value.scope) &&
	optional(bool)(value.repeatable) &&
	optional((share) => share === "always" || share === "before-start")(
		value.share,
	) &&
	optional(bool)(value.stateful);

const pageShapes: Record<PageMessage["t"], Validator> = {
	hello: {
		page: str,
		scope: str,
		revision,
		heartbeatMs: int,
		limits: optional(object),
		lease: optional(int),
		visible: optional(bool),
		credentials: optional(bool),
		diagnostics: optional(bool),
		anonymous: optional((value) => value === true),
	},
	subscribe: {
		c: str,
		request: (value) =>
			request(value) && object(value) && "subscription" in value,
		cursor: optional(str),
		replay: optional((value) => value === true),
	},
	unsubscribe: { c: str },
	update: { c: str },
	ack: { c: optional(str), seq: optional(int), k: optional(int) },
	reconcile: { c: str },
	command: {
		id: str,
		request: (value) => request(value) && object(value) && "payload" in value,
		timeoutMs: int,
	},
	cancel: { id: str },
	credentials: {
		id: str,
		ok: bool,
		credentials: optional(object),
		error: optional(errorRecord),
		revision,
	},
	revision: {
		revision: (value) => value !== null && revision(value),
		restart: bool,
	},
	probe: { id: str, hint: optional(bool) },
	renew: {},
	retry: { c: optional(str) },
	visibility: { visible: bool },
	detach: {},
};

/** Validate a page→runtime envelope; `undefined` means drop and count it. */
export function parsePageMessage(value: unknown): PageMessage | undefined {
	if (!hasEnvelope(value)) return undefined;
	return matches(value, shapeOf(pageShapes, value.t))
		? (value as unknown as PageMessage)
		: undefined;
}

/** A `hello` from another bridge version: answer with a stable `reject`. */
export function foreignHello(
	value: unknown,
): { a: string; g: number; received: unknown } | undefined {
	if (
		object(value) &&
		value.t === "hello" &&
		value.v !== BRIDGE_VERSION &&
		str(value.a) &&
		int(value.g)
	) {
		return { a: value.a, g: value.g, received: value.v };
	}
	return undefined;
}
