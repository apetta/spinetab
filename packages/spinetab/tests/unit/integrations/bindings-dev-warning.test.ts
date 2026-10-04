import { afterEach, describe, expect, it, vi } from "vitest";
import { warnUnowned } from "../../../src/bindings/shared/dev.ts";

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("development warnings in the Vue and Solid bindings", () => {
	it("warns outside production with the existing wording", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.stubEnv("NODE_ENV", "development");
		warnUnowned("useSubscription", "vue");
		vi.stubEnv("NODE_ENV", "test");
		warnUnowned("createSubscription", "solid");
		expect(warn.mock.calls).toEqual([
			[
				"[spinetab] useSubscription was called without an active effect scope; call dispose() yourself.",
			],
			[
				"[spinetab] createSubscription was called outside a reactive owner; call dispose() yourself.",
			],
		]);
	});

	it("is silent when NODE_ENV is production", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.stubEnv("NODE_ENV", "production");
		warnUnowned("useSubscription", "vue");
		warnUnowned("createSubscription", "solid");
		expect(warn).not.toHaveBeenCalled();
	});

	it("a missing process global does not throw and stays silent", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const scope = globalThis as { process?: unknown };
		const original = scope.process;
		try {
			delete scope.process;
			expect(typeof process).toBe("undefined");
			expect(() => warnUnowned("useSubscription", "vue")).not.toThrow();
			scope.process = undefined;
			expect(() => warnUnowned("createSubscription", "solid")).not.toThrow();
		} finally {
			scope.process = original;
		}
		expect(warn).not.toHaveBeenCalled();
	});
});
