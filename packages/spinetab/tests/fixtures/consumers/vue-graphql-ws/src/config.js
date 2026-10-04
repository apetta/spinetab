/**
 * Page settings from the query string (see the recipe app). The GraphQL
 * endpoint is relative; the client resolves it against the document base and
 * the runtime maps `http:` to `ws:`. `tag` namespaces the fixture counters.
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
	return {
		graphql: `fx/graphql-ws?tag=${encodeURIComponent(run)}&anonymous=1`,
	};
}

export const TICKS =
	"subscription Ticks($intervalMs: Int) { ticks(intervalMs: $intervalMs) { n tag } }";
