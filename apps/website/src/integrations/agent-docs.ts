import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AstroIntegration } from "astro";
import { JSDOM } from "jsdom";
import { contexts, recipes } from "../recipes/catalogue.ts";
import {
	convertPage,
	escapeLabel,
	markdownPath,
	recipeTitle,
} from "./markdown.ts";

export default function agentDocs(): AstroIntegration {
	let site: string;
	return {
		name: "spinetab-agent-docs",
		hooks: {
			"astro:config:done": ({ config }) => {
				if (!config.site || config.output !== "static" || config.base !== "/")
					throw new Error(
						"Agent docs require a static site with a canonical origin and root base.",
					);
				site = config.site;
			},
			"astro:build:done": async ({ dir, logger }) => {
				const root = fileURLToPath(dir);
				const files = (await readdir(root, { recursive: true }))
					.filter((path) => path.endsWith(".html") && path !== "404.html")
					.sort();
				const pages: { path: string; file: string; html: string }[] = [];
				for (const file of files) {
					const html = await readFile(join(root, file), "utf8");
					const dom = new JSDOM(html);
					const redirect = dom.window.document.querySelector(
						'meta[http-equiv="refresh"]',
					);
					dom.window.close();
					if (redirect) continue;
					const path = `/${file.replace(/index\.html$/, "").replace(/\.html$/, "")}`;
					pages.push({ path, file, html });
				}
				const paths = new Set(pages.map((page) => page.path));
				if (
					new Set(pages.map((page) => markdownPath(page.path))).size !==
					pages.length
				)
					throw new Error("Two pages resolve to the same Markdown URL.");
				for (const recipe of recipes) {
					if (!paths.has(recipe.url))
						throw new Error(`Missing built recipe: ${recipe.id}`);
				}
				const concreteRecipes = new Set(recipes.map((recipe) => recipe.url));
				const entries: string[] = [];
				for (const page of pages) {
					const url = new URL(page.path, site);
					const dom = new JSDOM(page.html);
					try {
						const { title, description, markdown } = convertPage(
							dom.window.document,
							url,
							paths,
						);
						const mdPath = markdownPath(page.path);
						const output = join(root, mdPath.slice(1));
						await mkdir(dirname(output), { recursive: true });
						await writeFile(output, markdown);
						if (!concreteRecipes.has(page.path))
							entries.push(
								`- [${escapeLabel(title)}](${new URL(mdPath, site)}): ${description.replace(/\s+/g, " ")}`,
							);
						const discovery = `<link rel="alternate" type="text/markdown" href="${mdPath}"><link rel="describedby" type="text/plain" href="/llms.txt">`;
						await writeFile(
							join(root, page.file),
							page.html.replace("</head>", `${discovery}</head>`),
						);
					} finally {
						dom.window.close();
					}
				}
				const recipeIndex = `# Spinetab recipes\n\nChoose your app, data library and connection. Each recipe includes installation, configuration, component lifecycle and recovery guidance.\n\n${contexts
					.map(
						(context) =>
							`## ${context.label}\n\n${recipes
								.filter((recipe) => recipe.context.id === context.id)
								.map(
									(recipe) =>
										`- [${escapeLabel(recipeTitle(recipe))}](${new URL(markdownPath(recipe.url), site)})`,
								)
								.join("\n")}`,
					)
					.join("\n\n")}\n`;
				await writeFile(join(root, "recipe-index.md"), recipeIndex);
				await writeFile(
					join(root, "llms.txt"),
					`# Spinetab\n\n> A client-side TypeScript library for sharing live subscriptions across browser tabs.\n\nStart with your framework's setup guide, then choose a recipe for your existing API and data library. Read continuity guidance before relying on reconnection to recover missed updates.\n\nEvery page below has a generated Markdown version. Examples describe interactive browser demonstrations; the Markdown does not contain live telemetry.\n\n## Recipes\n\n- [Complete recipes by app, data library and connection](${new URL("/recipe-index.md", site)})\n\n## Documentation\n\n${entries.join("\n")}\n`,
				);
				logger.info(
					`Generated ${pages.length} Markdown pages, recipe index and llms.txt`,
				);
			},
		},
	};
}
