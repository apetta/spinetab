import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionContext } from "../../../src/core/adapter.ts";
import { createBroker, isProviderShape } from "../../../src/core/broker.ts";
import { isSpinetabError } from "../../../src/core/errors.ts";
import { connectionKey } from "../../../src/core/identity.ts";
import {
	createRuntime,
	type Runtime,
	type RuntimeOptions,
	setWorkerOriginForTests,
} from "../../../src/core/runtime.ts";
import type { DiagnosticEvent } from "../../../src/core/types.ts";
import { isCredentials } from "../../../src/core/validate.ts";
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
		extra: Record<string, unknown> = {},
	): Promise<ConnectionContext> => {
		const before = test.connections.length;
		raw.subscribe(c, { connection: { url, ...extra } });
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

describe("retry names one consumer", () => {
	it("retries only the named consumer's group, under the existing coalescing", async () => {
		const { clock, test, tab } = setup();
		const raw = await tab();
		raw.subscribe("a", { connection: { url: "https://app.test/a" } });
		raw.subscribe("b", { connection: { url: "https://app.test/b" } });
		await settle(clock);
		const [a, b] = test.connections;
		for (const connection of [a, b]) {
			connection?.ctx.setStatus({
				state: "auth-blocked",
				reason: "credentials-rejected",
			});
		}
		await settle(clock);
		raw.send({ t: "retry", c: "a" });
		await settle(clock);
		expect([a?.retries, b?.retries]).toEqual([1, 0]);
		// Coalesced with the explicit retry above for one second.
		raw.send({ t: "retry", c: "a" });
		await settle(clock);
		expect(a?.retries).toBe(1);
		// Without `c`, every group of the page, as before.
		raw.send({ t: "retry" });
		await settle(clock);
		expect([a?.retries, b?.retries]).toEqual([1, 1]);
		clock.advance(1_000);
		raw.send({ t: "retry", c: "missing" });
		await settle(clock);
		expect([a?.retries, b?.retries]).toEqual([1, 1]);
	});
});

describe("anonymous pages", () => {
	it("keys the anonymous marker as its own component after the JSON-quoted scope", () => {
		const spec = '{"url":"https://app.test/feed"}';
		const anonymous = connectionKey("k", "s", spec, true);
		expect(anonymous).not.toBe(connectionKey("k", "s", spec));
		expect(anonymous.startsWith(`k|${JSON.stringify("s")}`)).toBe(true);
		// No scope string and no canonical spec can spell the marker.
		for (const scope of [
			's"+anonymous',
			"s+anonymous",
			's"|anonymous',
			"s|anonymous",
			"+anonymous",
		]) {
			expect(connectionKey("k", scope, spec)).not.toBe(anonymous);
		}
		for (const canonical of [`anonymous|${spec}`, `+anonymous|${spec}`]) {
			expect(connectionKey("k", "s", canonical)).not.toBe(anonymous);
		}
	});

	it("never shares a connection between anonymous and provider pages in one scope", async () => {
		setWorkerOriginForTests("https://app.test");
		const { clock, test, tab, open } = setup();
		const provider = await tab({ credentials: true, revision: 1 });
		const anonymous = await tab({ anonymous: true });
		const other = await tab({ anonymous: true });
		const providerCtx = await open(provider);
		const anonymousCtx = await open(anonymous);
		other.subscribe("x", { connection: { url: "https://app.test/feed" } });
		await settle(clock);
		expect(test.connections).toHaveLength(2);
		expect(anonymousCtx.key).not.toBe(providerCtx.key);
		expect(test.connections[1]?.subscriptions[0]?.consumers.size).toBe(2);
	});

	it("resolves an anonymous group's credentials to {} without asking, and its rejection is a no-op", async () => {
		setWorkerOriginForTests("https://app.test");
		const { clock, tab, open } = setup();
		const provider = await tab({ credentials: true, revision: 1 });
		const anonymous = await tab({ anonymous: true });
		const anonymousCtx = await open(anonymous, "https://elsewhere.test/feed");
		const empty = track(anonymousCtx.credentials("connect"));
		await settle(clock);
		expect(empty.value).toEqual({});
		expect(provider.ofType("credentialsRequest")).toHaveLength(0);
		anonymousCtx.rejectCredentials(empty.value);
		anonymousCtx.rejectCredentials();
		const providerCtx = await open(provider);
		const real = track(providerCtx.credentials("connect"));
		await settle(clock);
		answer(provider, 0, { ok: true, credentials: grant("t1"), revision: 1 });
		await settle(clock);
		expect(real.value).toEqual(grant("t1"));
	});

	it("fails a subscribe with authHeaders: true from an anonymous page, naming both options", async () => {
		const { clock, test, tab } = setup();
		const anonymous = await tab({ anonymous: true });
		anonymous.subscribe("h", {
			connection: { url: "https://app.test/feed", authHeaders: true },
		});
		await settle(clock);
		const [error] = anonymous.ofType("error");
		expect(error).toMatchObject({ c: "h", code: "unsupported-option" });
		expect(error?.message).toContain("authHeaders");
		expect(error?.message).toContain("anonymous");
		expect(test.connections).toHaveLength(0);
	});

	it("anonymous tabs and tabs without a provider never move the scope's revision", async () => {
		setWorkerOriginForTests("https://app.test");
		const { clock, tab, open } = setup();
		const provider = await tab({ credentials: true, revision: 1 });
		await tab({ anonymous: true, revision: 90 });
		const plain = await tab({ revision: 50 });
		plain.send({ t: "revision", revision: 70, restart: true });
		await settle(clock);
		const ctx = await open(provider);
		const result = track(ctx.credentials("connect"));
		await settle(clock);
		expect(provider.ofType("credentialsRequest")[0]).toMatchObject({
			revision: 1,
		});
		answer(provider, 0, { ok: true, credentials: grant("t1"), revision: 1 });
		await settle(clock);
		expect(result.value).toEqual(grant("t1"));
	});

	it("keeps the mode when the page changes scope (a fresh hello)", async () => {
		const { clock, test, tab } = setup();
		const raw = await tab({ anonymous: true, scope: "a" });
		raw.g += 1;
		raw.hello({ anonymous: true, scope: "b" });
		await settle(clock);
		raw.subscribe("1", { connection: { url: "https://app.test/feed" } });
		await settle(clock);
		const key = test.connections[0]?.ctx.key;
		expect(key).toBe(
			connectionKey("test", "b", '{"url":"https://app.test/feed"}', true),
		);
		expect(test.connections[0]?.ctx.scope).toBe("b");
	});
});

describe("the credential audience lives in worker code", () => {
	it("validates credentialOrigins at createRuntime", () => {
		const bad: unknown[] = [
			"https://api.test",
			["http://api.test"],
			["https://api.test/path"],
			["https://user@api.test"],
			["https://api.test?x=1"],
			["https://api.test#f"],
			["api.test"],
			["wss://api.test"],
			[42],
		];
		for (const credentialOrigins of bad) {
			let error: unknown;
			try {
				setup({ credentialOrigins: credentialOrigins as string[] });
			} catch (caught) {
				error = caught;
			}
			expect(isSpinetabError(error, "unsupported-option")).toBe(true);
		}
		expect(() =>
			setup({
				credentialOrigins: [
					"https://api.test",
					"https://api.test/",
					"http://localhost:3000",
					"http://127.0.0.1:8080",
				],
			}),
		).not.toThrow();
	});

	async function judged(
		url: string,
		options: {
			origin?: string | null;
			credentialOrigins?: string[];
			argument?: string;
		} = {},
	) {
		setWorkerOriginForTests(
			options.origin === undefined ? "https://app.test" : options.origin,
		);
		const { clock, tab, open } = setup(
			options.credentialOrigins
				? { credentialOrigins: options.credentialOrigins }
				: {},
		);
		const raw = await tab({ credentials: true, revision: 1 });
		const ctx = await open(raw, url);
		const result = track(ctx.credentials("connect", options.argument));
		await settle(clock);
		const asked = raw.ofType("credentialsRequest").length;
		if (asked > 0) {
			answer(raw, 0, { ok: true, credentials: grant("t"), revision: 1 });
			await settle(clock);
		}
		return {
			asked,
			allowed: result.value !== undefined,
			audience: isSpinetabError(result.error, "credentials-audience"),
			error: result.error,
		};
	}

	it("sends provider credentials only to the worker's origin or a listed origin", async () => {
		expect(await judged("https://app.test/feed")).toMatchObject({
			asked: 1,
			allowed: true,
		});
		expect(await judged("wss://app.test/socket")).toMatchObject({
			allowed: true,
		});
		for (const url of [
			"https://evil.test/feed",
			"https://app.test.evil.test/feed",
			"https://app.test:8443/feed",
			"http://app.test/feed",
		]) {
			expect(await judged(url)).toMatchObject({ asked: 0, audience: true });
		}
		expect(
			await judged("https://api.test/feed", {
				credentialOrigins: ["https://api.test"],
			}),
		).toMatchObject({ allowed: true });
		expect(
			await judged("wss://api.test/socket", {
				credentialOrigins: ["https://api.test/"],
			}),
		).toMatchObject({ allowed: true });
	});

	it("judges the URL the adapter passes over the connection URL", async () => {
		expect(
			await judged("https://app.test/feed", {
				argument: "https://evil.test/x",
			}),
		).toMatchObject({ asked: 0, audience: true });
		expect(
			await judged("https://evil.test/feed", {
				argument: "https://app.test/stop",
			}),
		).toMatchObject({ allowed: true });
		expect(
			await judged("https://app.test/feed", { argument: "not a url" }),
		).toMatchObject({ asked: 0, audience: true });
	});

	it("treats loopback as the worker's own origin only when the worker runs on loopback", async () => {
		const local = { origin: "http://localhost:5173" };
		for (const url of [
			"http://127.0.0.1:3000/feed",
			"ws://localhost:4000/socket",
			"http://[::1]:3000/feed",
			"http://api.localhost:1/feed",
		]) {
			expect(await judged(url, local)).toMatchObject({ allowed: true });
		}
		expect(await judged("https://app.test/feed", local)).toMatchObject({
			audience: true,
		});
		expect(await judged("http://localhost:3000/feed")).toMatchObject({
			audience: true,
		});
		expect(
			await judged("http://localhost:3000/feed", {
				credentialOrigins: ["http://localhost:3000"],
			}),
		).toMatchObject({ allowed: true });
	});

	it("with no worker origin allows only listed origins", async () => {
		expect(
			await judged("https://app.test/feed", { origin: null }),
		).toMatchObject({ audience: true });
		expect(
			await judged("https://api.test/feed", {
				origin: null,
				credentialOrigins: ["https://api.test"],
			}),
		).toMatchObject({ allowed: true });
	});

	it("reads the worker origin from globalThis.location by default", async () => {
		vi.stubGlobal("location", { origin: "https://loc.test" });
		const { clock, tab, open } = setup();
		const raw = await tab({ credentials: true, revision: 1 });
		const ok = track(
			(await open(raw, "https://loc.test/a")).credentials("connect"),
		);
		const no = track(
			(await open(raw, "https://app.test/a", "c2")).credentials("connect"),
		);
		await settle(clock);
		answer(raw, 0, { ok: true, credentials: grant("t"), revision: 1 });
		await settle(clock);
		expect(ok.value).toEqual(grant("t"));
		expect(isSpinetabError(no.error, "credentials-audience")).toBe(true);
	});

	it("refuses cleartext provider material to a non-loopback host, even on the worker's own origin", async () => {
		const plain = { origin: "http://app.test" };
		expect(await judged("http://app.test/feed", plain)).toMatchObject({
			asked: 0,
			audience: true,
		});
		expect(await judged("ws://app.test/socket", plain)).toMatchObject({
			audience: true,
		});
	});

	it("errors carry a fixed message without the URL", async () => {
		const { error } = await judged("https://evil.test/secret-path?q=1");
		expect(String((error as Error).message)).not.toContain("evil.test");
		expect(String((error as Error).message)).toContain("credentialOrigins");
	});
});

describe("rejection names the attached grant", () => {
	it("rejects the attached grant's revision, not the group's latest", async () => {
		setWorkerOriginForTests("https://app.test");
		const { clock, tab, open } = setup();
		const raw = await tab({ credentials: true, revision: 1 });
		const ctx = await open(raw);
		const first = track(ctx.credentials("connect"));
		await settle(clock);
		answer(raw, 0, { ok: true, credentials: grant("t1"), revision: 1 });
		await settle(clock);
		raw.send({ t: "revision", revision: 2, restart: false });
		await settle(clock);
		const second = track(ctx.credentials("rotated"));
		await settle(clock);
		answer(raw, 1, { ok: true, credentials: grant("t2"), revision: 2 });
		await settle(clock);
		expect(second.value).toEqual(grant("t2"));
		// A late 401 for the request that carried revision 1.
		ctx.rejectCredentials(first.value);
		const again = track(ctx.credentials("reconnect"));
		await settle(clock);
		expect(again.value).toEqual(grant("t2"));
		expect(raw.ofType("credentialsRequest")).toHaveLength(2);
	});

	it("is a no-op for {} or an object the runtime never handed out", async () => {
		setWorkerOriginForTests("https://app.test");
		const { clock, tab, open } = setup();
		const raw = await tab({ credentials: true, revision: 1 });
		const ctx = await open(raw);
		const first = track(ctx.credentials("connect"));
		await settle(clock);
		answer(raw, 0, { ok: true, credentials: grant("t1"), revision: 1 });
		await settle(clock);
		ctx.rejectCredentials({});
		ctx.rejectCredentials(grant("t1"));
		const again = track(ctx.credentials("reconnect"));
		await settle(clock);
		expect(again.value).toBe(first.value);
		ctx.rejectCredentials(first.value);
		const blocked = track(ctx.credentials("reconnect"));
		await settle(clock);
		expect(raw.ofType("credentialsRequest")).toHaveLength(2);
		answer(raw, 1, { ok: true, credentials: grant("t1b"), revision: 1 });
		await settle(clock);
		expect(isSpinetabError(blocked.error, "credentials-rejected")).toBe(true);
	});
});

describe("adapter diagnostics stay in their group's scope", () => {
	it("delivers an adapter diagnostic only to tabs of the group's scope", async () => {
		const seen: DiagnosticEvent[] = [];
		const { clock, tab, open } = setup({
			diagnostics: (event) => seen.push(event),
		});
		const mine = await tab({ diagnostics: true });
		const theirs = await tab({ diagnostics: true, scope: "t" });
		const ctx = await open(mine);
		const before = theirs.ofType("diagnostic").length;
		ctx.diagnostic({ type: "adapter-thing" });
		await settle(clock);
		const types = (raw: RawPage) =>
			raw.ofType("diagnostic").map((message) => message.event.type);
		expect(types(mine)).toContain("adapter-thing");
		expect(types(theirs)).not.toContain("adapter-thing");
		expect(theirs.ofType("diagnostic")).toHaveLength(before);
		expect(seen.map((event) => event.type)).toContain("adapter-thing");
		// The runtime's own diagnostics are unchanged: every opted-in tab.
		await tab({ scope: "u" });
		expect(types(theirs)).toContain("attached");
	});
});

describe("broker replies are the closed provider shape", () => {
	const invalid: Array<[string, unknown]> = [
		["an unknown key", { headers: {}, token: "x" }],
		["a header name that is not a token", { headers: { "bad name": "x" } }],
		["a cookie header", { headers: { Cookie: "a=b" } }],
		["last-event-id", { headers: { "Last-Event-ID": "3" } }],
		["a forbidden header", { headers: { Host: "evil.test" } }],
		["a sec- header", { headers: { "Sec-Fetch-Mode": "cors" } }],
		["a proxy- header", { headers: { "Proxy-Authorization": "x" } }],
		["a header value that is not a string", { headers: { authorization: 1 } }],
		["headers that are not a record", { headers: ["x"] }],
		["connectionParams that are not a record", { connectionParams: "x" }],
		["auth that is not a record", { auth: 7 }],
	];

	for (const [label, credentials] of invalid) {
		it(`treats ${label} as a provider failure, never a grant`, async () => {
			setWorkerOriginForTests("https://app.test");
			const { clock, tab, open } = setup();
			const raw = await tab({ credentials: true, revision: 1 });
			const ctx = await open(raw);
			const result = track(ctx.credentials("connect"));
			await settle(clock);
			answer(raw, 0, { ok: true, credentials, revision: 1 });
			await settle(clock);
			expect(isSpinetabError(result.error, "credentials-failed")).toBe(true);
		});
	}

	it("accepts headers, connectionParams and auth", async () => {
		setWorkerOriginForTests("https://app.test");
		const { clock, tab, open } = setup();
		const raw = await tab({ credentials: true, revision: 1 });
		const ctx = await open(raw);
		const result = track(ctx.credentials("connect"));
		await settle(clock);
		const credentials = {
			headers: { Authorization: "Bearer t", "X-Tenant": "a" },
			connectionParams: { token: "t", nested: { a: [1, null] } },
			auth: { token: "t" },
		};
		answer(raw, 0, { ok: true, credentials, revision: 1 });
		await settle(clock);
		expect(result.value).toEqual(credentials);
	});
});

describe("grant lifetime", () => {
	it("forgets the scope's grant when its last group closes with no wait pending", async () => {
		setWorkerOriginForTests("https://app.test");
		const { clock, tab, open } = setup({
			limits: { idleCloseMs: 1 },
		});
		const raw = await tab({ credentials: true, revision: 1 });
		const ctx = await open(raw, "https://app.test/a", "a");
		const first = track(ctx.credentials("connect"));
		await settle(clock);
		answer(raw, 0, { ok: true, credentials: grant("t1"), revision: 1 });
		await settle(clock);
		expect(first.value).toEqual(grant("t1"));
		raw.send({ t: "unsubscribe", c: "a" });
		await settle(clock);
		clock.advance(1);
		await settle(clock);
		clock.advance(1);
		await settle(clock);
		const next = await open(raw, "https://app.test/b", "b");
		const second = track(next.credentials("connect"));
		await settle(clock);
		expect(raw.ofType("credentialsRequest")).toHaveLength(2);
		answer(raw, 1, { ok: true, credentials: grant("t2"), revision: 1 });
		await settle(clock);
		expect(second.value).toEqual(grant("t2"));
	});

	it("keeps the grant while another group of the scope is open", async () => {
		setWorkerOriginForTests("https://app.test");
		const { clock, tab, open } = setup({
			limits: { idleCloseMs: 1 },
		});
		const raw = await tab({ credentials: true, revision: 1 });
		const ctx = await open(raw, "https://app.test/a", "a");
		await open(raw, "https://app.test/b", "b");
		const first = track(ctx.credentials("connect"));
		await settle(clock);
		answer(raw, 0, { ok: true, credentials: grant("t1"), revision: 1 });
		await settle(clock);
		raw.send({ t: "unsubscribe", c: "a" });
		await settle(clock);
		clock.advance(1);
		await settle(clock);
		clock.advance(1);
		await settle(clock);
		const next = await open(raw, "https://app.test/c", "c");
		const again = track(next.credentials("connect"));
		await settle(clock);
		expect(again.value).toBe(first.value);
		expect(raw.ofType("credentialsRequest")).toHaveLength(1);
	});

	it("reject() for an unknown scope is a no-op and creates no state", () => {
		const broker = createBroker({
			clock: new ManualClock(),
			timeoutMs: () => 5_000,
			targets: () => [],
			onRevision: () => {},
			onStale: () => {},
		});
		broker.reject("nobody", 1);
		expect(broker.observe("nobody", 1, false)).toBe(true);
		expect(broker.revision("nobody")).toBe(1);
	});

	it("residual: asks a provider tab that attached while every asked tab retired", async () => {
		setWorkerOriginForTests("https://app.test");
		const { clock, tab, open } = setup();
		const first = await tab({ credentials: true, revision: 1 });
		const ctx = await open(first);
		const result = track(ctx.credentials("connect"));
		await settle(clock);
		expect(first.ofType("credentialsRequest")).toHaveLength(1);
		const late = await tab({ credentials: true, revision: 1 });
		first.send({ t: "detach" });
		await settle(clock);
		expect(late.ofType("credentialsRequest")).toHaveLength(1);
		answer(late, 0, { ok: true, credentials: grant("late"), revision: 1 });
		await settle(clock);
		expect(result.value).toEqual(grant("late"));
	});
});

describe("runtime authentication and retry edge cases", () => {
	it("fails a subscribe with authHeaders: true to an origin outside the audience", async () => {
		setWorkerOriginForTests("https://app.test");
		const { clock, test, tab } = setup({
			credentialOrigins: ["https://api.test"],
		});
		const raw = await tab({ credentials: true, revision: 1 });
		const refused = [
			"https://other.test/feed",
			"https://app.test.other.test/feed",
			"http://app.test/feed",
		];
		refused.forEach((url, index) => {
			raw.subscribe(`r${index}`, { connection: { url, authHeaders: true } });
		});
		await settle(clock);
		const errors = raw.ofType("error");
		expect(errors).toHaveLength(refused.length);
		for (const error of errors) {
			expect(error).toMatchObject({ code: "unsupported-option" });
			expect(error.message).toContain("authHeaders");
			expect(error.message).toContain("credentialOrigins");
			for (const url of refused) expect(error.message).not.toContain(url);
		}
		expect(test.connections).toHaveLength(0);
		raw.subscribe("own", {
			connection: { url: "https://app.test/feed", authHeaders: true },
		});
		raw.subscribe("listed", {
			connection: { url: "https://api.test/feed", authHeaders: true },
		});
		raw.subscribe("auto", { connection: { url: "https://other.test/auto" } });
		raw.subscribe("off", {
			connection: { url: "https://other.test/off", authHeaders: false },
		});
		await settle(clock);
		expect(raw.ofType("error")).toHaveLength(refused.length);
		expect(test.connections).toHaveLength(4);
	});

	it("reports no-credential-source before the audience when nobody could supply credentials", async () => {
		setWorkerOriginForTests("https://app.test");
		const { clock, tab, open } = setup();
		const cookies = await tab();
		const ctx = await open(cookies, "https://chat.other.test/api", "chat");
		const result = track(ctx.credentials("connect"));
		await settle(clock);
		expect(isSpinetabError(result.error, "no-credential-source")).toBe(true);
		const provider = await tab({ credentials: true, revision: 1 });
		const withProvider = track(ctx.credentials("connect"));
		await settle(clock);
		expect(isSpinetabError(withProvider.error, "credentials-audience")).toBe(
			true,
		);
		expect(provider.ofType("credentialsRequest")).toHaveLength(0);
	});

	it("ignores the no-argument rejectCredentials(): nothing attached, nothing rejected", async () => {
		setWorkerOriginForTests("https://app.test");
		const { clock, tab, open } = setup();
		const raw = await tab({ credentials: true, revision: 1 });
		const ctx = await open(raw);
		const first = track(ctx.credentials("connect"));
		await settle(clock);
		answer(raw, 0, { ok: true, credentials: grant("t1"), revision: 1 });
		await settle(clock);
		ctx.rejectCredentials();
		const again = track(ctx.credentials("reconnect"));
		await settle(clock);
		expect(again.value).toBe(first.value);
		expect(raw.ofType("credentialsRequest")).toHaveLength(1);
	});

	it("posts the SSE event name beside eventId", async () => {
		const { clock, test, tab } = setup();
		const raw = await tab();
		raw.subscribe("c", { connection: { url: "https://app.test/feed" } });
		await settle(clock);
		const sub = test.connections[0]?.subscriptions[0];
		sub?.emit("a", { eventId: "1", event: "price" });
		sub?.emit("b");
		await settle(clock);
		const [named, plain] = raw
			.ofType("event")
			.filter((message) => message.kind === "next");
		expect(named).toMatchObject({ eventId: "1", event: "price", data: "a" });
		expect(plain).not.toHaveProperty("event");
		expect(plain).not.toHaveProperty("eventId");
	});
});

// Regression coverage for clock, credential and lifecycle boundaries.

describe("C1-F1 a provider revision never rotates anonymous groups", () => {
	async function twoGroups() {
		setWorkerOriginForTests("https://app.test");
		const { clock, test, tab, open } = setup();
		const anonymous = await tab({ anonymous: true, credentials: false });
		const provider = await tab({ credentials: true, revision: 1 });
		const anonymousCtx = await open(anonymous);
		const providerCtx = await open(provider);
		const anonymousConn = test.connections.find((c) => c.ctx === anonymousCtx);
		const providerConn = test.connections.find((c) => c.ctx === providerCtx);
		if (!anonymousConn || !providerConn) throw new Error("expected two groups");
		expect(anonymousCtx.key).toContain("+anonymous");
		expect(providerCtx.key).not.toContain("+anonymous");
		return { clock, provider, anonymousConn, providerConn };
	}

	it("C1-F1 setCredentialRevision(n, { restart: true }) from a provider tab restarts only provider groups", async () => {
		const { clock, provider, anonymousConn, providerConn } = await twoGroups();
		provider.send({ t: "revision", revision: 2, restart: true });
		await settle(clock);
		expect(providerConn.rotations).toBe(1);
		expect(anonymousConn.rotations).toBe(0);
	});

	it("C1-F1 a provider tab's new revision does not rotate an auth-blocked anonymous group", async () => {
		const { clock, provider, anonymousConn, providerConn } = await twoGroups();
		// A cookie 401 on the anonymous connection (no provider material).
		anonymousConn.ctx.setStatus({
			state: "auth-blocked",
			reason: "credentials-rejected",
			code: "http:401",
		});
		await settle(clock);
		provider.send({ t: "revision", revision: 2, restart: false });
		await settle(clock);
		expect(providerConn.rotations).toBe(0);
		expect(anonymousConn.rotations).toBe(0);
	});

	it("C1-F1 guard: an auth-blocked provider group still moves on the new revision", async () => {
		const { clock, provider, anonymousConn, providerConn } = await twoGroups();
		providerConn.ctx.setStatus({
			state: "auth-blocked",
			reason: "credentials-rejected",
			code: "http:401",
		});
		await settle(clock);
		provider.send({ t: "revision", revision: 2, restart: false });
		await settle(clock);
		expect(providerConn.rotations).toBe(1);
		expect(anonymousConn.rotations).toBe(0);
	});
});

describe("C1-F5 the broker refuses the header names the page refuses", () => {
	const reply = {
		headers: { "access-control-request-private-network": "true" },
	};

	it("C1-F5 the broker refuses every access-control-request-* name, like the page", () => {
		expect(isCredentials(reply)).toBe(false);
		expect(isProviderShape(reply)).toBe(false);
	});

	it("C1-F5 a raw provider reply with such a header ends credentials-failed, not a grant", async () => {
		setWorkerOriginForTests("https://app.test");
		const { clock, tab, open } = setup();
		const raw = await tab({ credentials: true, revision: 1 });
		const ctx = await open(raw);
		const result = track(ctx.credentials("connect"));
		await settle(clock);
		answer(raw, 0, { ok: true, credentials: reply, revision: 1 });
		await settle(clock);
		expect(isSpinetabError(result.error, "credentials-failed")).toBe(true);
		expect(result.value).toBeUndefined();
	});

	// The two predicates live apart on purpose (the runtime does not import the
	// page's option guards), so this table pins their parity instead.
	const names = [
		"Accept-Charset",
		"accept-encoding",
		"Access-Control-Request-Headers",
		"access-control-request-method",
		"access-control-request-private-network",
		"Access-Control-Request-Anything",
		"access-control-request-",
		"access-control-allow-origin",
		"access-control-request",
		"connection",
		"content-length",
		"cookie",
		"Cookie2",
		"cookie3",
		"date",
		"DNT",
		"expect",
		"host",
		"keep-alive",
		"last-event-id",
		"origin",
		"referer",
		"set-cookie",
		"te",
		"trailer",
		"transfer-encoding",
		"upgrade",
		"via",
		"proxy-authorization",
		"Proxy-",
		"sec-fetch-mode",
		"Sec-",
		"authorization",
		"x-tenant",
		"x_tenant",
		"a!#$%&'*+.^_`|~b",
		"bad name",
		"bad:name",
		"",
		"é",
	];
	for (const name of names) {
		it(`C1-F5 parity: ${JSON.stringify(name)} is judged alike by the page and the broker`, () => {
			const value = { headers: { [name]: "v" } };
			expect(isProviderShape(value)).toBe(isCredentials(value));
		});
	}
});
