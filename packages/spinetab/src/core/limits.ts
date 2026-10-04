import { MAX_TIMER_MS } from "./clock.ts";
import { SpinetabError } from "./errors.ts";
import type { DeliveryLimits, RuntimeLimits } from "./types.ts";

const KIB = 1024;
const MIB = 1024 * KIB;

export const DEFAULT_LIMITS: Readonly<RuntimeLimits> = Object.freeze({
	maxPendingMessages: 256,
	maxPendingBytes: 1 * MIB,
	maxPendingMessagesPerConsumer: 64,
	maxPendingBytesPerConsumer: 256 * KIB,
	maxMessageBytes: 256 * KIB,
	maxControlMessages: 64,
	maxPendingCommands: 64,
	commandTimeoutMs: 30_000,
	credentialTimeoutMs: 5_000,
	maxFrameBytes: 256 * KIB,
	maxConsumersPerAttachment: 1_000,
	maxSubscriptions: 1_000,
	maxConnections: 32,
	leaseMs: 180_000,
	idleCloseMs: 5_000,
	lingerMs: 0,
});

export const LIMIT_CAPS: Readonly<Partial<RuntimeLimits>> = Object.freeze({
	idleCloseMs: 60_000,
	lingerMs: 5_000,
	// Host timers cannot wait longer.
	leaseMs: MAX_TIMER_MS,
	commandTimeoutMs: MAX_TIMER_MS,
	credentialTimeoutMs: MAX_TIMER_MS,
});

const DELIVERY_KEYS: ReadonlyArray<keyof DeliveryLimits> = [
	"maxPendingMessages",
	"maxPendingBytes",
	"maxPendingMessagesPerConsumer",
	"maxPendingBytesPerConsumer",
	"maxMessageBytes",
];

/**
 * Merge overrides onto defaults. Every value must be a finite positive integer
 * (zero allowed only for `lingerMs`), within its cap where one exists, and no
 * unknown key is accepted.
 */
export function resolveLimits(
	overrides: Partial<RuntimeLimits> | undefined,
	base: Readonly<RuntimeLimits> = DEFAULT_LIMITS,
	path = "limits",
): RuntimeLimits {
	const result: RuntimeLimits = { ...base };
	if (overrides === undefined) return result;
	if (
		typeof overrides !== "object" ||
		overrides === null ||
		Array.isArray(overrides)
	) {
		throw new SpinetabError(
			"unsupported-option",
			`${path} must be an object.`,
			{
				detail: { path },
			},
		);
	}
	for (const key of Object.keys(overrides)) {
		const value = (overrides as Record<string, unknown>)[key];
		if (!Object.hasOwn(base, key)) {
			throw new SpinetabError(
				"unsupported-option",
				`Unknown limit ${path}.${key}.`,
				{
					detail: { path: `${path}.${key}` },
				},
			);
		}
		if (value === undefined) continue;
		const allowZero = key === "lingerMs";
		if (
			typeof value !== "number" ||
			!Number.isInteger(value) ||
			(allowZero ? value < 0 : value <= 0)
		) {
			throw new SpinetabError(
				"unsupported-option",
				`${path}.${key} must be a finite positive integer.`,
				{ detail: { path: `${path}.${key}` } },
			);
		}
		const cap = LIMIT_CAPS[key as keyof RuntimeLimits];
		if (cap !== undefined && value > cap) {
			throw new SpinetabError(
				"unsupported-option",
				`${path}.${key} must not exceed ${cap}.`,
				{ detail: { path: `${path}.${key}`, cap } },
			);
		}
		(result as unknown as Record<string, number>)[key] = value;
	}
	const ordered: Array<[keyof DeliveryLimits, keyof DeliveryLimits]> = [
		["maxPendingMessagesPerConsumer", "maxPendingMessages"],
		["maxPendingBytesPerConsumer", "maxPendingBytes"],
		["maxMessageBytes", "maxPendingBytesPerConsumer"],
	];
	for (const [smaller, larger] of ordered) {
		if (result[smaller] > result[larger]) {
			throw new SpinetabError(
				"unsupported-option",
				`${path}.${smaller} must not exceed ${path}.${larger}.`,
				{ detail: { path: `${path}.${smaller}` } },
			);
		}
	}
	return result;
}

/** Page-side delivery limits may only tighten the runtime's limits. */
export function resolveDeliveryLimits(
	overrides: Partial<DeliveryLimits> | undefined,
	base: Readonly<DeliveryLimits>,
	path = "limits",
): DeliveryLimits {
	const merged = resolveLimits(
		overrides as Partial<RuntimeLimits> | undefined,
		{ ...DEFAULT_LIMITS, ...base },
		path,
	);
	const result: DeliveryLimits = {
		maxPendingMessages: merged.maxPendingMessages,
		maxPendingBytes: merged.maxPendingBytes,
		maxPendingMessagesPerConsumer: merged.maxPendingMessagesPerConsumer,
		maxPendingBytesPerConsumer: merged.maxPendingBytesPerConsumer,
		maxMessageBytes: merged.maxMessageBytes,
	};
	for (const key of DELIVERY_KEYS) {
		if (result[key] > base[key]) result[key] = base[key];
	}
	return result;
}
