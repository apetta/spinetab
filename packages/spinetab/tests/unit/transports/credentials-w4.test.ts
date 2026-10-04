import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterSubscription } from "../../../src/core/adapter.ts";
import { SpinetabError } from "../../../src/core/errors.ts";
import type { Credentials, Json } from "../../../src/core/types.ts";
import { polling } from "../../../src/transports/polling/index.ts";
import { pollingAdapter } from "../../../src/transports/polling/runtime.ts";
import { classifyStatus } from "../../../src/transports/shared/http.ts";
import { sse } from "../../../src/transports/sse/index.ts";
import { sseAdapter } from "../../../src/transports/sse/runtime.ts";
import { stream } from "../../../src/transports/stream/index.ts";
import { streamAdapter } from "../../../src/transports/stream/runtime.ts";
import {
	eventStream,
	type FakeContext,
	fakeContext,
	flush,
	recordingSink,
	type ScriptedRequest,
	SUBSCRIBE_OPTIONS,
	scriptedBody,
	scriptedFetch,
} from "./helpers.ts";

// with one credential-header rule for the
// three HTTP transports, judged per request URL against the worker's origin.

const APP = "https://app.test";
const SAME = `${APP}/api/feed`;
const OTHER = "https://other.test/feed";

type Responder = (request: ScriptedRequest) => Response | Promise<Response>;

const ok = () => new Response('{"ok":true}', { status: 200 });
const status =
	(code: number, headers: Record<string, string> = {}) =>
	() =>
		new Response(null, { status: code, headers });
const bearer = (): Promise<Credentials> =>
	Promise.resolve({ headers: { authorization: "Bearer t" } });
const noSource = (): Promise<Credentials> =>
	Promise.reject(new SpinetabError("no-credential-source", "none"));

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("location", { origin: APP });
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

/** One polling identity, one consumer; returns the scripted requests. */
function poll(
	options: Record<string, unknown>,
	responders: Responder[],
	fake: FakeContext = fakeContext(),
) {
	const script = scriptedFetch(responders);
	const adapter = pollingAdapter({ fetch: script.fetch as typeof fetch });
	const { url, ...rest } = options as { url: string };
	const spec = polling(url, rest).connection;
	const connection = adapter.connect(spec, fake.ctx);
	const handle = connection.subscribe({}, recordingSink().sink, {
		key: "poll",
		repeatable: true,
	}) as Required<AdapterSubscription<Json>>;
	handle.consumerAdded("a", { intervalMs: 1_000 }, { visible: true });
	return { ...script, fake, connection, adapter, spec };
}

describe("polling: one credential-header rule", () => {
	it("auto merges provider headers on a same-origin URL and passes the URL", async () => {
		const fake = fakeContext();
		fake.setCredentials(bearer);
		const { requests } = poll({ url: SAME }, [ok], fake);
		await vi.advanceTimersByTimeAsync(0);
		expect(requests[0]?.headers.get("authorization")).toBe("Bearer t");
		expect(fake.credentialUrls).toEqual([SAME]);
	});

	it("auto never asks for credentials on a cross-origin URL", async () => {
		const fake = fakeContext();
		fake.setCredentials(bearer);
		const { requests } = poll({ url: OTHER }, [ok], fake);
		await vi.advanceTimersByTimeAsync(0);
		expect(requests).toHaveLength(1);
		expect(requests[0]?.headers.get("authorization")).toBeNull();
		expect(fake.credentialCalls).toEqual([]);
	});

	it("auto never merges when no worker origin is available", async () => {
		vi.stubGlobal("location", undefined);
		const fake = fakeContext();
		fake.setCredentials(bearer);
		const { requests } = poll({ url: SAME }, [ok], fake);
		await vi.advanceTimersByTimeAsync(0);
		expect(requests[0]?.headers.get("authorization")).toBeNull();
		expect(fake.credentialCalls).toEqual([]);
	});

	it("auto compares the exact origin, never a hostname suffix", async () => {
		const fake = fakeContext();
		fake.setCredentials(bearer);
		const { requests } = poll(
			{ url: "https://app.test.evil.example/api" },
			[ok],
			fake,
		);
		await vi.advanceTimersByTimeAsync(0);
		expect(requests[0]?.headers.get("authorization")).toBeNull();
		expect(fake.credentialCalls).toEqual([]);
	});

	it("auto without a provider reads anonymously", async () => {
		const fake = fakeContext();
		const { requests } = poll({ url: SAME }, [ok], fake);
		await vi.advanceTimersByTimeAsync(0);
		expect(requests).toHaveLength(1);
		expect(requests[0]?.headers.get("authorization")).toBeNull();
		expect(fake.last()).toMatchObject({ state: "connected" });
	});

	it("no downgrade: an identity that read with provider headers blocks when the source disappears", async () => {
		const fake = fakeContext();
		fake.setCredentials(bearer);
		const { requests } = poll({ url: SAME }, [ok, ok], fake);
		await vi.advanceTimersByTimeAsync(0);
		expect(requests).toHaveLength(1);
		fake.setCredentials(noSource);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(requests).toHaveLength(1);
		expect(fake.last()).toMatchObject({
			state: "auth-blocked",
			reason: "credentials-missing",
		});
	});

	it("authHeaders true asks with the cross-origin URL; false never asks", async () => {
		const always = fakeContext();
		always.setCredentials(bearer);
		const merged = poll({ url: OTHER, authHeaders: true }, [ok], always);
		await vi.advanceTimersByTimeAsync(0);
		expect(merged.requests[0]?.headers.get("authorization")).toBe("Bearer t");
		expect(always.credentialUrls).toEqual([OTHER]);

		const never = fakeContext();
		never.setCredentials(bearer);
		const plain = poll({ url: SAME, authHeaders: false }, [ok], never);
		await vi.advanceTimersByTimeAsync(0);
		expect(plain.requests[0]?.headers.get("authorization")).toBeNull();
		expect(never.credentialCalls).toEqual([]);
	});

	it("authHeaders true without a provider blocks and sends nothing", async () => {
		const fake = fakeContext();
		const { requests } = poll({ url: SAME, authHeaders: true }, [ok], fake);
		await vi.advanceTimersByTimeAsync(0);
		expect(requests).toHaveLength(0);
		expect(fake.last()).toMatchObject({
			state: "auth-blocked",
			reason: "no-credential-source",
		});
	});

	it("unset, true and false are three identities; the builder fills no default", () => {
		const adapter = pollingAdapter();
		const unset = polling(SAME).connection;
		const on = polling(SAME, { authHeaders: true }).connection;
		const off = polling(SAME, { authHeaders: false }).connection;
		expect("authHeaders" in unset).toBe(false);
		const keys = [unset, on, off].map((spec) => adapter.connectionKey?.(spec));
		expect(new Set(keys).size).toBe(3);
		expect(() => polling(SAME, { authHeaders: "yes" as never })).toThrow(
			/authHeaders/,
		);
		expect(() =>
			adapter.validateConnection?.({ ...unset, authHeaders: 1 }),
		).toThrow(/authHeaders/);
	});

	it("credentials-audience blocks permanently; rotation does not restart it", async () => {
		const fake = fakeContext();
		fake.setCredentials(() =>
			Promise.reject(
				new SpinetabError("credentials-audience", "not in credentialOrigins"),
			),
		);
		const { requests, connection } = poll(
			{ url: OTHER, authHeaders: true },
			[ok],
			fake,
		);
		await vi.advanceTimersByTimeAsync(0);
		expect(requests).toHaveLength(0);
		expect(fake.last()).toMatchObject({
			state: "auth-blocked",
			reason: "credentials-audience",
		});
		connection.rotate?.();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(fake.credentialCalls).toHaveLength(1);
	});

	it("a request carrying provider headers never follows a redirect; a redirect fails permanent-error redirect", async () => {
		const fake = fakeContext();
		fake.setCredentials(bearer);
		const { requests } = poll(
			{ url: SAME },
			[status(302, { location: "https://evil.example/" })],
			fake,
		);
		await vi.advanceTimersByTimeAsync(0);
		expect(requests[0]?.init.redirect).toBe("manual");
		expect(fake.last()).toMatchObject({
			state: "failed",
			reason: "permanent-error",
			code: "redirect",
		});
		await vi.advanceTimersByTimeAsync(60_000);
		expect(requests).toHaveLength(1);
	});

	it("a request without provider material keeps the platform redirect default", async () => {
		const { requests } = poll({ url: OTHER }, [ok]);
		await vi.advanceTimersByTimeAsync(0);
		expect(requests[0]?.init.redirect).toBeUndefined();
	});

	it("a 401 rejects exactly the attached grant and reports http:401", async () => {
		const fake = fakeContext();
		const grant = { headers: { authorization: "Bearer t" } };
		fake.setCredentials(() => Promise.resolve(grant));
		poll({ url: SAME }, [status(401)], fake);
		await vi.advanceTimersByTimeAsync(0);
		expect(fake.rejected).toEqual([grant]);
		expect(fake.rejected[0]).toBe(grant);
		expect(fake.last()).toMatchObject({
			state: "auth-blocked",
			reason: "credentials-rejected",
			code: "http:401",
		});
	});

	it("a 401 on a request that carried no provider material rejects nothing", async () => {
		const fake = fakeContext();
		fake.setCredentials(() => Promise.resolve({ connectionParams: { a: 1 } }));
		poll({ url: SAME }, [status(401)], fake);
		await vi.advanceTimersByTimeAsync(0);
		expect(fake.rejections()).toBe(0);
		expect(fake.last()).toMatchObject({
			state: "auth-blocked",
			code: "http:401",
		});
	});

	it("a 403 ends as permanent-error forbidden and rejects nothing", async () => {
		const fake = fakeContext();
		fake.setCredentials(bearer);
		const { requests } = poll({ url: SAME }, [status(403)], fake);
		await vi.advanceTimersByTimeAsync(0);
		expect(fake.rejections()).toBe(0);
		expect(fake.last()).toMatchObject({
			state: "failed",
			reason: "permanent-error",
			code: "forbidden",
		});
		await vi.advanceTimersByTimeAsync(60_000);
		expect(requests).toHaveLength(1);
	});
});

describe("fetch streams and fetch-mode SSE: the same rule", () => {
	const builders = [
		{
			name: "stream",
			adapter: () => streamAdapter(),
			spec: (url: string, options: Record<string, unknown> = {}) =>
				stream(url, { repeatable: true, ...options }).connection,
		},
		{
			name: "sse",
			adapter: () => sseAdapter(),
			spec: (url: string, options: Record<string, unknown> = {}) =>
				sse(url, options).connection,
		},
	] as const;

	for (const builder of builders) {
		function open(
			url: string,
			options: Record<string, unknown>,
			responders: Responder[],
			fake: FakeContext = fakeContext(),
		) {
			const script = scriptedFetch(responders);
			vi.stubGlobal("fetch", script.fetch);
			const adapter = builder.adapter();
			const spec = builder.spec(url, options);
			const connection = adapter.connect(spec as never, fake.ctx);
			const sink = recordingSink();
			connection.subscribe({} as never, sink.sink as never, SUBSCRIBE_OPTIONS);
			return { ...script, fake, connection, sink, spec, adapter };
		}
		const live = (request: ScriptedRequest) =>
			eventStream(
				scriptedBody(),
				builder.name === "stream"
					? { headers: { "content-type": "application/x-ndjson" } }
					: {},
				request.init.signal ?? undefined,
			);

		it(`(${builder.name}): auto merges on a same-origin URL and passes the URL`, async () => {
			const fake = fakeContext();
			fake.setCredentials(bearer);
			const { requests } = open(SAME, {}, [live], fake);
			await flush();
			expect(requests[0]?.headers.get("authorization")).toBe("Bearer t");
			expect(fake.credentialUrls).toEqual([SAME]);
		});

		it(`(${builder.name}): auto never asks on a cross-origin URL; false never asks`, async () => {
			const fake = fakeContext();
			fake.setCredentials(bearer);
			const cross = open(OTHER, {}, [live], fake);
			await flush();
			expect(cross.requests[0]?.headers.get("authorization")).toBeNull();
			const off = open(SAME, { authHeaders: false }, [live], fake);
			await flush();
			expect(off.requests[0]?.headers.get("authorization")).toBeNull();
			expect(fake.credentialCalls).toEqual([]);
		});

		it(`(${builder.name}): auto without a provider connects without headers`, async () => {
			const fake = fakeContext();
			const { requests } = open(SAME, {}, [live], fake);
			await flush();
			expect(requests).toHaveLength(1);
			expect(requests[0]?.headers.get("authorization")).toBeNull();
			expect(fake.states()).toContain("connected");
		});

		it(`(${builder.name}): unset, true and false are three identities`, () => {
			const adapter = builder.adapter();
			const keys = [undefined, true, false].map((authHeaders) =>
				adapter.connectionKey?.(
					builder.spec(
						SAME,
						authHeaders === undefined ? {} : { authHeaders },
					) as never,
				),
			);
			expect(new Set(keys).size).toBe(3);
		});

		it(`(${builder.name}): credentials-audience blocks permanently`, async () => {
			const fake = fakeContext();
			fake.setCredentials(() =>
				Promise.reject(new SpinetabError("credentials-audience", "no")),
			);
			const { requests, connection } = open(
				OTHER,
				{ authHeaders: true },
				[live, live],
				fake,
			);
			await flush();
			expect(requests).toHaveLength(0);
			expect(fake.last()).toMatchObject({
				state: "auth-blocked",
				reason: "credentials-audience",
			});
			connection.rotate?.();
			await flush();
			expect(fake.credentialCalls).toHaveLength(1);
		});

		it(`(${builder.name}): provider headers never follow a redirect`, async () => {
			const fake = fakeContext();
			fake.setCredentials(bearer);
			const { requests } = open(
				SAME,
				{},
				[status(307, { location: "https://evil.example/" })],
				fake,
			);
			await flush();
			expect(requests[0]?.init.redirect).toBe("manual");
			expect(fake.last()).toMatchObject({
				state: "failed",
				reason: "permanent-error",
				code: "redirect",
			});
			const plain = open(OTHER, {}, [live]);
			await flush();
			expect(plain.requests[0]?.init.redirect).toBeUndefined();
		});

		it(`(${builder.name}): a 401 rejects the attached grant and reports http:401`, async () => {
			const fake = fakeContext();
			const grant = { headers: { authorization: "Bearer t" } };
			fake.setCredentials(() => Promise.resolve(grant));
			open(SAME, {}, [status(401)], fake);
			await flush();
			expect(fake.rejected).toHaveLength(1);
			expect(fake.rejected[0]).toBe(grant);
			expect(fake.last()).toMatchObject({
				state: "auth-blocked",
				reason: "credentials-rejected",
				code: "http:401",
			});
		});

		it(`(${builder.name}): a 401 without attached material rejects nothing`, async () => {
			const fake = fakeContext();
			open(OTHER, {}, [status(401)], fake);
			await flush();
			expect(fake.rejections()).toBe(0);
			expect(fake.last()).toMatchObject({
				state: "auth-blocked",
				code: "http:401",
			});
		});

		it(`(${builder.name}): a 403 ends as permanent-error forbidden and rejects nothing`, async () => {
			const fake = fakeContext();
			fake.setCredentials(bearer);
			open(SAME, {}, [status(403)], fake);
			await flush();
			expect(fake.rejections()).toBe(0);
			expect(fake.last()).toMatchObject({
				state: "failed",
				reason: "permanent-error",
				code: "forbidden",
			});
		});
	}
});

describe("classification", () => {
	it("401 and 403 are distinct outcomes; a redirect (or an opaque redirect, status 0) is its own outcome", () => {
		expect(classifyStatus(401)).toEqual({ kind: "unauthorised" });
		expect(classifyStatus(403)).toEqual({ kind: "forbidden" });
		expect(classifyStatus(0)).toEqual({ kind: "redirect" });
		expect(classifyStatus(302)).toEqual({ kind: "redirect" });
		expect(classifyStatus(304)).toEqual({ kind: "permanent" });
	});
});
