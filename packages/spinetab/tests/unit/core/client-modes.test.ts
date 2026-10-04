import { afterEach, describe, expect, it } from "vitest";
import { createSpinetab, SERVER_STATUS } from "../../../src/core/client.ts";
import { isSpinetabError } from "../../../src/core/errors.ts";
import {
	disposeAll,
	feed,
	makeClient,
	modes,
	observe,
} from "./helpers/client.ts";
import { settle, tick } from "./helpers/clock.ts";

afterEach(disposeAll);

describe("construction and server rendering", () => {
	it("creates an inert client: no factory calls, listeners or timers until start", () => {
		const { client, host, kit, clock, local } = makeClient();
		expect(client.status.get()).toEqual({
			mode: "inactive",
			health: "unknown",
			generation: 0,
		});
		expect(host.created).toBe(0);
		expect(local.factory).not.toHaveBeenCalled();
		expect(kit.listenerCount()).toBe(0);
		expect(clock.pending()).toBe(0);
		expect(client.status.get()).toBe(client.status.get());
	});

	it("returns the referentially constant server status and inert handles outside a browser", async () => {
		const { client, host, clock } = makeClient(
			{},
			{ env: { isBrowser: () => false } },
		);
		expect(client.status.get()).toBe(SERVER_STATUS);
		client.start();
		const handle = client.subscribe(feed(), observe().observer);
		expect(handle.status.get().active).toBe(false);
		handle.unsubscribe();
		await expect(
			client.command({ adapter: "test", connection: {}, payload: 1 }),
		).resolves.toMatchObject({
			status: "not-sent",
			error: { code: "runtime-unavailable" },
		});
		await settle(clock);
		expect(host.created).toBe(0);
		expect(client.status.get()).toBe(SERVER_STATUS);
		expect(createSpinetab({}).status.get()).toBe(SERVER_STATUS);
		const page = await import("../../../src/index.ts");
		const constants = await import("../../../src/core/status.ts");
		expect(page.SERVER_STATUS).toBe(constants.SERVER_STATUS);
		expect(Object.isFrozen(page.SERVER_STATUS)).toBe(true);
		expect(makeClient().client.status.get()).toBe(constants.INACTIVE_STATUS);
	});

	it("rejects unknown and invalid options with a path", () => {
		const cases: Array<[Record<string, unknown>, string]> = [
			[{ bogus: 1 }, "unsupported-option"],
			[{ sharing: "maybe" }, "unsupported-option"],
			[
				{ limits: { maxPendingBytes: Number.POSITIVE_INFINITY } },
				"unsupported-option",
			],
			[{ limits: { maxPendingMessages: 0 } }, "unsupported-option"],
			[{ heartbeatMs: 1_000, leaseMs: 1_500 }, "unsupported-option"],
			[{ worker: "not-a-function" }, "unsupported-option"],
			[{ baseUrl: "not a url" }, "invalid-endpoint"],
			[{ credentialRevision: Number.NaN }, "unsupported-option"],
		];
		for (const [options, code] of cases) {
			let caught: unknown;
			try {
				createSpinetab(options as never);
			} catch (error) {
				caught = error;
			}
			expect(
				isSpinetabError(caught, code as never),
				JSON.stringify(options),
			).toBe(true);
		}
	});
});

describe("mode selection", () => {
	it("prefer: attaches shared after a versioned handshake and never loads local", async () => {
		const { client, host, clock, local, history } = makeClient();
		client.start();
		client.start();
		expect(client.status.get().mode).toBe("starting");
		await settle(clock);
		expect(client.status.get()).toMatchObject({
			mode: "shared",
			health: "healthy",
			runtimeId: host.runtime.id,
			generation: 1,
		});
		expect(host.created).toBe(1);
		expect(local.factory).not.toHaveBeenCalled();
		expect(modes(history)).toEqual(["inactive", "starting", "shared"]);
	});

	it("the first browser subscribe starts the client lazily", async () => {
		const { client, host, clock } = makeClient();
		client.subscribe(feed(), observe().observer);
		await settle(clock);
		expect(host.created).toBe(1);
		expect(client.status.get().mode).toBe("shared");
		expect(host.test.last().consumers.size).toBe(1);
	});

	it("off: runs locally over a MessageChannel without calling the worker factory", async () => {
		const { client, host, clock, local } = makeClient({ sharing: "off" });
		const { log, observer } = observe();
		client.subscribe(feed(), observer);
		await settle(clock);
		expect(host.created).toBe(0);
		expect(local.factory).toHaveBeenCalledTimes(1);
		expect(client.status.get()).toMatchObject({
			mode: "local",
			reason: "sharing-off",
			health: "healthy",
		});
		local.test.last().emit({ n: 1 });
		await settle(clock);
		expect(log.events).toEqual([{ n: 1 }]);
	});

	const fallbackCases = [
		["unsupported", (h: ReturnType<typeof makeClient>) => h] as const,
		[
			"worker-construct-failed",
			(h: ReturnType<typeof makeClient>) => {
				h.host.mode = "construct-throws";
				return h;
			},
		] as const,
		[
			"worker-error",
			(h: ReturnType<typeof makeClient>) => {
				h.host.mode = "error-event";
				return h;
			},
		] as const,
		[
			"worker-startup-error",
			(h: ReturnType<typeof makeClient>) => {
				h.host.mode = "startup-error";
				return h;
			},
		] as const,
		[
			"startup-timeout",
			(h: ReturnType<typeof makeClient>) => {
				h.host.mode = "hung";
				return h;
			},
		] as const,
		[
			"incompatible-version",
			(h: ReturnType<typeof makeClient>) => {
				h.host.mode = "v0";
				return h;
			},
		] as const,
		[
			"handshake-invalid",
			(h: ReturnType<typeof makeClient>) => {
				h.host.mode = "garbage";
				return h;
			},
		] as const,
	];

	for (const [reason, arrange] of fallbackCases) {
		it(`prefer: falls back to local once on ${reason}`, async () => {
			const harness = arrange(
				makeClient(
					{},
					reason === "unsupported"
						? { env: { hasSharedWorker: () => false } }
						: {},
				),
			);
			const { client, clock, local, history } = harness;
			const { log, observer } = observe();
			client.subscribe(feed(), observer);
			await settle(clock);
			clock.advance(5_000);
			await settle(clock);
			expect(client.status.get()).toMatchObject({ mode: "local", reason });
			expect(local.factory).toHaveBeenCalledTimes(1);
			expect(modes(history)).toEqual(["inactive", "starting", "local"]);
			local.test.last().emit("from-local");
			await settle(clock);
			expect(log.events).toEqual(["from-local"]);
		});

		it(`require: fails with sharing-unavailable on ${reason} and never loads local`, async () => {
			const harness = arrange(
				makeClient(
					{ sharing: "require" },
					reason === "unsupported"
						? { env: { hasSharedWorker: () => false } }
						: {},
				),
			);
			const { client, clock, local } = harness;
			const { log, observer } = observe();
			client.subscribe(feed(), observer);
			await settle(clock);
			clock.advance(5_000);
			await settle(clock);
			expect(client.status.get()).toMatchObject({
				mode: "failed",
				reason,
				health: "unreachable",
				error: { code: "sharing-unavailable" },
			});
			expect(local.factory).not.toHaveBeenCalled();
			expect(log.errors).toEqual([
				expect.objectContaining({ code: "sharing-unavailable" }),
			]);
			await expect(
				client.command({ adapter: "test", connection: {}, payload: 1 }),
			).resolves.toMatchObject({
				status: "not-sent",
				error: { code: "sharing-unavailable" },
			});
		});
	}

	it("prefer without a local factory ends failed/local-runtime-unavailable", async () => {
		const { client, clock } = makeClient(
			{},
			{ noLocal: true, env: { hasSharedWorker: () => false } },
		);
		client.start();
		await settle(clock);
		expect(client.status.get()).toMatchObject({
			mode: "failed",
			reason: "local-runtime-unavailable",
			detail: "unsupported",
		});
	});

	it("a failed local chunk load fails without a reload loop; retry() imports again", async () => {
		const harness = makeClient({ sharing: "off" }, { localFails: true });
		harness.client.start();
		await settle(harness.clock);
		expect(harness.client.status.get()).toMatchObject({
			mode: "failed",
			reason: "local-runtime-load-failed",
		});
		expect(harness.local.factory).toHaveBeenCalledTimes(1);
		harness.clock.advance(60_000);
		await settle(harness.clock);
		expect(harness.local.factory).toHaveBeenCalledTimes(1);
		harness.client.retry();
		await settle(harness.clock);
		expect(harness.local.factory).toHaveBeenCalledTimes(2);
	});

	it("retires a timed-out attempt before activating local; a late welcome never makes it shared", async () => {
		const { client, host, clock } = makeClient();
		host.mode = "hung";
		const { log, observer } = observe();
		client.subscribe(feed(), observer);
		await settle(clock);
		clock.advance(5_000);
		await settle(clock);
		expect(client.status.get().mode).toBe("local");
		host.unhang();
		await settle(clock);
		// The old runtime processed hello then detach: nothing remains attached.
		expect(host.runtime.stats().attachments).toBe(0);
		expect(client.status.get().mode).toBe("local");
		expect(host.test.all()).toHaveLength(0);
		expect(log.errors).toEqual([]);
	});

	it("never changes mode for upstream, auth, overflow or command failures", async () => {
		const { client, host, clock, local, history } = makeClient({
			limits: { maxPendingMessagesPerConsumer: 1, maxPendingMessages: 1 },
		});
		const { log, observer } = observe();
		client.subscribe(feed(), observer);
		await settle(clock);
		const ctx = host.test.connections[0]?.ctx;
		ctx?.setStatus({ state: "auth-blocked", reason: "credentials-rejected" });
		ctx?.setStatus({ state: "failed", reason: "protocol-error", code: 4400 });
		host.test.last().emit({ fn() {} });
		await settle(clock);
		const outcome = await client.command({
			adapter: "test",
			connection: { url: "https://api.test/feed" },
			payload: 1,
		});
		expect(outcome.status).toBe("not-sent");
		expect(modes(history)).toEqual(["inactive", "starting", "shared"]);
		expect(client.status.get().health).toBe("healthy");
		expect(local.factory).not.toHaveBeenCalled();
		expect(log.statuses.at(-1)?.connection.state).toBe("failed");
	});

	it("does not oscillate: after fallback, hints and a recovered worker never return to shared", async () => {
		const { client, host, clock, kit, history } = makeClient();
		host.mode = "v0";
		client.start();
		await settle(clock);
		host.mode = "running";
		for (let round = 0; round < 3; round += 1) {
			kit.fire("document", "visibilitychange");
			kit.fire("window", "online");
			await tick(clock, 20_000, 250);
		}
		expect(modes(history)).toEqual(["inactive", "starting", "local"]);
		expect(host.created).toBe(1);
	});

	it("retry() from failed runs one attach attempt; require also retries once per coalesced return hint", async () => {
		const { client, host, clock, kit } = makeClient({ sharing: "require" });
		host.mode = "v0";
		client.start();
		await settle(clock);
		expect(client.status.get().mode).toBe("failed");
		host.mode = "running";
		kit.fire("document", "visibilitychange");
		kit.fire("window", "online");
		clock.advance(300);
		await settle(clock);
		expect(host.created).toBe(2);
		expect(client.status.get().mode).toBe("shared");
		const second = makeClient(
			{ sharing: "require" },
			{ env: { hasSharedWorker: () => false } },
		);
		second.client.start();
		await settle(second.clock);
		second.kit.fire("window", "online");
		second.clock.advance(300);
		await settle(second.clock);
		expect(second.client.status.get()).toMatchObject({
			mode: "failed",
			reason: "unsupported",
		});
		expect(second.host.created).toBe(0);
	});
});
