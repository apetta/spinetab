import { createSpinetab } from "spinetab";
import { pollEvery, polling } from "spinetab/polling";
import { sse } from "spinetab/sse";
import { useSpinetabStatus, useSubscription } from "spinetab/vue";
import { createApp, h, ref } from "vue";
import { endpoints, readSettings } from "./config.js";

const settings = readSettings();
const urls = endpoints(settings.run, settings.recover);

const client = createSpinetab({
	sharing: settings.sharing,
});
const feed = sse({
	url: urls.feed,
	mode: "fetch",
	decoder: "json",
	replay: "last-event-id",
}).subscription({ event: "tick" });
const status = polling({ url: urls.status, decoder: "json" }).subscription();

const probe = {
	run: settings.run,
	clients: 1,
	events: [],
	errors: [],
	endpoint: urls.feed,
	extra: { continuity: [], polled: 0 },
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

// Vue composition used as the root component's setup.
function useServiceHealth() {
	const mode = useSpinetabStatus(client).status;
	const items = ref([]);
	const polled = ref(null);
	useSubscription(client, () => feed, {
		next(tick, meta) {
			probe.events.push({ n: tick.n, id: meta.eventId, at: Date.now() });
			items.value = [tick.n, ...items.value].slice(0, 10);
		},
		status(value) {
			probe.extra.continuity.push({
				state: value.continuity.state,
				reason: value.continuity.reason ?? null,
				at: Date.now(),
			});
		},
		error(error) {
			probe.errors.push({ code: error.code, message: error.message });
		},
	});
	useSubscription(
		client,
		() => status,
		{
			next(value) {
				probe.extra.polled += 1;
				polled.value = value.n;
			},
		},
		pollEvery(2_000),
	);
	return () =>
		h("main", [
			h("h1", "Service health"),
			h("p", { "data-testid": "status" }, mode.value.mode),
			h("p", { "data-testid": "polled" }, `status read ${polled.value ?? "-"}`),
			h(
				"ul",
				{ "data-testid": "feed" },
				items.value.map((n) => h("li", { key: n }, `tick ${n}`)),
			),
		]);
}

const App = { setup: useServiceHealth };

createApp(App).mount(document.getElementById("app"));
