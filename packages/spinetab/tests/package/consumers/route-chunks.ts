import { turbopackGraph } from "./inspect.ts";

/** The lazy chunks named by this route's emitted initial scripts, not other routes. */
export function nextRouteFallbacks(
	html: string,
	readChunk: (file: string) => string,
	fallback: readonly string[],
): string[] {
	const scripts = new Set<string>();
	for (const match of html.matchAll(/<script\b[^>]*?\ssrc=["']([^"']+)["']/g)) {
		const pathname = new URL(match[1] as string, "http://fixture.test")
			.pathname;
		const marker = pathname.indexOf("/_next/");
		if (marker !== -1 && pathname.endsWith(".js"))
			scripts.add(pathname.slice(marker + 7));
	}
	const graph = turbopackGraph(
		[...scripts].map((chunk) => ({
			chunk,
			text: readChunk(chunk),
			sources: [],
			appFiles: [],
		})),
	);
	return fallback.filter((file) => graph.lazy.has(file));
}
