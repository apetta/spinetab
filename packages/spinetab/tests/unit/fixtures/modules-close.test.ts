import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { io as connectSocketIo } from "socket.io-client";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { startFixtures } from "../../fixtures/servers/start.ts";

// Every protocol module that owns a WebSocket server, a Socket.IO instance or
// timers registers an `app.onClose` hook, so `startFixtures().close()` stays
// deterministic with live clients on every module: it completes well inside
// the launcher's 1 s hook deadline and leaves no referenced timers or sockets.

const HOOK_DEADLINE_MS = 1_000;

/** Referenced timers and TCP handles currently keeping the loop alive. */
function liveHandles(): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const type of process.getActiveResourcesInfo()) {
		if (type === "Timeout" || type.startsWith("TCP")) {
			counts[type] = (counts[type] ?? 0) + 1;
		}
	}
	return counts;
}

async function firstChunk(response: Response): Promise<void> {
	const reader = response.body?.getReader();
	if (!reader) throw new Error("no body");
	await reader.read();
	// Keep the stream open; the fixture must end it on shutdown.
	void reader.read().then(
		() => {},
		() => {},
	);
}

describe("fixture modules close deterministically", () => {
	it("closes ws, graphql-ws, trpc, Socket.IO, SSE, NDJSON, polling and AI with live clients", async () => {
		const baseline = liveHandles();
		const fixtures = await startFixtures([0]);
		const app = fixtures.apps[0];
		if (!app) throw new Error("no fixture app");
		const origin = app.origin;
		const wsOrigin = origin.replace("http:", "ws:");
		const run = `close-${Date.now()}`;
		const peers: WebSocket[] = [];

		// ws: a subscribed topic owns a server-side ticker.
		const topics = new WebSocket(`${wsOrigin}/ws/topics?run=${run}&rate=20`);
		peers.push(topics);
		await once(topics, "open");
		topics.send(JSON.stringify({ type: "subscribe", topic: "a" }));
		await once(topics, "message");

		// graphql-ws: an acknowledged anonymous connection. (Executing the
		// schema here would load a second `graphql` realm inside the Vitest
		// worker; subscriptions are covered by the integration project.)
		const gql = new WebSocket(
			`${wsOrigin}/graphql-ws?tag=${run}&anonymous=1`,
			"graphql-transport-ws",
		);
		peers.push(gql);
		await once(gql, "open");
		gql.send(JSON.stringify({ type: "connection_init" }));
		await once(gql, "message");

		// tRPC WebSocket: an open anonymous connection.
		const trpc = new WebSocket(`${wsOrigin}/trpc-ws?tag=anon${run}`);
		peers.push(trpc);
		await once(trpc, "open");

		// Socket.IO: per-socket ticks and a room ticker.
		const socket = connectSocketIo(origin, {
			transports: ["websocket"],
			reconnection: false,
			query: { tag: run, anonymous: "1", ticks: "20" },
		});
		await new Promise<void>((resolve) => socket.once("connect", resolve));
		await socket.timeout(2_000).emitWithAck("join", `${run}-room`);

		// HTTP streams: SSE, NDJSON and a live AI generation.
		await firstChunk(await fetch(`${origin}/sse/ticks?run=${run}&rate=20`));
		await firstChunk(
			await fetch(`${origin}/stream/ndjson?run=${run}&count=10000&rate=20`),
		);
		await firstChunk(
			await fetch(`${origin}/ai/chat`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					id: `chat-${run}`,
					generationId: `gen-${run}`,
					size: 10_000,
					delayMs: 20,
				}),
			}),
		);

		// Polling: a hung read that is never answered.
		await fetch(`${origin}/__fixture/fault`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				target: "polling",
				action: "hang",
				value: { id: run },
			}),
		});
		const hung = fetch(`${origin}/poll/value?id=${run}`).then(
			() => "answered",
			() => "ended",
		);
		await delay(50);

		const started = performance.now();
		await fixtures.close();
		const elapsed = performance.now() - started;
		socket.close();
		for (const peer of peers) peer.terminate();

		// Hooks finished on their own: the launcher's deadline was not needed.
		expect(elapsed).toBeLessThan(HOOK_DEADLINE_MS / 2);
		expect(await hung).toBe("ended");
		// Per-request loops wake at most one interval (≤ 50 ms) after shutdown.
		await delay(200);
		const after = liveHandles();
		for (const [type, count] of Object.entries(after)) {
			expect({ type, count }).toEqual({
				type,
				count: Math.min(count, baseline[type] ?? 0),
			});
		}
	});
});
