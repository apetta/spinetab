import {
	type APIRequestContext,
	type BrowserContext,
	expect,
	type Page,
} from "@playwright/test";
import type { Harness } from "./main";

// Playwright-side helpers for tests/browser/core-*.spec.ts (Node realm only;
// never imported by main.ts, so never bundled into the harness).

export const ORIGIN = "http://127.0.0.1:4500";
export type HarnessWindow = { harness: Harness };
/** What `harness.subscribe` accepts: polling options or a plain request. */
export type HarnessRequest = Parameters<Harness["subscribe"]>[1];

export function uid(label: string): string {
	return `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function openHarness(
	context: BrowserContext,
	query = "",
): Promise<Page> {
	const page = await context.newPage();
	await page.goto(`/harness/${query ? `?${query}` : ""}`);
	await page.waitForFunction(() => "harness" in window);
	return page;
}

export interface PollingStats {
	requests: number;
	inFlight: number;
	maxInFlight: number;
	aborted: number;
	completed: number;
	n: number;
}

export interface PollingRequest {
	id: string;
	method: string;
	hasAuth: boolean;
	scope: string | null;
	at: number;
	status: number;
	aborted: boolean;
}

export async function polling(request: APIRequestContext, id: string) {
	const response = await request.get(`${ORIGIN}/__fixture/counters`);
	const body = (await response.json()) as {
		polling: { byId: Record<string, PollingStats>; requests: PollingRequest[] };
	};
	return {
		stats: body.polling.byId[id] ?? {
			requests: 0,
			inFlight: 0,
			maxInFlight: 0,
			aborted: 0,
			completed: 0,
			n: 0,
		},
		requests: body.polling.requests.filter((entry) => entry.id === id),
	};
}

export async function setFault(
	request: APIRequestContext,
	action: string,
	value: unknown,
): Promise<void> {
	await request.post(`${ORIGIN}/__fixture/fault`, {
		data: { target: "polling", action, value },
	});
}

export async function eventCount(page: Page, name: string): Promise<number> {
	return page.evaluate(
		(subscription) =>
			(window as unknown as HarnessWindow).harness.events(subscription).length,
		name,
	);
}

export async function waitForEvents(
	page: Page,
	name: string,
	count: number,
	timeout = 15_000,
): Promise<void> {
	await expect
		.poll(() => eventCount(page, name), { timeout })
		.toBeGreaterThanOrEqual(count);
}

export const modes = (history: Array<{ mode: string }>) =>
	history
		.map((status) => status.mode)
		.filter((mode, index, list) => index === 0 || list[index - 1] !== mode);
