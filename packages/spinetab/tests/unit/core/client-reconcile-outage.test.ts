import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setWorkerOriginForTests } from "../../../src/core/runtime.ts";
import type { SubscriptionStatus } from "../../../src/core/types.ts";
import { graphqlWs } from "../../../src/protocols/graphql-ws/index.ts";
import { graphqlWsAdapter } from "../../../src/protocols/graphql-ws/runtime.ts";
import { websocketAdapter } from "../../../src/transports/websocket/runtime.ts";
import { FakeWebSocket as GraphqlWsSocket } from "../protocols/fakes.ts";
import { FakeWebSocket } from "../transports/helpers.ts";
import { disposeAll, feed, makeClient, observe } from "./helpers/client.ts";
import { settle, tick } from "./helpers/clock.ts";

// an application that reconciles on the
// early notice, while the upstream is still down, must learn when to reconcile
// again. The reconnect outcome precedes the `connected` that restores
// delivery, so the outage is never hidden behind a false `continuous`.

// The harness worker runs on the endpoints' origin, so provider credentials
// stay within the credential audience; Node has no `location`.
beforeEach(() => setWorkerOriginForTests("https://api.test"));
afterEach(() => setWorkerOriginForTests(undefined));

afterEach(() => {
	disposeAll();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

/** Continuity and connection changes in the order the observer saw them. */
function transitions(statuses: SubscriptionStatus[]): string[] {
	const log: string[] = [];
	let previous: SubscriptionStatus | undefined;
	for (const status of statuses) {
		if (status.continuity !== previous?.continuity) {
			log.push(`continuity:${status.continuity.state}`);
		}
		if (status.connection.state !== previous?.connection.state) {
			log.push(`connection:${status.connection.state}`);
		}
		previous = status;
	}
	return log;
}

describe("reconciling during an outage does not hide the outage", () => {
	beforeEach(() => {
		FakeWebSocket.reset();
		vi.stubGlobal("WebSocket", FakeWebSocket);
		// Only the adapter's backoff timer is faked; the client and runtime run
		// on the manual clock and real MessageChannel delivery.
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		vi.spyOn(Math, "random").mockReturnValue(0.5);
	});

	it("native WebSocket: the outcome at reconnect makes continuity non-continuous again", async () => {
		const { client, clock } = makeClient(
			{},
			{ hostLimits: { adapters: () => [websocketAdapter()] } },
		);
		const { log, observer } = observe();
		const handle = client.subscribe(
			{
				adapter: "websocket",
				connection: { url: "wss://api.test/ws" },
				subscription: {},
			},
			observer,
		);
		await settle(clock);
		FakeWebSocket.last().serverOpen();
		await settle(clock);
		expect(handle.status.get().connection.state).toBe("connected");

		// The early notice: continuity is unknown while the socket is down.
		FakeWebSocket.last().serverClose(1006);
		await settle(clock);
		expect(handle.status.get()).toMatchObject({
			continuity: { state: "unknown", reason: "reconnected" },
			connection: { state: "reconnecting" },
		});

		// The application reconciles (a refetch) while still disconnected.
		handle.markReconciled();
		const reconciledAt = handle.status.get().continuity.since;
		expect(handle.status.get().continuity.state).toBe("continuous");

		// Events produced from here until the new socket is live are missed.
		clock.advance(1_000);
		await vi.advanceTimersByTimeAsync(500);
		expect(FakeWebSocket.instances).toHaveLength(2);
		FakeWebSocket.last().serverOpen();
		await settle(clock);

		expect(handle.status.get()).toMatchObject({
			continuity: { state: "unknown", reason: "reconnected" },
			connection: { state: "connected" },
		});
		expect(handle.status.get().continuity.since).toBeGreaterThan(reconciledAt);
		expect(transitions(log.statuses).slice(-4)).toEqual([
			"connection:reconnecting",
			"continuity:continuous",
			"continuity:unknown",
			"connection:connected",
		]);
	});
});

describe("graphql-ws: reconciling during an outage does not hide the outage (APL-09)", () => {
	beforeEach(() => {
		GraphqlWsSocket.reset();
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	});

	it("an early notice, then markReconciled() while reconnecting: the outcome at reconnect makes continuity non-continuous again", async () => {
		const { client, clock } = makeClient(
			{ credentials: () => ({ connectionParams: { token: "t1" } }) },
			{
				hostLimits: {
					adapters: () => [
						graphqlWsAdapter({
							webSocketImpl: GraphqlWsSocket,
							retryWait: async () => {},
						}),
					],
				},
			},
		);
		const { log, observer } = observe();
		const handle = client.subscribe(
			graphqlWs({ url: "wss://api.test/graphql" }).subscription({
				query: "subscription { ticks { n } }",
			}),
			observer,
		);
		await settle(clock);
		GraphqlWsSocket.last().accept();
		await settle(clock);
		expect(handle.status.get().connection.state).toBe("connected");

		// The early notice: the socket drops and graphql-ws starts a new one.
		GraphqlWsSocket.last().networkError();
		await settle(clock);
		expect(GraphqlWsSocket.instances).toHaveLength(2);
		expect(handle.status.get()).toMatchObject({
			continuity: { state: "unknown", reason: "reconnected" },
			connection: { state: "reconnecting" },
		});

		// The application reconciles (a refetch) while still disconnected.
		handle.markReconciled();
		const reconciledAt = handle.status.get().continuity.since;
		expect(handle.status.get().continuity.state).toBe("continuous");

		// Events produced until the new socket is acknowledged are missed.
		clock.advance(1_000);
		GraphqlWsSocket.last().accept();
		await settle(clock);

		expect(handle.status.get()).toMatchObject({
			continuity: { state: "unknown", reason: "reconnected" },
			connection: { state: "connected" },
		});
		expect(handle.status.get().continuity.since).toBeGreaterThan(reconciledAt);
		expect(transitions(log.statuses).slice(-4)).toEqual([
			"connection:reconnecting",
			"continuity:continuous",
			"continuity:unknown",
			"connection:connected",
		]);
	});
});

describe("runtime replacement: the outcome follows the new runtime's connected", () => {
	it("a reconcile while the replacement connects is followed by an unknown outcome", async () => {
		const { client, host, clock } = makeClient({
			heartbeatMs: 1_000,
			probeTimeoutMs: 500,
			handshakeTimeoutMs: 1_000,
		});
		const { log, observer } = observe();
		const handle = client.subscribe(feed(), observer);
		await settle(clock);
		host.test.connections[0]?.ctx.setStatus({ state: "connected" });
		await settle(clock);

		host.crash();
		await tick(clock, 3_000, 100);
		expect(client.status.get().health).toBe("healthy");
		expect(host.runtime.stats().consumers).toBe(1);
		expect(handle.status.get().continuity).toMatchObject({
			state: "unknown",
			reason: "runtime-replaced",
		});

		handle.markReconciled();
		const reconciledAt = handle.status.get().continuity.since;
		clock.advance(1_000);
		host.test.last().emit({ n: "missed" });
		host.test.connections.at(-1)?.ctx.setStatus({ state: "connected" });
		await settle(clock);

		expect(handle.status.get()).toMatchObject({
			continuity: { state: "unknown", reason: "runtime-replaced" },
			connection: { state: "connected" },
		});
		expect(handle.status.get().continuity.since).toBeGreaterThan(reconciledAt);
		expect(transitions(log.statuses).slice(-2)).toEqual([
			"continuity:unknown",
			"connection:connected",
		]);

		// Reported once: a later reconnect of the same upstream is the adapter's.
		host.test.connections.at(-1)?.ctx.setStatus({ state: "connecting" });
		await settle(clock);
		handle.markReconciled();
		host.test.connections.at(-1)?.ctx.setStatus({ state: "connected" });
		await settle(clock);
		expect(handle.status.get().continuity.state).toBe("continuous");
	});

	it("an adapter outcome on the new runtime is kept, not overridden", async () => {
		const { client, host, clock } = makeClient({
			heartbeatMs: 1_000,
			probeTimeoutMs: 500,
			handshakeTimeoutMs: 1_000,
		});
		const handle = client.subscribe(feed(), observe().observer);
		await settle(clock);
		host.crash();
		await tick(clock, 3_000, 100);
		expect(host.runtime.stats().consumers).toBe(1);

		const upstream = host.test.last();
		upstream.sink.continuity("resumed-with-cursor", {
			cursor: "c1",
			duplicatesPossible: true,
		});
		host.test.connections.at(-1)?.ctx.setStatus({ state: "connected" });
		await settle(clock);

		expect(handle.status.get()).toMatchObject({
			continuity: { state: "resumed", reason: "resumed-with-cursor" },
			connection: { state: "connected" },
		});
	});
});
