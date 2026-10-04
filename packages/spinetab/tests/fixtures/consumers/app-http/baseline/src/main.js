import { createApp, h, onScopeDispose, ref } from "vue";
import { endpoints, readSettings } from "./config.js";

// Baseline without Spinetab: every tab opens its own EventSource and polls.
const settings = readSettings();
const urls = endpoints(settings.run, settings.recover);

const App = {
	setup() {
		const items = ref([]);
		const polled = ref(null);
		const source = new EventSource(urls.feed);
		source.addEventListener("tick", (event) => {
			items.value = [JSON.parse(event.data).n, ...items.value].slice(0, 10);
		});
		const timer = setInterval(async () => {
			const response = await fetch(urls.status);
			polled.value = (await response.json()).n;
		}, 2_000);
		onScopeDispose(() => {
			source.close();
			clearInterval(timer);
		});
		return () =>
			h("main", [
				h("h1", "Service health"),
				h(
					"p",
					{ "data-testid": "polled" },
					`status read ${polled.value ?? "-"}`,
				),
				h(
					"ul",
					{ "data-testid": "feed" },
					items.value.map((n) => h("li", { key: n }, `tick ${n}`)),
				),
			]);
	},
};

createApp(App).mount(document.getElementById("app"));
