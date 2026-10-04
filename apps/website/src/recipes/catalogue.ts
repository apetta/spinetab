export const contexts = [
	{
		id: "vite-react",
		framework: "vite",
		renderer: "react",
		label: "Vite · React",
		folder: "src/recipe",
	},
	{
		id: "vite-vue",
		framework: "vite",
		renderer: "vue",
		label: "Vite · Vue",
		folder: "src/recipe",
	},
	{
		id: "vite-svelte",
		framework: "vite",
		renderer: "svelte",
		label: "Vite · Svelte",
		folder: "src/recipe",
	},
	{
		id: "vite-solid",
		framework: "vite",
		renderer: "solid",
		label: "Vite · Solid",
		folder: "src/recipe",
	},
	{
		id: "nextjs",
		framework: "nextjs",
		renderer: "react",
		label: "Next.js",
		folder: "app/recipe",
	},
	{
		id: "astro-react",
		framework: "astro",
		renderer: "react",
		label: "Astro · React",
		folder: "src/components/recipe",
	},
	{
		id: "astro-vue",
		framework: "astro",
		renderer: "vue",
		label: "Astro · Vue",
		folder: "src/components/recipe",
	},
	{
		id: "astro-svelte",
		framework: "astro",
		renderer: "svelte",
		label: "Astro · Svelte",
		folder: "src/components/recipe",
	},
	{
		id: "astro-solid",
		framework: "astro",
		renderer: "solid",
		label: "Astro · Solid",
		folder: "src/components/recipe",
	},
	{
		id: "nuxt",
		framework: "nuxt",
		renderer: "vue",
		label: "Nuxt",
		folder: "app/components/recipe",
	},
	{
		id: "sveltekit",
		framework: "sveltekit",
		renderer: "svelte",
		label: "SvelteKit",
		folder: "src/lib/recipe",
	},
	{
		id: "react-router",
		framework: "react-router",
		renderer: "react",
		label: "React Router",
		folder: "app/recipe",
	},
] as const;
export type Context = (typeof contexts)[number];
export const frameworks = {
	vite: "Vite",
	nextjs: "Next.js",
	astro: "Astro",
	nuxt: "Nuxt",
	sveltekit: "SvelteKit",
	"react-router": "React Router",
} as const;
export const renderers = {
	react: "React",
	vue: "Vue",
	svelte: "Svelte",
	solid: "Solid",
} as const;
export const consumers = {
	direct: "Component state",
	query: "TanStack Query",
	swr: "SWR",
	apollo: "Apollo Client",
	trpc: "tRPC",
	ai: "AI SDK",
} as const;
export type Consumer = keyof typeof consumers;
export const sections: Record<
	Consumer,
	{ slug: string; label: string; description: string }
> = {
	direct: {
		slug: "direct",
		label: "Direct subscriptions",
		description: "Render a live feed with your framework's component binding.",
	},
	query: {
		slug: "tanstack-query",
		label: "TanStack Query",
		description: "Feed shared updates into your existing query cache.",
	},
	swr: {
		slug: "swr",
		label: "SWR",
		description: "Use shared subscriptions in a React app with SWR.",
	},
	apollo: {
		slug: "apollo",
		label: "Apollo Client",
		description: "Share GraphQL subscriptions through Apollo's client.",
	},
	trpc: {
		slug: "trpc",
		label: "tRPC",
		description: "Subscribe to a typed procedure over WebSocket or SSE.",
	},
	ai: {
		slug: "ai-sdk",
		label: "AI SDK",
		description: "Follow and resume the same chat generation across tabs.",
	},
};
export const sources = {
	polling: "HTTP polling",
	sse: "Server-sent events",
	websocket: "WebSocket",
	stream: "Fetch stream",
	"graphql-ws": "GraphQL over WebSocket",
	"graphql-sse": "GraphQL over SSE",
	"socket-io": "Socket.IO",
	"trpc-ws": "tRPC over WebSocket",
	"trpc-sse": "tRPC over SSE",
	chat: "Resumable chat",
} as const;
export type Source = keyof typeof sources;
const ordinary = [
	"polling",
	"sse",
	"websocket",
	"stream",
	"graphql-ws",
	"graphql-sse",
	"socket-io",
] as const;
const routes: Record<Consumer, readonly Source[]> = {
	direct: ordinary,
	query: ordinary,
	swr: ordinary,
	apollo: ["graphql-ws", "graphql-sse"],
	trpc: ["trpc-ws", "trpc-sse"],
	ai: ["chat"],
};
export interface Recipe {
	id: string;
	context: Context;
	consumer: Consumer;
	source: Source;
	url: string;
}
const combinations: Recipe[] = contexts.flatMap((context) =>
	(Object.keys(routes) as Consumer[]).flatMap((consumer) =>
		consumer === "swr" && context.renderer !== "react"
			? []
			: routes[consumer].map((source) => {
					const id = `${context.id}/${consumer}/${source}`;
					return { id, context, consumer, source, url: `/docs/recipes/${id}/` };
				}),
	),
);
export const retiredRecipes = combinations.filter(
	(r) =>
		(r.consumer === "apollo" && r.context.renderer !== "react") ||
		(r.consumer === "ai" && r.context.renderer === "solid"),
);
export const recipes = combinations.filter((r) => !retiredRecipes.includes(r));
export function retiredDestination(recipe: Recipe) {
	return recipe.consumer === "apollo"
		? "/docs/integrations/apollo/#other-ui-frameworks"
		: "/docs/integrations/ai-sdk/#use-it-in-your-app";
}
export const references: Record<Consumer, string> = {
	direct: "/docs/frameworks/",
	query: "/docs/integrations/tanstack-query/",
	swr: "/docs/integrations/swr/",
	apollo: "/docs/integrations/apollo/",
	trpc: "/docs/integrations/trpc/",
	ai: "/docs/integrations/ai-sdk/",
};
