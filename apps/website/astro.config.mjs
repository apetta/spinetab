import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import agentDocs from "./src/integrations/agent-docs.ts";
import { retiredRecipes } from "./src/recipes/catalogue.ts";

const retiredPaths = new Set(retiredRecipes.map((recipe) => recipe.url));

export default defineConfig({
	site: "https://spinetab.com",
	output: "static",
	// Preserve spaces around inline prose when the formatter wraps HTML tags.
	compressHTML: true,
	integrations: [
		react(),
		sitemap({ filter: (page) => !retiredPaths.has(new URL(page).pathname) }),
		starlight({
			title: "Spinetab",
			favicon: "/favicon.svg",
			customCss: ["./src/styles/docs.css"],
			components: { PageTitle: "./src/components/DocsPageTitle.astro" },
			sidebar: [
				{
					label: "Start here",
					items: [
						{ label: "Overview", slug: "docs" },
						"docs/getting-started",
						"docs/using-agents",
						"docs/choose-integration",
						"docs/frameworks",
					],
				},
				{
					label: "Frameworks",
					items: [
						"docs/setup/vite",
						"docs/setup/nextjs",
						"docs/setup/astro",
						"docs/setup/nuxt",
						"docs/setup/sveltekit",
						"docs/setup/react-router",
					],
				},
				{
					label: "Examples",
					items: ["docs/examples/orbit", "docs/examples/live-transit"],
				},
				{
					label: "Subscriptions",
					collapsed: true,
					items: [
						"docs/transports/polling",
						"docs/transports/sse",
						"docs/transports/stream",
						"docs/transports/websocket",
						"docs/protocols/graphql",
						"docs/protocols/socket-io",
					],
				},
				{
					label: "Library integrations",
					collapsed: true,
					items: [
						"docs/integrations/apollo",
						"docs/integrations/tanstack-query",
						"docs/integrations/swr",
						"docs/integrations/trpc",
						"docs/integrations/ai-sdk",
					],
				},
				{
					label: "Recipes",
					items: [
						{ label: "Direct subscriptions", link: "/docs/recipes/direct/" },
						{ label: "Apollo Client", link: "/docs/recipes/apollo/" },
						{ label: "TanStack Query", link: "/docs/recipes/tanstack-query/" },
						{ label: "SWR", link: "/docs/recipes/swr/" },
						{ label: "tRPC", link: "/docs/recipes/trpc/" },
						{ label: "AI SDK", link: "/docs/recipes/ai-sdk/" },
					],
				},
				{
					label: "Authentication and recovery",
					collapsed: true,
					items: [
						"docs/concepts/credentials",
						"docs/concepts/status",
						"docs/concepts/continuity",
						"docs/concepts/modes",
					],
				},
				{
					label: "Configuration",
					collapsed: true,
					items: ["docs/bundlers", "docs/your-worker", "docs/deployment"],
				},
				{
					label: "Reference",
					collapsed: true,
					items: [
						"docs/concepts/identity",
						"docs/concepts/defaults",
						"docs/bindings",
						"docs/compatibility",
						"docs/limits",
					],
				},
				{ label: "GitHub", link: "https://github.com/apetta/spinetab" },
			],
		}),
		agentDocs(),
	],
});
