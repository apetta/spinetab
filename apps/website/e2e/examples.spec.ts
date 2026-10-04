import { randomUUID } from "node:crypto";
import { test as base, expect, type Page, type Route } from "@playwright/test";
import {
	createExampleServer,
	type ExampleServer,
	type FixtureOrbitSample,
	type FixtureVehicle,
} from "./helpers/example-server";

const test = base.extend<{ source: ExampleServer }>({
	source: async ({ browserName }, use) => {
		const source = await createExampleServer();
		try {
			await use(source);
		} finally {
			await base.info().attach(`provider-counters-${browserName}`, {
				body: JSON.stringify(source.counters),
				contentType: "application/json",
			});
			await source.close();
		}
	},
});

function exampleURL(kind: "orbit" | "transit", source: ExampleServer) {
	const params = new URLSearchParams({
		group: randomUUID(),
		[kind === "orbit" ? "orbitEndpoint" : "transitEndpoint"]:
			kind === "orbit" ? source.orbitEndpoint : source.transitEndpoint,
	});
	return `/docs/examples/${kind === "orbit" ? "orbit" : "live-transit"}/?${params}`;
}

async function received(page: Page) {
	return Number(
		(await page.getByTestId("example-received").innerText()).match(
			/\d+/,
		)?.[0] ?? 0,
	);
}

async function expectReceiving(page: Page) {
	await expect.poll(() => received(page)).toBeGreaterThan(0);
	await expect(page.getByTestId("example-phase")).toHaveText("live");
}

async function expectTabPositions(pages: Page[]) {
	for (const [index, page] of pages.entries()) {
		const cards = page.locator(".example-flow-tab");
		await expect(cards).toHaveCount(pages.length, { timeout: 15_000 });
		await expect(cards.locator(":scope > span")).toHaveText(
			pages.map((_, slot) => (slot === index ? "This tab" : `Tab ${slot + 1}`)),
		);
		await expect(cards.nth(index)).toHaveAttribute("data-current", "true");
		await expect(
			page.locator('.example-flow-tab[data-current="true"]'),
		).toHaveCount(1);
	}
}

async function openCompanion(page: Page, waitForUpdates = true) {
	const popup = page.waitForEvent("popup");
	await page
		.getByRole("button", { name: /Open (a second|another) tab/ })
		.click();
	const companion = await popup;
	await companion.waitForLoadState("domcontentloaded");
	if (waitForUpdates) await expectReceiving(companion);
	return companion;
}

async function openLoadingCompanion(page: Page) {
	const url = page.url();
	const group = new URL(url).searchParams.get("group");
	if (!group) throw new Error("Missing tab experiment group");
	let releaseNavigation: (() => void) | undefined;
	const held = new Promise<void>((resolve) => {
		releaseNavigation = resolve;
	});
	let markNavigationEntered: (() => void) | undefined;
	const entered = new Promise<void>((resolve) => {
		markNavigationEntered = resolve;
	});
	let markNavigationHandled: (() => void) | undefined;
	const handled = new Promise<void>((resolve) => {
		markNavigationHandled = resolve;
	});
	const hold = async (route: Route) => {
		if (route.request().isNavigationRequest()) {
			markNavigationEntered?.();
			await held;
			try {
				await route.continue();
			} finally {
				markNavigationHandled?.();
			}
		} else {
			await route.continue();
		}
	};
	const context = page.context();
	await context.route(url, hold);
	const popup = page.waitForEvent("popup");
	const launcher = page.locator(".example-primary");
	await expect(launcher).toHaveAccessibleName("Open another tab");
	try {
		await launcher.click();
		await entered;
		await expect(launcher).toBeDisabled();
		await page.evaluate((experimentGroup) => {
			delete document.documentElement.dataset.peerHeartbeat;
			const observer = new BroadcastChannel(
				`spinetab-example:transit:${experimentGroup}`,
			);
			const reportingTabs = new Set<string>();
			observer.addEventListener("message", (event) => {
				if (event.data?.type === "tab") {
					reportingTabs.add(event.data.id);
					if (reportingTabs.size === 2) {
						document.documentElement.dataset.peerHeartbeat = "received";
						observer.close();
					}
				}
			});
		}, group);
		await expect(page.locator("html")).toHaveAttribute(
			"data-peer-heartbeat",
			"received",
		);
		await expect(launcher).toBeDisabled();
	} finally {
		releaseNavigation?.();
		await handled;
		await context.unroute(url, hold);
	}
	const companion = await popup;
	await companion.waitForLoadState("domcontentloaded");
	await expectReceiving(companion);
	expect(context.pages()).toHaveLength(3);
	return companion;
}

async function expectOrbitValues(page: Page, sample: FixtureOrbitSample) {
	const latitude = `${Math.abs(sample.latitude).toFixed(2)}° ${sample.latitude < 0 ? "S" : "N"}`;
	const longitude = `${Math.abs(sample.longitude).toFixed(2)}° ${sample.longitude < 0 ? "W" : "E"}`;
	await expect(page.locator(".orbit-coordinates dd")).toHaveText(
		`${latitude} ${longitude}`,
		{ useInnerText: true },
	);
	await expect(page.locator(".orbit-altitude dd")).toHaveText(
		`${Math.round(sample.altitude)} km`,
	);
	await expect(
		page
			.locator(".orbit-telemetry > div")
			.filter({ has: page.getByText("Speed", { exact: true }) })
			.locator("dd"),
	).toHaveText(`${Math.round(sample.velocity).toLocaleString("en-GB")} km/h`);
	const reported = new Date(sample.timestamp * 1_000).toISOString();
	const time = page.locator(".orbit-source-time time");
	await expect(time).toHaveAttribute("datetime", reported);
	await expect(time).toHaveText(`${reported.slice(11, 19)} UTC`);
}

async function compareOrbitValues(
	tabs: Page[],
	source: ExampleServer,
	sample: FixtureOrbitSample,
) {
	source.setOrbitSample(sample);
	try {
		await Promise.all(tabs.map((page) => expectOrbitValues(page, sample)));
		expect(source.counters.orbitSamples.at(-1)).toEqual(sample);
	} finally {
		source.setOrbitSample(null);
	}
}

async function expectTransitValues(
	page: Page,
	vehicles: FixtureVehicle[],
	selectedId: string,
) {
	for (const vehicle of vehicles) {
		const row = page.locator(`[data-vehicle-id="${vehicle.vehicleId}"]`);
		await expect(row).toHaveAttribute("data-updated", vehicle.lastUpdated);
		await expect(row.locator(".transit-line")).toHaveText(
			vehicle.line.publicCode,
		);
		const time = row.locator("time");
		await expect(time).toHaveAttribute("datetime", vehicle.lastUpdated);
		await expect(time).toHaveText(
			new Intl.DateTimeFormat("en-GB", {
				hour: "2-digit",
				minute: "2-digit",
				second: "2-digit",
				hour12: false,
				timeZone: "Europe/Oslo",
			}).format(new Date(vehicle.lastUpdated)),
		);
	}
	const selected = vehicles.find((vehicle) => vehicle.vehicleId === selectedId);
	if (!selected) throw new Error(`Missing expected vehicle ${selectedId}`);
	await expect(
		page.locator(`[data-vehicle-id="${selectedId}"] button`),
	).toHaveAttribute("aria-pressed", "true");
	await expect(page.locator(".transit-detail-heading strong")).toHaveAttribute(
		"title",
		selectedId,
	);
	await expect(page.locator(".transit-position dd").nth(0)).toHaveText(
		`${selected.location.latitude.toFixed(4)}° N`,
	);
	await expect(page.locator(".transit-position dd").nth(1)).toHaveText(
		`${selected.location.longitude.toFixed(4)}° E`,
	);
	const plot = await page.locator(".transit-plot-area").boundingBox();
	const marker = await page
		.locator(".transit-plot-marker.is-selected > circle:last-child")
		.boundingBox();
	if (!plot || !marker)
		throw new Error("Expected the selected vehicle on the position plot");
	expect(
		Math.abs(marker.x + marker.width / 2 - plot.x - plot.width / 2),
	).toBeLessThan(1);
	expect(
		Math.abs(marker.y + marker.height / 2 - plot.y - plot.height / 2),
	).toBeLessThan(1);
	await expect(page.locator(".transit-bearing")).toHaveText(
		`${selected.bearing}° reported bearing`,
	);
}

async function compareTransitValues(tabs: Page[], source: ExampleServer) {
	source.setPaused(true);
	const current = source.vehicles();
	const updated = new Date(
		Math.max(
			Date.now(),
			...current.map((vehicle) => Date.parse(vehicle.lastUpdated)),
		) + 1,
	).toISOString();
	const markers = current.map((vehicle) => ({
		...vehicle,
		lastUpdated: updated,
		location:
			vehicle.vehicleId === "oslo-31"
				? { latitude: 59.9212, longitude: 10.7543 }
				: { latitude: 59.9321, longitude: 10.7891 },
		bearing: vehicle.vehicleId === "oslo-31" ? 120 : 240,
	}));
	source.emit([...markers].reverse());
	try {
		await Promise.all(
			tabs.map((page, index) =>
				expectTransitValues(page, markers, index === 1 ? "oslo-54" : "oslo-31"),
			),
		);
	} finally {
		source.setPaused(false);
	}
}

async function setTheme(page: Page, theme: "light" | "dark") {
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
			),
	);
	const select = page.locator("starlight-theme-select select:visible");
	const menu = page
		.getByRole("navigation", { name: "Main", exact: true })
		.getByRole("button", { name: "Menu", exact: true });
	const openMenu = (await select.count()) === 0;
	if (openMenu) await menu.click();
	await select.selectOption(theme);
	if (openMenu) await menu.click();
	await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
	await expect(page.locator(".main-frame")).not.toHaveAttribute("inert", "");
}

test("Transit shares one connection across three tabs and tears down mode changes", async ({
	page,
	source,
}) => {
	test.setTimeout(60_000);
	source.setAckDelay(80);
	await page.goto(exampleURL("transit", source));
	await expectReceiving(page);
	await expect.poll(() => source.counters.activeConnections).toBe(1);
	await expect.poll(() => source.counters.activeSubscriptions).toBe(1);
	await expect.poll(() => source.counters.snapshots).toBeGreaterThan(0);
	expect(source.counters.snapshotActiveSubscriptions[0]).toBeGreaterThanOrEqual(
		1,
	);
	source.setReverseSnapshots(true);
	const second = await openCompanion(page);
	await expect(second.getByTestId("example-tabs")).toHaveText("2");
	const third = await openLoadingCompanion(second);
	await expect(page.getByTestId("example-tabs")).toContainText("3");
	await expectTabPositions([page, second, third]);
	await expect.poll(() => source.counters.activeConnections).toBe(1);
	await expect.poll(() => source.counters.activeSubscriptions).toBe(1);
	await expect(third.getByTestId("example-upstreams")).toContainText("1");
	await expect(third.locator('[data-vehicle-id="oslo-54"]')).toBeVisible();
	for (const tab of [page, second, third]) {
		await expect
			.poll(() =>
				tab
					.locator(".transit-vehicles li")
					.evaluateAll((rows) =>
						rows.map((row) => row.getAttribute("data-vehicle-id")),
					),
			)
			.toEqual(["oslo-31", "oslo-54"]);
	}
	await second.locator('[data-vehicle-id="oslo-54"] button').click();
	await expectTabPositions([page, second, third]);
	await compareTransitValues([page, second, third], source);
	expect(source.counters.inits[0]).toEqual(
		expect.objectContaining({
			headers: { "Et-Client-Name": expect.any(String) },
		}),
	);
	for (let cycle = 0; cycle < 2; cycle += 1) {
		await page
			.getByRole("button", { name: "Compare per-tab connections" })
			.click();
		for (const tab of [page, second, third]) {
			await expect(tab.getByTestId("example-mode")).toHaveText("local");
			await expectReceiving(tab);
		}
		await expect.poll(() => source.counters.activeConnections).toBe(3);
		await expect.poll(() => source.counters.activeSubscriptions).toBe(3);
		await expect(third.getByTestId("example-upstreams")).toHaveText("3");
		await expect(third.locator(".example-flow-source")).toHaveCount(3);
		await expect(third.locator(".example-flow-hub")).toHaveCount(0);
		await expectTabPositions([page, second, third]);
		await compareTransitValues([page, second, third], source);
		await second.getByRole("button", { name: "Share connections" }).click();
		for (const tab of [page, second, third]) {
			await expect(tab.getByTestId("example-mode")).toHaveText("shared");
			await expectReceiving(tab);
		}
		await expect.poll(() => source.counters.activeConnections).toBe(1);
		await expect.poll(() => source.counters.activeSubscriptions).toBe(1);
		await expect(third.getByTestId("example-upstreams")).toHaveText("1");
		await expect(third.locator(".example-flow-source")).toHaveCount(1);
		await expect(third.locator(".example-flow-tab")).toHaveCount(3);
		await expectTabPositions([page, second, third]);
		await compareTransitValues([page, second, third], source);
	}
	const before = await received(second);
	await page.close();
	await expect.poll(() => received(second)).toBeGreaterThan(before);
	await expect(
		second.getByTestId("example-tabs"),
		"Only the two remaining tabs should still be reporting",
	).toHaveText("2", { timeout: 15_000 });
	await expectTabPositions([second, third]);
	await third.close();
	await second.goto("/docs/");
	await expect.poll(() => source.counters.activeSubscriptions).toBe(0);
	await expect.poll(() => source.counters.activeConnections).toBe(0);
});

test("Orbit shares actual polling requests and independent tabs issue their own", async ({
	page,
	source,
}) => {
	test.setTimeout(60_000);
	await page.goto(exampleURL("orbit", source));
	await expectReceiving(page);
	const second = await openCompanion(page);
	const third = await openCompanion(second);
	await expectTabPositions([page, second, third]);
	await second.getByRole("button", { name: "Map", exact: true }).click();
	await expect(
		second.getByRole("button", { name: "Map", exact: true }),
	).toHaveAttribute("aria-pressed", "true");
	await expect(
		page.getByRole("button", { name: "Globe", exact: true }),
	).toHaveAttribute("aria-pressed", "true");
	await expect(
		third.getByRole("button", { name: "Globe", exact: true }),
	).toHaveAttribute("aria-pressed", "true");
	await expect(
		second.getByRole("img", { name: "Current ISS position" }),
	).toContainText("The map shows the whole Earth.");
	await page.locator(".example-reads summary").click();
	await expect(page.locator(".example-reads ol")).toBeVisible();
	const start = source.counters.orbitRequests;
	await expect
		.poll(() => source.counters.orbitRequests, { timeout: 10_000 })
		.toBeGreaterThanOrEqual(start + 3);
	const [firstShared, secondShared, thirdShared] =
		source.counters.orbitTimes.slice(-3);
	if (
		firstShared === undefined ||
		secondShared === undefined ||
		thirdShared === undefined
	) {
		throw new Error("Expected three observed shared polling requests");
	}
	expect(secondShared - firstShared).toBeGreaterThan(650);
	expect(thirdShared - secondShared).toBeGreaterThan(650);
	const beforeThird = await received(third);
	await expect.poll(() => received(third)).toBeGreaterThan(beforeThird);
	await expectTabPositions([page, second, third]);
	await compareOrbitValues([page, second, third], source, {
		latitude: -12.3456,
		longitude: 145.6789,
		altitude: 423.7,
		velocity: 27456.8,
		timestamp: Math.floor(Date.now() / 1_000),
	});
	await second
		.getByRole("button", { name: "Compare per-tab connections" })
		.click();
	for (const tab of [page, second, third]) {
		await expect(tab.getByTestId("example-mode")).toHaveText("local");
	}
	const localStart = source.counters.orbitRequests;
	await expect
		.poll(() => source.counters.orbitRequests, { timeout: 10_000 })
		.toBeGreaterThanOrEqual(localStart + 6);
	const localTimes = source.counters.orbitTimes.slice(localStart);
	const firstLocal = localTimes[0];
	const sixthLocal = localTimes[5];
	if (firstLocal === undefined || sixthLocal === undefined) {
		throw new Error("Expected six observed independent polling requests");
	}
	expect(sixthLocal - firstLocal).toBeLessThan(3_000);
	await expectTabPositions([page, second, third]);
	await compareOrbitValues([page, second, third], source, {
		latitude: 37.1256,
		longitude: -122.7854,
		altitude: 418.2,
		velocity: 27654.3,
		timestamp: Math.floor(Date.now() / 1_000),
	});
	await third.getByRole("button", { name: "Share connections" }).click();
	for (const tab of [page, second, third]) {
		await expect(tab.getByTestId("example-mode")).toHaveText("shared");
	}
	await expectTabPositions([page, second, third]);
	await compareOrbitValues([page, second, third], source, {
		latitude: 48.7654,
		longitude: 2.3456,
		altitude: 421.4,
		velocity: 27543.2,
		timestamp: Math.floor(Date.now() / 1_000),
	});
	await page.close();
	const remainingBefore = await received(second);
	await expect
		.poll(() => received(second), { timeout: 10_000 })
		.toBeGreaterThan(remainingBefore);
	await expectTabPositions([second, third]);
	await third.close();
	await second.goto("/docs/");
	await expect
		.poll(() => source.counters.orbitRequests, { timeout: 5_000 })
		.toBeGreaterThanOrEqual(localStart + 6);
	const stoppedAt = source.counters.orbitRequests;
	await second.waitForTimeout(2_200);
	expect(source.counters.orbitRequests).toBe(stoppedAt);
});

test("Transit preserves partial batches, rejects older updates and restores a dropped connection", async ({
	page,
	source,
}) => {
	await page.goto(exampleURL("transit", source));
	await expectReceiving(page);
	source.setPaused(true);
	const changed: FixtureVehicle = {
		vehicleId: "oslo-31",
		lastUpdated: `${new Date(Date.now() + 1_000).toISOString().slice(0, 19)}.123900Z`,
		location: { latitude: 59.95, longitude: 10.77 },
		line: { publicCode: "31" },
		bearing: 90,
		speed: 8,
		delay: 0,
		destinationName: "Snarøya",
		monitoredCall: null,
	};
	source.emit([changed]);
	const row = page.locator('[data-vehicle-id="oslo-31"]');
	await expect(row).toHaveAttribute("data-updated", changed.lastUpdated);
	await expect(page.locator('[data-vehicle-id="oslo-54"]')).toBeVisible();
	const beforeOlder = await received(page);
	source.emit([
		{ ...changed, lastUpdated: new Date(Date.now() - 60_000).toISOString() },
	]);
	await expect.poll(() => received(page)).toBeGreaterThan(beforeOlder);
	await expect(row).toHaveAttribute("data-updated", changed.lastUpdated);
	const beforeSubMillisecond = await received(page);
	source.emit([
		{
			...changed,
			lastUpdated: changed.lastUpdated.replace(".123900Z", ".123100Z"),
		},
	]);
	await expect.poll(() => received(page)).toBeGreaterThan(beforeSubMillisecond);
	await expect(row).toHaveAttribute("data-updated", changed.lastUpdated);
	const second = await openCompanion(page, false);
	await expect(second.locator('[data-vehicle-id="oslo-54"]')).toBeVisible();
	await expect(second.locator('[data-vehicle-id="oslo-31"]')).toHaveAttribute(
		"data-updated",
		changed.lastUpdated,
	);
	expect(await received(second)).toBe(0);
	await expect(second.getByTestId("example-phase")).toHaveText("starting");
	const resumed = {
		...changed,
		lastUpdated: new Date(Date.now() + 2_000).toISOString(),
	};
	source.emit([resumed]);
	await expectReceiving(second);
	await expect(second.locator('[data-vehicle-id="oslo-31"]')).toHaveAttribute(
		"data-updated",
		resumed.lastUpdated,
	);
	const connections = source.counters.connections;
	source.disconnect();
	await expect
		.poll(() => source.counters.connections)
		.toBeGreaterThan(connections);
	await expect.poll(() => source.counters.activeConnections).toBe(1);
	await expectReceiving(second);
	await expect(second.locator('[data-vehicle-id="oslo-54"]')).toBeVisible();
	await second.close();
});

test("Orbit reports provider failure and recovers without claiming successful reads", async ({
	page,
	source,
}) => {
	source.setOrbitFailure(429);
	await page.goto(exampleURL("orbit", source));
	await expect.poll(() => source.counters.orbitRequests).toBeGreaterThan(0);
	await expect(page.getByTestId("example-phase")).not.toHaveText("live");
	expect(await received(page)).toBe(0);
	source.setOrbitFailure(0);
	await expectReceiving(page);
});

test("Transit rejects malformed provider values without manufacturing a live result", async ({
	page,
	source,
}) => {
	await page.goto(exampleURL("transit", source));
	await expectReceiving(page);
	source.setPaused(true);
	const vehicle = source
		.vehicles()
		.find((value) => value.vehicleId === "oslo-31");
	if (!vehicle) throw new Error("Missing fixture vehicle oslo-31");
	const marker = {
		...vehicle,
		lastUpdated: new Date(Date.now() + 1_000).toISOString(),
	};
	source.emit([marker]);
	await expect(page.locator('[data-vehicle-id="oslo-31"]')).toHaveAttribute(
		"data-updated",
		marker.lastUpdated,
	);
	const before = await received(page);
	source.malformed();
	await expect(page.getByTestId("example-phase")).toHaveText("error");
	expect(await received(page)).toBe(before);
	await expect(page.locator('[data-vehicle-id="oslo-54"]')).toBeVisible();
});

for (const kind of ["orbit", "transit"] as const) {
	test(`${kind} resumes fresh data after navigating away and returning through history`, async ({
		page,
		source,
	}) => {
		await page.addInitScript(() => {
			window.addEventListener("pageshow", (event) => {
				document.documentElement.dataset.restoredFromCache = String(
					event.persisted,
				);
			});
		});
		await page.goto(exampleURL(kind, source));
		await expectReceiving(page);
		const connectionsBefore = source.counters.connections;
		await page.goto("/docs/");
		await expect.poll(() => source.counters.activeConnections).toBe(0);
		const requestsBefore = source.counters.orbitRequests;
		await page.goBack();
		await expectReceiving(page);
		const deliveriesBefore = await received(page);
		await expect.poll(() => received(page)).toBeGreaterThan(deliveriesBefore);
		if (kind === "transit") {
			await expect
				.poll(() => source.counters.connections)
				.toBeGreaterThan(connectionsBefore);
			await expect.poll(() => source.counters.activeConnections).toBe(1);
		} else {
			expect(source.counters.orbitRequests).toBeGreaterThan(requestsBefore);
		}
		await test.info().attach(`${kind}-history-restoration`, {
			body: JSON.stringify({
				restoredFromCache: await page
					.locator("html")
					.getAttribute("data-restored-from-cache"),
				connections: source.counters.connections,
				requests: source.counters.orbitRequests,
			}),
			contentType: "application/json",
		});
	});
}

for (const kind of ["orbit", "transit"] as const) {
	test(`${kind} marks old provider timestamps as stale`, async ({
		page,
		source,
	}) => {
		source.setStale(true);
		await page.goto(exampleURL(kind, source));
		await expect.poll(() => received(page)).toBeGreaterThan(0);
		await expect(page.getByTestId("example-stale")).toHaveText("true");
		await expect(page.locator(".example-proof")).not.toContainText(
			kind === "orbit"
				? "One polling schedule is supplying both views."
				: "Both tabs are receiving one shared feed.",
		);
	});
}

test("unsupported SharedWorker visibly falls back to real independent connections", async ({
	page,
	source,
}) => {
	await page.context().addInitScript(() => {
		Object.defineProperty(window, "SharedWorker", {
			value: undefined,
			configurable: true,
		});
	});
	await page.goto(exampleURL("transit", source));
	await expectReceiving(page);
	await expect(page.getByTestId("example-mode")).toHaveText("local");
	await expect(
		page
			.getByText(/sharing.*unavailable|independent.*browser|local fallback/i)
			.first(),
	).toBeVisible();
	const second = await openCompanion(page);
	await expect(second.getByTestId("example-mode")).toHaveText("local");
	await expect.poll(() => source.counters.activeConnections).toBe(2);
	await second.close();
});

test("bus details update without shifting the board or selected position panel", async ({
	page,
	source,
}) => {
	source.setPaused(true);
	for (const width of [320, 768, 1440]) {
		await page.setViewportSize({ width, height: 900 });
		await page.goto(exampleURL("transit", source));
		await expectReceiving(page);
		const row = page.locator('[data-vehicle-id="oslo-31"]');
		await row.getByRole("button").click();
		await page.evaluate(() => document.fonts.ready);
		const geometry = () =>
			page
				.locator(
					".transit-layout, .transit-list, .transit-detail, .transit-vehicle",
				)
				.evaluateAll((elements) =>
					elements.map((element) => {
						const rect = element.getBoundingClientRect();
						const origin = document
							.querySelector(".transit-layout")
							?.getBoundingClientRect();
						return {
							x: rect.x - (origin?.x ?? 0),
							y: rect.y - (origin?.y ?? 0),
							width: rect.width,
							height: rect.height,
						};
					}),
				);
		const before = await geometry();
		const vehicle = source
			.vehicles()
			.find((vehicle) => vehicle.vehicleId === "oslo-31");
		if (!vehicle) throw new Error("Missing bus fixture");
		for (const update of [
			{
				destinationName:
					"Oslo sentrum via Helsfyr, Hasle, Bislett and Majorstuen",
				delay: 134,
				monitoredCall: { vehicleAtStop: true },
				label: "At a stop · 2m 14s late",
				tone: "late",
			},
			{
				destinationName: "Snarøya",
				delay: -65,
				monitoredCall: null,
				label: "1m 05s early",
				tone: "early",
			},
			{
				destinationName: null,
				delay: null,
				monitoredCall: null,
				label: "Timing unavailable",
				tone: "unknown",
			},
			{
				destinationName: "Snarøya",
				delay: 0,
				monitoredCall: null,
				label: "On time",
				tone: "on-time",
			},
		]) {
			source.emit([
				{ ...vehicle, ...update, lastUpdated: new Date().toISOString() },
			]);
			await expect(row.locator(".transit-vehicle-caption")).toHaveText(
				update.label,
			);
			await expect(row.locator(".transit-vehicle-caption")).toHaveAttribute(
				"data-tone",
				update.tone,
			);
			if (update.destinationName)
				await expect(
					row.locator(".transit-vehicle-name > span").first(),
				).toHaveText(`To ${update.destinationName}`);
			expect(await geometry()).toEqual(before);
		}
		await page.goto("/docs/");
		await expect.poll(() => source.counters.activeConnections).toBe(0);
	}
	expect(
		source.counters.queries.every((query) => /mode:\s*BUS/.test(query)),
	).toBe(true);
});

test("example actions and proof fit phones and desktop in both themes", async ({
	page,
	source,
}) => {
	test.setTimeout(120_000);
	for (const kind of ["transit", "orbit"] as const) {
		for (const [width, height] of [
			[320, 568],
			[360, 800],
			[390, 844],
			[430, 932],
			[600, 900],
			[768, 1024],
			[820, 1180],
			[844, 390],
			[1024, 768],
			[1280, 800],
			[1440, 900],
			[1920, 1080],
		] as const) {
			await page.setViewportSize({ width, height });
			await page.goto(exampleURL(kind, source));
			await expectReceiving(page);
			for (const colorScheme of ["light", "dark"] as const) {
				await page.emulateMedia({ reducedMotion: "reduce" });
				await setTheme(page, colorScheme);
				expect(
					await page.evaluate(() => document.documentElement.scrollWidth),
				).toBeLessThanOrEqual(width);
				if (kind === "transit") {
					await expect
						.poll(
							() =>
								page.evaluate(() => {
									const markers = [
										...document.querySelectorAll(".transit-report-mark"),
									].map((element) => element.getBoundingClientRect());
									if (
										markers.length < 2 ||
										markers.some((rect) => rect.width === 0)
									)
										return Infinity;
									return (
										Math.max(...markers.map((rect) => rect.x)) -
										Math.min(...markers.map((rect) => rect.x))
									);
								}),
							{
								message:
									"Report markers should align after the live update renders",
							},
						)
						.toBeLessThan(1);
					const columnEnd = await page
						.locator(".transit-columns span")
						.last()
						.evaluate((element) => element.getBoundingClientRect().right);
					const reportEnd = await page
						.locator(".transit-report")
						.first()
						.evaluate((element) => element.getBoundingClientRect().right);
					expect(Math.abs(columnEnd - reportEnd)).toBeLessThan(1);
				}
				const action = page.getByRole("button", {
					name: /Open (a second|another) tab/,
				});
				await expect(action).toBeVisible();
				const bounds = await action.boundingBox();
				if (!bounds)
					throw new Error("The primary example action has no visible bounds");
				expect(bounds.height).toBeGreaterThanOrEqual(44);
				const proof = await page.locator(".example-proof").boundingBox();
				if (!proof) throw new Error("The example proof has no visible bounds");
				expect(proof.y + proof.height).toBeLessThanOrEqual(900);
				await page.keyboard.press("Tab");
				await action.focus();
				await expect(action).toBeFocused();
				expect(
					await action.evaluate(
						(element) => getComputedStyle(element).outlineStyle,
					),
				).not.toBe("none");
				await page.keyboard.press("Tab");
				await expect(action).not.toBeFocused();
				{
					const name = `${kind}-${width}x${height}-${colorScheme}`;
					const path = test.info().outputPath(`${name}.png`);
					await page.evaluate(() =>
						window.scrollTo({ top: 0, behavior: "instant" }),
					);
					await page.locator(".example-demo").screenshot({ path });
					await test.info().attach(name, { path, contentType: "image/png" });
				}
			}
			await page.goto("/docs/");
			await expect.poll(() => source.counters.activeConnections).toBe(0);
		}
	}
});

test("three-tab diagrams and alternate views fit narrow and wide layouts", async ({
	page,
	source,
}) => {
	test.setTimeout(60_000);
	for (const kind of ["transit", "orbit"] as const) {
		await page.goto(exampleURL(kind, source));
		await expectReceiving(page);
		const second = await openCompanion(page);
		const third = await openCompanion(second);
		await expectTabPositions([page, second, third]);
		await page.bringToFront();
		if (kind === "orbit")
			await page.getByRole("button", { name: "Map", exact: true }).click();
		for (const mode of ["shared", "local"] as const) {
			if (mode === "local") {
				await page
					.getByRole("button", { name: "Compare per-tab connections" })
					.click();
				await expect(page.getByTestId("example-mode")).toHaveText("local");
			}
			for (const width of [320, 820, 1440]) {
				await page.setViewportSize({ width, height: 900 });
				for (const theme of ["light", "dark"] as const) {
					await setTheme(page, theme);
					expect(
						await page.evaluate(() => document.documentElement.scrollWidth),
					).toBeLessThanOrEqual(width);
					const cards = await page
						.locator(".example-flow-tab")
						.evaluateAll((elements) =>
							elements.map((element) => {
								const r = element.getBoundingClientRect();
								return {
									left: r.left,
									right: r.right,
									width: r.width,
									scroll: element.scrollWidth,
									client: element.clientWidth,
								};
							}),
						);
					for (const card of cards) {
						expect(card.left).toBeGreaterThanOrEqual(0);
						expect(card.right).toBeLessThanOrEqual(width);
						expect(card.scroll).toBeLessThanOrEqual(card.client);
					}
					await page.locator(".example-demo").screenshot({
						path: test
							.info()
							.outputPath(`${kind}-${mode}-${width}-${theme}.png`),
					});
				}
			}
		}
		await second.close();
		await third.close();
		await page.goto("/docs/");
		await expect.poll(() => source.counters.activeConnections).toBe(0);
	}
});
