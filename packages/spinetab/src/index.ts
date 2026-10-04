// Framework-independent page entry (`spinetab`). Imports only page-side core
// modules and the `spinetab/wiring` seam: never the runtime engine, adapters
// or upstream clients.
import { wiring } from "spinetab/wiring";
import { createSpinetab as createClient } from "./core/client.ts";
import type { SpinetabClient, SpinetabOptions } from "./core/types.ts";
import { isPlainObject } from "./core/validate.ts";

/** Inert until start or subscribe; supplying either worker or local disables all plugin wiring for this client. */
export function createSpinetab(options: SpinetabOptions = {}): SpinetabClient {
	return createClient(
		wiring &&
			isPlainObject(options) &&
			options.worker === undefined &&
			options.local === undefined
			? { ...options, worker: wiring.worker, local: wiring.local }
			: options,
	);
}

export { isSpinetabError, SpinetabError } from "./core/errors.ts";
export {
	type ReconcileContext,
	type ReconcileOptions,
	reconcileLatest,
	reconcileOnLoss,
} from "./core/reconcile.ts";
export { INACTIVE_STATUS, SERVER_STATUS } from "./core/status.ts";
export {
	type StatusPhase,
	type StatusSummary,
	summariseStatus,
} from "./core/summary.ts";
export type {
	ClientStatus,
	CommandOutcome,
	CommandRequest,
	ConnectionReason,
	ConnectionState,
	ConnectionStatus,
	ConsumerJson,
	ConsumerOptions,
	Continuity,
	ContinuityReason,
	ContinuityState,
	CredentialRequest,
	CredentialRevision,
	Credentials,
	DeliveryLimits,
	DiagnosticEvent,
	EventMeta,
	ExecutionMode,
	Feed,
	Json,
	LocalRuntimeModule,
	ModeReason,
	Observer,
	ResumeState,
	RuntimeHandle,
	RuntimeHealth,
	RuntimeLimits,
	SerialisedError,
	SharedWorkerLike,
	SharingPolicy,
	Source,
	SpinetabClient,
	SpinetabErrorCode,
	SpinetabOptions,
	Store,
	Subscription,
	SubscriptionObserver,
	SubscriptionRequest,
	SubscriptionStatus,
} from "./core/types.ts";
export { resolveEndpoint } from "./core/url.ts";
