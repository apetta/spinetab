// CommonJS page entry (consumer cell b): the page reaches Spinetab
// through `require`, so the root's own require of the wiring seam must
// resolve to the plugin's wiring under CommonJS conditions. Built only by the
// webpack and Rspack `cjs` variants (CONSUMER_ENTRY=cjs); the same probe and
// endpoints as main.js.
const { createSpinetab, resolveEndpoint } = require("spinetab");
const { pollEvery, polling } = require("spinetab/polling");

const INTERVAL_MS = 1_000;
const params = new URLSearchParams(location.search);
const run = params.get("run") ?? "default";
const sharing =
	params.get("mode") === "local"
		? "off"
		: params.get("sharing") === "require"
			? "require"
			: "prefer";
const url = `fx/poll/value?id=${encodeURIComponent(run)}`;

const client = createSpinetab({ sharing });

const probe = {
	run,
	clients: 1,
	events: [],
	errors: [],
	endpoint: resolveEndpoint(url, document.baseURI),
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
heading.textContent = "Spinetab polling (CommonJS)";
const statusText = document.createElement("p");
statusText.dataset.testid = "status";
const valueText = document.createElement("p");
valueText.dataset.testid = "value";
root.append(heading, statusText, valueText);

statusText.textContent = client.status.get().mode;
client.status.subscribe((status) => {
	statusText.textContent = status.mode;
});

client.subscribe(
	polling({ url, decoder: "json" }).subscription(),
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
