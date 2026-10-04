import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Recipe } from "./catalogue.ts";

export interface ExampleFile {
	path: string;
	source: string;
	code: string;
	lang: string;
	section: "config" | "code" | "mount";
}
export function recipeFiles(recipe: Recipe): ExampleFile[] {
	const root = resolve("recipes");
	const { context: c, consumer, source } = recipe;
	const files: ExampleFile[] = [];
	const add = (
		source: string,
		path: string,
		section: ExampleFile["section"] = "code",
	) => {
		files.push({
			source: resolve(root, source),
			path,
			code: readFileSync(resolve(root, source), "utf8"),
			lang: path.split(".").at(-1) === "mjs" ? "js" : path.split(".").at(-1)!,
			section,
		});
	};
	const local = (source: string, name: string) =>
		add(source, `${c.folder}/${name}`);
	const suffix =
		c.renderer === "vue" ? "vue" : c.renderer === "svelte" ? "svelte" : "tsx";
	const authoredSuffix = c.renderer === "solid" ? "solid.tsx" : suffix;
	const config =
		c.framework === "astro"
			? "astro.config.mjs"
			: c.framework === "nuxt"
				? "nuxt.config.ts"
				: c.framework === "nextjs"
					? "next.config.ts"
					: "vite.config.ts";
	add(`hosts/${c.id}/${config}`, config, "config");
	local("live.ts", "live.ts");
	if (consumer !== "ai") local("queue-types.ts", "queue-types.ts");
	if (["direct", "query", "swr"].includes(consumer))
		local(`sources/${source}.ts`, "source.ts");
	if (consumer === "query") {
		local("query/feed.ts", "feed.ts");
		local(`query/Queue.${authoredSuffix}`, `Queue.${suffix}`);
	}
	if (consumer === "apollo") {
		local(`apollo/${source}.ts`, "endpoint.ts");
		local("apollo/document.ts", "document.ts");
		if (c.framework !== "nextjs") local("apollo/client.ts", "client.ts");
		local("apollo/Queue.tsx", "Queue.tsx");
	}
	if (consumer === "trpc") {
		local("trpc/router.ts", "router.ts");
		local(`trpc/${source}.ts`, "watch.ts");
	}
	if (consumer === "ai") local("ai/transport.ts", "transport.ts");
	local(
		consumer === "apollo" && c.framework === "nextjs"
			? "apollo/NextRecipe.tsx"
			: `${consumer}/Recipe.${authoredSuffix}`,
		`Recipe.${suffix}`,
	);
	if (c.framework === "vite")
		add(`hosts/${c.id}/App.${suffix}`, `src/App.${suffix}`, "mount");
	if (c.framework === "astro")
		add(`hosts/${c.id}/queue.astro`, "src/pages/queue.astro", "mount");
	if (c.framework === "nextjs") {
		add("hosts/nextjs/Live.tsx", "app/Live.tsx", "mount");
		add("hosts/nextjs/page.tsx", "app/page.tsx", "mount");
	}
	if (c.framework === "nuxt")
		add("hosts/nuxt/queue.vue", "app/pages/queue.vue", "mount");
	if (c.framework === "sveltekit")
		add(
			"hosts/sveltekit/+page.svelte",
			"src/routes/queue/+page.svelte",
			"mount",
		);
	if (c.framework === "react-router") {
		add("hosts/react-router/queue.tsx", "app/routes/queue.tsx", "mount");
		add("hosts/react-router/routes.ts", "app/routes.ts", "mount");
	}
	return files;
}
export function dependencies({ consumer, source, context }: Recipe) {
	const result = ["spinetab"];
	if (source.startsWith("graphql-"))
		result.push(
			"graphql@^17.0.2",
			`${source}@^${source === "graphql-ws" ? "6.3.0" : "2.6.1"}`,
		);
	if (source === "socket-io") result.push("socket.io-client@^4.8.4");
	if (consumer === "query")
		result.push(
			"@tanstack/query-core@^5.104.0",
			`@tanstack/${context.renderer}-query@^${context.renderer === "svelte" ? "6.3.0" : "5.104.0"}`,
		);
	if (consumer === "swr") result.push("swr@^2.5.1");
	if (consumer === "apollo") {
		result.push("@apollo/client@^4.3.1", "rxjs@^7.8.2");
		if (context.framework === "nextjs")
			result.push("@apollo/client-integration-nextjs@^0.14.5");
	}
	if (consumer === "trpc")
		result.push("@trpc/client@^11.19.0", "@trpc/server@^11.19.0");
	if (consumer === "ai") {
		result.push("ai@^7.0.116", "zod@^4");
		if (context.renderer !== "solid")
			result.push(
				`@ai-sdk/${context.renderer}@^${context.renderer === "svelte" ? "5.0.116" : context.renderer === "react" ? "4.0.119" : "4.0.116"}`,
			);
	}
	return result;
}
