/**
 * Page settings from the query string: `run` namespaces the fixture counters,
 * `mode=local` selects `sharing: "off"` and `sharing=require` selects
 * require-sharing. Endpoints are relative: they resolve against the document
 * base and reach the fixture through the front server's `fx/`
 * proxy, so `connect-src 'self'` suffices.
 */
export function readSettings(search = location.search) {
	const params = new URLSearchParams(search);
	const sharing =
		params.get("mode") === "local"
			? "off"
			: params.get("sharing") === "require"
				? "require"
				: "prefer";
	return { run: params.get("run") ?? "default", sharing };
}

export function endpoints(run) {
	const id = encodeURIComponent(run);
	return {
		ticks: `fx/sse/ticks?run=${id}&scope=recipe&rate=250`,
		lines: `fx/stream/ndjson?run=${id}&count=5&rate=1000`,
	};
}

/**
 * The application base for relative endpoints. Vite replaces
 * `%BASE_URL%` in index.html, so nested routes under a base path still
 * resolve `fx/…` against the base; other bundlers use `document.baseURI`.
 */
export function readBase() {
	const declared = document
		.querySelector('meta[name="spinetab-base"]')
		?.getAttribute("content");
	return declared && !declared.includes("%")
		? new URL(declared, location.origin).href
		: document.baseURI;
}
