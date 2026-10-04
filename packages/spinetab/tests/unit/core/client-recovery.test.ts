import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BRIDGE_VERSION } from "../../../src/core/bridge.ts";
import { setWorkerOriginForTests } from "../../../src/core/runtime.ts";
import type {
	CredentialRequest,
	DiagnosticEvent,
} from "../../../src/core/types.ts";
import {
	disposeAll,
	feed,
	makeClient,
	modes,
	observe,
} from "./helpers/client.ts";
import { settle, tick } from "./helpers/clock.ts";

// 036, 043, 053, 056, 057, 060 on the page client.

afterEach(disposeAll);

// The harness worker runs on the endpoints' origin, so provider credentials
// stay within the credential audience; Node has no `location`.
beforeEach(() => setWorkerOriginForTests("https://api.test"));
afterEach(() => setWorkerOriginForTests(undefined));

const fast = {
	heartbeatMs: 1_000,
	probeTimeoutMs: 500,
	handshakeTimeoutMs: 1_000,
};

describe("runtime loss and re-attachment", () => {
	it("reattaches after a silent worker crash and re-registers intent exactly once", async () => {
		const harness = makeClient(fast, {
			hostLimits: { test: { command: () => new Promise(() => {}) } },
		});
		const { client, host, clock, history } = harness;
		const resume = vi.fn((state: { lastEventId?: string }) => ({
			subscription: { from: state.lastEventId },
		}));
		const repeatable = observe();
		const once = observe();
		const first = client.subscribe(feed({ topic: "a" }), repeatable.observer, {
			resume,
		});
		client.subscribe(
			feed({ topic: "b" }, { repeatable: false }),
			once.observer,
		);
		await settle(clock);
		const firstRuntime = host.runtime.id;
		host.test.all()[0]?.emit({ n: 1 }, { eventId: "e1" });
		const command = client.command({
			adapter: "test",
			connection: { url: "https://api.test/cmd" },
			payload: 1,
		});
		await settle(clock);
		host.crash();
		await tick(clock, 3_000, 100);
		expect(client.status.get()).toMatchObject({
			mode: "shared",
			health: "healthy",
			generation: 2,
		});
		expect(client.status.get().runtimeId).not.toBe(firstRuntime);
		expect(history.map((status) => status.health)).toContain("reattaching");
		expect(modes(history)).toEqual(["inactive", "starting", "shared"]);
		expect(resume).toHaveBeenCalledTimes(1);
		expect(resume.mock.calls[0]?.[0]).toMatchObject({
			lastEventId: "e1",
			lastEvent: { n: 1 },
		});
		expect(host.runtime.stats().consumers).toBe(1);
		expect(host.test.all().map((subscription) => subscription.spec)).toEqual([
			{ from: "e1" },
		]);
		expect(first.status.get().continuity).toMatchObject({
			state: "unknown",
			reason: "runtime-replaced",
		});
		expect(once.log.errors[0]?.code).toBe("interrupted");
		await expect(command).resolves.toMatchObject({
			status: "unknown",
			error: { detail: { reason: "worker-lost" } },
		});
		expect(
			host.test.connections.flatMap((connection) => connection.commands),
		).toHaveLength(0);
		host.test.last().emit({ n: 2 });
		await settle(clock);
		expect(repeatable.log.events).toEqual([{ n: 1 }, { n: 2 }]);
		expect(first.status.get().continuity.state).toBe("unknown");
	});

	it("reattaches on detached{lease-expired} without spending the re-attachment budget", async () => {
		const { client, host, clock, history } = makeClient(
			{},
			{ hostLimits: { limits: { leaseMs: 3_000 } } },
		);
		const handle = client.subscribe(feed(), observe().observer);
		await settle(clock);
		for (let round = 0; round < 8; round += 1) await tick(clock, 3_500, 250);
		expect(modes(history)).toEqual(["inactive", "starting", "shared"]);
		expect(client.status.get().generation).toBeGreaterThan(6);
		expect(handle.status.get().continuity).toMatchObject({
			state: "unknown",
			reason: "lease-expired",
		});
		expect(host.runtime.stats().consumers).toBe(1);
	});

	it("bounds crash loops: 5 re-attachments per 5 minutes, then one shared→local under prefer", async () => {
		const { client, host, clock, history, local } = makeClient(fast);
		client.subscribe(feed(), observe().observer);
		await settle(clock);
		for (let crash = 0; crash < 6; crash += 1) {
			host.crash();
			await tick(clock, 3_000, 100);
		}
		expect(client.status.get()).toMatchObject({
			mode: "local",
			reason: "runtime-unstable",
		});
		expect(modes(history)).toEqual(["inactive", "starting", "shared", "local"]);
		expect(local.factory).toHaveBeenCalledTimes(1);
		expect(host.created).toBe(6);
	});

	it("bounds crash loops under require by failing with runtime-unstable", async () => {
		const { client, host, clock } = makeClient({ ...fast, sharing: "require" });
		const { log, observer } = observe();
		client.subscribe(feed(), observer);
		await settle(clock);
		for (let crash = 0; crash < 6; crash += 1) {
			host.crash();
			await tick(clock, 3_000, 100);
		}
		expect(client.status.get()).toMatchObject({
			mode: "failed",
			reason: "runtime-unstable",
			error: { code: "sharing-unavailable" },
		});
		expect(log.errors[0]?.code).toBe("sharing-unavailable");
		const created = host.created;
		await tick(clock, 20_000, 500);
		expect(host.created).toBe(created);
	});

	it("treats a hung worker's re-attach handshake timeout as startup-timeout (prefer → local once)", async () => {
		const { client, host, clock, local } = makeClient(fast);
		const { log, observer } = observe();
		client.subscribe(feed(), observer);
		await settle(clock);
		host.hang();
		await tick(clock, 4_000, 100);
		expect(client.status.get()).toMatchObject({
			mode: "local",
			reason: "startup-timeout",
		});
		expect(host.created).toBe(2);
		host.unhang();
		await settle(clock);
		expect(host.runtime.stats().attachments).toBe(0);
		local.test.last().emit("local");
		await settle(clock);
		expect(log.events).toEqual(["local"]);
	});

	it("treats a hung worker's re-attach handshake timeout as startup-timeout (require → failed)", async () => {
		const { client, host, clock } = makeClient({ ...fast, sharing: "require" });
		client.subscribe(feed(), observe().observer);
		await settle(clock);
		host.hang();
		await tick(clock, 4_000, 100);
		expect(client.status.get()).toMatchObject({
			mode: "failed",
			reason: "startup-timeout",
		});
		expect(host.created).toBe(2);
	});

	it("re-arms the handshake once after a detected scheduling gap instead of failing", async () => {
		const { client, host, clock } = makeClient({ handshakeTimeoutMs: 1_000 });
		host.hang();
		client.start();
		await settle(clock);
		clock.jump(60_000);
		clock.advance(0);
		await settle(clock);
		expect(client.status.get().mode).toBe("starting");
		host.unhang();
		await settle(clock);
		expect(client.status.get().mode).toBe("shared");
	});

	it("reattaches after a worker error event or a changed runtime id", async () => {
		const { client, host, clock } = makeClient(fast);
		client.subscribe(feed(), observe().observer);
		await settle(clock);
		host.fireError();
		await tick(clock, 1_000, 100);
		expect(client.status.get()).toMatchObject({
			mode: "shared",
			generation: 2,
			health: "healthy",
		});
	});
});

describe("runtime announcement on the page's port (contract decision: prompt recovery when an engine re-initialises the SharedWorker)", () => {
	// Package defaults throughout (20 s heartbeat, 5 s probe): only zero-delay
	// timers run, so the heartbeat, probe and lease cannot be what recovers.

	it("a different runtime announcing itself on a welcomed port retires the attachment and reattaches at once, re-registering intent once", async () => {
		const diagnostics: DiagnosticEvent[] = [];
		const { client, host, clock, history } = makeClient({
			diagnostics: (event) => diagnostics.push(event),
		});
		const resume = vi.fn(() => undefined);
		const repeatable = observe();
		const once = observe();
		const handle = client.subscribe(feed({ topic: "a" }), repeatable.observer, {
			resume,
		});
		client.subscribe(
			feed({ topic: "b" }, { repeatable: false }),
			once.observer,
		);
		await settle(clock);
		const before = client.status.get();
		expect(before).toMatchObject({
			mode: "shared",
			health: "healthy",
			generation: 1,
		});
		host.test.all()[0]?.emit({ n: 1 });
		await settle(clock);
		const startedAt = clock.now();

		host.reinit();
		await settle(clock);

		expect(clock.now()).toBe(startedAt);
		expect(client.status.get()).toMatchObject({
			mode: "shared",
			health: "healthy",
			generation: 2,
			runtimeId: host.runtime.id,
		});
		expect(client.status.get().runtimeId).not.toBe(before.runtimeId);
		expect(history.map((status) => status.health)).toContain("reattaching");
		// Through the existing factory, exactly once.
		expect(host.created).toBe(2);
		expect(resume).toHaveBeenCalledTimes(1);
		expect(host.runtime.stats()).toMatchObject({
			attachments: 1,
			consumers: 1,
		});
		expect(host.test.all()).toHaveLength(1);
		expect(handle.status.get().continuity).toMatchObject({
			state: "unknown",
			reason: "runtime-replaced",
		});
		// A non-repeatable request is never restarted: one honest interruption.
		expect(once.log.errors.map((error) => error.code)).toEqual(["interrupted"]);
		expect(diagnostics).toContainEqual(
			expect.objectContaining({
				type: "runtime-lost",
				detail: { reason: "runtime-announced" },
			}),
		);
		host.test.last().emit({ n: 2 });
		await settle(clock);
		expect(repeatable.log.events).toEqual([{ n: 1 }, { n: 2 }]);
		expect(handle.status.get().continuity.state).toBe("unknown");
	});

	it("ignores an announcement from the runtime that welcomed the attachment", async () => {
		const { client, host, clock } = makeClient();
		const { log, observer } = observe();
		const handle = client.subscribe(feed(), observer);
		await settle(clock);
		host.lastRelay().host.postMessage({
			v: BRIDGE_VERSION,
			t: "announce",
			runtime: host.runtime.id,
			generation: 9,
		});
		await settle(clock);
		expect(client.status.get()).toMatchObject({
			mode: "shared",
			health: "healthy",
			generation: 1,
			runtimeId: host.runtime.id,
		});
		expect(host.created).toBe(1);
		expect(host.runtime.stats()).toMatchObject({
			attachments: 1,
			consumers: 1,
		});
		expect(handle.status.get().continuity.state).toBe("continuous");
		host.test.last().emit("still-served");
		await settle(clock);
		expect(log.events).toEqual(["still-served"]);
	});

	it("repeated announcements spend the re-attachment budget; prefer then falls back to local once", async () => {
		const { client, host, clock, history, local } = makeClient();
		client.subscribe(feed(), observe().observer);
		await settle(clock);
		for (let round = 0; round < 6; round += 1) {
			host.reinit();
			await settle(clock);
		}
		expect(client.status.get()).toMatchObject({
			mode: "local",
			reason: "runtime-unstable",
		});
		expect(modes(history)).toEqual(["inactive", "starting", "shared", "local"]);
		// The initial attachment plus five immediate re-attachments, then policy.
		expect(host.created).toBe(6);
		expect(local.factory).toHaveBeenCalledTimes(1);
		host.reinit();
		await settle(clock);
		expect(host.created).toBe(6);
	});

	it("repeated announcements under require end in failed/runtime-unstable with no further constructions", async () => {
		const { client, host, clock } = makeClient({ sharing: "require" });
		const { log, observer } = observe();
		client.subscribe(feed(), observer);
		await settle(clock);
		for (let round = 0; round < 6; round += 1) {
			host.reinit();
			await settle(clock);
		}
		expect(client.status.get()).toMatchObject({
			mode: "failed",
			reason: "runtime-unstable",
			error: { code: "sharing-unavailable" },
		});
		expect(log.errors.at(-1)?.code).toBe("sharing-unavailable");
		const created = host.created;
		host.reinit();
		await tick(clock, 30_000, 1_000);
		expect(host.created).toBe(created);
	});

	it("a replacement during the handshake re-posts the hello on the same port instead of timing out", async () => {
		const { client, host, clock } = makeClient();
		client.start();
		const relay = host.lastRelay();
		// The first instance never sees the hello (it is re-initialised).
		relay.drop = (data, toRuntime) =>
			toRuntime && (data as { t?: string }).t === "hello";
		await settle(clock);
		expect(client.status.get().mode).toBe("starting");
		relay.drop = undefined;
		host.reinit();
		await settle(clock);
		expect(client.status.get()).toMatchObject({
			mode: "shared",
			generation: 1,
			runtimeId: host.runtime.id,
		});
		expect(host.created).toBe(1);
	});

	it("ignores a well-formed v1 message of an unknown type before welcome (additive types never fail a handshake)", async () => {
		const { client, host, clock } = makeClient({ sharing: "require" });
		client.start();
		host.lastRelay().host.postMessage({
			v: BRIDGE_VERSION,
			t: "future-message",
			a: "anything",
			g: 1,
		});
		await settle(clock);
		expect(client.status.get()).toMatchObject({
			mode: "shared",
			health: "healthy",
		});
	});
});

describe("multi-tab recovery", () => {
	it("N pages reattaching after a crash produce one upstream operation, not one per page", async () => {
		const first = makeClient(fast);
		const second = makeClient(fast, { host: first.host, clock: first.clock });
		const third = makeClient(fast, { host: first.host, clock: first.clock });
		for (const harness of [first, second, third])
			harness.client.subscribe(feed({ topic: "shared" }), observe().observer);
		await settle(first.clock);
		expect(first.host.test.all()).toHaveLength(1);
		first.host.crash();
		await tick(first.clock, 3_000, 100);
		for (const harness of [first, second, third]) {
			expect(harness.client.status.get()).toMatchObject({
				mode: "shared",
				health: "healthy",
			});
		}
		expect(first.host.test.connections).toHaveLength(1);
		expect(first.host.test.all()).toHaveLength(1);
		expect(first.host.test.last().consumers.size).toBe(3);
	});

	it("one page reattaching does not restart upstream work serving another page", async () => {
		const first = makeClient(fast);
		const second = makeClient(fast, { host: first.host, clock: first.clock });
		const kept = observe();
		first.client.subscribe(feed({ topic: "shared" }), observe().observer);
		second.client.subscribe(feed({ topic: "shared" }), kept.observer);
		await settle(first.clock);
		const upstream = first.host.test.last();
		// Only the first page's relay dies (its port goes silent).
		const relay = first.host.relays[0];
		if (relay) relay.dead = true;
		await tick(first.clock, 3_000, 100);
		expect(first.client.status.get()).toMatchObject({
			generation: 2,
			health: "healthy",
		});
		expect(first.host.test.all()).toHaveLength(1);
		expect(first.host.test.connections).toHaveLength(1);
		expect(upstream.unsubscribed).toBe(false);
		upstream.emit("after");
		await settle(first.clock);
		expect(kept.log.events).toEqual(["after"]);
		expect(second.client.status.get().generation).toBe(1);
	});
});

describe("scope change", () => {
	it("retires the attachment so queued old-scope events, replies and commands never reach the new scope", async () => {
		const provider = vi.fn(
			(request: CredentialRequest) =>
				new Promise<Record<string, unknown>>((resolve) => {
					request.signal.addEventListener("abort", () =>
						resolve({ token: `late-${request.scope}` }),
					);
				}),
		);
		const { client, host, clock } = makeClient(
			{ ...fast, scope: "alice", credentials: provider },
			{ hostLimits: { test: { command: () => new Promise(() => {}) } } },
		);
		const { log, observer } = observe();
		const handle = client.subscribe(feed(), observer);
		await settle(clock);
		const oldRelay = host.lastRelay();
		const posted = client.command({
			adapter: "test",
			connection: { url: "https://api.test/cmd" },
			payload: 1,
		});
		await settle(clock);
		const aliceCtx = host.test.connections[0]?.ctx;
		const aliceCredentials = aliceCtx
			?.credentials("connect")
			.catch((error: unknown) => error);
		await settle(clock);
		expect(provider).toHaveBeenCalledTimes(1);
		oldRelay.hold = true;
		host.test.last().emit({ scope: "alice", n: 1 });
		host.test.last().emit({ scope: "alice", n: 2 });
		await settle(clock);
		client.setScope("bob");
		host.release(oldRelay);
		await settle(clock);
		expect(log.events).toEqual([]);
		await expect(posted).resolves.toMatchObject({
			status: "unknown",
			error: { detail: { reason: "scope-changed" } },
		});
		expect(await aliceCredentials).toMatchObject({
			code: "no-credential-source",
		});
		expect(client.status.get()).toMatchObject({
			mode: "shared",
			generation: 2,
		});
		expect(handle.status.get().continuity).toMatchObject({
			state: "unknown",
			reason: "scope-changed",
		});
		expect(
			host.runtime.stats().perAttachment.map((entry) => entry.scope),
		).toEqual(["bob"]);
		// The aborted provider's late result was never posted as a reply.
		expect(host.runtime.stats().staleMessages).toBe(0);
		const bobSubscription = host.test
			.all()
			.find((subscription) => !subscription.unsubscribed);
		bobSubscription?.emit({ scope: "bob", n: 1 });
		await settle(clock);
		expect(log.events).toEqual([{ scope: "bob", n: 1 }]);
		expect(
			host.test.connections.find(
				(connection) => connection.ctx.scope === "alice",
			)?.disposed,
		).toBe(true);
	});

	it("settles commands held for the old scope as not-sent/scope-changed", async () => {
		const { client, host, clock } = makeClient(
			{ scope: "alice" },
			{ hostLimits: { test: { command: async () => ({ status: "sent" }) } } },
		);
		host.hang();
		const held = client.command({
			adapter: "test",
			connection: { url: "https://api.test/cmd" },
			payload: 1,
		});
		await settle(clock);
		client.setScope("bob");
		host.unhang();
		await settle(clock);
		await expect(held).resolves.toMatchObject({
			status: "not-sent",
			error: { code: "scope-changed" },
		});
		expect(
			host.test.connections.flatMap((connection) => connection.commands),
		).toHaveLength(0);
	});

	it("treats a change back to the same scope string as a new attachment (A → B → A)", async () => {
		const { client, host, clock } = makeClient({ ...fast, scope: "a" });
		const { log, observer } = observe();
		client.subscribe(feed(), observer);
		await settle(clock);
		const relays = [host.lastRelay()];
		host.lastRelay().hold = true;
		host.test.last().emit("a-old");
		await settle(clock);
		client.setScope("b");
		await settle(clock);
		relays.push(host.lastRelay());
		host.lastRelay().hold = true;
		host.test.last().emit("b-old");
		await settle(clock);
		client.setScope("a");
		await settle(clock);
		for (const relay of relays) host.release(relay);
		await settle(clock);
		expect(client.status.get().generation).toBe(3);
		expect(log.events).toEqual([]);
		const live = host.test
			.all()
			.filter((subscription) => !subscription.unsubscribed);
		expect(live).toHaveLength(1);
		live[0]?.emit("a-new");
		await settle(clock);
		expect(log.events).toEqual(["a-new"]);
		expect(host.runtime.stats().attachments).toBe(1);
	});

	it("ends subscriptions pinned to the old scope and ignores a no-op scope change", async () => {
		const { client, clock } = makeClient({ scope: "a" });
		const pinned = observe();
		client.subscribe(feed({}, { scope: "a" }), pinned.observer);
		await settle(clock);
		const generation = client.status.get().generation;
		client.setScope("a");
		expect(client.status.get().generation).toBe(generation);
		client.setScope("b");
		await settle(clock);
		expect(pinned.log.errors[0]?.code).toBe("scope-changed");
	});

	it("reports scope-changed over a prior gap on every change (A → B → A), then stays sticky", async () => {
		// The continuity ranking
		// used to suppress the notification after a gap, so integrations kept
		// old-session queues across a rapid change back to the same scope.
		const { client, host, clock } = makeClient({ ...fast, scope: "a" });
		const { log, observer } = observe();
		const handle = client.subscribe(feed(), observer);
		const pinned = observe();
		client.subscribe(feed({ pinned: true }, { scope: "a" }), pinned.observer);
		await settle(clock);
		const upstream = () =>
			host.test
				.all()
				.find(
					(entry) => !entry.unsubscribed && JSON.stringify(entry.spec) === "{}",
				);
		upstream()?.sink.continuity("decode-error");
		await settle(clock);
		expect(handle.status.get().continuity).toMatchObject({
			state: "gap",
			reason: "decode-error",
		});
		// An adapter cannot use the reason to downgrade a sticky gap.
		upstream()?.sink.continuity("scope-changed");
		await settle(clock);
		expect(handle.status.get().continuity.state).toBe("gap");
		client.setScope("b");
		client.setScope("a");
		expect(
			log.statuses.filter(
				(status) =>
					status.continuity.state === "unknown" &&
					status.continuity.reason === "scope-changed",
			),
		).toHaveLength(2);
		expect(pinned.log.errors.map((error) => error.code)).toEqual([
			"scope-changed",
		]);
		await settle(clock);
		expect(client.status.get().generation).toBe(3);
		upstream()?.emit("a-new");
		await settle(clock);
		expect(log.events).toEqual(["a-new"]);
		expect(handle.status.get().continuity).toMatchObject({
			state: "unknown",
			reason: "scope-changed",
		});
		upstream()?.sink.continuity("decode-error");
		await settle(clock);
		expect(handle.status.get().continuity.reason).toBe("decode-error");
		handle.markReconciled();
		expect(handle.status.get().continuity).toMatchObject({
			state: "continuous",
			reason: "reconciled",
		});
	});
});

describe("lifecycle, hints and health", () => {
	it("detaches on pagehide (intent kept) and reattaches on pageshow", async () => {
		const { client, host, clock, kit } = makeClient(fast);
		const handle = client.subscribe(feed(), observe().observer);
		await settle(clock);
		kit.fire("window", "pagehide", { persisted: true });
		await settle(clock);
		expect(host.runtime.stats().consumers).toBe(0);
		expect(handle.status.get().continuity.state).toBe("unknown");
		kit.fire("window", "pageshow", { persisted: true });
		await tick(clock, 500, 50);
		expect(host.runtime.stats().consumers).toBe(1);
		expect(client.status.get()).toMatchObject({
			health: "healthy",
			generation: 2,
		});
	});

	it("forwards visibility to the runtime for eligibility", async () => {
		const { client, host, clock, kit } = makeClient();
		client.subscribe(feed(), observe().observer);
		await settle(clock);
		kit.setVisible(false);
		kit.fire("document", "visibilitychange");
		await settle(clock);
		expect([...host.test.last().consumers.values()][0]?.visible).toBe(false);
	});

	it("coalesces lifecycle hints into one health check and spaces upstream checks per connection", async () => {
		const { client, host, clock, kit } = makeClient();
		client.subscribe(feed(), observe().observer);
		await settle(clock);
		for (const [target, type] of [
			["document", "visibilitychange"],
			["window", "online"],
			["document", "resume"],
			["window", "online"],
		] as const) {
			kit.fire(target, type, { persisted: true });
		}
		kit.fire("window", "pageshow", { persisted: true });
		await tick(clock, 300, 50);
		expect(host.test.connections[0]?.probes).toBe(1);
		kit.fire("window", "online");
		await tick(clock, 300, 50);
		expect(host.test.connections[0]?.probes).toBe(1);
		await tick(clock, 5_000, 250);
		kit.fire("window", "online");
		await tick(clock, 300, 50);
		expect(host.test.connections[0]?.probes).toBe(2);
	});

	it("detects a long scheduling gap from a late heartbeat and runs a coalesced check", async () => {
		const { client, host, clock } = makeClient({ heartbeatMs: 1_000 });
		client.subscribe(feed(), observe().observer);
		await settle(clock);
		clock.jump(120_000);
		await tick(clock, 600, 50);
		expect(host.test.connections[0]?.probes).toBe(1);
		expect(client.status.get()).toMatchObject({
			mode: "shared",
			health: "healthy",
			generation: 1,
		});
	});

	it("coalesces concurrent checkHealth calls into one probe", async () => {
		const { client, host, clock } = makeClient();
		client.start();
		await settle(clock);
		const [first, second] = [client.checkHealth(), client.checkHealth()];
		await settle(clock);
		expect(await first).toMatchObject({ health: "healthy" });
		expect(await second).toBe(await first);
		expect(host.test.connections).toHaveLength(0);
	});

	it("explicit retry() reaches blocked connections once; rotation posts the new revision", async () => {
		// Only a page with a provider moves a scope's revision.
		const { client, host, clock } = makeClient({
			credentialRevision: 1,
			credentials: () => ({}),
		});
		client.subscribe(feed(), observe().observer);
		await settle(clock);
		const connection = host.test.connections[0];
		connection?.ctx.setStatus({
			state: "retry-exhausted",
			reason: "attempts-exhausted",
		});
		await settle(clock);
		client.retry();
		client.retry();
		await settle(clock);
		expect(connection?.retries).toBe(1);
		client.setCredentialRevision(2, { restart: true });
		await settle(clock);
		expect(connection?.rotations).toBe(1);
	});
});

describe("credentials provider (page side)", () => {
	it("answers runtime requests with the provider result and the current revision", async () => {
		const provider = vi.fn(async (_request: CredentialRequest) => ({
			headers: { authorization: "Bearer t" },
		}));
		const { client, host, clock } = makeClient({
			scope: "s",
			credentialRevision: 7,
			credentials: provider,
		});
		client.subscribe(feed(), observe().observer);
		await settle(clock);
		const result = host.test.connections[0]?.ctx.credentials("connect");
		await settle(clock);
		await expect(result).resolves.toEqual({
			headers: { authorization: "Bearer t" },
		});
		expect(provider.mock.calls[0]?.[0]).toMatchObject({
			scope: "s",
			revision: 7,
			reason: "connect",
		});
	});

	it("reports a failing provider as credentials-failed and aborts a hanging one at the timeout", async () => {
		let aborted = false;
		const { client, host, clock } = makeClient({
			credentials: (request: CredentialRequest) =>
				new Promise((_resolve, reject) => {
					request.signal.addEventListener("abort", () => {
						aborted = true;
						reject(new Error("aborted"));
					});
				}),
		});
		client.subscribe(feed(), observe().observer);
		await settle(clock);
		const result = host.test.connections[0]?.ctx.credentials("connect");
		let error: unknown;
		result?.catch((caught: unknown) => {
			error = caught;
		});
		await tick(clock, 5_200, 100);
		expect(aborted).toBe(true);
		expect(error).toMatchObject({ code: "credentials-timeout" });
		const throwing = makeClient({
			credentials: () => {
				throw new Error("no session");
			},
		});
		throwing.client.subscribe(feed(), observe().observer);
		await settle(throwing.clock);
		const second = throwing.host.test.connections[0]?.ctx
			.credentials("connect")
			.catch((caught: unknown) => caught);
		await settle(throwing.clock);
		expect(await second).toMatchObject({
			code: "credentials-failed",
			message:
				"No page in this scope supplied credentials: its credentials provider failed.",
		});
	});

	it("reports a provider that returns no credentials object as credentials-failed", async () => {
		const { client, host, clock } = makeClient({
			credentials: () => null as never,
		});
		client.subscribe(feed(), observe().observer);
		await settle(clock);
		const result = host.test.connections[0]?.ctx
			.credentials("connect")
			.catch((caught: unknown) => caught);
		await settle(clock);
		expect(await result).toMatchObject({ code: "credentials-failed" });
	});

	it("keeps no-credential-source for a page without a provider", async () => {
		const { client, host, clock } = makeClient();
		client.subscribe(feed(), observe().observer);
		await settle(clock);
		const result = host.test.connections[0]?.ctx
			.credentials("connect")
			.catch((caught: unknown) => caught);
		await settle(clock);
		expect(await result).toMatchObject({ code: "no-credential-source" });
	});

	it("a rotation while the provider is pending is answered for the new revision", async () => {
		const answers: Array<(value: unknown) => void> = [];
		const provider = vi.fn(
			(_request: CredentialRequest) =>
				new Promise((resolve) => {
					answers.push(resolve);
				}),
		);
		const { client, host, clock } = makeClient({
			credentialRevision: 1,
			credentials: provider as never,
		});
		client.subscribe(feed(), observe().observer);
		await settle(clock);
		const result = host.test.connections[0]?.ctx.credentials("connect");
		await settle(clock);
		expect(provider).toHaveBeenCalledTimes(1);
		expect(provider.mock.calls[0]?.[0]).toMatchObject({ revision: 1 });
		client.setCredentialRevision(2);
		await settle(clock);
		// Minted for revision 1: the reply says so, and the runtime asks again
		// instead of caching it as revision 2.
		answers[0]?.({ headers: { authorization: "Bearer r1" } });
		await settle(clock);
		expect(provider).toHaveBeenCalledTimes(2);
		expect(provider.mock.calls[1]?.[0]).toMatchObject({ revision: 2 });
		answers[1]?.({ headers: { authorization: "Bearer r2" } });
		await settle(clock);
		await expect(result).resolves.toEqual({
			headers: { authorization: "Bearer r2" },
		});
	});
});
