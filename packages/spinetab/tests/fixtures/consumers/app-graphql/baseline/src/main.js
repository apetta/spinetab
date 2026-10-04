import { createClient } from "graphql-ws";
import {
	createElement as h,
	StrictMode,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { createRoot } from "react-dom/client";
import { endpoints, readSettings } from "./config.js";
import { FEED, SUMMARY } from "./documents.js";

// Baseline without Spinetab: every tab owns its own graphql-ws client.
const settings = readSettings();
const urls = endpoints(settings.run);
const url = new URL(urls.graphql, document.baseURI);
url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
const client = createClient({ url: url.href, lazy: true });

function useLive(query, variables, onData) {
	const latest = useRef(onData);
	useLayoutEffect(() => {
		latest.current = onData;
	});
	useEffect(
		() =>
			client.subscribe(
				{ query, variables },
				{
					next: (result) => latest.current(result),
					error: () => undefined,
					complete: () => undefined,
				},
			),
		[query, variables],
	);
}

const feedVariables = { label: "feed" };

function Feed() {
	const [items, setItems] = useState([]);
	useLive(FEED, feedVariables, (result) => {
		const tick = result.data?.ticks;
		if (tick) setItems((previous) => [tick.n, ...previous].slice(0, 10));
	});
	return h(
		"ul",
		{ "data-testid": "feed" },
		items.map((n) => h("li", { key: n }, `tick ${n}`)),
	);
}

function Summary() {
	const [latest, setLatest] = useState(0);
	useLive(SUMMARY, undefined, (result) =>
		setLatest(result.data?.ticks?.n ?? 0),
	);
	return h("p", { "data-testid": "summary" }, `summary ${latest}`);
}

function App() {
	return h("main", null, h("h1", null, "Live operations"), h(Summary), h(Feed));
}

createRoot(document.getElementById("app")).render(h(StrictMode, null, h(App)));
