import { expect, type Page, test } from "@playwright/test";

// Assert the shared-worker setup only; report engine behaviour after closing the first page without treating it as a package verdict.

interface NativeState {
	workerId: string | null;
	workerIds: string[];
	messages: number;
	lastAt: number | null;
	lastSeq: number | null;
	errors: number;
}
type NativeWindow = { nativeRepro?: NativeState };
type Sample = NativeState & { now: number };

const WINDOW_MS = 15_000;
const SAMPLE_MS = 250;

async function open(page: Page): Promise<void> {
	await page.goto("/harness/native.html");
	await page.waitForFunction(() =>
		Boolean((window as unknown as NativeWindow).nativeRepro?.workerId),
	);
}

const sample = (page: Page): Promise<Sample> =>
	page.evaluate(() => {
		const state = (window as unknown as NativeWindow).nativeRepro;
		if (!state) throw new Error("native repro not loaded");
		return { ...state, workerIds: [...state.workerIds], now: Date.now() };
	});

test("second page after the first client page closes (plain SharedWorker, no Spinetab)", async ({
	browser,
}, testInfo) => {
	const context = await browser.newContext();
	try {
		const first = await context.newPage();
		const second = await context.newPage();
		await open(first);
		await open(second);
		const [a, b] = [await sample(first), await sample(second)];
		// Setup: both pages are served by one worker instance.
		expect(a.workerId).toBeTruthy();
		expect(b.workerId).toBe(a.workerId);
		await expect
			.poll(async () => (await sample(second)).messages)
			.toBeGreaterThan(4);

		const atClose = await sample(second);
		const closedAt = Date.now();
		await first.close();
		const samples: Sample[] = [];
		while (Date.now() - closedAt < WINDOW_MS) {
			await second.waitForTimeout(SAMPLE_MS);
			samples.push(await sample(second));
		}
		const last = samples.at(-1) ?? atClose;

		// Longest stretch between consecutive samples without a new message.
		let silenceStart = closedAt;
		let longestSilenceMs = 0;
		let previous = atClose.messages;
		for (const entry of samples) {
			if (entry.messages > previous) {
				silenceStart = entry.now;
				previous = entry.messages;
			} else {
				longestSilenceMs = Math.max(longestSilenceMs, entry.now - silenceStart);
			}
		}
		const firstNew = samples.find((entry) => entry.messages > atClose.messages);
		const observation = {
			engine: testInfo.project.name,
			browserVersion: browser.version(),
			workerIdAtClose: atClose.workerId,
			workerIdAfter: last.workerId,
			workerIdChanged: last.workerId !== atClose.workerId,
			workerIdsSeen: last.workerIds.length,
			messagesAtClose: atClose.messages,
			messagesAfterWindow: last.messages,
			keptReceivingWithin15s: last.messages > atClose.messages,
			firstNewMessageAfterCloseMs: firstNew ? firstNew.now - closedAt : null,
			receivingAtEnd:
				last.lastAt !== null && last.now - last.lastAt <= 4 * SAMPLE_MS,
			lastMessageAgeAtEndMs:
				last.lastAt === null ? null : last.now - last.lastAt,
			longestSilenceMs,
			lastSeqAtClose: atClose.lastSeq,
			lastSeqAfterWindow: last.lastSeq,
			workerErrorEvents: last.errors,
		};
		console.log(`NATIVE-REPRO ${JSON.stringify(observation)}`);
		testInfo.annotations.push({
			type: "native-repro",
			description: JSON.stringify(observation),
		});
		await testInfo.attach("native-repro.json", {
			body: JSON.stringify(
				{
					...observation,
					samples: samples.map((entry) => ({
						msAfterClose: entry.now - closedAt,
						messages: entry.messages,
						lastSeq: entry.lastSeq,
						workerId: entry.workerId,
					})),
				},
				null,
				2,
			),
			contentType: "application/json",
		});
	} finally {
		await context.close();
	}
});
