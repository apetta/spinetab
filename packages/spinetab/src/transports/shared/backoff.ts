/** Use executable time for the retry budget so suspension does not spend it. */
export interface BackoffOptions {
	baseMs: number;
	factor: number;
	capMs: number;
	maxAttempts: number;
	maxElapsedMs: number;
	healthyResetMs: number;
}

export const NATIVE_BACKOFF: Readonly<BackoffOptions> = Object.freeze({
	baseMs: 1_000,
	factor: 2,
	capMs: 30_000,
	maxAttempts: 10,
	maxElapsedMs: 300_000,
	healthyResetMs: 10_000,
});

export type BackoffStep =
	| { kind: "retry"; attempt: number; delayMs: number }
	| { kind: "exhausted"; reason: "attempts-exhausted" | "time-limit" };

export interface Backoff {
	/** Next failure: a jittered delay or exhaustion. `minDelayMs` honours Retry-After. */
	fail(now: number, minDelayMs?: number): BackoffStep;
	/** The connection became healthy at `now`. */
	connected(now: number): void;
	/** Explicit retry or fresh series: forget failures. */
	reset(): void;
	/**
	 * Override the base delay (SSE `retry:` field). A base above the cap lifts
	 * the cap to it, so a server-directed interval takes effect.
	 */
	setBaseMs(ms: number): void;
	readonly attempt: number;
}

export function createBackoff(
	options: Partial<BackoffOptions> = {},
	random: () => number = Math.random,
): Backoff {
	const config = { ...NATIVE_BACKOFF, ...options };
	let attempt = 0;
	let seriesStart: number | undefined;
	let healthySince: number | undefined;
	let baseMs = config.baseMs;
	let capMs = config.capMs;
	return {
		get attempt() {
			return attempt;
		},
		fail(now, minDelayMs = 0) {
			if (
				healthySince !== undefined &&
				now - healthySince >= config.healthyResetMs
			) {
				attempt = 0;
				seriesStart = undefined;
			}
			healthySince = undefined;
			seriesStart ??= now;
			attempt += 1;
			if (attempt > config.maxAttempts) {
				return { kind: "exhausted", reason: "attempts-exhausted" };
			}
			if (now - seriesStart >= config.maxElapsedMs) {
				return { kind: "exhausted", reason: "time-limit" };
			}
			const ceiling = Math.min(capMs, baseMs * config.factor ** (attempt - 1));
			const delayMs = Math.max(Math.floor(random() * ceiling), minDelayMs);
			return { kind: "retry", attempt, delayMs };
		},
		connected(now) {
			healthySince = now;
		},
		reset() {
			attempt = 0;
			seriesStart = undefined;
			healthySince = undefined;
		},
		setBaseMs(ms) {
			baseMs = ms;
			capMs = Math.max(config.capMs, ms);
		},
	};
}
