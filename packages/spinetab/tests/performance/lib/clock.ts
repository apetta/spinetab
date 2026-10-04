/**
 * Cross-realm clock calibration. Pure
 * functions: unit-tested in tests/unit/performance/clock.test.ts.
 *
 * Each realm stamps `performance.timeOrigin + performance.now()`; raw
 * `now()` values are never subtracted across realms. A ping-pong sample is
 * [t0, tr, t1]: local send, remote stamp, local receive. With remote clock =
 * local clock + offset, the remote stamp was taken at local time (t0 + t1) / 2
 * ± RTT / 2, so offset = tr − (t0 + t1) / 2 with uncertainty RTT / 2. The
 * minimum-RTT sample bounds the uncertainty best.
 */

export type ClockSample = readonly [number, number, number];

export interface Calibration {
	/** remote − local, ms. */
	offset: number;
	rttMin: number;
	rttMedian: number;
	/** ± half the minimum RTT, ms. */
	uncertainty: number;
	samples: number;
	/** Samples discarded as malformed (t1 < t0 or non-finite). */
	rejected: number;
}

export function calibrate(samples: readonly ClockSample[]): Calibration {
	let best: ClockSample | undefined;
	let bestRtt = Number.POSITIVE_INFINITY;
	const rtts: number[] = [];
	let rejected = 0;
	for (const sample of samples) {
		const [t0, tr, t1] = sample;
		const rtt = t1 - t0;
		if (![t0, tr, t1].every(Number.isFinite) || rtt < 0) {
			rejected += 1;
			continue;
		}
		rtts.push(rtt);
		if (rtt < bestRtt) {
			bestRtt = rtt;
			best = sample;
		}
	}
	if (!best) {
		return {
			offset: Number.NaN,
			rttMin: Number.NaN,
			rttMedian: Number.NaN,
			uncertainty: Number.NaN,
			samples: 0,
			rejected,
		};
	}
	rtts.sort((a, b) => a - b);
	const middle = Math.floor(rtts.length / 2);
	const rttMedian =
		rtts.length % 2 === 1
			? (rtts[middle] as number)
			: ((rtts[middle - 1] as number) + (rtts[middle] as number)) / 2;
	const [t0, tr, t1] = best;
	return {
		offset: tr - (t0 + t1) / 2,
		rttMin: bestRtt,
		rttMedian,
		uncertainty: bestRtt / 2,
		samples: rtts.length,
		rejected,
	};
}

/** Remote timestamp expressed on the local clock. */
export function toLocal(remote: number, offset: number): number {
	return remote - offset;
}

/** Latency from a remote-clock start to a local-clock end. */
export function latency(
	remoteStart: number,
	localEnd: number,
	offset: number,
): number {
	return localEnd - toLocal(remoteStart, offset);
}

export interface CalibrationCheck {
	valid: boolean;
	offset: number;
	drift: number;
	uncertainty: number;
	reasons: string[];
}

/**
 * Combine calibrations taken before and after a window. The run is invalid
 * when either uncertainty or the drift exceeds its bound.
 * The offset used is the mean of both, so a linear drift is centred.
 */
export function checkCalibration(
	before: Calibration,
	after: Calibration,
	bounds: { maxUncertainty: number; maxDrift: number } = {
		maxUncertainty: 0.5,
		maxDrift: 0.5,
	},
): CalibrationCheck {
	const reasons: string[] = [];
	const uncertainty = Math.max(before.uncertainty, after.uncertainty);
	const drift = after.offset - before.offset;
	if (!Number.isFinite(before.offset) || !Number.isFinite(after.offset)) {
		reasons.push("no usable calibration samples");
	}
	if (uncertainty > bounds.maxUncertainty) {
		reasons.push(
			`uncertainty ±${uncertainty.toFixed(3)} ms > ±${bounds.maxUncertainty} ms`,
		);
	}
	if (Math.abs(drift) > bounds.maxDrift) {
		reasons.push(`drift ${drift.toFixed(3)} ms > ${bounds.maxDrift} ms`);
	}
	return {
		valid: reasons.length === 0,
		offset: (before.offset + after.offset) / 2,
		drift,
		uncertainty,
		reasons,
	};
}
