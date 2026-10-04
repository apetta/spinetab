import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConnectionContext } from "../../../src/core/adapter.ts";
import { isSpinetabError } from "../../../src/core/errors.ts";
import {
	createRuntime,
	type Runtime,
	setWorkerOriginForTests,
} from "../../../src/core/runtime.ts";
import type { Credentials } from "../../../src/core/types.ts";
import { ManualClock, settle } from "./helpers/clock.ts";
import { RawPage } from "./helpers/page.ts";
import { createTestAdapter } from "./helpers/test-adapter.ts";

// (credential brokering).

const runtimes: Runtime[] = [];
// The connections below live on the worker's own origin.
beforeEach(() => setWorkerOriginForTests("https://x.test"));
afterEach(() => {
	for (const runtime of runtimes.splice(0)) runtime.dispose();
	setWorkerOriginForTests(undefined);
});

function setup() {
	const clock = new ManualClock();
	const test = createTestAdapter();
	const runtime = createRuntime({ adapters: [test.adapter], clock });
	runtimes.push(runtime);
	return { clock, test, runtime };
}

async function tab(
	runtime: Runtime,
	clock: ManualClock,
	fields: Record<string, unknown> = {},
) {
	const raw = new RawPage(runtime);
	raw.hello({ credentials: true, scope: "s", ...fields });
	await settle(clock);
	return raw;
}

async function connection(
	raw: RawPage,
	clock: ManualClock,
	test: ReturnType<typeof createTestAdapter>,
	url = "https://x.test/a",
) {
	raw.subscribe(`c-${url}`, { connection: { url } });
	await settle(clock);
	const found = test.connections.find(
		(entry) => (entry.spec as { url: string }).url === url,
	);
	if (!found) throw new Error("no connection");
	return found.ctx;
}

function track(promise: Promise<unknown>) {
	const state: { value?: unknown; error?: unknown; done: boolean } = {
		done: false,
	};
	promise.then(
		(value) => Object.assign(state, { value, done: true }),
		(error) => Object.assign(state, { error, done: true }),
	);
	return state;
}

const reply = (
	raw: RawPage,
	index: number,
	fields: Record<string, unknown>,
) => {
	const request = raw.ofType("credentialsRequest")[index];
	if (!request) throw new Error(`no credentials request ${index}`);
	raw.send({ t: "credentials", id: request.id, ...fields });
};

describe("credential brokering", () => {
	it("asks the most recently active tab in scope and returns its credentials", async () => {
		const { clock, test, runtime } = setup();
		const older = await tab(runtime, clock, { revision: 1 });
		const other = await tab(runtime, clock, { scope: "other", revision: 1 });
		const recent = await tab(runtime, clock, { revision: 1 });
		const ctx = await connection(recent, clock, test);
		older.send({ t: "renew" });
		await settle(clock);
		const result = track(ctx.credentials("connect"));
		await settle(clock);
		expect(older.ofType("credentialsRequest")).toHaveLength(1);
		expect(recent.ofType("credentialsRequest")).toHaveLength(0);
		expect(other.ofType("credentialsRequest")).toHaveLength(0);
		expect(older.ofType("credentialsRequest")[0]).toMatchObject({
			scope: "s",
			revision: 1,
			reason: "connect",
		});
		reply(older, 0, {
			ok: true,
			credentials: { headers: { authorization: "Bearer t1" } },
			revision: 1,
		});
		await settle(clock);
		expect(result.value).toEqual({ headers: { authorization: "Bearer t1" } });
		expect(JSON.stringify(runtime.stats())).not.toContain("Bearer");
	});

	it("keeps one request in flight per scope and reuses the credential for the current revision", async () => {
		const { clock, test, runtime } = setup();
		const raw = await tab(runtime, clock, { revision: 3 });
		const first = await connection(raw, clock, test, "https://x.test/1");
		const second = await connection(raw, clock, test, "https://x.test/2");
		const a = track(first.credentials("connect"));
		const b = track(second.credentials("reconnect"));
		await settle(clock);
		expect(raw.ofType("credentialsRequest")).toHaveLength(1);
		reply(raw, 0, {
			ok: true,
			credentials: { auth: { token: "t3" } },
			revision: 3,
		});
		await settle(clock);
		expect(a.value).toEqual({ auth: { token: "t3" } });
		expect(b.value).toEqual({ auth: { token: "t3" } });
		const c = track(first.credentials("reconnect"));
		await settle(clock);
		expect(c.value).toEqual({ auth: { token: "t3" } });
		expect(raw.ofType("credentialsRequest")).toHaveLength(1);
		const fresh = track(first.credentials("retry"));
		await settle(clock);
		expect(raw.ofType("credentialsRequest")).toHaveLength(2);
		reply(raw, 1, {
			ok: true,
			credentials: { auth: { token: "t3b" } },
			revision: 3,
		});
		await settle(clock);
		expect(fresh.value).toEqual({ auth: { token: "t3b" } });
	});

	it("times out each tab after 5 s, tries at most 3 tabs, then reports credentials-timeout", async () => {
		const { clock, test, runtime } = setup();
		const tabs: RawPage[] = [];
		for (let index = 0; index < 4; index += 1)
			tabs.push(await tab(runtime, clock));
		const ctx = await connection(tabs[0] as RawPage, clock, test);
		const result = track(ctx.credentials("connect"));
		await settle(clock);
		const asked = () =>
			tabs.map((raw) => raw.ofType("credentialsRequest").length);
		expect(asked().reduce((sum, count) => sum + count, 0)).toBe(1);
		clock.advance(4_999);
		await settle(clock);
		expect(asked().reduce((sum, count) => sum + count, 0)).toBe(1);
		clock.advance(1);
		await settle(clock);
		clock.advance(5_000);
		await settle(clock);
		clock.advance(5_000);
		await settle(clock);
		expect(asked().reduce((sum, count) => sum + count, 0)).toBe(3);
		expect(isSpinetabError(result.error, "credentials-timeout")).toBe(true);
		expect(runtime.stats().pendingCredentialRequests).toBe(0);
	});

	it("reports no-credential-source when no tab in scope has a provider", async () => {
		const { clock, test, runtime } = setup();
		const raw = await tab(runtime, clock, { credentials: false });
		const ctx = await connection(raw, clock, test);
		const result = track(ctx.credentials("connect"));
		await settle(clock);
		expect(isSpinetabError(result.error, "no-credential-source")).toBe(true);
	});

	it("reuses the latest unrejected credential when no tab answers", async () => {
		const { clock, test, runtime } = setup();
		const raw = await tab(runtime, clock, { revision: 1 });
		const ctx = await connection(raw, clock, test);
		const first = track(ctx.credentials("connect"));
		await settle(clock);
		reply(raw, 0, {
			ok: true,
			credentials: { auth: { token: "t1" } },
			revision: 1,
		});
		await settle(clock);
		expect(first.value).toEqual({ auth: { token: "t1" } });
		const again = track(ctx.credentials("rotated"));
		await settle(clock);
		clock.advance(5_000);
		await settle(clock);
		expect(again.value).toEqual({ auth: { token: "t1" } });
	});

	it("ignores stale replies: wrong id, wrong attachment, after timeout and older revisions", async () => {
		const { clock, test, runtime } = setup();
		const a = await tab(runtime, clock, { revision: 5 });
		const b = await tab(runtime, clock, { revision: 5 });
		const ctx = await connection(b, clock, test);
		a.send({ t: "renew" });
		await settle(clock);
		const result = track(ctx.credentials("connect"));
		await settle(clock);
		const request = a.ofType("credentialsRequest")[0];
		b.send({
			t: "credentials",
			id: request?.id ?? "",
			ok: true,
			credentials: { auth: { token: "wrong-tab" } },
			revision: 5,
		});
		a.send({
			t: "credentials",
			id: "unknown",
			ok: true,
			credentials: { auth: { token: "wrong-id" } },
			revision: 5,
		});
		a.send({
			t: "credentials",
			id: request?.id ?? "",
			ok: true,
			credentials: { auth: { token: "old" } },
			revision: 4,
		});
		await settle(clock);
		expect(result.done).toBe(false);
		expect(runtime.stats().staleMessages).toBeGreaterThanOrEqual(3);
		expect(a.ofType("credentialsRequest")).toHaveLength(2);
		expect(a.ofType("credentialsRequest")[1]).toMatchObject({ revision: 5 });
		expect(b.ofType("credentialsRequest")).toHaveLength(0);
		// A second older answer is that tab's failure: the broker moves on.
		reply(a, 1, {
			ok: true,
			credentials: { auth: { token: "old" } },
			revision: 4,
		});
		await settle(clock);
		reply(b, 0, {
			ok: true,
			credentials: { auth: { token: "t5" } },
			revision: 5,
		});
		await settle(clock);
		expect(result.value).toEqual({ auth: { token: "t5" } });
		a.send({
			t: "credentials",
			id: request?.id ?? "",
			ok: true,
			credentials: { auth: { token: "late" } },
			revision: 5,
		});
		await settle(clock);
		expect(result.value).toEqual({ auth: { token: "t5" } });
	});

	it("never hands out a rejected revision: one upstream attempt per revision", async () => {
		const { clock, test, runtime } = setup();
		const raw = await tab(runtime, clock, { revision: 1 });
		const ctx = await connection(raw, clock, test);
		const first = track(ctx.credentials("connect"));
		await settle(clock);
		reply(raw, 0, {
			ok: true,
			credentials: { auth: { token: "t1" } },
			revision: 1,
		});
		await settle(clock);
		expect(first.value).toEqual({ auth: { token: "t1" } });
		ctx.rejectCredentials(first.value as Credentials);
		const second = track(ctx.credentials("reconnect"));
		await settle(clock);
		expect(raw.ofType("credentialsRequest")).toHaveLength(2);
		reply(raw, 1, {
			ok: true,
			credentials: { auth: { token: "t1-again" } },
			revision: 1,
		});
		await settle(clock);
		expect(isSpinetabError(second.error, "credentials-rejected")).toBe(true);
		raw.send({ t: "revision", revision: 1, restart: true });
		await settle(clock);
		expect(test.connections[0]?.rotations).toBe(0);
		raw.send({ t: "revision", revision: 2, restart: false });
		await settle(clock);
		const third = track(ctx.credentials("retry"));
		await settle(clock);
		reply(raw, 2, {
			ok: true,
			credentials: { auth: { token: "t2" } },
			revision: 2,
		});
		await settle(clock);
		expect(third.value).toEqual({ auth: { token: "t2" } });
	});

	it("applies newer revisions only, rotating on request or when auth-blocked", async () => {
		const { clock, test, runtime } = setup();
		const raw = await tab(runtime, clock, { revision: 2 });
		const ctx: ConnectionContext = await connection(raw, clock, test);
		const conn = test.connections[0];
		raw.send({ t: "revision", revision: 1, restart: true });
		raw.send({ t: "revision", revision: 2, restart: true });
		await settle(clock);
		expect(conn?.rotations).toBe(0);
		raw.send({ t: "revision", revision: 3, restart: false });
		await settle(clock);
		expect(conn?.rotations).toBe(0);
		raw.send({ t: "revision", revision: 4, restart: true });
		await settle(clock);
		expect(conn?.rotations).toBe(1);
		ctx.setStatus({ state: "auth-blocked", reason: "credentials-rejected" });
		raw.send({ t: "revision", revision: 5, restart: false });
		await settle(clock);
		expect(conn?.rotations).toBe(2);
	});

	it("unblocks a no-credential-source connection when a tab with a provider attaches", async () => {
		const { clock, test, runtime } = setup();
		const raw = await tab(runtime, clock, { credentials: false });
		const ctx = await connection(raw, clock, test);
		ctx.setStatus({ state: "auth-blocked", reason: "no-credential-source" });
		await tab(runtime, clock, { credentials: true });
		expect(test.connections[0]?.rotations).toBe(1);
	});

	it("moves to the next tab immediately when the asked tab detaches, and forgets credentials when the scope ends", async () => {
		const { clock, test, runtime } = setup();
		const a = await tab(runtime, clock, { revision: 1 });
		const b = await tab(runtime, clock, { revision: 1 });
		const ctx = await connection(b, clock, test);
		a.send({ t: "renew" });
		await settle(clock);
		const result = track(ctx.credentials("connect"));
		await settle(clock);
		expect(a.ofType("credentialsRequest")).toHaveLength(1);
		a.send({ t: "detach" });
		await settle(clock);
		expect(b.ofType("credentialsRequest")).toHaveLength(1);
		reply(b, 0, {
			ok: true,
			credentials: { auth: { token: "b" } },
			revision: 1,
		});
		await settle(clock);
		expect(result.value).toEqual({ auth: { token: "b" } });
		b.send({ t: "detach" });
		await settle(clock);
		const c = await tab(runtime, clock, { revision: 1, credentials: false });
		const ctx2 = await connection(c, clock, test, "https://x.test/b");
		const after = track(ctx2.credentials("connect"));
		await settle(clock);
		expect(isSpinetabError(after.error, "no-credential-source")).toBe(true);
	});
});

// The last page of a scope retiring while a
// refresh is in flight must fence the flight and forget the cached grant, over
// real MessageChannel ports; a scope that stays live keeps its cache.
describe("scope retirement during a credential refresh", () => {
	async function granted(
		runtime: Runtime,
		clock: ManualClock,
		test: ReturnType<typeof createTestAdapter>,
	) {
		const raw = await tab(runtime, clock, { revision: 1 });
		const ctx = await connection(raw, clock, test);
		const first = track(ctx.credentials("connect"));
		await settle(clock);
		reply(raw, 0, {
			ok: true,
			credentials: { auth: { token: "old-session" } },
			revision: 1,
		});
		await settle(clock);
		expect(first.value).toEqual({ auth: { token: "old-session" } });
		return { raw, ctx };
	}

	it("never resolves a refresh with the dropped grant when the last page's port closes mid-flight", async () => {
		const { clock, test, runtime } = setup();
		const { raw, ctx } = await granted(runtime, clock, test);
		const refresh = track(ctx.credentials("retry"));
		await settle(clock);
		expect(raw.ofType("credentialsRequest")).toHaveLength(2);
		raw.close();
		await settle(clock);
		expect(runtime.stats().attachments).toBe(0);
		expect(isSpinetabError(refresh.error, "no-credential-source")).toBe(true);
		expect(runtime.stats().pendingCredentialRequests).toBe(0);
		// A later page in the same scope without a provider must not inherit it.
		const later = await tab(runtime, clock, {
			revision: 1,
			credentials: false,
		});
		const ctx2 = await connection(later, clock, test, "https://x.test/later");
		const after = track(ctx2.credentials("connect"));
		await settle(clock);
		expect(isSpinetabError(after.error, "no-credential-source")).toBe(true);
	});

	it("asks a reloaded page of the scope instead of reviving the grant dropped by a detach mid-refresh", async () => {
		const { clock, test, runtime } = setup();
		const { raw, ctx } = await granted(runtime, clock, test);
		const refresh = track(ctx.credentials("retry"));
		await settle(clock);
		raw.send({ t: "detach" });
		await settle(clock);
		// The retired ask settles synchronously, so the fenced flight resumes
		// before any other port's message: it finds no page and no cache.
		expect(isSpinetabError(refresh.error, "no-credential-source")).toBe(true);
		expect(test.connections[0]?.disposed).toBe(true);
		const reloaded = await tab(runtime, clock, { revision: 1 });
		const ctx2 = await connection(reloaded, clock, test, "https://x.test/re");
		const next = track(ctx2.credentials("connect"));
		await settle(clock);
		expect(reloaded.ofType("credentialsRequest")).toHaveLength(1);
		reply(reloaded, 0, {
			ok: true,
			credentials: { auth: { token: "new-page" } },
			revision: 1,
		});
		await settle(clock);
		expect(next.value).toEqual({ auth: { token: "new-page" } });
	});

	it("keeps cache reuse while the scope stays live when one of two pages retires mid-refresh", async () => {
		const { clock, test, runtime } = setup();
		const { raw, ctx } = await granted(runtime, clock, test);
		const other = await tab(runtime, clock, { revision: 1 });
		raw.send({ t: "renew" });
		await settle(clock);
		const refresh = track(ctx.credentials("retry"));
		await settle(clock);
		expect(raw.ofType("credentialsRequest")).toHaveLength(2);
		raw.close();
		await settle(clock);
		expect(other.ofType("credentialsRequest")).toHaveLength(1);
		reply(other, 0, {
			ok: true,
			credentials: { auth: { token: "fresh" } },
			revision: 1,
		});
		await settle(clock);
		expect(refresh.value).toEqual({ auth: { token: "fresh" } });
		const ctx2 = await connection(other, clock, test, "https://x.test/again");
		const reused = track(ctx2.credentials("connect"));
		await settle(clock);
		expect(reused.value).toEqual({ auth: { token: "fresh" } });
		expect(other.ofType("credentialsRequest")).toHaveLength(1);
	});
});

// a provider that fails is a transient credentials failure, never
// "no credential source", which polling reads as permission to read
// anonymously (NT:579-580). Precedence after every asked tab: a success, then
// the latest usable grant, then timeout, then failure, then no source.
describe("a failing provider is never no-credential-source", () => {
	const failed = {
		ok: false,
		error: {
			code: "credentials-failed",
			message: "The credentials provider failed.",
		},
		revision: null,
	};

	/** The tabs holding an unanswered request, in the order they were asked. */
	const pending = (tabs: RawPage[], answered: number) =>
		tabs.filter((raw) => raw.ofType("credentialsRequest").length > answered);

	it("reports credentials-failed when the asked provider fails", async () => {
		const { clock, test, runtime } = setup();
		const raw = await tab(runtime, clock);
		const ctx = await connection(raw, clock, test);
		const result = track(ctx.credentials("connect"));
		await settle(clock);
		reply(raw, 0, failed);
		await settle(clock);
		expect(result.done).toBe(true);
		expect(isSpinetabError(result.error, "credentials-failed")).toBe(true);
		expect(isSpinetabError(result.error, "no-credential-source")).toBe(false);
		expect(runtime.stats().pendingCredentialRequests).toBe(0);
	});

	it.each([
		[
			"an uncloneable result",
			{
				ok: false,
				error: {
					code: "not-serialisable",
					message: "The credentials could not be cloned to the runtime.",
				},
				revision: null,
			},
		],
		["a success without credentials", { ok: true, revision: null }],
		["a failure without an error record", { ok: false, revision: null }],
	])("counts %s as a provider failure", async (_label, body) => {
		const { clock, test, runtime } = setup();
		const raw = await tab(runtime, clock);
		const ctx = await connection(raw, clock, test);
		const result = track(ctx.credentials("connect"));
		await settle(clock);
		reply(raw, 0, body);
		await settle(clock);
		expect(isSpinetabError(result.error, "credentials-failed")).toBe(true);
	});

	it.each([
		["a timeout, then a failure", ["timeout", "failure"]],
		["a failure, then a timeout", ["failure", "timeout"]],
	])("keeps credentials-timeout ahead of a failure: %s", async (_label, steps) => {
		const { clock, test, runtime } = setup();
		const tabs = [await tab(runtime, clock), await tab(runtime, clock)];
		const ctx = await connection(tabs[1] as RawPage, clock, test);
		const result = track(ctx.credentials("connect"));
		await settle(clock);
		for (const step of steps) {
			const [asked] = pending(tabs, 0);
			if (!asked) throw new Error("no tab was asked");
			if (step === "timeout") {
				clock.advance(5_000);
			} else {
				reply(asked, 0, failed);
			}
			await settle(clock);
			// An asked tab is never asked again within one request.
			tabs.splice(tabs.indexOf(asked), 1);
		}
		expect(result.done).toBe(true);
		expect(isSpinetabError(result.error, "credentials-timeout")).toBe(true);
	});

	it("still reports no-credential-source when no live page has a provider", async () => {
		const { clock, test, runtime } = setup();
		const without = await tab(runtime, clock, { credentials: false });
		const none = track(
			(await connection(without, clock, test)).credentials("connect"),
		);
		await settle(clock);
		expect(isSpinetabError(none.error, "no-credential-source")).toBe(true);
		// The only provider leaves before it answers: nobody failed.
		const leaving = await tab(runtime, clock);
		const ctx = await connection(leaving, clock, test, "https://x.test/b");
		const retired = track(ctx.credentials("connect"));
		await settle(clock);
		expect(leaving.ofType("credentialsRequest")).toHaveLength(1);
		leaving.send({ t: "detach" });
		await settle(clock);
		expect(isSpinetabError(retired.error, "no-credential-source")).toBe(true);
	});

	it("counts a no-credential-source reply from an asked tab as a provider failure", async () => {
		const { clock, test, runtime } = setup();
		// Only tabs that declared a provider are asked, so a "no source" answer
		// is a broken or forged provider, never permission to read anonymously.
		const answering = await tab(runtime, clock);
		const ctx = await connection(answering, clock, test);
		const answered = track(ctx.credentials("connect"));
		await settle(clock);
		reply(answering, 0, {
			ok: false,
			error: {
				code: "no-credential-source",
				message: "No credentials provider.",
			},
			revision: null,
		});
		await settle(clock);
		expect(isSpinetabError(answered.error, "credentials-failed")).toBe(true);
	});

	it("never masks an explicit provider failure with the cached grant", async () => {
		const { clock, test, runtime } = setup();
		const raw = await tab(runtime, clock, { revision: 1 });
		const ctx = await connection(raw, clock, test);
		const first = track(ctx.credentials("connect"));
		await settle(clock);
		reply(raw, 0, {
			ok: true,
			credentials: { auth: { token: "t1" } },
			revision: 1,
		});
		await settle(clock);
		expect(first.value).toEqual({ auth: { token: "t1" } });
		const again = track(ctx.credentials("rotated"));
		await settle(clock);
		reply(raw, 1, { ...failed, revision: 1 });
		await settle(clock);
		expect(again.value).toBeUndefined();
		expect(isSpinetabError(again.error, "credentials-failed")).toBe(true);
	});

	it("a timeout beside a failure reports credentials-timeout, not the cached grant", async () => {
		const { clock, test, runtime } = setup();
		const tabs = [
			await tab(runtime, clock, { revision: 1 }),
			await tab(runtime, clock, { revision: 1 }),
		];
		const ctx = await connection(tabs[1] as RawPage, clock, test);
		const asks = () =>
			tabs.map((raw) => raw.ofType("credentialsRequest").length);
		const first = track(ctx.credentials("connect"));
		await settle(clock);
		const granting = tabs[asks().indexOf(1)];
		if (!granting) throw new Error("no tab was asked");
		reply(granting, 0, {
			ok: true,
			credentials: { auth: { token: "t1" } },
			revision: 1,
		});
		await settle(clock);
		expect(first.value).toEqual({ auth: { token: "t1" } });
		const before = asks();
		const again = track(ctx.credentials("rotated"));
		await settle(clock);
		// The first tab asked fails; the second is then asked and times out.
		const failing = asks().findIndex((count, i) => count > (before[i] ?? 0));
		reply(tabs[failing] as RawPage, before[failing] ?? 0, {
			...failed,
			revision: 1,
		});
		await settle(clock);
		expect(asks()).toEqual(before.map((count) => count + 1));
		clock.advance(5_000);
		await settle(clock);
		expect(again.done).toBe(true);
		expect(again.value).toBeUndefined();
		expect(isSpinetabError(again.error, "credentials-timeout")).toBe(true);
	});

	it("asks a tab once more, at the current revision, when its reply is older", async () => {
		const { clock, test, runtime } = setup();
		const raw = await tab(runtime, clock, { revision: 1 });
		const ctx = await connection(raw, clock, test);
		const result = track(ctx.credentials("connect"));
		await settle(clock);
		// Another tab raised the scope to revision 2 (and may have closed).
		raw.send({ t: "revision", revision: 2, restart: false });
		await settle(clock);
		reply(raw, 0, {
			ok: true,
			credentials: { auth: { token: "old" } },
			revision: 1,
		});
		await settle(clock);
		expect(result.done).toBe(false);
		const asks = raw.ofType("credentialsRequest");
		expect(asks).toHaveLength(2);
		expect(asks[1]).toMatchObject({ revision: 2 });
		reply(raw, 1, {
			ok: true,
			credentials: { auth: { token: "new" } },
			revision: 2,
		});
		await settle(clock);
		expect(result.value).toEqual({ auth: { token: "new" } });
	});

	it("a second stale reply is a provider failure, never no-credential-source", async () => {
		const { clock, test, runtime } = setup();
		const raw = await tab(runtime, clock, { revision: 1 });
		const ctx = await connection(raw, clock, test);
		const result = track(ctx.credentials("connect"));
		await settle(clock);
		raw.send({ t: "revision", revision: 2, restart: false });
		await settle(clock);
		const stale = {
			ok: true,
			credentials: { auth: { token: "old" } },
			revision: 1,
		};
		reply(raw, 0, stale);
		await settle(clock);
		reply(raw, 1, stale);
		await settle(clock);
		// Asked once more, never a third time.
		expect(raw.ofType("credentialsRequest")).toHaveLength(2);
		expect(result.done).toBe(true);
		expect(isSpinetabError(result.error, "credentials-failed")).toBe(true);
		expect(runtime.stats().pendingCredentialRequests).toBe(0);
	});
});

describe("null versus numeric revisions across tabs", () => {
	it("a null-revision reply after a numeric rotation is stale: asked once more, then the next tab", async () => {
		const { clock, test, runtime } = setup();
		const numbered = await tab(runtime, clock, { revision: 2 });
		const unnumbered = await tab(runtime, clock);
		const ctx = await connection(numbered, clock, test);
		// The tab without a revision is the most recently active: asked first.
		clock.advance(1);
		unnumbered.send({ t: "renew" });
		await settle(clock);
		const result = track(ctx.credentials("connect"));
		await settle(clock);
		const unversioned = {
			ok: true,
			credentials: { auth: { token: "unversioned" } },
			revision: null,
		};
		reply(unnumbered, 0, unversioned);
		await settle(clock);
		expect(result.done).toBe(false);
		const asks = unnumbered.ofType("credentialsRequest");
		expect(asks).toHaveLength(2);
		expect(asks[1]).toMatchObject({ revision: 2 });
		reply(unnumbered, 1, unversioned);
		await settle(clock);
		expect(result.done).toBe(false);
		expect(numbered.ofType("credentialsRequest")).toHaveLength(1);
		reply(numbered, 0, {
			ok: true,
			credentials: { auth: { token: "two" } },
			revision: 2,
		});
		await settle(clock);
		expect(result.value).toEqual({ auth: { token: "two" } });
	});

	it("a null-revision grant cached before a numeric rotation is not reused when every tab times out", async () => {
		const { clock, test, runtime } = setup();
		const raw = await tab(runtime, clock);
		const ctx = await connection(raw, clock, test);
		const first = track(ctx.credentials("connect"));
		await settle(clock);
		reply(raw, 0, {
			ok: true,
			credentials: { auth: { token: "unversioned" } },
			revision: null,
		});
		await settle(clock);
		expect(first.value).toEqual({ auth: { token: "unversioned" } });
		raw.send({ t: "revision", revision: 3, restart: false });
		await settle(clock);
		const again = track(ctx.credentials("reconnect"));
		await settle(clock);
		expect(raw.ofType("credentialsRequest")[1]).toMatchObject({ revision: 3 });
		clock.advance(5_000);
		await settle(clock);
		expect(again.done).toBe(true);
		expect(again.value).toBeUndefined();
		expect(isSpinetabError(again.error, "credentials-timeout")).toBe(true);
	});

	it("guard: with no numeric revision in the scope a null grant is accepted and reused", async () => {
		const { clock, test, runtime } = setup();
		const raw = await tab(runtime, clock);
		const ctx = await connection(raw, clock, test);
		const first = track(ctx.credentials("connect"));
		await settle(clock);
		reply(raw, 0, {
			ok: true,
			credentials: { auth: { token: "unversioned" } },
			revision: null,
		});
		await settle(clock);
		expect(first.value).toEqual({ auth: { token: "unversioned" } });
		const reused = track(ctx.credentials("connect"));
		await settle(clock);
		expect(reused.value).toEqual({ auth: { token: "unversioned" } });
		expect(raw.ofType("credentialsRequest")).toHaveLength(1);
	});
});
