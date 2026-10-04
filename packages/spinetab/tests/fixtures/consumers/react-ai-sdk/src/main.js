// First: configures zod before the AI SDK builds its schemas.
import "./zod-jitless.js";
import { useChat } from "@ai-sdk/react";
import { createElement as h, StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { createSpinetab, resolveEndpoint } from "spinetab";
import { SpinetabChatTransport } from "spinetab/ai-sdk";
import { useSpinetabStatus } from "spinetab/react";
import { endpoints, readSettings } from "./config.js";

const settings = readSettings();
const urls = endpoints(settings.run);

const client = createSpinetab({
	worker: () =>
		new SharedWorker(new URL("./live.worker.js", import.meta.url), {
			type: "module",
		}),
	local: () => import("./live.worker.js"),
	sharing: settings.sharing,
});
const transport = new SpinetabChatTransport({ client, api: urls.chat });

const probe = {
	run: settings.run,
	clients: 1,
	events: [],
	errors: [],
	endpoint: resolveEndpoint(urls.chat, document.baseURI),
	extra: { text: "", starts: 0, role: null, observing: false, send: null },
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

function assistantText(messages) {
	const last = messages.findLast((message) => message.role === "assistant");
	return (last?.parts ?? [])
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("");
}

function Chat() {
	const { messages, sendMessage, resumeStream, status, error } = useChat({
		id: urls.chatId,
		transport,
	});
	// Follow generations started in other tabs from their first chunk, and
	// resume after a loss.
	useEffect(() => {
		const stop = transport.follow(urls.chatId, () => {
			probe.extra.starts += 1;
			void resumeStream();
		});
		probe.extra.observing = true;
		return () => {
			probe.extra.observing = false;
			stop();
		};
	}, [resumeStream]);
	useEffect(() => {
		probe.extra.send = () => sendMessage({ text: "Hello" });
	}, [sendMessage]);
	const text = assistantText(messages);
	useEffect(() => {
		probe.extra.text = text;
		probe.extra.role = transport.role(urls.chatId) ?? null;
		if (text) probe.events.push(text);
	}, [text]);
	useEffect(() => {
		if (error) probe.errors.push({ code: error.code, message: error.message });
	}, [error]);
	return h(
		"section",
		null,
		h("p", { "data-testid": "chat-status" }, status),
		h("p", { "data-testid": "answer" }, text),
	);
}

function App() {
	const status = useSpinetabStatus(client);
	return h(
		"main",
		null,
		h("h1", null, "Spinetab AI SDK"),
		h("p", { "data-testid": "status" }, status.mode),
		h(Chat),
	);
}

const root =
	document.getElementById("app") ??
	document.body.appendChild(
		Object.assign(document.createElement("div"), { id: "app" }),
	);
createRoot(root).render(h(StrictMode, null, h(App)));
