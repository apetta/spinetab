import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sse } from "../../../src/transports/sse/index.ts";
import { sseAdapter } from "../../../src/transports/sse/runtime.ts";
import { disposeAll, makeClient, observe } from "../core/helpers/client.ts";
import { ManualClock, settle } from "../core/helpers/clock.ts";
import { FakeWorkerHost } from "../core/helpers/worker.ts";
import { FakeEventSource } from "./helpers.ts";

// A declared SSE reset event through the real runtime and page client: the
// adapter's `replay-reset` maps to `gap` and replaces an earlier `resumed`
beforeEach(() => {
	FakeEventSource.reset();
	vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
	disposeAll();
	vi.unstubAllGlobals();
});

describe("SSE reset event on the page", () => {
	it("downgrades a reported resume to a sticky gap and never delivers the reset event", async () => {
		const clock = new ManualClock();
		const host = new FakeWorkerHost(clock, {
			adapters: () => [sseAdapter()],
		});
		const { client } = makeClient({}, { host, clock });
		const { log, observer } = observe();
		const handle = client.subscribe(
			sse({
				url: "https://api.test/sse",
				mode: "eventsource",
				replay: "last-event-id",
				resetEvent: "reset",
				decoder: "text",
			}).subscription(),
			observer,
		);
		await settle(clock);
		const source = FakeEventSource.last();
		source.open();
		source.emit("message", "a", "5");
		source.networkError();
		source.open();
		await settle(clock);
		expect(handle.status.get().continuity).toMatchObject({
			state: "resumed",
			reason: "resumed-with-cursor",
			cursor: "5",
		});
		source.emit("reset", "exhausted", "5");
		source.emit("message", "b", "50");
		await settle(clock);
		expect(handle.status.get().continuity).toMatchObject({
			state: "gap",
			reason: "replay-reset",
		});
		expect(log.events).toEqual(["a", "b"]);
	});
});
