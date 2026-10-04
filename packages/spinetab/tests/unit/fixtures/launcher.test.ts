import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { startFixtures } from "../../fixtures/servers/start.ts";

// Upgraded sockets are outside closeAllConnections(); the launcher must track and destroy them on shutdown.

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("fixture launcher shutdown", () => {
	it("closes deterministically with an upgraded WebSocket still open", async () => {
		const fixtures = await startFixtures([0]);
		const app = fixtures.apps[0];
		if (!app) throw new Error("no fixture app");
		const wss = new WebSocketServer({ noServer: true });
		let hookRan = false;
		app.onClose(() => {
			hookRan = true;
		});
		app.upgrade("/test/ws", (request, socket, head) => {
			wss.handleUpgrade(request, socket, head, (peer) =>
				wss.emit("connection", peer),
			);
		});
		const client = new WebSocket(
			`${app.origin.replace("http:", "ws:")}/test/ws`,
		);
		cleanups.push(() => {
			client.terminate();
			for (const peer of wss.clients) peer.terminate();
			return new Promise<void>((resolve) => wss.close(() => resolve()));
		});
		await once(client, "open");
		const clientClosed = once(client, "close");

		const closedWithinBudget = await Promise.race([
			fixtures.close().then(() => true),
			delay(500).then(() => false),
		]);

		expect(closedWithinBudget).toBe(true);
		expect(hookRan).toBe(true);
		await Promise.race([clientClosed, delay(500)]);
		expect(client.readyState).not.toBe(WebSocket.OPEN);
		// Idempotent: a second close resolves immediately.
		await fixtures.close();
	});

	it("closes with an idle keep-alive HTTP connection open", async () => {
		const fixtures = await startFixtures([0]);
		const app = fixtures.apps[0];
		if (!app) throw new Error("no fixture app");
		const response = await fetch(`${app.origin}/__fixture/counters`);
		expect(response.status).toBe(200);
		await response.text();
		const closedWithinBudget = await Promise.race([
			fixtures.close().then(() => true),
			delay(500).then(() => false),
		]);
		expect(closedWithinBudget).toBe(true);
	});
});
