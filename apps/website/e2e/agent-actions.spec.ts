import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
	await page.addInitScript(() => {
		Object.defineProperty(navigator, "clipboard", {
			value: {
				writeText: async (text: string) => {
					document.documentElement.dataset.copied = text;
				},
				write: async (items: ClipboardItem[]) => {
					const blob = await items[0]?.getType("text/plain");
					document.documentElement.dataset.copied = await blob?.text();
				},
			},
			configurable: true,
		});
	});
});

test("collapsed prompt copies complete text and leads to usable docs", async ({
	page,
	request,
}) => {
	await page.goto("/docs/getting-started/");
	await page
		.getByRole("link", { name: "Copy a setup prompt and give it the docs" })
		.click();
	await expect(page).toHaveURL(/\/docs\/using-agents\/$/);
	for (const label of ["Copy prompt"]) {
		const button = page.getByRole("button", { name: label, exact: true });
		const box = button.locator("xpath=ancestor::docs-copy");
		await expect(box.locator("pre")).toBeHidden();
		const visible = await box.locator("pre").textContent();
		const copyBounds = await button.boundingBox();
		const viewBounds = await box
			.getByRole("button", { name: "View prompt" })
			.boundingBox();
		if (!copyBounds || !viewBounds) throw new Error("Missing prompt controls");
		expect(
			Math.abs(
				copyBounds.y +
					copyBounds.height / 2 -
					(viewBounds.y + viewBounds.height / 2),
			),
		).toBeLessThan(1);
		await button.focus();
		await page.keyboard.press("Enter");
		await expect(box.getByRole("status")).toHaveText("Copied");
		await expect(page.locator("html")).toHaveAttribute(
			"data-copied",
			visible ?? "",
		);
		const disclosure = box.getByRole("button", { name: "View prompt" });
		await disclosure.focus();
		await page.keyboard.press("Enter");
		await expect(box.locator("pre")).toBeVisible();
		await expect(disclosure).toHaveAttribute("aria-expanded", "true");
		await disclosure.click();
		await expect(box.locator("pre")).toBeHidden();
		for (const url of visible?.match(/https?:\/\/[^\s,]+/g) ?? []) {
			expect(new URL(url).origin).toBe(new URL(page.url()).origin);
			const response = await request.get(url);
			expect(response.ok()).toBeTruthy();
			expect(response.headers()["content-type"]).toMatch(
				/^text\/(plain|markdown)/,
			);
		}
	}
	const markdown = await request.get("/docs/using-agents.md");
	expect(await markdown.text()).toContain("First inspect the framework");
	expect(await markdown.text()).not.toContain("Couldn’t copy");
	expect(await markdown.text()).not.toContain("View prompt");
	await expect(page.locator(".pagination-links a").last()).toHaveAttribute(
		"href",
		"/docs/choose-integration/",
	);
	await expect(
		page.locator("main").getByRole("link", { name: "llms.txt", exact: true }),
	).toHaveAttribute("href", "/llms.txt");
	await expect(
		page.getByRole("heading", { name: "Keep the docs close" }),
	).toHaveCount(0);
});

test("Markdown copying follows recipe selection and browser back", async ({
	page,
	request,
}) => {
	await page.goto("/docs/recipes/direct/");
	await page.getByLabel("Framework", { exact: true }).selectOption("nextjs");
	await expect(page).toHaveURL(/\/docs\/recipes\/nextjs\/direct\/polling\/$/);
	await page.getByLabel("Connection", { exact: true }).selectOption("sse");
	await expect(page).toHaveURL(/\/docs\/recipes\/nextjs\/direct\/sse\/$/);
	for (const source of ["sse", "polling"]) {
		const path = `/docs/recipes/nextjs/direct/${source}.md`;
		await expect(
			page.getByRole("link", { name: "View Markdown", exact: true }),
		).toHaveAttribute("href", path);
		await page
			.getByRole("button", { name: "Copy Markdown", exact: true })
			.click();
		await expect(page.locator(".page-actions").getByRole("status")).toHaveText(
			"Copied",
		);
		await expect(page.locator("html")).toHaveAttribute(
			"data-copied",
			await (await request.get(path)).text(),
		);
		if (source === "sse") await page.goBack();
	}
});

test("failed fetches and denied clipboard access offer a usable alternative", async ({
	page,
}) => {
	await page.goto("/docs/using-agents/");
	await page.route("**/docs/using-agents.md", (route) =>
		route.fulfill({ status: 503, body: "Unavailable" }),
	);
	await page
		.getByRole("button", { name: "Copy Markdown", exact: true })
		.click();
	await expect(page.locator(".page-actions").getByRole("status")).toHaveText(
		"Couldn’t copy. Use View Markdown.",
	);
	await expect(
		page.getByRole("button", { name: "Copy Markdown", exact: true }),
	).toBeEnabled();
	await page.unroute("**/docs/using-agents.md");
	await page
		.getByRole("button", { name: "Copy Markdown", exact: true })
		.click();
	await expect(page.locator(".page-actions").getByRole("status")).toHaveText(
		"Copied",
	);
	await page.evaluate(() => {
		navigator.clipboard.writeText = async () => {
			throw new DOMException("Denied", "NotAllowedError");
		};
	});
	await page.getByRole("button", { name: "Copy prompt", exact: true }).click();
	await expect(
		page
			.locator("docs-copy")
			.filter({ hasText: "Copy prompt" })
			.getByRole("status"),
	).toHaveText("Couldn’t copy. Select the prompt below.");
	await expect(page.locator("[data-copy-text]").first()).toBeVisible();
});

test("agent guide stays readable at phone, tablet and desktop widths", async ({
	page,
}) => {
	for (const width of [320, 390, 768, 1440]) {
		await page.setViewportSize({ width, height: 900 });
		await page.goto("/docs/using-agents/");
		await page.evaluate(() => document.fonts.ready);
		for (const theme of ["dark", "light"]) {
			await page.evaluate(
				(theme) => (document.documentElement.dataset.theme = theme),
				theme,
			);
			expect(
				await page.evaluate(
					() => document.documentElement.scrollWidth <= innerWidth,
				),
			).toBe(true);
			const link = page.getByRole("link", {
				name: "View Markdown",
				exact: true,
			});
			const before = await link.boundingBox();
			await page
				.getByRole("button", { name: "Copy Markdown", exact: true })
				.click();
			await expect(
				page.locator(".page-actions").getByRole("status"),
			).toHaveText("Copied");
			expect(await link.boundingBox()).toEqual(before);
		}
	}
});

test("prompt remains readable without JavaScript", async ({
	browser,
	baseURL,
}) => {
	const context = await browser.newContext({
		javaScriptEnabled: false,
		baseURL,
	});
	try {
		const page = await context.newPage();
		await page.goto("/docs/using-agents/");
		await expect(page.locator("[data-copy-text]")).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Copy prompt", exact: true }),
		).toHaveCount(0);
		await expect(
			page.locator("main").getByRole("link", { name: "llms.txt", exact: true }),
		).toBeVisible();
	} finally {
		await context.close();
	}
});
