import { createServer } from "node:net";
import { inject } from "vitest";
import type {
	ConnectionContext,
	SubscriptionSink,
} from "../../../src/core/adapter.ts";
import { SpinetabError } from "../../../src/core/errors.ts";
import { DEFAULT_LIMITS } from "../../../src/core/limits.ts";
import type {
	ConnectionStatus,
	ContinuityReason,
	CredentialRequest,
	Credentials,
	DiagnosticEvent,
	RuntimeLimits,
	SerialisedError,
} from "../../../src/core/types.ts";

/** The fake broker rejects a previously rejected revision until a newer grant is supplied. Rejection applies only to a grant this context handed out. */

export function primaryOrigin(): string {
	return inject("fixtureOrigins")[0];
}

export function wsOrigin(origin = primaryOrigin()): string {
	return origin.replace(/^http/, "ws");
}

let tagCounter = 0;
/** Unique, hyphen-free tag/scope so parallel files never share counters. */
export function uniqueTag(prefix: string): string {
	tagCounter += 1;
	return `${prefix}${process.pid.toString(36)}${Date.now().toString(36)}${tagCounter}`;
}

export async function readCounters<T = Record<string, unknown>>(
	name: string,
	origin = primaryOrigin(),
): Promise<T> {
	const response = await fetch(`${origin}/__fixture/counters`);
	const all = (await response.json()) as Record<string, T>;
	return all[name] as T;
}

export async function setFault(
	target: string,
	action: string,
	value: unknown = true,
	origin = primaryOrigin(),
): Promise<void> {
	await fetch(`${origin}/__fixture/fault`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ target, action, value }),
	});
}

export async function clearFault(
	target: string,
	action: string,
	origin = primaryOrigin(),
): Promise<void> {
	await setFault(target, action, false, origin);
}

export async function waitFor<T>(
	check: () => T | Promise<T>,
	options: { timeout?: number; interval?: number; message?: string } = {},
): Promise<NonNullable<T>> {
	const deadline = Date.now() + (options.timeout ?? 8_000);
	let last: T | undefined;
	while (Date.now() < deadline) {
		last = await check();
		if (last) return last as NonNullable<T>;
		await sleep(options.interval ?? 20);
	}
	throw new Error(
		`waitFor timed out${options.message ? `: ${options.message}` : ""} (last: ${JSON.stringify(last)})`,
	);
}

export const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface TestContext {
	ctx: ConnectionContext;
	statuses: ConnectionStatus[];
	requests: CredentialRequest["reason"][];
	diagnostics: Array<Omit<DiagnosticEvent, "at" | "realm">>;
	rejections: number[];
	/** Every `rejectCredentials` argument, in order. */
	rejectCalls: Array<Credentials | undefined>;
	/** The URL passed with each credential request. */
	urls: Array<string | undefined>;
	revision(): number;
	setRevision(revision: number): void;
	lastStatus(): ConnectionStatus | undefined;
	hasStatus(
		state: ConnectionStatus["state"],
		extra?: Partial<ConnectionStatus>,
	): boolean;
	abort(): void;
}

export function createTestContext(
	options: {
		scope?: string;
		/** Credentials for a revision; omit for "no credential source". */
		credentials?: (revision: number) => Credentials | Promise<Credentials>;
		limits?: Partial<RuntimeLimits>;
		key?: string;
		/** Executable-time clock; unit tests pass `Date.now` under fake timers. */
		now?: () => number;
		/** Whether a URL is inside the credential audience; default every URL. */
		audience?: (url: string | undefined) => boolean;
	} = {},
): TestContext {
	const statuses: ConnectionStatus[] = [];
	const requests: CredentialRequest["reason"][] = [];
	const diagnostics: TestContext["diagnostics"] = [];
	const rejections: number[] = [];
	const rejectCalls: Array<Credentials | undefined> = [];
	const urls: Array<string | undefined> = [];
	const rejected = new Set<number>();
	const grants = new WeakMap<object, number>();
	const controller = new AbortController();
	let revision = 1;
	const ctx: ConnectionContext = {
		scope: options.scope ?? "",
		key: options.key ?? "test-connection",
		limits: { ...DEFAULT_LIMITS, ...options.limits },
		signal: controller.signal,
		async credentials(reason, url) {
			requests.push(reason);
			urls.push(url);
			if (options.audience && !options.audience(url)) {
				throw new SpinetabError(
					"credentials-audience",
					"The URL is outside the worker's credential audience.",
				);
			}
			if (!options.credentials) {
				throw new SpinetabError(
					"no-credential-source",
					"No page in this scope supplies credentials.",
				);
			}
			if (rejected.has(revision)) {
				throw new SpinetabError(
					"credentials-rejected",
					"The current credential revision was rejected.",
				);
			}
			const asked = revision;
			const grant = await options.credentials(asked);
			if (grant && typeof grant === "object") grants.set(grant, asked);
			return grant;
		},
		rejectCredentials(credentials) {
			rejectCalls.push(credentials);
			const grantRevision =
				credentials === undefined ? undefined : grants.get(credentials);
			if (grantRevision === undefined || !carriesMaterial(credentials)) return;
			rejections.push(grantRevision);
			rejected.add(grantRevision);
		},
		setStatus(status) {
			statuses.push({ ...status, since: performance.now() });
		},
		diagnostic(event) {
			diagnostics.push(event);
		},
		now: options.now ?? (() => performance.now()),
	};
	return {
		ctx,
		statuses,
		requests,
		diagnostics,
		rejections,
		rejectCalls,
		urls,
		revision: () => revision,
		setRevision(next) {
			revision = next;
		},
		lastStatus: () => statuses.at(-1),
		hasStatus(state, extra = {}) {
			return statuses.some(
				(status) =>
					status.state === state &&
					Object.entries(extra).every(
						([key, value]) => status[key as keyof ConnectionStatus] === value,
					),
			);
		},
		abort: () => controller.abort(),
	};
}

/** Whether a grant carries any provider material in a documented channel. */
function carriesMaterial(credentials: Credentials | undefined): boolean {
	if (!credentials) return false;
	return (["headers", "connectionParams", "auth"] as const).some((key) => {
		const value = credentials[key];
		return (
			typeof value === "object" &&
			value !== null &&
			Object.keys(value).length > 0
		);
	});
}

export interface RecordingSink<E> {
	sink: SubscriptionSink<E>;
	events: E[];
	metas: Array<{ eventId?: string } | undefined>;
	errors: SerialisedError[];
	completions: number;
	continuity: Array<{ reason: ContinuityReason; cursor?: string }>;
	started: number;
	/** Every call in order, for sequence assertions. */
	log: string[];
}

export function createRecordingSink<E>(): RecordingSink<E> {
	const record: RecordingSink<E> = {
		events: [],
		metas: [],
		errors: [],
		completions: 0,
		continuity: [],
		started: 0,
		log: [],
		sink: {
			next(event, meta) {
				record.events.push(event);
				record.metas.push(meta);
				record.log.push("next");
			},
			error(error) {
				record.errors.push(error);
				record.log.push(`error:${error.code}`);
			},
			complete() {
				record.completions += 1;
				record.log.push("complete");
			},
			continuity(reason, detail) {
				record.continuity.push(
					detail?.cursor === undefined
						? { reason }
						: { reason, cursor: detail.cursor },
				);
				record.log.push(`continuity:${reason}`);
			},
			started() {
				record.started += 1;
			},
		},
	};
	return record;
}

/** Fast upstream backoff for tests (production keeps upstream defaults). */
export const fastRetry =
	(ms = 30) =>
	async () => {
		await sleep(ms);
	};

/**
 * A local TCP port with nothing listening. Avoid fixed ports such as 9:
 * they are on the Fetch "bad ports" list, so undici fails them before any
 * listener can observe the error.
 */
export async function closedPort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return port;
}
