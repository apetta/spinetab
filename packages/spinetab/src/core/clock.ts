/** Use the injected clock for deadlines so tests can control time. */
export interface Clock {
	now(): number;
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

/** Larger delays overflow the host timer's signed 32-bit range. */
export const MAX_TIMER_MS = 2_147_483_647;

export const systemClock: Clock = {
	now: () => Date.now(),
	setTimeout: (callback, ms) =>
		setTimeout(callback, Math.min(ms, MAX_TIMER_MS)),
	clearTimeout: (handle) => {
		clearTimeout(handle as ReturnType<typeof setTimeout>);
	},
};

/** Random, never-reused identifier (attachment ids, request ids). */
export function randomId(): string {
	const cryptoApi = (globalThis as { crypto?: Crypto }).crypto;
	if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
		return cryptoApi.randomUUID();
	}
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

/** Full-jitter exponential backoff delay for attempt `n` (1-based). */
export function jitteredBackoff(
	attempt: number,
	baseMs: number,
	capMs: number,
	random: () => number = Math.random,
): number {
	const ceiling = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
	return Math.floor(random() * ceiling);
}

/**
 * Proposed default scheduling-gap threshold: a timer that fires
 * later than max(2 × interval, 30 s) indicates a possible suspension.
 */
export function gapThreshold(intervalMs: number): number {
	return Math.max(2 * intervalMs, 30_000);
}
