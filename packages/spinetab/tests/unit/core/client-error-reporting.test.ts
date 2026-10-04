import { afterEach, describe, expect, it, vi } from "vitest";
import {
	reconcileLatest,
	reconcileOnLoss,
} from "../../../src/core/reconcile.ts";
import { summariseStatus } from "../../../src/core/summary.ts";
import type {
	ConnectionState,
	SubscriptionStatus,
} from "../../../src/core/types.ts";
import {
	isCredentials,
	refuseCredentialCarriers,
} from "../../../src/core/validate.ts";
import { disposeAll, feed, makeClient, observe } from "./helpers/client.ts";
import { settle } from "./helpers/clock.ts";

afterEach(() => {
	disposeAll();
	vi.unstubAllGlobals();
});

async function shared(options = {}) {
	const harness = makeClient(options);
	harness.client.start();
	await settle(harness.clock);
	return harness;
}

const reportsOf = (spy: ReturnType<typeof vi.fn>) =>
	spy.mock.calls.map(([error]) => ({
		code: String((error as { code?: unknown }).code),
		message: String((error as Error).message),
	}));

describe("default error reporting", () => {
	it("V-W3-1 a terminal error whose code is upstream text reports no upstream text", async () => {
		const harness = await shared();
		harness.client.subscribe(feed(), () => {});
		await settle(harness.clock);
		// An adapter handing an upstream error object with its own string code
		// (toSerialisedError passes any string code through).
		harness.host.test.last().sink.error({
			code: "Bearer CANARY-TOKEN",
			message: "upstream said no",
		} as never);
		await settle(harness.clock);
		const found = reportsOf(harness.kit.reportError);
		expect(found).toHaveLength(1);
		expect(JSON.stringify(found)).not.toContain("CANARY");
	});

	it("V-W3-2 reconcileOnLoss without onError reports a failed refresh through the client's onCallbackError", async () => {
		const globalReport = vi.fn();
		vi.stubGlobal("reportError", globalReport);
		const onCallbackError = vi.fn();
		const harness = await shared({
			onCallbackError,
			limits: { maxPendingMessagesPerConsumer: 2, maxPendingMessages: 2 },
		});
		const handle = harness.client.subscribe(feed(), () => {});
		reconcileOnLoss(handle, () => Promise.reject(new Error("refresh failed")));
		await settle(harness.clock);
		harness.host.test.connections[0]?.ctx.setStatus({ state: "connected" });
		await settle(harness.clock);
		for (let n = 1; n <= 3; n += 1) harness.host.test.last().emit(n);
		await settle(harness.clock);
		expect(handle.status.get().continuity.reason).toBe("overflow");
		// Without onError, use onCallbackError when set, else env.reportError.
		expect(onCallbackError).toHaveBeenCalled();
		expect(globalReport).not.toHaveBeenCalled();
	});
});

describe("reconcileOnLoss coalescing", () => {
	async function overflowTwice(advanceBetween: boolean) {
		const harness = await shared({
			limits: { maxPendingMessagesPerConsumer: 2, maxPendingMessages: 2 },
		});
		const { log, observer } = observe();
		const handle = harness.client.subscribe(feed(), observer);
		const resolvers: Array<() => void> = [];
		const refresh = vi.fn(
			() => new Promise<void>((resolve) => resolvers.push(resolve)),
		);
		reconcileOnLoss(handle, refresh);
		await settle(harness.clock);
		harness.host.test.connections[0]?.ctx.setStatus({ state: "connected" });
		await settle(harness.clock);
		for (let n = 1; n <= 3; n += 1) harness.host.test.last().emit(n);
		await settle(harness.clock);
		expect(refresh).toHaveBeenCalledTimes(1);
		if (advanceBetween) harness.clock.advance(1);
		// A second overflow while the first refresh is still running.
		for (let n = 4; n <= 6; n += 1) harness.host.test.last().emit(n);
		await settle(harness.clock);
		const second = handle.status.get().continuity;
		resolvers[0]?.();
		await settle(harness.clock);
		return { handle, refresh, second, log, harness };
	}

	it("V-W6-1 (control) a newer overflow one millisecond later during a refresh runs once more", async () => {
		const { handle, refresh, second } = await overflowTwice(true);
		expect(second).toMatchObject({ state: "gap", reason: "overflow" });
		expect(refresh).toHaveBeenCalledTimes(2);
		expect(handle.status.get().continuity.state).toBe("gap");
	});

	it("V-W6-2 a newer overflow in the same millisecond during a refresh is not declared reconciled", async () => {
		const { handle, refresh, second } = await overflowTwice(false);
		expect(second).toMatchObject({ state: "gap", reason: "overflow" });
		// Reconcile only if no newer notice arrived.
		expect(handle.status.get().continuity.state).toBe("gap");
		expect(refresh).toHaveBeenCalledTimes(2);
	});

	it("V-W6-3 reconcileLatest suppresses the continuity-lost report and reconciles on the next event", async () => {
		const harness = await shared({
			limits: { maxPendingMessagesPerConsumer: 2, maxPendingMessages: 2 },
		});
		const handle = harness.client.subscribe(feed(), () => {
			latest.onEvent();
		});
		const latest = reconcileLatest(handle);
		await settle(harness.clock);
		harness.host.test.connections[0]?.ctx.setStatus({ state: "connected" });
		await settle(harness.clock);
		for (let n = 1; n <= 3; n += 1) harness.host.test.last().emit(n);
		await settle(harness.clock);
		expect(harness.kit.reportError).not.toHaveBeenCalled();
		harness.host.test.last().emit(4);
		await settle(harness.clock);
		expect(handle.status.get().continuity).toMatchObject({
			state: "continuous",
			reason: "reconciled",
		});
	});
});

describe("summary", () => {
	const status = (
		state: ConnectionState,
		extra: Partial<SubscriptionStatus> = {},
		reason?: string,
	): SubscriptionStatus => ({
		active: true,
		connection: { state, since: 0, ...(reason ? { reason } : {}) } as never,
		continuity: { state: "continuous", since: 0 },
		...extra,
	});
	it.each([
		["inactive", "idle"],
		["connecting", "connecting"],
		["connected", "live"],
		["reconnecting", "reconnecting"],
		["auth-blocked", "blocked"],
		["retry-exhausted", "blocked"],
		["failed", "ended"],
		["disposed", "ended"],
	] as const)("V-W6-4 %s maps to %s", (state, phase) => {
		expect(summariseStatus(status(state)).phase).toBe(phase);
	});
	it("V-W6-5 reattaching and needsReconcile", () => {
		expect(
			summariseStatus(status("connecting", {}, "runtime-replaced")).phase,
		).toBe("reattaching");
		for (const [state, needs] of [
			["gap", true],
			["unknown", true],
			["resumed", false],
			["continuous", false],
		] as const) {
			expect(
				summariseStatus(
					status("connected", { continuity: { state, since: 0 } }),
				).needsReconcile,
			).toBe(needs);
		}
	});
});

describe("closed provider result", () => {
	it.each([
		[{ connectionParams: { at: new Date(0) } }],
		[{ connectionParams: { list: new Map([["a", 1]]) } }],
		[{ auth: { n: Number.NaN } }],
		[{ auth: { nested: { u: undefined } } }],
	])("V-S10-1 %o is not Record<string, Json> and is refused", (value) => {
		expect(isCredentials(value)).toBe(false);
	});

	it("V-S10-2 the page never replies ok with a non-JSON connectionParams value", async () => {
		const harness = makeClient({
			credentials: () => ({ connectionParams: { at: new Date(0) } }),
		});
		harness.client.start();
		const sent: Array<Record<string, unknown>> = [];
		harness.host.lastRelay().drop = (data, toRuntime) => {
			if (toRuntime) sent.push(data as Record<string, unknown>);
			return false;
		};
		await settle(harness.clock);
		const hello = sent.find((message) => message.t === "hello");
		harness.host.lastRelay().host.postMessage({
			v: 1,
			t: "credentialsRequest",
			a: hello?.a,
			g: hello?.g,
			k: 1_000,
			id: "ask-1",
			scope: hello?.scope,
			revision: null,
			reason: "connect",
		});
		await settle(harness.clock);
		const reply = sent.find((message) => message.t === "credentials");
		expect(reply).toMatchObject({ ok: false });
	});
});

describe("carriers", () => {
	it("V-S9-1 token-named keys and credential headers are refused case-insensitively", () => {
		expect(() =>
			refuseCredentialCarriers({ Access_Token: "x" }, "options.query"),
		).toThrowError(expect.objectContaining({ code: "unsupported-option" }));
		expect(() =>
			refuseCredentialCarriers({ a: [{ JWT: "x" }] }, "o.connectionParams"),
		).toThrowError(expect.objectContaining({ code: "unsupported-option" }));
		expect(() =>
			refuseCredentialCarriers({ "X-Api-Key": "x" }, "o.headers"),
		).toThrowError(expect.objectContaining({ code: "unsupported-option" }));
		expect(() =>
			refuseCredentialCarriers(["graphql-ws", "Bearer.x"], "o.subprotocols"),
		).toThrowError(expect.objectContaining({ code: "unsupported-option" }));
	});

	it("V-S9-2 messages never carry the value", () => {
		try {
			refuseCredentialCarriers({ token: "CANARY" }, "o.auth");
		} catch (error) {
			expect(JSON.stringify(error)).not.toContain("CANARY");
			expect((error as Error).message).not.toContain("CANARY");
		}
	});

	it("V-S9-3 a token key nested deeper than 32 levels is still refused", () => {
		let value: Record<string, unknown> = { token: "x" };
		for (let depth = 0; depth < 40; depth += 1) value = { n: value };
		expect(() =>
			refuseCredentialCarriers(value, "options.connectionParams"),
		).toThrowError(expect.objectContaining({ code: "unsupported-option" }));
	});
});

describe("edges", () => {
	it("V-S4-1 setScope refuses a string revision without changing scope", async () => {
		const harness = await shared();
		expect(() =>
			harness.client.setScope("next", "3" as unknown as number),
		).toThrowError(expect.objectContaining({ code: "unsupported-option" }));
		expect(harness.client.scope).toBe("");
		expect(() => harness.client.setCredentialRevision(-1)).toThrowError(
			expect.objectContaining({ code: "unsupported-option" }),
		);
		expect(() =>
			harness.client.setCredentialRevision(Number.MAX_SAFE_INTEGER + 1),
		).toThrowError(expect.objectContaining({ code: "unsupported-option" }));
		expect(() => makeClient({ credentialRevision: "1" as never })).toThrowError(
			expect.objectContaining({ code: "unsupported-option" }),
		);
	});

	it("V-W2-1 an anonymous page's hello never carries its revision and no option reaches the audience", async () => {
		const harness = makeClient({
			anonymous: true,
			credentialRevision: 9,
			baseUrl: "https://evil.test/",
		});
		harness.client.start();
		const sent: Array<Record<string, unknown>> = [];
		harness.host.lastRelay().drop = (data, toRuntime) => {
			if (toRuntime) sent.push(data as Record<string, unknown>);
			return false;
		};
		await settle(harness.clock);
		const hello = sent.find((message) => message.t === "hello");
		expect(hello).toMatchObject({
			anonymous: true,
			credentials: false,
			revision: null,
		});
		expect(Object.keys(hello ?? {})).not.toContain("credentialOrigins");
		expect(() =>
			makeClient({ credentialOrigins: ["https://evil.test"] } as never),
		).toThrowError(expect.objectContaining({ code: "unsupported-option" }));
	});
});
