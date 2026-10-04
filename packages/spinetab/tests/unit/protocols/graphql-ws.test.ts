import { CloseCode } from "graphql-ws/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterConnection } from "../../../src/core/adapter.ts";
import {
	classifyGraphqlWsClose,
	type GraphqlPayload,
	type GraphqlWsAdapterOptions,
	graphqlWsAdapter,
} from "../../../src/protocols/graphql-ws/runtime.ts";
import type { GraphqlWsConnection } from "../../../src/protocols/graphql-ws/spec.ts";
import {
	createRecordingSink,
	createTestContext,
	type TestContext,
} from "../../integration/protocols/helpers.ts";
import { FakeWebSocket } from "./fakes.ts";

// The real graphql-ws 6.3.0 client over a scripted WebSocket, with
// fake timers..

const QUERY = "subscription { ticks { n } }";
const flush = () => vi.advanceTimersByTimeAsync(0);

let connections: AdapterConnection[] = [];

beforeEach(() => {
	vi.useFakeTimers();
	FakeWebSocket.reset();
});
afterEach(() => {
	for (const connection of connections) connection.dispose();
	connections = [];
	vi.useRealTimers();
});

function setup(
	spec: Partial<GraphqlWsConnection> = {},
	options: {
		adapter?: GraphqlWsAdapterOptions;
		credentials?: false;
		/** Executable-time clock; defaults to the fake wall clock. */
		now?: () => number;
	} = {},
) {
	const adapter = graphqlWsAdapter({
		webSocketImpl: FakeWebSocket,
		retryWait: async () => {},
		...options.adapter,
	});
	const test: TestContext = createTestContext({
		scope: "s",
		now: options.now ?? (() => Date.now()),
		limits: { idleCloseMs: 50 },
		...(options.credentials === false
			? {}
			: {
					credentials: (revision) => ({
						connectionParams: { token: `t${revision}` },
					}),
				}),
	});
	const connection = adapter.connect(
		{
			url: "wss://api.test/graphql",
			connectionParams: { client: "web" },
			...spec,
		},
		test.ctx,
	);
	connections.push(connection);
	const subscribe = (repeatable = true) => {
		const recording = createRecordingSink<unknown>();
		const subscription = connection.subscribe(
			{ query: QUERY },
			recording.sink,
			{
				key: "k",
				repeatable,
			},
		);
		return { recording, subscription };
	};
	return { connection, test, subscribe };
}

async function connected(setupResult: ReturnType<typeof setup>) {
	const feed = setupResult.subscribe();
	await flush();
	const socket = FakeWebSocket.last();
	socket.accept();
	await flush();
	return { feed, socket };
}

describe("graphql-ws client configuration", () => {
	it("is lazy: no socket before the first subscribe, credentials resolved before opening", async () => {
		const context = setup();
		await flush();
		expect(FakeWebSocket.instances).toHaveLength(0);
		const { socket } = await connected(context);
		expect(FakeWebSocket.instances).toHaveLength(1);
		expect(socket.protocol).toBe("graphql-transport-ws");
		expect(socket.sent[0]).toEqual({
			type: "connection_init",
			payload: { client: "web", token: "t1" },
		});
		expect(context.test.requests).toEqual(["connect"]);
		expect(context.test.statuses.map((status) => status.state)).toEqual([
			"connecting",
			"connected",
		]);
	});

	it("opens no socket and reports auth-blocked without a credential source", async () => {
		const context = setup({}, { credentials: false });
		context.subscribe();
		await flush();
		expect(FakeWebSocket.instances).toHaveLength(0);
		expect(context.test.lastStatus()).toMatchObject({
			state: "auth-blocked",
			reason: "no-credential-source",
		});
		expect(context.test.rejections).toEqual([]);
	});

	it("an anonymous endpoint connects without requesting credentials", async () => {
		const context = setup(
			{ anonymous: true, connectionParams: undefined },
			{ credentials: false },
		);
		const { socket } = await connected(context);
		expect(socket.sent[0]).toEqual({ type: "connection_init" });
		expect(context.test.requests).toEqual([]);
	});

	it("bounds the acknowledgement wait: 4504 is retried by the upstream loop", async () => {
		const context = setup({
			connectionAckWaitTimeoutMs: 100,
			retryAttempts: 1,
		});
		context.subscribe();
		await flush();
		FakeWebSocket.last().open();
		await vi.advanceTimersByTimeAsync(100);
		expect(FakeWebSocket.instances[0]?.closedWith?.code).toBe(4504);
		await flush();
		expect(context.test.statuses[1]).toMatchObject({
			state: "reconnecting",
			code: "close:4504",
		});
		expect(FakeWebSocket.instances).toHaveLength(2);
	});
});

describe("close classification from the installed CloseCode enum", () => {
	it("classifies by code", () => {
		expect(classifyGraphqlWsClose(CloseCode.Unauthorized)).toBe("auth");
		// 4403 is forbidden, never a credential rejection.
		expect(classifyGraphqlWsClose(CloseCode.Forbidden)).toBe("forbidden");
		for (const code of [
			CloseCode.BadRequest,
			CloseCode.BadResponse,
			CloseCode.InternalClientError,
			CloseCode.SubprotocolNotAcceptable,
			CloseCode.SubscriberAlreadyExists,
			CloseCode.TooManyInitialisationRequests,
			CloseCode.InternalServerError,
			4418,
			1002,
		]) {
			expect(classifyGraphqlWsClose(code), String(code)).toBe("terminal");
		}
		for (const code of [
			CloseCode.ConnectionInitialisationTimeout,
			CloseCode.ConnectionAcknowledgementTimeout,
			4499,
			1000,
			1001,
			1006,
			1012,
			4000,
			4600,
		]) {
			expect(classifyGraphqlWsClose(code), String(code)).toBe("retry");
		}
	});

	for (const code of [4400, 4004, 4005, 4406, 4409, 4429, 4500, 4418]) {
		it(`${code} → failed/protocol-error with no retry`, async () => {
			const context = setup();
			const { feed, socket } = await connected(context);
			socket.serverClose(code, "x");
			await vi.advanceTimersByTimeAsync(50);
			expect(FakeWebSocket.instances).toHaveLength(1);
			expect(context.test.lastStatus()).toMatchObject({
				state: "failed",
				reason: "protocol-error",
				code: `close:${code}`,
			});
			expect(feed.recording.errors).toEqual([]);
			expect(feed.recording.completions).toBe(0);
		});
	}

	// Only 4401 rejects; 4403 is covered in credential-security.test.ts.
	for (const code of [4401]) {
		it(`${code} → auth-blocked, the revision rejected once, no retry`, async () => {
			const context = setup();
			await connected(context);
			FakeWebSocket.last().serverClose(code);
			await vi.advanceTimersByTimeAsync(50);
			expect(FakeWebSocket.instances).toHaveLength(1);
			expect(context.test.lastStatus()).toMatchObject({
				state: "auth-blocked",
				code: `close:${code}`,
			});
			expect(context.test.rejections).toEqual([1]);
			// Explicit retry with the rejected revision makes no attempt.
			context.connection.retry?.();
			await flush();
			expect(FakeWebSocket.instances).toHaveLength(1);
			// A new revision resumes with exactly one attempt.
			context.test.setRevision(2);
			context.connection.rotate?.();
			await flush();
			expect(FakeWebSocket.instances).toHaveLength(2);
			FakeWebSocket.last().accept();
			await flush();
			expect(FakeWebSocket.last().sent[0]).toMatchObject({
				payload: { token: "t2" },
			});
			expect(FakeWebSocket.last().subscribeIds()).toHaveLength(1);
		});
	}

	for (const code of [4408, 4499, 1006, 4000]) {
		it(`${code} → retried by the upstream loop, resubscribed once, continuity reconnected`, async () => {
			const context = setup();
			const { feed } = await connected(context);
			FakeWebSocket.last().serverClose(code);
			await flush();
			expect(FakeWebSocket.instances).toHaveLength(2);
			FakeWebSocket.last().accept();
			await flush();
			expect(FakeWebSocket.last().subscribeIds()).toHaveLength(1);
			// Once at detection, then the reconnect outcome.
			expect(feed.recording.continuity).toEqual([
				{ reason: "reconnected" },
				{ reason: "reconnected" },
			]);
			expect(context.test.requests).toEqual(["connect", "reconnect"]);
		});
	}

	it("retries a WebSocket error event (network) although upstream treats it as fatal by default", async () => {
		const context = setup();
		await connected(context);
		FakeWebSocket.last().networkError();
		await flush();
		expect(FakeWebSocket.instances).toHaveLength(2);
	});

	it("an application classifier can only make closes more terminal", async () => {
		const context = setup(
			{},
			{
				adapter: {
					classifyClose: (code) => (code === 4000 ? "auth" : undefined),
				},
			},
		);
		await connected(context);
		FakeWebSocket.last().serverClose(4000);
		await flush();
		expect(context.test.lastStatus()).toMatchObject({ state: "auth-blocked" });
		expect(FakeWebSocket.instances).toHaveLength(1);
	});

	it("exhaustion keeps intent; retry() recreates the client and resubscribes once", async () => {
		const context = setup({ retryAttempts: 1 });
		const { feed } = await connected(context);
		FakeWebSocket.last().serverClose(1006);
		await flush();
		FakeWebSocket.last().serverClose(1006);
		await flush();
		expect(context.test.lastStatus()).toMatchObject({
			state: "retry-exhausted",
			reason: "attempts-exhausted",
			code: "close:1006",
		});
		expect(feed.recording.errors).toEqual([]);
		expect(FakeWebSocket.instances).toHaveLength(2);
		context.connection.retry?.();
		await flush();
		expect(FakeWebSocket.instances).toHaveLength(3);
		FakeWebSocket.last().accept();
		await flush();
		expect(FakeWebSocket.last().subscribeIds()).toHaveLength(1);
		expect(context.test.requests.at(-1)).toBe("retry");
		// Once at detection, then the outcome when retry() restores delivery.
		expect(feed.recording.continuity).toEqual([
			{ reason: "reconnected" },
			{ reason: "reconnected" },
		]);
	});
});

describe("missing-pong watchdog", () => {
	it("terminates after the pong deadline and the upstream loop reconnects", async () => {
		const context = setup({ keepAliveMs: 1_000, pongTimeoutMs: 500 });
		await connected(context);
		const first = FakeWebSocket.last();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(first.sent.some((message) => message.type === "ping")).toBe(true);
		await vi.advanceTimersByTimeAsync(499);
		expect(FakeWebSocket.instances).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(first.closedWith?.code).toBe(4499);
		expect(
			context.test.hasStatus("reconnecting", { reason: "heartbeat-timeout" }),
		).toBe(true);
		await flush();
		expect(FakeWebSocket.instances).toHaveLength(2);
	});

	it("an answered ping keeps a quiet feed connected", async () => {
		const context = setup({ keepAliveMs: 1_000, pongTimeoutMs: 500 });
		await connected(context);
		const socket = FakeWebSocket.last();
		for (let round = 0; round < 3; round += 1) {
			await vi.advanceTimersByTimeAsync(1_000);
			socket.receive({ type: "pong" });
		}
		await vi.advanceTimersByTimeAsync(400);
		expect(FakeWebSocket.instances).toHaveLength(1);
		expect(context.test.hasStatus("reconnecting")).toBe(false);
	});

	it("probe() sends a resume-time ping with the same deadline", async () => {
		const context = setup({ keepAliveMs: 60_000, pongTimeoutMs: 500 });
		await connected(context);
		context.connection.probe?.();
		expect(FakeWebSocket.last().sent.at(-1)).toEqual({ type: "ping" });
		await vi.advanceTimersByTimeAsync(500);
		expect(FakeWebSocket.instances[0]?.closedWith?.code).toBe(4499);
	});
});

// A later ping must not reset an outstanding pong deadline.
describe("missing-pong deadline preservation", () => {
	const TIMEOUT = 10_000;
	const HINT = 5_001;
	const TERMINATED = { code: 4499, reason: "Terminated" };

	const pings = (socket: FakeWebSocket) =>
		socket.sent.filter((message) => message.type === "ping").length;
	const pongTimeouts = (context: ReturnType<typeof setup>) =>
		context.test.diagnostics.filter(
			(event) => event.type === "graphql-ws.pong-timeout",
		).length;
	/** The watchdog's own status; the upstream close/retry ones carry code or attempt. */
	const watchdogStatuses = (context: ReturnType<typeof setup>) =>
		context.test.statuses.filter(
			(status) =>
				status.state === "reconnecting" &&
				status.reason === "heartbeat-timeout" &&
				!("code" in status) &&
				!("attempt" in status),
		).length;

	/**
	 * A server acknowledges only after `connection_init`, which upstream sends
	 * from its asynchronous open handler. A synchronous acknowledgement would
	 * arrive before the client is ready and cause an acknowledgement timeout.
	 */
	async function handshake(socket: FakeWebSocket) {
		socket.open();
		await flush();
		expect(socket.sent[0]).toMatchObject({ type: "connection_init" });
		socket.ack();
		await flush();
		return socket;
	}
	async function established(context: ReturnType<typeof setup>) {
		context.subscribe();
		await flush();
		return { socket: await handshake(FakeWebSocket.last()) };
	}

	it("unanswered hints 5 001 ms apart fire at 10 s from the first probe, once", async () => {
		const context = setup({ keepAliveMs: 60_000, pongTimeoutMs: TIMEOUT });
		const { socket } = await established(context);
		context.connection.probe?.();
		await vi.advanceTimersByTimeAsync(HINT);
		context.connection.probe?.();
		await vi.advanceTimersByTimeAsync(TIMEOUT - HINT - 1);
		expect(socket.closedWith).toBeUndefined();
		await vi.advanceTimersByTimeAsync(1);
		expect(socket.closedWith).toEqual(TERMINATED);
		expect(pongTimeouts(context)).toBe(1);
		expect(watchdogStatuses(context)).toBe(1);
		// The outstanding ping answers the hint: no ping amplification.
		expect(pings(socket)).toBe(1);
		await flush();
		expect(FakeWebSocket.instances).toHaveLength(2);
		await handshake(FakeWebSocket.last());
		await vi.advanceTimersByTimeAsync(3 * TIMEOUT);
		expect(FakeWebSocket.instances).toHaveLength(2);
		expect(pongTimeouts(context)).toBe(1);
		expect(watchdogStatuses(context)).toBe(1);
	});

	it("a keepAlive ping after an unanswered probe does not postpone its deadline", async () => {
		// Upstream enqueues its keepAlive ping on open: it fires 6 s after the probe.
		const context = setup({ keepAliveMs: 6_000, pongTimeoutMs: TIMEOUT });
		const { socket } = await established(context);
		context.connection.probe?.();
		await vi.advanceTimersByTimeAsync(TIMEOUT - 1);
		expect(pings(socket)).toBe(2);
		expect(socket.closedWith).toBeUndefined();
		await vi.advanceTimersByTimeAsync(1);
		expect(socket.closedWith).toEqual(TERMINATED);
		expect(pongTimeouts(context)).toBe(1);
	});

	it("hints after an unanswered keepAlive ping send no ping and keep its deadline", async () => {
		const context = setup({ keepAliveMs: 4_000, pongTimeoutMs: TIMEOUT });
		const { socket } = await established(context);
		await vi.advanceTimersByTimeAsync(4_000);
		expect(pings(socket)).toBe(1);
		for (let hint = 0; hint < 2; hint += 1) {
			await vi.advanceTimersByTimeAsync(HINT);
			context.connection.probe?.();
		}
		// 4 000 + 2 × 5 001 = 14 002: past the keepAlive deadline at 14 000.
		expect(socket.closedWith).toEqual(TERMINATED);
		expect(pings(socket)).toBe(1);
		expect(pongTimeouts(context)).toBe(1);
	});

	it("a received pong clears the deadline; a later hint arms a fresh one from that probe", async () => {
		const context = setup({ keepAliveMs: 60_000, pongTimeoutMs: TIMEOUT });
		const { socket } = await established(context);
		context.connection.probe?.();
		await vi.advanceTimersByTimeAsync(3_000);
		socket.receive({ type: "pong" });
		await vi.advanceTimersByTimeAsync(9_000);
		expect(socket.closedWith).toBeUndefined();
		context.connection.probe?.(); // at 12 000: fresh deadline at 22 000
		expect(pings(socket)).toBe(2);
		await vi.advanceTimersByTimeAsync(HINT);
		context.connection.probe?.();
		await vi.advanceTimersByTimeAsync(TIMEOUT - HINT - 1);
		expect(socket.closedWith).toBeUndefined();
		await vi.advanceTimersByTimeAsync(1);
		expect(socket.closedWith).toEqual(TERMINATED);
		expect(pongTimeouts(context)).toBe(1);
		expect(pings(socket)).toBe(2);
	});

	it("dispose cancels the outstanding deadline", async () => {
		const context = setup({ keepAliveMs: 60_000, pongTimeoutMs: TIMEOUT });
		await established(context);
		context.connection.probe?.();
		await vi.advanceTimersByTimeAsync(HINT);
		context.connection.dispose();
		await vi.advanceTimersByTimeAsync(2 * TIMEOUT);
		expect(pongTimeouts(context)).toBe(0);
		expect(watchdogStatuses(context)).toBe(0);
	});

	it("a close cancels it; the next socket's probe arms its own deadline", async () => {
		const context = setup({ keepAliveMs: 60_000, pongTimeoutMs: TIMEOUT });
		const { socket } = await established(context);
		context.connection.probe?.();
		await vi.advanceTimersByTimeAsync(4_000);
		socket.networkError();
		await flush();
		const next = FakeWebSocket.last();
		expect(next).not.toBe(socket);
		await handshake(next);
		await vi.advanceTimersByTimeAsync(3_000);
		context.connection.probe?.(); // at 7 000: deadline at 17 000
		expect(pings(next)).toBe(1);
		await vi.advanceTimersByTimeAsync(TIMEOUT - 1);
		expect(next.closedWith).toBeUndefined();
		expect(pongTimeouts(context)).toBe(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(next.closedWith).toEqual(TERMINATED);
		expect(pongTimeouts(context)).toBe(1);
	});

	it("an auth-blocked close (generation change) cancels it", async () => {
		const context = setup({ keepAliveMs: 60_000, pongTimeoutMs: TIMEOUT });
		const { socket } = await established(context);
		context.connection.probe?.();
		await vi.advanceTimersByTimeAsync(HINT);
		socket.serverClose(4401);
		await vi.advanceTimersByTimeAsync(2 * TIMEOUT);
		expect(context.test.lastStatus()).toMatchObject({ state: "auth-blocked" });
		expect(pongTimeouts(context)).toBe(0);
		expect(watchdogStatuses(context)).toBe(0);
	});

	it("after a scheduling gap it re-arms for the remaining executable time from the original arm", async () => {
		let gap = 0;
		const context = setup(
			{ keepAliveMs: 60_000, pongTimeoutMs: TIMEOUT },
			{ now: () => Date.now() - gap },
		);
		const { socket } = await established(context);
		context.connection.probe?.(); // executable 0
		await vi.advanceTimersByTimeAsync(HINT);
		context.connection.probe?.();
		// 8 000 ms of the wall-clock wait were suspended, not executable time.
		gap = 8_000;
		await vi.advanceTimersByTimeAsync(TIMEOUT - HINT);
		// The wall timer fired at 10 000 but only 2 000 ms were executable.
		expect(socket.closedWith).toBeUndefined();
		await vi.advanceTimersByTimeAsync(2_000);
		context.connection.probe?.(); // a hint inside the re-armed window
		// Remaining 8 000 ms from the original arm: wall 18 000, executable 10 000.
		await vi.advanceTimersByTimeAsync(5_999);
		expect(socket.closedWith).toBeUndefined();
		await vi.advanceTimersByTimeAsync(1);
		expect(socket.closedWith).toEqual(TERMINATED);
		expect(pongTimeouts(context)).toBe(1);
		expect(pings(socket)).toBe(1);
	});
});

describe("results, errors and completion", () => {
	it("delivers results unchanged, terminal GraphQL errors and genuine completion", async () => {
		const context = setup();
		const { feed, socket } = await connected(context);
		const [id] = socket.subscribeIds();
		const result = {
			data: { ticks: { n: 1 } },
			errors: [{ message: "partial" }],
			extensions: { cost: 1 },
		};
		socket.receive({ id, type: "next", payload: result });
		expect(feed.recording.events).toEqual([result]);
		expect(feed.recording.started).toBe(1);
		socket.receive({ id, type: "error", payload: [{ message: "boom" }] });
		await flush();
		expect(feed.recording.errors).toEqual([
			{
				code: "upstream-error",
				message: "The GraphQL operation failed.",
				detail: { errors: [{ message: "boom" }] },
			},
		]);

		const second = context.subscribe();
		await flush();
		const secondId = socket.subscribeIds().at(-1);
		socket.receive({ id: secondId, type: "complete" });
		await flush();
		expect(second.recording.completions).toBe(1);
	});

	it("unsubscribe sends one Complete and no synthetic completion reaches the sink", async () => {
		const context = setup();
		const { feed, socket } = await connected(context);
		feed.subscription.unsubscribe();
		feed.subscription.unsubscribe();
		await flush();
		expect(
			socket.sent.filter((message) => message.type === "complete"),
		).toHaveLength(1);
		expect(feed.recording.completions).toBe(0);
		await vi.advanceTimersByTimeAsync(60);
		// Upstream lazy close with the idle value.
		expect(socket.closedWith?.code).toBe(1000);
		expect(context.test.lastStatus()).toMatchObject({
			state: "inactive",
			reason: "idle",
		});
	});

	it("dispose() completions from upstream are suppressed", async () => {
		const context = setup();
		const { feed } = await connected(context);
		context.connection.dispose();
		await vi.advanceTimersByTimeAsync(10);
		expect(feed.recording.completions).toBe(0);
		expect(feed.recording.errors).toEqual([]);
	});

	it("non-repeatable intent ends as interrupted instead of being re-issued", async () => {
		const context = setup();
		const once = context.subscribe(false);
		const repeatable = context.subscribe(true);
		await flush();
		const socket = FakeWebSocket.last();
		socket.accept();
		await flush();
		expect(socket.subscribeIds()).toHaveLength(2);
		socket.serverClose(1006);
		await flush();
		expect(once.recording.errors).toEqual([
			expect.objectContaining({ code: "interrupted" }),
		]);
		FakeWebSocket.last().accept();
		await flush();
		// Only the repeatable operation is re-sent on the new socket.
		expect(FakeWebSocket.instances).toHaveLength(2);
		expect(FakeWebSocket.last().subscribeIds()).toHaveLength(1);
		expect(repeatable.recording.continuity).toEqual([
			{ reason: "reconnected" },
			{ reason: "reconnected" },
		]);
	});
});

/** A socket whose close event arrives only when the test finishes the handshake. */
class SlowCloseSocket extends FakeWebSocket {
	pendingClose: { code: number; reason: string } | undefined;

	override close(code?: number, reason?: string): void {
		if (this.readyState >= 2) return;
		this.closedWith = { code, reason };
		this.readyState = 2;
		this.pendingClose = { code: code ?? 1005, reason: reason ?? "" };
	}

	finishClose(): void {
		const pending = this.pendingClose;
		if (!pending) throw new Error("no close is pending");
		this.pendingClose = undefined;
		this.readyState = 3;
		this.onclose?.({ ...pending, wasClean: pending.code === 1000 });
	}
}

// Disposing graphql-ws can complete subscriptions asynchronously; fence completion to the generation that opened them.
describe("restart generation fence", () => {
	it("a retry() inside the old socket's close handshake keeps the re-armed stream open", async () => {
		// Upstream leaves the failed operation's close promise without a
		// handler (its `send` threw first); record that one known rejection
		// instead of letting it surface as an unrelated test error.
		const rejections: unknown[] = [];
		const onRejection = (reason: unknown) => rejections.push(reason);
		process.on("unhandledRejection", onRejection);
		try {
			const context = setup(
				{},
				{
					adapter: {
						webSocketImpl: SlowCloseSocket,
						// One operation gets an unserialisable payload, so upstream
						// throws for that operation only and the socket stays open.
						applyContext: (payload, extra) =>
							(extra as { bad?: boolean }).bad
								? ({
										...payload,
										variables: { n: 1n },
									} as unknown as GraphqlPayload)
								: payload,
					},
				},
			);
			const { feed } = await connected(context);
			const first = FakeWebSocket.last() as SlowCloseSocket;
			expect(first.subscribeIds()).toHaveLength(1);

			const failing = context.connection.subscribe(
				{ query: QUERY, context: { bad: true } },
				createRecordingSink<unknown>().sink,
				{ key: "bad", repeatable: true },
			);
			await flush();
			expect(context.test.lastStatus()).toMatchObject({ state: "failed" });
			// The blocked client's dispose() closed the still-open socket.
			expect(first.pendingClose?.code).toBe(1000);
			failing.unsubscribe();

			context.connection.retry?.();
			await flush();
			const second = FakeWebSocket.last() as SlowCloseSocket;
			expect(second).not.toBe(first);
			second.accept();
			await flush();
			const [id] = second.subscribeIds();
			expect(id).toBeDefined();

			first.finishClose();
			await flush();
			second.receive({
				id,
				type: "next",
				payload: { data: { ticks: { n: 2 } } },
			});
			await flush();

			expect(feed.recording.log).not.toContain("complete");
			expect(feed.recording.completions).toBe(0);
			expect(feed.recording.events).toHaveLength(1);
			expect(rejections).toEqual([
				expect.objectContaining({ code: 1000, reason: "Normal Closure" }),
			]);
		} finally {
			process.off("unhandledRejection", onRejection);
		}
	});
});

/**
 * A real WebSocket stays CLOSING for the close handshake (one round trip) and
 * silently discards `send` while it is not OPEN.
 */
class HandshakeSocket extends FakeWebSocket {
	override send(data: string): void {
		if (this.readyState !== 1) return;
		super.send(data);
	}

	override close(code?: number, reason?: string): void {
		if (this.readyState >= 2) return;
		this.closedWith = { code, reason };
		this.readyState = 2;
		setTimeout(() => this.serverClose(code ?? 1005, reason ?? ""), 20);
	}
}

// graphql-ws 6.3.0 reconnects at once
// after a 1000 close while subscriptions are active, without calling
// `shouldRetry`. The adapter detects that close itself and takes the same
// path: the early notice, `reconnecting`, and non-repeatable intent ends as
// `interrupted` instead of being re-sent.
describe("a 1000 close with active subscriptions is a detected interruption", () => {
	it("reports the loss, publishes reconnecting and interrupts non-repeatable intent", async () => {
		const context = setup();
		const once = context.subscribe(false);
		const repeat = context.subscribe(true);
		await flush();
		const first = FakeWebSocket.last();
		first.accept();
		await flush();
		expect(first.subscribeIds()).toHaveLength(2);
		const before = context.test.statuses.length;

		first.serverClose(1000, "Normal Closure");
		await flush();
		const second = FakeWebSocket.last();
		expect(second).not.toBe(first);
		second.accept();
		await flush();

		expect(once.recording.errors.map((error) => error.code)).toEqual([
			"interrupted",
		]);
		expect(once.recording.log).toEqual([
			"continuity:reconnected",
			"error:interrupted",
		]);
		expect(second.subscribeIds()).toHaveLength(1);
		// Once at detection, then the reconnect outcome.
		expect(repeat.recording.continuity).toEqual([
			{ reason: "reconnected" },
			{ reason: "reconnected" },
		]);
		const after = context.test.statuses.slice(before);
		expect(after[0]).toMatchObject({
			state: "reconnecting",
			reason: "network",
			code: "close:1000",
		});
		expect(after.map((status) => status.state)).not.toContain("connecting");
		expect(after.at(-1)?.state).toBe("connected");
		expect(context.test.requests).toEqual(["connect", "reconnect"]);
	});

	it("a 1000 close after the last subscription left stays an idle close", async () => {
		const context = setup();
		const { feed, socket } = await connected(context);
		feed.subscription.unsubscribe();
		await vi.advanceTimersByTimeAsync(60);
		expect(socket.closedWith?.code).toBe(1000);
		expect(FakeWebSocket.instances).toHaveLength(1);
		expect(feed.recording.continuity).toEqual([]);
		expect(context.test.hasStatus("reconnecting")).toBe(false);
		expect(context.test.lastStatus()).toMatchObject({
			state: "inactive",
			reason: "idle",
		});
	});

	// Subscribing during an idle socket close must wait for a fresh socket without reporting an interruption.
	for (const repeatable of [false, true]) {
		it(`a ${repeatable ? "repeatable" : "non-repeatable"} subscription started during graphql-ws's own idle close is sent once on the next socket, without a loss notice`, async () => {
			const context = setup(
				{ lazyCloseTimeoutMs: 30 },
				{ adapter: { webSocketImpl: HandshakeSocket } },
			);
			const { feed, socket } = await connected(context);
			feed.subscription.unsubscribe();
			await vi.advanceTimersByTimeAsync(30);
			expect(socket.closedWith).toEqual({
				code: 1000,
				reason: "Normal Closure",
			});
			expect(socket.readyState).toBe(2);
			const before = context.test.statuses.length;

			const fresh = context.subscribe(repeatable);
			await vi.advanceTimersByTimeAsync(20); // the close event arrives
			await flush();
			expect(FakeWebSocket.instances).toHaveLength(2);
			const next = FakeWebSocket.last();
			next.accept();
			await flush();

			expect(fresh.recording.log).toEqual([]);
			expect(socket.subscribeIds()).toHaveLength(1);
			expect(next.subscribeIds()).toHaveLength(1);
			expect(
				context.test.statuses.slice(before).map((status) => status.state),
			).toEqual(["connecting", "connected"]);
			expect(context.test.hasStatus("reconnecting")).toBe(false);
		});
	}

	it("a subscription that joined during the idle close is detected at a later 1000 close on its next socket", async () => {
		const context = setup(
			{ lazyCloseTimeoutMs: 30 },
			{ adapter: { webSocketImpl: HandshakeSocket } },
		);
		const { feed } = await connected(context);
		feed.subscription.unsubscribe();
		await vi.advanceTimersByTimeAsync(30);
		const once = context.subscribe(false);
		await vi.advanceTimersByTimeAsync(20);
		await flush();
		const next = FakeWebSocket.last();
		next.accept();
		await flush();
		expect(next.subscribeIds()).toHaveLength(1);
		const before = context.test.statuses.length;

		next.serverClose(1000, "Normal Closure");
		await flush();

		expect(once.recording.log).toEqual([
			"continuity:reconnected",
			"error:interrupted",
		]);
		expect(context.test.statuses.slice(before)[0]).toMatchObject({
			state: "reconnecting",
			code: "close:1000",
		});
		expect(FakeWebSocket.instances).toHaveLength(2);
	});

	// Guard for the V-1 repair: records waiting on an attempt that never
	// connected still count. graphql-ws keeps its conservative rule:
	// a detected reconnect ends every current non-repeatable record.
	it("a 1000 close during connection_init stays a detected interruption", async () => {
		const context = setup();
		const once = context.subscribe(false);
		const repeat = context.subscribe(true);
		await flush();
		const first = FakeWebSocket.last();
		first.open(); // connection_init sent, never acknowledged
		await flush();
		first.serverClose(1000, "Normal Closure");
		await flush();
		const second = FakeWebSocket.last();
		expect(second).not.toBe(first);
		second.accept();
		await flush();

		expect(once.recording.log).toEqual(["error:interrupted"]);
		expect(repeat.recording.log).toEqual([]);
		expect(second.subscribeIds()).toHaveLength(1);
		expect(context.test.statuses.map((status) => status.state)).toEqual([
			"connecting",
			"reconnecting",
			"reconnecting",
			"connected",
		]);
		expect(context.test.hasStatus("reconnecting", { code: "close:1000" })).toBe(
			true,
		);
	});
});

// Credential rotation is a deliberate restart; report its outcome once, without an early interruption notice.
describe("a live rotate() is a deliberate restart", () => {
	it("reports continuity once, at the new connected, with connecting and a rotated request", async () => {
		const context = setup();
		const { feed } = await connected(context);
		const before = context.test.statuses.length;
		context.test.setRevision(2);
		context.connection.rotate?.();
		await flush();
		const second = FakeWebSocket.last();
		expect(FakeWebSocket.instances).toHaveLength(2);
		second.accept();
		await flush();

		expect(second.sent[0]).toMatchObject({ payload: { token: "t2" } });
		expect(second.subscribeIds()).toHaveLength(1);
		expect(
			feed.recording.log.filter((l) => l.startsWith("continuity")),
		).toEqual(["continuity:reconnected"]);
		const after = context.test.statuses.slice(before);
		expect(after.map((status) => status.state)).not.toContain("reconnecting");
		expect(after[0]?.state).toBe("connecting");
		expect(after.at(-1)?.state).toBe("connected");
		expect(context.test.requests).toEqual(["connect", "rotated"]);
		expect(feed.recording.errors).toEqual([]);
	});

	it("ends non-repeatable intent as interrupted without an early notice", async () => {
		const context = setup();
		const once = context.subscribe(false);
		await flush();
		FakeWebSocket.last().accept();
		await flush();
		context.test.setRevision(2);
		context.connection.rotate?.();
		await flush();
		expect(once.recording.log).toEqual(["error:interrupted"]);
		expect(once.recording.errors[0]?.message).toBe(
			"The connection restarted; the operation is not repeatable.",
		);
		expect(context.test.hasStatus("reconnecting")).toBe(false);
	});

	it("a failed attempt after the rotation is a detected interruption again", async () => {
		const context = setup();
		const { feed } = await connected(context);
		context.test.setRevision(2);
		context.connection.rotate?.();
		await flush();
		const before = context.test.statuses.length;
		FakeWebSocket.last().serverClose(1006);
		await flush();
		expect(context.test.hasStatus("reconnecting", { code: "close:1006" })).toBe(
			true,
		);
		FakeWebSocket.last().accept();
		await flush();
		expect(
			context.test.statuses.slice(before).map((status) => status.state),
		).toEqual(["reconnecting", "reconnecting", "connected"]);
		expect(context.test.requests).toEqual(["connect", "rotated", "reconnect"]);
		expect(feed.recording.continuity).toEqual([
			{ reason: "reconnected" },
			{ reason: "reconnected" },
		]);
	});
});
