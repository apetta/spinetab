import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import type { Root, RootContent } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { convertPage, markdownPath } from "../src/integrations/markdown.ts";
import { recipes, retiredRecipes } from "../src/recipes/catalogue.ts";
import { recipeFiles } from "../src/recipes/files.ts";

const parser = unified().use(remarkParse).use(remarkGfm);
const parse = (markdown: string) =>
	parser.parse(markdown.replace(/^---\n[\s\S]*?\n---\n/, ""));
const normal = (value: string) =>
	value.replace(/\r\n/g, "\n").replace(/\n+$/, "");
const squash = (value: string) => value.replace(/\s+/g, " ").trim();
type Node = Root | RootContent;
function nodes<T extends RootContent["type"]>(
	tree: Node,
	type: T,
): Extract<RootContent, { type: T }>[] {
	const found = tree.type === type ? [tree] : [];
	if ("children" in tree) {
		for (const child of tree.children)
			found.push(...nodes(child as Node, type));
	}
	return found as Extract<RootContent, { type: T }>[];
}
function text(node: Node): string {
	if ("value" in node) return node.value;
	return "children" in node
		? node.children.map((child) => text(child as Node)).join("")
		: "";
}
function offset(node: Node, edge: "start" | "end") {
	const value = node.position?.[edge].offset;
	assert.ok(value !== undefined, "Markdown parser omitted source positions");
	return value;
}

test("conversion preserves executable code, labelled choices, pipe cells and crosslinks", () => {
	const dom = new JSDOM(`<main><h1>Guide</h1><h2>Mount</h2>
	<div role="tablist"><button id="react">React</button><button id="vue">Vue</button></div>
	<div role="tabpanel" aria-labelledby="react"><div class="expressive-code"><figure><figcaption><span class="title">config.ts</span></figcaption><pre data-language="ts"><code>wrong highlighted text</code></pre><button data-code="export default {&#x7f;  value: 1 // comment&#x7f;}"></button></figure></div></div>
	<div role="tabpanel" aria-labelledby="vue"><p>Vue lifecycle guidance.</p><pre data-language="ts"><code>const fence = '\`\`\`';</code></pre></div>
	<table><tr><th>Type</th><th>Meaning</th></tr><tr><td><code>string | ArrayBuffer</code></td><td>Either</td></tr></table>
	<p><a href="/docs/concepts/continuity/#recover">Recovery</a> and <a href="https://example.com/">external</a>.</p><astro-island><p>999 connections</p></astro-island></main>`);
	try {
		const result = convertPage(
			dom.window.document,
			new URL("https://spinetab.com/docs/guide/"),
			new Set(["/docs/guide/", "/docs/concepts/continuity/"]),
		);
		const tree = parse(result.markdown);
		assert.deepEqual(
			nodes(tree, "code").map(({ value, lang }) => ({ value, lang })),
			[
				{ value: "export default {\n  value: 1 // comment\n}", lang: "ts" },
				{ value: "const fence = '```';", lang: "ts" },
			],
		);
		const cell = nodes(tree, "table")[0]?.children[1]?.children[0];
		assert.ok(cell);
		assert.equal(text(cell), "string | ArrayBuffer");
		assert.match(result.markdown, /### React\n\n\*\*File: `config.ts`\*\*/);
		assert.match(result.markdown, /### Vue\n\nVue lifecycle guidance/);
		assert.match(
			result.markdown,
			/https:\/\/spinetab.com\/docs\/concepts\/continuity.md#recover/,
		);
		assert.match(result.markdown, /https:\/\/example.com\//);
		assert.doesNotMatch(
			result.markdown,
			/999 connections|#react|wrong highlighted text/,
		);
	} finally {
		dom.window.close();
	}
});

test("conversion excludes decoration without losing hidden guidance or altering HTML", () => {
	const dom = new JSDOM(`<main><h1>One connection,<br>every tab.</h1>
	<figure><div aria-hidden="true"><p>● ● ●Tab three</p><span aria-hidden="false">Decorative child</span></div><figcaption>One connection serves three tabs.</figcaption></figure>
	<section data-markdown-exclude><h2>Browser-only content</h2><astro-island>Excluded demonstration</astro-island></section>
	<div role="tablist"><button id="choice">Alternative</button></div>
	<div role="tabpanel" aria-labelledby="choice" hidden><p>Hidden setup guidance.</p><pre data-language="html"><code>&lt;span aria-hidden="true"&gt;Icon&lt;/span&gt;</code></pre></div>
	<p aria-hidden="false">Visible guidance.</p>
	<p><a href="/docs/">First</a><a href="/docs/">Second</a></p>
	<a href="/docs/"><span>WebSocket</span><code>/websocket</code></a></main>`);
	try {
		const before = dom.window.document.body.innerHTML;
		const { markdown } = convertPage(
			dom.window.document,
			new URL("https://spinetab.com/"),
			new Set(["/", "/docs/"]),
		);
		const tree = parse(markdown);
		const heading = nodes(tree, "heading")[0];
		assert.ok(heading);
		assert.equal(text(heading), "One connection, every tab.");
		assert.doesNotMatch(
			markdown,
			/●|Tab three|Decorative child|Browser-only content|interactive demonstration/,
		);
		assert.match(markdown, /One connection serves three tabs\./);
		assert.match(markdown, /### Alternative\n\nHidden setup guidance\./);
		assert.match(markdown, /Visible guidance\./);
		assert.equal(
			nodes(tree, "code")[0]?.value,
			'<span aria-hidden="true">Icon</span>',
		);
		assert.match(markdown, /\[First\]\([^)]+\) \[Second\]/);
		assert.match(markdown, /\[WebSocket `\/websocket`\]/);
		assert.equal(dom.window.document.body.innerHTML, before);
	} finally {
		dom.window.close();
	}
});

test("all generated pages retain code, table boundaries, prose and labelled panels", async () => {
	const root = new URL("../dist/", import.meta.url);
	const files = (await readdir(root, { recursive: true })).filter(
		(path) => path.endsWith(".html") && path !== "404.html",
	);
	const outputs = new Map<string, Root>();
	let blocksChecked = 0;
	let tablesChecked = 0;
	let panelsChecked = 0;
	for (const file of files) {
		const dom = new JSDOM(await readFile(new URL(file, root), "utf8"));
		try {
			const document = dom.window.document;
			if (document.querySelector('meta[http-equiv="refresh"]')) continue;
			const pathname = `/${file.replace(/index\.html$/, "").replace(/\.html$/, "")}`;
			const mdPath = markdownPath(pathname);
			const markdown = await readFile(new URL(mdPath.slice(1), root), "utf8");
			const tree = parse(markdown);
			outputs.set(mdPath, tree);
			assert.equal(
				document
					.querySelector('link[rel="alternate"][type="text/markdown"]')
					?.getAttribute("href"),
				mdPath,
				pathname,
			);
			assert.equal(
				document.querySelector('link[rel="describedby"]')?.getAttribute("href"),
				"/llms.txt",
				pathname,
			);
			const main = document.querySelector("main");
			assert.ok(main, pathname);
			const blocks = nodes(tree, "code");
			const pres = Array.from(main.querySelectorAll("pre"));
			assert.equal(blocks.length, pres.length, pathname);
			const recipe = recipes.find(
				(entry) =>
					entry.id ===
					main
						.querySelector("[data-recipe-id]")
						?.getAttribute("data-recipe-id"),
			);
			const originals = recipe ? recipeFiles(recipe) : [];
			for (const [index, pre] of pres.entries()) {
				const widget = pre.closest(".expressive-code");
				const filename = widget
					?.querySelector("figcaption .title")
					?.textContent?.trim();
				const original = originals.find((entry) => entry.path === filename);
				const copied = widget
					?.querySelector("[data-code]")
					?.getAttribute("data-code");
				const reference =
					original?.code ??
					copied?.replaceAll("\x7f", "\n") ??
					(pre.hasAttribute("data-copy-text") ? pre.textContent : undefined);
				assert.ok(
					reference !== undefined,
					`${pathname}: code reference missing`,
				);
				const block = blocks[index];
				assert.ok(block, pathname);
				assert.equal(
					normal(block.value),
					normal(reference),
					`${pathname}: ${filename ?? index}`,
				);
				assert.equal(block.lang, pre.getAttribute("data-language"), pathname);
				if (filename) {
					const body = markdown.replace(/^---\n[\s\S]*?\n---\n/, "");
					const preceding = body.slice(
						blocks[index - 1]?.position?.end.offset ?? 0,
						offset(block, "start"),
					);
					assert.ok(
						preceding.includes(filename),
						`${pathname}: filename detached from code`,
					);
				}
				blocksChecked++;
			}
			const tables = nodes(tree, "table").map((table) =>
				table.children.map((row) =>
					row.children.map((cell) => squash(text(cell))),
				),
			);
			const expected = Array.from(main.querySelectorAll("table")).map((table) =>
				Array.from(table.rows).map((row) =>
					Array.from(row.cells).map((cell) => squash(cell.textContent ?? "")),
				),
			);
			assert.deepEqual(tables, expected, pathname);
			tablesChecked += tables.length;
			const headings = nodes(tree, "heading");
			for (const panel of main.querySelectorAll('[role="tabpanel"]')) {
				const label = document
					.getElementById(panel.getAttribute("aria-labelledby") ?? "")
					?.textContent?.trim();
				const heading = headings.find((entry) => text(entry) === label);
				assert.ok(heading, `${pathname}: unlabelled panel ${label}`);
				const next = headings.find(
					(entry) =>
						offset(entry, "start") > offset(heading, "start") &&
						entry.depth <= heading.depth,
				);
				for (const pre of panel.querySelectorAll("pre")) {
					const index = pres.indexOf(pre);
					const block = blocks[index];
					assert.ok(block, pathname);
					assert.ok(offset(block, "start") > offset(heading, "end"), pathname);
					assert.ok(
						!next || offset(block, "start") < offset(next, "start"),
						pathname,
					);
				}
				panelsChecked++;
			}
			const choices: string[][] = JSON.parse(
				main
					.querySelector("[data-recipe-picker]")
					?.getAttribute("data-recipes") ?? "[]",
			);
			const links = new Set(
				nodes(tree, "link").map(
					(link) => new URL(link.url, "https://spinetab.com").pathname,
				),
			);
			for (const [context, consumer, , path] of choices) {
				if (
					recipe?.url === pathname &&
					(recipe.context.id !== context || recipe.consumer !== consumer)
				)
					continue;
				assert.ok(
					path && links.has(markdownPath(path)),
					`${pathname}: missing recipe choice ${path}`,
				);
			}
			const prose = squash(nodes(tree, "paragraph").map(text).join(" "));
			for (const p of main.querySelectorAll("p")) {
				if (
					p.closest(
						".expressive-code,[data-recipe-picker],astro-island,nav,footer,[aria-hidden='true'],[data-markdown-exclude]",
					)
				)
					continue;
				assert.ok(
					prose.includes(squash(p.textContent ?? "")),
					`${pathname}: lost paragraph ${p.textContent}`,
				);
			}
		} finally {
			dom.window.close();
		}
	}
	for (const path of ["/llms.txt", "/recipe-index.md"])
		outputs.set(
			path,
			parse(await readFile(new URL(path.slice(1), root), "utf8")),
		);
	for (const [path, tree] of outputs) {
		for (const link of nodes(tree, "link")) {
			const url = new URL(link.url, "https://spinetab.com");
			if (url.origin === "https://spinetab.com" && url.pathname.endsWith(".md"))
				assert.ok(
					outputs.has(url.pathname),
					`${path}: missing ${url.pathname}`,
				);
		}
	}
	for (const recipe of recipes) {
		const tree = outputs.get(markdownPath(recipe.url));
		assert.ok(tree, recipe.id);
		for (const file of recipeFiles(recipe))
			assert.ok(
				nodes(tree, "code").some(
					(block) =>
						normal(block.value) === normal(file.code) &&
						block.lang === file.lang,
				),
				`${recipe.id}: ${file.path}`,
			);
	}
	const sourceRoot = new URL("../src/content/docs/", import.meta.url);
	for (const file of (await readdir(sourceRoot, { recursive: true })).filter(
		(path) => /\.mdx?$/.test(path),
	)) {
		const pathname = `/${file.replace(/\.mdx?$/, "").replace(/\/index$/, "")}/`;
		const tree = outputs.get(markdownPath(pathname));
		assert.ok(tree, pathname);
		let source = await readFile(new URL(file, sourceRoot), "utf8");
		if (source.includes("<SourceChoices"))
			source += await readFile(
				new URL("../src/components/docs/SourceChoices.mdx", import.meta.url),
				"utf8",
			);
		for (const [, lang, code] of source.matchAll(
			/^```(\S+)[^\n]*\n([\s\S]*?)^```\s*$/gm,
		)) {
			assert.ok(
				code &&
					nodes(tree, "code").some(
						(block) =>
							block.lang === lang && normal(block.value) === normal(code),
					),
				`${pathname}: authored ${lang} snippet changed`,
			);
		}
	}
	for (const recipe of retiredRecipes)
		assert.ok(!outputs.has(markdownPath(recipe.url)), recipe.id);
	assert.ok(!outputs.has("/404.md"));
	const titles = recipes.map((recipe) => {
		const tree = outputs.get(markdownPath(recipe.url));
		assert.ok(tree, recipe.id);
		const heading = nodes(tree, "heading")[0];
		assert.ok(heading, recipe.id);
		return text(heading);
	});
	assert.equal(new Set(titles).size, recipes.length);
	console.log(
		`Verified ${outputs.size - 2} pages, ${blocksChecked} code blocks, ${tablesChecked} tables and ${panelsChecked} tab panels.`,
	);
});
