// Tokenise imports within each file's code regions; ignore comments, literal contents and JSX text.

import { extname } from "node:path";

export interface CodeRegion {
	text: string;
	/**
	 * `module`: a module body, lexed whole. The others are markup: only their
	 * `{ … }` expression blocks are code, and only dynamic imports count there.
	 */
	kind: "module" | "svelte" | "astro" | "mdx";
	/** `<` in expression position starts JSX (JavaScript, JSX and TSX). */
	jsx: boolean;
}

/** `.d.ts`, `.d.mts`, `.d.cts` and `.d.<ext>.ts`: declarations emit no code. */
export const DECLARATION_FILE = /\.d\.(?:[^.\\/]+\.)?[cm]?ts$/;

const JSX_EXTENSIONS: ReadonlySet<string> = new Set([
	".js",
	".jsx",
	".mjs",
	".cjs",
	".tsx",
]);

const TAG = /<([A-Za-z][\w:.-]*)/y;
const RAW_ELEMENTS: ReadonlySet<string> = new Set(["script", "style"]);
const RAW_ATTRIBUTE = /(?:^|\s)is:raw(?![\w:-])/;
/** A script element inside an Astro expression, which Astro bundles too. */
const SCRIPT_ELEMENT =
	/<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script\s*>/gi;
const TYPE_ATTRIBUTE = /(?:^|\s)type\s*=\s*["']?([^"'\s>]+)/i;
const LANG_ATTRIBUTE = /(?:^|\s)lang\s*=\s*["']?([^"'\s>]+)/i;
const JS_TYPE = /^(?:module|(?:text|application)\/(?:java|ecma)script)$/i;
const ASTRO_INLINE = /(?:^|\s)(?:is:inline|define:vars)\b/;
const FRONTMATTER =
	/^\uFEFF?\s*---[^\S\r\n]*\r?\n(?:([\s\S]*?)\r?\n)??---[^\S\r\n]*(?:\r?\n|$)/;

interface Script {
	attributes: string;
	body: string;
}

type Flavour = "vue" | "svelte" | "astro" | "html" | "mdx";

/** Read markup scripts and expressions separately; preserve unclosed regions for the conservative fallback scan. Quoted attributes are text except Svelte expressions and template interpolations; Astro is:raw content and Vue interpolations are text. */
function splitMarkup(
	text: string,
	flavour: Flavour,
): { scripts: Script[]; code: string } {
	const scripts: Script[] = [];
	const blocks: string[] = [];
	const braces = flavour !== "vue" && flavour !== "html";
	// Attribute whitespace: HTML's ASCII set; Svelte and MDX's JSX read
	// JavaScript's.
	const space =
		flavour === "svelte" || flavour === "mdx" ? WHITESPACE : HTML_SPACE;
	let i = 0;
	let unread = false;
	/** The `{ … }` at `i`, or from it the rest when it cannot be closed. */
	const block = () => {
		const jsx = flavour !== "svelte";
		const lexed = lex(text, { start: i, block: true, jsx });
		unread = !lexed.complete;
		const end = unread ? text.length : lexed.end;
		const body = text.slice(i, end);
		const inner = flavour === "astro" ? body.matchAll(SCRIPT_ELEMENT) : [];
		for (const [, attributes = "", code = ""] of inner) {
			scripts.push({ attributes, body: code });
		}
		blocks.push(body);
		i = end;
	};
	/**
	 * The attribute value after the `=` at `i`. As in HTML, a value is quoted
	 * only when a quote is its first character (HTML has no backtick quote);
	 * otherwise it runs to whitespace or `>` and a quote in it is text
	 * (`title=Don't`, `href=/s?q='x`), while its `{ … }` stay expressions.
	 */
	const value = () => {
		for (i++; i < text.length && space.test(text[i] as string); ) i++;
		const quote = text[i];
		if (
			quote === '"' ||
			quote === "'" ||
			(quote === "`" && flavour !== "html")
		) {
			const code = flavour === "svelte" || quote === "`";
			for (i++; i < text.length && text[i] !== quote; ) {
				if (code && text[i] === "{" && (quote !== "`" || text[i - 1] === "$")) {
					block();
				} else i++;
			}
			i++;
			return;
		}
		while (
			i < text.length &&
			text[i] !== ">" &&
			!space.test(text[i] as string)
		) {
			if (text[i] === "{" && braces) block();
			else i++;
		}
	};
	while (i < text.length) {
		if (text[i] === "{" && braces && !(flavour === "mdx" && escaped(text, i))) {
			// Svelte's `{/if}` and `{/each}` close blocks; no expression.
			if (flavour === "svelte" && text[i + 1] === "/") {
				i = text.indexOf("}", i) + 1 || text.length;
			} else block();
			continue;
		}
		const c = text[i];
		const skip =
			c === "{" && flavour === "vue" && text[i + 1] === "{"
				? "}}"
				: c === "<" && flavour !== "mdx" && text.startsWith("<!--", i)
					? "-->"
					: undefined;
		const close = skip === undefined ? -1 : text.indexOf(skip, i + 2);
		TAG.lastIndex = i;
		const name = close === -1 && c === "<" ? TAG.exec(text)?.[1] : undefined;
		if (name === undefined) {
			i = close === -1 ? i + 1 : close + (skip?.length ?? 0);
			continue;
		}
		const start = i;
		i += 1 + name.length;
		// The attributes, to the tag's own `>`; a tag left open reads on raw.
		// As in HTML, `=` opens a value only after an attribute name.
		let named = false;
		while (i < text.length && text[i] !== ">") {
			const char = text[i] as string;
			if (char === "{" && braces) block();
			else if (char === "=" && named) value();
			else {
				if (!space.test(char)) named = char !== "/";
				i++;
				continue;
			}
			named = false;
		}
		if (i >= text.length) {
			if (!unread) blocks.push(text.slice(start));
			break;
		}
		const attributes = text.slice(start + 1 + name.length, i++);
		const element = name.toLowerCase();
		const raw =
			RAW_ELEMENTS.has(element) ||
			(flavour === "astro" && RAW_ATTRIBUTE.test(attributes));
		if (flavour === "mdx" || attributes.endsWith("/") || !raw) continue;
		const closing = new RegExp(`</${name.replaceAll(".", "\\.")}\\s*>`, "gi");
		closing.lastIndex = i;
		const found = closing.exec(text);
		if (element === "script") {
			scripts.push({ attributes, body: text.slice(i, found?.index) });
		}
		i = found ? found.index + found[0].length : text.length;
	}
	return { scripts, code: blocks.join("\n") };
}

const isJavaScript = ({ attributes }: Script) => {
	const type = TYPE_ATTRIBUTE.exec(attributes)?.[1];
	return type === undefined || JS_TYPE.test(type);
};

const module = (text: string, jsx: boolean): CodeRegion => ({
	text,
	kind: "module",
	jsx,
});

/** The code regions of one file, by its extension. */
export function codeRegions(code: string, path: string): CodeRegion[] {
	if (DECLARATION_FILE.test(path)) return [];
	const extension = extname(path);
	switch (extension) {
		case ".vue":
			// Template expressions cannot reach `import`; only scripts count.
			return splitMarkup(code, "vue").scripts.map((script) =>
				module(
					script.body,
					!/^[cm]?ts$/i.test(LANG_ATTRIBUTE.exec(script.attributes)?.[1] ?? ""),
				),
			);
		case ".svelte": {
			const { scripts, code: blocks } = splitMarkup(code, "svelte");
			return [
				...scripts.map((script) => module(script.body, false)),
				{ text: blocks, kind: "svelte", jsx: false },
			];
		}
		case ".astro": {
			const front = FRONTMATTER.exec(code);
			const { scripts, code: blocks } = splitMarkup(
				front ? code.slice(front[0].length) : code,
				"astro",
			);
			return [
				...(front ? [module(front[1] ?? "", false)] : []),
				// Astro bundles plain scripts; `is:inline` ones reach the page as is.
				...scripts
					.filter(
						(script) =>
							!ASTRO_INLINE.test(script.attributes) && isJavaScript(script),
					)
					.map((script) => module(script.body, false)),
				{ text: blocks, kind: "astro", jsx: true },
			];
		}
		case ".html":
			return splitMarkup(code, "html")
				.scripts.filter(isJavaScript)
				.map((script) => module(script.body, true));
		case ".mdx":
			return mdxRegions(code);
		default:
			return [module(code, JSX_EXTENSIONS.has(extension))];
	}
}

const FENCE_OPEN = /^[ \t>]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)?(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^[ \t>]*(`{3,}|~{3,})[ \t]*$/;
const ESM_LINE = /^(?:import|export)(?![\w$])/;
const BACKTICKS = /`+/g;
const PARAGRAPH_BREAK = /\n[^\S\n]*\n/;
/**
 * A line that ends the paragraph before it and holds none of the next: an
 * ATX heading, a thematic break or a setext underline (CommonMark; MDX
 * disables indented code, so any indent), also after a blockquote's `>`.
 */
const BLOCK_LINE =
	/^[ \t>]*(?:#{1,6}(?:[ \t]|$)|([-*_])(?:[ \t]*\1){2,}[ \t]*$|(?:=+|-+)[ \t]*$)/;
/**
 * An underline shape that is paragraph text instead when it continues a
 * list-item or blockquote paragraph lazily (an underline cannot be lazy).
 */
const LAZY_LINE = /^[ \t>]*(?:=+|--)[ \t]*$/;
const BLANK_LINE = /[^\S\n]*(?:\n|$)/y;

/**
 * One paragraph with its code spans blanked: a backtick run pairs with the
 * next run of equal length (CommonMark), found in linear time. A backslash
 * escapes a run's first backtick, so the rest opens one shorter; a closing
 * run ignores escapes, since a code span holds no escapes.
 */
function blankCodeSpans(text: string): string {
	const runs = [...text.matchAll(BACKTICKS)];
	// Each run's next run of the same length and of one less (-1: none),
	// read from the end.
	const closer: number[] = [];
	const shorter: number[] = [];
	const seen = new Map<number, number>();
	for (let k = runs.length - 1; k >= 0; k--) {
		const size = runs[k]?.[0].length ?? 0;
		closer[k] = seen.get(size) ?? -1;
		shorter[k] = seen.get(size - 1) ?? -1;
		seen.set(size, k);
	}
	let out = "";
	let from = 0;
	for (let k = 0; k < runs.length; k++) {
		const open = runs[k];
		if (open === undefined) continue;
		const lead = escaped(text, open.index) ? 1 : 0;
		const close = (lead === 1 ? shorter[k] : closer[k]) ?? -1;
		const end = runs[close];
		if (end === undefined) continue;
		out += `${text.slice(from, open.index + lead)} `;
		from = end.index + end[0].length;
		k = close;
	}
	return out + text.slice(from);
}

/**
 * MDX: column-0 ESM blocks outside fences, then the prose's expression
 * blocks. An ESM block ends at the first blank line where its code is
 * complete; a blank line inside unfinished code continues it (mdxjs-esm,
 * Sätteri), found in one reading.
 */
function mdxRegions(code: string): CodeRegion[] {
	const regions: CodeRegion[] = [];
	// The prose, and the prose with its lazy-capable lines kept as text:
	// whether `--` underlines or continues depends on its container, so an
	// MDX file with such a line is read both ways (conservative).
	const prose: string[] = [];
	const lazy: string[] = [];
	let both = false;
	let fence: { char: string; size: number } | undefined;
	// MDX skips a leading byte order mark before reading line 1.
	const text = code.charCodeAt(0) === 0xfeff ? code.slice(1) : code;
	const blankAfter = (at: number) => {
		BLANK_LINE.lastIndex = at + 1;
		return text[at] === "\n" && BLANK_LINE.test(text);
	};
	for (let at = 0; at < text.length; ) {
		const newline = text.indexOf("\n", at);
		const end = newline === -1 ? text.length : newline;
		const line = text.slice(at, end).replace(/\r$/, "");
		if (fence) {
			const close = FENCE_CLOSE.exec(line)?.[1];
			if (close?.[0] === fence.char && close.length >= fence.size) {
				fence = undefined;
			}
		} else if (ESM_LINE.test(line)) {
			const esm = lex(text, { start: at, jsx: true, stop: blankAfter });
			regions.push(module(text.slice(at, esm.end), true));
			at = esm.end + 1;
			continue;
		} else {
			const open = FENCE_OPEN.exec(line);
			const marker = open?.[1];
			// A backtick fence's info string cannot hold a backtick.
			if (marker && !(marker[0] === "`" && open?.[2]?.includes("`"))) {
				fence = { char: marker[0] ?? "`", size: marker.length };
				prose.push(""); // A fence ends the paragraph before it.
				lazy.push("");
			} else if (BLOCK_LINE.test(line)) {
				prose.push("", line, ""); // A paragraph of its own.
				if (LAZY_LINE.test(line)) {
					both = true;
					lazy.push(line);
				} else lazy.push("", line, "");
			} else {
				prose.push(line);
				lazy.push(line);
			}
		}
		at = end + 1;
	}
	const read = (lines: string[]): CodeRegion => {
		const paragraphs = lines.join("\n").split(PARAGRAPH_BREAK);
		const text = paragraphs.map(blankCodeSpans).join("\n\n");
		return { text: splitMarkup(text, "mdx").code, kind: "mdx", jsx: true };
	};
	regions.push(read(prose));
	if (both) regions.push(read(lazy));
	return regions;
}

// ── Lexer ────────────────────────────────────────────────────────────────

export type TokenKind =
	| "name"
	| "str"
	| "tpl"
	| "num"
	| "punct"
	| "regex"
	| "jsx";

export interface Token {
	t: TokenKind;
	v: string;
	/** A line break precedes this token. */
	nl: boolean;
}

export interface Lexed {
	tokens: Token[];
	/**
	 * False when a comment, template, bracket, expression block or JSX
	 * element runs past the end of the text, or a `}` closes nothing.
	 */
	complete: boolean;
	/** The index after the last character read. */
	end: number;
}

export interface LexOptions {
	/** Read `<` in expression position as JSX. */
	jsx?: boolean;
	start?: number;
	/** `start` is a `{`: stop after its matching `}` (a markup expression). */
	block?: boolean;
	/**
	 * Called at each line end outside any bracket, string, template, comment
	 * or JSX while the text so far is complete; true stops the reading there.
	 */
	stop?: (at: number) => boolean;
}

const WHITESPACE = /\s/;
/** HTML's ASCII whitespace (WHATWG), which Astro and Vue attributes read too. */
const HTML_SPACE = /[\t\n\f\r ]/;
const ID_START = /[A-Za-z_$\u0080-\uffff]/;
const IDENTIFIER = /#?[A-Za-z_$\u0080-\uffff][\w$\u0080-\uffff]*/y;
const NUMBER = /\.?\d[\w.]*/y;
const FLAGS = /[\w$\u0080-\uffff]*/y;
const JSX_NAME = /[A-Za-z_$\u0080-\uffff][\w$.:\-\u0080-\uffff]*/y;
const JSX_NAME_PART = /[\w$.:\-\u0080-\uffff]/;
const JSX_CHILD_STOP = /[<{]/g;
const TYPE_PARAMETERS = /^(?:,|extends\s)/;

const REGEX_AFTER_NAME: ReadonlySet<string> = new Set([
	"return",
	"typeof",
	"instanceof",
	"in",
	"new",
	"delete",
	"void",
	"throw",
	"case",
	"do",
	"else",
	"default",
	"yield",
	"await",
]);

/** A token that can end a for-of binding: a name (not one above), `]` or `}`. */
const binding = (token: Token | undefined): boolean =>
	isPunct(token, "]") ||
	isPunct(token, "}") ||
	(token?.t === "name" && !REGEX_AFTER_NAME.has(token.v));

/** A `)` closing the head of these precedes a statement, so a `/` is a regex. */
const HEAD_KEYWORDS: ReadonlySet<string> = new Set([
	"if",
	"while",
	"for",
	"with",
]);

/** Tokens after which a `<` starts JSX, besides `=>`. */
const JSX_AFTER_PUNCT: ReadonlySet<string> = new Set([
	"(",
	",",
	"=",
	":",
	"?",
	"[",
	"{",
	"}",
	";",
	"!",
	"&",
	"|",
]);

type Outcome = "done" | "abort" | "end";

/**
 * Significant tokens of `text`: comments dropped; strings, templates and
 * regular expressions as single tokens (a template without substitutions is a
 * `str`); `${…}` substitutions and JSX `{…}` containers lexed as code between
 * `{` and `}` tokens; JSX text and tags skipped, each element leaving one
 * `jsx` token. A quote or `/` with no close on its line is a lone punctuator,
 * so a mis-read never runs past one line.
 */
export function lex(text: string, options: LexOptions = {}): Lexed {
	const jsx = options.jsx === true;
	const length = text.length;
	const tokens: Token[] = [];
	let i = options.start ?? 0;
	let nl = false;
	let complete = true;
	/** `<` positions that proved not to start a JSX element. */
	const notJsx = new Set<number>();
	/** Tag name → the first closing tag at or after `from` (-1: none). */
	const closings = new Map<string, { from: number; at: number }>();
	/** Open `(`: whether each opens an if, while, for or with head. */
	let parens: boolean[] = [];
	/** `)` tokens that close such a head. */
	const heads = new Set<Token>();

	const emit = (t: TokenKind, v: string) => {
		tokens.push({ t, v, nl });
		nl = false;
	};
	const sticky = (pattern: RegExp): string => {
		pattern.lastIndex = i;
		return pattern.exec(text)?.[0] ?? "";
	};
	const lineEnd = (from: number) => {
		const end = text.indexOf("\n", from);
		return end === -1 ? length : end;
	};
	const skipSpace = (from: number) => {
		let j = from;
		while (j < length && WHITESPACE.test(text[j] as string)) j++;
		return j;
	};

	/** The closing quote on this line, or -1. */
	const closeString = (from: number, quote: string): number => {
		for (let j = from; j < length; j++) {
			const c = text[j];
			if (c === quote) return j;
			if (c === "\\") {
				j += text[j + 1] === "\r" && text[j + 2] === "\n" ? 2 : 1;
			} else if (c === "\n" || c === "\r") return -1;
		}
		return -1;
	};

	/** The closing `/` of a regular expression on this line, or -1. */
	const closeRegex = (from: number): number => {
		let inClass = false;
		for (let j = from; j < length; j++) {
			const c = text[j];
			if (c === "\n" || c === "\r") return -1;
			if (c === "\\") {
				// An escape never carries a literal onto the next line.
				const escapedChar = text[j + 1];
				if (escapedChar === "\n" || escapedChar === "\r") return -1;
				j++;
			} else if (c === "[") inClass = true;
			else if (c === "]") inClass = false;
			else if (c === "/" && !inClass) return j;
		}
		return -1;
	};

	/** A name that is a keyword, not a property (`x.return`). */
	const keyword = (names: ReadonlySet<string>): boolean => {
		const prev = tokens.at(-1);
		return (
			prev?.t === "name" && names.has(prev.v) && !isPunct(tokens.at(-2), ".")
		);
	};

	/** The index after the `>` closing TSX type arguments at `from`, or -1. */
	const typeArguments = (from: number): number => {
		let depth = 0;
		for (let j = from; j < length; j++) {
			const c = text[j];
			if (c === "<") depth++;
			else if (c === ">" && text[j - 1] !== "=" && --depth === 0) {
				return j + 1;
			} else if (c === '"' || c === "'") {
				j = closeString(j + 1, c);
				if (j === -1) return -1;
			}
		}
		return -1;
	};

	/** Whether a `/` after the token at `at` starts a regular expression. */
	const regexAfter = (at: number): boolean => {
		const prev = tokens[at];
		if (prev === undefined) return true;
		if (prev.t === "punct") {
			// `x++ / 2` divides; `if (a) /re/` is a regular expression.
			if (prev.v === ")") return heads.has(prev);
			// TypeScript's non-null `size! / 2` divides: a `!` right after an
			// operand on its line is never a prefix `!` in valid code.
			if (prev.v === "!") return prev.nl || regexAfter(at - 1);
			return prev.v !== "]" && prev.v !== "++" && prev.v !== "--";
		}
		if (prev.t !== "name" || isPunct(tokens[at - 1], ".")) return false;
		// `of` is the for-of keyword only after a binding inside parentheses
		// (`for (x of /re/g…)`); elsewhere it is an identifier: `of / 2`.
		if (prev.v === "of") return parens.length > 0 && binding(tokens[at - 1]);
		return REGEX_AFTER_NAME.has(prev.v);
	};

	const jsxAllowed = (): boolean => {
		const prev = tokens.at(-1);
		if (prev === undefined) return true;
		if (prev.t === "name") return prev.v === "return" || prev.v === "default";
		if (prev.t !== "punct") return false;
		if (prev.v === ">") {
			const before = tokens.at(-2);
			return before?.t === "punct" && before.v === "=";
		}
		return JSX_AFTER_PUNCT.has(prev.v);
	};

	/** Whether `</name` (or `</>` for a fragment) occurs at or after `from`. */
	const closes = (name: string, from: number): boolean => {
		const cached = closings.get(name);
		if (
			cached !== undefined &&
			cached.from <= from &&
			(cached.at === -1 || cached.at >= from)
		) {
			return cached.at !== -1;
		}
		const needle = name === "" ? "</>" : `</${name}`;
		let at = text.indexOf(needle, from);
		while (
			at !== -1 &&
			name !== "" &&
			JSX_NAME_PART.test(text[at + needle.length] ?? "")
		) {
			at = text.indexOf(needle, at + 1);
		}
		closings.set(name, { from, at });
		return at !== -1;
	};

	/** A `{…}` lexed as code, between `{` and `}` tokens. */
	const container = (): boolean => {
		emit("punct", "{");
		i++;
		return code(true);
	};

	/** A template literal from its backtick. False when the text ends first. */
	function template(): boolean {
		i++;
		let from = i;
		let whole = true;
		while (i < length) {
			const c = text[i];
			if (c === "\\") {
				i += 2;
			} else if (c === "`") {
				emit(whole ? "str" : "tpl", text.slice(from, i));
				i++;
				return true;
			} else if (c === "$" && text[i + 1] === "{") {
				emit("tpl", text.slice(from, i));
				i++;
				if (!container()) return false;
				whole = false;
				from = i;
			} else {
				i++;
			}
		}
		complete = false;
		return false;
	}

	/** A JSX element from its `<`; `abort` when the `<` starts none. */
	function element(): Outcome {
		const at = i;
		const outcome = elementBody();
		if (outcome === "abort") notJsx.add(at);
		return outcome;
	}

	function elementBody(): Outcome {
		i++;
		let name = "";
		if (text[i] === ">") {
			i++;
		} else {
			name = sticky(JSX_NAME);
			if (name === "") return "abort";
			i += name.length;
			// TSX type parameters: `<T,>` and `<T extends …>`.
			const after = skipSpace(i);
			if (TYPE_PARAMETERS.test(text.slice(after, after + 8))) return "abort";
			// TSX type arguments of a generic component: `<Table<Row> …>`.
			if (text[after] === "<") {
				i = typeArguments(after);
				if (i === -1) return "abort";
			}
			const tag = attributes();
			if (tag !== "open") return tag;
		}
		// A type such as `<T>(x: T) => T` has no closing tag to match.
		if (!closes(name, i)) return "abort";
		return children();
	}

	function attributes(): "open" | Outcome {
		for (;;) {
			i = skipSpace(i);
			if (i >= length) return "end";
			const c = text[i];
			if (c === ">") {
				i++;
				return "open";
			}
			if (c === "/" && text[i + 1] === ">") {
				i += 2;
				return "done";
			}
			if (c === "/" && text[i + 1] === "*") {
				const end = text.indexOf("*/", i + 2);
				if (end === -1) return "end";
				i = end + 2;
				continue;
			}
			if (c === "{") {
				if (!container()) return "end";
				continue;
			}
			const attribute = sticky(JSX_NAME);
			if (attribute === "") return "abort";
			i = skipSpace(i + attribute.length);
			if (text[i] !== "=") continue;
			i = skipSpace(i + 1);
			const value = text[i];
			if (value === '"' || value === "'") {
				// JSX attribute strings have no escapes and may span lines.
				const end = text.indexOf(value, i + 1);
				if (end === -1) return "abort";
				i = end + 1;
			} else if (value === "{") {
				if (!container()) return "end";
			} else if (value === "<") {
				const nested = element();
				if (nested !== "done") return nested;
			} else {
				return "abort";
			}
		}
	}

	function children(): Outcome {
		for (;;) {
			JSX_CHILD_STOP.lastIndex = i;
			const stop = JSX_CHILD_STOP.exec(text);
			if (stop === null) {
				i = length;
				return "end";
			}
			i = stop.index;
			if (text[i] === "{") {
				if (!container()) return "end";
			} else if (text[i + 1] === "/") {
				// This element's closing tag; names are not compared.
				const end = text.indexOf(">", i + 2);
				if (end === -1) {
					i = length;
					return "end";
				}
				i = end + 1;
				return "done";
			} else {
				const nested = element();
				if (nested !== "done") return nested;
			}
		}
	}

	/**
	 * Code to the end of the text, or with `inBlock` to the `}` that closes
	 * the current block (emitted). False when the text ends first.
	 */
	function code(inBlock: boolean): boolean {
		let depth = 0;
		while (i < length) {
			const c = text[i] as string;
			if (c === "\n" || c === "\u2028" || c === "\u2029") {
				if (!inBlock && depth === 0 && complete && options.stop?.(i)) {
					return true;
				}
				nl = true;
				i++;
				continue;
			}
			if (WHITESPACE.test(c)) {
				i++;
				continue;
			}
			if (c === "/") {
				const next = text[i + 1];
				if (next === "/") {
					i = lineEnd(i);
					continue;
				}
				if (next === "*") {
					const end = text.indexOf("*/", i + 2);
					if (end === -1) {
						i = length;
						complete = false;
						return false;
					}
					for (let j = i + 2; j < end; j++) {
						if (text[j] === "\n") {
							nl = true;
							break;
						}
					}
					i = end + 2;
					continue;
				}
				if (regexAfter(tokens.length - 1)) {
					const end = closeRegex(i + 1);
					if (end !== -1) {
						const start = i;
						i = end + 1;
						i += sticky(FLAGS).length;
						emit("regex", text.slice(start, i));
						continue;
					}
				}
				emit("punct", c);
				i++;
				continue;
			}
			if (c === '"' || c === "'") {
				const end = closeString(i + 1, c);
				if (end === -1) {
					emit("punct", c);
					i++;
				} else {
					emit("str", text.slice(i + 1, end));
					i = end + 1;
				}
				continue;
			}
			if (c === "`") {
				if (!template()) return false;
				continue;
			}
			if (c === "(" || c === "[" || c === "{") {
				if (c === "(") parens.push(keyword(HEAD_KEYWORDS));
				depth++;
				emit("punct", c);
				i++;
				continue;
			}
			if (c === ")" || c === "]" || c === "}") {
				emit("punct", c);
				if (c === ")" && parens.pop() === true) {
					heads.add(tokens.at(-1) as Token);
				}
				i++;
				if (depth > 0) depth--;
				else if (c === "}") {
					if (inBlock) return true;
					complete = false;
				}
				continue;
			}
			if (
				c === "<" &&
				jsx &&
				!notJsx.has(i) &&
				(text[i + 1] === ">" || ID_START.test(text[i + 1] ?? "")) &&
				jsxAllowed()
			) {
				const mark = {
					at: i,
					count: tokens.length,
					nl,
					complete,
					parens: [...parens],
				};
				const outcome = element();
				if (outcome === "done") {
					tokens.push({ t: "jsx", v: "", nl: mark.nl });
					nl = false;
					continue;
				}
				if (outcome === "end") {
					i = length;
					complete = false;
					return false;
				}
				// Not JSX: read the `<` as an operator.
				i = mark.at;
				tokens.length = mark.count;
				nl = mark.nl;
				complete = mark.complete;
				parens = mark.parens;
			}
			if (ID_START.test(c) || (c === "#" && ID_START.test(text[i + 1] ?? ""))) {
				const name = sticky(IDENTIFIER);
				emit("name", name);
				i += name.length;
				continue;
			}
			if (
				(c >= "0" && c <= "9") ||
				(c === "." && /\d/.test(text[i + 1] ?? ""))
			) {
				const number = sticky(NUMBER);
				emit("num", number);
				i += number.length;
				continue;
			}
			if ((c === "+" || c === "-") && text[i + 1] === c) {
				// `++` and `--` as one token: a `/` after either divides.
				emit("punct", c + c);
				i += 2;
				continue;
			}
			emit("punct", c);
			i++;
		}
		if (inBlock || depth > 0) complete = false;
		return !inBlock;
	}

	try {
		if (options.block) {
			if (!container()) complete = false;
		} else {
			if (text.charCodeAt(i) === 0xfeff) i++;
			if (text.startsWith("#!", i)) i = lineEnd(i);
			code(false);
		}
	} catch (error) {
		// Nesting deeper than the call stack: read the region as unclosable.
		if (!(error instanceof RangeError)) throw error;
		complete = false;
	}
	return { tokens, complete, end: i };
}

// ── Import forms ─────────────────────────────────────────────────────────

export interface ImportRecord {
	specifier: string;
	/** `import type`, `export type` and all-`type` lists. */
	typeOnly: boolean;
	/** Imported names of a named list (value names); undefined when none. */
	names: string[] | undefined;
}

/** After these, a line break continues the expression (no statement start). */
const OPERATOR_END: ReadonlySet<string> = new Set([
	"=",
	"(",
	"[",
	",",
	":",
	"?",
	"+",
	"-",
	"*",
	"/",
	"%",
	"&",
	"|",
	"^",
	"!",
	"~",
	"<",
	">",
	".",
]);

const isPunct = (token: Token | undefined, value: string) =>
	token?.t === "punct" && token.v === value;
const isName = (token: Token | undefined, value?: string) =>
	token?.t === "name" && (value === undefined || token.v === value);
const isStr = (token: Token | undefined) => token?.t === "str";

/** A static declaration can only start a statement. */
function statementStart(tokens: readonly Token[], i: number): boolean {
	const prev = tokens[i - 1];
	if (!prev || isPunct(prev, ";") || isPunct(prev, "}")) return true;
	// TypeScript's `export import x = require("…")`.
	if (isName(prev, "export") && isName(tokens[i], "import")) return true;
	return (
		(tokens[i]?.nl ?? false) &&
		!(prev.t === "punct" && OPERATOR_END.has(prev.v))
	);
}

interface ListEntry {
	name: string;
	type: boolean;
}

/** `{ a, type B, c as d, "e" as f }` from the `{` at `start`; `end` is the `}`. */
function namedList(
	tokens: readonly Token[],
	start: number,
): { entries: ListEntry[]; end: number } | undefined {
	const entries: ListEntry[] = [];
	let part: Token[] = [];
	const close = () => {
		if (part.length === 0) return;
		// `type` alone or `type as x` is a binding named `type`.
		const typed =
			isName(part[0], "type") &&
			part.length !== 1 &&
			!(part.length === 3 && isName(part[1], "as"));
		entries.push({ name: (typed ? part[1] : part[0])?.v ?? "", type: typed });
		part = [];
	};
	let k = start + 1;
	for (; k < tokens.length && !isPunct(tokens[k], "}"); k++) {
		const token = tokens[k] as Token;
		if (isPunct(token, ",")) close();
		else if (token.t === "name" || token.t === "str") part.push(token);
		else return undefined;
	}
	close();
	return k < tokens.length ? { entries, end: k } : undefined;
}

type Parsed = { record?: ImportRecord; end: number } | undefined;

function staticImport(tokens: readonly Token[], start: number): Parsed {
	let j = start;
	if (isStr(tokens[j])) {
		return {
			record: {
				specifier: tokens[j]?.v ?? "",
				typeOnly: false,
				names: undefined,
			},
			end: j,
		};
	}
	let typeOnly = false;
	if (
		isName(tokens[j], "type") &&
		!isPunct(tokens[j + 1], ",") &&
		!(isName(tokens[j + 1], "from") && isStr(tokens[j + 2]))
	) {
		typeOnly = true;
		j++;
	}
	if (isName(tokens[j]) && isPunct(tokens[j + 1], "=")) {
		// TypeScript import-equals: `import [type] x = require("…")`.
		if (
			isName(tokens[j + 2], "require") &&
			isPunct(tokens[j + 3], "(") &&
			isStr(tokens[j + 4])
		) {
			return {
				record: {
					specifier: tokens[j + 4]?.v ?? "",
					typeOnly,
					names: undefined,
				},
				end: j + 4,
			};
		}
		return undefined;
	}
	let hasDefault = false;
	let namespace = false;
	let list: ListEntry[] | undefined;
	let k = j;
	if (
		isName(tokens[k]) &&
		!(isName(tokens[k], "from") && isStr(tokens[k + 1]))
	) {
		hasDefault = true;
		k++;
		if (isPunct(tokens[k], ",")) k++;
	}
	if (
		isPunct(tokens[k], "*") &&
		isName(tokens[k + 1], "as") &&
		isName(tokens[k + 2])
	) {
		namespace = true;
		k += 3;
	} else if (isPunct(tokens[k], "{")) {
		const parsed = namedList(tokens, k);
		if (!parsed) return undefined;
		list = parsed.entries;
		k = parsed.end + 1;
	}
	if (!isName(tokens[k], "from") || !isStr(tokens[k + 1])) return undefined;
	const allType =
		list !== undefined &&
		list.length > 0 &&
		list.every((entry) => entry.type) &&
		!hasDefault &&
		!namespace;
	return {
		record: {
			specifier: tokens[k + 1]?.v ?? "",
			typeOnly: typeOnly || allType,
			names:
				namespace || !list
					? undefined
					: list.filter((entry) => !entry.type).map((entry) => entry.name),
		},
		end: k + 1,
	};
}

function staticExport(tokens: readonly Token[], start: number): Parsed {
	let k = start;
	let typeOnly = false;
	if (
		isName(tokens[k], "type") &&
		(isPunct(tokens[k + 1], "{") || isPunct(tokens[k + 1], "*"))
	) {
		typeOnly = true;
		k++;
	}
	let list: ListEntry[] | undefined;
	if (isPunct(tokens[k], "*")) {
		k++;
		if (isName(tokens[k], "as")) k += 2;
	} else if (isPunct(tokens[k], "{")) {
		const parsed = namedList(tokens, k);
		if (!parsed) return undefined;
		list = parsed.entries;
		k = parsed.end + 1;
	} else {
		return undefined;
	}
	if (!isName(tokens[k], "from") || !isStr(tokens[k + 1])) return undefined;
	const allType =
		list !== undefined && list.length > 0 && list.every((entry) => entry.type);
	return {
		record: {
			specifier: tokens[k + 1]?.v ?? "",
			typeOnly: typeOnly || allType,
			names: list?.filter((entry) => !entry.type).map((entry) => entry.name),
		},
		end: k + 1,
	};
}

/**
 * Import, export-from, `import()` and `require()` records over tokens. With
 * `statements` false (a markup expression), only the dynamic forms count.
 */
export function importsOf(
	tokens: readonly Token[],
	statements = true,
): ImportRecord[] {
	const found: ImportRecord[] = [];
	let depth = 0;
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i] as Token;
		if (token.t === "punct") {
			if (token.v === "(" || token.v === "[" || token.v === "{") depth++;
			else if (token.v === ")" || token.v === "]" || token.v === "}") {
				depth = Math.max(0, depth - 1);
			}
			continue;
		}
		// `x.import(…)`, `x?.require(…)` and `import.meta` are not imports.
		if (token.t !== "name" || isPunct(tokens[i - 1], ".")) continue;
		if (
			(token.v === "import" || token.v === "require") &&
			isPunct(tokens[i + 1], "(")
		) {
			const specifier = tokens[i + 2];
			if (specifier?.t === "str") {
				found.push({
					specifier: specifier.v,
					typeOnly: false,
					names: undefined,
				});
			}
			continue;
		}
		if (!statements || depth !== 0 || !statementStart(tokens, i)) continue;
		const parsed =
			token.v === "import"
				? staticImport(tokens, i + 1)
				: token.v === "export"
					? staticExport(tokens, i + 1)
					: undefined;
		if (parsed?.record) found.push(parsed.record);
		if (parsed) i = parsed.end;
	}
	return found;
}

// ── Files ────────────────────────────────────────────────────────────────

export interface FileImports {
	imports: ImportRecord[];
	/** Unclosed regions are scanned conservatively for literal entry mentions. */
	unread: string[];
}

const escaped = (text: string, at: number): boolean => {
	let slashes = 0;
	for (let j = at - 1; j >= 0 && text[j] === "\\"; j--) slashes++;
	return slashes % 2 === 1;
};

/**
 * Dynamic imports in a markup region's `{ … }` blocks, which
 * splitMarkup has already chosen: escaped braces and Svelte closing tags
 * never reach here.
 */
function markupImports(
	region: CodeRegion,
	found: ImportRecord[],
): string | undefined {
	const { text } = region;
	let at = text.indexOf("{");
	while (at !== -1) {
		const block = lex(text, { start: at, block: true, jsx: region.jsx });
		if (!block.complete) return text.slice(at);
		for (const record of importsOf(block.tokens, false)) found.push(record);
		at = text.indexOf("{", block.end);
	}
	return undefined;
}

export function readImports(code: string, path: string): FileImports {
	const imports: ImportRecord[] = [];
	const unread: string[] = [];
	for (const region of codeRegions(code, path)) {
		if (!region.text.includes("spinetab/")) continue;
		if (region.kind === "module") {
			const lexed = lex(region.text, { jsx: region.jsx });
			if (!lexed.complete) {
				unread.push(region.text);
				continue;
			}
			for (const record of importsOf(lexed.tokens)) imports.push(record);
		} else {
			const rest = markupImports(region, imports);
			if (rest !== undefined) unread.push(rest);
		}
	}
	return { imports, unread };
}
