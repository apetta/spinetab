import { describe, expect, it } from "vitest";
import type { SpinetabError } from "../../../src/core/errors.ts";
import { polling } from "../../../src/transports/polling/index.ts";
import { pollingAdapter } from "../../../src/transports/polling/runtime.ts";
import { sse } from "../../../src/transports/sse/index.ts";
import { sseAdapter } from "../../../src/transports/sse/runtime.ts";
import { stream } from "../../../src/transports/stream/index.ts";
import { streamAdapter } from "../../../src/transports/stream/runtime.ts";
import { websocket } from "../../../src/transports/websocket/index.ts";
import { websocketAdapter } from "../../../src/transports/websocket/runtime.ts";

// Token-shaped credential carriers are refused in static options by every
// page builder and again by each worker validator (an accident guard).

function refusal(action: () => unknown): SpinetabError | undefined {
	try {
		action();
	} catch (error) {
		return error as SpinetabError;
	}
	return undefined;
}

const HTTP = "https://api.test/feed";
const WS = "wss://api.test/ws";

const headerBuilders = [
	["polling", (headers: Record<string, string>) => polling(HTTP, { headers })],
	["sse", (headers: Record<string, string>) => sse(HTTP, { headers })],
	["stream", (headers: Record<string, string>) => stream(HTTP, { headers })],
] as const;

describe("credential carriers in static options", () => {
	for (const [name, build] of headerBuilders) {
		it(`(${name}): refuses credential header names, including last-event-id, never echoing the value`, () => {
			for (const header of [
				"Authorization",
				"proxy-authorization",
				"Cookie",
				"X-API-Key",
				"x-auth-token",
				"Last-Event-ID",
			]) {
				const error = refusal(() => build({ [header]: "secret-value" }));
				expect(error?.code, `${name} ${header}`).toBe("unsupported-option");
				expect(error?.message).not.toContain("secret-value");
			}
			expect(refusal(() => build({ "x-feed": "a" }))).toBeUndefined();
		});
	}

	it("refuses a token-named SSE resume query parameter", () => {
		expect(
			refusal(() => sse(HTTP, { resume: { query: "access_token" } }))?.code,
		).toBe("unsupported-option");
		expect(refusal(() => sse(HTTP, { resume: { query: "cursor" } }))).toBe(
			undefined,
		);
	});

	it("refuses token-shaped WebSocket subprotocols", () => {
		const jwt = `${"a".repeat(30)}.${"b".repeat(30)}.${"c".repeat(30)}`;
		for (const subprotocol of [jwt, "bearer", "Bearer.abc"]) {
			expect(
				refusal(() => websocket(WS, { subprotocols: [subprotocol] }))?.code,
				subprotocol,
			).toBe("unsupported-option");
		}
		expect(
			refusal(() => websocket(WS, { subprotocols: ["graphql-transport-ws"] })),
		).toBeUndefined();
	});

	it("the worker validators refuse the same carriers (version skew)", () => {
		const cases: Array<() => unknown> = [
			() =>
				pollingAdapter().validateConnection?.({
					url: HTTP,
					method: "GET",
					decoder: "json",
					timeoutMs: 30_000,
					headers: { "x-api-key": "k" },
				}),
			() =>
				sseAdapter().validateConnection?.({
					url: HTTP,
					headers: { "X-Auth-Token": "k" },
				}),
			() =>
				streamAdapter().validateConnection?.({
					url: HTTP,
					headers: { Cookie: "c" },
				}),
			() =>
				websocketAdapter().validateConnection?.({
					url: WS,
					subprotocols: ["bearer-x"],
				}),
		];
		for (const validate of cases) {
			expect(refusal(validate)?.code).toBe("unsupported-option");
		}
	});

	const urlBuilders = [
		["polling", (url: string) => polling(url)],
		["sse", (url: string) => sse(url)],
		["stream", (url: string) => stream(url)],
		["websocket", (url: string) => websocket(url.replace(/^https/, "wss"))],
	] as const;

	for (const [name, build] of urlBuilders) {
		it(`(${name}): refuses token-named URL query parameters, relative or absolute, never echoing the value`, () => {
			for (const query of [
				"access_token",
				"ID_TOKEN",
				"refresh_token",
				"token",
				"api_key",
				"apiKey",
				"jwt",
				"auth",
				"Authorization",
				"password",
				"secret",
			]) {
				for (const url of [
					`https://api.test/feed?tag=a&${query}=secret-value`,
					`/feed?${query}=secret-value`,
				]) {
					const error = refusal(() => build(url));
					expect(error?.code, `${name} ${url}`).toBe("unsupported-option");
					expect(error?.message).not.toContain("secret-value");
					expect(error?.detail).toMatchObject({
						path: name === "polling" ? "polling.url" : "connection.url",
					});
				}
			}
			expect(
				refusal(() =>
					build("https://api.test/feed?tag=a&tokenish=1&gate=auth"),
				),
			).toBeUndefined();
		});
	}

	it("the worker validators refuse token-named URL query parameters (version skew)", () => {
		const url = "https://api.test/feed?Access_Token=secret-value";
		const cases: Array<() => unknown> = [
			() =>
				pollingAdapter().validateConnection?.({
					url,
					method: "GET",
					decoder: "json",
					timeoutMs: 30_000,
				}),
			() => sseAdapter().validateConnection?.({ url }),
			() => streamAdapter().validateConnection?.({ url }),
			() =>
				websocketAdapter().validateConnection?.({
					url: url.replace(/^https/, "wss"),
				}),
		];
		for (const validate of cases) {
			const error = refusal(validate);
			expect(error?.code).toBe("unsupported-option");
			expect(error?.detail).toMatchObject({ path: "connection.url" });
			expect(error?.message).not.toContain("secret-value");
		}
	});
});
