import { describe, expect, it } from "vitest";
import { summariseStatus } from "../../../src/core/summary.ts";
import type {
	ConnectionStatus,
	Continuity,
	SubscriptionStatus,
} from "../../../src/core/types.ts";

const status = (
	connection: Omit<ConnectionStatus, "since">,
	continuity: Omit<Continuity, "since"> = { state: "continuous" },
	active = true,
): SubscriptionStatus => ({
	active,
	connection: { ...connection, since: 1 },
	continuity: { ...continuity, since: 1 },
});

describe("summariseStatus", () => {
	it.each([
		[{ state: "inactive" }, "idle"],
		[{ state: "connecting" }, "connecting"],
		[{ state: "connected" }, "live"],
		[{ state: "reconnecting", reason: "network" }, "reconnecting"],
		[{ state: "connecting", reason: "runtime-replaced" }, "reattaching"],
		[{ state: "reconnecting", reason: "runtime-replaced" }, "reattaching"],
		[{ state: "auth-blocked", reason: "no-credential-source" }, "blocked"],
		[{ state: "retry-exhausted", reason: "attempts-exhausted" }, "blocked"],
		[{ state: "failed", reason: "permanent-error" }, "ended"],
		[{ state: "disposed" }, "ended"],
	] as const)("maps %j to phase %s", (connection, phase) => {
		expect(summariseStatus(status(connection)).phase).toBe(phase);
	});

	it("an ended subscription (inactive handle) reads ended, a never-started one idle", () => {
		expect(
			summariseStatus(status({ state: "connected" }, undefined, false)).phase,
		).toBe("ended");
		expect(
			summariseStatus(status({ state: "inactive" }, undefined, false)).phase,
		).toBe("idle");
	});

	it.each([
		["continuous", false],
		["resumed", false],
		["gap", true],
		["unknown", true],
	] as const)("needsReconcile for continuity %s is %s", (state, needs) => {
		expect(
			summariseStatus(status({ state: "connected" }, { state })).needsReconcile,
		).toBe(needs);
	});

	it("live never implies nothing was missed: phase and needsReconcile stay separate", () => {
		expect(
			summariseStatus(
				status({ state: "connected" }, { state: "gap", reason: "overflow" }),
			),
		).toEqual({ phase: "live", needsReconcile: true });
	});
});
