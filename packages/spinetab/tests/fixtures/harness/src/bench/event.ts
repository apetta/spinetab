/**
 * Reference workload event. Shared by the fixture
 * generator (`tests/fixtures/servers/bench.ts`, Node) and the bench pages
 * (browser). Erasable TypeScript with no imports, so plain `node` and Vite can
 * both load it.
 *
 * Every event serialises to exactly `size` bytes of ASCII JSON (default
 * 1 KiB): `{ topic, seq, emittedAt, body }` with `body` padded after the other
 * fields are known, because `emittedAt` has a variable number of digits.
 */

/** Topics in the reference workload. */
export const TOPICS = 100;
/** Serialised event size in bytes. */
export const EVENT_BYTES = 1024;
/** Aggregate logical events per second. */
export const RATE_HZ = 100;
/** Timestamp ring slots per topic (1 Hz per topic: ~34 min before reuse). */
export const RING = 2048;
/** Highest topic index a page tracks (limits scenario subscribes 0…999, plus one). */
export const MAX_TOPICS = 1024;
/** BroadcastChannel shared by the bench pages and the bench runtime realm. */
export const CHANNEL = "spinetab-bench";

export interface BenchEvent {
	topic: number;
	seq: number;
	/** Fixture clock: Node `performance.timeOrigin + performance.now()`. */
	emittedAt: number;
	body: string;
}

const FILL = "abcdefghijklmnopqrstuvwxyz0123456789";
let padCache = "";

function pad(length: number): string {
	if (length <= 0) return "";
	if (padCache.length < length) {
		padCache = FILL.repeat(Math.ceil(length / FILL.length));
	}
	return padCache.slice(0, length);
}

/** Marker text seeded into bodies for the privacy scan; ASCII word characters and `-` only. */
export function isMarker(value: string): boolean {
	return /^[A-Za-z0-9-]*$/.test(value);
}

/**
 * Build one event whose JSON form is exactly `size` bytes. When `size` is
 * smaller than the fixed fields plus the marker, the event is as small as
 * possible and larger than `size`.
 */
export function makeEvent(
	topic: number,
	seq: number,
	emittedAt: number,
	size: number = EVENT_BYTES,
	marker = "",
): BenchEvent {
	if (!Number.isInteger(topic) || topic < 0) {
		throw new RangeError(`topic must be a non-negative integer: ${topic}`);
	}
	if (!Number.isInteger(seq) || seq < 0) {
		throw new RangeError(`seq must be a non-negative integer: ${seq}`);
	}
	if (!Number.isFinite(emittedAt)) {
		throw new RangeError("emittedAt must be finite");
	}
	if (!isMarker(marker)) {
		throw new RangeError("marker must be ASCII letters, digits or '-'");
	}
	// Same key order and number formatting as JSON.stringify(event).
	const fixed = `{"topic":${topic},"seq":${seq},"emittedAt":${JSON.stringify(emittedAt)},"body":""}`;
	const room = size - fixed.length - marker.length;
	return { topic, seq, emittedAt, body: marker + pad(room) };
}

/** UTF-8 length of the event's JSON form (ASCII, so string length). */
export function serialisedBytes(event: BenchEvent): number {
	return JSON.stringify(event).length;
}

export interface EventKey {
	topic: number;
	seq: number;
	emittedAt: number;
}

/**
 * Topic, seq and emit time from a delivered value: the native frame is the
 * event itself; graphql-ws delivers `{ data: { feed: event } }`.
 */
export function readEvent(value: unknown): EventKey | undefined {
	let candidate: unknown = value;
	if (
		typeof value === "object" &&
		value !== null &&
		"data" in value &&
		typeof (value as { data?: unknown }).data === "object"
	) {
		candidate = (value as { data?: { feed?: unknown } | null }).data?.feed;
	}
	if (typeof candidate !== "object" || candidate === null) return undefined;
	const { topic, seq, emittedAt } = candidate as Partial<EventKey>;
	if (
		typeof topic !== "number" ||
		typeof seq !== "number" ||
		typeof emittedAt !== "number"
	) {
		return undefined;
	}
	return { topic, seq, emittedAt };
}

/** GraphQL document for one topic (graphql-ws variant). */
export const FEED_QUERY =
	"subscription Feed($topic: Int!) { feed(topic: $topic) { topic seq emittedAt body } }";
