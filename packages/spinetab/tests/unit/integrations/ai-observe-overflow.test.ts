import { afterEach, describe, expect, it } from "vitest";
import { SpinetabChatTransport } from "../../../src/integrations/ai-sdk/index.ts";
import { AI_ADAPTER_KIND } from "../../../src/integrations/ai-sdk/shared.ts";
import { disposeAll, makeClient } from "../core/helpers/client.ts";
import { settle } from "../core/helpers/clock.ts";

afterEach(disposeAll);

describe("AI discovery after consumer overflow", () => {
	it("reports interrupted chunks and still observes the next generation without a new prompt", async () => {
		const { client, host, clock } = makeClient(
			{ anonymous: true, limits: { maxPendingMessagesPerConsumer: 2 } },
			{ hostLimits: { test: { kind: AI_ADAPTER_KIND } } },
		);
		const transport = new SpinetabChatTransport({
			client,
			api: "https://chat.test/api/chat",
			resume: false,
		});
		const starts: string[] = [];
		const stop = transport.observe("chat", {
			onStart: (event) => starts.push(event.generationId),
		});
		await settle(clock);
		host.test.connections[0]?.ctx.setStatus({ state: "connected" });
		await settle(clock);
		const feed = host.test.last();
		for (let index = 0; index < 3; index += 1)
			feed.emit({
				type: "chunks",
				generationId: "old",
				index,
				chunks: [{ type: "start", messageId: "old" }],
			});
		await settle(clock);
		expect(starts).toEqual(["old"]);
		await expect(
			transport.reconnectToStream({ chatId: "chat" }),
		).rejects.toMatchObject({ code: "cannot-resume" });
		feed.emit({
			type: "chunks",
			generationId: "new",
			index: 0,
			chunks: [{ type: "start", messageId: "new" }],
		});
		await settle(clock);
		expect(starts).toEqual(["old", "new"]);
		expect(host.test.connections[0]?.commands).toEqual([]);
		expect(host.test.active()).toHaveLength(1);
		stop();
		await settle(clock);
		expect(host.test.active()).toHaveLength(0);
	});
});
