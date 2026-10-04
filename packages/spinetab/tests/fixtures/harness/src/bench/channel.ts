/**
 * Messages on the bench BroadcastChannel (`CHANNEL` in event.ts) between the
 * bench pages and the bench runtime realm (the SharedWorker, or the local
 * runtime in local mode). Requests name their target realm; replies carry the
 * request id, so every page ignores other pages' traffic.
 */

export type RealmOp =
	| "stats"
	| "handles"
	| "ring"
	| "timed"
	| "arm"
	| "busy"
	| "resolution"
	| "reset";

/** `worker` or `local:<pageId>`. */
export type RealmTarget = string;

export type ChannelMessage =
	| { kind: "ping"; id: string; target: RealmTarget }
	| { kind: "pong"; id: string; at: number; realm: string }
	| {
			kind: "req";
			id: string;
			target: RealmTarget;
			op: RealmOp;
			args?: Record<string, number>;
	  }
	| {
			kind: "res";
			id: string;
			realm: string;
			runtimeId: string;
			ok: boolean;
			value?: unknown;
			error?: string;
	  };

export interface RingCopy {
	at: Float64Array;
	seq: Int32Array;
}

export interface BusyResult {
	start: number;
	end: number;
}

/** Smallest non-zero step of `performance.now()` in this realm (ms). */
export function timerResolution(samples = 2_000): number {
	let smallest = Number.POSITIVE_INFINITY;
	let previous = performance.now();
	let steps = 0;
	const deadline = previous + 250;
	while (steps < samples && previous < deadline) {
		const next = performance.now();
		const step = next - previous;
		if (step > 0) {
			if (step < smallest) smallest = step;
			steps += 1;
		}
		previous = next;
	}
	return Number.isFinite(smallest) ? smallest : Number.NaN;
}

/** Busy-loop the current thread (scheduling-gap and stall scenarios). */
export function busy(ms: number): BusyResult {
	const start = performance.timeOrigin + performance.now();
	const until = performance.now() + ms;
	while (performance.now() < until) {
		// Intentionally blocking.
	}
	return { start, end: performance.timeOrigin + performance.now() };
}
