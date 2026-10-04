import type { TestInfo } from "@playwright/test";
import { DEFAULT_LIMITS } from "../../../src/core/limits.ts";
import type { TopicSummary } from "../../fixtures/harness/src/bench/types.ts";
import { CONTROL_BOUNDS } from "./control.ts";
import { type Metrics, type RawRecord, writeRaw } from "./evidence.ts";

/**
 * Metric bookkeeping shared by the scenarios. Only finite numbers enter
 * `metrics`; anything else is recorded in `notMeasured` with the reason, so
 * a run never reports NaN as a value.
 */
export class Recorded {
	readonly metrics: Metrics = {};
	readonly notMeasured: Record<string, string> = {};

	put(id: string, value: number, reasonIfMissing = "no value"): void {
		if (Number.isFinite(value)) this.metrics[id] = value;
		else this.notMeasured[id] = reasonIfMissing;
	}

	trials(id: string, values: number[]): void {
		// Non-finite trials stay in the array (as null in JSON) so the row fails.
		this.metrics[id] = values.map((value) =>
			Number.isFinite(value) ? value : Number.NaN,
		);
	}

	skip(id: string, reason: string): void {
		this.notMeasured[id] = reason;
	}
}

export interface RecordMeta {
	scenario: string;
	config: string;
	/** Row ids this run must produce; a failed run records them as failed. */
	expected: string[];
}

/**
 * A failed run: every expected row without a value becomes null (NaN), which
 * fails the row in aggregate.ts, with the failure message as its reason. Rows
 * that already hold a value keep it; ids that should stay explicitly not
 * measured (`skip`) must therefore not be listed as expected.
 */
export function markFailed(
	out: Recorded,
	detail: Record<string, unknown>,
	expected: readonly string[],
	failure: unknown,
): void {
	const message = String((failure as Error)?.message ?? failure).slice(
		0,
		2_000,
	);
	detail.failure = message;
	for (const id of expected) {
		if (!(id in out.metrics)) {
			out.metrics[id] = Number.NaN;
			out.notMeasured[id] = `run failed: ${message.slice(0, 300)}`;
		}
	}
}

/**
 * Run a measurement and always write its raw record, including on failure:
 * expected rows without a value are recorded as null (a failed run, which
 * fails the row in aggregate.ts) with the failure message. The error is
 * rethrown so Playwright reports it.
 */
export async function withRecord(
	testInfo: TestInfo,
	meta: RecordMeta,
	body: (out: Recorded, detail: Record<string, unknown>) => Promise<void>,
): Promise<void> {
	const out = new Recorded();
	const detail: Record<string, unknown> = {};
	let failure: unknown;
	try {
		await body(out, detail);
	} catch (error) {
		failure = error;
	}
	if (failure !== undefined) markFailed(out, detail, meta.expected, failure);
	writeRaw({
		project: testInfo.project.name,
		scenario: meta.scenario,
		config: meta.config,
		repeat: testInfo.repeatEachIndex,
		metrics: out.metrics,
		notMeasured: out.notMeasured,
		detail,
	});
	if (failure !== undefined) throw failure;
}

export interface ContinuityTotals {
	gapEvents: number;
	duplicates: number;
	lossReports: number;
	errors: number;
	delivered: number;
	topicsWithoutEvents: number;
}

/** Totals across pages: delivery loss evidence. */
export function continuityTotals(
	summaries: readonly TopicSummary[],
): ContinuityTotals {
	const totals: ContinuityTotals = {
		gapEvents: 0,
		duplicates: 0,
		lossReports: 0,
		errors: 0,
		delivered: 0,
		topicsWithoutEvents: 0,
	};
	for (const summary of summaries) {
		const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
		totals.gapEvents += sum(summary.gapEvents);
		totals.duplicates += sum(summary.duplicates);
		totals.lossReports += sum(summary.lossReports);
		totals.errors += summary.errors.filter((error) => error !== null).length;
		totals.delivered += sum(summary.counts);
		totals.topicsWithoutEvents += summary.counts.filter(
			(count) => count === 0,
		).length;
	}
	return totals;
}

/** Runtime `stats()` shape used here (see src/core/runtime.ts `RuntimeStats`). */
export interface RuntimeStatsLike {
	id: string;
	attachments: number;
	consumers: number;
	ledgers: number;
	pendingMessages: number;
	pendingBytes: number;
	connections: number;
	subscriptions: number;
	pendingCommands: number;
	pendingCredentialRequests: number;
	/** Attachments expired since runtime start (any cause). */
	expired?: number;
	perAttachment: Array<{
		consumers: number;
		ledgers: number;
		pendingMessages: number;
		pendingBytes: number;
		/** Control posted and unacknowledged (the flow-control window). */
		pendingControl: number;
		/** Control waiting in the attachment's outbox. */
		queuedControl?: number;
		queuedControlBytes?: number;
		queuedData?: number;
		queuedDataBytes?: number;
	}>;
	diagnostics: unknown[];
	/** Requested from core; used when present. */
	hwm?: Partial<Record<HwmKey, number>>;
}

export type HwmKey =
	| "pendingMessages"
	| "pendingBytes"
	| "perConsumerMessages"
	| "perConsumerBytes"
	| "pendingCommands"
	| "controlMessages"
	| "controlQueued"
	| "controlQueuedBytes"
	| "subscriptions"
	| "consumersPerAttachment"
	| "connections";

/** Posted control occupancy is informational; control headroom uses the outbox's failure bounds. */
export const LIMITS: Readonly<Record<HwmKey, number>> = Object.freeze({
	pendingMessages: DEFAULT_LIMITS.maxPendingMessages,
	pendingBytes: DEFAULT_LIMITS.maxPendingBytes,
	perConsumerMessages: DEFAULT_LIMITS.maxPendingMessagesPerConsumer,
	perConsumerBytes: DEFAULT_LIMITS.maxPendingBytesPerConsumer,
	pendingCommands: DEFAULT_LIMITS.maxPendingCommands,
	controlMessages: CONTROL_BOUNDS.window,
	controlQueued: CONTROL_BOUNDS.queued,
	controlQueuedBytes: CONTROL_BOUNDS.queuedBytes,
	subscriptions: DEFAULT_LIMITS.maxSubscriptions,
	consumersPerAttachment: DEFAULT_LIMITS.maxConsumersPerAttachment,
	connections: DEFAULT_LIMITS.maxConnections,
});

/**
 * High-water marks: the runtime's own `hwm` when core provides it, otherwise
 * the maximum over sampled snapshots (a lower bound; recorded as such).
 */
export function highWater(samples: readonly RuntimeStatsLike[]): {
	source: "runtime" | "sampled";
	values: Partial<Record<HwmKey, number>>;
} {
	const last = samples[samples.length - 1];
	if (last?.hwm) return { source: "runtime", values: { ...last.hwm } };
	const values: Partial<Record<HwmKey, number>> = {};
	const raise = (key: HwmKey, value: number) => {
		values[key] = Math.max(values[key] ?? 0, value);
	};
	for (const stats of samples) {
		raise("subscriptions", stats.subscriptions);
		raise("connections", stats.connections);
		raise("pendingCommands", stats.pendingCommands);
		for (const attachment of stats.perAttachment) {
			raise("pendingMessages", attachment.pendingMessages);
			raise("pendingBytes", attachment.pendingBytes);
			raise("controlMessages", attachment.pendingControl);
			if (typeof attachment.queuedControl === "number") {
				raise("controlQueued", attachment.queuedControl);
			}
			if (typeof attachment.queuedControlBytes === "number") {
				raise("controlQueuedBytes", attachment.queuedControlBytes);
			}
			raise("consumersPerAttachment", attachment.consumers);
		}
	}
	return { source: "sampled", values };
}

/** Reason recorded on a true high-water row when only snapshots exist. */
export const SAMPLED_ONLY = "runtime hwm unavailable; sampled lower bound only";

export interface HighWaterRow {
	key: HwmKey;
	/** Gate metric id, written only from the runtime's own `hwm`. */
	id: string;
	/** Informational metric id for the snapshot maximum (has a `sampled` segment). */
	sampledId: string;
	/** Maps the observed value to the metric (for example limit ÷ observed). */
	value?: (observed: number) => number;
}

/**
 * Record high-water marks honestly. With
 * the runtime's `hwm`, the gate ids are measured. With sampled snapshots,
 * which only bound the peak from below, the gate ids are not measured and
 * the values go to the informational `sampledId`s instead.
 */
export function recordHighWater(
	out: Recorded,
	hwm: ReturnType<typeof highWater>,
	rows: readonly HighWaterRow[],
): void {
	for (const row of rows) {
		const observed = hwm.values[row.key];
		const value =
			observed === undefined
				? undefined
				: row.value
					? row.value(observed)
					: observed;
		if (hwm.source === "runtime") {
			if (value === undefined) {
				out.skip(row.id, `Runtime.stats().hwm has no ${row.key} value`);
			} else out.put(row.id, value);
			continue;
		}
		out.skip(row.id, SAMPLED_ONLY);
		if (value === undefined) {
			out.skip(row.sampledId, `stats() snapshots do not expose ${row.key}`);
		} else out.put(row.sampledId, value);
	}
}

/**
 * Headroom rows of one tab-scaling config (`at` is `<variant>.n<N>`):
 * limit ÷ high-water mark per key, gate ids `headroom.<at>.<key>` from the
 * runtime's `hwm`, sampled maxima under `headroom.sampled.<at>.<key>`.
 */
export function headroomRows(
	at: string,
	keys: readonly HwmKey[] = Object.keys(LIMITS) as HwmKey[],
): HighWaterRow[] {
	return keys.map((key) => ({
		key,
		id: `headroom.${at}.${key}`,
		sampledId: `headroom.sampled.${at}.${key}`,
		value: (observed: number) => LIMITS[key] / Math.max(observed, 1),
	}));
}

/** Outbox bounds used by the control headroom gate. */
export const CONTROL_OUTBOX_KEYS: readonly HwmKey[] = [
	"controlQueued",
	"controlQueuedBytes",
];

/** Metric ids of the control flow observations for one config. */
export const controlIds = (at: string) => ({
	/** `hwm.controlMessages`: posted-window occupancy (≤ the window). */
	posted: `control.${at}.posted`,
	postedSampled: `control.sampled.${at}.posted`,
	/** `stats().expired` at the end of the config (any cause). */
	expired: `control.${at}.expired`,
	/** Σ `perAttachment[].queuedControl` at the end of the config. */
	queuedAtEnd: `control.${at}.queued-at-end`,
});

export interface ControlFlowDetail {
	bounds: typeof CONTROL_BOUNDS;
	expired: number | null;
	/**
	 * `attachment-expired` diagnostics in the retained runtime history, by
	 * cause. The runtime keeps that history only when its `diagnostics` sink is
	 * configured, so expiries the history does not explain
	 * are reported under `unattributed`, never dropped.
	 */
	expiredCauses: Record<string, number>;
	atEnd: {
		pendingControl: number | null;
		queuedControl: number | null;
		queuedControlBytes: number | null;
		queuedData: number | null;
		queuedDataBytes: number | null;
	};
}

type OutboxField =
	| "pendingControl"
	| "queuedControl"
	| "queuedControlBytes"
	| "queuedData"
	| "queuedDataBytes";

/** Σ of one field over attachments; null when any attachment lacks it. */
function total(final: RuntimeStatsLike, field: OutboxField): number | null {
	let sum = 0;
	for (const attachment of final.perAttachment) {
		const value = attachment[field];
		if (typeof value !== "number" || !Number.isFinite(value)) return null;
		sum += value;
	}
	return sum;
}

/**
 * Control flow observations for one config: posted-window occupancy from the runtime's `hwm` (structural,
 * ≤ the window), attachments expired and control still queued in the final
 * `stats()` (both 0: no `control-queue` or `control-stalled` expiry, and the
 * outbox drained). Values the runtime does not expose are not measured,
 * never zero. Returns the evidence for `detail.controlFlow`.
 */
export function recordControlFlow(
	out: Recorded,
	hwm: ReturnType<typeof highWater>,
	final: RuntimeStatsLike | undefined,
	at: string,
): ControlFlowDetail {
	const ids = controlIds(at);
	recordHighWater(out, hwm, [
		{ key: "controlMessages", id: ids.posted, sampledId: ids.postedSampled },
	]);
	const expired =
		typeof final?.expired === "number" && Number.isFinite(final.expired)
			? final.expired
			: null;
	if (expired === null) {
		out.skip(ids.expired, "final Runtime.stats() has no expired counter");
	} else out.put(ids.expired, expired);
	const atEnd = {
		pendingControl: final ? total(final, "pendingControl") : null,
		queuedControl: final ? total(final, "queuedControl") : null,
		queuedControlBytes: final ? total(final, "queuedControlBytes") : null,
		queuedData: final ? total(final, "queuedData") : null,
		queuedDataBytes: final ? total(final, "queuedDataBytes") : null,
	};
	if (atEnd.queuedControl === null) {
		out.skip(
			ids.queuedAtEnd,
			"final Runtime.stats() has no perAttachment queuedControl",
		);
	} else out.put(ids.queuedAtEnd, atEnd.queuedControl);
	const expiredCauses: Record<string, number> = {};
	let attributed = 0;
	for (const event of final?.diagnostics ?? []) {
		const entry = event as { type?: unknown; detail?: { cause?: unknown } };
		if (entry?.type !== "attachment-expired") continue;
		const cause =
			typeof entry.detail?.cause === "string" ? entry.detail.cause : "none";
		expiredCauses[cause] = (expiredCauses[cause] ?? 0) + 1;
		attributed += 1;
	}
	// Expiries without a retained diagnostic (no runtime sink in the fixture, or
	// more expiries than the history holds) must never read as "no causes".
	if (expired !== null && attributed < expired) {
		expiredCauses.unattributed = expired - attributed;
	}
	return { bounds: CONTROL_BOUNDS, expired, expiredCauses, atEnd };
}

/** Drain metrics cannot be inferred from records without retained control-flow samples. */
export const PREDATES_CONTROL_FLOW =
	"raw record lacks final Runtime.stats() expired and queued control metrics";

const isNumberRecord = (value: unknown): value is Record<string, number> =>
	typeof value === "object" &&
	value !== null &&
	!Array.isArray(value) &&
	Object.values(value).every(
		(entry) => typeof entry === "number" && Number.isFinite(entry),
	);

/** Derive missing headroom and occupancy rows from retained runtime high-water marks. Existing rows win; drain metrics stay unmeasured without controlFlow samples. */
export function deriveControlFlow(record: RawRecord): {
	record: RawRecord;
	derived: string[];
} {
	const detail = (
		typeof record.detail === "object" && record.detail !== null
			? record.detail
			: {}
	) as Record<string, unknown>;
	const config = detail.config as
		| { kind?: unknown; variant?: unknown; n?: unknown; attribution?: unknown }
		| undefined;
	if (
		record.scenario !== "tabs" ||
		config?.kind !== "spinetab" ||
		typeof config.variant !== "string" ||
		typeof config.n !== "number" ||
		config.attribution === true
	) {
		return { record, derived: [] };
	}
	const stored = detail.hwm as
		| { source?: unknown; values?: unknown }
		| undefined;
	if (
		(stored?.source !== "runtime" && stored?.source !== "sampled") ||
		!isNumberRecord(stored.values)
	) {
		return { record, derived: [] };
	}
	const at = `${config.variant}.n${config.n}`;
	const out = new Recorded();
	const hwm: ReturnType<typeof highWater> = {
		source: stored.source,
		values: stored.values as Partial<Record<HwmKey, number>>,
	};
	recordHighWater(out, hwm, headroomRows(at, CONTROL_OUTBOX_KEYS));
	const ids = controlIds(at);
	recordHighWater(out, hwm, [
		{ key: "controlMessages", id: ids.posted, sampledId: ids.postedSampled },
	]);
	if (detail.controlFlow === undefined) {
		out.skip(ids.expired, PREDATES_CONTROL_FLOW);
		out.skip(ids.queuedAtEnd, PREDATES_CONTROL_FLOW);
	}
	const original = record.notMeasured ?? {};
	const known = (id: string) => id in record.metrics || id in original;
	const metrics = { ...record.metrics };
	const notMeasured = { ...original };
	const derived: string[] = [];
	for (const [id, value] of Object.entries(out.metrics)) {
		if (known(id)) continue;
		metrics[id] = value;
		derived.push(id);
	}
	let skipped = 0;
	for (const [id, reason] of Object.entries(out.notMeasured)) {
		if (known(id)) continue;
		notMeasured[id] = reason;
		skipped += 1;
	}
	if (derived.length === 0 && skipped === 0) return { record, derived };
	return { record: { ...record, metrics, notMeasured }, derived };
}
