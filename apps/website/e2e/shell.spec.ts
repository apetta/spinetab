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
