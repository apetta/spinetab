import { expect, test } from "@playwright/test";

test("the website shell links to documentation and examples", async ({
	page,
}) => {
	await page.goto("/");
	await expect(page).toHaveTitle("Spinetab");
	await expect(page.getByRole("heading", { level: 1 })).toHaveText(
		"One spine,every tab.",
	);
	await page
		.getByRole("navigation", { name: "Main navigation" })
		.getByRole("link", { name: "Documentation" })
		.click();
	await expect(page.getByRole("heading", { level: 1 })).toHaveText(
		"Documentation",
	);
	await page.getByRole("link", { name: "View the embedded examples" }).click();
	await expect(page.getByRole("heading", { level: 1 })).toHaveText("Examples");
});

test("the embedded React shell hydrates without browser errors", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto("/examples/");
	await page.getByRole("button", { name: "Check interactivity" }).click();
	await expect(page.getByRole("status")).toHaveText("React is ready.");
	expect(errors).toEqual([]);
});
