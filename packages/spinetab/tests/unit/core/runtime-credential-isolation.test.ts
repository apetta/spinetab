import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionContext } from "../../../src/core/adapter.ts";
import { BRIDGE_VERSION } from "../../../src/core/bridge.ts";
import { isSpinetabError } from "../../../src/core/errors.ts";
import {
	createRuntime,
	type Runtime,
	type RuntimeOptions,
	setWorkerOriginForTests,
} from "../../../src/core/runtime.ts";
import { ManualClock, settle } from "./helpers/clock.ts";
import { RawPage } from "./helpers/page.ts";
import { createTestAdapter } from "./helpers/test-adapter.ts";

const runtimes: Runtime[] = [];
afterEach(() => {
	for (const runtime of runtimes.splice(0)) runtime.dispose();
	setWorkerOriginForTests(undefined);
	vi.unstubAllGlobals();
});

function setup(options: Partial<RuntimeOptions> = {}) {
	const clock = new ManualClock();
	const test = createTestAdapter();
	const runtime = createRuntime({
		adapters: [test.adapter],
		clock,
		...options,
	});
	runtimes.push(runtime);
	const tab = async (fields: Record<string, unknown> = {}) => {
		const raw = new RawPage(runtime);
		raw.hello({ scope: "s", ...fields });
		await settle(clock);
		return raw;
	};
	const open = async (
		raw: RawPage,
		url = "https://app.test/feed",
		c = `c-${url}`,
	): Promise<ConnectionContext> => {
		const before = test.connections.length;
		raw.subscribe(c, { connection: { url } });
		await settle(clock);
		const found = test.connections[before];
		if (!found) throw new Error("no new connection");
		return found.ctx;
	};
	return { clock, test, runtime, tab, open };
}

function track<T>(promise: Promise<T>) {
	const state: { value?: T; error?: unknown; done: boolean } = { done: false };
	promise.then(
		(value) => Object.assign(state, { value, done: true }),
		(error) => Object.assign(state, { error, done: true }),
	);
	return state;
}

const answer = (
	raw: RawPage,
	index: number,
	fields: Record<string, unknown>,
) => {
	const request = raw.ofType("credentialsRequest")[index];
	if (!request) throw new Error(`no credentials request ${index}`);
	raw.send({ t: "credentials", id: request.id, ...fields });
};

const grant = (token: string) => ({
	headers: { authorization: `Bearer ${token}` },
});

async function judge(
	url: string,
	worker: string | null,
	credentialOrigins?: string[],
) {
	setWorkerOriginForTests(worker);
	const { clock, tab, open } = setup(
		credentialOrigins ? { credentialOrigins } : {},
	);
	const raw = await tab({ credentials: true, revision: 1 });
	const ctx = await open(raw, "https://placeholder.test/feed", "x");
	const result = track(ctx.credentials("connect", url));
	await settle(clock);
	const asked = raw.ofType("credentialsRequest").length;
	return {
		asked,
		audience: isSpinetabError(result.error, "credentials-audience"),
		error: result.error as { message?: string; detail?: unknown } | undefined,
	};
}

describe("no bypass of the credential audience", () => {
	it("refuses look-alike, userinfo, backslash and fragment tricks against the worker's origin", async () => {
		for (const url of [
			"https://app.test.evil.test/x",
			"https://evil.test/https://app.test/",
			"https://app.test@evil.test/x",
			"https://evil.test#@app.test",
			"https://evil.test\\@app.test/x",
			"https://app.test./x",
			"https://app.test:444/x",
			"http://localhost.evil.test/x",
			"http://127.0.0.1.evil.test/x",
			"ws://app.test/socket",
			"blob:https://app.test/uuid",
			"/relative",
			"",
		]) {
			const outcome = await judge(url, "https://app.test");
			expect({ url, ...outcome, error: undefined }).toMatchObject({
				url,
				asked: 0,
				audience: true,
			});
			expect(outcome.error?.message ?? "").not.toContain("evil");
			expect(outcome.error?.message ?? "").not.toContain("app.test");
		}
	});

	it("accepts the worker's own origin in every equivalent spelling", async () => {
		for (const url of [
			"https://APP.test/x",
			"https://app.test:443/x",
			"wss://app.test:443/socket",
			"wss://app.test/socket",
		]) {
			expect(await judge(url, "https://app.test")).toMatchObject({
				asked: 1,
				audience: false,
			});
		}
	});

	it("loopback counts as the worker's own only when the worker is on loopback", async () => {
		for (const url of [
			"http://localhost:9999/x",
			"http://127.0.0.1/x",
			"http://[::1]:1/x",
		]) {
			expect(await judge(url, "https://app.test")).toMatchObject({
				asked: 0,
				audience: true,
			});
			expect(await judge(url, "http://localhost:4321")).toMatchObject({
				asked: 1,
			});
		}
		// A cleartext non-loopback worker's own origin is refused by the TLS rule.
		expect(await judge("http://app.test/x", "http://app.test")).toMatchObject({
			asked: 0,
			audience: true,
		});
	});

	it("an opaque or missing worker origin allows only listed origins", async () => {
		expect(await judge("https://app.test/x", "null")).toMatchObject({
			asked: 0,
			audience: true,
		});
		expect(
			await judge("https://api.test/x", null, ["https://api.test"]),
		).toMatchObject({ asked: 1 });
	});

	it("credentialOrigins refuses paths, queries, fragments, userinfo, wss and cleartext hosts", () => {
		for (const entry of [
			"https://api.test/path",
			"https://api.test?",
			"https://api.test/#",
			"https://u@api.test",
			"wss://api.test",
			"http://api.test",
			"api.test",
			"",
			"https://api.test/%3F",
		]) {
			let error: unknown;
			try {
				createRuntime({ adapters: [], credentialOrigins: [entry] });
			} catch (caught) {
				error = caught;
			}
			expect({
				entry,
				ok: isSpinetabError(error, "unsupported-option"),
			}).toEqual({ entry, ok: true });
		}
	});

	it("records how credentialOrigins treats a wildcard-looking entry", () => {
		let error: unknown;
		try {
			runtimes.push(
				createRuntime({
					adapters: [],
					credentialOrigins: ["https://*.api.test"],
				}),
			);
		} catch (caught) {
			error = caught;
		}
		// Recorded for the report: accepted as a literal host (never a wildcard).
		expect(error === undefined || isSpinetabError(error)).toBe(true);
	});
});

describe("grant lifetime with anonymous pages in the scope", () => {
	it("REFUTE the grant is forgotten when the last provider group closes, even with an anonymous group open", async () => {
		setWorkerOriginForTests("https://app.test");
		const { clock, tab, open } = setup({ limits: { idleCloseMs: 1 } });
		const provider = await tab({ credentials: true, revision: 1 });
		const anonymous = await tab({ anonymous: true });
		await open(anonymous, "https://app.test/public", "pub");
		const ctx = await open(provider, "https://app.test/a", "a");
		const first = track(ctx.credentials("connect"));
		await settle(clock);
		answer(provider, 0, { ok: true, credentials: grant("t1"), revision: 1 });
		await settle(clock);
		expect(first.value).toEqual(grant("t1"));
		provider.send({ t: "unsubscribe", c: "a" });
		await settle(clock);
		clock.advance(1);
		await settle(clock);
		clock.advance(1);
		await settle(clock);
		// The provider group is closed; only the anonymous group remains.
		const next = await open(provider, "https://app.test/b", "b");
		const second = track(next.credentials("connect"));
		await settle(clock);
		// A fresh ask, not the cached grant.
		expect(provider.ofType("credentialsRequest")).toHaveLength(2);
		expect(second.done).toBe(false);
	});

	it("REFUTE a grant does not outlive every provider page because an anonymous page stays in the scope", async () => {
		setWorkerOriginForTests("https://app.test");
		const { clock, tab, open } = setup({ limits: { idleCloseMs: 1 } });
		const provider = await tab({ credentials: true, revision: 1 });
		const anonymous = await tab({ anonymous: true });
		await open(anonymous, "https://app.test/public", "pub");
		const ctx = await open(provider, "https://app.test/a", "a");
		track(ctx.credentials("connect"));
		await settle(clock);
		answer(provider, 0, { ok: true, credentials: grant("t1"), revision: 1 });
		await settle(clock);
		provider.send({ t: "detach" });
		await settle(clock);
		clock.advance(1);
		await settle(clock);
		clock.advance(1);
		await settle(clock);
		const later = await tab({ credentials: true, revision: 1 });
		const next = await open(later, "https://app.test/c", "c");
		const reused = track(next.credentials("connect"));
		await settle(clock);
		// The new tab must be asked; the old tab's grant must not be handed out.
		expect(later.ofType("credentialsRequest")).toHaveLength(1);
		expect(reused.value).toBeUndefined();
	});
});

describe("rejection names the attached grant", () => {
	it("REFUTE /the no-argument rejectCredentials() rejects a revision without naming any attached grant", async () => {
		setWorkerOriginForTests("https://app.test");
		const { clock, tab, open } = setup();
		const raw = await tab({ credentials: true, revision: 1 });
		const a = await open(raw, "https://app.test/a", "a");
		const b = await open(raw, "https://app.test/b", "b");
		track(a.credentials("connect"));
		await settle(clock);
		answer(raw, 0, { ok: true, credentials: grant("t1"), revision: 1 });
		await settle(clock);
		// A custom adapter that attached nothing to the failing request (for
		// example a cross-origin read in auto mode) calls the old form.
		a.rejectCredentials();
		const after = track(b.credentials("connect"));
		await settle(clock);
		// "never rejects when nothing was attached": the cached grant stays.
		expect(after.value).toEqual(grant("t1"));
	});

	it("a copy of the grant, an unknown object and {} reject nothing", async () => {
		setWorkerOriginForTests("https://app.test");
		const { clock, tab, open } = setup();
		const raw = await tab({ credentials: true, revision: 1 });
		const a = await open(raw, "https://app.test/a", "a");
		const b = await open(raw, "https://app.test/b", "b");
		const first = track(a.credentials("connect"));
		await settle(clock);
		answer(raw, 0, { ok: true, credentials: grant("t1"), revision: 1 });
		await settle(clock);
		a.rejectCredentials({ ...(first.value as object) });
		a.rejectCredentials({});
		a.rejectCredentials(grant("t1"));
		a.rejectCredentials(undefined);
		const after = track(b.credentials("connect"));
		await settle(clock);
		expect(after.value).toBe(first.value);
	});

	it("rejecting the handed grant blocks that revision for the scope", async () => {
		setWorkerOriginForTests("https://app.test");
		const { clock, tab, open } = setup();
		const raw = await tab({ credentials: true, revision: 1 });
		const a = await open(raw, "https://app.test/a", "a");
		const b = await open(raw, "https://app.test/b", "b");
		const first = track(a.credentials("connect"));
		await settle(clock);
		answer(raw, 0, { ok: true, credentials: grant("t1"), revision: 1 });
		await settle(clock);
		a.rejectCredentials(first.value);
		const after = track(b.credentials("connect"));
		await settle(clock);
		answer(raw, 1, { ok: true, credentials: grant("t1"), revision: 1 });
		await settle(clock);
		expect(isSpinetabError(after.error, "credentials-rejected")).toBe(true);
	});
});

describe("anonymous pages", () => {
	it("an anonymous page that also says credentials: true is never asked and never moves the revision", async () => {
		setWorkerOriginForTests("https://app.test");
		const { clock, tab, open } = setup();
		const provider = await tab({ credentials: true, revision: 1 });
		const both = await tab({ anonymous: true, credentials: true, revision: 9 });
		both.send({ t: "revision", revision: 12, restart: true });
		await settle(clock);
		const ctx = await open(provider);
		track(ctx.credentials("connect"));
		await settle(clock);
		expect(both.ofType("credentialsRequest")).toHaveLength(0);
		expect(provider.ofType("credentialsRequest")[0]).toMatchObject({
			revision: 1,
		});
	});

	it("refuses authHeaders: true on a command from an anonymous page", async () => {
		const { clock, test, tab } = setup();
		const anonymous = await tab({ anonymous: true });
		anonymous.send({
			t: "command",
			id: "k1",
			timeoutMs: 1_000,
			request: {
				adapter: "test",
				connection: { url: "https://app.test/feed", authHeaders: true },
				payload: {},
			},
		});
		await settle(clock);
		const failed = anonymous.received.find(
			(message) =>
				JSON.stringify(message).includes("unsupported-option") &&
				JSON.stringify(message).includes("anonymous"),
		);
		expect(failed).toBeDefined();
		expect(test.connections).toHaveLength(0);
	});

	it("an anonymous page cannot answer a credentials request meant for a provider tab", async () => {
		setWorkerOriginForTests("https://app.test");
		const { clock, tab, open } = setup();
		const provider = await tab({ credentials: true, revision: 1 });
		const anonymous = await tab({ anonymous: true });
		const ctx = await open(provider);
		const result = track(ctx.credentials("connect"));
		await settle(clock);
		const request = provider.ofType("credentialsRequest")[0];
		anonymous.send({
			t: "credentials",
			id: request?.id,
			ok: true,
			credentials: grant("forged"),
			revision: 1,
		});
		await settle(clock);
		expect(result.done).toBe(false);
	});
});

describe("closed provider shape at the broker", () => {
	for (const [label, credentials] of [
		[
			"a Proxy-Authorization header",
			{ headers: { "Proxy-Authorization": "x" } },
		],
		["a Sec- header", { headers: { "Sec-Fetch-Site": "x" } }],
		["a Cookie header", { headers: { Cookie: "a=b" } }],
		["a Last-Event-ID header", { headers: { "Last-Event-ID": "1" } }],
		["a header name with a space", { headers: { "authorization ": "x" } }],
		["a header value with a newline", { headers: { authorization: "a\r\nb" } }],
		["a top-level token", { token: "t" }],
		["an array auth", { auth: ["t"] }],
		["a null connectionParams", { connectionParams: null }],
	] as const) {
		it(`treats ${label} as a provider failure`, async () => {
			setWorkerOriginForTests("https://app.test");
			const { clock, tab, open } = setup();
			const raw = await tab({ credentials: true, revision: 1 });
			const ctx = await open(raw);
			const result = track(ctx.credentials("connect"));
			await settle(clock);
			answer(raw, 0, { ok: true, credentials, revision: 1 });
			await settle(clock);
			expect(result.value).toBeUndefined();
			expect(isSpinetabError(result.error, "credentials-failed")).toBe(true);
		});
	}
});

describe("revisions", () => {
	it("drops hello and revision envelopes whose revision is not a non-negative safe integer", async () => {
		setWorkerOriginForTests("https://app.test");
		const { clock, runtime, tab, open } = setup();
		const provider = await tab({ credentials: true, revision: 1 });
		for (const revision of ["2", -1, 1.5, 2 ** 53, Number.NaN]) {
			provider.send({ t: "revision", revision, restart: false });
		}
		await settle(clock);
		const bad = new RawPage(runtime);
		bad.hello({ scope: "s", credentials: true, revision: "9" });
		await settle(clock);
		expect(bad.ofType("welcome")).toHaveLength(0);
		const ctx = await open(provider);
		track(ctx.credentials("connect"));
		await settle(clock);
		expect(provider.ofType("credentialsRequest")[0]).toMatchObject({
			revision: 1,
		});
	});
});

describe("per-handle retry", () => {
	it("a retry naming another page's consumer id touches only this page's consumer", async () => {
		const { clock, test, tab } = setup();
		const one = await tab();
		const two = await tab();
		one.subscribe("x", { connection: { url: "https://app.test/one" } });
		two.subscribe("y", { connection: { url: "https://app.test/two" } });
		await settle(clock);
		for (const connection of test.connections) {
			connection.ctx.setStatus({ state: "retry-exhausted" });
		}
		await settle(clock);
		two.send({ t: "retry", c: "x" });
		await settle(clock);
		expect(test.connections.map((each) => each.retries)).toEqual([0, 0]);
		two.send({ t: "retry", c: 5 });
		await settle(clock);
		expect(test.connections.map((each) => each.retries)).toEqual([0, 0]);
	});
});

describe("defineWorker registers nothing outside a SharedWorker", () => {
	type WorkerEntry = typeof import("../../../src/worker/index.ts");
	let entry: WorkerEntry;
	beforeEach(async () => {
		vi.resetModules();
		entry = await import("../../../src/worker/index.ts");
	});

	it("a dedicated-worker-like global and a global with a non-function SharedWorkerGlobalScope register nothing", () => {
		const addEventListener = vi.fn();
		vi.stubGlobal("addEventListener", addEventListener);
		const Dedicated = Object.defineProperty(() => {}, Symbol.hasInstance, {
			value: (value: unknown) => value === globalThis,
		});
		vi.stubGlobal("DedicatedWorkerGlobalScope", Dedicated);
		vi.stubGlobal("WorkerGlobalScope", Dedicated);
		const { adapter } = createTestAdapter();
		const factory = entry.defineWorker(() => [adapter]);
		expect(typeof factory).toBe("function");
		vi.stubGlobal("SharedWorkerGlobalScope", { prototype: {} });
		entry.defineWorker(() => [adapter]);
		expect(addEventListener).not.toHaveBeenCalled();
	});

	it("a second serve after a page attached: later pages get worker-startup-error", async () => {
		const listeners: Array<(event: MessageEvent) => void> = [];
		vi.stubGlobal(
			"SharedWorkerGlobalScope",
			Object.defineProperty(() => {}, Symbol.hasInstance, {
				value: (value: unknown) => value === globalThis,
			}),
		);
		vi.stubGlobal(
			"addEventListener",
			(type: string, listener: (event: MessageEvent) => void) => {
				if (type === "connect") listeners.push(listener);
			},
		);
		const created: Runtime[] = [];
		const { adapter } = createTestAdapter();
		entry.defineWorker(() => [adapter]);
		const connect = () => {
			const channel = new MessageChannel();
			const received: Array<Record<string, unknown>> = [];
			channel.port1.addEventListener("message", (event) =>
				received.push(event.data),
			);
			channel.port1.start();
			for (const listener of listeners)
				listener(new MessageEvent("connect", { ports: [channel.port2] }));
			channel.port1.postMessage({
				v: BRIDGE_VERSION,
				t: "hello",
				a: `a-${Math.random()}`,
				g: 1,
				page: "p",
				scope: "",
				revision: null,
				heartbeatMs: 20_000,
			});
			return { received, port: channel.port1 };
		};
		const early = connect();
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(early.received.map((m) => m.t)).toContain("welcome");
		entry.serveSharedWorker(() => {
			const runtime = createRuntime({ adapters: [] });
			created.push(runtime);
			return runtime;
		});
		const late = connect();
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(listeners).toHaveLength(1);
		expect(created).toHaveLength(0);
		expect(late.received[0]).toMatchObject({
			t: "startupError",
			code: "worker-startup-error",
		});
		// Recorded: the page that attached before the second serve keeps its runtime.
		expect(early.received.some((m) => m.t === "startupError")).toBe(false);
		early.port.close();
		late.port.close();
	});
});
