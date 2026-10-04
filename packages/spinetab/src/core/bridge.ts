import type {
	CommandOutcome,
	ConnectionStatus,
	Continuity,
	CredentialRequest,
	CredentialRevision,
	Credentials,
	DeliveryLimits,
	DiagnosticEvent,
	Json,
	RuntimeLimits,
	SerialisedError,
	SpinetabErrorCode,
} from "./types.ts";

/** Fence side effects by attachment ID and generation; treat the replay marker as an optional capability negotiated at welcome. */
export const BRIDGE_VERSION = 1;

interface Envelope {
	v: typeof BRIDGE_VERSION;
	a: string;
	g: number;
}

export interface WireSubscriptionRequest {
	adapter: string;
	connection: unknown;
	subscription: unknown;
	scope?: string;
	repeatable?: boolean;
	share?: "always" | "before-start";
	stateful?: boolean;
}

export interface WireCommandRequest {
	adapter: string;
	connection: unknown;
	scope?: string;
	payload: unknown;
}

export type PageMessage = Envelope &
	(
		| {
				t: "hello";
				page: string;
				scope: string;
				revision: CredentialRevision | null;
				heartbeatMs: number;
				limits?: Partial<DeliveryLimits>;
				lease?: number;
				visible?: boolean;
				credentials?: boolean;
				diagnostics?: boolean;
				/** The page declared `anonymous: true`; old runtimes ignore it and stay fail-closed. */
				anonymous?: true;
		  }
		| {
				t: "subscribe";
				c: string;
				request: WireSubscriptionRequest;
				options?: Json;
				cursor?: string;
				/**
				 * Re-registered intent after runtime loss or a scope change, sent only
				 * to a runtime whose `welcome` carried `replay: true`.
				 */
				replay?: true;
		  }
		| { t: "unsubscribe"; c: string }
		| { t: "update"; c: string; consumer?: Json }
		| { t: "ack"; c?: string; seq?: number; k?: number }
		| { t: "reconcile"; c: string }
		| {
				t: "command";
				id: string;
				request: WireCommandRequest;
				timeoutMs: number;
		  }
		| { t: "cancel"; id: string }
		| {
				t: "credentials";
				id: string;
				ok: boolean;
				credentials?: Credentials;
				error?: SerialisedError;
				revision: CredentialRevision | null;
		  }
		| { t: "revision"; revision: CredentialRevision; restart: boolean }
		| { t: "probe"; id: string; hint?: boolean }
		| { t: "renew" }
		| { t: "retry"; c?: string }
		| { t: "visibility"; visible: boolean }
		| { t: "detach" }
	);

export type DetachCode =
	| "lease-expired"
	| "attachment-expired"
	| "scope-changed"
	| "runtime-disposed";

export interface AdapterInfo {
	kind: string;
	version: number;
}

export type RuntimeMessage = Envelope &
	(
		| {
				t: "welcome";
				runtime: string;
				limits: RuntimeLimits;
				adapters: AdapterInfo[];
				lease: number;
				/** This runtime honours `subscribe.replay`; older ones omit it. */
				replay?: true;
		  }
		| {
				t: "reject";
				code: "incompatible-version";
				supported: number[];
				received: unknown;
		  }
		| { t: "startupError"; code: SpinetabErrorCode; message: string }
		| {
				t: "event";
				c: string;
				seq: number;
				kind: "next";
				data: unknown;
				eventId?: string;
				event?: string;
		  }
		| {
				t: "event";
				c: string;
				seq: number;
				k: number;
				kind: "error";
				error: SerialisedError;
		  }
		| { t: "event"; c: string; seq: number; k: number; kind: "complete" }
		| {
				t: "status";
				k: number;
				c: string | string[];
				connection: ConnectionStatus;
				repeatable?: boolean;
		  }
		| {
				t: "continuity";
				k: number;
				c: string | string[];
				continuity: Continuity;
				/** Private early-loss phase, before the next connection status. */
				pending?: boolean;
				/** Per-consumer missed counts, parallel to a batched `c`. */
				missed?: number[];
		  }
		| { t: "commandResult"; k: number; id: string; outcome: CommandOutcome }
		| {
				t: "credentialsRequest";
				k: number;
				id: string;
				scope: string;
				revision: CredentialRevision | null;
				reason: CredentialRequest["reason"];
		  }
		| { t: "probeResult"; k: number; id: string; runtime: string }
		| { t: "detached"; code: DetachCode }
		| {
				t: "error";
				k: number;
				c?: string;
				id?: string;
				code: SpinetabErrorCode;
				message: string;
				detail?: Json;
		  }
		| { t: "diagnostic"; k: number; event: DiagnosticEvent }
	);

/**
 * Port-level runtime announcement (not an attachment envelope): which runtime
 * instance now serves this port, and its accept sequence (1 for the first
 * port it accepted; diagnostic only).
 */
export interface RuntimeAnnounce {
	v: typeof BRIDGE_VERSION;
	t: "announce";
	runtime: string;
	generation: number;
}

/** Distributive omit so envelope construction keeps the union intact. */
export type WithoutEnvelope<T> = T extends unknown
	? Omit<T, "v" | "a" | "g">
	: never;

export type PageBody = WithoutEnvelope<PageMessage>;
export type RuntimeBody = WithoutEnvelope<RuntimeMessage>;

/*
 * Checks shared by both receivers. Each side's shape table and parser lives in
 * the module only that realm imports, so neither realm ships the other's:
 * `bridge-page.ts` validates runtime→page messages on the page and
 * `bridge-runtime.ts` validates page→runtime messages in the runtime.
 */

export type Shape = Record<string, unknown>;

export const str = (value: unknown): value is string =>
	typeof value === "string";
export const int = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
export const bool = (value: unknown): value is boolean =>
	typeof value === "boolean";
export const optional =
	(check: (value: unknown) => boolean) =>
	(value: unknown): boolean =>
		value === undefined || check(value);
/** A credential revision: a non-negative safe integer, or null for none. */
export const revision = (value: unknown): boolean =>
	value === null || int(value);
export const object = (value: unknown): value is Shape =>
	typeof value === "object" && value !== null && !Array.isArray(value);
export const errorRecord = (value: unknown): boolean =>
	object(value) && str(value.code) && str(value.message);

export type Validator = Record<string, (value: unknown) => boolean>;

export function hasEnvelope(value: unknown): value is Shape {
	return (
		object(value) &&
		value.v === BRIDGE_VERSION &&
		str(value.t) &&
		str(value.a) &&
		value.a.length > 0 &&
		int(value.g)
	);
}

/** Own shapes only: `t: "toString"` must not find a prototype member. */
export function shapeOf(
	shapes: Record<string, Validator>,
	type: unknown,
): Validator | undefined {
	return typeof type === "string" && Object.hasOwn(shapes, type)
		? shapes[type]
		: undefined;
}

export function matches(
	value: Shape,
	validator: Validator | undefined,
): boolean {
	if (!validator) return false;
	for (const key in validator) {
		const check = validator[key] as (item: unknown) => boolean;
		if (!check(value[key])) return false;
	}
	return true;
}
