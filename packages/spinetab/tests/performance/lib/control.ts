import { DEFAULT_LIMITS } from "../../../src/core/limits.ts";
import type { RuntimeLimits } from "../../../src/core/types.ts";

/**
 * Control flow control bounds.
 *
 * `maxControlMessages` bounds control messages
 * *posted* and unacknowledged: a normal 100-subscription burst fills it on
 * purpose and queues the remainder in the attachment's outbox, which drains
 * as acknowledgements arrive. The finite failure bounds are the outbox's:
 * the runtime expires the attachment (`cause: "control-queue"`) only when one
 * more queued message would exceed the count bound or the byte bound. Spare
 * capacity (≥ 4× headroom) is therefore measured against these two bounds;
 * the posted window's occupancy is an observation, not a failure budget.
 *
 * `queued` mirrors `queuedControlCap()` in src/core/runtime.ts (a private
 * closure) and `queuedBytes` its byte check `maxControlMessages ×
 * maxMessageBytes`. tests/unit/performance/control.test.ts drives the real
 * runtime to each bound, so a change there fails the tooling's tests instead
 * of silently skewing headroom.
 */
export interface ControlBounds {
	/** Posted and unacknowledged control per attachment (flow control). */
	window: number;
	/** Control messages queued in one attachment's outbox. */
	queued: number;
	/** Estimated bytes of control snapshots queued in one outbox. */
	queuedBytes: number;
}

export type ControlLimits = Pick<
	RuntimeLimits,
	| "maxControlMessages"
	| "maxConsumersPerAttachment"
	| "maxPendingCommands"
	| "maxMessageBytes"
>;

export function controlBounds(
	limits: ControlLimits = DEFAULT_LIMITS,
): ControlBounds {
	return {
		window: limits.maxControlMessages,
		queued: 2 * (limits.maxConsumersPerAttachment + limits.maxPendingCommands),
		queuedBytes: limits.maxControlMessages * limits.maxMessageBytes,
	};
}

/** Bounds at the package defaults, which the bench runtime uses. */
export const CONTROL_BOUNDS: Readonly<ControlBounds> = Object.freeze(
	controlBounds(),
);
