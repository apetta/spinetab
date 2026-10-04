import { expect, type Page, test } from "@playwright/test";
import type {
	AiRecord,
	HarnessAi,
} from "../fixtures/harness/src/adapters/ai-sdk.ts";
import type { HarnessWindow } from "../fixtures/harness/src/browser-helpers";

// Keep both pages in one browser context so they can share the same worker.

// The harness type comes from main.ts (no global Window augmentation, so
// specs cannot declare conflicting views of `window.harness`).
type AiWindow = HarnessWindow & { harnessAi: HarnessAi };

type Counters = {
	generations: number;
	resumes: number;
	stops: number;
	active: number;
	generationIds: string[];
	stopRequests: Array<{ chatId: string; generationId: string | null }>;
};

const chat = (name: string) =>
	`${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function counters(page: Page): Promise<Counters> {
	const response = await page.request.get("/__fixture/counters");
	return ((await response.json()) as { ai: Counters }).ai;
}

async function openTab(page: Page, query = "") {
	await page.goto(`/harness/${query ? `?${query}` : ""}`);
	await page.evaluate(() =>
		(window as unknown as AiWindow).harness.create({ sharing: "require" }),
	);
	await page.waitForFunction(
		() => typeof (window as unknown as AiWindow).harnessAi === "object",
	);
}

const record = (page: Page, chatId: string): Promise<AiRecord> =>
	page.evaluate(
		(id) => (window as unknown as AiWindow).harnessAi.record(id),
		chatId,
	);

test.beforeEach(async ({ request }) => {
	await request.post("/__fixture/reset");
});

test("BR-AI-01 two tabs observe one generation; closing the originator leaves the follower complete", async ({
	context,
}) => {
	const a = await context.newPage();
	const b = await context.newPage();
	// The follower constructs the shared worker, so closing the originator
	// closes a tab that does not own it. WebKit relaunches the worker when its
	// first client closes (tests/diagnostics/native-sharedworker.spec.ts); that
	// case is BR-AI-01b.
	await openTab(b);
	await openTab(a);
	const chatId = chat("two-tabs");
	await b.evaluate(
		(id) => (window as unknown as AiWindow).harnessAi.observe(id, true),
		chatId,
	);
	await a.evaluate(
		(id) =>
			(window as unknown as AiWindow).harnessAi.send(id, {
				size: 150,
				delayMs: 10,
			}),
		chatId,
	);
	await expect
		.poll(async () => (await record(b, chatId)).chunks.length)
		.toBeGreaterThan(5);
	await a.close();
	await expect
		.poll(async () => (await record(b, chatId)).done, { timeout: 15_000 })
		.toBe(true);
	const follower = await record(b, chatId);
	expect(follower.error).toBeNull();
	expect(follower.chunks[0]?.type).toBe("start");
	expect(follower.chunks.at(-1)?.type).toBe("finish");
	expect(follower.text.split(" ")).toHaveLength(150);
	expect(
		await b.evaluate(
			(id) => (window as unknown as AiWindow).harnessAi.role(id),
			chatId,
		),
	).toBe("follower");
	const server = await counters(b);
	expect(server.generations).toBe(1);
	expect(server.stops).toBe(0);
	expect(server.resumes).toBe(0);
});

// When the engine replaces the worker (WebKit relaunches it when its first
// client page closes), the new runtime announces itself on the follower's
// port and the follower is interrupted at once (contract decision: prompt
// recovery), at package defaults.
const INTERRUPTION_BOUND_MS = 3_000;

test("BR-AI-01b the originator is the worker's first client: the follower completes, or is interrupted once and promptly when the engine replaces the worker", async ({
	context,
}) => {
	test.setTimeout(90_000);
	const a = await context.newPage();
	const b = await context.newPage();
	await openTab(a);
	await openTab(b);
	const chatId = chat("owner-closes");
	await b.evaluate(
		(id) => (window as unknown as AiWindow).harnessAi.observe(id, true),
		chatId,
	);
	await a.evaluate(
		(id) =>
			(window as unknown as AiWindow).harnessAi.send(id, {
				size: 150,
				delayMs: 10,
			}),
		chatId,
	);
	await expect
		.poll(async () => (await record(b, chatId)).chunks.length)
		.toBeGreaterThan(5);
	const runtimeBefore = await b.evaluate(
		() => (window as unknown as AiWindow).harness.status().runtimeId,
	);
	const closedAt = await b.evaluate(() => Date.now());
	await a.close();
	await expect
		.poll(async () => (await record(b, chatId)).done, { timeout: 40_000 })
		.toBe(true);
	const follower = await record(b, chatId);
	const doneAfterMs =
		follower.doneAt === null ? null : follower.doneAt - closedAt;
	if (follower.error === null) {
		// The worker survived its first client: the generation completed on
		// the runtime that started it.
		expect(follower.chunks.at(-1)?.type).toBe("finish");
		expect(follower.text.split(" ")).toHaveLength(150);
		expect(follower.interrupted).toBe(0);
		expect(
			await b.evaluate(
				() => (window as unknown as AiWindow).harness.status().runtimeId,
			),
		).toBe(runtimeBefore);
	} else {
		// The engine replaced the worker and its in-flight fetch: one honest,
		// prompt interruption, then reattachment to the new runtime.
		expect(follower.error.code).toBe("interrupted");
		expect(doneAfterMs).not.toBeNull();
		expect(doneAfterMs as number).toBeLessThanOrEqual(INTERRUPTION_BOUND_MS);
		await expect
			.poll(async () => (await record(b, chatId)).interrupted)
			.toBe(1);
		await expect
			.poll(
				() =>
					b.evaluate(
						() => (window as unknown as AiWindow).harness.status().runtimeId,
					),
				{ timeout: INTERRUPTION_BOUND_MS },
			)
			.not.toBe(runtimeBefore);
		const losses = await b.evaluate(() =>
			(window as unknown as AiWindow).harness
				.diagnostics()
				.filter((event) => event.type === "runtime-lost")
				.map((event) => event.detail),
		);
		expect(losses).toEqual([{ reason: "runtime-announced" }]);
	}
	const runtimeAfter = await b.evaluate(
		() => (window as unknown as AiWindow).harness.status().runtimeId,
	);
	console.log(
		`AI-OWNER-CLOSURE ${JSON.stringify({
			engine: test.info().project.name,
			completed: follower.error === null,
			error: follower.error?.code ?? null,
			chunks: follower.chunks.length,
			doneAfterMs,
			interrupted: (await record(b, chatId)).interrupted,
			runtimeReplaced: runtimeAfter !== runtimeBefore,
		})}`,
	);
	// The start command is never re-sent and nothing is stopped, whatever the outcome.
	const server = await counters(b);
	expect(server.generations).toBe(1);
	expect(server.stops).toBe(0);
	expect(server.resumes).toBe(0);
});

test("BR-AI-02 detaching an observer never stops; an explicit stop is one identified command", async ({
	context,
}) => {
	const a = await context.newPage();
	const b = await context.newPage();
	await openTab(a);
	await openTab(b);
	const chatId = chat("detach-stop");
	await b.evaluate(
		(id) => (window as unknown as AiWindow).harnessAi.observe(id, true),
		chatId,
	);
	await a.evaluate(
		(id) =>
			(window as unknown as AiWindow).harnessAi.send(id, {
				size: 400,
				delayMs: 10,
			}),
		chatId,
	);
	await expect
		.poll(async () => (await record(b, chatId)).chunks.length)
		.toBeGreaterThan(5);
	await a.evaluate(
		(id) => (window as unknown as AiWindow).harnessAi.abort(id),
		chatId,
	);
	await expect.poll(async () => (await record(a, chatId)).done).toBe(true);
	const before = (await record(b, chatId)).chunks.length;
	await expect
		.poll(async () => (await record(b, chatId)).chunks.length)
		.toBeGreaterThan(before + 5);
	expect((await counters(a)).stops).toBe(0);

	expect(
		await b.evaluate(
			(id) => (window as unknown as AiWindow).harnessAi.stop(id),
			chatId,
		),
	).toBe("acknowledged");
	await expect.poll(async () => (await record(b, chatId)).done).toBe(true);
	const follower = await record(b, chatId);
	expect(follower.chunks.at(-1)).toEqual({ type: "abort", reason: "stopped" });
	const server = await counters(b);
	expect(server.stops).toBe(1);
	expect(server.stopRequests[0]?.generationId).toBe(server.generationIds[0]);
	expect(follower.interrupted).toBe(0);
});

test("BR-AI-03 a stalled observer overflows with a typed error while its peer completes", async ({
	context,
}) => {
	const a = await context.newPage();
	const b = await context.newPage();
	await openTab(a);
	await openTab(b);
	const chatId = chat("stalled");
	await b.evaluate(
		(id) => (window as unknown as AiWindow).harnessAi.observe(id, true),
		chatId,
	);
	await b.evaluate(() =>
		(window as unknown as AiWindow).harness.holdAcks(true),
	);
	await a.evaluate(
		(id) =>
			(window as unknown as AiWindow).harnessAi.send(id, {
				size: 400,
				delayMs: 1,
			}),
		chatId,
	);
	await expect
		.poll(async () => (await record(a, chatId)).done, { timeout: 15_000 })
		.toBe(true);
	expect((await record(a, chatId)).error).toBeNull();
	expect((await record(a, chatId)).text.split(" ")).toHaveLength(400);
	await b.evaluate(() =>
		(window as unknown as AiWindow).harness.holdAcks(false),
	);
	await expect.poll(async () => (await record(b, chatId)).done).toBe(true);
	expect((await record(b, chatId)).error?.code).toBe("overflow");
	expect((await counters(a)).generations).toBe(1);
});

test("BR-AI-05 a scope change discards old-scope chunks before new-scope delivery", async ({
	page,
}) => {
	await openTab(page);
	const chatId = chat("scope");
	await page.evaluate(
		(id) =>
			(window as unknown as AiWindow).harnessAi.send(id, {
				size: 300,
				delayMs: 10,
			}),
		chatId,
	);
	await expect
		.poll(async () => (await record(page, chatId)).chunks.length)
		.toBeGreaterThan(3);
	await page.evaluate(() =>
		(window as unknown as AiWindow).harness.setScope("other-user"),
	);
	await expect.poll(async () => (await record(page, chatId)).done).toBe(true);
	const after = await record(page, chatId);
	expect(after.chunks.length).toBeLessThan(300);
	expect(after.error?.code ?? "detached").toMatch(
		/scope-changed|attachment-retired|detached|interrupted/,
	);
	expect((await counters(page)).generations).toBe(1);
});

test("BR-AI-04 worker replacement during a generation: start count unchanged, observers interrupted once", async ({
	context,
}) => {
	// Fast heartbeat/probe so the killed worker is detected within seconds.
	const fast = "heartbeat=1000&probe=1000&handshake=2000";
	const a = await context.newPage();
	const b = await context.newPage();
	await openTab(a, fast);
	await openTab(b, fast);
	const chatId = chat("replaced");
	await b.evaluate(
		(id) => (window as unknown as AiWindow).harnessAi.observe(id, true),
		chatId,
	);
	await a.evaluate(
		(id) =>
			(window as unknown as AiWindow).harnessAi.send(id, {
				size: 600,
				delayMs: 10,
			}),
		chatId,
	);
	await expect
		.poll(async () => (await record(b, chatId)).chunks.length)
		.toBeGreaterThan(5);
	const before = await a.evaluate(
		() => (window as unknown as AiWindow).harness.status().runtimeId,
	);
	// Kill the shared worker instance: both tabs lose the same runtime.
	await a.evaluate(() => (window as unknown as AiWindow).harness.crashWorker());
	for (const page of [a, b]) {
		await expect
			.poll(async () => (await record(page, chatId)).done, { timeout: 15_000 })
			.toBe(true);
		await expect
			.poll(
				() =>
					page.evaluate(
						() => (window as unknown as AiWindow).harness.status().runtimeId,
					),
				{ timeout: 15_000 },
			)
			.not.toBe(before);
	}
	// onInterrupted runs once per episode, after the stream has errored.
	await expect.poll(async () => (await record(a, chatId)).interrupted).toBe(1);
	await expect.poll(async () => (await record(b, chatId)).interrupted).toBe(1);
	const originator = await record(a, chatId);
	const follower = await record(b, chatId);
	expect(originator.error?.code).toBe("interrupted");
	expect(follower.error?.code).toBe("interrupted");
	expect(originator.text.split(" ").length).toBeLessThan(600);
	// The start command is never re-sent after replacement.
	const server = await counters(a);
	expect(server.generations).toBe(1);
	expect(server.stops).toBe(0);
});
