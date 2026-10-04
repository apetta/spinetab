import { ApolloClient, gql, InMemoryCache } from "@apollo/client";
import { createTRPCClient } from "@trpc/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClientWithEnv } from "../../../src/core/client.ts";
import { createRuntime, type Runtime } from "../../../src/core/runtime.ts";
import type { SubscriptionStatus } from "../../../src/core/types.ts";
import { SpinetabLink } from "../../../src/integrations/apollo/index.ts";
import {
	spinetabSseLink,
	spinetabWsLink,
} from "../../../src/integrations/trpc/index.ts";
import { graphqlSse } from "../../../src/protocols/graphql-sse/index.ts";
import { graphqlWs } from "../../../src/protocols/graphql-ws/index.ts";
import type { FixtureTrpcRouter } from "../../fixtures/servers/trpc.ts";
import { ManualClock, settle } from "../core/helpers/clock.ts";
import { createTestEnv } from "../core/helpers/env.ts";
import { createTestAdapter } from "../core/helpers/test-adapter.ts";
import { FakeWorkerHost } from "../core/helpers/worker.ts";

// Regression: a healthy upstream survived but Apollo ended an overflowed
// consumer. Exercise real page/runtime admission and real library observables;
// the scripted adapter isolates the integration responsibility from protocol IO.
const SUB = gql`subscription Ticks { ticks { n } }`;
const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const dispose of cleanups.splice(0)) dispose();
});

function setup(kind: string, sharing: "prefer" | "off") {
	const clock = new ManualClock();
	const upstream = createTestAdapter({ kind });
	const host = new FakeWorkerHost(clock, {
		adapters: () => [upstream.adapter],
	});
	const locals: Runtime[] = [];
	const clients = [0, 1].map(() =>
		createClientWithEnv(
			{
				worker: host.factory,
				local: async () => ({
					default: () => {
						const runtime = createRuntime({
							adapters: [upstream.adapter],
							clock,
						});
						locals.push(runtime);
						return runtime;
					},
				}),
				sharing,
				anonymous: true,
				limits: { maxPendingMessagesPerConsumer: 2, maxPendingMessages: 16 },
			},
			createTestEnv(clock).env,
		),
	);
	cleanups.push(() => {
		for (const client of clients) client.dispose();
		host.dispose();
		for (const local of locals) local.dispose();
	});
	return { clock, upstream, host, clients };
}

describe("subscription recovery policy after real admission overflow", () => {
	for (const kind of [
		"graphql-ws",
		"graphql-sse",
		"trpc-ws",
		"trpc-sse",
	] as const) {
		for (const sharing of ["prefer", "off"] as const) {
			it.each([
				"refresh",
				"latest",
			] as const)(`${kind} ${sharing}: %s preserves the operation and later live delivery`, async (policy) => {
				const { clock, upstream, host, clients } = setup(kind, sharing);
				const values: number[][] = [[], []];
				const errors: unknown[] = [];
				const statuses: SubscriptionStatus[][] = [[], []];
				const refreshes = [vi.fn(async () => {}), vi.fn(async () => {})];
				for (const [index, client] of clients.entries()) {
					if (kind.startsWith("graphql")) {
						const apollo = new ApolloClient({
							cache: new InMemoryCache(),
							link: new SpinetabLink(
								client,
								kind === "graphql-ws"
									? graphqlWs("https://api.test/graphql")
									: graphqlSse("https://api.test/graphql"),
								{
									reconcile: policy === "latest" ? "latest" : refreshes[index],
									onStatus: (status) => statuses[index]?.push(status),
								},
							),
						});
						cleanups.push(() => apollo.stop());
						const subscription = apollo
							.subscribe<{ ticks: { n: number } }>({ query: SUB })
							.subscribe({
								next: (value) => {
									if (value.error) errors.push(value.error);
									if (value.data) values[index]?.push(value.data.ticks.n);
								},
								error: (error) => errors.push(error),
							});
						cleanups.push(() => subscription.unsubscribe());
					} else {
						const factory =
							kind === "trpc-ws" ? spinetabWsLink : spinetabSseLink;
						const trpc = createTRPCClient<FixtureTrpcRouter>({
							links: [
								factory<FixtureTrpcRouter>({
									client,
									url: "https://api.test/trpc",
									reconcile: policy === "latest" ? "latest" : refreshes[index],
									onStatus: (status) => statuses[index]?.push(status),
								}),
							],
						});
						const subscription = trpc.ticks.subscribe(
							{ tag: "same" },
							{
								onData: (value) => values[index]?.push(value.data.n),
								onError: (error) => errors.push(error),
							},
						);
						cleanups.push(() => subscription.unsubscribe());
					}
				}
				await settle(clock);
				for (const connection of upstream.connections)
					connection.ctx.setStatus({ state: "connected" });
				await settle(clock);
				expect(upstream.active()).toHaveLength(sharing === "prefer" ? 1 : 2);
				const emit = (n: number) => {
					for (const record of upstream.active())
						record.emit(
							kind.startsWith("graphql")
								? { data: { ticks: { n } } }
								: { data: { id: String(n), data: { n } }, id: String(n) },
						);
				};
				if (sharing === "prefer") {
					// One tab stalls; healthy peers still receive and acknowledge.
					const follower = host.relays[1];
					if (!follower) throw new Error("missing follower relay");
					follower.hold = true;
					for (let n = 1; n <= 3; n += 1) {
						emit(n);
						await settle(clock);
					}
					expect(values[0]).toEqual([1, 2, 3]);
					host.release(follower);
				} else {
					// Local admission is bounded too: a burst precedes the ACK task.
					for (let n = 1; n <= 3; n += 1) emit(n);
				}
				await settle(clock);
				expect(
					statuses[1]?.some((s) => s.continuity.reason === "overflow"),
				).toBe(true);
				expect(errors).toEqual([]);
				if (policy === "refresh") {
					expect(refreshes[1]).toHaveBeenCalled();
					expect(statuses[1]?.at(-1)?.continuity.state).toBe("continuous");
				} else expect(statuses[1]?.at(-1)?.continuity.state).toBe("gap");
				emit(4);
				await settle(clock);
				expect(values[1]?.at(-1)).toBe(4);
				expect(statuses[1]?.at(-1)?.continuity.state).toBe("continuous");
				expect(upstream.active()).toHaveLength(sharing === "prefer" ? 1 : 2);
				for (const dispose of cleanups.splice(0).reverse()) dispose();
				expect(upstream.active()).toHaveLength(0);
			});
		}
	}
});
