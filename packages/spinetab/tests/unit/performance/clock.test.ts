import { describe, expect, it } from "vitest";
import {
	type ClockSample,
	calibrate,
	checkCalibration,
	latency,
	toLocal,
} from "../../performance/lib/clock.ts";

/** Deterministic pseudo-random sequence (no Math.random in tests). */
function lcg(seed: number) {
	let state = seed >>> 0;
	return () => {
		state = (1664525 * state + 1013904223) >>> 0;
		return state / 2 ** 32;
	};
}

/**
 * Simulate ping-pongs to a remote clock `offset` ahead of local, with
 * asymmetric outbound/return delays.
 */
function simulate(offset: number, count: number, seed = 7): ClockSample[] {
	const random = lcg(seed);
	const samples: ClockSample[] = [];
	let t = 1_000_000;
	for (let index = 0; index < count; index += 1) {
		const out = 0.05 + random() * 2;
		const back = 0.05 + random() * 2;
		const t0 = t;
		const remote = t0 + out + offset;
		const t1 = t0 + out + back;
		samples.push([t0, remote, t1]);
		t += 5;
	}
	return samples;
}

describe("calibrate", () => {
	it("recovers the offset within ± RTTmin / 2 from the minimum-RTT sample", () => {
		for (const offset of [-12_345.678, -0.4, 0, 3.25, 86_400_000.5]) {
			const result = calibrate(simulate(offset, 200));
			expect(result.samples).toBe(200);
			expect(Math.abs(result.offset - offset)).toBeLessThanOrEqual(
				result.uncertainty + 1e-9,
			);
			expect(result.uncertainty).toBeCloseTo(result.rttMin / 2, 12);
			expect(result.rttMin).toBeLessThanOrEqual(result.rttMedian);
		}
	});

	it("is exact for a symmetric sample", () => {
		const result = calibrate([
			[100, 205, 110],
			[200, 1_000, 260],
		]);
		expect(result.offset).toBe(100);
		expect(result.rttMin).toBe(10);
		expect(result.uncertainty).toBe(5);
		expect(result.rttMedian).toBe(35);
	});

	it("rejects malformed samples and reports NaN with none left", () => {
		const result = calibrate([
			[10, 5, 9],
			[Number.NaN, 1, 2],
		]);
		expect(result.rejected).toBe(2);
		expect(result.samples).toBe(0);
		expect(result.offset).toBeNaN();
	});
});

describe("cross-realm latency", () => {
	it("converts a remote stamp onto the local clock before subtracting", () => {
		// Worker clock is 40 ms ahead of the page clock.
		const offset = 40;
		const workerReceipt = 1_040.5; // page time 1000.5
		const pageCallback = 1_002;
		expect(toLocal(workerReceipt, offset)).toBe(1_000.5);
		expect(latency(workerReceipt, pageCallback, offset)).toBe(1.5);
	});
});

describe("checkCalibration", () => {
	const base = calibrate([[0, 50.1, 0.2]]);

	it("accepts small uncertainty and drift and centres the offset", () => {
		const after = calibrate([[1_000, 1_050.3, 1_000.2]]);
		const check = checkCalibration(base, after);
		expect(check.valid).toBe(true);
		expect(check.drift).toBeCloseTo(0.2, 9);
		expect(check.offset).toBeCloseTo(50.1, 9);
	});

	it("invalidates the run above ±0.5 ms uncertainty or 0.5 ms drift", () => {
		const wide = calibrate([[0, 50, 1.4]]);
		expect(checkCalibration(base, wide).valid).toBe(false);
		const drifted = calibrate([[0, 50.8, 0.2]]);
		const check = checkCalibration(base, drifted);
		expect(check.valid).toBe(false);
		expect(check.reasons.join(" ")).toContain("drift");
	});
});
