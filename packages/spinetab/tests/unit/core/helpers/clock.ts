import type { Clock } from "../../../../src/core/clock.ts";

interface Timer {
	id: number;
	at: number;
	callback: () => void;
}

/**
 * Deterministic clock for runtime and client tests. Timers run only when the
 * test advances time; MessageChannel delivery stays real, so tests call
 * `settle()` to let posted messages arrive between steps.
 */
export class ManualClock implements Clock {
	private time: number;
	private timers: Timer[] = [];
	private nextId = 1;

	constructor(start = 1_000_000) {
		this.time = start;
	}

	now(): number {
		return this.time;
	}

	setTimeout(callback: () => void, ms: number): unknown {
		const timer = {
			id: this.nextId++,
			at: this.time + Math.max(0, ms),
			callback,
		};
		this.timers.push(timer);
		return timer.id;
	}

	clearTimeout(handle: unknown): void {
		this.timers = this.timers.filter((timer) => timer.id !== handle);
	}

	pending(): number {
		return this.timers.length;
	}

	/** Run every timer due within `ms`, in time order, including new ones. */
	advance(ms: number): void {
		const target = this.time + ms;
		for (;;) {
			const due = this.timers
				.filter((timer) => timer.at <= target)
				.sort((x, y) => x.at - y.at || x.id - y.id)[0];
			if (!due) break;
			this.timers = this.timers.filter((timer) => timer !== due);
			this.time = Math.max(this.time, due.at);
			due.callback();
		}
		this.time = target;
	}

	/** Jump wall time without running timers (a suspension gap). */
	jump(ms: number): void {
		this.time += ms;
	}
}

const realImmediate = globalThis.setImmediate;

/** Let real MessageChannel deliveries and promise chains run. */
export async function flush(turns = 4): Promise<void> {
	for (let turn = 0; turn < turns; turn += 1) {
		await new Promise<void>((resolve) => realImmediate(resolve));
	}
}

/** Flush messages and run zero-delay timers until the system is quiet. */
export async function settle(clock: ManualClock, rounds = 8): Promise<void> {
	for (let round = 0; round < rounds; round += 1) {
		await flush();
		clock.advance(0);
	}
	await flush();
}

/** Advance time in steps, delivering messages between steps (like real time). */
export async function tick(
	clock: ManualClock,
	ms: number,
	step = 50,
): Promise<void> {
	let remaining = ms;
	while (remaining > 0) {
		const next = Math.min(step, remaining);
		clock.advance(next);
		remaining -= next;
		await flush(3);
	}
	await settle(clock);
}
