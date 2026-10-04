import { createElement as h, StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { createSpinetab } from "spinetab";
import { graphqlWs } from "spinetab/graphql-ws";
import { useSpinetabStatus, useSubscription } from "spinetab/react";
import { endpoints, readSettings } from "./config.js";
import { FEED, SUMMARY } from "./documents.js";

const settings = readSettings();
const urls = endpoints(settings.run);

const client = createSpinetab({
	sharing: settings.sharing,
});
const endpoint = graphqlWs({ url: urls.graphql, anonymous: true });
const feed = endpoint.subscription({
	query: FEED,
	variables: { label: "feed" },
});
const summary = endpoint.subscription({ query: SUMMARY });

const probe = {
	run: settings.run,
	clients: 1,
	events: [],
	errors: [],
	endpoint: urls.graphql,
	extra: { continuity: [], summary: 0 },
	status() {
		const { mode, reason, health, runtimeId, generation, error } =
			client.status.get();
		return {
			mode,
			reason,
			health,
			runtimeId,
			generation,
			...(error ? { error: { code: error.code, message: error.message } } : {}),
		};
	},
};
window.__consumer = probe;

function Feed() {
	const [items, setItems] = useState([]);
	useSubscription(client, feed, {
		next(result) {
			const tick = result.data?.ticks;
			if (!tick) return;
			probe.events.push({ n: tick.n, at: Date.now() });
			setItems((previous) => [tick.n, ...previous].slice(0, 10));
		},
		status(status) {
			probe.extra.continuity.push({
				state: status.continuity.state,
				reason: status.continuity.reason ?? null,
				at: Date.now(),
			});
		},
		error(error) {
			probe.errors.push({ code: error.code, message: error.message });
		},
	});
	return h(
		"ul",
		{ "data-testid": "feed" },
		items.map((n) => h("li", { key: n }, `tick ${n}`)),
	);
}

function Summary() {
	const [latest, setLatest] = useState(0);
	useSubscription(client, summary, {
		next(result) {
			const n = result.data?.ticks?.n ?? 0;
			probe.extra.summary = n;
			setLatest(n);
		},
	});
	return h("p", { "data-testid": "summary" }, `summary ${latest}`);
}

function App() {
	const status = useSpinetabStatus(client);
	return h(
		"main",
		null,
		h("h1", null, "Live operations"),
		h("p", { "data-testid": "status" }, status.mode),
		h(Summary),
		h(Feed),
	);
}

createRoot(document.getElementById("app")).render(h(StrictMode, null, h(App)));
