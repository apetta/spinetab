import { expect, test } from "@playwright/test";
import {
	recipes,
	retiredDestination,
	retiredRecipes,
} from "../src/recipes/catalogue";
import { recipeFiles } from "../src/recipes/files";

test("every built recipe displays exactly its authored files", async ({
	request,
}) => {
	test.setTimeout(120_000);
	for (const recipe of recipes) {
		const response = await request.get(recipe.url);
		expect(response.ok(), recipe.id).toBeTruthy();
		const html = await response.text();
		for (const heading of [
			"before-you-start",
			"install",
			"configure",
			"connect",
			"mount",
			"check",
		])
			expect(html, recipe.id).toContain(`id="${heading}"`);
		const titles = [
			...html.matchAll(/<span class="title"[^>]*>(.*?)<\/span>/g),
		].map((m) => m[1]);
		for (const file of recipeFiles(recipe)) {
			expect(titles, recipe.id).toContain(file.path);
			const copied = [...html.matchAll(/data-code="([^"]*)"/g)].map((match) =>
				match[1]!
					.replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
						String.fromCodePoint(Number.parseInt(hex, 16)),
					)
					.replaceAll("&quot;", '"')
					.replaceAll("&lt;", "<")
					.replaceAll("&gt;", ">")
					.replaceAll("&amp;", "&")
					.replaceAll("\x7f", "\n"),
			);
			expect(copied, `${recipe.id}: ${file.path}`).toContain(
				file.code.trimEnd().replaceAll("\t", "  "),
			);
		}
		expect(html, recipe.id).not.toContain("recipe.context");
		expect(html, recipe.id).toContain(
			`data-consumer-lock="${recipe.consumer}"`,
		);
		expect(html, recipe.id).not.toContain('aria-label="Data layer"');
		expect(html, recipe.id).toContain(`data-recipe-id="${recipe.id}"`);
		expect(html, recipe.id).not.toContain("Browse all recipes");
		const prose = html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ");
		expect(prose, recipe.id).toContain("See compatible versions if upgrading");
		expect(prose, recipe.id).toContain("declare anonymous: true:");
		expect(prose, recipe.id).toContain("add credentials and user scopes;");
	}
});

test("all retired recipe URLs include their integration destination", async ({
	request,
}) => {
	for (const recipe of retiredRecipes) {
		const response = await request.get(recipe.url);
		expect(response.ok(), recipe.id).toBeTruthy();
		expect(await response.text()).toContain(retiredDestination(recipe));
	}
});
