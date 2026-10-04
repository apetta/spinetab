import type { HandleCounts } from "../../fixtures/harness/src/bench/instrument.ts";
import type { RuntimeStatsLike } from "./record.ts";

/** Pause emission and drain delivery before counting persistent handles. Require consecutive identical censuses; failure to quiesce is not a passing measurement. */

/** Live timers (timeouts + intervals) and listeners in one realm. */
export interface Census {
	timers: number;
	listeners: number;
}

export interface RealmCensus {
	page: Census;
	worker: Census;
}

export const census = (counts: HandleCounts): Census => ({
	timers: counts.timeouts + counts.intervals,
	listeners: counts.listeners,
});

/**
 * Work the runtime still holds for the page: an empty list means every
 * delivered message and control message was acknowledged and no outbox or
 * command is pending.
 */
export function outstanding(stats: RuntimeStatsLike): string[] {
	const found: string[] = [];
	const check = (name: string, value: number | undefined) => {
		if ((value ?? 0) !== 0) found.push(`${name}=${value}`);
	};
	check("pendingMessages", stats.pendingMessages);
	check("pendingBytes", stats.pendingBytes);
	check("pendingCommands", stats.pendingCommands);
	check("pendingCredentialRequests", stats.pendingCredentialRequests);
	stats.perAttachment.forEach((attachment, index) => {
		check(`perAttachment[${index}].pendingControl`, attachment.pendingControl);
		check(`perAttachment[${index}].queuedControl`, attachment.queuedControl);
		check(`perAttachment[${index}].queuedData`, attachment.queuedData);
	});
	return found;
}

/** What `quiesce` reads; heap.perf.ts binds it to the bench page and fixture. */
export interface QuiescencePort {
	/** Stop fixture emission (bench `pause` fault). */
	pause(): Promise<void>;
	/** Restore emission; always called, also after a failure. */
	resume(): Promise<void>;
	/** Fixture `emitted` counter. */
	emitted(): Promise<number>;
	/** Events delivered to page callbacks so far. */
	delivered(): Promise<number>;
	/** Runtime `stats()` from the runtime realm. */
	stats(): Promise<RuntimeStatsLike>;
	/** Live handles in both realms (instrument.ts). */
	census(): Promise<RealmCensus>;
}

export interface QuiescenceOptions {
	/** Give up (not measured) after this long from the pause. */
	boundMs: number;
	/** Delay between reads. */
	spacingMs: number;
	/** Consecutive identical, drained reads required. */
	stableReads: number;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}

export const QUIESCENCE: Readonly<QuiescenceOptions> = Object.freeze({
	boundMs: 15_000,
	spacingMs: 100,
	stableReads: 5,
});

interface Read {
	emitted: number;
	delivered: number;
	outstanding: string[];
	census: RealmCensus;
}

export type Quiescence =
	| {
			ok: true;
			census: RealmCensus;
			stats: RuntimeStatsLike;
			elapsedMs: number;
			reads: number;
	  }
	| {
			ok: false;
			reason: string;
			elapsedMs: number;
			reads: number;
			last?: Read;
	  };

export async function quiesce(
	port: QuiescencePort,
	options: Partial<QuiescenceOptions> = {},
): Promise<Quiescence> {
	const { boundMs, spacingMs, stableReads } = { ...QUIESCENCE, ...options };
	const now = options.now ?? Date.now;
	const sleep =
		options.sleep ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const started = now();
	let reads = 0;
	let last: Read | undefined;
	let previous: string | undefined;
	let stable = 0;
	try {
		await port.pause();
		for (;;) {
			const stats = await port.stats();
			const read: Read = {
				emitted: await port.emitted(),
				delivered: await port.delivered(),
				outstanding: outstanding(stats),
				census: await port.census(),
			};
			reads += 1;
			last = read;
			const key = JSON.stringify([read.emitted, read.delivered, read.census]);
			if (read.outstanding.length > 0) {
				stable = 0;
				previous = undefined;
			} else {
				stable = key === previous ? stable + 1 : 1;
				previous = key;
			}
			if (stable >= stableReads) {
				return {
					ok: true,
					census: read.census,
					stats,
					elapsedMs: now() - started,
					reads,
				};
			}
			if (now() - started + spacingMs > boundMs) {
				const cause =
					read.outstanding.length > 0
						? `runtime still holds ${read.outstanding.join(", ")}`
						: `emission, delivery or handle census still changing (${stable} of ${stableReads} identical reads)`;
				return {
					ok: false,
					reason: `quiescence not reached within ${boundMs} ms: ${cause}`,
					elapsedMs: now() - started,
					reads,
					last,
				};
			}
			await sleep(spacingMs);
		}
	} finally {
		await port.resume();
	}
}

/** Liveness O(1) row: persistent timer growth from the 1- to the 100-topic state. */
export const timerDelta = (from: Census, to: Census): number =>
	to.timers - from.timers;

/** History row: range of timers plus range of listeners across censuses. */
export function handlesRange(censuses: readonly Census[]): number {
	const range = (values: number[]) => Math.max(...values) - Math.min(...values);
	return (
		range(censuses.map((value) => value.timers)) +
		range(censuses.map((value) => value.listeners))
	);
}
