import type { RingCopy } from "./channel";
import { MAX_TOPICS, RING, readEvent, TOPICS } from "./event";
import type { ClockSamples, LatencySample, TopicSummary } from "./types";

/**
 * Page-realm callback recorder shared by the Spinetab and independent bench
 * pages. All storage is preallocated so recording
 * never allocates per event and bench storage does not grow with history.
 */

const stamp = () => performance.timeOrigin + performance.now();

export interface TopicState {
	continuity: { state: string; reason?: string; missed?: number } | null;
	connection: string | null;
	error: string | null;
	lossReports: number;
}

export class Recorder {
	readonly at = new Float64Array(TOPICS * RING);
	readonly seq = new Int32Array(TOPICS * RING).fill(-1);
	readonly emitted = new Float64Array(TOPICS * RING);
	readonly visible = new Uint8Array(TOPICS * RING);
	readonly counts = new Uint32Array(MAX_TOPICS);
	readonly firstSeq = new Int32Array(MAX_TOPICS).fill(-1);
	readonly lastSeq = new Int32Array(MAX_TOPICS).fill(-1);
	readonly gapEvents = new Uint32Array(MAX_TOPICS);
	readonly duplicates = new Uint32Array(MAX_TOPICS);
	readonly first = new Float64Array(MAX_TOPICS).fill(Number.NaN);
	readonly state: TopicState[] = Array.from({ length: MAX_TOPICS }, () => ({
		continuity: null,
		connection: null,
		error: null,
		lossReports: 0,
	}));
	armedAt = Number.POSITIVE_INFINITY;
	total = 0;
	lastAt = 0;

	/** Record one delivered value; returns false when it is not a bench event. */
	record(value: unknown): boolean {
		const now = stamp();
		const key = readEvent(value);
		if (!key || key.topic < 0 || key.topic >= MAX_TOPICS) return false;
		const { topic, seq } = key;
		this.total += 1;
		this.lastAt = now;
		this.counts[topic] = (this.counts[topic] ?? 0) + 1;
		const last = this.lastSeq[topic] ?? -1;
		if (last === -1) this.firstSeq[topic] = seq;
		else if (seq <= last)
			this.duplicates[topic] = (this.duplicates[topic] ?? 0) + 1;
		else if (seq > last + 1)
			this.gapEvents[topic] = (this.gapEvents[topic] ?? 0) + (seq - last - 1);
		if (seq > last) this.lastSeq[topic] = seq;
		if (now >= this.armedAt && Number.isNaN(this.first[topic] ?? 0)) {
			this.first[topic] = now;
		}
		if (topic < TOPICS) {
			const slot = topic * RING + (seq % RING);
			this.at[slot] = now;
			this.seq[slot] = seq;
			this.emitted[slot] = key.emittedAt;
			this.visible[slot] = document.visibilityState === "visible" ? 1 : 0;
		}
		return true;
	}

	arm(at: number): void {
		this.armedAt = at;
		this.first.fill(Number.NaN);
	}

	firstAfter(topics: number[]) {
		let first = Number.POSITIVE_INFINITY;
		let all = Number.NEGATIVE_INFINITY;
		let missing = 0;
		for (const topic of topics) {
			const value = this.first[topic] ?? Number.NaN;
			if (Number.isNaN(value)) {
				missing += 1;
				continue;
			}
			first = Math.min(first, value);
			all = Math.max(all, value);
		}
		return {
			first: Number.isFinite(first) ? first : Number.NaN,
			all: missing === 0 && Number.isFinite(all) ? all : Number.NaN,
			missing,
		};
	}

	summary(topics: number[]): TopicSummary {
		const pick = <T>(read: (topic: number) => T) => topics.map(read);
		return {
			topics,
			counts: pick((topic) => this.counts[topic] ?? 0),
			firstSeq: pick((topic) => this.firstSeq[topic] ?? -1),
			lastSeq: pick((topic) => this.lastSeq[topic] ?? -1),
			gapEvents: pick((topic) => this.gapEvents[topic] ?? 0),
			duplicates: pick((topic) => this.duplicates[topic] ?? 0),
			continuity: pick((topic) => this.state[topic]?.continuity ?? null),
			connection: pick((topic) => this.state[topic]?.connection ?? null),
			errors: pick((topic) => this.state[topic]?.error ?? null),
			lossReports: pick((topic) => this.state[topic]?.lossReports ?? 0),
			total: this.total,
			lastAt: this.lastAt,
		};
	}

	/**
	 * Pair page callbacks in [from, to] with worker receipts of the same seq.
	 * `crossOffset` = worker clock − page clock; `serverOffset` = fixture
	 * clock − page clock (both from minimum-RTT ping-pong, lib/clock.ts).
	 * Hidden-tab callbacks are excluded and counted unless `includeHidden`
	 * (the informational background-tab row).
	 */
	latencies(
		from: number,
		to: number,
		worker: RingCopy | undefined,
		crossOffset: number | null,
		serverOffset: number | null,
		includeHidden = false,
	): LatencySample {
		const result: LatencySample = {
			cross: [],
			e2e: [],
			paired: 0,
			unpaired: 0,
			hidden: 0,
		};
		for (let slot = 0; slot < this.at.length; slot += 1) {
			const seq = this.seq[slot] ?? -1;
			const at = this.at[slot] ?? 0;
			if (seq < 0 || at < from || at > to) continue;
			if (this.visible[slot] !== 1) {
				result.hidden += 1;
				if (!includeHidden) continue;
			}
			if (serverOffset !== null) {
				result.e2e.push(at - ((this.emitted[slot] ?? 0) - serverOffset));
			}
			if (worker && crossOffset !== null) {
				if (worker.seq[slot] === seq) {
					result.cross.push(at - ((worker.at[slot] ?? 0) - crossOffset));
					result.paired += 1;
				} else {
					result.unpaired += 1;
				}
			}
		}
		return result;
	}

	reset(): void {
		this.at.fill(0);
		this.seq.fill(-1);
		this.emitted.fill(0);
		this.visible.fill(0);
		this.counts.fill(0);
		this.firstSeq.fill(-1);
		this.lastSeq.fill(-1);
		this.gapEvents.fill(0);
		this.duplicates.fill(0);
		this.first.fill(Number.NaN);
		for (const entry of this.state) {
			entry.continuity = null;
			entry.connection = null;
			entry.error = null;
			entry.lossReports = 0;
		}
		this.armedAt = Number.POSITIVE_INFINITY;
		this.total = 0;
		this.lastAt = 0;
	}
}

/** Ping-pong against the fixture clock endpoint (end-to-end calibration). */
export async function serverClockSamples(
	samples: number,
	spacingMs: number,
	wait: (ms: number) => Promise<void>,
): Promise<ClockSamples> {
	const result: ClockSamples = [];
	for (let index = 0; index < samples; index += 1) {
		const t0 = stamp();
		const response = await fetch("/__fixture/bench/clock", {
			cache: "no-store",
		});
		const body = (await response.json()) as { now: number };
		const t1 = stamp();
		result.push([t0, body.now, t1]);
		await wait(spacingMs);
	}
	return result;
}
