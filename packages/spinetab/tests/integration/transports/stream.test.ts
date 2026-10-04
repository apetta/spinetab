import { randomUUID } from "node:crypto";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	inject,
	it,
	vi,
} from "vitest";
import type { AdapterConnection } from "../../../src/core/adapter.ts";
import {
	ndjsonParser,
	type StreamConnectionSpec,
	type StreamSubscriptionSpec,
	streamAdapter,
} from "../../../src/transports/stream/runtime.ts";
import {
	fakeContext,
	recordingSink,
	waitFor,
} from "../../unit/transports/helpers.ts";

// NT-I-13…17: the stream adapter against the real `stream` fixture over
// Node's fetch. Counters are run-scoped.

const [origin] = inject("fixtureOrigins");

interface StreamCounters {
	requests: Record<string, number>;
	starts: number;
	active: number;
	aborts: number;
	completed: number;
}

async function counters(run: string): Promise<StreamCounters> {
	return (await (
		await fetch(`${origin}/stream/counters?run=${run}`)
	).json()) as StreamCounters;
}

type Conn = AdapterConnection<StreamSubscriptionSpec, unknown>;
const open: Conn[] = [];

const parsers = {
	ndjson: ndjsonParser(),
	"ndjson-heartbeat": ndjsonParser({
		heartbeat: (value) =>
			typeof value === "object" &&
			value !== null &&
			!Array.isArray(value) &&
			value.type === "heartbeat",
	}),
};

function connect(query: string, spec: Partial<StreamConnectionSpec> = {}) {
	const run = randomUUID();
	const adapter = streamAdapter({ parsers });
	const connection: StreamConnectionSpec = {
		url: `${origin}/stream/ndjson?run=${run}&${query}`,
		parser: "ndjson",
		...spec,
	};
	adapter.validateConnection?.(connection);
	const fake = fakeContext();
	const conn = adapter.connect(connection, fake.ctx);
	open.push(conn);
	const record = recordingSink();
	const sub = conn.subscribe({}, record.sink, {
		key: "s",
		repeatable: connection.repeatable === true,
	});
	return { run, conn, fake, record, sub };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const expected = (count: number) =>
	Array.from({ length: count }, (_, index) => ({
		n: index + 1,
		text: "héllo 🌍 ✓",
	}));

beforeEach(() => {
	vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
	for (const conn of open.splice(0)) conn.dispose();
	vi.restoreAllMocks();
});

describe("stream adapter against the stream fixture", () => {
	it("settles an interrupted POST under the default policy as interrupted; one start only (NT-I-13)", async () => {
		const { run, record } = connect("fault=terminate-mid-frame&count=4", {
			method: "POST",
			body: '{"prompt":"x"}',
		});
		await waitFor(() => record.errors.length === 1);
		expect(record.errors[0]?.code).toBe("interrupted");
		expect(record.events).toEqual(expected(1));
		await sleep(300);
		const server = await counters(run);
		expect(server.starts).toBe(1);
		expect(server.requests).toEqual({ POST: 1 });
	});

	it("restarts an explicitly repeatable read and reports reconnected (NT-I-13)", async () => {
		const { run, record } = connect("terminateFirst=1&count=3&rate=5", {
			repeatable: true,
		});
		await waitFor(() => record.completed === 1);
		// The early notice at detection, then the outcome.
		expect(record.continuity).toEqual([
			{ reason: "reconnected" },
			{ reason: "reconnected" },
		]);
		// First response: frame 1, then a cut mid-frame (never delivered). The
		// restart reads the whole body again: no catch-up is claimed.
		expect(record.events).toEqual([...expected(1), ...expected(3)]);
		const server = await counters(run);
		expect(server.requests).toEqual({ GET: 2 });
		expect(server.completed).toBe(1);
	});

	it("delivers identical frames for 1-byte and coalesced bodies (NT-I-14)", async () => {
		const oneByte = connect("count=6&split=1");
		const whole = connect("count=6");
		await waitFor(
			() => oneByte.record.completed === 1 && whole.record.completed === 1,
		);
		expect(whole.record.events).toEqual(expected(6));
		expect(oneByte.record.events).toEqual(whole.record.events);
		const threeByte = connect("count=6&split=3");
		await waitFor(() => threeByte.record.completed === 1);
		expect(threeByte.record.events).toEqual(expected(6));
	});

	it("accepts a final line without a trailing newline at clean end", async () => {
		const { record } = connect("count=3&fault=no-trailing-newline");
		await waitFor(() => record.completed === 1);
		expect(record.events).toEqual(expected(3));
	});

	it("fails an oversized frame with frame-too-large and never loops (NT-I-15)", async () => {
		const { run, record, fake } = connect("fault=oversized&size=300000", {
			repeatable: true,
		});
		await waitFor(() => record.errors.length === 1);
		expect(record.errors[0]?.code).toBe("frame-too-large");
		expect(record.events).toEqual(expected(1));
		expect(fake.last()).toMatchObject({
			state: "failed",
			code: "frame-too-large",
		});
		await waitFor(async () => (await counters(run)).aborts === 1);
		await sleep(300);
		expect((await counters(run)).requests).toEqual({ GET: 1 });
	});

	it("fails on malformed input by default and skips it with a gap when asked (NT-I-15)", async () => {
		const strict = connect("fault=malformed&count=4", { repeatable: true });
		await waitFor(() => strict.record.errors.length === 1);
		expect(strict.record.errors[0]?.code).toBe("malformed-frame");
		expect(strict.record.events).toEqual(expected(1));

		const lenient = connect("fault=malformed&count=4", {
			repeatable: true,
			malformed: "skip",
		});
		await waitFor(() => lenient.record.completed === 1);
		expect(
			lenient.record.events.map((event) => (event as { n: number }).n),
		).toEqual([1, 3, 4]);
		expect(lenient.record.continuity).toEqual([{ reason: "decode-error" }]);
	});

	it("aborts the request when the last consumer leaves (NT-I-16)", async () => {
		const { run, record, sub } = connect("fault=stall&count=5", {
			repeatable: true,
		});
		await waitFor(() => record.events.length === 1);
		await waitFor(async () => (await counters(run)).active === 1);
		sub.unsubscribe();
		await waitFor(async () => (await counters(run)).active === 0);
		const server = await counters(run);
		expect(server.aborts).toBe(1);
		expect(server.completed).toBe(0);
		expect(record.errors).toEqual([]);
	});

	it("reconnects a silent repeatable stream once per detection; heartbeat lines keep it alive (NT-I-17)", async () => {
		const silent = connect("fault=stall&count=5", {
			repeatable: true,
			heartbeat: { expectInboundWithinMs: 200 },
		});
		await waitFor(
			async () => (await counters(silent.run)).requests.GET === 2,
			3_000,
		);
		expect(silent.fake.statuses).toContainEqual(
			expect.objectContaining({
				state: "reconnecting",
				reason: "heartbeat-timeout",
			}),
		);

		const beating = connect("fault=stall&count=5&heartbeatMs=50", {
			repeatable: true,
			parser: "ndjson-heartbeat",
			heartbeat: { expectInboundWithinMs: 300 },
		});
		await sleep(900);
		expect((await counters(beating.run)).requests).toEqual({ GET: 1 });
		expect(beating.record.events).toEqual(expected(1));
	});

	it("settles a silent non-repeatable stream as interrupted without restarting it (NT-I-17)", async () => {
		const { run, record } = connect("fault=stall&count=5", {
			method: "POST",
			body: "{}",
			heartbeat: { expectInboundWithinMs: 200 },
		});
		await waitFor(() => record.errors.length === 1);
		expect(record.errors[0]?.code).toBe("interrupted");
		await sleep(300);
		expect((await counters(run)).starts).toBe(1);
	});

	it("surfaces HTTP status before parsing", async () => {
		const missing = connect("status=404", { repeatable: true });
		await waitFor(() => missing.fake.last()?.state === "failed");
		expect(missing.fake.last()).toEqual({
			state: "failed",
			reason: "permanent-error",
			code: 404,
		});
		expect(missing.record.events).toEqual([]);
		const empty = connect("status=204", { repeatable: true });
		await waitFor(() => empty.record.completed === 1);
	});
});
