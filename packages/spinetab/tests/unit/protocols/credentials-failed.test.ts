import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdapterConnection } from "../../../src/core/adapter.ts";
import { SpinetabError } from "../../../src/core/errors.ts";
import type { SpinetabErrorCode } from "../../../src/core/types.ts";
import { trpcWsAdapter } from "../../../src/integrations/trpc/runtime.ts";
import { graphqlSseAdapter } from "../../../src/protocols/graphql-sse/runtime.ts";
import { graphqlWsAdapter } from "../../../src/protocols/graphql-ws/runtime.ts";
import { credentialFailureReason } from "../../../src/protocols/shared/runtime.ts";
import {
	createRecordingSink,
	createTestContext,
	sleep,
	type TestContext,
	waitFor,
} from "../../integration/protocols/helpers.ts";
import { FakeWebSocket } from "./fakes.ts";

//: a credentials provider that throws or returns a
// non-object is transient, exactly like a credentials timeout. It blocks with
// `credentials-missing`, never marks the revision rejected and never becomes
// an anonymous attempt (NT:579-580).

const TRANSIENT: SpinetabErrorCode[] = [
	"credentials-failed",
	"credentials-timeout",
];

const failingProvider = (code: SpinetabErrorCode) => () => {
	throw new SpinetabError(code, "The credentials provider failed.");
};

const connections: AdapterConnection[] = [];
beforeEach(() => FakeWebSocket.reset());
afterEach(() => {
	for (const connection of connections.splice(0)) connection.dispose();
});

describe("credentials-failed maps exactly like credentials-timeout", () => {
	it("credentialFailureReason", () => {
		for (const code of TRANSIENT) {
			expect(credentialFailureReason({ code }), code).toBe(
				"credentials-missing",
			);
		}
		expect(credentialFailureReason({ code: "credentials-rejected" })).toBe(
			"credentials-rejected",
		);
		expect(credentialFailureReason({ code: "no-credential-source" })).toBe(
			"no-credential-source",
		);
	});

	const adapters: Record<
		string,
		(test: TestContext) => {
			connection: AdapterConnection;
			subscribe(): void;
			attempts(): number;
		}
	> = {
		"graphql-ws": (test) => {
			const connection = graphqlWsAdapter({
				webSocketImpl: FakeWebSocket,
				retryWait: async () => {},
			}).connect({ url: "wss://api.test/graphql" }, test.ctx);
			return {
				connection,
				subscribe: () =>
					connection.subscribe(
						{ query: "subscription { ticks { n } }" },
						createRecordingSink<unknown>().sink,
						{ key: "k", repeatable: true },
					),
				attempts: () => FakeWebSocket.instances.length,
			};
		},
		"graphql-sse": (test) => {
			let calls = 0;
			const connection = graphqlSseAdapter({
				fetchFn: (async () => {
					calls += 1;
					return new Response(null, { status: 500 });
				}) as typeof fetch,
				retry: async () => {},
			}).connect({ url: "https://api.test/graphql/stream" }, test.ctx);
			return {
				connection,
				subscribe: () =>
					connection.subscribe(
						{ query: "subscription { ticks { n } }" },
						createRecordingSink<unknown>().sink,
						{ key: "k", repeatable: true },
					),
				attempts: () => calls,
			};
		},
		"trpc-ws": (test) => {
			const connection = trpcWsAdapter({
				WebSocket: FakeWebSocket as unknown as typeof WebSocket,
				retryDelayMs: () => 10,
			}).connect({ url: "wss://api.test/trpc" }, test.ctx);
			return {
				connection: connection as AdapterConnection,
				subscribe: () =>
					connection.subscribe(
						{ path: "ticks", input: { tag: "a" } },
						createRecordingSink<never>().sink,
						{ key: "k", repeatable: true },
					),
				attempts: () => FakeWebSocket.instances.length,
			};
		},
	};

	for (const [kind, open] of Object.entries(adapters)) {
		it(`${kind}: a failed provider blocks like a timeout and never connects anonymously`, async () => {
			const outcomes = [];
			for (const code of TRANSIENT) {
				const test = createTestContext({
					scope: "s",
					credentials: failingProvider(code),
				});
				const adapter = open(test);
				connections.push(adapter.connection);
				adapter.subscribe();
				await waitFor(() => test.hasStatus("auth-blocked"), {
					timeout: 2_000,
				});
				await sleep(20);
				outcomes.push({
					status: {
						state: test.lastStatus()?.state,
						reason: test.lastStatus()?.reason,
					},
					attempts: adapter.attempts(),
					rejections: test.rejections.length,
				});
			}
			expect(outcomes[0]).toEqual({
				status: { state: "auth-blocked", reason: "credentials-missing" },
				attempts: 0,
				rejections: 0,
			});
			expect(outcomes[1]).toEqual(outcomes[0]);
		});
	}
});
