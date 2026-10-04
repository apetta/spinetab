"use client";

// First: configures zod before the AI SDK builds its schemas.
import "./zod-jitless";
import { useChat } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import { useEffect, useState } from "react";
import { type ClientStatus, createSpinetab } from "spinetab";
import { SpinetabChatTransport } from "spinetab/ai-sdk";
import { useSpinetabStatus } from "spinetab/react";

interface Probe {
	run: string;
	clients: number;
	events: unknown[];
	errors: Array<{ code: string; message: string }>;
	endpoint: string;
	extra: {
		text: string;
		starts: number;
		role: string | null;
		observing: boolean;
		send: (() => unknown) | null;
	};
	status(): Record<string, unknown>;
}

const client = createSpinetab({
	worker: () =>
		new SharedWorker(new URL("./live.worker.ts", import.meta.url), {
			type: "module",
		}),
	local: () => import("./live.worker"),
});

const probe: Probe = {
	run: "",
	clients: 0,
	events: [],
	errors: [],
	endpoint: "",
	extra: { text: "", starts: 0, role: null, observing: false, send: null },
	status: () => plain(client.status.get()),
};
if (typeof window !== "undefined") {
	probe.clients += 1;
	(window as { __consumer?: Probe }).__consumer = probe;
}

function plain(status: ClientStatus): Record<string, unknown> {
	const { mode, reason, health, runtimeId, generation, error } = status;
	return {
		mode,
		reason,
		health,
		runtimeId,
		generation,
		...(error ? { error: { code: error.code, message: error.message } } : {}),
	};
}

function assistantText(messages: UIMessage[]): string {
	const last = messages.findLast((message) => message.role === "assistant");
	return (last?.parts ?? [])
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("");
}

export function ChatView({ api }: { api: string }) {
	const status = useSpinetabStatus(client);
	const [chatId, setChatId] = useState<string | null>(null);
	useEffect(() => {
		const run = new URLSearchParams(location.search).get("run") ?? "default";
		probe.run = run;
		probe.endpoint = new URL(api, document.baseURI).href;
		setChatId(`chat-${run}`);
	}, [api]);
	return (
		<section>
			<p data-testid="status">
				{status.reason ? `${status.mode}/${status.reason}` : status.mode}
			</p>
			{chatId ? <Chat chatId={chatId} api={api} /> : null}
		</section>
	);
}

const transports = new Map<string, SpinetabChatTransport>();
function transportFor(api: string): SpinetabChatTransport {
	let transport = transports.get(api);
	if (!transport) {
		transport = new SpinetabChatTransport({ client, api });
		transports.set(api, transport);
	}
	return transport;
}

function Chat({ chatId, api }: { chatId: string; api: string }) {
	const transport = transportFor(api);
	const { messages, sendMessage, resumeStream, status, error } = useChat({
		id: chatId,
		transport,
	});
	// Follow generations started in other tabs, and resume after a loss.
	useEffect(() => {
		const stop = transport.follow(chatId, () => {
			probe.extra.starts += 1;
			void resumeStream();
		});
		probe.extra.observing = true;
		return () => {
			probe.extra.observing = false;
			stop();
		};
	}, [transport, chatId, resumeStream]);
	useEffect(() => {
		probe.extra.send = () => sendMessage({ text: "Hello" });
	}, [sendMessage]);
	const text = assistantText(messages);
	useEffect(() => {
		probe.extra.text = text;
		probe.extra.role = transport.role(chatId) ?? null;
		if (text) probe.events.push(text);
	}, [text, transport, chatId]);
	useEffect(() => {
		if (error) probe.errors.push({ code: error.name, message: error.message });
	}, [error]);
	return (
		<>
			<p data-testid="chat-status">{status}</p>
			<p data-testid="answer">{text}</p>
		</>
	);
}
