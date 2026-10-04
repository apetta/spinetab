import { afterEach, describe, expect, it } from "vitest";
import { SpinetabError } from "../../../src/core/errors.ts";
import { createRuntime, type Runtime } from "../../../src/core/runtime.ts";
import type { CommandOutcome, RuntimeLimits } from "../../../src/core/types.ts";
import { ManualClock, settle } from "./helpers/clock.ts";
import { RawPage } from "./helpers/page.ts";
import {
	createTestAdapter,
	type TestAdapterOptions,
} from "./helpers/test-adapter.ts";

// Runtime behaviour under lifecycle and message-order changes.

const runtimes: Runtime[] = [];
afterEach(() => {
	for (const runtime of runtimes.splice(0)) runtime.dispose();
});

async function setup(
	command: TestAdapterOptions["command"],
	limits: Partial<RuntimeLimits> = {},
) {
	const clock = new ManualClock();
	const test = createTestAdapter({
		...(command ? { command } : {}),
		idleCloseMs: 1_000,
	});
	const runtime = createRuntime({ adapters: [test.adapter], clock, limits });
	runtimes.push(runtime);
	const raw = new RawPage(runtime);
	raw.hello();
	await settle(clock);
	const send = (
		id: string,
		payload: unknown = { op: id },
		timeoutMs = 30_000,
	) =>
		raw.send({
			t: "command",
			id,
			request: {
				adapter: "test",
				connection: { url: "https://x.test" },
				payload,
			},
			timeoutMs,
		});
	const result = (id: string) =>
		raw.ofType("commandResult").find((message) => message.id === id)?.outcome;
	return { clock, test, runtime, raw, send, result };
}

describe("runtime commands", () => {
	it("reports acknowledged, rejected and sent outcomes, one upstream action per call", async () => {
		const outcomes: CommandOutcome[] = [
			{ status: "acknowledged", value: { ok: true } },
			{
				status: "rejected",
				error: new SpinetabError("command-rejected", "denied", {
					detail: { why: "policy" },
				}) as never,
			},
			{ status: "sent" },
		];
		let index = 0;
		const { clock, test, send, result } = await setup(
			async () => outcomes[index++] as CommandOutcome,
		);
		send("a", { same: 1 });
		send("b", { same: 1 });
		send("c", { same: 1 });
		await settle(clock);
		expect(test.connections[0]?.commands).toHaveLength(3);
		expect(result("a")).toEqual({
			status: "acknowledged",
			value: { ok: true },
		});
		expect(result("b")).toEqual({
			status: "rejected",
			error: {
				code: "command-rejected",
				message: "denied",
				detail: { why: "policy" },
			},
		});
		expect(result("c")).toEqual({ status: "sent" });
	});

	it("settles not-sent when the adapter has no commands, the adapter is unknown or it throws synchronously", async () => {
		const { clock, raw, send, result } = await setup(undefined);
		send("a");
		raw.send({
			t: "command",
			id: "b",
			request: { adapter: "nope", connection: {}, payload: 1 },
			timeoutMs: 100,
		});
		await settle(clock);
		expect(result("a")).toMatchObject({
			status: "not-sent",
			error: { code: "command-not-sent" },
		});
		expect(result("b")).toMatchObject({
			status: "not-sent",
			error: { code: "adapter-not-registered" },
		});
		const thrower = await setup(() => {
			throw new SpinetabError("command-not-sent", "socket not open");
		});
		thrower.send("x");
		await settle(thrower.clock);
		expect(thrower.result("x")).toMatchObject({
			status: "not-sent",
			error: { code: "command-not-sent", message: "socket not open" },
		});
	});

	it("bounds pending commands per attachment with an immediate limit-exceeded", async () => {
		const { clock, send, result } = await setup(() => new Promise(() => {}), {
			maxPendingCommands: 2,
		});
		send("a");
		send("b");
		send("c");
		await settle(clock);
		expect(result("a")).toBeUndefined();
		expect(result("c")).toMatchObject({
			status: "not-sent",
			error: { code: "limit-exceeded" },
		});
	});

	it("times out as unknown, aborts the adapter signal and never resends", async () => {
		const { clock, test, send, result, runtime } = await setup(
			() => new Promise(() => {}),
		);
		send("slow", {}, 2_000);
		await settle(clock);
		clock.advance(1_999);
		expect(result("slow")).toBeUndefined();
		clock.advance(1);
		await settle(clock);
		expect(result("slow")).toMatchObject({
			status: "unknown",
			error: { code: "command-unknown", detail: { reason: "timeout" } },
		});
		expect(test.connections[0]?.commands[0]?.signal.aborted).toBe(true);
		expect(test.connections[0]?.commands).toHaveLength(1);
		expect(runtime.stats().pendingCommands).toBe(0);
	});

	it("maps an adapter rejection to unknown and an invalid outcome to unknown", async () => {
		let call = 0;
		const { clock, send, result } = await setup(async () => {
			call += 1;
			if (call === 1) throw new Error("socket closed before ack");
			return { status: "weird" } as never;
		});
		send("a");
		send("b");
		await settle(clock);
		expect(result("a")).toMatchObject({
			status: "unknown",
			error: { code: "command-unknown" },
		});
		expect(result("b")).toMatchObject({
			status: "unknown",
			error: { code: "command-unknown" },
		});
	});

	it("cancel aborts the adapter command and posts nothing further", async () => {
		const { clock, test, raw, send, result } = await setup(
			() => new Promise(() => {}),
		);
		send("a");
		await settle(clock);
		raw.send({ t: "cancel", id: "a" });
		await settle(clock);
		expect(test.connections[0]?.commands[0]?.signal.aborted).toBe(true);
		expect(result("a")).toBeUndefined();
	});

	it("keeps the connection open while a command is pending, then idles it", async () => {
		let resolve: (outcome: CommandOutcome) => void = () => {};
		const { clock, test, send } = await setup(
			() =>
				new Promise((done) => {
					resolve = done;
				}),
		);
		send("a");
		await settle(clock);
		clock.advance(5_000);
		expect(test.connections[0]?.disposed).toBe(false);
		resolve({ status: "sent" });
		await settle(clock);
		clock.advance(1_000);
		expect(test.connections[0]?.disposed).toBe(true);
	});

	it("aborts a retired attachment's pending commands", async () => {
		const { clock, test, raw, send } = await setup(() => new Promise(() => {}));
		send("a");
		await settle(clock);
		raw.send({ t: "detach" });
		await settle(clock);
		expect(test.connections[0]?.commands[0]?.signal.aborted).toBe(true);
	});

	it("reports an uncloneable acknowledged value as unknown rather than dropping it silently", async () => {
		const { clock, send, result } = await setup(async () => ({
			status: "acknowledged",
			value: { fn() {} },
		}));
		send("a");
		await settle(clock);
		expect(result("a")).toMatchObject({
			status: "unknown",
			error: { detail: { reason: "not-serialisable" } },
		});
	});
});

// Regression coverage for clock, credential and lifecycle boundaries.
// command's timeoutMs crosses the bridge from any page, so the runtime clamps
// it to MAX_TIMER_MS (2^31 - 1) before arming a timer or telling the adapter.
describe("C1-F4 a command timeout above MAX_TIMER_MS", () => {
	const MAX = 2_147_483_647;

	class RecordingClock extends ManualClock {
		readonly delays: number[] = [];
		override setTimeout(callback: () => void, ms: number): unknown {
			this.delays.push(ms);
			return super.setTimeout(callback, ms);
		}
	}

	it("C1-F4 is clamped: the adapter sees MAX_TIMER_MS and no runtime timer exceeds it", async () => {
		const clock = new RecordingClock();
		const seen: number[] = [];
		const test = createTestAdapter({
			command: (_payload, options) => {
				seen.push(options.timeoutMs);
				return new Promise(() => {});
			},
		});
		const runtime = createRuntime({ adapters: [test.adapter], clock });
		runtimes.push(runtime);
		const raw = new RawPage(runtime);
		raw.hello();
		await settle(clock);
		raw.send({
			t: "command",
			id: "big",
			timeoutMs: 2 ** 31,
			request: {
				adapter: "test",
				connection: { url: "https://x.test" },
				payload: {},
			},
		});
		await settle(clock);
		expect(seen).toEqual([MAX]);
		expect(Math.max(...clock.delays)).toBeLessThanOrEqual(MAX);
		expect(raw.ofType("commandResult")).toHaveLength(0);
	});

	it("C1-F4 with the system clock it is not settled unknown/timeout and aborted at once", async () => {
		const wait = (ms: number) =>
			new Promise((resolve) => globalThis.setTimeout(resolve, ms));
		const test = createTestAdapter({ command: () => new Promise(() => {}) });
		const runtime = createRuntime({ adapters: [test.adapter] });
		runtimes.push(runtime);
		const raw = new RawPage(runtime);
		raw.hello();
		await wait(5);
		raw.send({
			t: "command",
			id: "cmd-1",
			timeoutMs: 2 ** 31,
			request: {
				adapter: "test",
				connection: { url: "https://example.test/feed" },
				payload: { op: 1 },
			},
		});
		await wait(40);
		expect(raw.ofType("commandResult")).toHaveLength(0);
		expect(test.connections[0]?.commands[0]?.signal.aborted).toBe(false);
	});
});
