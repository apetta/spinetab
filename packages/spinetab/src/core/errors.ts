import type { Json, SerialisedError, SpinetabErrorCode } from "./types.ts";

/**
 * Typed error with a stable `code`. Identify errors by `code`, never by
 * `instanceof`: ESM and CommonJS copies of the package may both be loaded.
 * Messages never contain payloads, credentials, headers or URL query strings.
 */
export class SpinetabError extends Error {
	readonly code: SpinetabErrorCode;
	readonly detail: Json | undefined;
	readonly retryable: boolean;

	constructor(
		code: SpinetabErrorCode,
		message: string,
		options: { detail?: Json; retryable?: boolean; cause?: unknown } = {},
	) {
		super(
			message,
			options.cause === undefined ? undefined : { cause: options.cause },
		);
		this.name = "SpinetabError";
		this.code = code;
		this.detail = options.detail;
		this.retryable = options.retryable ?? false;
	}

	/** Plain record for the bridge and adapter sinks. */
	toJSON(): SerialisedError {
		return serialiseError(this);
	}
}

/** The package's own adapter kinds; a custom adapter's kind gets the generic hint. */
const PACKAGE_KIND =
	/^(?:polling|sse|stream|websocket|graphql-(?:ws|sse)|socket-io|trpc-(?:ws|sse)|ai-sdk)$/;

/**
 * `adapter-not-registered` for `kind`, naming both remedies: the plugin's
 * `adapters` option and the worker file. The factory and entry are computed
 * from the kind so the page carries no adapter table: the camel-cased kind
 * plus `Adapter` (`graphql-ws` → `graphqlWsAdapter`) from `spinetab/<kind>/runtime`,
 * except `trpc-ws` and `trpc-sse`, which share `spinetab/trpc/runtime`.
 */
export function adapterNotRegistered(kind: string): SpinetabError {
	let message = `Adapter ${kind} is not registered. `;
	if (PACKAGE_KIND.test(kind)) {
		const factory = `${kind.replace(/-(\w)/g, (_, letter: string) => letter.toUpperCase())}Adapter`;
		const entry = kind.startsWith("trpc-") ? "trpc" : kind;
		message += `List "${kind}" in the plugin's adapters option, or add ${factory}() from spinetab/${entry}/runtime to your worker file.`;
	} else {
		message += "Add its adapter to your worker file.";
	}
	return new SpinetabError("adapter-not-registered", message, {
		detail: { adapter: kind },
	});
}

export function isSpinetabError(
	error: unknown,
	code?: SpinetabErrorCode,
): error is SpinetabError {
	if (
		typeof error !== "object" ||
		error === null ||
		(error as { name?: unknown }).name !== "SpinetabError" ||
		typeof (error as { code?: unknown }).code !== "string"
	) {
		return false;
	}
	return code === undefined || (error as SpinetabError).code === code;
}

export function serialiseError(
	error: SpinetabError | SerialisedError,
): SerialisedError {
	const record: SerialisedError = { code: error.code, message: error.message };
	if (error.detail !== undefined) record.detail = error.detail;
	if (error.retryable) record.retryable = true;
	return record;
}

export function deserialiseError(record: SerialisedError): SpinetabError {
	return new SpinetabError(record.code, record.message, {
		detail: record.detail,
		retryable: record.retryable,
	});
}

/** Wrap an unknown failure without leaking payloads into the message. */
export function toSerialisedError(
	error: unknown,
	fallbackCode: SpinetabErrorCode = "upstream-error",
): SerialisedError {
	if (isSpinetabError(error)) return serialiseError(error);
	if (
		error &&
		typeof error === "object" &&
		"code" in error &&
		"message" in error
	) {
		const candidate = error as { code: unknown; message: unknown };
		if (
			typeof candidate.code === "string" &&
			typeof candidate.message === "string"
		) {
			return {
				code: candidate.code as SpinetabErrorCode,
				message: candidate.message,
			};
		}
	}
	const message =
		error instanceof Error
			? error.message
			: typeof error === "string"
				? error
				: "Unknown error";
	return { code: fallbackCode, message };
}

/** Every `SpinetabErrorCode` (the type keeps it complete), to check a code that arrived as data. */
const ERROR_CODES: Record<SpinetabErrorCode, 1> = {
	"unsupported-option": 1,
	"invalid-endpoint": 1,
	"not-serialisable": 1,
	"limit-exceeded": 1,
	timeout: 1,
	aborted: 1,
	disposed: 1,
	"attachment-retired": 1,
	"adapter-not-registered": 1,
	"invalid-envelope": 1,
	"sharing-unavailable": 1,
	"incompatible-version": 1,
	"worker-startup-error": 1,
	"runtime-unavailable": 1,
	"not-configured": 1,
	overflow: 1,
	"message-too-large": 1,
	"event-not-serialisable": 1,
	"continuity-lost": 1,
	"credentials-timeout": 1,
	"credentials-failed": 1,
	"credentials-audience": 1,
	"credentials-rejected": 1,
	"no-credential-source": 1,
	"auth-blocked": 1,
	"scope-changed": 1,
	"retry-exhausted": 1,
	"upstream-error": 1,
	"protocol-error": 1,
	"decode-error": 1,
	"frame-too-large": 1,
	"malformed-frame": 1,
	"command-not-sent": 1,
	"command-unknown": 1,
	"command-rejected": 1,
	"subscribe-rejected": 1,
	interrupted: 1,
	"late-join-unsupported": 1,
	"cannot-resume": 1,
	"stop-unavailable": 1,
};

export function isErrorCode(value: unknown): value is SpinetabErrorCode {
	return typeof value === "string" && Object.hasOwn(ERROR_CODES, value);
}

/**
 * Where application errors about a subscription handle go: the client
 * registers each handle with its `onCallbackError`, else `env.reportError`,
 * path. The reconcile engine reads it for a failed refresh with no `onError`.
 * Keep it on the handle, non-enumerably: a module-local WeakMap cannot be
 * read by an integration loaded through the other ESM/CommonJS entry.
 */
export function registerHandleReporter(
	handle: object,
	reporter: (error: unknown) => void,
): void {
	Object.defineProperty(handle, Symbol.for("spinetab.handleReporter.v1"), {
		value: reporter,
	});
}

export function handleReporter(
	handle: object,
): ((error: unknown) => void) | undefined {
	return (handle as Record<symbol, ((error: unknown) => void) | undefined>)[
		Symbol.for("spinetab.handleReporter.v1")
	];
}

/**
 * The base each page client resolves relative endpoints against:
 * its `baseUrl` option, else the document base read at start. Registered per
 * client object by `createClientWithEnv`, so page integrations that resolve
 * their own endpoints (the AI SDK transport) use the same base. Internal: not
 * a public entry; a client from anywhere else has no entry. As with the handle
 * reporter, the non-enumerable slot works across ESM/CommonJS package copies
 * without a global registry retaining clients.
 */
export function registerClientBase(
	client: object,
	base: () => string | undefined,
): void {
	Object.defineProperty(client, Symbol.for("spinetab.clientBase.v1"), {
		value: base,
	});
}

export function clientBase(
	client: object,
): (() => string | undefined) | undefined {
	return (client as Record<symbol, (() => string | undefined) | undefined>)[
		Symbol.for("spinetab.clientBase.v1")
	];
}
