import type { SubscriptionStatus } from "./types.ts";

/**
 * One word for where a subscription stands. `live` means connected upstream;
 * it never means that nothing was missed (read `needsReconcile` for that).
 */
export type StatusPhase =
	| "idle"
	| "connecting"
	| "live"
	| "reconnecting"
	| "reattaching"
	| "blocked"
	| "ended";

export interface StatusSummary {
	phase: StatusPhase;
	/**
	 * Continuity is `gap` or `unknown`: data may be missing until the
	 * application reconciles. Stays true while a pending reconcile runs.
	 */
	needsReconcile: boolean;
}

/**
 * Summarise a subscription status without merging connection and
 * continuity: `phase` comes from the connection alone and `needsReconcile`
 * from continuity alone. A pure helper, tree-shaken when unused.
 */
export function summariseStatus(status: SubscriptionStatus): StatusSummary {
	const { state, reason } = status.connection;
	let phase: StatusPhase;
	if (state === "inactive") phase = "idle";
	else if (!status.active || state === "failed" || state === "disposed")
		phase = "ended";
	else if (state === "auth-blocked" || state === "retry-exhausted")
		phase = "blocked";
	else if (state === "connected") phase = "live";
	// The page lost its runtime; not an upstream failure.
	else if (reason === "runtime-replaced") phase = "reattaching";
	else phase = state;
	const continuity = status.continuity.state;
	return {
		phase,
		needsReconcile: continuity === "gap" || continuity === "unknown",
	};
}
