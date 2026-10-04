import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	type Census,
	handlesRange,
	outstanding,
	QUIESCENCE,
	type QuiescencePort,
	quiesce,
	type RealmCensus,
	timerDelta,
} from "../../performance/lib/quiescence.ts";
import {
	Recorded,
	type RuntimeStatsLike,
} from "../../performance/lib/record.ts";
import { type BudgetRow, evaluateRow } from "../../performance/lib/stats.ts";

// Pause and drain the simulated bench before counting persistent handles; negative controls retain an extra timer or listener.

const budgets = JSON.parse(
	readFileSync(
		new URL("../../performance/budgets.json", import.meta.url),
		"utf8",
	),
) as { rows: BudgetRow[] };
const budget = (id: string) => {
	const found = budgets.rows.find((row) => row.id === id);
	if (!found) throw new Error(`no budget row ${id}`);
	return found;
};

interface BenchModel {
	topics: number;
	/** Persistent page timers per active subscription (a real defect). */
	timersPerTopic?: number;
	/** Handles left behind by earlier cycles (a real leak). */
	leakedTimers?: number;
	leakedListeners?: number;
	/** Acknowledgements never reach the runtime. */
	stuckAcks?: boolean;
	/** The pause fault is not applied. */
	ignorePause?: boolean;
}

/**
 * One simulated tab. Each `stats()` read advances one task: a live
 * zero-delay ack timer fires and flushes, in-flight events are delivered and
 * arm it, and unpaused emission sends more (100 topics every task, 1 topic
 * every 100th task).
 */
function simulatedBench(model: BenchModel) {
	let paused = false;
	let task = 0;
	let emitted = 0;
	let delivered = 0;
	let inFlight = 0;
	let unacked = 0;
	let ackTimer = false;
	const advance = () => {
		if (ackTimer) {
			ackTimer = false;
			if (!model.stuckAcks) unacked = 0;
		}
		if (inFlight > 0) {
			delivered += inFlight;
			unacked += inFlight;
			inFlight = 0;
			ackTimer = true;
		}
		if (
			(!paused || model.ignorePause) &&
			(task * model.topics) % 100 < model.topics
		) {
			emitted += model.topics;
			inFlight += model.topics;
		}
		task += 1;
	};
	const stats = (): RuntimeStatsLike => ({
		id: "runtime",
		attachments: 1,
		consumers: model.topics,
		ledgers: model.topics,
		pendingMessages: unacked + inFlight,
		pendingBytes: (unacked + inFlight) * 1_024,
		connections: 1,
		subscriptions: model.topics,
		pendingCommands: 0,
		pendingCredentialRequests: 0,
		perAttachment: [
			{
				consumers: model.topics,
				ledgers: model.topics,
				pendingMessages: unacked + inFlight,
				pendingBytes: (unacked + inFlight) * 1_024,
				pendingControl: 0,
				queuedControl: 0,
				queuedData: 0,
			},
		],
		diagnostics: [],
	});
	const census = (): RealmCensus => ({
		page: {
			timers:
				1 +
				(ackTimer ? 1 : 0) +
				(model.timersPerTopic ?? 0) * model.topics +
				(model.leakedTimers ?? 0),
			listeners: 23 + (model.leakedListeners ?? 0),
		},
		worker: { timers: 2, listeners: 4 },
	});
	const port: QuiescencePort = {
		pause: async () => {
			paused = true;
		},
		resume: async () => {
			paused = false;
		},
		emitted: async () => emitted,
		delivered: async () => delivered,
		stats: async () => {
			advance();
			return stats();
		},
		census: async () => census(),
	};
	return {
		port,
		model,
		get paused() {
			return paused;
		},
		/** heap.perf.ts windowMax under traffic: the old row input. */
		activeMax(samples = 30): Census {
			let timers = 0;
			let listeners = 0;
			for (let index = 0; index < samples; index += 1) {
				advance();
				const { page } = census();
				timers = Math.max(timers, page.timers);
				listeners = Math.max(listeners, page.listeners);
			}
			return { timers, listeners };
		},
	};
}

function virtualClock() {
	let at = 0;
	return {
		now: () => at,
		sleep: async (ms: number) => {
			at += ms;
		},
	};
}

async function settled(port: QuiescencePort) {
	const result = await quiesce(port, virtualClock());
	if (!result.ok) throw new Error(result.reason);
	return result;
}

/** heap.perf.ts: a row is put when quiescent, else skipped with the reason. */
function evaluated(id: string, value: number | { reason: string }) {
	const out = new Recorded();
	if (typeof value === "number") out.put(id, value);
	else out.skip(id, value.reason);
	const runs = id in out.metrics ? [out.metrics[id] as number] : [];
	return { out, evaluation: evaluateRow(budget(id), runs) };
}

describe("outstanding runtime work", () => {
	it("is empty only when nothing is posted-unacknowledged, queued or pending", () => {
		const clean: RuntimeStatsLike = {
			id: "r",
			attachments: 1,
			consumers: 0,
			ledgers: 0,
			pendingMessages: 0,
			pendingBytes: 0,
			connections: 1,
			subscriptions: 0,
			pendingCommands: 0,
			pendingCredentialRequests: 0,
			perAttachment: [
				{
					consumers: 0,
					ledgers: 0,
					pendingMessages: 0,
					pendingBytes: 0,
					pendingControl: 0,
				},
			],
			diagnostics: [],
		};
		expect(outstanding(clean)).toEqual([]);
		const attachment = clean
			.perAttachment[0] as RuntimeStatsLike["perAttachment"][number];
		expect(
			outstanding({
				...clean,
				pendingMessages: 2,
				pendingBytes: 10,
				pendingCommands: 1,
				pendingCredentialRequests: 1,
				perAttachment: [
					{ ...attachment, pendingControl: 3, queuedControl: 4, queuedData: 5 },
				],
			}),
		).toEqual([
			"pendingMessages=2",
			"pendingBytes=10",
			"pendingCommands=1",
			"pendingCredentialRequests=1",
			"perAttachment[0].pendingControl=3",
			"perAttachment[0].queuedControl=4",
			"perAttachment[0].queuedData=5",
		]);
	});
});

describe("quiescent liveness census (handles.o1.*)", () => {
	it("separates the shared transient ack timer from persistent handles", async () => {
		const one = simulatedBench({ topics: 1 });
		const hundred = simulatedBench({ topics: 100 });
		// Under traffic the old window maximum sees the ack timer at 100 topics.
		one.activeMax();
		expect(hundred.activeMax().timers).toBe(2);
		const from = await settled(one.port);
		const to = await settled(hundred.port);
		// Quiescent: exactly the heartbeat in both states.
		expect(from.census.page).toEqual({ timers: 1, listeners: 23 });
		expect(to.census.page).toEqual({ timers: 1, listeners: 23 });
		expect(to.stats.pendingMessages).toBe(0);
		expect(one.paused).toBe(false);
		expect(hundred.paused).toBe(false);
		for (const realm of ["page", "worker"] as const) {
			const id = `handles.o1.graphql-ws.${realm}.timers`;
			const value = timerDelta(from.census[realm], to.census[realm]);
			expect(value).toBe(0);
			expect(evaluated(id, value).evaluation.status).toBe("pass");
		}
	});

	it("negative control: a persistent timer per subscription still fails", async () => {
		const one = simulatedBench({ topics: 1, timersPerTopic: 1 });
		const hundred = simulatedBench({ topics: 100, timersPerTopic: 1 });
		one.activeMax();
		hundred.activeMax();
		const from = await settled(one.port);
		const to = await settled(hundred.port);
		expect(from.census.page.timers).toBe(2);
		expect(to.census.page.timers).toBe(101);
		const value = timerDelta(from.census.page, to.census.page);
		expect(value).toBe(99);
		const { evaluation } = evaluated("handles.o1.ws.page.timers", value);
		expect(evaluation.status).toBe("fail");
		expect(evaluation.measured).toBe(99);
	});
});

describe("quiescent history census (history.*.handles-range)", () => {
	const checkpoints = async (leak: (cycle: number) => Partial<BenchModel>) => {
		const censuses: Census[] = [];
		for (let cycle = 0; cycle < 5; cycle += 1) {
			const bench = simulatedBench({ topics: 100, ...leak(cycle) });
			// Traffic before each checkpoint, as in the 5 min history window.
			bench.activeMax(10);
			censuses.push((await settled(bench.port)).census.page);
		}
		return censuses;
	};

	it("is flat when only the transient ack timer varies under traffic", async () => {
		const value = handlesRange(await checkpoints(() => ({})));
		expect(value).toBe(0);
		expect(
			evaluated("history.ws.page.handles-range", value).evaluation.status,
		).toBe("pass");
	});

	it("negative control: a cycle leaving one timer still fails", async () => {
		const value = handlesRange(
			await checkpoints((cycle) => ({ leakedTimers: cycle })),
		);
		expect(value).toBe(4);
		expect(
			evaluated("history.ws.page.handles-range", value).evaluation.status,
		).toBe("fail");
	});

	it("negative control: a single leaked listener still fails", async () => {
		const value = handlesRange(
			await checkpoints((cycle) => ({ leakedListeners: cycle === 4 ? 1 : 0 })),
		);
		expect(value).toBe(1);
		expect(
			evaluated("history.graphql-ws.page.handles-range", value).evaluation
				.status,
		).toBe("fail");
	});
});

describe("quiescence fails closed", () => {
	it("records not measured with the reason when acks never drain", async () => {
		const bench = simulatedBench({ topics: 100, stuckAcks: true });
		bench.activeMax(10);
		const clock = virtualClock();
		const result = await quiesce(bench.port, clock);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toMatch(
			/^quiescence not reached within 15000 ms: runtime still holds pendingMessages=\d+/,
		);
		expect(result.elapsedMs).toBeLessThanOrEqual(QUIESCENCE.boundMs);
		expect(bench.paused).toBe(false);
		const { out, evaluation } = evaluated("handles.o1.ws.page.timers", result);
		expect(out.metrics).toEqual({});
		expect(out.notMeasured["handles.o1.ws.page.timers"]).toBe(result.reason);
		expect(evaluation.status).toBe("not-measured");
	});

	it("records not measured when emission does not stop", async () => {
		const result = await quiesce(
			simulatedBench({ topics: 100, ignorePause: true }).port,
			virtualClock(),
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		// Traffic keeps acks in flight, so the runtime never reads as drained.
		expect(result.reason).toMatch(/quiescence not reached within 15000 ms/);
	});

	it("records not measured when the census keeps changing", async () => {
		const bench = simulatedBench({ topics: 1 });
		let flip = 0;
		const port: QuiescencePort = {
			...bench.port,
			census: async () => ({
				page: { timers: 1 + (flip++ % 2), listeners: 23 },
				worker: { timers: 2, listeners: 4 },
			}),
		};
		const result = await quiesce(port, { ...virtualClock(), boundMs: 2_000 });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe(
			"quiescence not reached within 2000 ms: emission, delivery or handle census still changing (1 of 5 identical reads)",
		);
		expect(result.reads).toBeLessThanOrEqual(21);
	});

	it("resumes emission when a read throws", async () => {
		const bench = simulatedBench({ topics: 1 });
		const port: QuiescencePort = {
			...bench.port,
			census: async () => {
				throw new Error("page closed");
			},
		};
		await expect(quiesce(port, virtualClock())).rejects.toThrow("page closed");
		expect(bench.paused).toBe(false);
	});
});
