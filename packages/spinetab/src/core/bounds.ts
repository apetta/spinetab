import { estimateBytes } from "./estimate.ts";
import type {
	CommandOutcome,
	Continuity,
	DiagnosticEvent,
	Json,
	SerialisedError,
	SpinetabErrorCode,
} from "./types.ts";

/** Omit oversized control content with an explicit marker; never truncate it. */

/** Estimated bytes; `Infinity` when the value cannot be estimated (or cloned). */
export function contentBytes(value: unknown): number {
	return estimateBytes(value) ?? Number.POSITIVE_INFINITY;
}

const describeBytes = (bytes: number) =>
	Number.isFinite(bytes) ? `${bytes} bytes` : "a value that cannot be cloned";

/**
 * Keep an error's code and retryability; omit its message and detail when
 * together they exceed `limit`. `bytes` may be precomputed once for fan-out.
 */
export function boundError(
	error: SerialisedError,
	limit: number,
	bytes = contentBytes(error),
): SerialisedError {
	if (bytes <= limit) return error;
	const code: SpinetabErrorCode =
		typeof error.code === "string" && contentBytes(error.code) <= limit
			? error.code
			: "upstream-error";
	return {
		code,
		message: `The ${code} error's message and detail (${describeBytes(bytes)}) exceed maxMessageBytes (${limit}) and were omitted.`,
		detail: omitted(limit, bytes),
		...(error.retryable ? { retryable: true } : {}),
	};
}

/**
 * A command reply larger than `limit` never crosses: an acknowledged result
 * becomes `unknown` (it reached the server, but its value cannot be
 * delivered, so a blind retry is unsafe); other outcomes keep their status
 * with a bounded error. A value the estimator cannot size is reported like a
 * `DataCloneError` (`unknown`, reason `not-serialisable`).
 */
export function boundOutcome(
	outcome: CommandOutcome,
	limit: number,
): CommandOutcome {
	if (outcome.status === "sent") return outcome;
	if (outcome.status !== "acknowledged") {
		return { ...outcome, error: boundError(outcome.error, limit) };
	}
	const bytes = contentBytes(outcome.value);
	if (bytes <= limit) return outcome;
	if (!Number.isFinite(bytes)) {
		return {
			status: "unknown",
			error: {
				code: "command-unknown",
				message: "The command result could not be cloned to the page.",
				detail: { reason: "not-serialisable", acknowledged: true },
			},
		};
	}
	return {
		status: "unknown",
		error: {
			code: "limit-exceeded",
			message: `The command was acknowledged, but its result (${bytes} bytes) exceeds maxMessageBytes (${limit}) and was not delivered; do not retry blindly.`,
			detail: { ...omitted(limit, bytes), acknowledged: true },
		},
	};
}

/** Omit (never truncate) a continuity cursor larger than `limit`. */
export function boundContinuity(
	continuity: Continuity,
	limit: number,
	cursorBytes = continuity.cursor === undefined
		? 0
		: contentBytes(continuity.cursor),
): Continuity {
	if (cursorBytes <= limit) return continuity;
	const { cursor: _omitted, ...rest } = continuity;
	return rest;
}

/**
 * Replace an oversized or uncloneable adapter diagnostic with a fixed marker.
 * Runtime-generated diagnostics are fixed-size by construction.
 */
export function boundDiagnostic(
	event: Pick<DiagnosticEvent, "type" | "detail">,
	limit: number,
): Pick<DiagnosticEvent, "type" | "detail"> {
	const bytes = contentBytes([event.type, event.detail ?? null]);
	if (bytes <= limit) return event;
	return { type: "diagnostic-omitted", detail: omitted(limit, bytes) };
}

function omitted(limit: number, bytes: number): { [key: string]: Json } {
	return {
		reason: "limit-exceeded",
		limit: "maxMessageBytes",
		value: limit,
		...(Number.isFinite(bytes) ? { bytes } : { cloneable: false }),
	};
}
