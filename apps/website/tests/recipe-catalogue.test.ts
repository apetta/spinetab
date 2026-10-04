import assert from "node:assert/strict";
import { test } from "node:test";
import { recipes, retiredRecipes } from "../src/recipes/catalogue.ts";
import { dependencies, recipeFiles } from "../src/recipes/files.ts";

// Keep the expected inventory independent of catalogue compatibility rules.
const reactHosts = ["vite-react", "nextjs", "astro-react", "react-router"];
const otherHosts = [
	"vite-vue",
	"vite-svelte",
	"vite-solid",
	"astro-vue",
	"astro-svelte",
	"astro-solid",
	"nuxt",
	"sveltekit",
];
const feeds = [
	"websocket",
	"sse",
	"stream",
	"polling",
	"graphql-ws",
	"graphql-sse",
	"socket-io",
];
const expected = [...reactHosts, ...otherHosts].flatMap((host) => [
	...["direct", "query", ...(reactHosts.includes(host) ? ["swr"] : [])].flatMap(
		(consumer) => feeds.map((source) => `${host}/${consumer}/${source}`),
	),
	...(reactHosts.includes(host)
		? ["graphql-ws", "graphql-sse"].map((source) => `${host}/apollo/${source}`)
		: []),
	...["trpc-ws", "trpc-sse"].map((source) => `${host}/trpc/${source}`),
	...(!host.endsWith("-solid") ? [`${host}/ai/chat`] : []),
]);
function checkCoverage(ids: string[]) {
	assert.equal(ids.length, new Set(ids).size, "duplicate recipe");
	assert.deepEqual([...ids].sort(), [...expected].sort());
}
test("every curated stack has exactly one recipe", () => {
	assert.equal(expected.length, 238);
	assert.equal(retiredRecipes.length, 18);
	checkCoverage(recipes.map((r) => r.id));
});
test("each recipe has unique files, complete stages and resolving local imports", () => {
	for (const recipe of recipes) {
		assert.equal(recipe.url, `/docs/recipes/${recipe.id}/`);
		const files = recipeFiles(recipe);
		const paths = files.map((f) => f.path);
		assert.equal(paths.length, new Set(paths).size, recipe.id);
		for (const stage of ["config", "code", "mount"])
			assert.ok(
				files.some((f) => f.section === stage),
				`${recipe.id}: ${stage}`,
			);
		assert.ok(
			files.some((f) => f.code.includes("anonymous: true")),
			recipe.id,
		);
		const peers = dependencies(recipe).map((name) =>
			name.replace(/@[^@]+$/, ""),
		);
		for (const file of files) {
			for (const [, specifier] of file.code.matchAll(
				/(?:from\s+|import\s*)["']([^"']+)["']/g,
			)) {
				if (specifier!.startsWith(".")) {
					const resolved = new URL(
						specifier!,
						`https://recipe.invalid/${file.path}`,
					).pathname.slice(1);
					assert.ok(
						paths.some(
							(p) =>
								p === resolved ||
								p.replace(/\.(?:tsx?|vue|svelte|astro)$/, "") === resolved,
						),
						`${recipe.id}: ${file.path} -> ${specifier}`,
					);
				} else if (file.section === "code") {
					const root = specifier!.startsWith("@")
						? specifier!.split("/").slice(0, 2).join("/")
						: specifier!.split("/")[0];
					assert.ok(
						peers.includes(root!) ||
							["react", "vue", "svelte", "solid-js"].includes(root!),
						`${recipe.id}: missing dependency ${root}`,
					);
				}
			}
		}
	}
});
