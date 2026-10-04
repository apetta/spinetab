/** Page settings and endpoints (see the recipe app). `tag` namespaces counters. */
export function readSettings(search = location.search) {
	const params = new URLSearchParams(search);
	const sharing =
		params.get("mode") === "local"
			? "off"
			: params.get("sharing") === "require"
				? "require"
				: params.get("sharing") === "off"
					? "off"
					: "prefer";
	return { run: params.get("run") ?? "default", sharing };
}

export function endpoints(run) {
	return {
		graphql: `fx/graphql-ws?tag=${encodeURIComponent(run)}&anonymous=1`,
	};
}
