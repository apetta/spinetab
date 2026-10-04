/**
 * Page settings and endpoints (see the recipe app). `recover=1` makes the
 * fixture reset each SSE response after 55 events (11 s at 200 ms), so recovery
 * latency and continuity can be measured against the fixture's own cursors.
 * Each connection outlives the 10 s healthy window of the native backoff,
 * so every reset is a fresh first retry, not one step of a
 * growing series that would exhaust its 10 attempts.
 */
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
	return {
		run: params.get("run") ?? "default",
		sharing,
		recover: params.get("recover") === "1",
	};
}

export function endpoints(run, recover) {
	const id = encodeURIComponent(run);
	return {
		feed: `fx/sse/ticks?run=${id}&scope=http&rate=200${recover ? "&resetAfter=55" : ""}`,
		status: `fx/poll/value?id=${id}`,
	};
}
