import type { Json } from "../../core/types.ts";
import {
	assertAbsoluteUrl,
	assertBoolean,
	assertInteger,
	assertJson,
	assertKnownKeys,
	assertOneOf,
	assertPlainObject,
	assertString,
	invalid,
	refuseCredentialCarriers,
	refuseUrlCredentials,
} from "../shared/validate.ts";

/**
 * Socket.IO connection options. `sharing` is required: the
 * application declares whether one server socket shared by every tab is
 * compatible with its per-socket presence and server state. `"per-tab"` gives
 * each tab its own worker-hosted socket.
 */
export interface SocketIoConnection {
	/**
	 * Server URL. As with upstream `io()`, its path is the namespace
	 * (`https://h/chat` joins `/chat`) and its origin is the Manager URI.
	 */
	url: string;
	/** Engine.IO path; default `/socket.io`. A proxy prefix goes here. */
	path?: string;
	/**
	 * Namespace; default the URL path, which is `/` for a bare origin. The path
	 * is read after URL parsing: escapes are decoded and dot segments resolved.
	 * A value that differs from a non-root URL path is refused.
	 */
	namespace?: string;
	transports?: Array<"polling" | "websocket" | "webtransport">;
	upgrade?: boolean;
	withCredentials?: boolean;
	/** Non-secret static namespace auth; `credentials.auth` is merged over it. */
	auth?: Record<string, Json>;
	/** Non-secret query parameters. Credentials never go into the query. */
	query?: Record<string, string>;
	/** Acknowledgement timeout for commands and joins; default 10 000 ms. */
	ackTimeoutMs?: number;
	/** Finite Manager budget; default 10. */
	reconnectionAttempts?: number;
	reconnectionDelayMs?: number;
	reconnectionDelayMaxMs?: number;
	/** Connection timeout; default 20 000 ms (upstream). */
	timeoutMs?: number;
	sharing: "shared" | "per-tab";
	/** Declare that the namespace needs no credentials. */
	anonymous?: boolean;
	/** Set by the page builder for `per-tab` sharing; one socket per tab. */
	tab?: string;
	/** Set by the page builder for a membership without a route: own socket. */
	membership?: string;
}

export interface SocketIoEmitSpec {
	event: string;
	args?: Json[];
}

/** One listener identity: event plus optional membership key. */
export interface SocketIoSubscriptionSpec {
	event: string;
	/** Membership key (for example a room); empty means namespace-wide. */
	membership?: string;
	/** Name of a worker-side route in `socketIoAdapter({ routes })`. */
	route?: string;
	/** Idempotent join emitted with an acknowledgement once per key and session; one that times out is compensated with a leave once the key has no consumers. */
	join?: SocketIoEmitSpec;
	/** Emitted after the last consumer of the key leaves, once the key's joins are acknowledged or time out; a leave lost or timed out is sent once more after a recovered reconnect; failures are diagnostics. */
	leave?: SocketIoEmitSpec;
}

export interface SocketIoCommand {
	event: string;
	args?: Json[];
	/**
	 * `true` (default): wait for an acknowledgement and resolve with its first
	 * argument. `"error-first"`: a non-null first argument rejects. `false`:
	 * fire-and-forget, outcome `sent`.
	 */
	ack?: boolean | "error-first";
	/** May be dropped when the transport is not writable; implies `ack: false`. */
	volatile?: boolean;
}

export const SOCKET_IO_DEFAULTS = Object.freeze({
	path: "/socket.io",
	namespace: "/",
	ackTimeoutMs: 10_000,
	reconnectionAttempts: 10,
});

const KEYS = [
	"url",
	"path",
	"namespace",
	"transports",
	"upgrade",
	"withCredentials",
	"auth",
	"query",
	"ackTimeoutMs",
	"reconnectionAttempts",
	"reconnectionDelayMs",
	"reconnectionDelayMaxMs",
	"timeoutMs",
	"sharing",
	"anonymous",
	"tab",
	"membership",
] as const;

/** Upstream options Spinetab owns or refuses, with the reason. */
const REFUSED: Record<string, string> = {
	retries:
		"upstream retries re-send emits (at-least-once); commands are emitted at most once.",
	forceNew: "Spinetab creates one Manager per connection identity itself.",
	multiplex: "Spinetab creates one Manager per connection identity itself.",
	autoConnect: "Spinetab controls when sockets connect.",
	extraHeaders:
		"extra headers reach polling only; pass credentials through credentials.auth.",
	reconnection: "the Manager loop owns reconnection; set reconnectionAttempts.",
};

const RESERVED_EVENTS = new Set([
	"connect",
	"connect_error",
	"disconnect",
	"disconnecting",
	"newListener",
	"removeListener",
]);

export function validateSocketIoConnection(
	spec: unknown,
	options: { absolute: boolean },
	path = "connection",
): asserts spec is SocketIoConnection {
	assertPlainObject(spec, path);
	for (const key of Object.keys(spec)) {
		const reason = REFUSED[key];
		if (reason) throw invalid(`${path}.${key}`, reason);
	}
	if (spec.sharing === undefined) {
		throw invalid(
			`${path}.sharing`,
			'declare "shared" (one socket for every tab) or "per-tab" (one socket per tab).',
		);
	}
	assertKnownKeys(spec, KEYS, path);
	assertString(spec.url, `${path}.url`, { nonEmpty: true });
	if (options.absolute) {
		assertAbsoluteUrl(spec.url, `${path}.url`, [
			"http:",
			"https:",
			"ws:",
			"wss:",
		]);
	}
	assertString(spec.path, `${path}.path`, { optional: true, nonEmpty: true });
	if (spec.namespace !== undefined) {
		assertString(spec.namespace, `${path}.namespace`);
		if (!(spec.namespace as string).startsWith("/")) {
			throw invalid(`${path}.namespace`, 'must start with "/".');
		}
		const named = urlNamespace(spec.url as string);
		if (named !== undefined && named !== "/" && named !== spec.namespace) {
			throw invalid(
				`${path}.namespace`,
				`differs from the path of ${path}.url. Set only one; a proxy prefix goes in ${path}.path.`,
			);
		}
	}
	if (spec.transports !== undefined) {
		if (!Array.isArray(spec.transports) || spec.transports.length === 0) {
			throw invalid(`${path}.transports`, "must be a non-empty array.");
		}
		spec.transports.forEach((transport, index) => {
			assertOneOf(
				transport,
				["polling", "websocket", "webtransport"],
				`${path}.transports[${index}]`,
			);
		});
	}
	assertBoolean(spec.upgrade, `${path}.upgrade`);
	assertBoolean(spec.withCredentials, `${path}.withCredentials`);
	refuseUrlCredentials(spec.url, `${path}.url`);
	if (spec.auth !== undefined) {
		assertPlainObject(spec.auth, `${path}.auth`);
		assertJson(spec.auth, `${path}.auth`);
		refuseCredentialCarriers(spec.auth, `${path}.auth`);
	}
	if (spec.query !== undefined) {
		assertPlainObject(spec.query, `${path}.query`);
		for (const [key, value] of Object.entries(spec.query)) {
			assertString(value, `${path}.query.${key}`);
		}
		refuseCredentialCarriers(spec.query, `${path}.query`);
	}
	assertInteger(spec.ackTimeoutMs, `${path}.ackTimeoutMs`, {
		min: 1,
		max: 120_000,
	});
	assertInteger(spec.reconnectionAttempts, `${path}.reconnectionAttempts`, {
		min: 1,
		max: 1_000,
	});
	assertInteger(spec.reconnectionDelayMs, `${path}.reconnectionDelayMs`, {
		min: 1,
		max: 600_000,
	});
	assertInteger(spec.reconnectionDelayMaxMs, `${path}.reconnectionDelayMaxMs`, {
		min: 1,
		max: 600_000,
	});
	assertInteger(spec.timeoutMs, `${path}.timeoutMs`, { min: 1, max: 600_000 });
	assertOneOf(spec.sharing, ["shared", "per-tab"], `${path}.sharing`);
	assertBoolean(spec.anonymous, `${path}.anonymous`);
	assertString(spec.tab, `${path}.tab`, { optional: true, nonEmpty: true });
	if (spec.sharing === "per-tab" && options.absolute && !spec.tab) {
		throw invalid(`${path}.tab`, "per-tab sockets need the builder's tab id.");
	}
	assertString(spec.membership, `${path}.membership`, { optional: true });
}

/**
 * The namespace a URL names by its path, as upstream `io()` reads it, or
 * `undefined` for a document-relative URL, which only the page client can
 * resolve (the runtime then checks the resolved URL).
 */
export function urlNamespace(url: string): string | undefined {
	if (!/^([a-z][a-z\d+.-]*:)?\//i.test(url)) return undefined;
	try {
		return pathNamespace(new URL(url, "http://h").pathname);
	} catch {
		return undefined;
	}
}

/**
 * A parsed URL path as the namespace it names. Upstream keeps the raw path,
 * but the runtime only sees the page's resolved href, so the escapes the URL
 * parser added (`/%C3%A4` for `/ä`) are decoded; reserved escapes such as
 * `%2F` stay. Dot segments are already resolved. A malformed escape leaves
 * the path as parsed.
 */
export function pathNamespace(pathname: string): string {
	try {
		return decodeURI(pathname);
	} catch {
		return pathname;
	}
}

function validateEmit(value: unknown, path: string): void {
	assertPlainObject(value, path);
	assertKnownKeys(value, ["event", "args"], path);
	validateEventName(value.event, `${path}.event`);
	if (value.args !== undefined) {
		if (!Array.isArray(value.args))
			throw invalid(`${path}.args`, "must be an array.");
		assertJson(value.args, `${path}.args`);
	}
}

function validateEventName(value: unknown, path: string): void {
	assertString(value, path, { nonEmpty: true });
	if (RESERVED_EVENTS.has(value as string)) {
		throw invalid(path, "reserved Socket.IO events are status, not data.");
	}
}

export function validateSocketIoSubscription(
	spec: unknown,
	routes: readonly string[] | undefined,
	path = "subscription",
): asserts spec is SocketIoSubscriptionSpec {
	assertPlainObject(spec, path);
	assertKnownKeys(
		spec,
		["event", "membership", "route", "join", "leave"],
		path,
	);
	validateEventName(spec.event, `${path}.event`);
	assertString(spec.membership, `${path}.membership`, { optional: true });
	assertString(spec.route, `${path}.route`, { optional: true, nonEmpty: true });
	if (spec.route !== undefined) {
		if (spec.membership === undefined) {
			throw invalid(`${path}.route`, "a route needs a membership key.");
		}
		if (routes && !routes.includes(spec.route as string)) {
			throw invalid(
				`${path}.route`,
				"is not registered in socketIoAdapter({ routes }).",
			);
		}
	}
	if (spec.join !== undefined) validateEmit(spec.join, `${path}.join`);
	if (spec.leave !== undefined) validateEmit(spec.leave, `${path}.leave`);
	if ((spec.join || spec.leave) && spec.membership === undefined) {
		throw invalid(`${path}.join`, "join and leave need a membership key.");
	}
}

export function validateSocketIoCommand(
	spec: unknown,
	path = "command",
): asserts spec is SocketIoCommand {
	assertPlainObject(spec, path);
	assertKnownKeys(spec, ["event", "args", "ack", "volatile"], path);
	validateEventName(spec.event, `${path}.event`);
	if (spec.args !== undefined) {
		if (!Array.isArray(spec.args))
			throw invalid(`${path}.args`, "must be an array.");
		assertJson(spec.args, `${path}.args`);
	}
	if (
		spec.ack !== undefined &&
		spec.ack !== true &&
		spec.ack !== false &&
		spec.ack !== "error-first"
	) {
		throw invalid(`${path}.ack`, 'must be true, false or "error-first".');
	}
	assertBoolean(spec.volatile, `${path}.volatile`);
	if (spec.volatile && spec.ack !== undefined && spec.ack !== false) {
		throw invalid(
			`${path}.volatile`,
			"volatile emits cannot wait for an acknowledgement.",
		);
	}
}
