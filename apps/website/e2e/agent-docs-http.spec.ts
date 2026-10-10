import { expect, test } from "@playwright/test";

test("agents can discover and fetch every indexed Markdown page", async ({
	request,
}) => {
	test.setTimeout(120_000);
	const index = await request.get("/llms.txt");
	expect(index.status()).toBe(200);
	expect(index.headers()["content-type"]).toMatch(/^text\/plain/);
	const recipeIndex = await request.get("/recipe-index.md");
	expect(recipeIndex.status()).toBe(200);
	const links = [
		...`${await index.text()}\n${await recipeIndex.text()}`.matchAll(
			/\]\((https:\/\/spinetab\.com\/[^)]+)\)/g,
		),
	];
	const paths = new Set(links.map((match) => new URL(match[1] ?? "").pathname));
	expect(paths.size).toBeGreaterThan(250);
	for (const path of paths) {
		const response = await request.get(path);
		expect(response.status(), path).toBe(200);
		expect(response.headers()["content-type"], path).toBe(
			"text/markdown; charset=utf-8",
		);
		expect(response.headers().link, path).toContain(
			'</llms.txt>; rel="describedby"',
		);
		expect(response.headers()["x-robots-tag"], path).toMatch(
			/(?:^|,\s*)noindex(?:,|$)/,
		);
		expect(await response.text(), path).toMatch(
			/^(?:---\n|# Spinetab recipes\n)/,
		);
	}
});

test("HTML and Markdown stay separate and conditional requests revalidate", async ({
	request,
}) => {
	for (const path of [
		"/llms.txt",
		"/index.md",
		"/docs.md",
		"/docs/recipes/nextjs/apollo/graphql-sse.md",
	]) {
		const response = await request.get(path);
		expect(response.status(), path).toBe(200);
		const etag = response.headers().etag;
		expect(etag, path).toBeTruthy();
		expect(response.headers()["cache-control"], path).toBe(
			"public, max-age=0, must-revalidate",
		);
		const cached = await request.get(path, {
			headers: { "If-None-Match": etag ?? "" },
		});
		expect(cached.status(), path).toBe(304);
		expect(await cached.body()).toHaveLength(0);
		const stale = await request.get(path, {
			headers: { "If-None-Match": '"previous-build"' },
		});
		expect(stale.status(), path).toBe(200);
		expect(await stale.text()).toBe(await response.text());
		const head = await request.head(path);
		expect(head.status(), path).toBe(200);
		expect(head.headers().etag).toBe(etag);
		expect(head.headers()["content-type"]).toBe(
			response.headers()["content-type"],
		);
		expect(await head.body()).toHaveLength(0);
		for (const accept of ["text/html", "text/markdown", "*/*"]) {
			const repeated = await request.get(path, { headers: { Accept: accept } });
			expect(repeated.headers()["content-type"]).toBe(
				response.headers()["content-type"],
			);
			expect(await repeated.text()).toBe(await response.text());
		}
	}
	for (const path of ["/", "/docs/", "/docs/setup/nextjs/"]) {
		const response = await request.get(path, {
			headers: { Accept: "text/markdown" },
		});
		expect(response.headers()["content-type"]).toMatch(/^text\/html/);
		expect(await response.text()).toContain(
			'rel="alternate" type="text/markdown"',
		);
	}
	for (const path of [
		"/docs/not-a-page.md",
		"/docs/recipes/astro-vue/apollo/graphql-sse.md",
		"/404.md",
	]) {
		const response = await request.get(path);
		expect(response.status(), path).toBe(404);
	}
});

test("Markdown navigation leads to complete setup and recovery guidance", async ({
	request,
}) => {
	const homepage = await (await request.get("/index.md")).text();
	expect(homepage).toContain("# One connection, every tab.\n");
	expect(homepage).not.toMatch(
		/●|Tab (one|two|three)|spinetab \/ shared connection/,
	);
	expect(homepage).toContain("## How connection sharing works");
	const index = await (await request.get("/llms.txt")).text();
	expect(index).toContain("/docs/setup/nextjs.md");
	expect(index).toContain("/docs/concepts/continuity.md");
	const recipes = await (await request.get("/recipe-index.md")).text();
	for (const path of [
		"/docs/recipes/nextjs/apollo/graphql-sse.md",
		"/docs/recipes/vite-vue/query/sse.md",
	]) {
		expect(recipes).toContain(path);
		const markdown = await (await request.get(path)).text();
		expect(markdown).toContain("## Before you start");
		expect(markdown).toMatch(/## 4\\?\. Mount the view/);
		expect(markdown).toContain(
			"Reconnecting alone does not reconstruct missed state",
		);
		expect(markdown).toContain("/docs/concepts/continuity.md");
		expect(markdown).toContain("**File:");
	}
});
