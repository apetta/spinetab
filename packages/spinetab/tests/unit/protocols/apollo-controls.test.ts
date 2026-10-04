import { ApolloClient, gql, InMemoryCache } from "@apollo/client";
import { ApolloLink } from "@apollo/client/link";
import { Observable, of } from "rxjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
	Continuity,
	SubscriptionStatus,
} from "../../../src/core/types.ts";
import {
	type SpinetabControls,
	SpinetabLink,
	spinetabSplit,
} from "../../../src/integrations/apollo/index.ts";
import { graphqlWs } from "../../../src/protocols/graphql-ws/index.ts";
import { createFakeClient } from "./fakes.ts";

const SUB = gql`
	subscription OnTick {
		ticks { n }
	}
`;
const QUERY = gql`
	query Hello {
		hello
	}
`;

const continuity = (
	state: Continuity["state"],
	since: number,
	reason?: Continuity["reason"],
): Continuity => ({ state, since, ...(reason ? { reason } : {}) });

function setup() {
	const { client, calls } = createFakeClient();
	const seen: {
		status: Array<{ state: string; operation: string; controls: unknown }>;
		continuity: Array<{
			state: string;
			reason?: string;
			operation: string;
			controls: SpinetabControls;
		}>;
	} = { status: [], continuity: [] };
	const link = new SpinetabLink(client, graphqlWs("/graphql"), {
		onStatus: (status, operation, controls) => {
			seen.status.push({
				state: status.connection.state,
				operation: operation.operationName ?? "",
				controls,
			});
		},
		onContinuity: (value, operation, controls) => {
			seen.continuity.push({
				state: value.state,
				...(value.reason ? { reason: value.reason } : {}),
				operation: operation.operationName ?? "",
				controls,
			});
		},
	});
	const apollo = new ApolloClient({ cache: new InMemoryCache(), link });
	const errors: unknown[] = [];
	// Apollo 4 delivers a link error as a result carrying `error`.
	const start = () =>
		apollo.subscribe({ query: SUB }).subscribe({
			next: (result) => {
				if (result.error) errors.push(result.error);
			},
			error: (error) => errors.push(error),
		});
	return { calls, seen, start, errors };
}

describe("Apollo: controls and onContinuity", () => {
	it("onStatus gets the operation and controls that act on this subscription's handle", () => {
		const { calls, seen, start } = setup();
		start();
		const call = calls[0];
		call?.status("reconnecting");
		expect(seen.status).toHaveLength(1);
		expect(seen.status[0]?.operation).toBe("OnTick");
		const controls = seen.status[0]?.controls as SpinetabControls;
		controls.retry();
		controls.markReconciled({ pending: true });
		controls.markReconciled();
		expect(call?.retries).toBe(1);
		expect(call?.reconciled).toEqual([{ pending: true }, undefined]);
	});

	it("onContinuity fires once per notice away from continuous, with the same controls", () => {
		const { calls, seen, start } = setup();
		start();
		const call = calls[0];
		call?.status("connected");
		call?.status("reconnecting", {
			continuity: continuity("unknown", 10, "reconnected"),
		});
		// A connection-only change repeats the notice: not reported again.
		call?.status("connecting", {
			continuity: continuity("unknown", 10, "reconnected"),
		});
		// The reconnect outcome is a fresh notice.
		call?.status("connected", {
			continuity: continuity("unknown", 20, "reconnected"),
		});
		call?.status("connected", { continuity: continuity("continuous", 30) });
		expect(seen.continuity.map(({ state, reason }) => [state, reason])).toEqual(
			[
				["unknown", "reconnected"],
				["unknown", "reconnected"],
			],
		);
		expect(seen.continuity[0]?.operation).toBe("OnTick");
		seen.continuity[1]?.controls.markReconciled();
		expect(call?.reconciled).toEqual([undefined]);
		expect(seen.continuity[0]?.controls).toBe(seen.status[0]?.controls);
	});

	it("a gap still ends the observable with continuity-lost, after onContinuity", () => {
		const { calls, seen, start, errors } = setup();
		start();
		calls[0]?.status("connected", {
			continuity: continuity("gap", 5, "overflow"),
		});
		expect(seen.continuity.map((item) => item.reason)).toEqual(["overflow"]);
		expect(errors).toHaveLength(1);
		expect((errors[0] as { code?: string }).code).toBe("continuity-lost");
	});

	it("controls are inert once the observable ended", () => {
		const { calls, seen, start } = setup();
		const subscription = start();
		const call = calls[0];
		call?.status("reconnecting");
		const controls = seen.status[0]?.controls as SpinetabControls;
		subscription.unsubscribe();
		controls.retry();
		controls.markReconciled();
		expect(call?.retries).toBe(0);
		expect(call?.reconciled).toEqual([]);

		// Ended by a terminal status: inert as well.
		const second = setup();
		second.start();
		const handle = second.calls[0];
		handle?.status("failed");
		const ended = second.seen.status[0]?.controls as SpinetabControls;
		ended.retry();
		ended.markReconciled();
		expect(handle?.retries).toBe(0);
		expect(handle?.reconciled).toEqual([]);
	});

	it("onStatus without the new parameters keeps working (two-argument callbacks)", () => {
		const { client, calls } = createFakeClient();
		const states: string[] = [];
		const apollo = new ApolloClient({
			cache: new InMemoryCache(),
			link: new SpinetabLink(client, graphqlWs("/graphql"), {
				onStatus: (status: SubscriptionStatus) =>
					states.push(status.connection.state),
			}),
		});
		apollo.subscribe({ query: SUB }).subscribe({});
		calls[0]?.status("connecting");
		expect(states).toEqual(["connecting"]);
	});
});

describe("Apollo: spinetabSplit", () => {
	it("routes subscriptions to Spinetab and everything else to the given HTTP link", async () => {
		const { client, calls } = createFakeClient();
		const httpOperations: string[] = [];
		const http = new ApolloLink((operation) => {
			httpOperations.push(operation.operationName ?? "");
			return of({ data: { hello: "from http" } });
		});
		const seen: string[] = [];
		const apollo = new ApolloClient({
			cache: new InMemoryCache(),
			link: spinetabSplit(client, graphqlWs("/graphql"), http, {
				onStatus: (status) => seen.push(status.connection.state),
			}),
		});
		const result = await apollo.query({ query: QUERY });
		expect(result.data).toEqual({ hello: "from http" });
		expect(httpOperations).toEqual(["Hello"]);
		expect(calls).toHaveLength(0);
		apollo.subscribe({ query: SUB }).subscribe({});
		expect(calls).toHaveLength(1);
		expect(calls[0]?.request.adapter).toBe("graphql-ws");
		calls[0]?.status("connecting");
		expect(seen).toEqual(["connecting"]);
		expect(httpOperations).toEqual(["Hello"]);
	});
});

describe("Apollo reconcile recipe (real ApolloClient 4.3.1)", () => {
	// SpinetabLink ignores the promise `onContinuity` returns, so the
	// recipe owns its failure path, and it must never declare a refetch that
	// failed or never ran. The HTTP link answers the first request with data
	// and every later one as the case says.
	type Answer = "ok" | "network-error" | "graphql-errors";
	type Recipe = (
		apollo: ApolloClient,
		controls: SpinetabControls,
	) => Promise<void>;

	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => {
		unhandled.push(reason);
	};
	beforeEach(() => {
		unhandled.length = 0;
		process.on("unhandledRejection", onUnhandled);
	});
	afterEach(() => {
		process.off("unhandledRejection", onUnhandled);
	});

	/**
	 * An application-owned query that rejects on any error and never
	 * joins a request begun before the notice. one options object
	 * serves every operation, so the run token is kept per operation (its
	 * `controls`), and it guards the write as well as the declaration: a
	 * `network-only` query writes its answer itself, so an overtaken run's
	 * late answer would replace the newest run's data after it declared.
	 * Hence `no-cache` and an explicit `writeQuery` by the newest run only.
	 */
	const ownQuery = (): Recipe => {
		const runs = new WeakMap<SpinetabControls, number>();
		return async (apollo, controls) => {
			const run = (runs.get(controls) ?? 0) + 1;
			runs.set(controls, run);
			try {
				const { data } = await apollo.query({
					query: QUERY,
					fetchPolicy: "no-cache",
					errorPolicy: "none",
					context: { queryDeduplication: false },
				});
				// A newer notice's run supersedes this one.
				if (runs.get(controls) === run) {
					apollo.writeQuery({ query: QUERY, data });
					controls.markReconciled();
				}
			} catch {
				// The loss stays visible; the next notice runs this again.
			}
		};
	};

	/** `refetchQueries` confirms only when every result is checked and one ran. */
	const checkedRefetch: Recipe = async (apollo, controls) => {
		try {
			const results = await apollo.refetchQueries({ include: "active" });
			if (results.length === 0 || results.some((result) => result.error)) {
				throw new Error("The refetch failed or refetched nothing.");
			}
			controls.markReconciled();
		} catch {
			// The loss stays visible; the next notice runs this again.
		}
	};

	/** Superseded documentation (apollo.md:52-56): an anti-pattern. */
	const superseded: Recipe = async (apollo, controls) => {
		await apollo.refetchQueries({ include: "active" });
		controls.markReconciled();
	};

	/**
	 * One `unknown/reconnected` notice through spinetabSplit with `recipe` as
	 * `onContinuity`. `watch` keeps an active ObservableQuery on QUERY (with
	 * `errorPolicy`); otherwise QUERY is only cached. The recipe's promise is
	 * discarded, as the link does. Returns the HTTP requests after the notice
	 * and the handle's markReconciled calls.
	 */
	async function notice(
		recipe: Recipe,
		options: {
			refetch: Answer;
			watch: boolean;
			errorPolicy?: "all" | "ignore";
			clientErrorPolicy?: "all";
		},
	) {
		const { client, calls } = createFakeClient();
		let requests = 0;
		const http = new ApolloLink((): Observable<ApolloLink.Result> => {
			requests += 1;
			const answer = requests === 1 ? "ok" : options.refetch;
			if (answer === "ok") return of({ data: { hello: `v${requests}` } });
			if (answer === "graphql-errors") {
				return of({ data: null, errors: [{ message: "resolver failed" }] });
			}
			return new Observable((observer) => {
				observer.error(new Error("network down"));
			});
		});
		// Apollo 4 types a client-wide errorPolicy default only once the
		// application declares it (ApolloClient.DeclareDefaultOptions); it is
		// set at runtime here, without that global augmentation.
		const defaultOptions = (options.clientErrorPolicy
			? {
					query: { errorPolicy: options.clientErrorPolicy },
					watchQuery: { errorPolicy: options.clientErrorPolicy },
				}
			: undefined) as unknown as ApolloClient.Options["defaultOptions"];
		const apollo: ApolloClient = new ApolloClient({
			cache: new InMemoryCache(),
			link: spinetabSplit(client, graphqlWs("/graphql"), http, {
				onContinuity: (_continuity, _operation, controls) => {
					void recipe(apollo, controls);
				},
			}),
			...(defaultOptions ? { defaultOptions } : {}),
		});
		const subscriptions: Array<{ unsubscribe(): void }> = [];
		if (options.watch) {
			subscriptions.push(
				apollo
					.watchQuery({
						query: QUERY,
						...(options.errorPolicy
							? { errorPolicy: options.errorPolicy }
							: {}),
					})
					.subscribe({ next() {}, error() {} }),
			);
		} else {
			await apollo.query({ query: QUERY });
		}
		await settle();
		const before = requests;
		subscriptions.push(
			apollo.subscribe({ query: SUB }).subscribe({ next() {}, error() {} }),
		);
		const call = calls[0];
		call?.status("connected", {
			continuity: continuity("unknown", 10, "reconnected"),
		});
		await settle();
		for (const subscription of subscriptions) subscription.unsubscribe();
		apollo.stop();
		return { refetches: requests - before, reconciled: call?.reconciled };
	}

	async function settle(): Promise<void> {
		for (let turn = 0; turn < 5; turn += 1) {
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
		}
	}

	it.each([
		true,
		false,
	])("P-U-31a own query (no-cache, guarded write): a successful refetch reconciles (active ObservableQuery: %s)", async (watch) => {
		const run = await notice(ownQuery(), { refetch: "ok", watch });
		expect(run.refetches).toBe(1);
		expect(run.reconciled).toEqual([undefined]);
		expect(unhandled).toEqual([]);
	});

	it.each([
		"network-error",
		"graphql-errors",
	] as const)("P-U-31b own query (no-cache, guarded write): a refetch with %s keeps continuity unknown and leaves no unhandled rejection", async (refetch) => {
		const run = await notice(ownQuery(), { refetch, watch: true });
		expect(run.refetches).toBe(1);
		expect(run.reconciled).toEqual([]);
		expect(unhandled).toEqual([]);
	});

	it.each([
		"network-error",
		"graphql-errors",
	] as const)("P-U-31c own query (no-cache, guarded write): errorPolicy 'none' is pinned, so a %s still fails when the client defaults to 'all'", async (refetch) => {
		const run = await notice(ownQuery(), {
			refetch,
			watch: true,
			clientErrorPolicy: "all",
		});
		expect(run.refetches).toBe(1);
		expect(run.reconciled).toEqual([]);
		expect(unhandled).toEqual([]);
	});

	it.each([
		"network-error",
		"graphql-errors",
	] as const)("P-U-31d checked refetchQueries: a %s under errorPolicy 'all' keeps continuity unknown", async (refetch) => {
		const run = await notice(checkedRefetch, {
			refetch,
			watch: true,
			errorPolicy: "all",
		});
		expect(run.refetches).toBe(1);
		expect(run.reconciled).toEqual([]);
		expect(unhandled).toEqual([]);
	});

	it("P-U-31e checked refetchQueries: with no active ObservableQuery nothing is refetched and continuity stays unknown", async () => {
		const run = await notice(checkedRefetch, { refetch: "ok", watch: false });
		expect(run.refetches).toBe(0);
		expect(run.reconciled).toEqual([]);
		expect(unhandled).toEqual([]);
	});

	it("P-U-31h own query (no-cache, guarded write): an identical query already in flight at the notice is not joined; the recipe waits for its own request", async () => {
		const { client, calls } = createFakeClient();
		const answers: Array<() => void> = [];
		let requests = 0;
		const http = new ApolloLink(
			() =>
				new Observable<ApolloLink.Result>((observer) => {
					requests += 1;
					const answer = `v${requests}`;
					answers.push(() => {
						observer.next({ data: { hello: answer } });
						observer.complete();
					});
				}),
		);
		const recipe = ownQuery();
		const apollo: ApolloClient = new ApolloClient({
			cache: new InMemoryCache(),
			link: spinetabSplit(client, graphqlWs("/graphql"), http, {
				onContinuity: (_continuity, _operation, controls) => {
					void recipe(apollo, controls);
				},
			}),
		});
		// Begun before the notice, for example a component's own fetch.
		const early = apollo.query({ query: QUERY, fetchPolicy: "network-only" });
		await settle();
		const subscription = apollo
			.subscribe({ query: SUB })
			.subscribe({ next() {}, error() {} });
		calls[0]?.status("connected", {
			continuity: continuity("unknown", 10, "reconnected"),
		});
		await settle();
		expect(requests).toBe(2);
		// The pre-notice answer alone declares nothing.
		answers.shift()?.();
		await early;
		await settle();
		expect(calls[0]?.reconciled).toEqual([]);
		answers.shift()?.();
		await settle();
		expect(calls[0]?.reconciled).toEqual([undefined]);
		expect(apollo.readQuery({ query: QUERY })).toEqual({ hello: "v2" });
		expect(unhandled).toEqual([]);
		subscription.unsubscribe();
		apollo.stop();
	});

	/**
	 * The documented two-notice flow through spinetabSplit with `recipe` as
	 * `onContinuity`: `unknown` at detection (while reconnecting), then again
	 * as the outcome just before `connected`. QUERY is cached from a first
	 * request (v1); the HTTP link then holds each request until the test
	 * answers or fails it: `held[0]` is the first run's (v2), `held[1]` the
	 * second run's (v3).
	 */
	async function twoNotices(recipe: Recipe) {
		const { client, calls } = createFakeClient();
		const held: Array<{ answer(): void; fail(): void }> = [];
		let requests = 0;
		const http = new ApolloLink(
			() =>
				new Observable<ApolloLink.Result>((observer) => {
					requests += 1;
					const hello = `v${requests}`;
					held.push({
						answer: () => {
							observer.next({ data: { hello } });
							observer.complete();
						},
						fail: () => observer.error(new Error("network down")),
					});
				}),
		);
		const apollo: ApolloClient = new ApolloClient({
			cache: new InMemoryCache(),
			link: spinetabSplit(client, graphqlWs("/graphql"), http, {
				onContinuity: (_continuity, _operation, controls) => {
					void recipe(apollo, controls);
				},
			}),
		});
		const first = apollo.query({ query: QUERY });
		held.shift()?.answer();
		await first;
		const subscription = apollo
			.subscribe({ query: SUB })
			.subscribe({ next() {}, error() {} });
		const call = calls[0];
		call?.status("reconnecting", {
			continuity: continuity("unknown", 10, "reconnected"),
		});
		await settle();
		call?.status("connected", {
			continuity: continuity("unknown", 11, "reconnected"),
		});
		await settle();
		return {
			held,
			requests: () => requests,
			reconciled: () => call?.reconciled,
			cached: () => apollo.readQuery({ query: QUERY }),
			stop() {
				subscription.unsubscribe();
				apollo.stop();
			},
		};
	}

	it("P-U-31i own query (no-cache, guarded write), two notices for one interruption (detection, then the outcome): the first run's answer lands after the second run's request failed; nothing is reconciled", async () => {
		const run = await twoNotices(ownQuery());
		try {
			// Each run made its own request; none has been answered.
			expect(run.requests()).toBe(3);
			expect(run.reconciled()).toEqual([]);
			run.held[1]?.fail();
			await settle();
			run.held[0]?.answer();
			await settle();
			// The first run was overtaken by the second notice: it declares
			// nothing, although its request succeeded.
			expect(run.reconciled()).toEqual([]);
			expect(unhandled).toEqual([]);
		} finally {
			run.stop();
		}
	});

	it("P-U-31i own query (no-cache, guarded write), two notices: the second run answers first, writes and reconciles; the first run's late answer is neither written nor declared", async () => {
		const run = await twoNotices(ownQuery());
		try {
			expect(run.requests()).toBe(3);
			run.held[1]?.answer();
			await settle();
			expect(run.reconciled()).toEqual([undefined]);
			expect(run.cached()).toEqual({ hello: "v3" });
			run.held[0]?.answer();
			await settle();
			expect(run.reconciled()).toEqual([undefined]);
			expect(run.cached()).toEqual({ hello: "v3" });
			expect(unhandled).toEqual([]);
		} finally {
			run.stop();
		}
	});

	it("P-U-31i own query (no-cache, guarded write): one options object serves every operation, so the run token is kept per operation; a reconnect's notices on two operations both reconcile", async () => {
		const { client, calls } = createFakeClient();
		const answers: Array<() => void> = [];
		const http = new ApolloLink(
			() =>
				new Observable<ApolloLink.Result>((observer) => {
					const hello = `v${answers.length + 1}`;
					answers.push(() => {
						observer.next({ data: { hello } });
						observer.complete();
					});
				}),
		);
		const recipe = ownQuery();
		const apollo: ApolloClient = new ApolloClient({
			cache: new InMemoryCache(),
			link: spinetabSplit(client, graphqlWs("/graphql"), http, {
				onContinuity: (_continuity, _operation, controls) => {
					void recipe(apollo, controls);
				},
			}),
		});
		const TOCKS = gql`
			subscription OnTock {
				tocks { n }
			}
		`;
		const subscriptions = [SUB, TOCKS].map((query) =>
			apollo.subscribe({ query }).subscribe({ next() {}, error() {} }),
		);
		expect(calls).toHaveLength(2);
		// One reconnect: each operation receives its own notice.
		calls[0]?.status("connected", {
			continuity: continuity("unknown", 10, "reconnected"),
		});
		calls[1]?.status("connected", {
			continuity: continuity("unknown", 10, "reconnected"),
		});
		await settle();
		expect(answers).toHaveLength(2);
		answers[0]?.();
		answers[1]?.();
		await settle();
		expect(calls[0]?.reconciled).toEqual([undefined]);
		expect(calls[1]?.reconciled).toEqual([undefined]);
		expect(unhandled).toEqual([]);
		for (const subscription of subscriptions) subscription.unsubscribe();
		apollo.stop();
	});

	it("P-U-31j residual (pinned): a component's network-only request begun before the notice that answers after the recipe's write replaces it, while continuity already reads reconciled", async () => {
		const { client, calls } = createFakeClient();
		const answers: Array<() => void> = [];
		let requests = 0;
		const http = new ApolloLink(
			() =>
				new Observable<ApolloLink.Result>((observer) => {
					requests += 1;
					const hello = `v${requests}`;
					answers.push(() => {
						observer.next({ data: { hello } });
						observer.complete();
					});
				}),
		);
		const recipe = ownQuery();
		const apollo: ApolloClient = new ApolloClient({
			cache: new InMemoryCache(),
			link: spinetabSplit(client, graphqlWs("/graphql"), http, {
				onContinuity: (_continuity, _operation, controls) => {
					void recipe(apollo, controls);
				},
			}),
		});
		const early = apollo.query({ query: QUERY, fetchPolicy: "network-only" });
		await settle();
		const subscription = apollo
			.subscribe({ query: SUB })
			.subscribe({ next() {}, error() {} });
		calls[0]?.status("connected", {
			continuity: continuity("unknown", 10, "reconnected"),
		});
		await settle();
		expect(requests).toBe(2);
		answers[1]?.();
		await settle();
		expect(calls[0]?.reconciled).toEqual([undefined]);
		expect(apollo.readQuery({ query: QUERY })).toEqual({ hello: "v2" });
		// Apollo writes the pre-notice answer when it lands; the recipe cannot
		// cancel a request it did not start.
		answers[0]?.();
		await early;
		await settle();
		expect(apollo.readQuery({ query: QUERY })).toEqual({ hello: "v1" });
		expect(calls[0]?.reconciled).toEqual([undefined]);
		expect(unhandled).toEqual([]);
		subscription.unsubscribe();
		apollo.stop();
	});

	it("P-U-31f anti-pattern: under errorPolicy 'ignore' a failed refetch carries no error, so even a checked refetchQueries declares it reconciled", async () => {
		const run = await notice(checkedRefetch, {
			refetch: "network-error",
			watch: true,
			errorPolicy: "ignore",
		});
		expect(run.refetches).toBe(1);
		expect(run.reconciled).toEqual([undefined]);
	});

	it.each([
		{
			row: "AP1: errorPolicy 'all', network error",
			refetch: "network-error",
			watch: true,
			errorPolicy: "all",
			refetches: 1,
		},
		{
			row: "AP5: no active ObservableQuery",
			refetch: "ok",
			watch: false,
			refetches: 0,
		},
	] as const)("P-U-31g anti-pattern, the superseded apollo.md recipe ($row): declared reconciled", async (row) => {
		const run = await notice(superseded, row);
		expect(run.refetches).toBe(row.refetches);
		expect(run.reconciled).toEqual([undefined]);
	});
});
