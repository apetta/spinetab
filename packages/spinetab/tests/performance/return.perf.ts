import { expect, type Page, test } from "@playwright/test";
import type {
	TimedState,
	TimedStatusEntry,
} from "../fixtures/harness/src/bench/timed.ts";
import type { BenchWindow } from "../fixtures/harness/src/bench/types.ts";
import {
	ALL_TOPICS,
	benchState,
	calibrateRealm,
	clearFault,
	openPage,
	recordEnvironment,
	resetFixture,
	setFault,
	settings,
	sleep,
	startPage,
	VARIANTS,
	type Variant,
	waitFor,
	waitForCounts,
} from "./lib/bench.ts";
import { rep } from "./lib/evidence.ts";
import { derivePhases, type Phases } from "./lib/phases.ts";
import { withRecord } from "./lib/record.ts";

// Return to service after confirmed return.
// Trial: 100 topics; fault `stall` (half-open existing sockets; new ones
// healthy) until tab 0 sees 2 s without events; clear the fault; confirmed
// return t0 = `checkHealth("fixture-return")` or a synthetic `online` event
// (exercises the 250 ms coalescing). Health start = the runtime's adapter
// `probe()` call (timed.ts), calibrated to the page clock. Contrast trials use
// `terminate`. Package defaults throughout (no shortened heartbeats). The
// stall period is recorded separately and excluded. Each trial also records
// the adapter status log and derived, informational recovery phases
// (lib/phases.ts); they are not rows, gates or budgets.

type W = BenchWindow;
type Hint = "check-health" | "online";
type Fault = "stall" | "terminate";
const S = settings();
/** Hint-triggered probes are spaced ≥ 5 s per connection (runtime default). */
const TRIAL_SPACING_MS = 6_000;
const RESTORE_TIMEOUT_MS = 30_000;
/** Runtime adapter kind per bench variant (timed.ts logs by adapter kind). */
const ADAPTER_KIND: Record<Variant, string> = {
	"graphql-ws": "graphql-ws",
	ws: "websocket",
};

interface Trial {
	faultAt: number;
	quietFor: number;
	t0: number;
	healthStart: number;
	firstEvent: number;
	restored: number;
	selfHealedBeforeReturn: boolean;
	probes: number;
	continuity: string[];
	/** Derived, informational; never a row or gate. */
	phases: Phases;
	/** Raw status log (worker clock, all adapters, cumulative for the page). */
	statuses: TimedStatusEntry[];
}

async function stamp(page: Page): Promise<number> {
	return page.evaluate(() => performance.timeOrigin + performance.now());
}

async function trial(
	page: Page,
	request: Parameters<typeof setFault>[0],
	variant: Variant,
	hint: Hint,
	fault: Fault,
	offset: number,
): Promise<Trial> {
	const faultAt = await stamp(page);
	await setFault(request, fault);
	if (fault === "stall") {
		// Wait for 2 s without events on tab 0.
		await waitFor(
			async () => {
				const [last, at] = await page.evaluate(() => [
					(window as unknown as W).bench.lastEventAt(),
					performance.timeOrigin + performance.now(),
				]);
				return (at as number) - (last as number);
			},
			(quiet) => quiet >= 2_000,
			"2 s without events after the stall",
			20_000,
			50,
		);
	}
	await clearFault(request, fault);
	const before = await page.evaluate(() =>
		(window as unknown as W).bench.lastEventAt(),
	);
	const selfHealedBeforeReturn = fault === "stall" && before > faultAt + 2_000;

	// Confirmed return: arm the page recorder, then send the hint.
	const t0 = await page.evaluate(
		async ([kind]) => {
			const api = (window as unknown as W).bench;
			if (kind === "online") {
				const at = api.arm();
				api.online();
				return at;
			}
			const at = api.arm();
			void api.checkHealth("fixture-return");
			return at;
		},
		[hint] as const,
	);
	const restoredAt = await waitFor(
		() =>
			page.evaluate(
				(topics) => (window as unknown as W).bench.firstAfter(topics),
				ALL_TOPICS,
			),
		(value) => value.missing === 0,
		"all 100 topics delivering after return",
		RESTORE_TIMEOUT_MS,
		25,
	).catch(() => undefined);
	const firstAfter =
		restoredAt ??
		(await page.evaluate(
			(topics) => (window as unknown as W).bench.firstAfter(topics),
			ALL_TOPICS,
		));
	const timed = (
		await page.evaluate(() =>
			(window as unknown as W).bench.realm<TimedState>("timed"),
		)
	).value;
	// Worker clock → page clock: remote − offset.
	const probe = timed.probes
		.map((entry) => entry.at - offset)
		.find((at) => at >= t0);
	const summary = await page.evaluate(() =>
		(window as unknown as W).bench.summary(),
	);
	const phases = derivePhases({
		t0,
		offset,
		faultAt,
		statuses: timed.statuses,
		probes: timed.probes,
		firstEvent: firstAfter.first,
		restored: firstAfter.all,
		adapter: ADAPTER_KIND[variant],
	});
	return {
		faultAt,
		quietFor: t0 - faultAt,
		t0,
		healthStart: probe === undefined ? Number.NaN : probe - t0,
		firstEvent: Number.isNaN(firstAfter.first)
			? Number.NaN
			: firstAfter.first - t0,
		restored: Number.isNaN(firstAfter.all) ? Number.NaN : firstAfter.all - t0,
		selfHealedBeforeReturn,
		probes: timed.probes.length,
		continuity: [
			...new Set(
				summary.continuity.map((entry) =>
					entry ? `${entry.state}/${entry.reason ?? ""}` : "none",
				),
			),
		],
		phases,
		statuses: timed.statuses,
	};
}

interface ReturnConfig {
	variant: Variant;
	hint: Hint;
	fault: Fault;
	pongTimeoutMs?: number;
}

const configs: ReturnConfig[] = [];
for (const variant of VARIANTS) {
	for (const hint of ["check-health", "online"] as const) {
		for (const fault of ["stall", "terminate"] as const) {
			configs.push({ variant, hint, fault });
		}
	}
}
// Sensitivity row: graphql-ws with a 2 s pong deadline.
configs.push({
	variant: "graphql-ws",
	hint: "check-health",
	fault: "stall",
	pongTimeoutMs: 2_000,
});

for (const config of configs) {
	const name = `${config.variant}.${config.pongTimeoutMs ? `pong${config.pongTimeoutMs}.` : ""}${config.hint}.${config.fault}`;
	const smokeTag =
		config.variant === "ws" &&
		config.hint === "check-health" &&
		config.fault === "stall" &&
		!config.pongTimeoutMs;
	test(
		`return ${name}`,
		{ tag: smokeTag ? ["@pinned", "@smoke"] : ["@pinned"] },
		async ({ browser, request }, testInfo) => {
			test.setTimeout(90_000 + S.returnTrials * 60_000);
			await recordEnvironment(browser, testInfo);
			await resetFixture(request);
			const ids = ["health-start", "first-event", "restored"].map(
				(metric) => `return.${name}.${metric}`,
			);
			await withRecord(
				testInfo,
				{ scenario: "return", config: name, expected: ids },
				async (out, detail) => {
					const context = await browser.newContext();
					try {
						const page = await openPage(context, "spinetab");
						const info = await startPage(page, {
							variant: config.variant,
							diagnostics: true,
							...(config.pongTimeoutMs
								? { pongTimeoutMs: config.pongTimeoutMs }
								: {}),
						});
						expect(info.mode).toBe("shared");
						await page.evaluate(
							(topics) => (window as unknown as W).bench.subscribe(topics),
							ALL_TOPICS,
						);
						await waitForCounts(request, config.variant, 1, 100);
						await sleep(3_000);
						const calibration = await calibrateRealm(page, 100);
						detail.calibration = calibration;
						const trials: Trial[] = [];
						for (let index = 0; index < S.returnTrials; index += 1) {
							let result = await trial(
								page,
								request,
								config.variant,
								config.hint,
								config.fault,
								calibration.offset,
							);
							// A trial where the adapter's own heartbeat recovered first
							// measures nothing about return; it is recorded and redone once.
							if (result.selfHealedBeforeReturn) {
								detail.selfHealed = [
									...((detail.selfHealed as Trial[]) ?? []),
									result,
								];
								await sleep(TRIAL_SPACING_MS);
								result = await trial(
									page,
									request,
									config.variant,
									config.hint,
									config.fault,
									calibration.offset,
								);
							}
							trials.push(result);
							await sleep(TRIAL_SPACING_MS);
						}
						detail.trials = trials;
						detail.diagnostics = await page.evaluate(() =>
							(window as unknown as W).bench.diagnostics(),
						);
						detail.fixture = (await benchState(request)).counters;
						out.trials(
							`return.${name}.health-start`,
							trials.map((entry) => entry.healthStart),
						);
						out.trials(
							`return.${name}.first-event`,
							trials.map((entry) => entry.firstEvent),
						);
						out.trials(
							`return.${name}.restored`,
							trials.map((entry) => entry.restored),
						);
					} finally {
						await context.close();
					}
				},
			);
		},
	);
}

// Detected long gap (informational, pinned reps 1–5): the page's heartbeat
// (20 s default) fires late by more than max(2 × 20 s, 30 s) = 40 s after the
// main thread is blocked for L = threshold + interval + 5 s = 65 s. The
// generator is paused meanwhile so no delivery backlog forms; t0 is the
// page's `scheduling-gap` diagnostic.
const GAP_LOOP_MS = 40_000 + 20_000 + 5_000;

for (const variant of VARIANTS) {
	test(
		`return ${variant}.gap`,
		{ tag: ["@pinned"] },
		async ({ browser, request }, testInfo) => {
			test.skip(
				S.smoke || Number(rep()) > 5,
				"gap trials run in pinned reps 1–5 only",
			);
			test.setTimeout(GAP_LOOP_MS + 120_000);
			await recordEnvironment(browser, testInfo);
			await resetFixture(request);
			await withRecord(
				testInfo,
				{
					scenario: "return",
					config: `${variant}.gap`,
					expected: [`return.${variant}.gap.detected`],
				},
				async (out, detail) => {
					const context = await browser.newContext();
					try {
						const page = await openPage(context, "spinetab");
						await startPage(page, { variant, diagnostics: true });
						await page.evaluate(
							(topics) => (window as unknown as W).bench.subscribe(topics),
							ALL_TOPICS,
						);
						await waitForCounts(request, variant, 1, 100);
						await sleep(3_000);
						const calibration = await calibrateRealm(page, 100);
						await setFault(request, "pause");
						const loop = await page.evaluate(
							(ms) => (window as unknown as W).bench.busy(ms),
							GAP_LOOP_MS,
						);
						await clearFault(request, "pause");
						await sleep(10_000);
						// Diagnostics stamp Date.now(); map them onto the page clock.
						const { events, delta } = await page.evaluate(() => ({
							events: (window as unknown as W).bench.diagnostics() as Array<{
								type: string;
								at: number;
								detail?: { ms?: number };
							}>,
							delta: Date.now() - (performance.timeOrigin + performance.now()),
						}));
						const gap = events.find(
							(event) =>
								event.type === "scheduling-gap" &&
								event.at - delta >= loop.start,
						);
						const timed = (
							await page.evaluate(() =>
								(window as unknown as W).bench.realm<TimedState>("timed"),
							)
						).value;
						detail.loop = loop;
						detail.gap = gap ?? null;
						detail.probes = timed.probes;
						out.put(`return.${variant}.gap.detected`, gap ? 1 : 0);
						if (gap) {
							const t0 = gap.at - delta;
							const probe = timed.probes
								.map((entry) => entry.at - calibration.offset)
								.find((at) => at >= t0 - 1);
							out.put(
								`return.${variant}.gap.lateness`,
								gap.detail?.ms ?? Number.NaN,
							);
							out.put(
								`return.${variant}.gap.health-start`,
								probe === undefined ? Number.NaN : probe - t0,
								"no adapter probe after the detected gap",
							);
						}
						expect(gap, "the page detected the scheduling gap").toBeDefined();
					} finally {
						await context.close();
					}
				},
			);
		},
	);
}
