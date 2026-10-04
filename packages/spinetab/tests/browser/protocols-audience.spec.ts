import { expect, type Page, test } from "@playwright/test";
import type {
	HarnessRequest,
	HarnessWindow,
} from "../fixtures/harness/src/browser-helpers";

// Exercise credential-audience refusal in a real worker, whose origin comes from location.

const FOREIGN = "https://api.example.invalid";

async function openHarness(page: Page) {
	await page.goto("/harness/");
	await page.waitForFunction(
		() =>
			typeof (window as unknown as Partial<HarnessWindow>).harness?.create ===
			"function",
	);
	await page.evaluate(() =>
		(window as unknown as HarnessWindow).harness.create({
			sharing: "require",
			credentials: "valid",
		}),
	);
}

async function subscribe(page: Page, name: string, request: HarnessRequest) {
	await page.evaluate(
		([n, r]) =>
			(window as unknown as HarnessWindow).harness.subscribe(
				n as string,
				r as HarnessRequest,
			),
		[name, request as unknown] as const,
	);
}

const connections = (page: Page, name: string) =>
	page.evaluate(
		(n) =>
			(window as unknown as HarnessWindow).harness
				.statuses(n)
				.map((status) => ({
					state: String(status.connection.state),
					reason: String(status.connection.reason),
				})),
		name,
	);

const cases: Array<{ name: string; request: HarnessRequest }> = [
	{
		name: "graphql-ws",
		request: {
			adapter: "graphql-ws",
			connection: { url: `${FOREIGN}/graphql` },
			subscription: { query: "subscription { ticks { n } }" },
		},
	},
	{
		name: "graphql-sse",
		request: {
			adapter: "graphql-sse",
			connection: { url: `${FOREIGN}/graphql/stream` },
			subscription: { query: "subscription { ticks { n } }" },
		},
	},
];

for (const { name, request } of cases) {
	test(`${name}: provider credentials never leave for an unlisted origin`, async ({
		page,
	}) => {
		await openHarness(page);
		await subscribe(page, "feed", request);
		await expect
			.poll(async () => (await connections(page, "feed")).at(-1))
			.toEqual({ state: "auth-blocked", reason: "credentials-audience" });
		// Permanent: a rotation does not restart it, and nothing follows.
		await page.evaluate(() =>
			(window as unknown as HarnessWindow).harness.setRevision(2),
		);
		await page.waitForTimeout(500);
		const states = await connections(page, "feed");
		const blockedAt = states.findIndex(
			(status) => status.reason === "credentials-audience",
		);
		expect(
			states
				.slice(blockedAt)
				.every((status) => status.state === "auth-blocked"),
		).toBe(true);
	});
}
