import type {
	TimedEntry,
	TimedStatusEntry,
} from "../../fixtures/harness/src/bench/timed.ts";

/**
 * Informational recovery phases for return trials,
 * derived from the bench's timed log of adapter status reports. They are
 * never gates: rows, targets and budgets come from the existing
 * health-start, first-event and restored measurements only.
 *
 * Status semantics, checked against the installed code:
 *
 * - detection: the first `reconnecting` status WITHOUT an `attempt` field.
 * graphql-ws reports one when its pong watchdog fires (`heartbeat-timeout`)
 * and when `shouldRetry` accepts a close (`code: "close:<n>"`).
 * - retry start: the first `reconnecting` WITH an `attempt` field after
 * detection. graphql-ws emits `connecting(isRetry)` only after awaiting
 * `retryWait`, and the adapter reports it with the attempt count.
 * - ack: the first `connected` after retry start (or after detection when no
 * retry start was observed; `ackAfter` says which). graphql-ws reports it
 * after `connection_ack`.
 *
 * Adapters that report an attempt on every `reconnecting` status (the native
 * WebSocket adapter does so when it schedules a retry) do not distinguish
 * detection from retry scheduling, so those phases stay null with a note.
 * Every value is milliseconds relative to `t0` on the page clock (negative
 * when the phase preceded the return hint); an unobservable phase is null
 * with a note, never a fabricated zero.
 */

export const PHASES_LABEL = "derived, informational";

export interface PhaseInput {
	/** Confirmed return, page clock. */
	t0: number;
	/** Worker → page calibration: page = remote − offset. */
	offset: number;
	/** Raw status log (worker clock), all adapters. */
	statuses: readonly TimedStatusEntry[];
	/** Raw probe log (worker clock). */
	probes: readonly TimedEntry[];
	/** First delivery at or after t0, page clock; NaN when none. */
	firstEvent: number;
	/** Every topic delivering at or after t0, page clock; NaN when not. */
	restored: number;
	/** Adapter kind to derive phases for, e.g. "graphql-ws" or "websocket". */
	adapter: string;
	/** Fault injection, page clock; statuses before it are stale. Default t0. */
	faultAt?: number;
}

/** A status on the page clock, relative to t0. */
export interface CalibratedStatus {
	ms: number;
	state: string;
	reason?: string;
	attempt?: number;
	code?: string | number;
}

export interface Phases {
	label: typeof PHASES_LABEL;
	detection: number | null;
	retryStart: number | null;
	ack: number | null;
	/** Which phase the ack follows; null when no ack was derived. */
	ackAfter: "retry-start" | "detection" | null;
	healthStart: number | null;
	firstEvent: number | null;
	restored: number | null;
	/** One note per null phase, plus context (stale or preceding t0). */
	notes: string[];
	/** Statuses of this adapter before the window start (faultAt or t0). */
	stale: number;
	/** Statuses of other adapters, excluded. */
	otherAdapter: number;
	/** This adapter's statuses in the window, in log order. */
	statuses: CalibratedStatus[];
}

const hasAttempt = (status: CalibratedStatus) => status.attempt !== undefined;

function calibrate(
	entry: TimedStatusEntry,
	offset: number,
	t0: number,
): CalibratedStatus {
	const status: CalibratedStatus = {
		ms: entry.at - offset - t0,
		state: entry.state,
	};
	if (entry.reason !== undefined) status.reason = entry.reason;
	if (entry.attempt !== undefined) status.attempt = entry.attempt;
	if (entry.code !== undefined) status.code = entry.code;
	return status;
}

export function derivePhases(input: PhaseInput): Phases {
	const { t0, offset } = input;
	const from = input.faultAt ?? t0;
	const notes: string[] = [];
	const own = input.statuses.filter((entry) => entry.adapter === input.adapter);
	const otherAdapter = input.statuses.length - own.length;
	const statuses: CalibratedStatus[] = [];
	let stale = 0;
	for (const entry of own) {
		if (entry.at - offset < from) stale += 1;
		else statuses.push(calibrate(entry, offset, t0));
	}
	if (stale > 0) {
		notes.push(
			`${stale} status(es) precede the window start (${input.faultAt === undefined ? "t0" : "faultAt"}) and are ignored`,
		);
	}

	const detectionIndex = statuses.findIndex(
		(status) => status.state === "reconnecting" && !hasAttempt(status),
	);
	let detection: number | null = null;
	if (detectionIndex >= 0) {
		detection = statuses[detectionIndex]?.ms ?? null;
	} else if (!statuses.some((status) => status.state === "reconnecting")) {
		notes.push("detection: no reconnecting status observed");
	} else {
		notes.push(
			"detection: adapter reports an attempt field on every reconnecting status, so detection is not distinguishable from retry scheduling",
		);
	}

	let retryIndex = -1;
	let retryStart: number | null = null;
	if (detectionIndex < 0) {
		notes.push("retryStart: no detection observed");
	} else {
		retryIndex = statuses.findIndex(
			(status, index) =>
				index > detectionIndex &&
				status.state === "reconnecting" &&
				hasAttempt(status),
		);
		if (retryIndex >= 0) retryStart = statuses[retryIndex]?.ms ?? null;
		else
			notes.push(
				"retryStart: adapter reports no attempt field after detection",
			);
	}

	let ack: number | null = null;
	let ackAfter: Phases["ackAfter"] = null;
	const baseIndex = retryIndex >= 0 ? retryIndex : detectionIndex;
	if (baseIndex < 0) {
		const unattributed = statuses.some(
			(status) => status.state === "connected",
		);
		notes.push(
			unattributed
				? "ack: no detection observed; a connected status without a preceding reconnecting status is not attributed"
				: "ack: no detection observed",
		);
	} else {
		const ackIndex = statuses.findIndex(
			(status, index) => index > baseIndex && status.state === "connected",
		);
		const after = retryIndex >= 0 ? "retry-start" : "detection";
		if (ackIndex >= 0) {
			ack = statuses[ackIndex]?.ms ?? null;
			ackAfter = after;
		} else {
			notes.push(`ack: no connected status after ${after}`);
		}
	}

	// Same rule as return.perf.ts: the first probe (any adapter) at or after t0.
	const probe = input.probes
		.map((entry) => entry.at - offset)
		.find((at) => at >= t0);
	const healthStart = probe === undefined ? null : probe - t0;
	if (healthStart === null) {
		notes.push("healthStart: no adapter probe at or after t0");
	}
	const firstEvent = Number.isFinite(input.firstEvent)
		? input.firstEvent - t0
		: null;
	if (firstEvent === null) {
		notes.push("firstEvent: no delivery observed at or after t0");
	}
	const restored = Number.isFinite(input.restored) ? input.restored - t0 : null;
	if (restored === null) {
		notes.push("restored: not every topic delivered at or after t0");
	}

	for (const [name, value] of [
		["detection", detection],
		["retryStart", retryStart],
		["ack", ack],
	] as const) {
		if (value !== null && value < 0) {
			notes.push(`${name}: precedes t0 (before the return hint)`);
		}
	}

	return {
		label: PHASES_LABEL,
		detection,
		retryStart,
		ack,
		ackAfter,
		healthStart,
		firstEvent,
		restored,
		notes,
		stale,
		otherAdapter,
		statuses,
	};
}
