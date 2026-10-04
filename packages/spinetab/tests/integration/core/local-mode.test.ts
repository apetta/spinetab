import { afterEach, describe, expect, inject, it, vi } from "vitest";
import { createSpinetab } from "../../../src/index.ts";
import { pollEvery, polling } from "../../../src/transports/polling/index.ts";
import { pollingAdapter } from "../../../src/transports/polling/runtime.ts";
import { defineWorker } from "../../../src/worker/index.ts";
import { byId, uniqueId, waitFor } from "./helpers.ts";

// The public createSpinetab
// in sharing "off" mode, lazily loading a local runtime over a MessageChannel
// and delivering real polling results from the fixture server. The local
// module is the one-file recipe's worker module: its default export is what
// `defineWorker` returns.

const [origin] = inject("fixtureOrigins");

afterEach(() => {
	vi.unstubAllGlobals();
});

function stubBrowser(baseURI: string) {
	const target = () => ({ addEventListener() {}, removeEventListener() {} });
	vi.stubGlobal("window", target());
	vi.stubGlobal("document", {
		...target(),
		visibilityState: "visible",
		baseURI,
	});
}

describe("createSpinetab in local mode (end to end)", () => {
	it("loads the local runtime lazily and delivers real polling results in order", async () => {
		stubBrowser(`${origin}/app/`);
		const id = uniqueId("local");
		const local = vi.fn(async () => ({
			default: defineWorker(() => [pollingAdapter()]),
		}));
		const client = createSpinetab({ sharing: "off", local });
		expect(local).not.toHaveBeenCalled();
		const feed = polling({ url: `/poll/value?id=${id}` }).subscription<{
			n: number;
			scope: string | null;
		}>();
		const values: number[] = [];
		const handle = client.subscribe(
			feed,
			{ next: (value) => values.push(value.n) },
			pollEvery(1_000),
		);
		await waitFor(() => values.length >= 2, 6_000);
		expect(local).toHaveBeenCalledTimes(1);
		expect(client.status.get()).toMatchObject({
			mode: "local",
			reason: "sharing-off",
			health: "healthy",
		});
		expect(values.slice(0, 2)).toEqual([1, 2]);
		expect(handle.status.get()).toMatchObject({
			connection: { state: "connected" },
			continuity: { state: "continuous" },
		});
		handle.unsubscribe();
		const { stats } = await byId(origin, id);
		await new Promise((resolve) => setTimeout(resolve, 2_200));
		const after = await byId(origin, id);
		expect(after.stats.requests).toBe(stats.requests);
		client.dispose();
		expect(client.status.get().mode).toBe("disposed");
	});
});
