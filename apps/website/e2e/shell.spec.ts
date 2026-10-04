import { expect, test } from "@playwright/test";

test("the website shell links to documentation and GitHub", async ({
	page,
}) => {
	await page.goto("/");
	await expect(page).toHaveTitle("Spinetab");
	await expect(page.getByRole("heading", { level: 1 })).toHaveText(
		/One connection,\s*every tab\./,
	);
	await page
		.getByRole("navigation", { name: "Main navigation" })
		.getByRole("link", { name: "Documentation" })
		.click();
	await expect(page.getByRole("heading", { level: 1 })).toHaveText(
		"Documentation",
	);
	const sidebar = page.getByRole("navigation", { name: "Main", exact: true });
	await sidebar.getByRole("link", { name: "Getting started" }).click();
	await expect(page.getByRole("heading", { level: 1 })).toHaveText(
		"Getting started",
	);
	await expect(sidebar.getByRole("link", { name: "GitHub" })).toHaveAttribute(
		"href",
		"https://github.com/apetta/spinetab",
	);
});

for (const colorScheme of ["light", "dark"] as const) {
	test(`portable icons and layout in ${colorScheme} mode`, async ({ page }) => {
		await page.emulateMedia({ colorScheme });
		for (const width of [320, 390, 760, 761, 1024, 1440]) {
			await page.setViewportSize({ width, height: 900 });
			await page.goto("/");
			await expect(page.locator(".hero-actions .arrow-icon")).toBeVisible();
			await expect(page.locator(".connection-symbol path")).toBeVisible();
			expect(await page.locator("body").innerText()).not.toMatch(/[↗↔]/u);
			expect(
				await page.evaluate(() => document.documentElement.scrollWidth),
			).toBeLessThanOrEqual(width);
			await expect(page.locator("body")).toHaveCSS(
				"color",
				colorScheme === "dark" ? "rgb(245, 237, 219)" : "rgb(53, 35, 68)",
			);
		}
		await page.goto("/docs/getting-started/");
		await expect(page.getByRole("heading", { level: 1 })).toHaveText(
			"Getting started",
		);
		await expect(
			page.locator(".sl-link-card").first().locator("svg"),
		).toBeVisible();
	});
}
