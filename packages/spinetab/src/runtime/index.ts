// Runtime engine entry (`spinetab/runtime`) for the SharedWorker entry and the
// lazily loaded local runtime module. Never imports page-only code.
export type {
	AdapterConnection,
	AdapterSubscription,
	AdapterSubscriptionOptions,
	ConnectionContext,
	ConsumerContext,
	ContinuityDetail,
	RuntimeAdapter,
	SinkNextMeta,
	SubscriptionSink,
} from "../core/adapter.ts";
export { defineAdapter } from "../core/adapter.ts";
export type { Clock } from "../core/clock.ts";
export { isSpinetabError, SpinetabError } from "../core/errors.ts";
export { stableStringify, uniqueKey } from "../core/identity.ts";
export { DEFAULT_LIMITS } from "../core/limits.ts";
export type {
	AnyRuntimeAdapter,
	AttachmentStats,
	Runtime,
	RuntimeHighWaterMarks,
	RuntimeOptions,
	RuntimeStats,
	RuntimeStatsOptions,
} from "../core/runtime.ts";
export { createRuntime } from "../core/runtime.ts";
export type {
	CommandOutcome,
	ConnectionStatus,
	ContinuityReason,
	CredentialRequest,
	CredentialRevision,
	Credentials,
	DiagnosticEvent,
	Json,
	RuntimeLimits,
	SerialisedError,
	SpinetabErrorCode,
} from "../core/types.ts";
