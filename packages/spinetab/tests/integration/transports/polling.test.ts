import {
	afterEach,
	beforeEach,
	describe,
	expect,
	inject,
	it,
	vi,
} from "vitest";
import { createRuntime, type Runtime } from "../../../src/core/runtime.ts";
import type {
	CredentialRequest,
	SpinetabClient,
} from "../../../src/core/types.ts";
import { pollEvery, polling } from "../../../src/transports/polling/index.ts";
import { pollingAdapter } from "../../../src/transports/polling/runtime.ts";
import { byId, fault, sleep, tab, uniqueId, waitFor } from "../core/helpers.ts";

// over real HTTP
// against the polling fixture, through the real page client and runtime.

const [origin] = inject("fixtureOrigins");
const runtimes: Runtime[] = [];
const clients: SpinetabClient[] = [];
const faults: string[] = [];

beforeEach(() => {
	// The runtime runs on the fixture's origin, so auto mode merges.
	vi.stubGlobal("location", { origin });
});

afterEach(async () => {
	vi.unstubAllGlobals();
	for (const client of clients.splice(0)) client.dispose();
	for (const runtime of runtimes.splice(0)) runtime.dispose();
	for (const action of faults.splice(0)) await fault(origin, action, null);
});

/**
 * refuses `auth` as a URL query name in the builders and validators, so the
 * fixture's `guard=required` switch is added below them, at fetch time, where
 * no application option reaches.
 */
const withFixtureAuthSwitch: typeof fetch = (input, init) => {
	const url = new URL(input instanceof Request ? input.url : String(input));
	url.searchParams.set("guard", "required");
	return fetch(url, init);
};

function runtime(options: { fixtureAuthSwitch?: boolean } = {}) {
	const created = createRuntime({
		adapters: [
			pollingAdapter(
				options.fixtureAuthSwitch ? { fetch: withFixtureAuthSwitch } : {},
			),
		],
	});
	runtimes.push(created);
	return created;
}

function open(shared: Runtime, options = {}) {
	const opened = tab(shared, origin, options);
	clients.push(opened.client);
	return opened;
}

async function setFault(action: string, value: unknown) {
	faults.push(action);
	await fault(origin, action, value);
}

const feedFor = (id: string, extra = "") =>
	polling({ url: `/poll/value?id=${id}${extra}` }).subscription<{
		n: number;
		scope: string | null;
	}>();

describe("polling against the fixture", () => {
	it("shares one schedule across tabs: one request per interval, never overlapping", async () => {
		const shared = runtime();
		const id = uniqueId("shared");
		await setFault("delay-ms", { id, ms: 1_300 });
		const seen: number[][] = [[], [], []];
		for (let index = 0; index < 3; index += 1) {
			open(shared).client.subscribe(
				feedFor(id),
				{ next: (value) => seen[index]?.push(value.n) },
				pollEvery(1_000),
			);
		}
		await waitFor(() => (seen[0]?.length ?? 0) >= 3, 12_000);
		const { stats, requests } = await byId(origin, id);
		expect(stats.maxInFlight).toBe(1);
		// Fixed delay from completion: requests are at least interval + delay apart.
		const gaps = requests
			.slice(1)
			.map((request, index) => request.at - (requests[index]?.at ?? 0));
		expect(Math.min(...gaps)).toBeGreaterThanOrEqual(2_200);
		expect(seen[1]?.slice(0, 3)).toEqual(seen[0]?.slice(0, 3));
		expect(shared.stats().subscriptions).toBe(1);
	});

	it("coalesces simultaneous joins into one read and never serves a late joiner an old result", async () => {
		const shared = runtime();
		const id = uniqueId("join");
		const first: number[] = [];
		const client = open(shared).client;
		client.subscribe(
			feedFor(id),
			{ next: (value) => first.push(value.n) },
			pollEvery(10_000),
		);
		for (let index = 0; index < 4; index += 1)
			client.subscribe(feedFor(id), { next: () => {} }, pollEvery(10_000));
		await waitFor(() => first.length >= 1);
		await sleep(300);
		expect((await byId(origin, id)).stats.requests).toBe(1);
		const late: number[] = [];
		open(shared).client.subscribe(
			feedFor(id),
			{ next: (value) => late.push(value.n) },
			pollEvery(10_000),
		);
		await waitFor(() => late.length >= 1);
		expect(late[0]).toBe(2);
		expect((await byId(origin, id)).stats.requests).toBe(2);
	});

	it("makes zero requests while no consumer is eligible and one catch-up read on return", async () => {
		const shared = runtime();
		const id = uniqueId("hidden");
		const opened = open(shared);
		const values: number[] = [];
		opened.client.subscribe(
			feedFor(id),
			{ next: (value) => values.push(value.n) },
			pollEvery(1_000),
		);
		await waitFor(() => values.length >= 1);
		opened.setVisible(false);
		await sleep(100);
		const before = (await byId(origin, id)).stats.requests;
		await sleep(3_200);
		expect((await byId(origin, id)).stats.requests).toBe(before);
		opened.setVisible(true);
		await waitFor(
			async () => (await byId(origin, id)).stats.requests === before + 1,
			2_000,
		);
		await sleep(500);
		expect((await byId(origin, id)).stats.requests).toBe(before + 1);
		expect(values.at(-1)).toBe(before + 1);
	});

	it("aborts the in-flight read when the last consumer leaves", async () => {
		const shared = runtime();
		const id = uniqueId("abort");
		await setFault("hang", { id });
		const handle = open(shared).client.subscribe(
			feedFor(id),
			{ next: () => {} },
			pollEvery(1_000),
		);
		await waitFor(async () => (await byId(origin, id)).stats.inFlight === 1);
		handle.unsubscribe();
		await waitFor(
			async () => (await byId(origin, id)).stats.aborted === 1,
			3_000,
		);
		expect((await byId(origin, id)).stats.inFlight).toBe(0);
	});

	it("merges credentials.headers per read and blocks on a rejected revision without spinning", async () => {
		const shared = runtime({ fixtureAuthSwitch: true });
		const id = uniqueId("auth");
		let token = "revoked-carol-1";
		// The provider result is closed: `headers` only.
		const provider = (_request: CredentialRequest) => ({
			headers: { authorization: `Bearer ${token}` },
		});
		const { client } = open(shared, {
			scope: "carol",
			credentialRevision: 1,
			credentials: provider,
		});
		const values: Array<{ n: number; scope: string | null }> = [];
		const handle = client.subscribe(
			feedFor(id),
			{ next: (value) => values.push(value) },
			pollEvery(1_000),
		);
		await waitFor(
			() => handle.status.get().connection.state === "auth-blocked",
			4_000,
		);
		expect(handle.status.get().connection).toMatchObject({
			reason: "credentials-rejected",
			code: "http:401",
		});
		await sleep(2_500);
		const blocked = await byId(origin, id);
		expect(blocked.stats.requests).toBe(1);
		expect(blocked.requests[0]?.hasAuth).toBe(true);
		token = "valid-carol-2";
		client.setCredentialRevision(2);
		await waitFor(() => values.length >= 1, 4_000);
		expect(values[0]?.scope).toBe("carol");
		expect(handle.status.get().connection.state).toBe("connected");
		expect(JSON.stringify(shared.stats())).not.toContain("valid-carol");
	});

	it("backs off on 500 and recovers when the server does", async () => {
		const shared = runtime();
		const id = uniqueId("flaky");
		await setFault("status", { id, status: 500 });
		const values: number[] = [];
		const handle = open(shared).client.subscribe(
			feedFor(id),
			{ next: (value) => values.push(value.n) },
			pollEvery(1_000),
		);
		await waitFor(
			() => handle.status.get().connection.state === "reconnecting",
			4_000,
		);
		expect(handle.status.get().connection).toMatchObject({
			reason: "server-closed",
			code: 500,
			attempt: 1,
		});
		await fault(origin, "status", null);
		await waitFor(() => values.length >= 1, 8_000);
		expect(handle.status.get().connection.state).toBe("connected");
		expect(handle.status.get().continuity.state).toBe("continuous");
	});

	it("fails an oversized body without delivering it", async () => {
		const shared = runtime();
		const id = uniqueId("big");
		await setFault("oversized", { id, bytes: 400_000 });
		const values: unknown[] = [];
		const handle = open(shared).client.subscribe(
			feedFor(id),
			{ next: (value) => values.push(value) },
			pollEvery(1_000),
		);
		await waitFor(
			() => handle.status.get().connection.state === "failed",
			4_000,
		);
		expect(handle.status.get().connection).toMatchObject({
			code: "frame-too-large",
		});
		expect(handle.status.get().continuity).toMatchObject({
			state: "gap",
			reason: "message-too-large",
		});
		expect(values).toEqual([]);
	});

	it("aborts old-scope reads on a scope change and never delivers their results", async () => {
		const shared = runtime();
		const id = uniqueId("scope");
		await setFault("delay-ms", { id, ms: 800 });
		const provider = (request: CredentialRequest) => ({
			headers: { authorization: `Bearer valid-${request.scope}-1` },
		});
		const { client } = open(shared, { scope: "alice", credentials: provider });
		const values: Array<{ scope: string | null }> = [];
		client.subscribe(
			feedFor(id),
			{ next: (value) => values.push(value) },
			pollEvery(1_000),
		);
		await waitFor(async () => (await byId(origin, id)).stats.inFlight === 1);
		client.setScope("bob");
		await waitFor(() => values.length >= 1, 5_000);
		expect(values.every((value) => value.scope === "bob")).toBe(true);
		const { requests } = await byId(origin, id);
		expect(requests[0]).toMatchObject({ scope: "alice", aborted: true });
	});
});
