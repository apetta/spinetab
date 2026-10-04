import type {
	AdapterConnection,
	AnyRuntimeAdapter,
	ConnectionContext,
	SubscriptionSink,
} from "spinetab/runtime";
import { RING, readEvent, TOPICS } from "./event";

/**
 * Runtime-realm timing. Wraps each runtime
 * adapter as `{...adapter, connect }` and each connection with explicit
 * forwarding (connections are class instances), recording:
 *
 * - receipt: `performance.timeOrigin + performance.now()` when the adapter
 * hands an event to the runtime (`sink.next`), before forwarding; upstream
 * client parsing is therefore excluded (it belongs to the upstream baseline)
 * - `probe()` calls: the runtime-side start of a coordinated health check
 * - `connect()` calls and adapter continuity reports
 * - adapter status reports (`ctx.setStatus`): state, reason, attempt and code
 * only, forwarded unchanged; return trials derive informational recovery
 * phases from them (tests/performance/lib/phases.ts)
 *
 * Rings are preallocated at import, before any baseline.
 */

export const receiptAt = new Float64Array(TOPICS * RING);
export const receiptSeq = new Int32Array(TOPICS * RING).fill(-1);

export interface TimedEntry {
	at: number;
	adapter: string;
	detail?: string;
}

/** One adapter `setStatus` report; no payloads or credentials. */
export interface TimedStatusEntry {
	at: number;
	adapter: string;
	state: string;
	reason?: string;
	attempt?: number;
	code?: string | number;
}

const LOG_LIMIT = 1_000;
const probes: TimedEntry[] = [];
const connects: TimedEntry[] = [];
const continuity: TimedEntry[] = [];
const statuses: TimedStatusEntry[] = [];
let received = 0;
let firstAfter = Number.NaN;
let armedAt = Number.POSITIVE_INFINITY;

const stamp = () => performance.timeOrigin + performance.now();

function push<T>(log: T[], entry: T): void {
	log.push(entry);
	if (log.length > LOG_LIMIT) log.shift();
}

function record(event: unknown, at: number): void {
	received += 1;
	if (at >= armedAt && Number.isNaN(firstAfter)) firstAfter = at;
	const key = readEvent(event);
	if (!key || key.topic < 0 || key.topic >= TOPICS) return;
	const slot = key.topic * RING + (key.seq % RING);
	receiptAt[slot] = at;
	receiptSeq[slot] = key.seq;
}

function timedSink<E>(sink: SubscriptionSink<E>, adapter: string) {
	const wrapped: SubscriptionSink<E> = {
		next(event, meta) {
			record(event, stamp());
			sink.next(event, meta);
		},
		error(error) {
			push(continuity, { at: stamp(), adapter, detail: `error:${error.code}` });
			sink.error(error);
		},
		complete() {
			sink.complete();
		},
		continuity(reason, detail) {
			push(continuity, { at: stamp(), adapter, detail: reason });
			sink.continuity(reason, detail);
		},
		started() {
			sink.started();
		},
	};
	return wrapped;
}

function timedConnection(
	// biome-ignore lint/suspicious/noExplicitAny: adapters are heterogeneous
	connection: AdapterConnection<any, any, any, any, any>,
	adapter: string,
	// biome-ignore lint/suspicious/noExplicitAny: adapters are heterogeneous
): AdapterConnection<any, any, any, any, any> {
	// biome-ignore lint/suspicious/noExplicitAny: adapters are heterogeneous
	const wrapped: AdapterConnection<any, any, any, any, any> = {
		subscribe: (spec, sink, options) =>
			connection.subscribe(spec, timedSink(sink, adapter), options),
		dispose: () => connection.dispose(),
	};
	if (connection.command) {
		const command = connection.command.bind(connection);
		wrapped.command = (payload, options) => command(payload, options);
	}
	if (connection.probe) {
		const probe = connection.probe.bind(connection);
		wrapped.probe = () => {
			push(probes, { at: stamp(), adapter });
			probe();
		};
	}
	if (connection.retry) {
		const retry = connection.retry.bind(connection);
		wrapped.retry = () => retry();
	}
	if (connection.rotate) {
		const rotate = connection.rotate.bind(connection);
		wrapped.rotate = () => rotate();
	}
	return wrapped;
}

/**
 * Forwards every context member explicitly (a new member fails the type
 * check instead of being dropped) and records each status report before
 * forwarding it unchanged.
 */
function timedContext(
	ctx: ConnectionContext,
	adapter: string,
): ConnectionContext {
	return {
		scope: ctx.scope,
		key: ctx.key,
		limits: ctx.limits,
		signal: ctx.signal,
		// Forward every argument as given: the URL the adapter judged and
		// the attached grant, or no argument at all.
		credentials: (...args: Parameters<ConnectionContext["credentials"]>) =>
			ctx.credentials(...args),
		rejectCredentials: (
			...attached: Parameters<ConnectionContext["rejectCredentials"]>
		) => ctx.rejectCredentials(...attached),
		setStatus: (status) => {
			const entry: TimedStatusEntry = {
				at: stamp(),
				adapter,
				state: status.state,
			};
			if (status.reason !== undefined) entry.reason = status.reason;
			if (status.attempt !== undefined) entry.attempt = status.attempt;
			if (status.code !== undefined) entry.code = status.code;
			push(statuses, entry);
			ctx.setStatus(status);
		},
		diagnostic: (event) => ctx.diagnostic(event),
		now: () => ctx.now(),
	};
}

export function timed(adapter: AnyRuntimeAdapter): AnyRuntimeAdapter {
	return {
		...adapter,
		connect(spec: unknown, ctx: ConnectionContext) {
			push(connects, { at: stamp(), adapter: adapter.kind });
			return timedConnection(
				adapter.connect(spec, timedContext(ctx, adapter.kind)),
				adapter.kind,
			);
		},
	};
}

export interface TimedState {
	received: number;
	probes: TimedEntry[];
	connects: TimedEntry[];
	continuity: TimedEntry[];
	statuses: TimedStatusEntry[];
	/** First receipt at or after `arm(at)`; NaN when none yet. */
	firstAfter: number;
}

/** Start watching for the first receipt at or after `at` (return-to-service). */
export function arm(at: number): void {
	armedAt = at;
	firstAfter = Number.NaN;
}

export function timedState(): TimedState {
	return {
		received,
		probes: [...probes],
		connects: [...connects],
		continuity: [...continuity],
		statuses: [...statuses],
		firstAfter,
	};
}

export function resetTimed(): void {
	receiptAt.fill(0);
	receiptSeq.fill(-1);
	probes.length = 0;
	connects.length = 0;
	continuity.length = 0;
	statuses.length = 0;
	received = 0;
	firstAfter = Number.NaN;
	armedAt = Number.POSITIVE_INFINITY;
}
