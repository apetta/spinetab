import { describe, expect, it } from "vitest";
import { isSpinetabError } from "../../../src/core/errors.ts";
import {
	assertAbsoluteEndpoint,
	resolveEndpoint,
} from "../../../src/core/url.ts";

// (relative endpoints resolved in the page; runtime rejects
// non-absolute endpoints; userinfo rejected).

const expectCode = (run: () => unknown, code: string) => {
	try {
		run();
	} catch (error) {
		expect(isSpinetabError(error, code as never)).toBe(true);
		return;
	}
	throw new Error("expected a SpinetabError");
};

describe("resolveEndpoint", () => {
	it("resolves against the application base, not a worker asset path", () => {
		expect(resolveEndpoint("api/feed", "https://app.test/app/page")).toBe(
			"https://app.test/app/api/feed",
		);
		expect(
			resolveEndpoint("/poll/value?id=1", "http://127.0.0.1:4500/harness/"),
		).toBe("http://127.0.0.1:4500/poll/value?id=1");
		expect(resolveEndpoint("wss://other.test/ws")).toBe("wss://other.test/ws");
	});

	it("gives different identities for different bases", () => {
		expect(resolveEndpoint("api", "https://a.test/x/")).not.toBe(
			resolveEndpoint("api", "https://a.test/y/"),
		);
	});

	it("rejects userinfo, empty and unresolvable endpoints with invalid-endpoint", () => {
		expectCode(
			() => resolveEndpoint("https://user:secret@api.test/feed"),
			"invalid-endpoint",
		);
		expectCode(
			() => resolveEndpoint("//user@api.test/", "https://a.test/"),
			"invalid-endpoint",
		);
		expectCode(() => resolveEndpoint(""), "invalid-endpoint");
		expectCode(() => resolveEndpoint("relative/only"), "invalid-endpoint");
		try {
			resolveEndpoint("https://user:secret@api.test/feed");
		} catch (error) {
			expect(String((error as Error).message)).not.toContain("secret");
		}
	});

	it("runtime-side check accepts absolute URLs only", () => {
		expect(() =>
			assertAbsoluteEndpoint("https://api.test/x", "url"),
		).not.toThrow();
		expectCode(() => assertAbsoluteEndpoint("/x", "url"), "invalid-endpoint");
		expectCode(() => assertAbsoluteEndpoint(5, "url"), "invalid-endpoint");
	});
});
