/**
 * Summary statistics for the representative-app reports. Pure and Node-runnable (erasable TypeScript, no imports), so the
 * browser spec and the report derivation script share one definition.
 */

/** Definitions written beside the values in every app report. */
export const DEFINITIONS = {
	median:
		"middle sorted value; mean of the two middle sorted values for an even count",
	p95: "nearest rank",
} as const;

const ascending = (values: readonly number[]) =>
	[...values].sort((a, b) => a - b);

/**
 * Median: for an odd count, the middle value of the ascending sort; for an
 * even count, the mean of the two middle values (so `[1, 2, 3, 4]` gives 2.5);
 * `null` for no values. The input is not modified.
 */
export function median(values: readonly number[]): number | null {
	const sorted = ascending(values);
	const count = sorted.length;
	if (count === 0) return null;
	const upper = Math.floor(count / 2);
	if (count % 2 === 1) return sorted[upper] as number;
	return ((sorted[upper - 1] as number) + (sorted[upper] as number)) / 2;
}

/**
 * 95th percentile by nearest rank: the value at 1-based rank `ceil(0.95 × n)`
 * of the ascending sort (n = 10 → rank 10, n = 20 → rank 19); `null` for no
 * values. Always an observed sample, never interpolated. The rank uses integer
 * arithmetic (`ceil(95n / 100)`) so floating point cannot shift it. The input
 * is not modified.
 */
export function p95(values: readonly number[]): number | null {
	const sorted = ascending(values);
	if (sorted.length === 0) return null;
	const rank = Math.max(1, Math.ceil((95 * sorted.length) / 100));
	return sorted[rank - 1] as number;
}
