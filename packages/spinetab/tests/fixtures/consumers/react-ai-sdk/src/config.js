/**
 * Page settings from the query string (see the recipe app). The chat route is
 * relative (`api/chat`) and served by the application's own origin.
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
	return { chat: "api/chat", chatId: `chat-${run}` };
}
