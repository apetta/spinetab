import {
	QueryClient,
	QueryClientProvider,
	useQuery,
} from "@tanstack/react-query";
import { createElement as h, StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { createSpinetab, resolveEndpoint } from "spinetab";
import { useSpinetabStatus } from "spinetab/react";
import { sse } from "spinetab/sse";
import { stream } from "spinetab/stream";
import { bindQuery } from "spinetab/tanstack-query";
import { endpoints, readBase, readSettings } from "./config.js";

const settings = readSettings();
const urls = endpoints(settings.run);
const base = readBase();

const client = createSpinetab({
	worker: () =>
		new SharedWorker(new URL("./live.worker.js", import.meta.url), {
			type: "module",
			name: "spinetab",
		}),
	local: () => import("./live.local.js"),
	sharing: settings.sharing,
	baseUrl: base,
});

// Test probe: plain data only.
const probe = {
	run: settings.run,
	clients: 1,
	events: [],
	errors: [],
	endpoint: resolveEndpoint(urls.ticks, base),
	extra: { lines: [] },
	status() {
		const { mode, reason, health, runtimeId, generation, error } =
			client.status.get();
		return {
			mode,
			reason,
			health,
			runtimeId,
			generation,
			...(error
				? {
						error: {
							code: error.code,
							message: error.message,
							detail: error.detail,
						},
					}
				: {}),
		};
	},
};
window.__consumer = probe;

// SSE events arrive as their decoded JSON data, with the envelope's id in
// `meta.eventId`; the options-object builder stays the escape hatch.
const ticks = sse({
	url: urls.ticks,
	mode: "fetch",
	decoder: "json",
}).subscription({ event: "tick" });
// A URL-first feed is its own source: NDJSON by default.
const lines = stream(urls.lines, { repeatable: true });
const queryClient = new QueryClient();
const tickKey = ["ticks", settings.run];

function Ticks() {
	// The application owns the cache: Spinetab events update it through the
	// tools bound to this QueryClient.
	useEffect(() => {
		const binding = bindQuery(client, ticks, {
			queryClient,
			onEvent(tick, tools) {
				probe.events.push(tick);
				tools.setQueryData(tickKey, (previous = []) =>
					[...previous, tick.n].slice(-5),
				);
			},
			onError(error) {
				probe.errors.push({ code: error.code, message: error.message });
			},
		});
		return () => binding.unsubscribe();
	}, []);
	const { data } = useQuery({
		queryKey: tickKey,
		queryFn: () => [],
		enabled: false,
		initialData: [],
	});
	return h("p", { "data-testid": "ticks" }, `ticks: ${data.join(", ")}`);
}

function Lines() {
	const [state, setState] = useState("idle");
	useEffect(() => {
		// The one-line form: a source and a callback.
		const subscription = client.subscribe(lines, (line) => {
			probe.extra.lines.push(line);
		});
		const stop = subscription.status.subscribe((status) =>
			setState(status.connection.state),
		);
		return () => {
			stop();
			subscription.unsubscribe();
		};
	}, []);
	return h("p", { "data-testid": "lines" }, `lines: ${state}`);
}

function App() {
	const status = useSpinetabStatus(client);
	return h(
		QueryClientProvider,
		{ client: queryClient },
		h(
			"main",
			null,
			h("h1", null, "Spinetab recipe"),
			h("p", { "data-testid": "status" }, status.mode),
			h(Ticks),
			h(Lines),
		),
	);
}

const root =
	document.getElementById("app") ??
	document.body.appendChild(
		Object.assign(document.createElement("div"), { id: "app" }),
	);
createRoot(root).render(h(StrictMode, null, h(App)));
