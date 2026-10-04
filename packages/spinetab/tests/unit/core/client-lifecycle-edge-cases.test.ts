import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClientWithEnv } from "../../../src/core/client.ts";
import {
	createRuntime,
	setWorkerOriginForTests,
} from "../../../src/core/runtime.ts";
import type {
	ClientStatus,
	CommandOutcome,
	SpinetabOptions,
	Subscription,
	SubscriptionStatus,
} from "../../../src/core/types.ts";
import { disposeAll, feed, makeClient, observe } from "./helpers/client.ts";
import { ManualClock, settle, tick } from "./helpers/clock.ts";
import { createTestEnv } from "./helpers/env.ts";
import { createTestAdapter } from "./helpers/test-adapter.ts";
import type { FakeWorkerHost } from "./helpers/worker.ts";

// Regression coverage for attachment loss and recovery.

afterEach(disposeAll);
beforeEach(() => setWorkerOriginForTests("https://api.test"));
afterEach(() => setWorkerOriginForTests(undefined));

const fast = {
	heartbeatMs: 1_000,
	probeTimeoutMs: 1_000,
	handshakeTimeoutMs: 1_000,
};

const withCommands = {
	hostLimits: {
		test: {
			command: async (): Promise<CommandOutcome> => ({
				status: "acknowledged",
				value: 1,
			}),
		},
	},
};

const onTopic = (host: FakeWorkerHost, topic: string) =>
	host.test.all().filter((s) => (s.spec as { topic?: string }).topic === topic);

describe("a subscribe from a client.status listener registers once", () => {
	async function subscribeOnShared() {
		const harness = makeClient();
		const { log, observer } = observe();
		let handle: Subscription<unknown> | undefined;
		harness.client.status.subscribe((status) => {
			if (status.mode === "shared" && !handle) {
				handle = harness.client.subscribe(feed({ topic: "t" }), observer);
			}
		});
		harness.client.start();
		await settle(harness.clock);
		return { ...harness, log, handle };
	}

	it("a subscribe from a status listener on the shared transition registers exactly one runtime consumer", async () => {
		const { host, clock, log, handle } = await subscribeOnShared();
		expect(handle).toBeDefined();
		expect(host.runtime.stats().consumers).toBe(1);
		const upstream = onTopic(host, "t");
		expect(upstream).toHaveLength(1);
		expect(upstream[0]?.consumers.size).toBe(1);
		upstream[0]?.emit(1);
		upstream[0]?.emit(2);
		await settle(clock);
		expect(log.events).toEqual([1, 2]);
	});

	it("unsubscribe releases it and the upstream subscription", async () => {
		const { host, clock, handle } = await subscribeOnShared();
		const upstream = onTopic(host, "t");
		handle?.unsubscribe();
		await settle(clock);
		await settle(clock);
		expect(host.runtime.stats().consumers).toBe(0);
		expect(upstream.map((s) => s.unsubscribed)).toEqual([true]);
	});

	it("a subscribe from a status listener when health returns to healthy registers once", async () => {
		const { client, host, clock } = makeClient(fast);
		client.start();
		await settle(clock);
		let handle: Subscription<unknown> | undefined;
		client.status.subscribe((status) => {
			if (status.health === "healthy" && !handle) {
				handle = client.subscribe(feed({ topic: "h" }), () => {});
			}
		});
		host.fireError();
		await tick(clock, 1_500, 50);
		expect(client.status.get()).toMatchObject({
			mode: "shared",
			health: "healthy",
			generation: 2,
		});
		expect(handle).toBeDefined();
		expect(host.runtime.stats().consumers).toBe(1);
		handle?.unsubscribe();
		await settle(clock);
		await settle(clock);
		expect(host.runtime.stats().consumers).toBe(0);
	});
});

describe("repeatable: false is honoured on re-registration before the first status", () => {
	const dropStatus = (host: FakeWorkerHost) => {
		host.lastRelay().drop = (data, toRuntime) =>
			!toRuntime && (data as { t?: string })?.t === "status";
	};

	it("control: status delivered before the loss ends interrupted after one upstream run", async () => {
		const { client, host, clock } = makeClient(fast);
		client.start();
		await settle(clock);
		const once = observe();
		client.subscribe(
			feed({ topic: "once" }, { repeatable: false }),
			once.observer,
		);
		await settle(clock);
		host.fireError();
		await tick(clock, 1_500, 50);
		expect(once.log.errors.map((e) => e.code)).toEqual(["interrupted"]);
		expect(onTopic(host, "once")).toHaveLength(1);
	});

	it("lost before its first status (worker error): interrupted, one upstream run", async () => {
		const { client, host, clock } = makeClient(fast);
		client.start();
		await settle(clock);
		dropStatus(host);
		const once = observe();
		const handle = client.subscribe(
			feed({ topic: "once" }, { repeatable: false }),
			once.observer,
		);
		await settle(clock);
		expect(onTopic(host, "once")).toHaveLength(1);
		host.fireError();
		await tick(clock, 1_500, 50);
		expect(client.status.get().generation).toBe(2);
		expect(once.log.errors.map((e) => e.code)).toEqual(["interrupted"]);
		expect(onTopic(host, "once")).toHaveLength(1);
		expect(handle.status.get().active).toBe(false);
	});

	it("subscribed, then pagehide in the same task, then pageshow: interrupted, one upstream run", async () => {
		const { client, clock, host, kit } = makeClient();
		client.start();
		await settle(clock);
		const once = observe();
		const handle = client.subscribe(
			feed({ topic: "once" }, { repeatable: false }),
			once.observer,
		);
		kit.fire("window", "pagehide", { persisted: true });
		await settle(clock);
		expect(onTopic(host, "once")).toHaveLength(1);
		kit.fire("window", "pageshow", { persisted: true });
		await tick(clock, 1_000, 50);
		expect(client.status.get().generation).toBe(2);
		expect(once.log.errors.map((e) => e.code)).toEqual(["interrupted"]);
		expect(onTopic(host, "once")).toHaveLength(1);
		expect(handle.status.get().active).toBe(false);
	});

	it("hung worker and ping timeout before the first status: interrupted, one upstream run", async () => {
		const { client, host, clock } = makeClient(fast, { noLocal: true });
		client.start();
		await settle(clock);
		host.hang();
		const once = observe();
		const handle = client.subscribe(
			feed({ topic: "once" }, { repeatable: false }),
			once.observer,
		);
		await settle(clock);
		// heartbeat 1 s, probe timeout 1 s, loss, 250 ms backoff, new hello (held)
		await tick(clock, 2_400, 50);
		expect(client.status.get().health).toBe("reattaching");
		host.unhang();
		await settle(clock);
		await tick(clock, 500, 50);
		expect(client.status.get()).toMatchObject({
			mode: "shared",
			generation: 2,
		});
		expect(once.log.errors.map((e) => e.code)).toEqual(["interrupted"]);
		expect(onTopic(host, "once")).toHaveLength(1);
		expect(handle.status.get().active).toBe(false);
	});

	it("guard: a repeatable request lost before its first status is re-registered, not ended", async () => {
		const { client, host, clock } = makeClient(fast);
		client.start();
		await settle(clock);
		dropStatus(host);
		const again = observe();
		const handle = client.subscribe(feed({ topic: "again" }), again.observer);
		await settle(clock);
		host.fireError();
		await tick(clock, 1_500, 50);
		expect(again.log.errors).toEqual([]);
		expect(handle.status.get().active).toBe(true);
		expect(host.runtime.stats().consumers).toBe(1);
		const upstream = onTopic(host, "again");
		upstream[upstream.length - 1]?.emit(7);
		await settle(clock);
		expect(again.log.events).toEqual([7]);
	});

	it("(was the residual row): an adapter-default non-repeatable request lost before its first status ends interrupted; the upstream never restarts", async () => {
		// The runtime communicates adapter-default repeatability through the replay marker before the first status.
		const { client, host, clock } = makeClient(fast, {
			hostLimits: { test: { repeatable: () => false } },
		});
		client.start();
		await settle(clock);
		dropStatus(host);
		const once = observe();
		const handle = client.subscribe(feed({ topic: "once" }), once.observer);
		await settle(clock);
		host.fireError();
		await tick(clock, 1_500, 50);
		expect(client.status.get().generation).toBe(2);
		expect(once.log.errors.map((e) => e.code)).toEqual(["interrupted"]);
		expect(onTopic(host, "once")).toHaveLength(1);
		expect(host.runtime.stats().consumers).toBe(0);
		expect(handle.status.get().active).toBe(false);
	});
});

describe("request fields are validated before anything is posted", () => {
	const wrongTypes: Array<[string, unknown]> = [
		["share", "sometimes"],
		["share", null],
		["repeatable", "false"],
		["repeatable", 0],
		["stateful", 1],
	];

	for (const [field, value] of wrongTypes) {
		it(`subscribe with ${field}=${JSON.stringify(value)} fails with unsupported-option at request.${field}`, async () => {
			const { client, clock, host } = makeClient();
			client.start();
			await settle(clock);
			expect(() =>
				client.subscribe(
					feed({ topic: "a" }, { [field]: value } as never),
					() => {},
				),
			).toThrowError(
				expect.objectContaining({
					code: "unsupported-option",
					detail: { path: `request.${field}` },
				}),
			);
			await settle(clock);
			expect(host.runtime.stats()).toMatchObject({
				invalidEnvelopes: 0,
				consumers: 0,
			});
		});
	}

	it("an unknown subscribe key fails naming it; a typo never subscribes as repeatable", async () => {
		const { client, clock, host } = makeClient();
		client.start();
		await settle(clock);
		expect(() =>
			client.subscribe(
				feed({ topic: "a" }, { repeatible: false } as never),
				() => {},
			),
		).toThrowError(
			expect.objectContaining({
				code: "unsupported-option",
				detail: { path: "request.repeatible" },
			}),
		);
		await settle(clock);
		expect(host.test.all()).toHaveLength(0);
	});

	it("an unknown command key rejects naming it and sends nothing", async () => {
		const { client, clock, host } = makeClient({}, withCommands);
		client.start();
		await settle(clock);
		await expect(
			client.command({
				adapter: "test",
				connection: { url: "https://api.test/c" },
				payload: 1,
				timeuot: 5,
			} as never),
		).rejects.toMatchObject({
			code: "unsupported-option",
			detail: { path: "request.timeuot" },
		});
		await settle(clock);
		expect(host.test.connections.flatMap((c) => c.commands)).toEqual([]);
	});

	it("guard: every documented key is accepted, including undefined optional fields as builders produce them", async () => {
		const { client, clock, host } = makeClient({}, withCommands);
		client.start();
		await settle(clock);
		const { log, observer } = observe();
		client.subscribe(
			{
				adapter: "test",
				connection: { url: "https://api.test/feed" },
				subscription: { topic: "ok" },
				scope: "",
				repeatable: undefined,
				share: "always",
				stateful: false,
			},
			observer,
		);
		const outcome = client.command({
			adapter: "test",
			connection: { url: "https://api.test/c" },
			payload: 1,
			scope: "",
		});
		await settle(clock);
		expect(log.errors).toEqual([]);
		expect(onTopic(host, "ok")).toHaveLength(1);
		await expect(outcome).resolves.toMatchObject({ status: "acknowledged" });
	});
});

describe("a worker factory result without a usable port", () => {
	const disposers: Array<() => void> = [];
	afterEach(() => {
		for (const dispose of disposers.splice(0)) dispose();
	});

	function clientWith(
		worker: () => unknown,
		options: Partial<SpinetabOptions> = {},
	) {
		const clock = new ManualClock();
		const kit = createTestEnv(clock);
		const test = createTestAdapter();
		const local = vi.fn(async () => ({
			default: () => createRuntime({ adapters: [test.adapter], clock }),
		}));
		const client = createClientWithEnv(
			{
				worker: worker as SpinetabOptions["worker"],
				local: local as unknown as SpinetabOptions["local"],
				...options,
			},
			kit.env,
		);
		disposers.push(() => client.dispose());
		return { client, clock, local, test };
	}

	const listeners = { addEventListener() {}, removeEventListener() {} };
	const dedicated = () => ({ ...listeners, postMessage() {} });
	const portWithout = (missing: string) => {
		const port: Record<string, unknown> = {
			postMessage() {},
			addEventListener() {},
			removeEventListener() {},
			start() {},
			close() {},
		};
		delete port[missing];
		return { ...listeners, port };
	};

	it("a dedicated-Worker-shaped result fails startup and falls back to local under prefer", async () => {
		const { client, clock, local, test } = clientWith(dedicated);
		const { log, observer } = observe();
		expect(() => client.subscribe(feed(), observer)).not.toThrow();
		await settle(clock);
		expect(client.status.get()).toMatchObject({
			mode: "local",
			reason: "worker-construct-failed",
			health: "healthy",
		});
		expect(local).toHaveBeenCalledTimes(1);
		test.last().emit({ n: 1 });
		await settle(clock);
		expect(log.events).toEqual([{ n: 1 }]);
		expect(() => client.dispose()).not.toThrow();
		expect(client.status.get().mode).toBe("disposed");
	});

	it("a port without postMessage fails with worker-construct-failed / not-a-shared-worker under require", async () => {
		const { client, clock, local } = clientWith(
			() => portWithout("postMessage"),
			{ sharing: "require" },
		);
		const { log, observer } = observe();
		client.subscribe(feed(), observer);
		await settle(clock);
		expect(client.status.get()).toMatchObject({
			mode: "failed",
			reason: "worker-construct-failed",
			detail: "not-a-shared-worker",
		});
		expect(log.errors.map((e) => e.code)).toEqual(["sharing-unavailable"]);
		expect(local).not.toHaveBeenCalled();
		expect(() => client.dispose()).not.toThrow();
	});

	it("a port whose start() throws fails startup without wedging the client", async () => {
		const worker = {
			...listeners,
			port: {
				postMessage() {},
				addEventListener() {},
				removeEventListener() {},
				start() {
					throw new TypeError("not a port");
				},
				close() {},
			},
		};
		const { client, clock } = clientWith(() => worker, {
			sharing: "require",
		});
		expect(() => client.start()).not.toThrow();
		await settle(clock);
		expect(client.status.get()).toMatchObject({
			mode: "failed",
			reason: "worker-construct-failed",
			detail: "TypeError",
		});
		// The failed client still answers: retry() and dispose() never throw.
		expect(() => client.retry()).not.toThrow();
		await settle(clock);
		expect(client.status.get().mode).toBe("failed");
		expect(() => client.dispose()).not.toThrow();
		expect(client.status.get().mode).toBe("disposed");
	});
});

describe("a command held before welcome keeps its issue-time deadline", () => {
	function held(command: () => Promise<CommandOutcome>) {
		const seen: Array<{ timeoutMs: number; signal: AbortSignal }> = [];
		const harness = makeClient(
			{},
			{
				hostLimits: {
					test: {
						command: (_payload, options) => {
							seen.push(options);
							return command();
						},
					},
				},
			},
		);
		return { ...harness, seen };
	}

	it("posts the remaining time, so the runtime's outcome settles it at the deadline", async () => {
		const { client, clock, host, seen } = held(() => new Promise(() => {}));
		host.hang();
		const t0 = clock.now();
		let settled: { outcome: CommandOutcome; at: number } | undefined;
		void client
			.command(
				{
					adapter: "test",
					connection: { url: "https://api.test/cmd" },
					payload: 1,
				},
				{ timeoutMs: 1_000 },
			)
			.then((outcome) => {
				settled = { outcome, at: clock.now() - t0 };
			});
		await tick(clock, 600, 50);
		host.unhang();
		await settle(clock);
		expect(seen.map((item) => item.timeoutMs)).toEqual([400]);
		await tick(clock, 400, 50);
		expect(seen[0]?.signal.aborted).toBe(true);
		expect(settled?.at).toBe(1_000);
		// The runtime's own outcome, not the page's fallback timer.
		expect(settled?.outcome).toMatchObject({
			status: "unknown",
			error: {
				code: "command-unknown",
				message: "The command did not settle before its timeout.",
			},
		});
	});

	it("an upstream answer after the issue-time deadline is not reported as acknowledged", async () => {
		let ack: ((outcome: CommandOutcome) => void) | undefined;
		const { client, clock, host } = held(
			() =>
				new Promise<CommandOutcome>((resolve) => {
					ack = resolve;
				}),
		);
		host.hang();
		const pending = client.command(
			{
				adapter: "test",
				connection: { url: "https://api.test/cmd" },
				payload: 1,
			},
			{ timeoutMs: 1_000 },
		);
		await tick(clock, 600, 50);
		host.unhang();
		await settle(clock);
		await tick(clock, 500, 50);
		ack?.({ status: "acknowledged", value: "late" });
		await settle(clock);
		await expect(pending).resolves.toMatchObject({
			status: "unknown",
			error: { message: "The command did not settle before its timeout." },
		});
	});

	it("a held command whose deadline passed during a suspension is never posted", async () => {
		const { client, clock, host, seen } = held(() => new Promise(() => {}));
		host.hang();
		const pending = client.command(
			{
				adapter: "test",
				connection: { url: "https://api.test/cmd" },
				payload: 1,
			},
			{ timeoutMs: 1_000 },
		);
		await settle(clock);
		clock.jump(1_000);
		host.unhang();
		await settle(clock);
		await expect(pending).resolves.toMatchObject({
			status: "not-sent",
			error: { code: "timeout" },
		});
		expect(seen).toEqual([]);
	});

	it("a held command posts at most its own timeoutMs after the wall clock steps back", async () => {
		const { client, clock, host, seen } = held(() => new Promise(() => {}));
		host.hang();
		void client.command(
			{
				adapter: "test",
				connection: { url: "https://api.test/cmd" },
				payload: 1,
			},
			{ timeoutMs: 1_000 },
		);
		await tick(clock, 200, 50);
		// An NTP or manual step back of one hour while the command is held.
		clock.jump(-3_600_000);
		host.unhang();
		await settle(clock);
		expect(seen).toHaveLength(1);
		expect(seen[0]?.timeoutMs).toBeLessThanOrEqual(1_000);
	});
});

describe("checkHealth resolves with the status after a failed check", () => {
	it("a probe timeout resolves with health 'reattaching', as client.status reads", async () => {
		const { client, clock, host } = makeClient(
			{ probeTimeoutMs: 1_000, heartbeatMs: 60_000 },
			{ noLocal: true },
		);
		client.start();
		await settle(clock);
		host.hang();
		let resolved: Awaited<ReturnType<typeof client.checkHealth>> | undefined;
		void client.checkHealth("test").then((status) => {
			resolved = status;
		});
		await tick(clock, 1_100, 50);
		expect(client.status.get()).toMatchObject({
			health: "reattaching",
			detail: "ping-timeout",
		});
		expect(resolved).toMatchObject({
			health: "reattaching",
			detail: "ping-timeout",
		});
	});
});

// A check spanning attachment retirement must resolve with the status after retirement.
describe("a check pending when the attachment is retired resolves with the status after it", () => {
	async function pendingCheck(
		extra: Partial<SpinetabOptions> = {},
		harness: ReturnType<typeof makeClient> = makeClient(
			{ probeTimeoutMs: 5_000, heartbeatMs: 60_000, ...extra },
			{ noLocal: true },
		),
	) {
		const { client, clock, host } = harness;
		if (client.status.get().mode === "inactive") {
			client.start();
			await settle(clock);
		}
		host.hang();
		const box: { resolved?: Awaited<ReturnType<typeof client.checkHealth>> } =
			{};
		void client.checkHealth("test").then((status) => {
			box.resolved = status;
		});
		await tick(clock, 100, 50);
		expect(client.status.get().health).toBe("checking");
		return { ...harness, box };
	}

	it("V-06a a worker error resolves it with the status after the loss", async () => {
		const { client, clock, host, box } = await pendingCheck();
		host.fireError();
		await settle(clock);
		expect(client.status.get()).toMatchObject({
			health: "reattaching",
			detail: "worker-error",
		});
		expect(box.resolved).toEqual(client.status.get());
	});

	it("V-06c a port close resolves it with the status after the loss", async () => {
		const { client, clock, host, box } = await pendingCheck();
		host.lastRelay().host.close();
		await settle(clock);
		expect(client.status.get()).toMatchObject({
			health: "reattaching",
			detail: "port-close",
		});
		expect(box.resolved).toEqual(client.status.get());
	});

	it("pagehide resolves it with health 'unknown', as client.status reads", async () => {
		const { client, clock, kit, box } = await pendingCheck();
		kit.fire("window", "pagehide", { persisted: true });
		await settle(clock);
		expect(client.status.get()).toMatchObject({
			mode: "shared",
			health: "unknown",
		});
		expect(box.resolved).toEqual(client.status.get());
	});

	it("a scope change resolves it with health 'reattaching', as client.status reads", async () => {
		const { client, clock, box } = await pendingCheck();
		client.setScope("next-principal");
		await settle(clock);
		expect(client.status.get()).toMatchObject({
			mode: "shared",
			health: "reattaching",
		});
		expect(box.resolved).toEqual(client.status.get());
	});

	it("the loss that exhausts the re-attachment budget resolves it with the failed status", async () => {
		const harness = makeClient({
			probeTimeoutMs: 5_000,
			heartbeatMs: 60_000,
			sharing: "require",
		});
		const { client, clock, host } = harness;
		client.start();
		await settle(clock);
		for (let loss = 0; loss < 5; loss += 1) {
			host.fireError();
			await tick(clock, 11_000, 500);
			expect(client.status.get()).toMatchObject({
				mode: "shared",
				health: "healthy",
			});
		}
		const { box } = await pendingCheck({}, harness);
		host.fireError();
		await settle(clock);
		expect(client.status.get()).toMatchObject({
			mode: "failed",
			reason: "runtime-unstable",
			health: "unreachable",
		});
		expect(box.resolved).toEqual(client.status.get());
	});

	it("dispose() resolves it with the disposed status, as client.status reads", async () => {
		const { client, clock, box } = await pendingCheck();
		client.dispose();
		await settle(clock);
		expect(client.status.get()).toMatchObject({
			mode: "disposed",
			health: "unknown",
		});
		expect(box.resolved).toEqual(client.status.get());
	});
});

// Observer callbacks run during retirement; a re-entrant check must wait for the final client status.
describe("a check made from observer.status during a retirement resolves with the status after it", () => {
	type Harness = ReturnType<typeof makeClient>;

	async function observerCheck(withPending: boolean) {
		const harness = makeClient(
			{ probeTimeoutMs: 5_000, heartbeatMs: 60_000 },
			{ noLocal: true },
		);
		const { client, clock, host } = harness;
		client.start();
		await settle(clock);
		const box: {
			armed: boolean;
			check?: Promise<ClientStatus>;
			pending?: Promise<ClientStatus>;
		} = { armed: false };
		client.subscribe(feed({ topic: "t" }), {
			next: () => {},
			status: (status) => {
				// One re-entrant call, guarded synchronously.
				if (box.armed && !box.check && status.continuity.state === "unknown") {
					box.check = client.checkHealth("from-observer");
				}
			},
		});
		await settle(clock);
		expect(client.status.get()).toMatchObject({
			mode: "shared",
			health: "healthy",
		});
		if (withPending) {
			host.hang();
			box.pending = client.checkHealth("pending");
			await tick(clock, 100, 50);
			expect(client.status.get().health).toBe("checking");
		}
		box.armed = true;
		return { ...harness, box };
	}

	const transitions: {
		name: string;
		run: (harness: Harness) => void;
		after: Partial<ClientStatus>;
	}[] = [
		{
			name: "a worker error",
			run: ({ host }) => host.fireError(),
			after: { mode: "shared", health: "reattaching", detail: "worker-error" },
		},
		{
			name: "a scope change",
			run: ({ client }) => client.setScope("next-principal"),
			after: { mode: "shared", health: "reattaching" },
		},
		{
			name: "pagehide",
			run: ({ kit }) => kit.fire("window", "pagehide", { persisted: true }),
			after: { mode: "shared", health: "unknown" },
		},
	];

	for (const transition of transitions) {
		for (const withPending of [false, true]) {
			it(`I-3 ${transition.name} ${withPending ? "with" : "without"} a check pending`, async () => {
				const harness = await observerCheck(withPending);
				const { client, box } = harness;
				transition.run(harness);
				// The transition has completed: this is what client.status reads.
				const after = client.status.get();
				expect(after).toMatchObject(transition.after);
				expect(box.check).toBeDefined();
				// Microtasks only: no message from a new attachment can land here.
				expect(await box.check).toEqual(after);
				if (box.pending) expect(await box.pending).toEqual(after);
				expect(client.status.get()).toEqual(after);
			});
		}
	}
});

// Checks while hidden must not attach a worker; the next visible return attaches once.
describe("a check never re-attaches a page hidden by pagehide", () => {
	type Harness = ReturnType<typeof makeClient>;

	async function attached(): Promise<Harness> {
		const harness = makeClient(
			{ probeTimeoutMs: 5_000, heartbeatMs: 60_000 },
			{ noLocal: true },
		);
		harness.client.start();
		await settle(harness.clock);
		return harness;
	}

	/** One check from observer.status on the first matching status. */
	function observerCheck(
		{ client }: Harness,
		when: (status: SubscriptionStatus) => boolean,
	) {
		const box: { armed: boolean; check?: Promise<ClientStatus> } = {
			armed: false,
		};
		client.subscribe(feed({ topic: "t" }), {
			next: () => {},
			status: (status) => {
				if (box.armed && !box.check && when(status)) {
					box.check = client.checkHealth("from-observer");
				}
			},
		});
		return box;
	}

	/** Open page ports and runtime attachments: an orphan shows as 2. */
	const attachments = ({ host }: Harness) => ({
		page: host.relays.filter((relay) => !relay.closed && !relay.dead).length,
		runtime: host.runtime.stats().attachments,
	});

	/** BFCache restore: visible again, pageshow, then the hint window. */
	async function restore({ clock, kit }: Harness): Promise<void> {
		kit.setVisible(true);
		kit.fire("document", "visibilitychange");
		kit.fire("window", "pageshow", { persisted: true });
		await tick(clock, 500, 50);
	}

	const detachedShape = { mode: "shared", health: "unknown", generation: 1 };
	const reattached = { mode: "shared", health: "healthy", generation: 2 };

	it("G4-1 a check from observer.status during the pagehide detach constructs nothing and resolves detached; pageshow re-attaches once", async () => {
		const harness = await attached();
		const { client, clock, host, kit } = harness;
		const box = observerCheck(
			harness,
			(status) => status.continuity.state === "unknown",
		);
		await settle(clock);
		const before = host.created;
		box.armed = true;
		// The document still reads visible: the HTML unload steps (and
		// Chromium) fire pagehide before the visibility state becomes hidden.
		kit.fire("window", "pagehide", { persisted: true });
		expect(box.check).toBeDefined();
		expect(host.created - before).toBe(0);
		const detached = client.status.get();
		expect(detached).toMatchObject(detachedShape);
		expect(await box.check).toEqual(detached);
		await settle(clock);
		expect(host.created - before).toBe(0);
		expect(attachments(harness)).toEqual({ page: 0, runtime: 0 });
		expect(client.status.get()).toEqual(detached);
		await restore(harness);
		expect(host.created - before).toBe(1);
		expect(attachments(harness)).toEqual({ page: 1, runtime: 1 });
		expect(client.status.get()).toMatchObject(reattached);
	});

	for (const order of [
		{ name: "while the document still reads visible", hideFirst: false },
		{ name: "after the document was hidden", hideFirst: true },
	]) {
		it(`G4-2 a check from the application's own pagehide listener ${order.name} constructs nothing and resolves detached; pageshow re-attaches once`, async () => {
			const harness = await attached();
			const { client, clock, host, kit } = harness;
			client.subscribe(feed({ topic: "t" }), { next: () => {} });
			await settle(clock);
			// Registered after start(), so it runs after Spinetab's listener.
			let check: Promise<ClientStatus> | undefined;
			kit.env.listen("window", "pagehide", () => {
				check = client.checkHealth("app-pagehide");
			});
			const before = host.created;
			const hide = () => {
				kit.setVisible(false);
				kit.fire("document", "visibilitychange");
			};
			if (order.hideFirst) hide();
			kit.fire("window", "pagehide", { persisted: true });
			if (!order.hideFirst) hide();
			expect(check).toBeDefined();
			expect(host.created - before).toBe(0);
			const detached = client.status.get();
			expect(detached).toMatchObject(detachedShape);
			expect(await check).toEqual(detached);
			await settle(clock);
			expect(host.created - before).toBe(0);
			expect(attachments(harness)).toEqual({ page: 0, runtime: 0 });
			await restore(harness);
			expect(host.created - before).toBe(1);
			expect(attachments(harness)).toEqual({ page: 1, runtime: 1 });
			expect(client.status.get()).toMatchObject(reattached);
		});
	}

	it("G4-3 a scope change while hidden by pagehide, with a check from observer.status, constructs nothing and orphans nothing; pageshow attaches once with the new scope", async () => {
		const harness = await attached();
		const { client, clock, host, kit } = harness;
		const box = observerCheck(
			harness,
			(status) => status.continuity.reason === "scope-changed",
		);
		await settle(clock);
		kit.fire("window", "pagehide", { persisted: true });
		await settle(clock);
		const before = host.created;
		box.armed = true;
		client.setScope("next-principal");
		expect(box.check).toBeDefined();
		expect(host.created - before).toBe(0);
		const detached = client.status.get();
		expect(detached).toMatchObject(detachedShape);
		expect(await box.check).toEqual(detached);
		await settle(clock);
		expect(host.created - before).toBe(0);
		expect(attachments(harness)).toEqual({ page: 0, runtime: 0 });
		await restore(harness);
		expect(host.created - before).toBe(1);
		expect(attachments(harness)).toEqual({ page: 1, runtime: 1 });
		expect(host.runtime.stats().perAttachment.map((a) => a.scope)).toEqual([
			"next-principal",
		]);
		expect(host.runtime.stats().consumers).toBe(1);
		expect(client.status.get()).toMatchObject(reattached);
	});

	it("G4-4 a scope change after pageshow, before the hint re-attaches, with a check from observer.status: the check re-attaches at once and the scope change opens no second attachment", async () => {
		const harness = await attached();
		const { client, clock, host, kit } = harness;
		const box = observerCheck(
			harness,
			(status) => status.continuity.reason === "scope-changed",
		);
		await settle(clock);
		kit.fire("window", "pagehide", { persisted: true });
		await settle(clock);
		const before = host.created;
		// Shown again; the pageshow hint waits for its 250 ms window.
		kit.fire("window", "pageshow", { persisted: true });
		box.armed = true;
		client.setScope("next-principal");
		expect(box.check).toBeDefined();
		expect(host.created - before).toBe(1);
		const reattaching = client.status.get();
		expect(reattaching).toMatchObject({
			mode: "shared",
			health: "reattaching",
		});
		expect(await box.check).toEqual(reattaching);
		await tick(clock, 500, 50);
		expect(host.created - before).toBe(1);
		expect(attachments(harness)).toEqual({ page: 1, runtime: 1 });
		expect(host.runtime.stats().perAttachment.map((a) => a.scope)).toEqual([
			"next-principal",
		]);
		expect(host.runtime.stats().consumers).toBe(1);
		expect(client.status.get()).toMatchObject(reattached);
	});

	it("G4-5 a check while the document is hidden, after a freeze detach and resume, constructs nothing and resolves detached; the resume hint re-attaches after its window", async () => {
		const harness = await attached();
		const { client, clock, host, kit } = harness;
		client.subscribe(feed({ topic: "t" }), { next: () => {} });
		await settle(clock);
		kit.setVisible(false);
		kit.fire("document", "visibilitychange");
		kit.fire("document", "freeze");
		await settle(clock);
		const before = host.created;
		kit.fire("document", "resume");
		const check = client.checkHealth("hidden");
		expect(host.created - before).toBe(0);
		const detached = client.status.get();
		expect(detached).toMatchObject(detachedShape);
		expect(await check).toEqual(detached);
		// Hidden visibility is not a detach: the resume hint, a
		// path this guard leaves unchanged, re-attaches the hidden page.
		await tick(clock, 500, 50);
		expect(host.created - before).toBe(1);
		expect(attachments(harness)).toEqual({ page: 1, runtime: 1 });
		expect(client.status.get()).toMatchObject(reattached);
	});

	it("G4-6 guard: a nested setScope from observer.status during a scope change attaches once, with the newest scope", async () => {
		const harness = await attached();
		const { client, clock, host } = harness;
		let nested = false;
		client.subscribe(feed({ topic: "t" }), {
			next: () => {},
			status: (status) => {
				if (!nested && status.continuity.reason === "scope-changed") {
					nested = true;
					client.setScope("third-principal");
				}
			},
		});
		await settle(clock);
		const before = host.created;
		client.setScope("next-principal");
		expect(nested).toBe(true);
		expect(host.created - before).toBe(1);
		await settle(clock);
		expect(host.created - before).toBe(1);
		expect(attachments(harness)).toEqual({ page: 1, runtime: 1 });
		expect(host.runtime.stats().perAttachment.map((a) => a.scope)).toEqual([
			"third-principal",
		]);
		expect(host.runtime.stats().consumers).toBe(1);
		expect(client.status.get()).toMatchObject(reattached);
	});

	// A second pagehide can occur during the delayed reattachment after return.
	for (const second of [
		{
			name: "after pageshow, navigating away",
			via: "pageshow",
			persisted: false,
		},
		{
			name: "after pageshow, into the BFCache again",
			via: "pageshow",
			persisted: true,
		},
		{
			name: "after resume and visible, closing the tab",
			via: "resume",
			persisted: false,
		},
	]) {
		it(`G4-7 a second pagehide inside the post-return hint window ${second.name} (persisted ${second.persisted}): a check from the application's own pagehide listener constructs nothing and resolves detached`, async () => {
			const harness = await attached();
			const { client, clock, host, kit } = harness;
			client.subscribe(feed({ topic: "t" }), { next: () => {} });
			await settle(clock);
			// Registered after start(), so it runs after Spinetab's listener.
			let armed = false;
			let check: Promise<ClientStatus> | undefined;
			kit.env.listen("window", "pagehide", () => {
				if (armed) check = client.checkHealth("app-pagehide-2");
			});
			const hide = () => {
				kit.setVisible(false);
				kit.fire("document", "visibilitychange");
			};
			if (second.via === "pageshow") {
				kit.fire("window", "pagehide", { persisted: true });
				hide();
			} else {
				hide();
				kit.fire("document", "freeze");
			}
			await settle(clock);
			const before = host.created;
			// Shown again; the return's re-attachment waits for its window.
			if (second.via === "resume") kit.fire("document", "resume");
			kit.setVisible(true);
			kit.fire("document", "visibilitychange");
			if (second.via === "pageshow") {
				kit.fire("window", "pageshow", { persisted: true });
			}
			await tick(clock, 100, 50);
			expect(host.created - before).toBe(0);
			armed = true;
			// HTML unload order: pagehide while the document still reads visible.
			kit.fire("window", "pagehide", { persisted: second.persisted });
			expect(check).toBeDefined();
			expect(host.created - before).toBe(0);
			hide();
			const detached = client.status.get();
			expect(detached).toMatchObject(detachedShape);
			expect(await check).toEqual(detached);
			// No time passes while hidden: browsers run no timer of a page after
			// pagehide until it is shown again (the pending return hint's own
			// path is unchanged; E-fix3-fix-1 notes, residual X2).
			await settle(clock);
			expect(host.created - before).toBe(0);
			expect(attachments(harness)).toEqual({ page: 0, runtime: 0 });
			expect(client.status.get()).toEqual(detached);
			if (!second.persisted) return;
			// Restored again: the return clears the mark, so a check inside the
			// window re-attaches at once, and only once.
			kit.setVisible(true);
			kit.fire("document", "visibilitychange");
			kit.fire("window", "pageshow", { persisted: true });
			const again = client.checkHealth("after-second-return");
			expect(host.created - before).toBe(1);
			await again;
			await tick(clock, 500, 50);
			expect(host.created - before).toBe(1);
			expect(attachments(harness)).toEqual({ page: 1, runtime: 1 });
			expect(client.status.get()).toMatchObject(reattached);
		});
	}

	// An application listener registered before Spinetab runs before detach; any attachment its check creates must be retired by the following detach.
	it("G4-R residual: a check from an application pagehide listener registered before Spinetab's, inside the post-return hint window, constructs one worker that the detach retires at once; nothing stays open and the check resolves detached", async () => {
		const harness = makeClient(
			{ probeTimeoutMs: 5_000, heartbeatMs: 60_000 },
			{ noLocal: true },
		);
		const { client, clock, host, kit } = harness;
		let armed = false;
		let check: Promise<ClientStatus> | undefined;
		kit.env.listen("window", "pagehide", () => {
			if (armed) check = client.checkHealth("early-app-pagehide");
		});
		client.start();
		await settle(clock);
		client.subscribe(feed({ topic: "t" }), { next: () => {} });
		await settle(clock);
		kit.fire("window", "pagehide", { persisted: true });
		await settle(clock);
		const before = host.created;
		kit.fire("window", "pageshow", { persisted: true });
		await tick(clock, 100, 50);
		expect(host.created - before).toBe(0);
		armed = true;
		kit.fire("window", "pagehide", { persisted: false });
		expect(check).toBeDefined();
		expect(host.created - before).toBe(1);
		const detached = client.status.get();
		expect(detached).toMatchObject(detachedShape);
		expect(await check).toEqual(detached);
		await settle(clock);
		expect(host.created - before).toBe(1);
		expect(attachments(harness)).toEqual({ page: 0, runtime: 0 });
		expect(client.status.get()).toEqual(detached);
	});
});

describe("observer.status never ends on a superseded snapshot", () => {
	const label = (s: SubscriptionStatus) =>
		`${s.connection.state}|${s.continuity.state}/${s.continuity.reason ?? "-"}`;

	it("an overflow gap reconciled synchronously by a store listener", async () => {
		const { client, host, clock } = makeClient({
			limits: { maxPendingMessagesPerConsumer: 2, maxPendingMessages: 2 },
		});
		client.start();
		await settle(clock);
		host.lastRelay().drop = (data, toRuntime) =>
			toRuntime &&
			(data as { t?: string }).t === "ack" &&
			"c" in (data as object);
		const seen: string[] = [];
		const handle = client.subscribe(feed(), {
			next() {},
			status: (s) => seen.push(label(s)),
		});
		await settle(clock);
		host.test.connections[0]?.ctx.setStatus({ state: "connected" });
		await settle(clock);
		// "latest" by hand: a full-state feed reconciled on every notice.
		handle.status.subscribe((s) => {
			if (s.continuity.state === "gap") handle.markReconciled();
		});
		seen.length = 0;
		for (let n = 1; n <= 5; n += 1) host.test.last().emit(n);
		await settle(clock);
		expect(label(handle.status.get())).toBe("connected|continuous/reconciled");
		expect(seen.at(-1)).toBe(label(handle.status.get()));
	});

	it("guard: a scope change reconciled synchronously by a store listener", async () => {
		const { client, clock } = makeClient();
		const seen: string[] = [];
		const handle = client.subscribe(feed({ topic: "a" }), {
			next() {},
			status: (s) => seen.push(label(s)),
		});
		await settle(clock);
		handle.status.subscribe((s) => {
			if (s.continuity.state !== "continuous") handle.markReconciled();
		});
		client.setScope("other");
		await settle(clock);
		expect(seen.at(-1)).toBe(label(handle.status.get()));
	});
});

describe("C1-F4 page timing options and command timeouts stay within MAX_TIMER_MS", () => {
	const MAX = 2_147_483_647;

	for (const key of [
		"handshakeTimeoutMs",
		"probeTimeoutMs",
		"heartbeatMs",
		"leaseMs",
	] as const) {
		it(`C1-F4 createSpinetab refuses options.${key} above MAX_TIMER_MS`, () => {
			const make = (value: number) =>
				createClientWithEnv(
					{ [key]: value } as SpinetabOptions,
					createTestEnv(new ManualClock()).env,
				).dispose();
			expect(() => make(2 ** 31)).toThrowError(
				expect.objectContaining({
					code: "unsupported-option",
					message: `options.${key} must be an integer between 1 and ${MAX}.`,
					detail: { path: `options.${key}` },
				}),
			);
			expect(() => make(MAX)).not.toThrow();
		});
	}

	it("C1-F4 command() rejects options.timeoutMs above MAX_TIMER_MS and sends nothing", async () => {
		const { client, clock, host } = makeClient({}, withCommands);
		client.start();
		await settle(clock);
		await expect(
			client.command(
				{
					adapter: "test",
					connection: { url: "https://api.test/cmd" },
					payload: 1,
				},
				{ timeoutMs: 2 ** 31 },
			),
		).rejects.toMatchObject({
			code: "unsupported-option",
			detail: { path: "options.timeoutMs" },
		});
		await settle(clock);
		expect(host.runtime.stats().pendingCommands).toBe(0);
	});

	it("C1-F4 guard: command() accepts options.timeoutMs MAX_TIMER_MS", async () => {
		const { client, clock } = makeClient({}, withCommands);
		client.start();
		await settle(clock);
		const outcome = client.command(
			{
				adapter: "test",
				connection: { url: "https://api.test/cmd" },
				payload: 1,
			},
			{ timeoutMs: MAX },
		);
		await settle(clock);
		await expect(outcome).resolves.toMatchObject({ status: "acknowledged" });
	});
});

describe("the runtime replay marker", () => {
	const INTERRUPTED =
		"The runtime was replaced and this subscription cannot be restarted automatically; its outcome is unknown.";
	type Message = Record<string, unknown>;
	const without = (message: Message, key: string): Message =>
		Object.fromEntries(
			Object.entries(message).filter(([name]) => name !== key),
		);

	/**
	 * Record every subscribe the page posts (before any rewrite). With `old`,
	 * emulate an older runtime: its welcome advertises nothing and it
	 * never sees a marker (it would ignore one).
	 */
	function wire(host: FakeWorkerHost, options: { old?: boolean } = {}) {
		const subscribes: Message[] = [];
		host.rewrite = (data, toRuntime) => {
			const message = data as Message;
			if (toRuntime && message?.t === "subscribe") {
				subscribes.push(message);
				return options.old ? without(message, "replay") : data;
			}
			if (!toRuntime && options.old && message?.t === "welcome") {
				return without(message, "replay");
			}
			return data;
		};
		return subscribes;
	}

	const dropFirstStatus = (host: FakeWorkerHost) => {
		host.lastRelay().drop = (data, toRuntime) =>
			!toRuntime && (data as { t?: string })?.t === "status";
	};

	async function lostBeforeFirstStatus(
		request: Parameters<typeof feed>[1],
		settings: { old?: boolean; adapterRepeatable?: boolean } = {},
	) {
		const harness = makeClient(fast, {
			...(settings.adapterRepeatable === false
				? { hostLimits: { test: { repeatable: () => false } } }
				: {}),
		});
		const subscribes = wire(harness.host, { old: settings.old === true });
		harness.client.start();
		await settle(harness.clock);
		dropFirstStatus(harness.host);
		const log = observe();
		const handle = harness.client.subscribe(
			feed({ topic: "t" }, request),
			log.observer,
		);
		await settle(harness.clock);
		harness.host.fireError();
		await tick(harness.clock, 1_500, 50);
		expect(harness.client.status.get().generation).toBe(2);
		return { ...harness, subscribes, log: log.log, handle };
	}

	const endedAtOnce = (
		result: Awaited<ReturnType<typeof lostBeforeFirstStatus>>,
	) => {
		expect(result.log.errors).toEqual([
			expect.objectContaining({ code: "interrupted", message: INTERRUPTED }),
		]);
		expect(result.subscribes).toHaveLength(1);
		expect(onTopic(result.host, "t")).toHaveLength(1);
		expect(result.handle.status.get().active).toBe(false);
	};

	const replayed = async (
		result: Awaited<ReturnType<typeof lostBeforeFirstStatus>>,
	) => {
		expect(result.log.errors).toEqual([]);
		expect(result.handle.status.get().active).toBe(true);
		const upstream = onTopic(result.host, "t");
		upstream[upstream.length - 1]?.emit(7);
		await settle(result.clock);
		expect(result.log.events).toEqual([7]);
	};

	it("new page + new runtime: an adapter-default non-repeatable request ends interrupted after the runtime's answer, with the fixed sentence", async () => {
		const result = await lostBeforeFirstStatus(
			{},
			{ adapterRepeatable: false },
		);
		expect(result.subscribes.map((m) => m.replay)).toEqual([undefined, true]);
		expect(result.log.errors).toEqual([
			expect.objectContaining({ code: "interrupted", message: INTERRUPTED }),
		]);
		expect(onTopic(result.host, "t")).toHaveLength(1);
		expect(result.host.runtime.stats()).toMatchObject({
			consumers: 0,
			invalidEnvelopes: 0,
		});
		expect(result.handle.status.get().active).toBe(false);
	});

	it("new page + new runtime: a repeatable request is re-registered with the marker and resumes", async () => {
		const result = await lostBeforeFirstStatus({});
		expect(result.subscribes.map((m) => m.replay)).toEqual([undefined, true]);
		await replayed(result);
	});

	it("guard: new page + new runtime: explicit repeatable: false ends at once, without a round trip", async () => {
		endedAtOnce(await lostBeforeFirstStatus({ repeatable: false }));
	});

	it("new page + old runtime: an adapter-default non-repeatable request ends interrupted at once; nothing is replayed", async () => {
		endedAtOnce(
			await lostBeforeFirstStatus({}, { old: true, adapterRepeatable: false }),
		);
	});

	it("new page + old runtime: a request without a flag or a status ends interrupted even when the adapter would repeat it (fail closed)", async () => {
		endedAtOnce(await lostBeforeFirstStatus({}, { old: true }));
	});

	it("guard: new page + old runtime: explicit repeatable: false ends at once", async () => {
		endedAtOnce(
			await lostBeforeFirstStatus({ repeatable: false }, { old: true }),
		);
	});

	it("guard: new page + old runtime: an explicit repeatable: true is replayed, without a marker", async () => {
		const result = await lostBeforeFirstStatus(
			{ repeatable: true },
			{ old: true },
		);
		expect(result.subscribes.map((m) => m.replay)).toEqual([
			undefined,
			undefined,
		]);
		await replayed(result);
	});

	it("guard: new page + old runtime: a request its first status proved repeatable is replayed, without a marker", async () => {
		const { client, host, clock } = makeClient(fast);
		const subscribes = wire(host, { old: true });
		client.start();
		await settle(clock);
		const log = observe();
		const handle = client.subscribe(feed({ topic: "t" }), log.observer);
		await settle(clock);
		host.fireError();
		await tick(clock, 1_500, 50);
		expect(client.status.get().generation).toBe(2);
		expect(subscribes.map((m) => m.replay)).toEqual([undefined, undefined]);
		expect(log.log.errors).toEqual([]);
		expect(handle.status.get().active).toBe(true);
		const upstream = onTopic(host, "t");
		upstream[upstream.length - 1]?.emit(7);
		await settle(clock);
		expect(log.log.events).toEqual([7]);
	});
});
