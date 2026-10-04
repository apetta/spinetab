import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type ClientEnv,
	createClientWithEnv,
	createSpinetab as createCoreClient,
	SERVER_STATUS,
} from "../../../src/core/client.ts";
import { isSpinetabError } from "../../../src/core/errors.ts";
import type {
	SpinetabClient,
	SpinetabOptions,
} from "../../../src/core/types.ts";
import { createSpinetab } from "../../../src/index.ts";
import {
	disposeAll,
	feed,
	makeClient,
	modes,
	observe,
} from "./helpers/client.ts";
import { ManualClock, settle } from "./helpers/clock.ts";
import { createTestEnv } from "./helpers/env.ts";

// Missing runtime wiring must fail on first start and report once, even with a status subscriber.

const SENTENCE =
	"not-configured: add the spinetab plugin to your bundler config, or pass worker and local to createSpinetab.";

const clients: SpinetabClient[] = [];
afterEach(() => {
	disposeAll();
	for (const client of clients.splice(0)) client.dispose();
});

/** A client built with no options at all and no status subscriber. */
function bare(overrides: Parameters<typeof createTestEnv>[1] = {}) {
	const clock = new ManualClock();
	const kit = createTestEnv(clock, overrides);
	const client = createClientWithEnv(undefined as never, kit.env);
	clients.push(client);
	return { clock, kit, client };
}

const unconfigured = () => makeClient({ worker: undefined }, { noLocal: true });

const reports = (reportError: ReturnType<typeof vi.fn>) =>
	reportError.mock.calls.map(([error]) => {
		const { code, message } = error as { code: string; message: string };
		return { code, message };
	});

describe("not-configured: construction", () => {
	it("stays inert until start: no report, no listeners, no timers", () => {
		const { client, kit, clock } = bare();
		expect(client.status.get()).toEqual({
			mode: "inactive",
			health: "unknown",
			generation: 0,
		});
		expect(kit.reportError).not.toHaveBeenCalled();
		expect(kit.listenerCount()).toBe(0);
		expect(clock.pending()).toBe(0);
	});

	it("keeps the constant server status outside a browser and never reports", async () => {
		const { client, kit, clock } = bare({ isBrowser: () => false });
		client.start();
		client.subscribe(feed(), () => {});
		client.retry();
		await settle(clock);
		expect(client.status.get()).toBe(SERVER_STATUS);
		expect(kit.reportError).not.toHaveBeenCalled();
	});

	it("core and root createSpinetab accept no argument (server status under Node)", () => {
		const core = createCoreClient();
		const root = createSpinetab();
		clients.push(core, root);
		expect(core.status.get()).toBe(SERVER_STATUS);
		expect(root.status.get()).toBe(SERVER_STATUS);
	});

	it("still rejects a non-object argument and an audience option (security)", () => {
		for (const input of [null, 1, "worker"]) {
			expect(() => createSpinetab(input as never)).toThrow(
				expect.objectContaining({ code: "unsupported-option" }),
			);
		}
		let caught: unknown;
		try {
			createSpinetab({
				credentialOrigins: ["https://api.example.com"],
			} as never);
		} catch (error) {
			caught = error;
		}
		expect(isSpinetabError(caught, "unsupported-option")).toBe(true);
	});
});

describe("not-configured: first start", () => {
	it("fails with reason and code not-configured, reported once with a status subscriber", async () => {
		const { client, clock, host, local, kit, history } = unconfigured();
		client.start();
		await settle(clock);
		const status = client.status.get();
		expect(status).toMatchObject({
			mode: "failed",
			reason: "not-configured",
			health: "unreachable",
		});
		expect(status.detail).toBeUndefined();
		expect(isSpinetabError(status.error, "not-configured")).toBe(true);
		expect(status.error?.detail).toEqual({ reason: "not-configured" });
		expect(modes(history)).toEqual(["inactive", "starting", "failed"]);
		expect(host.created).toBe(0);
		expect(local.factory).not.toHaveBeenCalled();
		expect(reports(kit.reportError)).toEqual([
			{ code: "not-configured", message: SENTENCE },
		]);
	});

	it("reports exactly the fixed sentence once without a status subscriber", async () => {
		const { client, clock, kit } = bare();
		client.start();
		await settle(clock);
		expect(client.status.get().reason).toBe("not-configured");
		// Not the generic "client failed; watch client.status…" sentence.
		expect(reports(kit.reportError)).toEqual([
			{ code: "not-configured", message: SENTENCE },
		]);
	});

	it("routes the report through onCallbackError when one is set", async () => {
		const onCallbackError = vi.fn();
		const clock = new ManualClock();
		const kit = createTestEnv(clock);
		const client = createClientWithEnv({ onCallbackError }, kit.env);
		clients.push(client);
		client.start();
		await settle(clock);
		expect(onCallbackError).toHaveBeenCalledTimes(1);
		expect(onCallbackError.mock.calls[0]?.[0]).toMatchObject({
			code: "not-configured",
			message: SENTENCE,
		});
		expect(onCallbackError.mock.calls[0]?.[1]).toEqual({ subscriptionId: "" });
		expect(kit.reportError).not.toHaveBeenCalled();
	});

	it.each<[string, Partial<SpinetabOptions>, Partial<ClientEnv>?]>([
		["prefer", {}],
		["require", { sharing: "require" }],
		["off", { sharing: "off" }],
		["no SharedWorker", {}, { hasSharedWorker: () => false }],
	])("sharing %s with neither factory is not-configured", async (_, options, env = {}) => {
		const { client, clock, kit } = makeClient(
			{ worker: undefined, ...options },
			{ noLocal: true, env },
		);
		client.start();
		await settle(clock);
		expect(client.status.get()).toMatchObject({
			mode: "failed",
			reason: "not-configured",
		});
		expect(reports(kit.reportError)).toEqual([
			{ code: "not-configured", message: SENTENCE },
		]);
	});

	it("the first browser subscribe starts it; handlers get the error, the client reports once", async () => {
		const { client, clock, kit } = unconfigured();
		const handled = observe();
		client.subscribe(feed(), handled.observer);
		// Function observers have no error handler: no second report each.
		client.subscribe(feed(), () => {});
		client.subscribe(feed({ n: 2 }), () => {});
		await settle(clock);
		expect(handled.log.errors).toHaveLength(1);
		expect(handled.log.errors[0]?.code).toBe("not-configured");
		const outcome = await client.command({
			adapter: "test",
			connection: { url: "https://api.test/cmd" },
			payload: 1,
		});
		expect(outcome).toMatchObject({
			status: "not-sent",
			error: { code: "not-configured" },
		});
		expect(reports(kit.reportError)).toEqual([
			{ code: "not-configured", message: SENTENCE },
		]);
	});

	it("retry() fails the same way without a second report", async () => {
		const { client, clock, kit, history } = unconfigured();
		client.start();
		await settle(clock);
		client.retry();
		client.retry();
		await settle(clock);
		expect(client.status.get()).toMatchObject({
			mode: "failed",
			reason: "not-configured",
		});
		expect(modes(history)).toEqual([
			"inactive",
			"starting",
			"failed",
			"starting",
			"failed",
			"starting",
			"failed",
		]);
		expect(kit.reportError).toHaveBeenCalledTimes(1);
	});

	it("require: return hints never retry a not-configured client", async () => {
		const { client, clock, kit, history } = makeClient(
			{ worker: undefined, sharing: "require" },
			{ noLocal: true },
		);
		client.start();
		await settle(clock);
		kit.fire("document", "visibilitychange");
		kit.fire("window", "online");
		clock.advance(300);
		await settle(clock);
		expect(modes(history)).toEqual(["inactive", "starting", "failed"]);
		expect(kit.reportError).toHaveBeenCalledTimes(1);
	});
});

describe("partial configuration keeps today's paths", () => {
	it("local without worker: unsupported, then local mode, nothing reported", async () => {
		const { client, clock, host, local, kit } = makeClient({
			worker: undefined,
		});
		client.start();
		await settle(clock);
		expect(client.status.get()).toMatchObject({
			mode: "local",
			reason: "unsupported",
		});
		expect(host.created).toBe(0);
		expect(local.factory).toHaveBeenCalledTimes(1);
		expect(kit.reportError).not.toHaveBeenCalled();
	});

	it("local without worker under require: unsupported/no-worker-factory, not not-configured", async () => {
		// Local mode clears `detail`, so `require` is where the detail shows.
		const { client, clock, host, local, kit } = makeClient({
			worker: undefined,
			sharing: "require",
		});
		client.start();
		await settle(clock);
		const status = client.status.get();
		expect(status).toMatchObject({
			mode: "failed",
			reason: "unsupported",
			detail: "no-worker-factory",
		});
		expect(status.error?.code).toBe("sharing-unavailable");
		expect(host.created).toBe(0);
		expect(local.factory).not.toHaveBeenCalled();
		expect(reports(kit.reportError)).not.toContainEqual(
			expect.objectContaining({ code: "not-configured" }),
		);
		// A run-time failure with a status subscriber stays unreported.
		expect(kit.reportError).not.toHaveBeenCalled();
	});

	it("worker without local under sharing off: local-runtime-unavailable, not not-configured", async () => {
		const { client, clock, kit } = makeClient(
			{ sharing: "off" },
			{ noLocal: true },
		);
		client.start();
		await settle(clock);
		expect(client.status.get()).toMatchObject({
			mode: "failed",
			reason: "local-runtime-unavailable",
		});
		// A run-time failure with a status subscriber stays unreported.
		expect(kit.reportError).not.toHaveBeenCalled();
	});

	it("worker without local attaches shared as before", async () => {
		const { client, clock, host } = makeClient({}, { noLocal: true });
		client.start();
		await settle(clock);
		expect(client.status.get().mode).toBe("shared");
		expect(host.created).toBe(1);
	});
});
