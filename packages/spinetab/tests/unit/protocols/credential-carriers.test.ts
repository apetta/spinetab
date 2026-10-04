import { describe, expect, it } from "vitest";
import { isSpinetabError } from "../../../src/core/errors.ts";
import type { Json } from "../../../src/core/types.ts";
import {
	spinetabSseLink,
	spinetabWsLink,
} from "../../../src/integrations/trpc/index.ts";
import { trpcWsAdapter } from "../../../src/integrations/trpc/runtime.ts";
import { graphqlSse } from "../../../src/protocols/graphql-sse/index.ts";
import { graphqlSseAdapter } from "../../../src/protocols/graphql-sse/runtime.ts";
import { graphqlWs } from "../../../src/protocols/graphql-ws/index.ts";
import { graphqlWsAdapter } from "../../../src/protocols/graphql-ws/runtime.ts";
import { socketIo } from "../../../src/protocols/socket-io/index.ts";
import { socketIoAdapter } from "../../../src/protocols/socket-io/runtime.ts";
import { createFakeClient } from "./fakes.ts";

// Identity-bearing options must reject credential carriers without echoing their values.

function refusal(run: () => unknown): { path?: unknown; message: string } {
	try {
		run();
	} catch (error) {
		if (isSpinetabError(error) && error.code === "unsupported-option") {
			return {
				path: (error.detail as { path?: unknown } | undefined)?.path,
				message: error.message,
			};
		}
		throw error;
	}
	throw new Error("expected unsupported-option");
}

const SECRET = "s3cr3t-value";

describe("page builders refuse credential carriers", () => {
	it("graphqlWs: token-named connectionParams keys, at any depth", () => {
		const cases: Array<Record<string, Json>> = [
			{ token: SECRET },
			{ Authorization: SECRET },
			{ nested: { access_token: SECRET } },
		];
		for (const params of cases) {
			const outcome = refusal(() =>
				graphqlWs("/graphql", { connectionParams: params }),
			);
			expect(String(outcome.path)).toMatch(/^graphqlWs\.connectionParams\./);
			expect(outcome.message).toContain("credentials provider");
			expect(outcome.message).not.toContain(SECRET);
		}
		expect(() =>
			graphqlWs("/graphql", { connectionParams: { client: "web" } }),
		).not.toThrow();
	});

	it("graphqlSse: credential headers", () => {
		for (const name of [
			"authorization",
			"X-API-Key",
			"cookie",
			"Last-Event-ID",
		]) {
			const outcome = refusal(() =>
				graphqlSse("/stream", { headers: { [name]: SECRET } }),
			);
			expect(outcome.path).toBe(`graphqlSse.headers.${name}`);
			expect(outcome.message).not.toContain(SECRET);
			// The refusal names the credentials provider (core's message).
			expect(outcome.message).toContain("credentials provider");
		}
		expect(() =>
			graphqlSse("/stream", { headers: { "x-client": "web" } }),
		).not.toThrow();
	});

	it("socketIo: token-named auth and query keys", () => {
		const auth = refusal(() =>
			socketIo("/chat", { sharing: "shared", auth: { jwt: SECRET } }),
		);
		expect(auth.path).toBe("socketIo.auth.jwt");
		const query = refusal(() =>
			socketIo("/chat", { sharing: "shared", query: { api_key: SECRET } }),
		);
		expect(query.path).toBe("socketIo.query.api_key");
		expect(() =>
			socketIo("/chat", {
				sharing: "shared",
				auth: { room: "a" },
				query: { tenant: "a" },
			}),
		).not.toThrow();
	});

	it("token-named query parameters in the endpoint URL", () => {
		expect(refusal(() => graphqlWs("/graphql?token=x")).path).toBe(
			"graphqlWs.url",
		);
		expect(refusal(() => graphqlSse("/stream?access_token=x")).path).toBe(
			"graphqlSse.url",
		);
		expect(
			refusal(() => socketIo("/chat?password=x", { sharing: "shared" })).path,
		).toBe("socketIo.url");
		expect(() => graphqlWs("/graphql?tag=a")).not.toThrow();
	});

	it("tRPC links: token-named connectionParams keys", () => {
		const { client } = createFakeClient();
		expect(
			refusal(() =>
				spinetabWsLink({
					client,
					url: "/trpc-ws",
					connectionParams: { token: SECRET },
				}),
			).path,
		).toBe("spinetabWsLink.connectionParams.token");
		expect(
			refusal(() =>
				spinetabSseLink({
					client,
					url: "/trpc",
					connectionParams: { secret: SECRET },
				}),
			).path,
		).toBe("spinetabSseLink.connectionParams.secret");
	});
});

describe("worker validators refuse them too (hand-built bridge messages)", () => {
	it("graphql-ws, graphql-sse, Socket.IO and tRPC WS", () => {
		expect(
			refusal(() =>
				graphqlWsAdapter().validateConnection?.({
					url: "wss://api.test/graphql",
					connectionParams: { password: SECRET },
				}),
			).path,
		).toBe("connection.connectionParams.password");
		expect(
			refusal(() =>
				graphqlSseAdapter().validateConnection?.({
					url: "https://api.test/stream",
					headers: { "x-auth-token": SECRET },
				}),
			).path,
		).toBe("connection.headers.x-auth-token");
		expect(
			refusal(() =>
				socketIoAdapter().validateConnection?.({
					url: "https://h.test/chat",
					sharing: "shared",
					query: { refresh_token: SECRET },
				}),
			).path,
		).toBe("connection.query.refresh_token");
		expect(
			refusal(() =>
				trpcWsAdapter().validateConnection?.({
					url: "wss://api.test/trpc?apikey=x",
				}),
			).path,
		).toBe("connection.url");
	});
});
