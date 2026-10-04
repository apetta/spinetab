/**
 * Page settings from the query string (see the recipe app). The polling
 * fixture counts requests per `id`, so the run id doubles as the identity
 * marker; the endpoint is relative and proxied.
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
	return { value: `fx/poll/value?id=${encodeURIComponent(run)}` };
}

export const INTERVAL_MS = 1_000;
