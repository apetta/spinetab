import { afterEach, describe, expect, it } from "vitest";
import { adapterNotRegistered } from "../../../src/core/errors.ts";
import { createRuntime, type Runtime } from "../../../src/core/runtime.ts";
import { disposeAll, feed, makeClient, observe } from "./helpers/client.ts";
import { ManualClock, settle } from "./helpers/clock.ts";
import { RawPage } from "./helpers/page.ts";
import { createTestAdapter } from "./helpers/test-adapter.ts";

// The adapter-not-registered message names the factory and the entry
// to import, computed from the kind string, and the plugin's
// adapters option as the first lever.

const runtimes: Runtime[] = [];
afterEach(() => {
	disposeAll();
	for (const runtime of runtimes.splice(0)) runtime.dispose();
});

const hint = (kind: string, factory: string, entry: string) =>
	`Adapter ${kind} is not registered. List "${kind}" in the plugin's adapters option, or add ${factory}() from spinetab/${entry}/runtime to your worker file.`;

describe("adapter-not-registered message", () => {
	it.each([
		["polling", "pollingAdapter", "polling"],
		["sse", "sseAdapter", "sse"],
		["stream", "streamAdapter", "stream"],
		["websocket", "websocketAdapter", "websocket"],
		["graphql-ws", "graphqlWsAdapter", "graphql-ws"],
		["graphql-sse", "graphqlSseAdapter", "graphql-sse"],
		["socket-io", "socketIoAdapter", "socket-io"],
		["trpc-ws", "trpcWsAdapter", "trpc"],
		["trpc-sse", "trpcSseAdapter", "trpc"],
		["ai-sdk", "aiSdkAdapter", "ai-sdk"],
	])("names %s's factory and entry", (kind, factory, entry) => {
		const error = adapterNotRegistered(kind);
		expect(error.code).toBe("adapter-not-registered");
		expect(error.message).toBe(hint(kind, factory, entry));
		expect(error.detail).toEqual({ adapter: kind });
	});

	it("reports it from the page when the shared runtime lacks the adapter", async () => {
		const { client, clock } = makeClient();
		const missing = observe();
		client.subscribe(feed({}, { adapter: "graphql-ws" }), missing.observer);
		await settle(clock);
		expect(missing.log.errors).toHaveLength(1);
		expect(missing.log.errors[0]).toMatchObject({
			code: "adapter-not-registered",
			message: hint("graphql-ws", "graphqlWsAdapter", "graphql-ws"),
			detail: { adapter: "graphql-ws" },
		});
	});

	it("reports it from the runtime for a subscription and a command", async () => {
		const clock = new ManualClock();
		const runtime = createRuntime({
			adapters: [createTestAdapter().adapter],
			clock,
		});
		runtimes.push(runtime);
		const page = new RawPage(runtime);
		page.hello();
		await settle(clock);
		page.subscribe("1", { adapter: "trpc-ws" });
		page.send({
			t: "command",
			id: "k1",
			request: {
				adapter: "socket-io",
				connection: { url: "https://x.test" },
				payload: {},
			},
			timeoutMs: 1_000,
		});
		await settle(clock);
		expect(page.ofType("error")[0]).toMatchObject({
			c: "1",
			code: "adapter-not-registered",
			message: hint("trpc-ws", "trpcWsAdapter", "trpc"),
		});
		expect(page.ofType("commandResult")[0]).toMatchObject({
			id: "k1",
			outcome: {
				status: "not-sent",
				error: {
					code: "adapter-not-registered",
					message: hint("socket-io", "socketIoAdapter", "socket-io"),
				},
			},
		});
	});
});
