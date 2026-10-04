import type {
	ConnectionContext,
	SubscriptionSink,
} from "../../../../src/core/adapter.ts";
import { DEFAULT_LIMITS } from "../../../../src/core/limits.ts";
import type {
	ConnectionStatus,
	Credentials,
	RuntimeLimits,
	SerialisedError,
} from "../../../../src/core/types.ts";

/** Minimal `ConnectionContext` for driving an adapter's `connect()` directly. */
export function fakeContext(
	options: {
		limits?: Partial<RuntimeLimits>;
		credentials?: () => Credentials | Promise<Credentials>;
		credentialError?: SerialisedError;
	} = {},
) {
	const controller = new AbortController();
	const statuses: Array<Omit<ConnectionStatus, "since">> = [];
	let rejected = 0;
	let credentialRequests = 0;
	/** `[reason, url]` of every `credentials()` call. */
	const credentialCalls: Array<[string, string | undefined]> = [];
	/** The grant passed to every `rejectCredentials()` call. */
	const rejectedWith: Array<Credentials | undefined> = [];
	const ctx: ConnectionContext = {
		scope: "",
		key: "test",
		limits: { ...DEFAULT_LIMITS, ...options.limits },
		signal: controller.signal,
		async credentials(reason, url) {
			credentialRequests += 1;
			credentialCalls.push([reason, url]);
			if (options.credentialError) throw options.credentialError;
			if (!options.credentials) {
				throw {
					code: "no-credential-source",
					message: "No credential source",
				};
			}
			return options.credentials();
		},
		rejectCredentials(credentials) {
			rejected += 1;
			rejectedWith.push(credentials);
		},
		setStatus(status) {
			statuses.push(status);
		},
		diagnostic() {},
		now: () => performance.now(),
	};
	return {
		ctx,
		controller,
		statuses,
		credentialCalls,
		rejectedWith,
		get rejected() {
			return rejected;
		},
		get credentialRequests() {
			return credentialRequests;
		},
	};
}

export interface RecordedSink<E> extends SubscriptionSink<E | E[]> {
	/** Events in order; batches (arrays) are flattened into their elements. */
	events: E[];
	/** Number of `next` calls (a batch counts once). */
	batches: number;
	errors: SerialisedError[];
	completed: number;
	startedAt: number | undefined;
	done: Promise<void>;
}

/**
 * Sink that records everything and resolves `done` on error or completion.
 * AI stream events are batches of chunks; they are recorded flattened.
 */
export function recordingSink<E>(): RecordedSink<E> {
	let resolveDone!: () => void;
	const done = new Promise<void>((resolve) => {
		resolveDone = resolve;
	});
	const sink: RecordedSink<E> = {
		events: [],
		batches: 0,
		errors: [],
		completed: 0,
		startedAt: undefined,
		done,
		next(event) {
			sink.batches += 1;
			if (Array.isArray(event)) sink.events.push(...event);
			else sink.events.push(event);
		},
		error(error) {
			sink.errors.push(error);
			resolveDone();
		},
		complete() {
			sink.completed += 1;
			resolveDone();
		},
		continuity() {},
		started() {
			sink.startedAt ??= sink.events.length;
		},
	};
	return sink;
}

export async function fixture(origin: string) {
	const post = async (path: string, body: unknown) => {
		const response = await fetch(`${origin}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		await response.text();
	};
	return {
		reset: () => post("/__fixture/reset", {}),
		fault: (action: string, value: unknown) =>
			post("/__fixture/fault", { target: "ai", action, value }),
		async counters() {
			const response = await fetch(`${origin}/__fixture/counters`);
			const all = (await response.json()) as { ai: AiCounters };
			return all.ai;
		},
	};
}

export interface AiCounters {
	generations: number;
	resumes: number;
	stops: number;
	active: number;
	generationIds: string[];
	stopRequests: Array<{ chatId: string; generationId: string | null }>;
	resumeStatuses: number[];
	startHeaders: Array<{ authorization: string | null; custom: string | null }>;
	clientDisconnects: number;
}

export async function waitFor(
	condition: () => boolean | Promise<boolean>,
	timeoutMs = 5_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await condition())) {
		if (Date.now() > deadline) throw new Error("waitFor timed out");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
