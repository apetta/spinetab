import { createSpinetab, resolveEndpoint } from "spinetab";
import { pollEvery, polling } from "spinetab/polling";
import { endpoints, INTERVAL_MS, readSettings } from "./config.js";

const settings = readSettings();
const urls = endpoints(settings.run);

// The plugin infers the worker adapters from this file's spinetab/polling import.
const client = createSpinetab({
	sharing: settings.sharing,
});

const probe = {
	run: settings.run,
	clients: 1,
	events: [],
	errors: [],
	endpoint: resolveEndpoint(urls.value, document.baseURI),
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

const root =
	document.getElementById("app") ??
	document.body.appendChild(
		Object.assign(document.createElement("div"), { id: "app" }),
	);
const heading = document.createElement("h1");
heading.textContent = "Spinetab polling";
const statusText = document.createElement("p");
statusText.dataset.testid = "status";
const valueText = document.createElement("p");
valueText.dataset.testid = "value";
root.append(heading, statusText, valueText);

statusText.textContent = client.status.get().mode;
client.status.subscribe((status) => {
	statusText.textContent = status.mode;
});

const feed = polling({ url: urls.value, decoder: "json" });
client.subscribe(
	feed.subscription(),
	{
		next(value) {
			probe.events.push(value);
			valueText.textContent = `n = ${value.n}`;
		},
		error(error) {
			probe.errors.push({ code: error.code, message: error.message });
		},
	},
	pollEvery(INTERVAL_MS),
);
