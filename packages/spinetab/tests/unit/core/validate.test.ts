import { describe, expect, it } from "vitest";
import {
	isCredentials,
	refuseCredentialCarriers,
} from "../../../src/core/validate.ts";

// Credential-shaped static options are rejected as an accident guard, not a security boundary.

function refusal(run: () => void) {
	try {
		run();
	} catch (error) {
		return error as { code: string; message: string; detail?: unknown };
	}
	return undefined;
}

describe("refuseCredentialCarriers", () => {
	it.each([
		"access_token",
		"id_token",
		"refresh_token",
		"token",
		"api_key",
		"apikey",
		"jwt",
		"auth",
		"authorization",
		"password",
		"secret",
		"Access_Token",
		"TOKEN",
	])("refuses the key %s in query, connectionParams and auth objects", (key) => {
		for (const path of ["query", "connection.connectionParams", "auth"]) {
			const error = refusal(() =>
				refuseCredentialCarriers({ room: "a", [key]: "CANARY" }, path),
			);
			expect(error?.code).toBe("unsupported-option");
			expect(error?.message).toContain(`${path}.${key}`);
			expect(error?.message).toContain("credentials provider");
			expect(error?.message).not.toContain("CANARY");
		}
	});

	it("refuses token keys nested at any depth, and a bare query parameter name", () => {
		expect(
			refusal(() =>
				refuseCredentialCarriers(
					{ headers: { Authorization: "Bearer CANARY" } },
					"connectionParams",
				),
			)?.message,
		).toContain("connectionParams.headers.Authorization");
		expect(
			refusal(() =>
				refuseCredentialCarriers(
					[{ ok: 1 }, { jwt: "x" }],
					"connectionParams.list",
				),
			)?.message,
		).toContain("connectionParams.list.1.jwt");
		expect(
			refusal(() => refuseCredentialCarriers("access_token", "resume.query"))
				?.code,
		).toBe("unsupported-option");
	});

	it("refuses a token key at any depth (past 32 levels too) and survives cycles", () => {
		let value: Record<string, unknown> = { token: "CANARY" };
		for (let depth = 0; depth < 40; depth += 1) value = { n: value };
		const error = refusal(() => refuseCredentialCarriers(value, "auth"));
		expect(error?.code).toBe("unsupported-option");
		expect(error?.message).toMatch(/^auth(\.n){40}\.token /);
		const cyclic: Record<string, unknown> = { room: "a" };
		cyclic.self = cyclic;
		expect(() => refuseCredentialCarriers(cyclic, "query")).not.toThrow();
	});

	it("keeps the list narrow: similar keys and token-like values pass", () => {
		expect(() =>
			refuseCredentialCarriers(
				{
					author: "a",
					tokens: 3,
					authMode: "cookie",
					role: ["auth", "token"],
					nested: { page: 1 },
				},
				"connectionParams",
			),
		).not.toThrow();
		expect(() =>
			refuseCredentialCarriers("cursor", "resume.query"),
		).not.toThrow();
		expect(() => refuseCredentialCarriers(undefined, "query")).not.toThrow();
	});

	it.each([
		"authorization",
		"Proxy-Authorization",
		"cookie",
		"X-API-Key",
		"x-auth-token",
		"Last-Event-ID",
	])("refuses the static header %s", (name) => {
		const error = refusal(() =>
			refuseCredentialCarriers(
				{ accept: "text/event-stream", [name]: "CANARY" },
				"connection.headers",
			),
		);
		expect(error?.code).toBe("unsupported-option");
		expect(error?.message).toContain(`connection.headers.${name}`);
		expect(error?.message).toContain("credentials provider");
		expect(error?.message).not.toContain("CANARY");
	});

	it("other static headers pass, including names that are token keys elsewhere", () => {
		expect(() =>
			refuseCredentialCarriers(
				{ accept: "application/json", "x-request-id": "1", token: "n" },
				"headers",
			),
		).not.toThrow();
	});

	it("refuses subprotocols longer than 64 characters or containing bearer", () => {
		const jwt = `eyJ${"a".repeat(80)}.b.c`;
		for (const value of [[jwt], ["graphql-ws", "Bearer.abc"], "x-BEARER"]) {
			const error = refusal(() =>
				refuseCredentialCarriers(value, "connection.subprotocols"),
			);
			expect(error?.code).toBe("unsupported-option");
			expect(error?.message).toContain("connection.subprotocols");
			expect(error?.message).not.toContain(jwt);
		}
		expect(() =>
			refuseCredentialCarriers(
				["graphql-transport-ws", "a".repeat(64)],
				"subprotocols",
			),
		).not.toThrow();
	});

	it("names the adapter when given", () => {
		expect(
			refusal(() =>
				refuseCredentialCarriers({ token: "x" }, "query", "socket-io"),
			)?.message,
		).toMatch(/^socket-io: query\.token /);
	});
});

describe("isCredentials", () => {
	const cyclic: Record<string, unknown> = {};
	cyclic.self = cyclic;
	it.each([
		[{ connectionParams: { at: new Date(0) } }],
		[{ connectionParams: { list: new Map([["a", 1]]) } }],
		[{ connectionParams: { big: 1n } }],
		[{ auth: { n: Number.NaN } }],
		[{ auth: { n: Number.POSITIVE_INFINITY } }],
		[{ auth: { u: undefined } }],
		[{ auth: { nested: { u: undefined } } }],
		[{ auth: { list: [1, undefined] } }],
		[{ auth: { list: new Array<number>(2) } }],
		[{ auth: { f() {} } }],
		[{ connectionParams: cyclic }],
	])("refuses %o: connectionParams and auth are Record<string, Json>", (value) => {
		expect(isCredentials(value)).toBe(false);
	});

	it("accepts JSON records, nested objects, arrays and null", () => {
		const shared = { id: 1 };
		expect(
			isCredentials({
				headers: { authorization: "Bearer t" },
				connectionParams: { token: "t", tenant: { id: 1, tags: ["a", null] } },
				auth: { a: shared, b: shared, ok: true, n: -1.5 },
			}),
		).toBe(true);
		expect(isCredentials({ headers: undefined, auth: {} })).toBe(true);
	});
});
