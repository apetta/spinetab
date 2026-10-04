import type { UIMessage, UIMessageChunk } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import type {
	AdapterConnection,
	RuntimeAdapter,
	SubscriptionSink,
} from "../../../src/core/adapter.ts";
import { isSpinetabError } from "../../../src/core/errors.ts";
import { SpinetabChatTransport } from "../../../src/integrations/ai-sdk/index.ts";
import {
	AI_ADAPTER_KIND,
	type AiCommandPayload,
	type AiCommandResult,
	type AiSubscriptionSpec,
} from "../../../src/integrations/ai-sdk/shared.ts";
import { disposeAll, makeClient } from "../core/helpers/client.ts";
import { ManualClock, settle } from "../core/helpers/clock.ts";
import { FakeWorkerHost } from "../core/helpers/worker.ts";

// A stateful AI follower whose runtime is replaced underneath it
// (WebKit re-initialises the SharedWorker when its first client page closes)
// learns it from the new runtime's `announce` at once: one honest
// `interrupted` outcome and one `onInterrupted`, with no start resent and no
// stop, over the real page client, bridge and runtime (package defaults; no
// clock time passes, so no heartbeat, probe or lease is involved).

afterEach(disposeAll);

const API = "https://chat.example/api/chat";
const realFlush = () => new Promise((resolve) => setTimeout(resolve, 5));

/** Scripted AI adapter shared by every runtime instance of the fake host. */
function scriptedAi() {
	const sinks = new Map<string, SubscriptionSink<unknown>>();
	const payloads: AiCommandPayload[] = [];
	const adapter: RuntimeAdapter<
		{ api: string },
		AiSubscriptionSpec,
		unknown,
		AiCommandPayload,
		AiCommandResult
	> = {
		kind: AI_ADAPTER_KIND,
		version: 1,
		connect(): AdapterConnection<
			AiSubscriptionSpec,
			unknown,
			AiCommandPayload,
			AiCommandResult
		> {
			return {
				subscribe(spec, sink) {
					const key =
						spec.kind === "generation"
							? `generation:${spec.generationId}`
							: spec.kind === "observe"
								? `observe:${spec.chatId}`
								: `resume:${spec.nonce}`;
					sinks.set(key, sink);
					return {
						unsubscribe: () => {
							if (sinks.get(key) === sink) sinks.delete(key);
						},
					};
				},
				async command(payload) {
					payloads.push(payload);
					return {
						status: "acknowledged",
						value: { status: 200, generationId: payload.generationId },
					};
				},
				dispose() {},
			};
		},
	};
	return { adapter, sinks, payloads };
}

describe("AI follower when the SharedWorker is re-initialised (UNIT-AI-10)", () => {
	it("reports one prompt interruption with no resend and no stop, and reattaches to the new runtime", async () => {
		const ai = scriptedAi();
		const clock = new ManualClock();
		const host = new FakeWorkerHost(clock, { adapters: () => [ai.adapter] });
		const originator = makeClient({ sharing: "require" }, { host, clock });
		const follower = makeClient({ sharing: "require" }, { host, clock });
		const interrupted: string[] = [];
		const transportA = new SpinetabChatTransport({
			client: originator.client,
			api: API,
			resume: false,
			stop: { api: (chatId, id) => `${API}/${chatId}/stop?g=${id}` },
		});
		const transportB = new SpinetabChatTransport({
			client: follower.client,
			api: API,
			resume: false,
			stop: { api: (chatId, id) => `${API}/${chatId}/stop?g=${id}` },
			onInterrupted: (chatId) => interrupted.push(chatId),
		});
		const dispose = transportB.observe("chat-1");
		await settle(clock);

		const started = transportA.sendMessages({
			trigger: "submit-message",
			chatId: "chat-1",
			messageId: undefined,
			messages: [
				{ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
			] as UIMessage[],
			abortSignal: undefined,
		});
		for (let round = 0; round < 4; round += 1) {
			await settle(clock);
			await realFlush();
		}
		await started;
		const start = ai.payloads[0] as Extract<
			AiCommandPayload,
			{ type: "start" }
		>;
		expect(start.type).toBe("start");
		const chunks: UIMessageChunk[] = [
			{ type: "start", messageId: start.generationId },
			{ type: "text-start", id: "t" },
		];
		ai.sinks.get("observe:chat-1")?.next({
			type: "chunks",
			generationId: start.generationId,
			index: 0,
			chunks,
		});
		await settle(clock);
		const stream = await transportB.reconnectToStream({ chatId: "chat-1" });
		if (!stream) throw new Error("follower stream missing");
		const reader = stream.getReader();
		expect((await reader.read()).value).toEqual(chunks[0]);
		expect((await reader.read()).value).toEqual(chunks[1]);
		const runtimeBefore = follower.client.status.get().runtimeId;
		const at = clock.now();

		// The originator's tab closes; the engine re-initialises the worker.
		originator.client.dispose();
		await settle(clock);
		host.reinit();
		await settle(clock);

		const failure = await reader.read().catch((error: unknown) => error);
		expect(isSpinetabError(failure, "interrupted")).toBe(true);
		await realFlush();
		await realFlush();
		expect(interrupted).toEqual(["chat-1"]);
		expect(clock.now()).toBe(at);
		expect(follower.client.status.get()).toMatchObject({
			mode: "shared",
			health: "healthy",
			generation: 2,
			runtimeId: host.runtime.id,
		});
		expect(follower.client.status.get().runtimeId).not.toBe(runtimeBefore);
		// The observation was re-registered once on the new runtime; nothing
		// was started again and nothing was stopped.
		expect(host.runtime.stats().consumers).toBe(1);
		expect(ai.payloads.map((payload) => payload.type)).toEqual(["start"]);
		// Later episodes are unaffected: no second callback without a new loss.
		await settle(clock);
		await realFlush();
		expect(interrupted).toEqual(["chat-1"]);
		dispose();
	});
});
