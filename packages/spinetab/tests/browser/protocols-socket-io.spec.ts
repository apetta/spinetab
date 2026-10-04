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

// Protocol behaviour from the SharedWorker in Chromium,
// Firefox and WebKit. Requires the harness worker to register
// `socketIoHarnessAdapter` (tests/fixtures/harness/src/adapters/socket-io.ts).
// Namespaces are used anonymously (`anonymous=1` query, `anonymous: true`).

interface Counters {
	connections: number;
	byTransport: Record<string, number>;
	upgrades: number;
	commands: Record<string, number>;
	joins: Record<string, number>;
	recovered: number;
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

const events = (page: Page, name: string) =>
	page.evaluate(
		(n) => (window as unknown as HarnessWindow).harness.events(n),
		name,
	);

async function counters(
	request: APIRequestContext,
	tag: string,
): Promise<Counters> {
	const response = await request.get("/__fixture/counters");
	const all = (await response.json()) as {
		"socket-io": { tags: Record<string, Counters> };
	};
	return all["socket-io"].tags[tag] as Counters;
}

const tagFor = (prefix: string) =>
	`${prefix}${randomUUID().replace(/-/g, "").slice(0, 12)}`;

function connection(tag: string, extra: Record<string, unknown> = {}) {
	return {
		url: "http://127.0.0.1:4500",
		sharing: "shared",
		anonymous: true,
		query: { tag, anonymous: "1", ticks: "50" },
		reconnectionDelayMs: 100,
		reconnectionDelayMaxMs: 200,
		...extra,
	};
}

for (const transport of ["polling", "websocket"] as const) {
	test(`${transport}-only transport works from the SharedWorker`, async ({
		page,
		request,
	}) => {
		const tag = tagFor(`bs${transport[0]}`);
		await openHarness(page);
		await subscribe(page, "ticks", {
			adapter: "socket-io",
			connection: connection(tag, { transports: [transport] }),
			subscription: { event: "tick" },
		});
		await expect
			.poll(async () => (await events(page, "ticks")).length)
			.toBeGreaterThan(2);
		const stats = await counters(request, tag);
		expect(stats.byTransport).toEqual({ [transport]: 1 });
		expect(stats.upgrades).toBe(0);
	});
}

test("per-tab sockets keep each tab's room events separate", async ({
	context,
	request,
}) => {
	const tag = tagFor("bsr");
	const pages = [await context.newPage(), await context.newPage()];
	const rooms = [`${tag}a`, `${tag}b`] as const;
	for (const [index, page] of pages.entries()) {
		await openHarness(page);
		const tab = `tab-${index}-${tag}`;
		await subscribe(page, "room", {
			adapter: "socket-io",
			connection: connection(tag, { sharing: "per-tab", tab }),
			subscription: {
				event: "room",
				membership: rooms[index],
				route: "byRoom",
				join: { event: "join", args: [rooms[index]] },
			},
		});
	}
	for (const [index, page] of pages.entries()) {
		await expect
			.poll(async () => (await events(page, "room")).length)
			.toBeGreaterThan(2);
		const received = (await events(page, "room")) as Array<unknown>;
		expect(JSON.stringify(received)).toContain(rooms[index]);
		expect(JSON.stringify(received)).not.toContain(rooms[1 - index]);
	}
	const stats = await counters(request, tag);
	expect(stats.connections).toBe(2);
	expect(stats.joins).toEqual({ [rooms[0]]: 1, [rooms[1]]: 1 });
});

test("commands are emitted at most once: the server count equals the calls", async ({
	page,
	request,
}) => {
	const tag = tagFor("bsc");
	await openHarness(page);
	await subscribe(page, "ticks", {
		adapter: "socket-io",
		connection: connection(tag),
		subscription: { event: "tick" },
	});
	await expect
		.poll(async () => (await events(page, "ticks")).length)
		.toBeGreaterThan(0);
	const outcomes = await page.evaluate(
		async ([conn]) => {
			const harness = (window as unknown as HarnessWindow).harness;
			const results = [];
			for (let index = 0; index < 5; index += 1) {
				results.push(
					await harness.command({
						adapter: "socket-io",
						connection: conn,
						payload: { event: "echo", args: [index] },
					}),
				);
			}
			return results;
		},
		[connection(tag)] as const,
	);
	expect(outcomes.map((outcome) => outcome.status)).toEqual(
		Array(5).fill("acknowledged"),
	);
	expect((await counters(request, tag)).commands).toEqual({ echo: 5 });
});

test("a transport drop with connection-state recovery reports `recovered`", async ({
	page,
	request,
}) => {
	const tag = tagFor("bsv");
	await openHarness(page);
	await subscribe(page, "ticks", {
		adapter: "socket-io",
		connection: connection(tag),
		subscription: { event: "tick" },
	});
	await expect
		.poll(async () => (await events(page, "ticks")).length)
		.toBeGreaterThan(1);
	await request.post(`/socket-io-control/close-transport?tag=${tag}`);
	await expect
		.poll(() =>
			page.evaluate(() =>
				(window as unknown as HarnessWindow).harness
					.statuses("ticks")
					.some((status) => status.continuity.reason === "recovered"),
			),
		)
		.toBe(true);
	expect((await counters(request, tag)).recovered).toBe(1);
});
