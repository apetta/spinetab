import { afterEach, describe, expect, it } from "vitest";
import { adapterNotRegistered } from "../../../src/core/errors.ts";
import { disposeAll, feed, makeClient, observe } from "./helpers/client.ts";
import { settle } from "./helpers/clock.ts";

// The missing-adapter error must identify both plugin and explicit-worker remedies without exposing option values.

afterEach(disposeAll);

const REPORT =
	"adapter-not-registered: add the adapter to the plugin's adapters option or to your worker file.";

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
	])("%s names the adapters option, %s and spinetab/%s/runtime", (kind, factory, entry) => {
		const error = adapterNotRegistered(kind);
		expect(error.code).toBe("adapter-not-registered");
		expect(error.message).toBe(
			`Adapter ${kind} is not registered. List "${kind}" in the plugin's adapters option, or add ${factory}() from spinetab/${entry}/runtime to your worker file.`,
		);
		expect(error.detail).toEqual({ adapter: kind });
		expect(error.retryable).toBe(false);
	});

	it.each([
		"test",
		"my-feed",
		"trpc",
		"trpc-http",
		"graphql",
		"Polling",
		"sse ",
		"",
	])("a kind outside the package (%j) gets the generic sentence", (kind) => {
		const error = adapterNotRegistered(kind);
		expect(error.message).toBe(
			`Adapter ${kind} is not registered. Add its adapter to your worker file.`,
		);
		expect(error.message).not.toContain("adapters option");
		expect(error.detail).toEqual({ adapter: kind });
	});
});

describe("adapter-not-registered on the page", () => {
	it("a handler gets the full message; an unhandled end reports the fixed sentence", async () => {
		const { client, clock, kit } = makeClient();
		const handled = observe();
		client.subscribe(feed({}, { adapter: "sse" }), handled.observer);
		client.subscribe(feed({ n: 2 }, { adapter: "sse" }), () => {});
		await settle(clock);
		expect(handled.log.errors).toHaveLength(1);
		expect(handled.log.errors[0]).toMatchObject({
			code: "adapter-not-registered",
			message: adapterNotRegistered("sse").message,
		});
		const found = kit.reportError.mock.calls.map(([error]) => {
			const { code, message } = error as { code: string; message: string };
			return { code, message };
		});
		expect(found).toEqual([
			{ code: "adapter-not-registered", message: REPORT },
		]);
	});
});
