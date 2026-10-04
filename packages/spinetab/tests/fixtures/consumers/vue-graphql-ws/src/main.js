import { createSpinetab, resolveEndpoint } from "spinetab";
import { graphqlWs } from "spinetab/graphql-ws";
import { useSpinetabStatus, useSubscription } from "spinetab/vue";
import { createApp, h, ref } from "vue";
import { endpoints, readSettings, TICKS } from "./config.js";

const settings = readSettings();
const urls = endpoints(settings.run);

const client = createSpinetab({
	sharing: settings.sharing,
});

const probe = {
	run: settings.run,
	clients: 1,
	events: [],
	errors: [],
	endpoint: resolveEndpoint(urls.graphql, document.baseURI),
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

const request = graphqlWs({ url: urls.graphql, anonymous: true }).subscription({
	query: TICKS,
	variables: { intervalMs: 200 },
});

// Vue composition used as the root component's setup.
function useLiveTicks() {
	const { status } = useSpinetabStatus(client);
	const latest = ref(null);
	const subscription = useSubscription(client, () => request, {
		next(result) {
			const n = result.data?.ticks?.n ?? null;
			probe.events.push(n);
			latest.value = n;
		},
		error(error) {
			probe.errors.push({ code: error.code, message: error.message });
		},
	});
	return () =>
		h("main", [
			h("h1", "Spinetab Vue GraphQL"),
			h("p", { "data-testid": "status" }, status.value.mode),
			h("p", { "data-testid": "latest" }, `tick ${latest.value ?? "-"}`),
			h(
				"p",
				{ "data-testid": "connection" },
				subscription.status.value.connection.state,
			),
		]);
}

const App = { setup: useLiveTicks };

const root =
	document.getElementById("app") ??
	document.body.appendChild(
		Object.assign(document.createElement("div"), { id: "app" }),
	);
createApp(App).mount(root);
