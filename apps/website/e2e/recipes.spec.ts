import { expect, test } from "@playwright/test";
import { recipes, sections } from "../src/recipes/catalogue";

test("inline prose keeps its spaces before and after changing a recipe", async ({
	page,
}) => {
	await page.goto("/docs/recipes/direct/");
	const content = page.locator("[data-recipe-content]");
	const checkProse = async () => {
		await expect(
			content.locator('[data-recipe-part="install"] p').last(),
		).toHaveText(
			"Keep your framework's existing dependencies. See compatible versions if upgrading an older app.",
		);
		await expect(
			content.locator('[data-recipe-part="before-you-start"] p').last(),
		).toContainText("declare anonymous: true:");
		await expect(
			content.locator('[data-recipe-part="before-you-start"] p').last(),
		).toContainText("add credentials and user scopes;");
		await expect(
			content.locator('[data-recipe-part="check"] p').last(),
		).toHaveText("API options and advanced recovery · Authentication");
	};
	await expect(content.locator("[data-recipe-summary]")).toHaveText(
		"HTTP polling · Vite · React",
	);
	await checkProse();
	await page.getByLabel("Framework", { exact: true }).selectOption("nextjs");
	await page.getByLabel("Connection").selectOption("sse");
	await expect(content).toHaveAttribute("data-recipe-id", "nextjs/direct/sse");
	await expect(content.locator("[data-recipe-summary]")).toHaveText(
		"Server-sent events · Next.js",
	);
	await checkProse();
});

test("framework choice resolves to a complete deep link and survives history", async ({
	page,
}) => {
	await page.goto("/docs/setup/vite/");
	const picker = page.locator("[data-recipe-picker]");
	await picker.getByLabel("UI library").selectOption("vue");
	await picker.getByLabel("Data layer").selectOption("query");
	await picker.getByLabel("Connection").selectOption("graphql-sse");
	await picker.getByRole("link", { name: "Open recipe" }).click();
	await expect(page).toHaveURL(
		/\/docs\/recipes\/vite-vue\/query\/graphql-sse\/$/,
	);
	await page.evaluate(() =>
		localStorage.setItem(
			"starlight-synced-tabs",
			JSON.stringify({ framework: "React" }),
		),
	);
	await page.reload();
	await expect(page.getByLabel("UI library")).toHaveValue("vue");
	await expect(page.getByLabel("Data layer")).toHaveCount(0);
	await expect(page.getByLabel("Connection")).toHaveValue("graphql-sse");
	await page.goBack();
	await expect(page).toHaveURL(/\/docs\/setup\/vite\/$/);
	await page.goForward();
	await expect(page.getByLabel("UI library")).toHaveValue("vue");
});

test("incompatible selections are corrected visibly", async ({ page }) => {
	await page.goto("/docs/setup/vite/");
	await page.getByLabel("Data layer").selectOption("swr");
	await page.getByLabel("UI library").selectOption("vue");
	await expect(page.getByLabel("Data layer")).toHaveValue("direct");
	await expect(page.locator("[data-recipe-message]")).toContainText(
		"Component state",
	);
	await expect(page.locator("[data-recipe-link]")).toHaveAttribute(
		"href",
		"/docs/recipes/vite-vue/direct/polling/",
	);
});

test("renderer hub keeps its own renderer and works without JavaScript", async ({
	browser,
	baseURL,
}) => {
	const context = await browser.newContext({ javaScriptEnabled: false });
	const page = await context.newPage();
	await page.goto(`${baseURL}/docs/recipes/astro-svelte/`);
	await expect(page.getByLabel("UI library")).toHaveValue("svelte");
	await page.locator("[data-recipe-link]").click();
	await expect(page).toHaveURL(/\/astro-svelte\/direct\/polling\/$/);
	await expect(page.locator(".expressive-code")).not.toHaveCount(0);
	await context.close();
});

for (const width of [375, 815, 1440]) {
	test(`recipe controls and code fit ${width}px in both themes`, async ({
		page,
	}) => {
		await page.setViewportSize({ width, height: 900 });
		await page.goto("/docs/recipes/vite-react/trpc/trpc-sse/");
		for (const theme of ["light", "dark"]) {
			const themeSelect = page.locator("starlight-theme-select select:visible");
			const menu = page.getByRole("button", { name: "Menu", exact: true });
			const openMenu = (await themeSelect.count()) === 0;
			if (openMenu) await menu.click();
			await themeSelect.selectOption(theme);
			if (openMenu) {
				await menu.click();
				await expect(page.locator(".main-frame")).not.toHaveAttribute(
					"inert",
					"",
				);
			}
			expect(
				await page.evaluate(
					() => document.documentElement.scrollWidth <= innerWidth + 1,
				),
			).toBeTruthy();
			for (const control of await page
				.locator("[data-recipe-picker] select:visible")
				.all()) {
				const bounds = await control.boundingBox();
				expect(bounds?.height).toBeGreaterThanOrEqual(40);
			}
			const select = page.getByRole("radio", {
				name: "tRPC over SSE",
				exact: true,
			});
			await select.focus();
			await page.keyboard.press("Tab");
			await page.keyboard.press("Shift+Tab");
			await expect(select).toBeFocused();
			expect(
				await select.evaluate(
					(el) => getComputedStyle(el.closest("label")!).outlineStyle,
				),
			).not.toBe("none");
			await page.screenshot({
				path: test.info().outputPath(`controls-${theme}.png`),
			});
		}
		await page.locator(".expressive-code .copy button").first().click();
		await expect(page.locator(".expressive-code").first()).toBeVisible();
	});
}

test("recipe sections lock integration and offer only compatible apps", async ({
	page,
}) => {
	await page.goto("/docs/recipes/");
	for (const [consumer, section] of Object.entries(sections)) {
		await page.goto(`/docs/recipes/${section.slug}/`);
		const picker = page.locator("[data-recipe-picker]");
		await expect(picker.getByLabel("Data layer")).toHaveCount(0);
		const expected = [
			...new Set(
				recipes
					.filter((r) => r.consumer === consumer)
					.map((r) => r.context.framework),
			),
		];
		expect(
			await picker
				.locator("[data-framework] option")
				.evaluateAll((options) =>
					options.map((option) => (option as HTMLOptionElement).value),
				),
		).toEqual(expect.arrayContaining(expected));
		await expect(picker.locator("[data-framework] option")).toHaveCount(
			expected.length,
		);
		await picker
			.getByLabel("Framework", { exact: true })
			.selectOption("nextjs");
		if (consumer === "apollo")
			await picker
				.getByRole("radio", { name: "GraphQL over SSE", exact: true })
				.check();
		if (consumer === "trpc")
			await picker
				.getByRole("radio", { name: "tRPC over SSE", exact: true })
				.check();
		if (consumer === "ai") {
			await expect(picker.getByLabel("Connection")).toHaveCount(0);
			await expect(picker.getByRole("radio")).toHaveCount(0);
		}
		await expect(page).toHaveURL(new RegExp(`/nextjs/${consumer}/`));
		await expect(page.locator("[data-recipe-content]")).toHaveAttribute(
			"data-recipe-id",
			new RegExp(`^nextjs/${consumer}/`),
		);
		await expect(
			picker.getByRole("link", { name: "Open recipe" }),
		).toBeHidden();
		await expect(page.getByLabel("Framework", { exact: true })).toHaveValue(
			"nextjs",
		);
		await expect(page.getByLabel("Data layer")).toHaveCount(0);
		await expect(
			picker.getByRole("link", { name: "Change integration", exact: true }),
		).toHaveCount(0);
	}
});

test("section defaults and deep links render complete recipes without JavaScript", async ({
	browser,
	baseURL,
}) => {
	const context = await browser.newContext({ javaScriptEnabled: false });
	const page = await context.newPage();
	for (const [consumer, section] of Object.entries(sections)) {
		await page.goto(`${baseURL}/docs/recipes/${section.slug}/`);
		await expect(
			page.getByText("Browse all recipes", { exact: true }),
		).toHaveCount(0);
		await expect(page.locator("[data-recipe-content]")).toHaveAttribute(
			"data-recipe-id",
			recipes.find((r) => r.consumer === consumer)!.id,
		);
		await expect(page.locator(".expressive-code")).not.toHaveCount(0);
		await page.getByRole("link", { name: "Open recipe" }).click();
		await expect(page.locator("[data-recipe-content]")).toHaveAttribute(
			"data-recipe-id",
			recipes.find((r) => r.consumer === consumer)!.id,
		);
	}
	await context.close();
});

test("inline selection updates URL, content, history and copy without replacing the page", async ({
	page,
}) => {
	await page.goto("/docs/recipes/direct/");
	await page.evaluate(() => {
		(window as unknown as { recipePageMarker: number }).recipePageMarker = 1;
	});
	await page.getByLabel("Framework", { exact: true }).selectOption("nextjs");
	await expect(page).toHaveURL(/nextjs\/direct\/polling\/$/);
	await page.getByLabel("Connection").selectOption("websocket");
	await expect(page).toHaveURL(/nextjs\/direct\/websocket\/$/);
	await expect(page.locator("[data-recipe-content]")).toHaveAttribute(
		"data-recipe-id",
		"nextjs/direct/websocket",
	);
	await expect(page.locator("[data-recipe-summary]")).toContainText(
		"WebSocket",
	);
	expect(
		await page.evaluate(
			() =>
				(window as unknown as { recipePageMarker: number }).recipePageMarker,
		),
	).toBe(1);
	await page.locator(".expressive-code .copy button").first().click();
	await expect(
		page.locator(".expressive-code .copy .feedback").first(),
	).toHaveText("Copied!");
	await page.goBack();
	await expect(page.locator("[data-recipe-content]")).toHaveAttribute(
		"data-recipe-id",
		"nextjs/direct/polling",
	);
	await expect(page.getByLabel("Connection")).toHaveValue("polling");
	await page.goBack();
	await expect(page).toHaveURL(/\/docs\/recipes\/direct\/$/);
	await expect(page.locator("[data-recipe-content]")).toHaveAttribute(
		"data-recipe-id",
		"vite-react/direct/polling",
	);
	await page.goForward();
	await expect(page.locator("[data-recipe-content]")).toHaveAttribute(
		"data-recipe-id",
		"nextjs/direct/polling",
	);
	await page.reload();
	await expect(page.getByLabel("Framework", { exact: true })).toHaveValue(
		"nextjs",
	);
	await expect(page.locator("[data-recipe-content]")).toHaveAttribute(
		"data-recipe-id",
		"nextjs/direct/polling",
	);
});

test("rapid selections cannot overwrite the latest recipe", async ({
	page,
}) => {
	await page.goto("/docs/recipes/direct/");
	await page.route(
		"**/docs/recipes/vite-react/direct/websocket/",
		async (route) => {
			await new Promise((resolve) => setTimeout(resolve, 300));
			await route.continue();
		},
	);
	await page.getByLabel("Connection").selectOption("websocket");
	await page.getByLabel("Connection").selectOption("sse");
	await expect(page.locator("[data-recipe-content]")).toHaveAttribute(
		"data-recipe-id",
		"vite-react/direct/sse",
	);
	await expect(page).toHaveURL(/vite-react\/direct\/sse\/$/);
	await expect(page.getByLabel("Connection")).toHaveValue("sse");
});

test("failed loading keeps the working recipe and offers a direct link", async ({
	page,
}) => {
	await page.goto("/docs/recipes/direct/");
	await page.route("**/docs/recipes/vite-react/direct/websocket/", (route) =>
		route.fulfill({ status: 503, body: "Unavailable" }),
	);
	await page.getByLabel("Connection").selectOption("websocket");
	await expect(page.locator("[data-recipe-message]")).toContainText(
		"Could not load",
	);
	await expect(page.locator("[data-recipe-content]")).toHaveAttribute(
		"data-recipe-id",
		"vite-react/direct/polling",
	);
	await expect(page.getByLabel("Connection")).toHaveValue("polling");
	await expect(page.getByRole("link", { name: "Open recipe" })).toBeVisible();
	await expect(page.getByRole("link", { name: "Open recipe" })).toHaveAttribute(
		"href",
		"/docs/recipes/vite-react/direct/websocket/",
	);
	await expect(page).toHaveURL(/\/docs\/recipes\/direct\/$/);
});

test("framework changes preserve compatible UI choices and restore them through history", async ({
	page,
}) => {
	await page.goto("/docs/recipes/trpc/");
	const framework = page.getByLabel("Framework", { exact: true });
	const renderer = page.getByLabel("UI library");
	const content = page.locator("[data-recipe-content]");
	await expect(framework.locator("option")).toHaveText([
		"Vite",
		"Next.js",
		"Astro",
		"Nuxt",
		"SvelteKit",
		"React Router",
	]);
	await renderer.selectOption("svelte");
	await expect(content).toHaveAttribute(
		"data-recipe-id",
		"vite-svelte/trpc/trpc-ws",
	);
	await framework.selectOption("astro");
	await expect(content).toHaveAttribute(
		"data-recipe-id",
		"astro-svelte/trpc/trpc-ws",
	);
	await expect(renderer).toHaveValue("svelte");
	await framework.selectOption("nuxt");
	await expect(content).toHaveAttribute("data-recipe-id", "nuxt/trpc/trpc-ws");
	await expect(renderer).toBeHidden();
	await expect(renderer).toHaveValue("vue");
	await page.goBack();
	await expect(content).toHaveAttribute(
		"data-recipe-id",
		"astro-svelte/trpc/trpc-ws",
	);
	await expect(renderer).toBeVisible();
	await expect(renderer).toHaveValue("svelte");
	await page.reload();
	await expect(framework).toHaveValue("astro");
	await expect(renderer).toHaveValue("svelte");
});

test("curated integrations exclude custom UI recipes", async ({ page }) => {
	await page.goto("/docs/recipes/apollo/");
	await expect(
		page.getByLabel("Framework", { exact: true }).locator("option"),
	).toHaveText(["Vite", "Next.js", "Astro", "React Router"]);
	await expect(page.getByLabel("UI library")).toBeHidden();
	await page.goto("/docs/recipes/ai-sdk/");
	await expect(page.getByLabel("UI library").locator("option")).toHaveText([
		"React",
		"Vue",
		"Svelte",
	]);
	await page.getByLabel("Framework", { exact: true }).selectOption("astro");
	await expect(page).toHaveURL(/astro-react\/ai\/chat\/$/);
	await expect(page.getByLabel("UI library").locator("option")).toHaveText([
		"React",
		"Vue",
		"Svelte",
	]);
});

test("failed framework loading restores both framework and UI library", async ({
	page,
}) => {
	await page.goto("/docs/recipes/astro-svelte/trpc/trpc-sse/");
	await page.route("**/docs/recipes/nextjs/trpc/trpc-sse/", (route) =>
		route.fulfill({ status: 503, body: "Unavailable" }),
	);
	await page.getByLabel("Framework", { exact: true }).selectOption("nextjs");
	await expect(page.locator("[data-recipe-message]")).toContainText(
		"Could not load",
	);
	await expect(page.getByLabel("Framework", { exact: true })).toHaveValue(
		"astro",
	);
	await expect(page.getByLabel("UI library")).toBeVisible();
	await expect(page.getByLabel("UI library")).toHaveValue("svelte");
	await expect(page.locator("[data-recipe-content]")).toHaveAttribute(
		"data-recipe-id",
		"astro-svelte/trpc/trpc-sse",
	);
});

test("retired recipe URLs lead to the relevant integration guidance", async ({
	page,
}) => {
	await page.goto("/docs/recipes/astro-vue/apollo/graphql-sse/");
	await expect(page).toHaveURL(/integrations\/apollo\/#other-ui-frameworks$/);
	await expect(
		page.getByRole("heading", { name: "Other UI frameworks", exact: true }),
	).toBeVisible();
	await page.goto("/docs/recipes/vite-solid/ai/chat/");
	await expect(page).toHaveURL(/integrations\/ai-sdk\/#use-it-in-your-app$/);
});
