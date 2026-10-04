import { afterEach, describe, expect, it } from "vitest";
import { boundOutcome } from "../../../src/core/bounds.ts";
import { SpinetabError } from "../../../src/core/errors.ts";
import { estimateBytes } from "../../../src/core/estimate.ts";
import { createRuntime, type Runtime } from "../../../src/core/runtime.ts";
import type { CommandOutcome, RuntimeLimits } from "../../../src/core/types.ts";
import { ManualClock, settle } from "./helpers/clock.ts";
import { RawPage } from "./helpers/page.ts";
import {
	createTestAdapter,
	type TestAdapterOptions,
} from "./helpers/test-adapter.ts";

// Variable-sized envelope metadata is
// charged in projected admission, cursors are never truncated, and
// application- or adapter-controlled control content (command replies,
// errors, continuity cursors, status codes, diagnostics) is bounded by
// maxMessageBytes with honest outcomes, over real MessageChannels.

const runtimes: Runtime[] = [];
afterEach(() => {
	for (const runtime of runtimes.splice(0)) runtime.dispose();
});

const LIMITS = {
	maxMessageBytes: 128,
	maxPendingBytesPerConsumer: 256,
	maxPendingBytes: 512,
} satisfies Partial<RuntimeLimits>;

async function setup(
	limits: Partial<RuntimeLimits> = LIMITS,
	options: TestAdapterOptions = {},
) {
	const clock = new ManualClock();
	const test = createTestAdapter(options);
	const runtime = createRuntime({
		adapters: [test.adapter],
		clock,
		limits,
		// History opt-in: these tests read `stats().diagnostics`.
		diagnostics: () => undefined,
	});
	runtimes.push(runtime);
	const raw = new RawPage(runtime);
	raw.hello();
	await settle(clock);
	return { clock, test, runtime, raw };
}

async function subscribed(
	limits: Partial<RuntimeLimits> = LIMITS,
	options: TestAdapterOptions = {},
) {
	const context = await setup(limits, options);
	context.raw.subscribe("1", {});
	await settle(context.clock);
	return { ...context, upstream: context.test.last() };
}

describe("event metadata in projected admission", () => {
	it("charges the event cursor with the content, estimated once per event", async () => {
		const { clock, runtime, raw, upstream } = await subscribed({
			maxMessageBytes: 1_024,
			maxPendingBytesPerConsumer: 2_048,
			maxPendingBytes: 4_096,
		});
		const event = { value: 1 };
		const eventId = "cursor-7";
		upstream.emit(event, { eventId });
		await settle(clock);
		expect(raw.events("1")[0]).toMatchObject({ kind: "next", eventId });
		expect(runtime.stats().pendingBytes).toBe(
			(estimateBytes(event) as number) + (estimateBytes(eventId) as number),
		);
	});

	it("never truncates an oversized cursor: the event is message-too-large and not posted", async () => {
		const { clock, runtime, raw, upstream } = await subscribed();
		upstream.emit({ value: 1 }, { eventId: "i".repeat(4_096) });
		await settle(clock);
		expect(raw.data("1")).toEqual([]);
		expect(runtime.stats().pendingBytes).toBe(0);
		expect(raw.continuity("1")[0]?.continuity).toMatchObject({
			state: "gap",
			reason: "message-too-large",
		});
	});

	it("overflows when content fits but content plus cursor crosses the remaining window", async () => {
		const { clock, runtime, raw, upstream } = await subscribed({
			maxMessageBytes: 200,
			maxPendingBytesPerConsumer: 200,
			maxPendingBytes: 400,
		});
		const first = { text: "a".repeat(20) };
		const firstBytes = estimateBytes(first) as number;
		upstream.emit(first);
		await settle(clock);
		// The second event's content alone fits the remaining window; its
		// cursor pushes it over, so projected admission overflows.
		const second = { v: 1 };
		const room = 200 - firstBytes;
		expect(estimateBytes(second) as number).toBeLessThan(room);
		upstream.emit(second, { eventId: "x".repeat(Math.ceil(room / 3)) });
		await settle(clock);
		expect(raw.data("1")).toEqual([first]);
		expect(runtime.stats().pendingBytes).toBe(firstBytes);
		expect(raw.continuity("1")[0]?.continuity.reason).toBe("overflow");
	});
});

describe("control-path content bounded by maxMessageBytes", () => {
	async function commands(outcome: () => Promise<CommandOutcome>) {
		const context = await setup(LIMITS, { command: outcome });
		const send = (id: string) =>
			context.raw.send({
				t: "command",
				id,
				request: {
					adapter: "test",
					connection: { url: "https://x.test" },
					payload: { op: id },
				},
				timeoutMs: 30_000,
			});
		const result = (id: string) =>
			context.raw.ofType("commandResult").find((message) => message.id === id)
				?.outcome;
		return { ...context, send, result };
	}

	it("settles an acknowledged result larger than maxMessageBytes as unknown/limit-exceeded without crossing", async () => {
		const { clock, raw, send, result } = await commands(async () => ({
			status: "acknowledged",
			value: "x".repeat(4_096),
		}));
		send("big");
		await settle(clock);
		expect(result("big")).toMatchObject({
			status: "unknown",
			error: {
				code: "limit-exceeded",
				detail: {
					reason: "limit-exceeded",
					limit: "maxMessageBytes",
					value: 128,
					bytes: 4_096,
					acknowledged: true,
				},
			},
		});
		expect(JSON.stringify(raw.raw)).not.toContain("x".repeat(200));
	});

	it("keeps a small acknowledged result and the status of rejected outcomes with bounded errors", async () => {
		const outcomes: CommandOutcome[] = [
			{ status: "acknowledged", value: { ok: true } },
			{
				status: "rejected",
				error: new SpinetabError("command-rejected", "denied", {
					detail: { why: "d".repeat(4_096) },
				}) as never,
			},
		];
		let index = 0;
		const { clock, send, result } = await commands(
			async () => outcomes[index++] as CommandOutcome,
		);
		send("small");
		await settle(clock);
		send("rejected");
		await settle(clock);
		expect(result("small")).toEqual({
			status: "acknowledged",
			value: { ok: true },
		});
		const rejected = result("rejected");
		expect(rejected).toMatchObject({
			status: "rejected",
			error: {
				code: "command-rejected",
				detail: { reason: "limit-exceeded", limit: "maxMessageBytes" },
			},
		});
		expect(JSON.stringify(rejected)).not.toContain("ddd");
	});

	it("bounds an adapter's terminal error but keeps its code, for every consumer", async () => {
		const { clock, raw, upstream } = await subscribed();
		upstream.sink.error({
			code: "protocol-error",
			message: "m".repeat(2_048),
			detail: { frames: "f".repeat(2_048) },
		});
		await settle(clock);
		const terminal = raw.events("1").find((event) => event.kind === "error");
		expect(terminal).toMatchObject({
			kind: "error",
			error: {
				code: "protocol-error",
				detail: { reason: "limit-exceeded", limit: "maxMessageBytes" },
			},
		});
		expect(JSON.stringify(terminal)).not.toContain("mmm");
		expect(JSON.stringify(terminal)).not.toContain("fff");
	});

	it("keeps small adapter errors unchanged", async () => {
		const { clock, raw, upstream } = await subscribed();
		upstream.sink.error({ code: "protocol-error", message: "bad frame" });
		await settle(clock);
		expect(
			raw.events("1").find((event) => event.kind === "error"),
		).toMatchObject({
			error: { code: "protocol-error", message: "bad frame" },
		});
	});

	it("omits (never truncates) an oversized continuity cursor and keeps a small one", async () => {
		const { clock, raw, upstream } = await subscribed();
		upstream.sink.continuity("resumed-with-cursor", { cursor: "c-1" });
		await settle(clock);
		upstream.sink.continuity("resumed-with-cursor", {
			cursor: "c".repeat(4_096),
		});
		await settle(clock);
		const notices = raw.continuity("1").map((message) => message.continuity);
		expect(notices[0]).toMatchObject({ state: "resumed", cursor: "c-1" });
		expect(notices[1]).toMatchObject({
			state: "resumed",
			reason: "resumed-with-cursor",
		});
		expect(notices[1]).not.toHaveProperty("cursor");
	});

	it("omits an oversized adapter status code, including from the subscribe snapshot", async () => {
		const { clock, raw, test } = await subscribed();
		const ctx = test.connections[0]?.ctx;
		ctx?.setStatus({ state: "reconnecting", code: "z".repeat(4_096) });
		await settle(clock);
		raw.subscribe("2", {});
		await settle(clock);
		const statuses = raw.ofType("status").slice(-2);
		for (const status of statuses) {
			expect(status.connection.state).toBe("reconnecting");
			expect(status.connection).not.toHaveProperty("code");
		}
		ctx?.setStatus({ state: "reconnecting", code: 4_001 });
		await settle(clock);
		expect(raw.ofType("status").at(-1)?.connection.code).toBe(4_001);
	});

	it("replaces an oversized or uncloneable adapter diagnostic with a fixed marker", async () => {
		const { clock, runtime, test } = await subscribed();
		const ctx = test.connections[0]?.ctx;
		ctx?.diagnostic({
			type: "adapter-note",
			detail: { text: "n".repeat(4_096) },
		});
		ctx?.diagnostic({ type: "adapter-small", detail: { ok: true } });
		await settle(clock);
		const types = runtime.stats().diagnostics.map((event) => event.type);
		expect(types).toContain("diagnostic-omitted");
		expect(types).toContain("adapter-small");
		expect(JSON.stringify(runtime.stats().diagnostics)).not.toContain("nnn");
	});
});

describe("boundOutcome", () => {
	it("reports a result the estimator cannot size like a DataCloneError", () => {
		class Opaque {
			readonly size = 1;
		}
		expect(
			boundOutcome({ status: "acknowledged", value: new Opaque() }, 1_024),
		).toMatchObject({
			status: "unknown",
			error: {
				code: "command-unknown",
				detail: { reason: "not-serialisable", acknowledged: true },
			},
		});
		expect(boundOutcome({ status: "sent" }, 1)).toEqual({ status: "sent" });
	});
});
