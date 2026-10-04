import { expect, test } from "@playwright/test";
import { describeCell } from "../package/consumers/browser.ts";
import { consumer, PORTS, STATIC_CSP } from "../package/consumers/catalogue.ts";

/**
 * Import side effects in the page and module-worker realms: the
 * packed `side-effects` consumer loads every peer, installs spies, then
 * imports each Spinetab entry (page: one at a time; module worker: all).
 * No spied API may be called and no global may appear. Each realm then calls
 * `defineWorker(() => [])`, which must register nothing.
 * The Node realm is tests/package/side-effects.test.ts.
 */
interface Snapshot {
	calls: Record<string, number>;
	added: string[];
	addedSymbols: string[];
	exports?: number;
}

/** `define-worker.js`: spies around one `defineWorker(() => [])` call. */
interface DefineWorkerCall extends Snapshot {
	factory: string;
	onconnect: string;
}

interface Report {
	done: boolean;
	error?: string;
	page?: Record<string, Snapshot>;
	defineWorker?: DefineWorkerCall;
	worker?: Snapshot & {
		onconnect: string;
		exports: Record<string, number>;
		defineWorker: DefineWorkerCall;
	};
}

const NO_EFFECT: DefineWorkerCall = {
	calls: {},
	added: [],
	addedSymbols: [],
	factory: "function",
	onconnect: "undefined",
};

describeCell(
	{
		id: "side-effects-vite-prod",
		consumer: "side-effects",
		bundler: "vite",
		mode: "prod",
		variant: "prod",
		frontPort: PORTS.vite.prod,
		out: "out/vite-prod",
		front: { csp: STATIC_CSP },
		report: { bundler: "vite", variant: "prod" },
	},
	(context) => {
		test("no entry has an import-time effect in the page or a module worker, and defineWorker registers nothing there", async ({
			browser,
		}) => {
			const browserContext = await browser.newContext();
			try {
				const page = await browserContext.newPage();
				const errors: string[] = [];
				page.on("pageerror", (error) => errors.push(error.message));
				await page.goto(`${context.cell().origin}/`);
				await expect
					.poll(
						() =>
							page.evaluate(
								() =>
									(window as { __sideEffects?: Report }).__sideEffects?.done ===
									true,
							),
						{ timeout: 60_000 },
					)
					.toBe(true);
				const report = (await page.evaluate(
					() => (window as { __sideEffects?: Report }).__sideEffects,
				)) as Report;
				expect(report.error).toBeUndefined();
				expect(errors).toEqual([]);
				const pageEffects = Object.entries(report.page ?? {}).filter(
					([, snapshot]) =>
						Object.keys(snapshot.calls).length > 0 ||
						snapshot.added.length > 0 ||
						snapshot.addedSymbols.length > 0,
				);
				expect(pageEffects).toEqual([]);
				// Every browser entry of the catalogue, each imported on its own.
				expect(Object.keys(report.page ?? {}).sort()).toEqual(
					[...consumer("side-effects").entries].sort(),
				);
				expect(report.worker?.calls).toEqual({});
				expect(report.worker?.added).toEqual([]);
				expect(report.worker?.addedSymbols).toEqual([]);
				expect(report.worker?.onconnect).toBe("undefined");
				for (const [name, count] of Object.entries(
					report.worker?.exports ?? {},
				)) {
					expect(count, name).toBeGreaterThan(0);
				}
				// No listener, timer or message, no onconnect.
				expect(report.defineWorker).toEqual(NO_EFFECT);
				expect(report.worker?.defineWorker).toEqual(NO_EFFECT);
				context.note({
					counters: { entries: Object.keys(report.page ?? {}).length },
				});
			} finally {
				await browserContext.close();
			}
		});
	},
);
