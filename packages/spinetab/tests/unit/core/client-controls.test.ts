import { afterEach, describe, expect, it, vi } from "vitest";
import { createClientWithEnv } from "../../../src/core/client.ts";
import { reconcileOnLoss } from "../../../src/core/reconcile.ts";
import { summariseStatus } from "../../../src/core/summary.ts";
import type { ConsumerJson } from "../../../src/core/types.ts";
import { disposeAll, feed, makeClient, observe } from "./helpers/client.ts";
import { ManualClock, settle } from "./helpers/clock.ts";
import { createTestEnv } from "./helpers/env.ts";
import { FakeWorkerHost } from "./helpers/worker.ts";

afterEach(disposeAll);

async function shared(options = {}, settings = {}) {
	const harness = makeClient(options, settings);
	harness.client.start();
	await settle(harness.clock);
	return harness;
}

/** Record every page→runtime message on the current relay. */
function recordSent(harness: Awaited<ReturnType<typeof shared>>) {
	const sent: Array<Record<string, unknown>> = [];
	harness.host.lastRelay().drop = (data, toRuntime) => {
		if (toRuntime) sent.push(data as Record<string, unknown>);
		return false;
	};
	return sent;
}

describe("consumer options accept optional properties", () => {
	it("strips undefined values before posting subscribe and update", async () => {
		const harness = await shared();
		const sent = recordSent(harness);
		const optional: { intervalMs?: number; onJoin: string } = {
			intervalMs: undefined,
			onJoin: "await",
		};
		const consumer: ConsumerJson = optional;
		const handle = harness.client.subscribe(feed(), observe().observer, {
			consumer,
		});
		await settle(harness.clock);
		const subscribe = sent.find((message) => message.t === "subscribe");
		expect(subscribe?.options).toEqual({ onJoin: "await" });
		expect(Object.hasOwn(subscribe?.options as object, "intervalMs")).toBe(
			false,
		);
		handle.update({ intervalMs: undefined, onJoin: "immediate" });
		await settle(harness.clock);
		const update = sent.find((message) => message.t === "update");
		expect(update?.consumer).toEqual({ onJoin: "immediate" });
		expect(Object.hasOwn(update?.consumer as object, "intervalMs")).toBe(false);
		const upstream = harness.host.test.last();
		const [entry] = [...upstream.consumers.values()];
		expect(Object.hasOwn(entry?.options as object, "intervalMs")).toBe(false);
	});
});

describe("per-handle retry", () => {
	it("Subscription.retry() posts retry with its own consumer id; client.retry() stays client-wide", async () => {
		const harness = await shared();
		const sent = recordSent(harness);
		const a = harness.client.subscribe(feed({ f: "a" }), observe().observer);
		const b = harness.client.subscribe(feed({ f: "b" }), observe().observer);
		await settle(harness.clock);
		const ids = sent
			.filter((message) => message.t === "subscribe")
			.map((message) => message.c);
		b.retry();
		a.retry();
		harness.client.retry();
		await settle(harness.clock);
		const retries = sent
			.filter((message) => message.t === "retry")
			.map(({ t, c }) => ({ t, c }));
		expect(retries).toEqual([
			{ t: "retry", c: ids[1] },
			{ t: "retry", c: ids[0] },
			{ t: "retry", c: undefined },
		]);
		a.unsubscribe();
		a.retry();
		await settle(harness.clock);
		expect(sent.filter((message) => message.t === "retry")).toHaveLength(3);
	});
});

describe("markReconciled({ pending: true })", () => {
	it("pending restarts stopped delivery and keeps continuity non-continuous; plain markReconciled() then reconciles", async () => {
		const harness = await shared({
			limits: { maxPendingMessagesPerConsumer: 2, maxPendingMessages: 2 },
		});
		const { client, host, clock } = harness;
		const sent = recordSent(harness);
		const { log, observer } = observe();
		const handle = client.subscribe(feed(), observer);
		await settle(clock);
		// Three events in one runtime task: the third overflows before any ack.
		for (let n = 1; n <= 3; n += 1) host.test.last().emit(n);
		await settle(clock);
		const gap = handle.status.get().continuity;
		expect(gap).toMatchObject({ state: "gap", reason: "overflow" });
		handle.markReconciled({ pending: true });
		expect(handle.status.get().continuity).toBe(gap);
		// A pending reconcile in flight still needs reconciling.
		expect(summariseStatus(handle.status.get()).needsReconcile).toBe(true);
		await settle(clock);
		expect(sent.filter((message) => message.t === "reconcile")).toHaveLength(1);
		host.test.last().emit(4);
		await settle(clock);
		expect(log.events).toEqual([1, 2, 4]);
		expect(handle.status.get().continuity).toBe(gap);
		// Not stopped any more: a second pending call posts nothing.
		handle.markReconciled({ pending: true });
		await settle(clock);
		expect(sent.filter((message) => message.t === "reconcile")).toHaveLength(1);
		handle.markReconciled();
		expect(handle.status.get().continuity).toMatchObject({
			state: "continuous",
			reason: "reconciled",
		});
		await settle(clock);
		expect(sent.filter((message) => message.t === "reconcile")).toHaveLength(1);
	});
});

/** Start a client and record its page→runtime messages from the first hello. */
async function started(options = {}, settings = {}) {
	const harness = makeClient(options, settings);
	harness.client.start();
	const sent = recordSent(harness as Awaited<ReturnType<typeof shared>>);
	await settle(harness.clock);
	return { ...harness, sent };
}

/** Post a runtime→page credentials request on the current attachment. */
function askForCredentials(
	harness: Awaited<ReturnType<typeof started>>,
	id = "ask-1",
) {
	const hello = harness.sent.filter((message) => message.t === "hello").at(-1);
	harness.host.lastRelay().host.postMessage({
		v: 1,
		t: "credentialsRequest",
		a: hello?.a,
		g: hello?.g,
		k: 1_000,
		id,
		scope: hello?.scope,
		revision: null,
		reason: "connect",
	});
}

describe("anonymous pages (page side)", () => {
	it("anonymous: true with credentials is unsupported-option naming both; anonymous must be a boolean", () => {
		expect(() =>
			makeClient({ anonymous: true, credentials: () => ({}) }),
		).toThrowError(
			expect.objectContaining({
				code: "unsupported-option",
				message: expect.stringMatching(/anonymous.*credentials/),
			}),
		);
		expect(() =>
			makeClient({ anonymous: "yes" as unknown as boolean }),
		).toThrowError(expect.objectContaining({ code: "unsupported-option" }));
		expect(() =>
			makeClient({ anonymous: false, credentials: () => ({}) }),
		).not.toThrow();
	});

	it("hello carries anonymous: true (and only on anonymous pages), also after setScope", async () => {
		const plain = await started();
		const plainHello = plain.sent.find((message) => message.t === "hello");
		expect(plainHello).toBeDefined();
		expect(Object.hasOwn(plainHello as object, "anonymous")).toBe(false);
		const anonymous = await started({ anonymous: true, credentialRevision: 4 });
		const hello = anonymous.sent.find((message) => message.t === "hello");
		expect(hello).toMatchObject({
			anonymous: true,
			credentials: false,
			revision: null,
		});
		anonymous.client.subscribe(feed(), observe().observer);
		await settle(anonymous.clock);
		anonymous.client.setScope("next", 5);
		// setScope re-attaches synchronously on a new port: record its hello.
		const again = recordSent(anonymous as Awaited<ReturnType<typeof shared>>);
		await settle(anonymous.clock);
		expect(again.find((message) => message.t === "hello")).toMatchObject({
			scope: "next",
			anonymous: true,
			credentials: false,
			revision: null,
		});
	});

	it("an anonymous page never answers credential requests and never sends revision changes", async () => {
		const anonymous = await started({ anonymous: true });
		askForCredentials(anonymous);
		anonymous.client.setCredentialRevision(2, { restart: true });
		await settle(anonymous.clock);
		expect(
			anonymous.sent.filter(
				(message) => message.t === "credentials" || message.t === "revision",
			),
		).toEqual([]);
		// A page with no declaration still answers "no source", as today.
		const plain = await started();
		askForCredentials(plain);
		plain.client.setCredentialRevision(2);
		await settle(plain.clock);
		expect(
			plain.sent
				.filter(
					(message) => message.t === "credentials" || message.t === "revision",
				)
				.map((message) => message.t)
				.sort(),
		).toEqual(["credentials", "revision"]);
	});
});

/** Every report the loud path made, as plain records. */
const reports = (spy: ReturnType<typeof vi.fn>) =>
	spy.mock.calls.map(([error]) => ({
		code: (error as { code?: string }).code,
		message: (error as Error).message,
		detail: (error as { detail?: unknown }).detail,
	}));

describe("loud by default", () => {
	it("a terminal error with no error handler is reported once, as its code and a fixed sentence only", async () => {
		const harness = await shared({ scope: "tenant-42" });
		const handle = harness.client.subscribe(
			feed({}, { connection: { url: "https://api.test/feed?q=CANARY-URL" } }),
			() => {},
		);
		await settle(harness.clock);
		harness.host.test.last().sink.error({
			code: "protocol-error",
			message: "CANARY-UPSTREAM text",
			detail: { reason: "CANARY-DETAIL" },
		});
		await settle(harness.clock);
		expect(handle.status.get().active).toBe(false);
		const [report, ...rest] = reports(harness.kit.reportError);
		expect(rest).toEqual([]);
		expect(report?.code).toBe("protocol-error");
		expect(report?.detail).toBeUndefined();
		expect(report?.message).toMatch(/^protocol-error: /);
		expect(report?.message).not.toMatch(/CANARY|tenant-42|api\.test/);
	});

	it("a report's code is a known error code: a runtime code that is not one reports as upstream-error", async () => {
		const harness = await shared();
		const handle = harness.client.subscribe(feed(), () => {});
		await settle(harness.clock);
		harness.host.test.last().sink.error({
			code: "Bearer CANARY-TOKEN",
			message: "CANARY upstream text",
		} as never);
		await settle(harness.clock);
		expect(handle.status.get().active).toBe(false);
		const [report, ...rest] = reports(harness.kit.reportError);
		expect(rest).toEqual([]);
		expect(report?.code).toBe("upstream-error");
		expect(report?.message).toBe(
			"upstream-error: subscription ended with no error handler.",
		);
	});

	it("routes through onCallbackError when set, and an error handler or an aborted outcome reports nothing", async () => {
		const onCallbackError = vi.fn();
		const harness = await shared({ onCallbackError });
		const unhandled = harness.client.subscribe(feed({ f: 1 }), () => {});
		const handled = observe();
		harness.client.subscribe(feed({ f: 2 }), handled.observer);
		const aborted = harness.client.subscribe(feed({ f: 3 }), () => {});
		await settle(harness.clock);
		const [one, two, three] = harness.host.test.all();
		one?.sink.error({ code: "upstream-error", message: "x" });
		two?.sink.error({ code: "upstream-error", message: "x" });
		three?.sink.error({ code: "aborted", message: "x" });
		await settle(harness.clock);
		expect(handled.log.errors).toHaveLength(1);
		expect(aborted.status.get().active).toBe(false);
		expect(harness.kit.reportError).not.toHaveBeenCalled();
		expect(reports(onCallbackError).map((report) => report.code)).toEqual([
			"upstream-error",
		]);
		expect(onCallbackError.mock.calls[0]?.[1]).toEqual({
			subscriptionId: unhandled.id,
		});
	});

	it("an error hook that rethrows the same error (a binding without a hook) is reported by the same rule", async () => {
		const harness = await shared();
		harness.client.subscribe(feed({ f: 1 }), {
			next() {},
			error(error) {
				throw error;
			},
		});
		const other = new Error("hook bug");
		harness.client.subscribe(feed({ f: 2 }), {
			next() {},
			error() {
				throw other;
			},
		});
		await settle(harness.clock);
		const [one, two] = harness.host.test.all();
		one?.sink.error({ code: "upstream-error", message: "CANARY" });
		two?.sink.error({ code: "upstream-error", message: "x" });
		await settle(harness.clock);
		const calls = harness.kit.reportError.mock.calls.map(([error]) => error);
		expect(calls).toHaveLength(2);
		expect(calls).toContain(other);
		const rethrown = reports(harness.kit.reportError).find(
			(report) => report.message !== "hook bug",
		);
		expect(rethrown?.code).toBe("upstream-error");
		expect(rethrown?.message).not.toContain("CANARY");
	});

	it("a client entering failed mode with no status subscriber is reported once per client", () => {
		const clock = new ManualClock();
		const host = new FakeWorkerHost(clock);
		const kit = createTestEnv(clock, { hasSharedWorker: () => false });
		const client = createClientWithEnv(
			{ sharing: "require", worker: host.factory },
			kit.env,
		);
		client.start();
		expect(client.status.get().mode).toBe("failed");
		client.retry();
		expect(client.status.get().mode).toBe("failed");
		expect(reports(kit.reportError)).toEqual([
			{
				code: "sharing-unavailable",
				message: expect.stringMatching(/^sharing-unavailable: /),
				detail: undefined,
			},
		]);
		client.dispose();
		host.dispose();
		// With a status subscriber, the application handles the mode itself.
		const watched = createTestEnv(clock, { hasSharedWorker: () => false });
		const second = createClientWithEnv(
			{ sharing: "require", worker: host.factory },
			watched.env,
		);
		second.status.subscribe(() => {});
		second.start();
		expect(second.status.get().mode).toBe("failed");
		expect(watched.reportError).not.toHaveBeenCalled();
		second.dispose();
	});

	it("auth-blocked with no-credential-source on a client that declared neither is reported once per client, naming the fix", async () => {
		const harness = await shared({ scope: "tenant-42" });
		harness.client.subscribe(feed({ f: 1 }), observe().observer);
		harness.client.subscribe(
			feed({}, { connection: { url: "https://other.test/x" } }),
			observe().observer,
		);
		await settle(harness.clock);
		for (const connection of harness.host.test.connections) {
			connection.ctx.setStatus({
				state: "auth-blocked",
				reason: "no-credential-source",
			});
		}
		await settle(harness.clock);
		const found = reports(harness.kit.reportError);
		expect(found).toHaveLength(1);
		expect(found[0]?.code).toBe("no-credential-source");
		expect(found[0]?.message).toMatch(/credentials.*anonymous: true/);
		expect(found[0]?.message).not.toContain("tenant-42");
	});

	it("a client that declared credentials or anonymous is not reported for no-credential-source", async () => {
		for (const options of [{ anonymous: true }, { credentials: () => ({}) }]) {
			const harness = await shared(options);
			harness.client.subscribe(feed(), observe().observer);
			await settle(harness.clock);
			harness.host.test.connections[0]?.ctx.setStatus({
				state: "auth-blocked",
				reason: "no-credential-source",
			});
			await settle(harness.clock);
			expect(harness.kit.reportError).not.toHaveBeenCalled();
		}
	});

	it("auth-blocked with credentials-audience is reported once per client, naming credentialOrigins", async () => {
		const harness = await shared({ credentials: () => ({}) });
		harness.client.subscribe(feed(), observe().observer);
		await settle(harness.clock);
		const ctx = harness.host.test.connections[0]?.ctx;
		ctx?.setStatus({ state: "auth-blocked", reason: "credentials-audience" });
		await settle(harness.clock);
		ctx?.setStatus({ state: "connecting" });
		ctx?.setStatus({ state: "auth-blocked", reason: "credentials-audience" });
		await settle(harness.clock);
		const found = reports(harness.kit.reportError);
		expect(found).toHaveLength(1);
		expect(found[0]?.code).toBe("credentials-audience");
		// Names both places that can widen the audience .
		expect(found[0]?.message).toBe(
			"credentials-audience: add the origin to credentialOrigins in the Spinetab plugin options or your worker file, or declare anonymous: true.",
		);
	});

	it("stopped delivery with no status handler is reported once per subscription as continuity-lost", async () => {
		const harness = await shared({
			limits: { maxPendingMessagesPerConsumer: 2, maxPendingMessages: 4 },
		});
		const bare = harness.client.subscribe(feed({ f: 1 }), () => {});
		harness.client.subscribe(feed({ f: 2 }), observe().observer);
		const engine = harness.client.subscribe(feed({ f: 3 }), () => {});
		reconcileOnLoss(engine, () => new Promise<void>(() => {}));
		await settle(harness.clock);
		harness.host.test.connections[0]?.ctx.setStatus({ state: "connected" });
		await settle(harness.clock);
		for (const upstream of harness.host.test.all()) {
			for (let n = 1; n <= 3; n += 1) upstream.emit(n);
		}
		await settle(harness.clock);
		expect(bare.status.get().continuity.reason).toBe("overflow");
		// The bare subscription overflows again: still one report.
		bare.markReconciled();
		await settle(harness.clock);
		for (let n = 4; n <= 6; n += 1) harness.host.test.all()[0]?.emit(n);
		await settle(harness.clock);
		const found = reports(harness.kit.reportError);
		expect(found.map((report) => report.code)).toEqual(["continuity-lost"]);
		expect(found[0]?.message).toMatch(/^continuity-lost: /);
	});
});

describe("revisions are non-negative safe integers", () => {
	const invalid = [
		"2026-09-27",
		-1,
		1.5,
		Number.NaN,
		Number.MAX_SAFE_INTEGER + 1,
		null,
	];

	it.each(invalid)("credentialRevision %j is unsupported-option", (value) => {
		expect(() =>
			makeClient({ credentialRevision: value as unknown as number }),
		).toThrowError(expect.objectContaining({ code: "unsupported-option" }));
	});

	it.each(invalid)("setCredentialRevision and setScope refuse %j", (value) => {
		const { client } = makeClient({ credentialRevision: 0 });
		const revision = value as unknown as number;
		expect(() => client.setCredentialRevision(revision)).toThrowError(
			expect.objectContaining({ code: "unsupported-option" }),
		);
		expect(() => client.setScope("next", revision)).toThrowError(
			expect.objectContaining({ code: "unsupported-option" }),
		);
		expect(client.scope).toBe("");
	});

	it("accepts 0 and Number.MAX_SAFE_INTEGER", () => {
		const { client } = makeClient({ credentialRevision: 0 });
		expect(() =>
			client.setCredentialRevision(Number.MAX_SAFE_INTEGER),
		).not.toThrow();
		expect(() => client.setScope("next", 3)).not.toThrow();
	});
});

describe("the provider result is closed", () => {
	async function replyFor(result: unknown) {
		const harness = await started({
			credentials: () => result as Record<string, never>,
		});
		askForCredentials(harness);
		await settle(harness.clock);
		return harness.sent.find((message) => message.t === "credentials");
	}

	it.each([
		[{ token: "CANARY" }],
		[{ headers: { authorization: "Bearer CANARY" }, extra: 1 }],
		[{ headers: "Bearer CANARY" }],
		[{ headers: { authorization: 42 } }],
		[{ headers: { "bad name": "CANARY" } }],
		[{ headers: { cookie: "CANARY" } }],
		[{ headers: { "Last-Event-ID": "CANARY" } }],
		[{ headers: { Host: "CANARY" } }],
		[{ headers: { "Proxy-Authorization": "CANARY" } }],
		[{ headers: { "Sec-Fetch-Mode": "CANARY" } }],
		[{ connectionParams: "CANARY" }],
		[{ auth: ["CANARY"] }],
	])("%j replies credentials-failed with a fixed message", async (result) => {
		const reply = await replyFor(result);
		expect(reply).toMatchObject({
			ok: false,
			error: { code: "credentials-failed" },
		});
		expect(reply?.credentials).toBeUndefined();
		expect(JSON.stringify(reply)).not.toContain("CANARY");
	});

	it.each([
		[{}],
		[{ headers: { authorization: "Bearer t", "x-tenant": "1" } }],
		[{ connectionParams: { token: "t" }, auth: { token: "t" } }],
	])("%j is accepted as is", async (result) => {
		const reply = await replyFor(result);
		expect(reply).toMatchObject({ ok: true, credentials: result });
	});
});

describe("event metadata", () => {
	it("the page forwards the SSE event name into meta.event when the runtime sends one", async () => {
		const harness = await shared();
		const { log, observer } = observe();
		harness.client.subscribe(feed(), observer);
		await settle(harness.clock);
		// Stand in for a runtime that posts the name (core-runtime's half).
		harness.host.lastRelay().drop = (data, toRuntime) => {
			const message = data as { t?: string; seq?: number; event?: string };
			if (!toRuntime && message.t === "event" && message.seq === 1)
				message.event = "tick";
			return false;
		};
		harness.host.test.last().emit({ n: 1 }, { eventId: "e1" });
		harness.host.test.last().emit({ n: 2 });
		await settle(harness.clock);
		expect(log.metas).toEqual([
			{ seq: 1, eventId: "e1", event: "tick" },
			{ seq: 2 },
		]);
	});
});
