import { afterEach, describe, expect, it, vi } from "vitest";
import {
	reportInterruption,
	setRecoveryPending,
} from "../../../src/core/continuity-phase.ts";
import {
	type ReconcileContext,
	reconcileLatest,
	reconcileOnLoss,
} from "../../../src/core/reconcile.ts";
import { createStore } from "../../../src/core/store.ts";
import type {
	ConnectionState,
	ContinuityReason,
	ContinuityState,
	Subscription,
	SubscriptionStatus,
} from "../../../src/core/types.ts";
import { disposeAll, feed, makeClient, observe } from "./helpers/client.ts";
import { settle, tick } from "./helpers/clock.ts";

// Scripted handles isolate reconcile policy; separate multi-tab cases exercise the real client and runtime.

afterEach(() => {
	disposeAll();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

/** A handle whose status the test drives; markReconciled behaves as the client's. */
function scripted(connection: ConnectionState = "connected") {
	let since = 0;
	const store = createStore<SubscriptionStatus>({
		active: true,
		connection: { state: connection, since },
		continuity: { state: "continuous", since },
	});
	const calls: string[] = [];
	const subscription: Subscription<unknown> = {
		id: "s1",
		status: store,
		update() {},
		retry() {},
		unsubscribe() {},
		markReconciled(options) {
			calls.push(options?.pending ? "pending" : "reconciled");
			if (options?.pending) return;
			since += 1;
			store.set({
				...store.get(),
				continuity: { state: "continuous", reason: "reconciled", since },
			});
		},
	};
	return {
		subscription,
		calls,
		notice(
			state: ContinuityState,
			reason: ContinuityReason,
			at?: number,
			pending = false,
		) {
			since = at ?? since + 1;
			if (pending) setRecoveryPending(store, true);
			store.set({ ...store.get(), continuity: { state, reason, since } });
		},
		/** A newer notice identical to the current one, `since` included. */
		repeat() {
			store.set({ ...store.get(), continuity: { ...store.get().continuity } });
		},
		connect(state: ConnectionState, at?: number) {
			setRecoveryPending(store, false);
			since = at ?? since + 1;
			store.set({ ...store.get(), connection: { state, since } });
		},
		continuity: () => store.get().continuity,
	};
}

function deferred() {
	let resolve!: () => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<void>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("reconcileOnLoss (scripted handle)", () => {
	it.each([
		"overflow",
	] as const)("E4 a live %s gap refreshes immediately without waiting for reconnection", async (reason) => {
		const handle = scripted();
		const refresh = vi.fn();
		reconcileOnLoss(handle.subscription, refresh);
		handle.notice("gap", reason, 0);
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(handle.calls).toEqual(["pending"]);
		await flush();
		expect(handle.calls).toEqual(["pending", "reconciled"]);
	});

	it.each([
		"message-too-large",
		"event-not-serialisable",
	] as const)("invalid %s delivery stays stopped rather than automatically retrying the payload", async (reason) => {
		const handle = scripted();
		const refresh = vi.fn();
		reconcileOnLoss(handle.subscription, refresh);
		handle.notice("gap", reason);
		await flush();
		expect(refresh).not.toHaveBeenCalled();
		expect(handle.calls).toEqual([]);
		expect(handle.continuity().state).toBe("gap");
	});

	it("superseding loss aborts the old refresh before a guarded application write", async () => {
		const handle = scripted();
		const first = deferred();
		const contexts: ReconcileContext[] = [];
		const writes: number[] = [];
		reconcileOnLoss(handle.subscription, async (context) => {
			contexts.push(context);
			const n = contexts.length;
			if (n === 1) await first.promise;
			if (!context.signal.aborted) writes.push(n);
		});
		handle.notice("gap", "overflow");
		handle.notice("unknown", "scope-changed");
		expect(contexts[0]?.signal.aborted).toBe(true);
		first.resolve();
		await flush();
		expect(writes).toEqual([2]);
		expect(handle.continuity().state).toBe("continuous");
	});

	it("a failed refresh cannot retry an invalid payload on reconnection", async () => {
		const handle = scripted();
		const refresh = vi.fn(async () => {
			throw new Error("refresh failed");
		});
		const onError = vi.fn();
		reconcileOnLoss(handle.subscription, refresh, { onError });
		handle.notice("gap", "overflow");
		await flush();
		expect(onError).toHaveBeenCalledOnce();
		handle.connect("reconnecting");
		handle.notice("gap", "message-too-large");
		handle.connect("connected");
		await flush();
		expect(refresh).toHaveBeenCalledOnce();
		expect(handle.continuity().reason).toBe("message-too-large");
	});

	it.each([
		"stop",
		"disconnect",
	] as const)("%s aborts an in-flight refresh and prevents late reconciliation", async (reason) => {
		const handle = scripted();
		const run = deferred();
		let context: ReconcileContext | undefined;
		const stop = reconcileOnLoss(handle.subscription, (value) => {
			context = value;
			return run.promise;
		});
		handle.notice("gap", "overflow");
		if (reason === "stop") stop();
		else handle.connect("reconnecting");
		expect(context?.signal.aborted).toBe(true);
		run.resolve();
		await flush();
		expect(handle.calls).not.toContain("reconciled");
	});

	it.each([
		"reconnected",
		"reopened",
		"lease-expired",
	] as const)("E4 late attachment to an already connected sticky %s loss refreshes immediately", async (reason) => {
		const handle = scripted();
		handle.notice("unknown", reason, -5);
		const refresh = vi.fn();
		reconcileOnLoss(handle.subscription, refresh);
		expect(refresh).toHaveBeenCalledTimes(1);
		await flush();
		expect(handle.calls).toEqual(["reconciled"]);
	});
	it("a stopped gap restarts delivery first (pending), refreshes, then declares reconciled", async () => {
		const handle = scripted();
		const run = deferred();
		const refresh = vi.fn((_context: ReconcileContext) => run.promise);
		reconcileOnLoss(handle.subscription, refresh);
		handle.notice("gap", "overflow");
		expect(handle.calls).toEqual(["pending"]);
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(refresh.mock.calls[0]?.[0]).toMatchObject({
			continuity: { state: "gap", reason: "overflow" },
			status: { connection: { state: "connected" } },
		});
		expect(handle.continuity().state).toBe("gap");
		run.resolve();
		await flush();
		expect(handle.calls).toEqual(["pending", "reconciled"]);
		expect(handle.continuity()).toMatchObject({ state: "continuous" });
	});

	it("a loss already present when the engine starts is handled", async () => {
		const handle = scripted();
		handle.notice("unknown", "runtime-replaced");
		const refresh = vi.fn();
		reconcileOnLoss(handle.subscription, refresh);
		expect(refresh).toHaveBeenCalledTimes(1);
		await flush();
		expect(handle.calls).toEqual(["reconciled"]);
	});

	it("refreshes only while connected: notices while disconnected wait and coalesce into one refresh at connected", async () => {
		const handle = scripted("reconnecting");
		const refresh = vi.fn();
		reconcileOnLoss(handle.subscription, refresh);
		handle.notice("unknown", "reconnected"); // early notice
		handle.notice("unknown", "reconnected"); // outcome notice
		expect(refresh).not.toHaveBeenCalled();
		handle.connect("connected");
		expect(refresh).toHaveBeenCalledTimes(1);
		await flush();
		expect(handle.calls).toEqual(["reconciled"]);
	});

	it.each([
		0, -5,
	])("E4 early and outcome loss notices coalesce until restored connection even with clock %s", async (at) => {
		const handle = scripted();
		const refresh = vi.fn();
		reconcileOnLoss(handle.subscription, refresh);
		handle.notice("unknown", "reconnected", at, true);
		await flush();
		expect(refresh).not.toHaveBeenCalled();
		expect(handle.calls).toEqual([]);
		handle.connect("reconnecting", at);
		await flush();
		handle.notice("unknown", "reconnected", at);
		expect(refresh).not.toHaveBeenCalled();
		handle.connect("connected", at - 1);
		expect(refresh).toHaveBeenCalledTimes(1);
		await flush();
		expect(handle.calls).toEqual(["reconciled"]);
	});

	it("coalescing: newer notices during a refresh run it once more and only then declare reconciled", async () => {
		const handle = scripted();
		const runs = [deferred(), deferred()];
		let index = 0;
		const refresh = vi.fn(() => runs[index++]?.promise);
		reconcileOnLoss(handle.subscription, refresh);
		handle.notice("gap", "overflow");
		handle.notice("gap", "overflow");
		handle.notice("gap", "overflow");
		expect(refresh).toHaveBeenCalledTimes(1);
		runs[0]?.resolve();
		await flush();
		expect(handle.calls).not.toContain("reconciled");
		expect(refresh).toHaveBeenCalledTimes(2);
		runs[1]?.resolve();
		await flush();
		expect(refresh).toHaveBeenCalledTimes(2);
		expect(handle.calls.filter((call) => call === "reconciled")).toHaveLength(
			1,
		);
		expect(handle.continuity().state).toBe("continuous");
	});

	it("coalescing: a newer notice in the same millisecond (same since) during a refresh still runs it once more", async () => {
		const handle = scripted();
		const runs = [deferred(), deferred()];
		let index = 0;
		const refresh = vi.fn(() => runs[index++]?.promise);
		reconcileOnLoss(handle.subscription, refresh);
		handle.notice("gap", "overflow");
		handle.repeat();
		expect(handle.calls).toEqual(["pending", "pending"]);
		runs[0]?.resolve();
		await flush();
		expect(handle.calls).not.toContain("reconciled");
		expect(refresh).toHaveBeenCalledTimes(2);
		expect(handle.continuity().state).toBe("gap");
	});

	it("a failed refresh keeps continuity non-continuous, reports through onError and retries on the next notice or at connected, never on a timer", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"] });
		const handle = scripted();
		const onError = vi.fn();
		const failure = new Error("reload failed");
		const refresh = vi.fn().mockRejectedValue(failure);
		reconcileOnLoss(handle.subscription, refresh, { onError });
		handle.notice("gap", "overflow");
		await flush();
		expect(onError).toHaveBeenCalledWith(failure);
		expect(handle.continuity().state).toBe("gap");
		expect(handle.calls).toEqual(["pending"]);
		vi.advanceTimersByTime(600_000);
		await flush();
		expect(refresh).toHaveBeenCalledTimes(1);
		// At the next `connected`.
		handle.connect("reconnecting");
		handle.connect("connected");
		expect(refresh).toHaveBeenCalledTimes(2);
		await flush();
		// On the next notice.
		refresh.mockResolvedValue(undefined);
		handle.notice("gap", "overflow");
		expect(refresh).toHaveBeenCalledTimes(3);
		await flush();
		expect(handle.continuity().state).toBe("continuous");
		expect(onError).toHaveBeenCalledTimes(2);
	});

	it("without onError a failed or throwing refresh goes to reportError", async () => {
		const reportError = vi.fn();
		vi.stubGlobal("reportError", reportError);
		const handle = scripted();
		const failure = new Error("sync failure");
		reconcileOnLoss(handle.subscription, () => {
			throw failure;
		});
		handle.notice("unknown", "replay-reset");
		await flush();
		expect(reportError).toHaveBeenCalledWith(failure);
		expect(handle.continuity().state).toBe("unknown");
	});

	it("stop() ends the engine: an in-flight refresh declares nothing and later notices are ignored", async () => {
		const handle = scripted();
		const run = deferred();
		const refresh = vi.fn(() => run.promise);
		const stop = reconcileOnLoss(handle.subscription, refresh);
		handle.notice("gap", "overflow");
		stop();
		run.resolve();
		await flush();
		handle.notice("gap", "overflow");
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(handle.calls).toEqual(["pending"]);
	});
});

describe("reconcileLatest", () => {
	it("latest: a loss notice restarts delivery (pending) and the next delivered event declares reconciled", () => {
		const handle = scripted();
		const latest = reconcileLatest(handle.subscription);
		latest.onEvent();
		expect(handle.calls).toEqual([]);
		handle.notice("gap", "overflow");
		expect(handle.calls).toEqual(["pending"]);
		expect(handle.continuity().state).toBe("gap");
		latest.onEvent();
		expect(handle.calls).toEqual(["pending", "reconciled"]);
		latest.onEvent();
		expect(handle.calls).toEqual(["pending", "reconciled"]);
		latest.stop();
		handle.notice("unknown", "reconnected");
		latest.onEvent();
		expect(handle.calls).toEqual(["pending", "reconciled"]);
	});
});

describe("reconcileOnLoss with the real client", () => {
	for (const sharing of ["prefer", "off"] as const) {
		it.each([
			0, -10_000,
		])(`E4 ${sharing}: ordered MessagePort loss waits for restored connected with clock step %s`, async (step) => {
			const { client, host, local, clock } = makeClient({ sharing });
			const handle = client.subscribe(feed(), observe().observer);
			await settle(clock);
			const test = sharing === "off" ? local.test : host.test;
			const ctx = test.connections[0]?.ctx;
			expect(ctx).toBeDefined();
			ctx?.setStatus({ state: "connected" });
			await settle(clock);
			const refresh = vi.fn();
			reconcileOnLoss(handle, refresh);
			clock.jump(step);
			reportInterruption(test.last().sink, "reconnected");
			await settle(clock);
			expect(handle.status.get().connection.state).toBe("connected");
			expect(refresh).not.toHaveBeenCalled();
			ctx?.setStatus({ state: "reconnecting" });
			await settle(clock);
			test.last().sink.continuity("reconnected");
			await settle(clock);
			expect(refresh).not.toHaveBeenCalled();
			ctx?.setStatus({ state: "connected" });
			await settle(clock);
			expect(refresh).toHaveBeenCalledTimes(1);
			expect(handle.status.get().continuity.state).toBe("continuous");
		});
	}

	it("F-1: no event is lost after an overflow while the refresh runs", async () => {
		const { client, host, clock } = makeClient({
			limits: { maxPendingMessagesPerConsumer: 2, maxPendingMessages: 2 },
		});
		client.start();
		await settle(clock);
		const { log, observer } = observe();
		const handle = client.subscribe(feed(), observer);
		await settle(clock);
		host.test.connections[0]?.ctx.setStatus({ state: "connected" });
		await settle(clock);
		const run = deferred();
		const refresh = vi.fn(() => run.promise);
		reconcileOnLoss(handle, refresh);
		// Three events in one runtime task: the third overflows before any ack.
		for (let n = 1; n <= 3; n += 1) host.test.last().emit(n);
		await settle(clock);
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(handle.status.get().continuity.state).toBe("gap");
		// Events produced while the application refreshes are delivered.
		host.test.last().emit(4);
		await settle(clock);
		host.test.last().emit(5);
		await settle(clock);
		expect(log.events).toEqual([1, 2, 4, 5]);
		expect(handle.status.get().continuity.state).toBe("gap");
		run.resolve();
		await settle(clock);
		expect(handle.status.get().continuity).toMatchObject({
			state: "continuous",
			reason: "reconciled",
		});
	});

	it("F-2: an overflowed 50 ms feed with a 500 ms reload still reaches continuous", async () => {
		const { client, host, clock } = makeClient({
			limits: { maxPendingMessagesPerConsumer: 2, maxPendingMessages: 2 },
		});
		client.start();
		await settle(clock);
		const { log, observer } = observe();
		const handle = client.subscribe(feed(), observer);
		await settle(clock);
		host.test.connections[0]?.ctx.setStatus({ state: "connected" });
		await settle(clock);
		const refresh = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					clock.setTimeout(resolve, 500);
				}),
		);
		reconcileOnLoss(handle, refresh);
		let n = 0;
		const producer = () => {
			n += 1;
			host.test.last().emit(n);
			clock.setTimeout(producer, 50);
		};
		// A burst overflows once, then the feed runs every 50 ms.
		for (let burst = 0; burst < 3; burst += 1) {
			n += 1;
			host.test.last().emit(n);
		}
		clock.setTimeout(producer, 50);
		await settle(clock);
		expect(handle.status.get().continuity.reason).toBe("overflow");
		await tick(clock, 1_000, 50);
		expect(handle.status.get().continuity).toMatchObject({
			state: "continuous",
			reason: "reconciled",
		});
		expect(refresh).toHaveBeenCalledTimes(1);
		// Every event after the overflow arrived: nothing lost during the reload.
		const after = log.events.slice(2) as number[];
		expect(after[0]).toBe(4);
		expect(after.every((value, index) => value === 4 + index)).toBe(true);
		expect(after.length).toBeGreaterThanOrEqual(18);
	});

	it("without onError a failed refresh takes the client's path: onCallbackError, else env.reportError", async () => {
		const globalReport = vi.fn();
		vi.stubGlobal("reportError", globalReport);
		const failure = new Error("refresh failed");
		for (const onCallbackError of [vi.fn(), undefined]) {
			const { client, host, clock, kit } = makeClient({
				limits: { maxPendingMessagesPerConsumer: 2, maxPendingMessages: 2 },
				...(onCallbackError ? { onCallbackError } : {}),
			});
			client.start();
			await settle(clock);
			const handle = client.subscribe(feed(), { next() {}, status() {} });
			reconcileOnLoss(handle, () => Promise.reject(failure));
			await settle(clock);
			host.test.connections[0]?.ctx.setStatus({ state: "connected" });
			await settle(clock);
			for (let n = 1; n <= 3; n += 1) host.test.last().emit(n);
			await settle(clock);
			expect(handle.status.get().continuity.reason).toBe("overflow");
			const reporter = onCallbackError ?? kit.reportError;
			expect(reporter).toHaveBeenCalledTimes(1);
			expect(reporter.mock.calls[0]?.[0]).toBe(failure);
			if (onCallbackError) expect(kit.reportError).not.toHaveBeenCalled();
		}
		expect(globalReport).not.toHaveBeenCalled();
	});

	it("N tabs refresh N times: no cross-tab coordination", async () => {
		const first = makeClient();
		const second = makeClient({}, { host: first.host, clock: first.clock });
		const { clock, host } = first;
		first.client.start();
		second.client.start();
		await settle(clock);
		const a = first.client.subscribe(feed(), observe().observer);
		const b = second.client.subscribe(feed(), observe().observer);
		await settle(clock);
		host.test.connections[0]?.ctx.setStatus({ state: "connected" });
		await settle(clock);
		expect(host.test.all()).toHaveLength(1);
		const refresh = vi.fn();
		reconcileOnLoss(a, refresh);
		reconcileOnLoss(b, refresh);
		reportInterruption(host.test.last().sink, "reconnected");
		await settle(clock);
		expect(refresh).not.toHaveBeenCalled();
		host.test.connections[0]?.ctx.setStatus({ state: "reconnecting" });
		await settle(clock);
		host.test.last().sink.continuity("reconnected");
		await settle(clock);
		host.test.connections[0]?.ctx.setStatus({ state: "connected" });
		await settle(clock);
		expect(refresh).toHaveBeenCalledTimes(2);
		expect(a.status.get().continuity.state).toBe("continuous");
		expect(b.status.get().continuity.state).toBe("continuous");
	});
});
