import { afterEach, describe, expect, it } from "vitest";
import type { AdapterConnection } from "../../../src/core/adapter.ts";
import { graphqlSse } from "../../../src/protocols/graphql-sse/index.ts";
import { graphqlSseAdapter } from "../../../src/protocols/graphql-sse/runtime.ts";
import type { GraphqlSseConnection } from "../../../src/protocols/graphql-sse/spec.ts";
import type { GraphqlSseTagCounters } from "../../fixtures/servers/graphql-sse.ts";
import {
	clearFault,
	createRecordingSink,
	createTestContext,
	fastRetry,
	primaryOrigin,
	readCounters,
	setFault,
	sleep,
	uniqueTag,
	waitFor,
} from "./helpers.ts";

// Real graphql-sse 2.6.1 client (in the adapter) against the real handler in
// both modes, over Node's fetch. Covers P-I-07 and P-I-08.

const TICKS = /* GraphQL */ `
	subscription Ticks($intervalMs: Int, $count: Int, $label: String) {
		ticks(intervalMs: $intervalMs, count: $count, label: $label) { n label }
	}
`;

type TickResult = { data?: { ticks: { n: number; label: string | null } } };

async function tagCounters(tag: string): Promise<GraphqlSseTagCounters> {
	const all = await readCounters<{
		tags: Record<string, GraphqlSseTagCounters>;
	}>("graphql-sse");
	return (
		all.tags[tag] ?? {
			requests: {},
			statuses: [],
			active: 0,
			streams: 0,
			operations: 0,
			completes: 0,
			authorizations: [],
			urls: [],
		}
	);
}

const connections: AdapterConnection[] = [];
afterEach(() => {
	for (const connection of connections.splice(0)) connection.dispose();
});

function setup(
	tag: string,
	mode: "distinct" | "single",
	options: {
		connection?: Partial<GraphqlSseConnection>;
		path?: string;
		token?: (revision: number) => string;
		retry?: (retries: number) => Promise<void>;
	} = {},
) {
	const adapter = graphqlSseAdapter({ retry: options.retry ?? fastRetry() });
	const spec: GraphqlSseConnection = {
		url: `${primaryOrigin()}/graphql-sse/${tag}${options.path ?? ""}`,
		mode,
		...options.connection,
	};
	adapter.validateConnection?.(spec);
	const test = createTestContext({
		scope: tag,
		credentials: (revision) => ({
			headers: {
				authorization: `Bearer ${options.token?.(revision) ?? `valid-${tag}-${revision}`}`,
			},
		}),
		limits: { idleCloseMs: 100 },
	});
	const connection = adapter.connect(spec, test.ctx);
	connections.push(connection);
	const subscribe = (
		variables: Record<string, unknown> = {},
		repeatable = true,
	) => {
		const request = graphqlSse({ url: spec.url, mode }).subscription({
			query: TICKS,
			variables: { intervalMs: 20, ...variables },
		});
		adapter.validateSubscription?.(request.subscription);
		const recording = createRecordingSink<TickResult>();
		const subscription = connection.subscribe(
			request.subscription,
			recording.sink as never,
			{
				key: adapter.subscriptionKey?.(request.subscription) ?? "",
				repeatable,
			},
		);
		return { recording, subscription };
	};
	return { connection, test, subscribe };
}

describe("graphql-sse adapter against the real handler", () => {
	it("distinct mode: one POST stream per identity with credentials only in headers (P-I-07)", async () => {
		const tag = uniqueTag("gsa");
		const { subscribe, test } = setup(tag, "distinct");
		const a = subscribe({ label: "a" });
		const b = subscribe({ label: "b" });
		await waitFor(
			() => a.recording.events.length >= 2 && b.recording.events.length >= 2,
		);
		let counters = await tagCounters(tag);
		expect(counters.requests).toEqual({ POST: 2 });
		expect(counters.streams).toBe(2);
		expect(counters.authorizations).toEqual([
			`Bearer valid-${tag}-1`,
			`Bearer valid-${tag}-1`,
		]);
		expect(counters.urls.every((url) => !url.includes("valid-"))).toBe(true);
		expect(a.recording.events[0]?.data?.ticks.label).toBe("a");
		expect(test.hasStatus("connected")).toBe(true);

		a.subscription.unsubscribe();
		b.subscription.unsubscribe();
		await waitFor(async () => (await tagCounters(tag)).active === 0);
		counters = await tagCounters(tag);
		expect(counters.requests).toEqual({ POST: 2 });
		expect(a.recording.completions + b.recording.completions).toBe(0);
	});

	it("single mode: one reservation, a POST per operation and one DELETE per stop (P-I-07)", async () => {
		const tag = uniqueTag("gsb");
		const { subscribe } = setup(tag, "single");
		const a = subscribe({ label: "a" });
		const b = subscribe({ label: "b" });
		await waitFor(
			() => a.recording.events.length >= 2 && b.recording.events.length >= 2,
		);
		let counters = await tagCounters(tag);
		expect(counters.requests).toEqual({ PUT: 1, GET: 1, POST: 2 });
		expect(counters.streams).toBe(1);
		a.subscription.unsubscribe();
		b.subscription.unsubscribe();
		await waitFor(async () => (await tagCounters(tag)).requests.DELETE === 2);
		// Upstream lazy close (idle value 100 ms) ends the reservation stream.
		await waitFor(async () => (await tagCounters(tag)).active === 0);
		counters = await tagCounters(tag);
		expect(counters.requests).toEqual({ PUT: 1, GET: 1, POST: 2, DELETE: 2 });
	});

	it("delivers a genuine server completion once (P-I-07)", async () => {
		const tag = uniqueTag("gsc");
		const { subscribe } = setup(tag, "distinct");
		const feed = subscribe({ count: 2 });
		await waitFor(() => feed.recording.completions === 1);
		expect(feed.recording.events.map((event) => event.data?.ticks.n)).toEqual([
			1, 2,
		]);
		await sleep(100);
		expect((await tagCounters(tag)).requests).toEqual({ POST: 1 });
	});

	it("401 blocks after one request; the same revision never retries (P-I-08)", async () => {
		const tag = uniqueTag("gsd");
		const { subscribe, test, connection } = setup(tag, "distinct", {
			token: (revision) =>
				revision === 1 ? `revoked-${tag}-1` : `valid-${tag}-${revision}`,
		});
		const feed = subscribe();
		await waitFor(() => test.hasStatus("auth-blocked"));
		expect(test.lastStatus()).toMatchObject({
			state: "auth-blocked",
			reason: "credentials-rejected",
			code: "http:401",
		});
		connection.retry?.();
		await sleep(250);
		expect((await tagCounters(tag)).requests).toEqual({ POST: 1 });
		expect(test.rejections).toEqual([1]);

		test.setRevision(2);
		connection.rotate?.();
		await waitFor(() => feed.recording.events.length >= 1);
		expect((await tagCounters(tag)).requests).toEqual({ POST: 2 });
		expect(feed.recording.errors).toEqual([]);
	});

	it("5xx is retried by upstream then exhausted; explicit retry recreates (P-I-08)", async () => {
		const tag = uniqueTag("gse");
		await setFault(`graphql-sse@${tag}`, "status", 503);
		const { subscribe, test, connection } = setup(tag, "distinct", {
			connection: { retryAttempts: 2 },
		});
		const feed = subscribe();
		await waitFor(() => test.hasStatus("retry-exhausted"));
		expect(test.lastStatus()).toMatchObject({ code: "http:503" });
		expect((await tagCounters(tag)).requests).toEqual({ POST: 3 });
		await clearFault(`graphql-sse@${tag}`, "status");
		connection.retry?.();
		await waitFor(() => feed.recording.events.length >= 1);
		expect(test.lastStatus()?.state).toBe("connected");
		expect(feed.recording.errors).toEqual([]);
	});

	it("single mode reservation refused with 405 fails as unsupported-mode, no retry (P-I-08)", async () => {
		const tag = uniqueTag("gsf");
		await setFault(`graphql-sse@${tag}`, "status", {
			status: 405,
			method: "PUT",
		});
		const { subscribe, test } = setup(tag, "single");
		subscribe();
		await waitFor(() => test.hasStatus("failed"));
		expect(test.lastStatus()).toMatchObject({ code: "unsupported-mode:405" });
		await sleep(200);
		expect((await tagCounters(tag)).requests).toEqual({ PUT: 1 });
	});

	it("declared heartbeat: quiet feeds with comments stay open, a stalled stream reconnects (P-I-08)", async () => {
		const tag = uniqueTag("gsg");
		const { subscribe, test } = setup(tag, "distinct", {
			path: "/heartbeat/60",
			connection: { heartbeatMs: 60 },
		});
		const quiet = subscribe({ intervalMs: 5_000 });
		await sleep(600);
		expect((await tagCounters(tag)).requests).toEqual({ POST: 1 });
		expect(test.hasStatus("reconnecting")).toBe(false);
		quiet.subscription.unsubscribe();

		const live = subscribe({ intervalMs: 30 });
		await waitFor(() => live.recording.events.length >= 2);
		await setFault(`graphql-sse@${tag}`, "stall");
		await waitFor(() =>
			test.hasStatus("reconnecting", { reason: "heartbeat-timeout" }),
		);
		await clearFault(`graphql-sse@${tag}`, "stall");
		await waitFor(() => live.recording.continuity.length >= 1);
		const before = live.recording.events.length;
		await waitFor(() => live.recording.events.length > before);
		// Once at detection, then the reconnect outcome.
		expect(live.recording.continuity).toEqual([
			{ reason: "reconnected" },
			{ reason: "reconnected" },
		]);
		expect((await tagCounters(tag)).requests.POST).toBeGreaterThanOrEqual(3);
	});
});

// Count real event streams and reservations to detect connections left open after operation POST retries.
describe("graphql-sse single mode after transient POST failures", () => {
	/** The handler's open stream count once it settles (or after 3 s). */
	async function settledActive(tag: string, expected: number) {
		try {
			await waitFor(async () => (await tagCounters(tag)).active === expected, {
				timeout: 3_000,
			});
		} catch {}
		return (await tagCounters(tag)).active;
	}

	/** Upstream backoff that lifts the fault before the given retry's attempt. */
	function clearingRetry(target: string, at = 2) {
		let retries = 0;
		return async () => {
			retries += 1;
			if (retries === at) await clearFault(target, "status");
			await sleep(10);
		};
	}

	it("two refused POSTs leave one stream while live and none after the last unsubscribe", async () => {
		const tag = uniqueTag("gsp");
		const target = `graphql-sse@${tag}`;
		await setFault(target, "status", { status: 503, method: "POST" });
		const { subscribe } = setup(tag, "single", {
			retry: clearingRetry(target),
		});
		const feed = subscribe();
		await waitFor(() => feed.recording.events.length >= 2);
		const counters = await tagCounters(tag);
		expect(counters.statuses.filter((code) => code === 503)).toHaveLength(2);
		expect(counters.requests).toMatchObject({ PUT: 3, GET: 3, POST: 3 });
		expect(await settledActive(tag, 1)).toBe(1);

		feed.subscription.unsubscribe();
		expect(await settledActive(tag, 0)).toBe(0);
		expect(feed.recording.errors).toEqual([]);
	});

	it("an unrelated live non-repeatable operation keeps its stream; every stream closes after the last unsubscribe", async () => {
		const tag = uniqueTag("gsq");
		const target = `graphql-sse@${tag}`;
		const { subscribe, test } = setup(tag, "single", {
			retry: clearingRetry(target),
		});
		const live = subscribe({ label: "live" }, false);
		await waitFor(() => live.recording.events.length >= 2);
		await setFault(target, "status", { status: 503, method: "POST" });
		const later = subscribe({ label: "later" });
		await waitFor(() => later.recording.events.length >= 2);
		const seen = live.recording.events.length;
		await waitFor(() => live.recording.events.length > seen + 2);
		expect(live.recording.errors).toEqual([]);
		expect((await tagCounters(tag)).requests).toMatchObject({
			PUT: 3,
			GET: 3,
			POST: 4,
		});
		// The live operation's reservation and the recovered one; not the refused one.
		expect(await settledActive(tag, 2)).toBe(2);
		// A connection-wide loss is reported conservatively, never `continuous`.
		expect(live.recording.continuity.length).toBeGreaterThan(0);
		expect(test.lastStatus()?.state).toBe("connected");

		live.subscription.unsubscribe();
		expect(await settledActive(tag, 1)).toBe(1);
		later.subscription.unsubscribe();
		expect(await settledActive(tag, 0)).toBe(0);
	});

	for (const end of ["dispose", "rotate"] as const) {
		it(`${end}() closes every stream, including one a live operation still holds`, async () => {
			const tag = uniqueTag(end === "dispose" ? "gsr" : "gss");
			const target = `graphql-sse@${tag}`;
			const { subscribe, test, connection } = setup(tag, "single", {
				retry: clearingRetry(target),
			});
			const live = subscribe({ label: "live" });
			await waitFor(() => live.recording.events.length >= 1);
			await setFault(target, "status", { status: 503, method: "POST" });
			const later = subscribe({ label: "later" });
			await waitFor(() => later.recording.events.length >= 1);
			expect(await settledActive(tag, 2)).toBe(2);
			if (end === "dispose") {
				connection.dispose();
				expect(await settledActive(tag, 0)).toBe(0);
				return;
			}
			test.setRevision(2);
			connection.rotate?.();
			const [liveSeen, laterSeen] = [
				live.recording.events.length,
				later.recording.events.length,
			];
			await waitFor(
				() =>
					live.recording.events.length > liveSeen &&
					later.recording.events.length > laterSeen,
			);
			expect((await tagCounters(tag)).requests.PUT).toBe(4);
			expect(await settledActive(tag, 1)).toBe(1);
			live.subscription.unsubscribe();
			later.subscription.unsubscribe();
			expect(await settledActive(tag, 0)).toBe(0);
		});
	}

	// Server completion sends no DELETE; the adapter must release a replaced reservation when its last operation completes.
	it("an operation the server completes on a replaced stream releases it while another operation lives", async () => {
		const tag = uniqueTag("gsu");
		const target = `graphql-sse@${tag}`;
		const { subscribe } = setup(tag, "single", {
			retry: clearingRetry(target, 1),
		});
		const finite = subscribe({ label: "finite", count: 12, intervalMs: 50 });
		await waitFor(() => finite.recording.events.length >= 1);
		await setFault(target, "status", { status: 503, method: "POST" });
		const later = subscribe({ label: "later" });
		await waitFor(() => later.recording.events.length >= 1);
		expect(finite.recording.completions).toBe(0);
		expect(await settledActive(tag, 2)).toBe(2);

		await waitFor(() => finite.recording.completions === 1, { timeout: 3_000 });
		expect(await settledActive(tag, 1)).toBe(1);
		later.subscription.unsubscribe();
		expect(await settledActive(tag, 0)).toBe(0);
		expect(finite.recording.errors).toEqual([]);
		expect(later.recording.errors).toEqual([]);
	});

	const controls = [
		["PUT-503", { status: 503, method: "PUT" }],
		["PUT-401", { status: 401, method: "PUT" }],
		["POST-401", { status: 401, method: "POST" }],
	] as const;
	for (const [label, fault] of controls) {
		it(`control ${label}: recovers and closes every stream`, async () => {
			const tag = uniqueTag("gst");
			const target = `graphql-sse@${tag}`;
			await setFault(target, "status", fault);
			const { subscribe, test, connection } = setup(tag, "single", {
				retry: clearingRetry(target),
			});
			const feed = subscribe();
			if (fault.status === 401) {
				await waitFor(() => test.hasStatus("auth-blocked"));
				expect(await settledActive(tag, 0)).toBe(0);
				await clearFault(target, "status");
				test.setRevision(2);
				connection.rotate?.();
			}
			await waitFor(() => feed.recording.events.length >= 1);
			expect(await settledActive(tag, 1)).toBe(1);
			feed.subscription.unsubscribe();
			expect(await settledActive(tag, 0)).toBe(0);
		});
	}
});
