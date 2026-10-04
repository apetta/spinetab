import { describe, expect, it } from "vitest";
import {
	CREDENTIAL_ORIGIN_SENTENCE,
	checkCredentialOrigin,
	isLoopbackHost,
	normaliseCredentialOrigins,
	type OriginCheck,
} from "../../../src/core/origins.ts";

// the credential-origin rule shared by `createRuntime` and the
// build plugins. The runtime parity lives in runtime-origins-parity.test.ts.

const reasonOf = (value: unknown) => {
	const check = checkCredentialOrigin(value);
	return check.ok ? "ok" : check.reason;
};

describe("checkCredentialOrigin", () => {
	it("keeps the fixed sentence the build messages and the runtime share", () => {
		expect(CREDENTIAL_ORIGIN_SENTENCE).toBe(
			'must be an exact https: origin such as "https://api.example.com" (http: only for loopback), without a path, query, fragment or userinfo.',
		);
	});

	it("reason type: anything but a string", () => {
		for (const value of [
			undefined,
			null,
			42,
			true,
			{},
			["https://api.test"],
			new URL("https://api.test"),
			{ toString: () => "https://api.test" },
		]) {
			expect(reasonOf(value), String(value)).toBe("type");
		}
	});

	it("reason syntax: text URL cannot parse", () => {
		for (const value of [
			"",
			" ",
			"api.test",
			"//api.test",
			"https://",
			"https://api test",
			"http://[::1",
			"not a url",
		]) {
			expect(reasonOf(value), value).toBe("syntax");
		}
	});

	it("reason scheme: not https:, and not http: on a loopback host", () => {
		for (const value of [
			"http://api.test",
			"wss://api.test",
			"ws://localhost",
			"ftp://api.test",
			"file:///etc/passwd",
			"data:text/plain,x",
			"javascript:alert(1)",
			"blob:https://api.test/uuid",
			"http://localhost.evil.test",
			"http://127.0.0.1.evil.test",
			"http://evil-localhost",
			"http://[::2]",
			"http://0.0.0.0",
			"http://10.0.0.1",
		]) {
			expect(reasonOf(value), value).toBe("scheme");
		}
	});

	it("reason userinfo: a user name or password", () => {
		for (const value of [
			"https://user@api.test",
			"https://:secret@api.test",
			"https://user:secret@api.test",
			"http://user@localhost:3000",
		]) {
			expect(reasonOf(value), value).toBe("userinfo");
		}
	});

	it("reason path: a path, query or fragment, even an empty one", () => {
		for (const value of [
			"https://api.test/path",
			"https://api.test//",
			"https://api.test/api/",
			"https://api.test?x=1",
			"https://api.test?",
			"https://api.test/?",
			"https://api.test#f",
			"https://api.test#",
			"https://api.test/#",
			"http://localhost:3000/app",
		]) {
			expect(reasonOf(value), value).toBe("path");
		}
	});

	it("accepts http: only on loopback hosts", () => {
		expect(
			[
				"http://localhost",
				"http://localhost:3000",
				"http://app.localhost:5173",
				"http://127.0.0.1",
				"http://127.1.2.3:8080",
				"http://[::1]:4000",
			].map((value) => checkCredentialOrigin(value)),
		).toEqual([
			{ ok: true, origin: "http://localhost" },
			{ ok: true, origin: "http://localhost:3000" },
			{ ok: true, origin: "http://app.localhost:5173" },
			{ ok: true, origin: "http://127.0.0.1" },
			{ ok: true, origin: "http://127.1.2.3:8080" },
			{ ok: true, origin: "http://[::1]:4000" },
		]);
	});

	it("normalises an accepted entry to URL.origin", () => {
		const cases: [string, string][] = [
			["https://api.test", "https://api.test"],
			["https://api.test/", "https://api.test"],
			["HTTPS://API.Test", "https://api.test"],
			["https://api.test:443", "https://api.test"],
			["https://api.test:8443", "https://api.test:8443"],
			["http://localhost:80", "http://localhost"],
			["https://bücher.example", "https://xn--bcher-kva.example"],
			["https://localhost", "https://localhost"],
			// URL trims surrounding spaces; the runtime has always accepted this.
			[" https://api.test ", "https://api.test"],
		];
		for (const [value, origin] of cases) {
			expect(checkCredentialOrigin(value), value).toEqual<OriginCheck>({
				ok: true,
				origin,
			});
		}
	});

	it("shares the loopback predicate the runtime judges URLs with", () => {
		for (const host of ["localhost", "a.localhost", "[::1]", "127.9.9.9"]) {
			expect(isLoopbackHost(host), host).toBe(true);
		}
		for (const host of ["localhost.test", "[::2]", "127.0.0", "128.0.0.1"]) {
			expect(isLoopbackHost(host), host).toBe(false);
		}
	});
});

describe("normaliseCredentialOrigins", () => {
	it("normalises, de-duplicates and sorts by code unit", () => {
		expect(
			normaliseCredentialOrigins([
				"https://b.test",
				"https://B.test/",
				"https://a.test:443",
				"https://a.test",
				"https://a.test:9",
				"https://a.test:10",
				"http://localhost:3000",
			]),
		).toEqual([
			"http://localhost:3000",
			"https://a.test",
			"https://a.test:10",
			"https://a.test:9",
			"https://b.test",
		]);
	});

	it("gives the same result for every input order", () => {
		const values = ["https://c.test", "https://a.test/", "https://B.test"];
		const expected = ["https://a.test", "https://b.test", "https://c.test"];
		for (const order of [
			[0, 1, 2],
			[2, 1, 0],
			[1, 0, 2],
		]) {
			expect(
				normaliseCredentialOrigins(order.map((index) => values[index] ?? "")),
			).toEqual(expected);
		}
	});

	it("throws nothing and leaves invalid entries out", () => {
		const values = [
			"https://api.test/path",
			42,
			null,
			"http://api.test",
			"https://user@api.test",
			"https://ok.test",
		] as unknown as string[];
		expect(() => normaliseCredentialOrigins(values)).not.toThrow();
		expect(normaliseCredentialOrigins(values)).toEqual(["https://ok.test"]);
		expect(normaliseCredentialOrigins([])).toEqual([]);
	});

	it("does not mutate its input", () => {
		const values = Object.freeze(["https://b.test", "https://a.test"]);
		expect(normaliseCredentialOrigins(values)).toEqual([
			"https://a.test",
			"https://b.test",
		]);
		expect(values).toEqual(["https://b.test", "https://a.test"]);
	});
});
