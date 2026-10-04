import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_LIMITS } from "../../../src/core/limits.ts";
import { createRuntime, type Runtime } from "../../../src/core/runtime.ts";
import type { DiagnosticEvent } from "../../../src/core/types.ts";
import { evaluateRun } from "../../performance/aggregate.ts";
import {
	CONTROL_BOUNDS,
	controlBounds,
} from "../../performance/lib/control.ts";
import type { RawRecord } from "../../performance/lib/evidence.ts";
import {
	controlIds,
	deriveControlFlow,
	type HwmKey,
	highWater,
	LIMITS,
	PREDATES_CONTROL_FLOW,
	Recorded,
	type RuntimeStatsLike,
	recordControlFlow,
	SAMPLED_ONLY,
} from "../../performance/lib/record.ts";
import type { BudgetRow } from "../../performance/lib/stats.ts";
import { ManualClock, settle } from "../core/helpers/clock.ts";
import { RawPage } from "../core/helpers/page.ts";
import { createTestAdapter } from "../core/helpers/test-adapter.ts";

// Headroom gates use outbox failure bounds; posted-window occupancy is informational. These records are synthetic unless a case drives the runtime.

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

describe("control outbox bounds", () => {
	it("derive from DEFAULT_LIMITS: window 64, 2 128 messages, 16 MiB", () => {
		expect(CONTROL_BOUNDS).toEqual({
			window: 64,
			queued: 2 * (1_000 + 64),
			queuedBytes: 64 * 256 * 1024,
		});
		expect(controlBounds(DEFAULT_LIMITS)).toEqual(CONTROL_BOUNDS);
		expect(
			controlBounds({ ...DEFAULT_LIMITS, maxMessageBytes: 1024 }).queuedBytes,
		).toBe(64 * 1024);
	});

	it("LIMITS keep every existing value and add the outbox bounds", () => {
		expect(LIMITS).toEqual({
			pendingMessages: 256,
			pendingBytes: 1024 * 1024,
			perConsumerMessages: 64,
			perConsumerBytes: 256 * 1024,
			pendingCommands: 64,
			controlMessages: 64,
			controlQueued: 2_128,
			controlQueuedBytes: 16 * 1024 * 1024,
			subscriptions: 1_000,
			consumersPerAttachment: 1_000,
			connections: 32,
		});
	});
});

const runtimes: Runtime[] = [];
const pages: RawPage[] = [];
afterEach(() => {
	for (const runtime of runtimes.splice(0)) runtime.dispose();
	for (const page of pages.splice(0)) page.port.close();
});

function setup() {
	const clock = new ManualClock();
	const test = createTestAdapter();
	const diagnostics: DiagnosticEvent[] = [];
	const runtime = createRuntime({
		adapters: [test.adapter],
		clock,
		diagnostics: (event) => diagnostics.push(event),
	});
	runtimes.push(runtime);
	return { clock, test, runtime, diagnostics };
}

async function subscribedPage(
	{ runtime, clock, test }: ReturnType<typeof setup>,
	fields = {},
) {
	const raw = new RawPage(runtime);
	pages.push(raw);
	raw.hello(fields);
	await settle(clock);
	raw.subscribe("1", {});
	await settle(clock);
	const ctx = test.connections[0]?.ctx;
	if (!ctx) throw new Error("no connection");
	return { raw, ctx };
}

const expiries = (diagnostics: DiagnosticEvent[]) =>
	diagnostics.filter((event) => event.type === "attachment-expired");

describe("the tooling's bounds are the runtime's (queuedControlCap and byte cap)", () => {
	it("count: CONTROL_BOUNDS.queued queued without expiry, one more expires (control-queue)", async () => {
		const context = setup();
		const { runtime, clock, diagnostics } = context;
		const { raw, ctx } = await subscribedPage(context);
		// The subscribe snapshot is posted; these fill the window, then the outbox.
		const changes = CONTROL_BOUNDS.window + CONTROL_BOUNDS.queued - 1;
		for (let attempt = 1; attempt <= changes; attempt += 1) {
			ctx.setStatus({ state: "reconnecting", reason: "network", attempt });
		}
		await settle(clock);
		expect(raw.ofType("detached")).toHaveLength(0);
		expect(
			runtime.stats().perAttachment.find((entry) => entry.a === raw.a),
		).toMatchObject({
			pendingControl: CONTROL_BOUNDS.window,
			queuedControl: CONTROL_BOUNDS.queued,
		});
		ctx.setStatus({ state: "connected" });
		await settle(clock);
		expect(raw.ofType("detached")).toEqual([
			expect.objectContaining({ code: "attachment-expired" }),
		]);
		expect(expiries(diagnostics)).toEqual([
			expect.objectContaining({
				detail: { reason: "attachment-expired", cause: "control-queue" },
			}),
		]);
		expect(runtime.stats().hwm).toMatchObject({
			controlMessages: CONTROL_BOUNDS.window,
			controlQueued: CONTROL_BOUNDS.queued,
		});
		expect(runtime.stats().expired).toBe(1);
	});

	it("bytes: expiry when queued content would exceed maxControlMessages × maxMessageBytes", async () => {
		const context = setup();
		const { runtime, clock, diagnostics } = context;
		// The page tightens its own maxMessageBytes, so the byte bound binds first.
		const limits = { ...DEFAULT_LIMITS, maxMessageBytes: 1024 };
		const bound = controlBounds(limits).queuedBytes;
		const { raw, ctx } = await subscribedPage(context, {
			limits: { maxMessageBytes: limits.maxMessageBytes },
		});
		const code = "c".repeat(300);
		for (
			let attempt = 1;
			attempt <= CONTROL_BOUNDS.window + 200;
			attempt += 1
		) {
			ctx.setStatus({
				state: "reconnecting",
				reason: "network",
				attempt,
				code,
			});
		}
		await settle(clock);
		expect(raw.ofType("detached")).toHaveLength(1);
		expect(expiries(diagnostics)).toEqual([
			expect.objectContaining({
				detail: { reason: "attachment-expired", cause: "control-queue" },
			}),
		]);
		const { controlQueued, controlQueuedBytes } = runtime.stats().hwm;
		expect(controlQueued).toBeLessThan(controlBounds(limits).queued);
		// Never above the bound, and expired only because the next message
		// (about one average message) would not fit under it.
		expect(controlQueuedBytes).toBeLessThanOrEqual(bound);
		const perMessage = controlQueuedBytes / controlQueued;
		expect(bound - controlQueuedBytes).toBeLessThan(2 * perMessage);
		// A bound half as large would have expired long before this peak.
		expect(controlQueuedBytes).toBeGreaterThan(bound / 2);
	});
});

const hwmOf = (values: Partial<Record<HwmKey, number>>) =>
	highWater([{ hwm: values } as unknown as RuntimeStatsLike]);

function finalStats(
	overrides: Partial<RuntimeStatsLike> = {},
	attachment: Partial<RuntimeStatsLike["perAttachment"][number]> = {},
): RuntimeStatsLike {
	return {
		id: "runtime",
		attachments: 1,
		consumers: 100,
		ledgers: 100,
		pendingMessages: 0,
		pendingBytes: 0,
		connections: 1,
		subscriptions: 100,
		pendingCommands: 0,
		pendingCredentialRequests: 0,
		expired: 0,
		perAttachment: [
			{
				consumers: 100,
				ledgers: 100,
				pendingMessages: 0,
				pendingBytes: 0,
				pendingControl: 0,
				queuedControl: 0,
				queuedControlBytes: 0,
				queuedData: 0,
				queuedDataBytes: 0,
				...attachment,
			},
		],
		diagnostics: [],
		...overrides,
	};
}

describe("recordControlFlow", () => {
	const ids = controlIds("ws.n5");

	it("records posted occupancy, expiries and control left queued", () => {
		const out = new Recorded();
		const detail = recordControlFlow(
			out,
			hwmOf({ controlMessages: 64, controlQueued: 37 }),
			finalStats({
				diagnostics: [
					{ type: "attachment-expired", detail: { cause: "control-stalled" } },
					{ type: "other" },
				],
			}),
			"ws.n5",
		);
		expect(out.metrics).toEqual({
			[ids.posted]: 64,
			[ids.expired]: 0,
			[ids.queuedAtEnd]: 0,
		});
		expect(out.notMeasured).toEqual({});
		expect(detail.bounds).toEqual(CONTROL_BOUNDS);
		expect(detail.expiredCauses).toEqual({ "control-stalled": 1 });
		expect(detail.atEnd).toEqual({
			pendingControl: 0,
			queuedControl: 0,
			queuedControlBytes: 0,
			queuedData: 0,
			queuedDataBytes: 0,
		});
	});

	it("never lets expiries the history does not explain read as no causes", () => {
		// The runtime keeps diagnostic history only when its sink is configured;
		// a fixture without one, or a ring shorter than the expiry count, must
		// surface as `unattributed`, not as an empty cause map.
		const out = new Recorded();
		const none = recordControlFlow(
			out,
			hwmOf({ controlMessages: 64 }),
			finalStats({ expired: 2, diagnostics: [] }),
			"ws.n5",
		);
		expect(out.metrics[ids.expired]).toBe(2);
		expect(none.expiredCauses).toEqual({ unattributed: 2 });
		const partial = recordControlFlow(
			new Recorded(),
			hwmOf({ controlMessages: 64 }),
			finalStats({
				expired: 3,
				diagnostics: [
					{ type: "attachment-expired", detail: { cause: "control-queue" } },
				],
			}),
			"ws.n5",
		);
		expect(partial.expiredCauses).toEqual({
			"control-queue": 1,
			unattributed: 2,
		});
		const complete = recordControlFlow(
			new Recorded(),
			hwmOf({ controlMessages: 64 }),
			finalStats({
				expired: 1,
				diagnostics: [
					{ type: "attachment-expired", detail: { cause: "control-stalled" } },
				],
			}),
			"ws.n5",
		);
		expect(complete.expiredCauses).toEqual({ "control-stalled": 1 });
	});

	it("the bench runtimes opt in to diagnostic history, so expiredCauses cannot be a silent false zero", () => {
		for (const file of ["bench.worker.ts", "local.ts"]) {
			const source = readFileSync(
				new URL(`../../fixtures/harness/src/bench/${file}`, import.meta.url),
				"utf8",
			);
			expect(
				source,
				`${file} must pass a diagnostics sink to createRuntime: the recorder reads expiredCauses from the runtime's retained history`,
			).toMatch(/createRuntime\(\{[^}]*\bdiagnostics:/s);
		}
	});

	it("never turns a missing counter or field into zero", () => {
		const out = new Recorded();
		const final = finalStats({}, { queuedControl: undefined });
		delete final.expired;
		recordControlFlow(out, hwmOf({ controlMessages: 64 }), final, "ws.n5");
		expect(out.metrics).toEqual({ [ids.posted]: 64 });
		expect(out.notMeasured[ids.expired]).toMatch(/no expired counter/);
		expect(out.notMeasured[ids.queuedAtEnd]).toMatch(/no perAttachment/);
		const none = new Recorded();
		recordControlFlow(none, hwmOf({}), undefined, "ws.n5");
		expect(none.metrics).toEqual({});
	});

	it("keeps sampled occupancy out of the gate id", () => {
		const out = new Recorded();
		recordControlFlow(
			out,
			highWater([finalStats({}, { pendingControl: 40 })]),
			finalStats(),
			"ws.n5",
		);
		expect(out.notMeasured[ids.posted]).toBe(SAMPLED_ONLY);
		expect(out.metrics[ids.postedSampled]).toBe(40);
	});
});

/** The four shared configs' runtime hwm in root smoke-1. */
const SMOKE_1 = [
	["graphql-ws", 1, 37, 8_140],
	["graphql-ws", 5, 37, 8_582],
	["ws", 1, 36, 6_876],
	["ws", 5, 37, 7_538],
] as const;

function tabRecord(
	variant: string,
	n: number,
	values: Partial<Record<HwmKey, number>>,
	extra: { metrics?: RawRecord["metrics"]; detail?: object } = {},
): RawRecord {
	const at = `${variant}.n${n}`;
	return {
		schema: 1,
		run: "SYNTHETIC",
		rep: "01",
		profile: "smoke",
		project: "chromium-perf",
		scenario: "tabs",
		config: `spinetab-${variant}-n${n}`,
		writtenAt: `2026-09-27T00:00:0${n}.000Z`,
		metrics: {
			[`tabs.${variant}.spinetab.n${n}.lost`]: 0,
			// What the pre-point-32 scenario wrote: 64 ÷ posted hwm.
			[`headroom.${at}.controlMessages`]:
				64 / Math.max(values.controlMessages ?? 1, 1),
			...extra.metrics,
		},
		detail: {
			config: { kind: "spinetab", variant, n },
			hwm: { source: "runtime", values },
			...extra.detail,
		},
	};
}

const smokeRecords = () =>
	SMOKE_1.map(([variant, n, queued, bytes]) =>
		tabRecord(variant, n, {
			controlMessages: 64,
			controlQueued: queued,
			controlQueuedBytes: bytes,
		}),
	);

const SMOKE_ENV = { schema: 1, run: "SYNTHETIC", profile: "smoke" };
const statusOf = (run: ReturnType<typeof evaluateRun>, id: string) => {
	const found = run.evaluated.find(({ row }) => row.id === id);
	if (!found) throw new Error(`no row ${id}`);
	return found.evaluation;
};

describe("deriveControlFlow", () => {
	it("re-derives outbox headroom and posted occupancy from a retained runtime hwm", () => {
		const [record] = smokeRecords();
		if (!record) throw new Error("no record");
		const before = structuredClone(record);
		const { record: derived, derived: ids } = deriveControlFlow(record);
		expect(record).toEqual(before);
		expect(ids).toEqual([
			"headroom.graphql-ws.n1.controlQueued",
			"headroom.graphql-ws.n1.controlQueuedBytes",
			"control.graphql-ws.n1.posted",
		]);
		expect(derived.metrics["headroom.graphql-ws.n1.controlQueued"]).toBe(
			2_128 / 37,
		);
		expect(derived.metrics["headroom.graphql-ws.n1.controlQueuedBytes"]).toBe(
			(16 * 1024 * 1024) / 8_140,
		);
		expect(derived.metrics["control.graphql-ws.n1.posted"]).toBe(64);
		// A high-water mark cannot prove a drain or the absence of expiry.
		expect(derived.notMeasured).toEqual({
			"control.graphql-ws.n1.expired": PREDATES_CONTROL_FLOW,
			"control.graphql-ws.n1.queued-at-end": PREDATES_CONTROL_FLOW,
		});
	});

	it("leaves a record that already has the ids, and other records, as they are", () => {
		const current = tabRecord(
			"ws",
			5,
			{ controlMessages: 64, controlQueued: 37 },
			{
				metrics: {
					"headroom.ws.n5.controlQueued": 1,
					"headroom.ws.n5.controlQueuedBytes": 1,
					"control.ws.n5.posted": 99,
					"control.ws.n5.expired": 0,
					"control.ws.n5.queued-at-end": 0,
				},
				detail: { controlFlow: {} },
			},
		);
		expect(deriveControlFlow(current)).toEqual({
			record: current,
			derived: [],
		});
		for (const other of [
			{ ...current, scenario: "heap" },
			{ ...current, detail: { config: { kind: "independent" } } },
			{
				...current,
				detail: {
					config: { kind: "spinetab", variant: "ws", n: 5, attribution: true },
					hwm: { source: "runtime", values: { controlQueued: 1 } },
				},
			},
			{
				...current,
				detail: {
					config: { kind: "spinetab", variant: "ws", n: 5 },
					hwm: { source: "runtime", values: { controlQueued: "37" } },
				},
			},
		]) {
			expect(deriveControlFlow(other).derived).toEqual([]);
			expect(deriveControlFlow(other).record).toBe(other);
		}
	});

	it("never derives a gate value from a sampled hwm", () => {
		const record = tabRecord("ws", 1, { controlQueued: 36 });
		(record.detail as { hwm: { source: string } }).hwm.source = "sampled";
		const { record: derived, derived: ids } = deriveControlFlow(record);
		expect(ids).toEqual(["headroom.sampled.ws.n1.controlQueued"]);
		expect(derived.notMeasured?.["headroom.ws.n1.controlQueued"]).toBe(
			SAMPLED_ONLY,
		);
	});
});

describe("headroom against the control outbox bounds (smoke-1 shaped records)", () => {
	const run = evaluateRun({
		records: smokeRecords(),
		environment: SMOKE_ENV,
		rows: budgets.rows,
	});

	it("passes ≥ 4× against the count and byte bounds, minimum across configs", () => {
		expect(statusOf(run, "headroom.controlQueued")).toMatchObject({
			status: "pass",
			measured: 2_128 / 37,
		});
		expect(statusOf(run, "headroom.controlQueuedBytes")).toMatchObject({
			status: "pass",
			measured: (16 * 1024 * 1024) / 8_582,
		});
	});

	it("reports the full posted window as occupancy, never as a failed headroom", () => {
		expect(statusOf(run, "headroom.controlMessages")).toMatchObject({
			status: "informational",
			measured: 1,
		});
		expect(statusOf(run, "control.posted")).toMatchObject({
			status: "pass",
			measured: 64,
		});
	});

	it("keeps no-loss gating and states that drain and expiry were not retained", () => {
		for (const [variant, n] of SMOKE_1) {
			expect(statusOf(run, `tabs.${variant}.spinetab.n${n}.lost`).status).toBe(
				"pass",
			);
		}
		for (const id of ["control.expired", "control.queued-at-end"]) {
			expect(statusOf(run, id)).toMatchObject({
				status: "not-measured",
				reason: PREDATES_CONTROL_FLOW,
			});
		}
		expect(Object.keys(run.derived.records)).toHaveLength(4);
		expect(run.counts.fail).toBeUndefined();
	});

	it("mutation: without the outbox rows the old posted-window gate flags 1× again", () => {
		const posted = budget("headroom.controlMessages");
		const outbox = new Set([
			"headroom.controlQueued",
			"headroom.controlQueuedBytes",
			"control.posted",
			"control.expired",
			"control.queued-at-end",
		]);
		const mutated = budgets.rows
			.filter((row) => !outbox.has(row.id))
			.map((row) =>
				row.id === posted.id ? ({ ...row, role: "gate" } as BudgetRow) : row,
			);
		const old = evaluateRun({
			records: smokeRecords(),
			environment: SMOKE_ENV,
			rows: mutated,
		});
		expect(statusOf(old, "headroom.controlMessages")).toMatchObject({
			status: "fail",
			measured: 1,
			reason: "1 of 1 run(s) violate >= 4",
		});
	});

	it.each([
		[
			"count headroom below 4×",
			{ controlQueued: 600 },
			"headroom.controlQueued",
		],
		[
			"byte headroom below 4×",
			{ controlQueuedBytes: 5 * 1024 * 1024 },
			"headroom.controlQueuedBytes",
		],
		["posted above the window", { controlMessages: 65 }, "control.posted"],
	])("negative control: %s fails", (_name, override, id) => {
		const records = smokeRecords();
		records[3] = tabRecord("ws", 5, {
			controlMessages: 64,
			controlQueued: 37,
			controlQueuedBytes: 7_538,
			...override,
		});
		const result = evaluateRun({
			records,
			environment: SMOKE_ENV,
			rows: budgets.rows,
		});
		expect(statusOf(result, id).status).toBe("fail");
	});

	it.each([
		["an expired attachment", "expired", 1],
		["control left queued", "queued-at-end", 2],
	])("negative control: %s fails its structural row", (_name, suffix, value) => {
		const records = smokeRecords().map((record) => {
			const at = `${(record.detail as { config: { variant: string } }).config.variant}.n${
				(record.detail as { config: { n: number } }).config.n
			}`;
			return {
				...record,
				metrics: {
					...record.metrics,
					[`control.${at}.expired`]: 0,
					[`control.${at}.queued-at-end`]: 0,
					...(at === "ws.n1" ? { [`control.${at}.${suffix}`]: value } : {}),
				},
				detail: { ...(record.detail as object), controlFlow: {} },
			};
		});
		const result = evaluateRun({
			records,
			environment: SMOKE_ENV,
			rows: budgets.rows,
		});
		expect(statusOf(result, `control.${suffix}`)).toMatchObject({
			status: "fail",
			measured: value,
		});
	});
});

describe("budgets.json control rows", () => {
	it("keeps headroom.controlMessages informational with its existing target", () => {
		const posted = budget("headroom.controlMessages");
		expect(posted).toMatchObject({
			comparator: ">=",
			target: 4,
			kind: "structural",
			role: "informational",
		});
	});

	it("gates the outbox at ≥ 4× and the window, expiry and drain structurally", () => {
		for (const id of [
			"headroom.controlQueued",
			"headroom.controlQueuedBytes",
		]) {
			expect(budget(id)).toMatchObject({
				comparator: ">=",
				target: 4,
				targetState: "provisional",
				kind: "structural",
				gate: "all",
			});
		}
		expect(budget("control.posted")).toMatchObject({
			comparator: "<=",
			target: DEFAULT_LIMITS.maxControlMessages,
		});
		expect(budget("control.expired")).toMatchObject({
			comparator: "==",
			target: 0,
		});
		expect(budget("control.queued-at-end")).toMatchObject({
			comparator: "==",
			target: 0,
		});
	});

	it("is wired into the tab-scaling scenario", () => {
		const source = readFileSync(
			new URL("../../performance/tabs.perf.ts", import.meta.url),
			"utf8",
		);
		expect(source).toContain("recordHighWater(out, hwm, headroomRows(at));");
		expect(source).toContain("detail.controlFlow = recordControlFlow(");
	});
});
