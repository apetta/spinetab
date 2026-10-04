import { randomUUID } from "node:crypto";
import {
	type APIRequestContext,
	expect,
	type Page,
	test,
} from "@playwright/test";
import type {
	HarnessRequest,
	HarnessWindow,
} from "../fixtures/harness/src/browser-helpers";

// Protocol behaviour in Chromium, Firefox and WebKit through
// the SharedWorker. Requires the harness worker to register
// `trpcWsHarnessAdapter` and `trpcSseHarnessAdapter`
// (tests/fixtures/harness/src/adapters/trpc.ts). Fixture tags starting with
// `anon` need no credentials; the SSE path uses the browser's native
// EventSource (Node test workers have none).

interface Counters {
	wsConnections: number;
	sseRequests: number;
	subscriptions: number;
	lastEventIds: Array<string | null>;
	urls: string[];
}

async function openHarness(page: Page) {
	await page.goto("/harness/");
	await page.waitForFunction(
		() =>
			typeof (window as unknown as Partial<HarnessWindow>).harness?.create ===
			"function",
	);
	await page.evaluate(() =>
		(window as unknown as HarnessWindow).harness.create({ sharing: "require" }),
	);
}

const subscribe = (page: Page, name: string, request: HarnessRequest) =>
	page.evaluate(
		([n, r]) =>
			(window as unknown as HarnessWindow).harness.subscribe(
				n as string,
				r as HarnessRequest,
			),
		[name, request as unknown] as const,
	);

const eventCount = (page: Page, name: string) =>
	page.evaluate(
		(n) => (window as unknown as HarnessWindow).harness.events(n).length,
		name,
	);

async function counters(
	request: APIRequestContext,
	tag: string,
): Promise<Counters> {
	const response = await request.get("/__fixture/counters");
	const all = (await response.json()) as {
		trpc: { tags: Record<string, Counters> };
	};
	return all.trpc.tags[tag] as Counters;
}

const tagFor = () => `anon${randomUUID().replace(/-/g, "").slice(0, 12)}`;

test("SSE with the native EventSource: superjson values survive the bridge, URLs carry no credentials", async ({
	page,
	request,
}) => {
	const tag = tagFor();
	await openHarness(page);
	await subscribe(page, "ticks", {
		adapter: "trpc-sse",
		connection: { url: "/trpc", anonymous: true },
		subscription: { path: "ticks", input: { tag, intervalMs: 50 } },
	});
	await expect.poll(() => eventCount(page, "ticks")).toBeGreaterThan(2);
	const isDate = await page.evaluate(() => {
		const [first] = (window as unknown as HarnessWindow).harness.events(
			"ticks",
		) as Array<{
			data: { data: { data: { at: unknown } } };
		}>;
		return first?.data.data.data.at instanceof Date;
	});
	expect(isDate).toBe(true);
	const stats = await counters(request, tag);
	expect(stats.sseRequests).toBe(1);
	expect(stats.urls.every((url) => !url.includes("token"))).toBe(true);
});

test("two tabs share one tracked WebSocket subscription; a starting cursor separates consumers", async ({
	context,
	request,
}) => {
	const tag = tagFor();
	const base = {
		adapter: "trpc-ws",
		connection: { url: `/trpc-ws?tag=${tag}`, anonymous: true },
	};
	const first = await context.newPage();
	const second = await context.newPage();
	await openHarness(first);
	await openHarness(second);
	await subscribe(first, "ticks", {
		...base,
		subscription: { path: "ticks", input: { tag, intervalMs: 50 } },
	});
	await subscribe(second, "ticks", {
		...base,
		subscription: { path: "ticks", input: { tag, intervalMs: 50 } },
	});
	await subscribe(second, "resumed", {
		...base,
		subscription: {
			path: "ticks",
			input: { tag, intervalMs: 50 },
			lastEventId: "10",
		},
	});
	await expect.poll(() => eventCount(first, "ticks")).toBeGreaterThan(1);
	await expect.poll(() => eventCount(second, "resumed")).toBeGreaterThan(1);
	const stats = await counters(request, tag);
	expect(stats.wsConnections).toBe(1);
	expect(stats.subscriptions).toBe(2);
	expect([...stats.lastEventIds].sort()).toEqual(["10", null].sort());
});
