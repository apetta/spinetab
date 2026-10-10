import TurndownService from "turndown";
import {
	consumers,
	type Recipe,
	recipes,
	sources,
} from "../recipes/catalogue.ts";
import { recipeFiles } from "../recipes/files.ts";

export function markdownPath(pathname: string) {
	return pathname === "/" ? "/index.md" : `${pathname.replace(/\/$/, "")}.md`;
}

export function recipeTitle(recipe: Recipe) {
	return `${recipe.context.label} · ${consumers[recipe.consumer]} · ${sources[recipe.source]}`;
}

export const escapeLabel = (value: string) => value.replace(/[\\[\]]/g, "\\$&");

export function convertPage(document: Document, url: URL, paths: Set<string>) {
	const main = document.querySelector("main");
	const heading = main?.querySelector("h1");
	if (!main || !heading) throw new Error(`Missing main heading: ${url}`);
	const content = main.cloneNode(true) as HTMLElement;
	for (const node of content.querySelectorAll(
		'[aria-hidden="true"],[data-markdown-exclude]',
	))
		node.remove();
	for (const br of content.querySelectorAll(
		"h1 br,h2 br,h3 br,h4 br,h5 br,h6 br",
	))
		br.replaceWith(document.createTextNode(" "));
	for (const code of content.querySelectorAll("a > span + code"))
		code.before(document.createTextNode(" "));
	for (const link of content.querySelectorAll("a + a")) {
		if (link.previousSibling?.nodeName === "A")
			link.before(document.createTextNode(" "));
	}
	const recipeId = content
		.querySelector("[data-recipe-id]")
		?.getAttribute("data-recipe-id");
	const recipe = recipes.find((entry) => entry.id === recipeId);
	if (recipeId && !recipe) throw new Error(`Unknown recipe: ${recipeId}`);
	const title =
		recipe?.url === url.pathname
			? recipeTitle(recipe)
			: url.pathname === "/"
				? "Spinetab"
				: (heading.textContent?.trim() ?? "");
	const contentHeading = content.querySelector("h1");
	if (recipe?.url === url.pathname && contentHeading)
		contentHeading.textContent = title;
	const files = recipe ? recipeFiles(recipe) : [];
	const turndown = new TurndownService({
		headingStyle: "atx",
		codeBlockStyle: "fenced",
		bulletListMarker: "-",
	});

	turndown.addRule("tables", {
		filter: "table",
		replacement: (_content, node) => {
			const rows = Array.from((node as HTMLTableElement).rows).map((row) =>
				Array.from(row.cells).map((cell) => {
					if (cell.colSpan !== 1 || cell.rowSpan !== 1)
						throw new Error(
							`Markdown cannot represent merged table cells: ${url}`,
						);
					return turndown
						.turndown(cell.innerHTML)
						.replace(/\n/g, " ")
						.replace(/\|/g, "\\|");
				}),
			);
			const header = rows[0];
			if (!header) return "";
			if (rows.some((row) => row.length !== header.length))
				throw new Error(`Uneven table columns: ${url}`);
			const format = (row: string[]) => `| ${row.join(" | ")} |`;
			return `\n\n${[
				format(header),
				format(header.map(() => "---")),
				...rows.slice(1).map(format),
			].join("\n")}\n\n`;
		},
	});
	turndown.addRule("code", {
		filter: (node) =>
			node.classList.contains("expressive-code") || node.nodeName === "PRE",
		replacement: (_content, node) => {
			const pre = node.nodeName === "PRE" ? node : node.querySelector("pre");
			if (!pre) throw new Error(`Code widget has no pre element: ${url}`);
			const path = node.querySelector("figcaption .title")?.textContent?.trim();
			const original = files.find((file) => file.path === path);
			const copy = node.querySelector("[data-code]")?.getAttribute("data-code");
			// Expressive Code encodes line breaks in its clipboard data as DEL.
			const code =
				original?.code ??
				copy?.replace(/\u007f/g, "\n") ??
				pre.textContent ??
				"";
			const runs = code.match(/`+/g) ?? [];
			const fence = "`".repeat(
				Math.max(3, ...runs.map((run) => run.length + 1)),
			);
			const language = pre.getAttribute("data-language") ?? "";
			return `\n\n${path ? `**File: \`${path}\`**\n\n` : ""}${fence}${language}\n${code.replace(/\n+$/, "")}\n${fence}\n\n`;
		},
	});
	turndown.addRule("panels", {
		filter: (node) => node.getAttribute("role") === "tabpanel",
		replacement: (body, node) => {
			const label = document
				.getElementById(node.getAttribute("aria-labelledby") ?? "")
				?.textContent?.trim();
			if (!label) throw new Error(`Unlabelled tab panel: ${url}`);
			return `\n\n### ${label}\n\n${body.trim()}\n\n`;
		},
	});
	turndown.addRule("picker", {
		filter: (node) => node.hasAttribute("data-recipe-picker"),
		replacement: (_body, node) => {
			const choices: string[][] = JSON.parse(
				node.getAttribute("data-recipes") ?? "[]",
			);
			const available = new Set(choices.map((choice) => choice[3]));
			const relevant = recipes.filter(
				(entry) =>
					available.has(entry.url) &&
					(recipe?.url !== url.pathname ||
						(entry.context.id === recipe.context.id &&
							entry.consumer === recipe.consumer)),
			);
			if (!relevant.length) throw new Error(`Empty recipe selector: ${url}`);
			return `\n\n**Available recipes**\n\n${relevant.map((entry) => `- [${escapeLabel(recipeTitle(entry))}](${new URL(markdownPath(entry.url), url.origin)})`).join("\n")}\n\n`;
		},
	});
	turndown.addRule("blockLinks", {
		filter: (node) =>
			node.nodeName === "A" && Boolean(node.querySelector("h2,h3,p,div")),
		replacement: (_body, node) => {
			const text = Array.from(node.children)
				.map((child) => child.textContent?.trim())
				.join(" ")
				.replace(/\s+/g, " ");
			return `[${escapeLabel(text)}](${node.getAttribute("href")})`;
		},
	});
	for (const island of content.querySelectorAll("astro-island")) {
		const note = document.createElement("p");
		note.append("The interactive demonstration is available in the ");
		const link = document.createElement("a");
		link.href = url.href;
		link.textContent = "browser version";
		link.setAttribute("data-keep-html", "");
		note.append(link, ". This Markdown page does not contain live data.");
		island.replaceWith(note);
	}
	content
		.querySelectorAll(
			"script,style,link,svg,.sl-anchor-link,[role='tablist'],.pagination,footer,nav",
		)
		.forEach((node) => {
			node.remove();
		});
	for (const link of content.querySelectorAll<HTMLAnchorElement>("a[href]")) {
		const target = new URL(link.getAttribute("href") ?? "", url);
		if (
			!link.hasAttribute("data-keep-html") &&
			target.origin === url.origin &&
			paths.has(target.pathname)
		)
			target.pathname = markdownPath(target.pathname);
		link.setAttribute("href", target.href);
	}
	const description =
		document.querySelector<HTMLMetaElement>('meta[name="description"]')
			?.content ?? "";
	const header = `---\ntitle: ${JSON.stringify(title)}\nurl: ${JSON.stringify(url.href)}\ndescription: ${JSON.stringify(description)}\n---\n\n`;
	return {
		title,
		description,
		markdown: `${header}${turndown.turndown(content)}\n`,
	};
}
