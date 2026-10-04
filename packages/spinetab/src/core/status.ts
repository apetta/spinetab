import type { ClientStatus, SubscriptionStatus } from "./types.ts";

/**
 * Referentially constant status snapshots, in a tiny side-effect-free module
 * so bindings can import them without pulling in the page client.
 */

/** Server rendering status: identical on every server call. */
export const SERVER_STATUS: ClientStatus = Object.freeze({
	mode: "inactive",
	reason: "server",
	health: "unknown",
	generation: 0,
}) as ClientStatus;

/** Browser status before `start()` or the first subscribe. */
export const INACTIVE_STATUS: ClientStatus = Object.freeze({
	mode: "inactive",
	health: "unknown",
	generation: 0,
}) as ClientStatus;

/** Status of an inert server-side subscription handle. */
export const SERVER_SUBSCRIPTION_STATUS: SubscriptionStatus = Object.freeze({
	active: false,
	connection: Object.freeze({ state: "inactive", since: 0 }),
	continuity: Object.freeze({ state: "continuous", since: 0 }),
}) as SubscriptionStatus;
