import { createTRPCClient, TRPCClientError } from "@trpc/client";
import { describe, expect, it } from "vitest";
import {
	spinetabSseLink,
	spinetabWsLink,
} from "../../../src/integrations/trpc/index.ts";
import {
	inputWithCursor,
	splitCursor,
	validateTrpcSubscription,
} from "../../../src/integrations/trpc/spec.ts";
import type { FixtureTrpcRouter } from "../../fixtures/servers/trpc.ts";
import { createFakeClient } from "./fakes.ts";

// with a real createTRPCClient
// and a fake Spinetab page client.

function setup() {
	const { client, calls } = createFakeClient();
	const trpc = createTRPCClient<FixtureTrpcRouter>({
		links: [
			spinetabWsLink<FixtureTrpcRouter>({
				client,
				url: "/trpc-ws",
				replay: ["ticks"],
			}),
		],
	});
	return { trpc, calls };
}

describe("tRPC subscription identity and cursors", () => {
	it("keeps lastEventId out of the input identity and uses it as the starting cursor", () => {
		const { trpc, calls } = setup();
		trpc.ticks.subscribe({ tag: "a" }, { onData() {} });
		trpc.ticks.subscribe({ tag: "a", lastEventId: "7" }, { onData() {} });
		expect(calls[0]?.request).toMatchObject({
			adapter: "trpc-ws",
			connection: { url: "/trpc-ws" },
			subscription: { path: "ticks", input: { tag: "a" }, replay: true },
		});
		expect(calls[1]?.request.subscription).toEqual({
			path: "ticks",
			input: { tag: "a" },
			lastEventId: "7",
			replay: true,
		});
		expect(structuredClone(calls[1]?.request)).toEqual(calls[1]?.request);
	});

	it("advances the consumer cursor only for delivered ids and forwards it on resume", () => {
		const { trpc, calls } = setup();
		const data: unknown[] = [];
		let started = 0;
		trpc.ticks.subscribe(
			{ tag: "a" },
			{
				onData: (value) => data.push(value),
				onStarted: () => {
					started += 1;
				},
			},
		);
		const call = calls[0];
		expect(call?.options?.resume?.({})).toBeUndefined();
		call?.observer.next(
			{ id: "1", data: { id: "1", data: { n: 1 } } },
			{ seq: 1, eventId: "1" },
		);
		call?.observer.next(
			{ id: "2", data: { id: "2", data: { n: 2 } } },
			{ seq: 2, eventId: "2" },
		);
		expect(started).toBe(1);
		expect(data).toEqual([
			{ id: "1", data: { n: 1 } },
			{ id: "2", data: { n: 2 } },
		]);
		expect(call?.options?.resume?.({ lastEventId: "99" })).toEqual({
			subscription: {
				path: "ticks",
				input: { tag: "a" },
				lastEventId: "2",
				replay: true,
			},
		});
	});

	it("maps completion to stopped and keeps resumable states open", () => {
		const { trpc, calls } = setup();
		const states: string[] = [];
		let stopped = 0;
		let errors = 0;
		trpc.ticks.subscribe(
			{ tag: "a" },
			{
				onData() {},
				onConnectionStateChange: (state) => states.push(state.state),
				onStopped: () => {
					stopped += 1;
				},
				onError: () => {
					errors += 1;
				},
			},
		);
		const call = calls[0];
		call?.status("connecting");
		call?.status("connected");
		call?.status("reconnecting");
		call?.status("auth-blocked");
		expect(states).toEqual([
			"connecting",
			"pending",
			"connecting",
			"connecting",
		]);
		expect(errors).toBe(0);
		call?.observer.complete?.();
		expect(stopped).toBe(1);
	});

	it("maps a worker error shape to a TRPCClientError with its code", () => {
		const { trpc, calls } = setup();
		let error: unknown;
		trpc.ticks.subscribe(
			{ tag: "a" },
			{
				onData() {},
				onError: (cause) => {
					error = cause;
				},
			},
		);
		calls[0]?.observer.error?.({
			code: "upstream-error",
			message: "nope",
			detail: {
				trpcCode: "BAD_REQUEST",
				shape: {
					message: "nope",
					code: -32600,
					data: { code: "BAD_REQUEST", httpStatus: 400 },
				},
			},
		});
		expect(error).toBeInstanceOf(TRPCClientError);
		expect((error as TRPCClientError<never>).data).toMatchObject({
			code: "BAD_REQUEST",
		});
	});

	it("errors non-subscription operations immediately", async () => {
		const { trpc, calls } = setup();
		await expect(trpc.echo.mutate({ a: 1 })).rejects.toThrow(
			/only handle subscriptions/,
		);
		expect(calls).toHaveLength(0);
	});
});

describe("tRPC spec helpers and SSE credential policy", () => {
	it("merges the cursor into object inputs only", () => {
		expect(inputWithCursor({ tag: "a" }, "3")).toEqual({
			tag: "a",
			lastEventId: "3",
		});
		expect(inputWithCursor(undefined, "3")).toEqual({ lastEventId: "3" });
		expect(inputWithCursor("scalar", "3")).toBe("scalar");
		expect(inputWithCursor({ tag: "a" }, undefined)).toEqual({ tag: "a" });
		expect(splitCursor({ tag: "a", lastEventId: "4" })).toEqual({
			input: { tag: "a" },
			lastEventId: "4",
		});
		expect(splitCursor("x")).toEqual({ input: "x" });
	});

	it("rejects a cursor inside the identity input", () => {
		expect(() =>
			validateTrpcSubscription({ path: "ticks", input: { lastEventId: "1" } }),
		).toThrowError(expect.objectContaining({ code: "unsupported-option" }));
	});

	it("never places credentials in SSE connection params", () => {
		const { client } = createFakeClient();
		// The option is gone; any value is an unknown option.
		for (const value of [true, false]) {
			expect(() =>
				spinetabSseLink({
					client,
					url: "/trpc",
					allowConnectionParamsCredentials: value,
				} as never),
			).toThrowError(expect.objectContaining({ code: "unsupported-option" }));
		}
		expect(() =>
			spinetabSseLink({
				client,
				url: "/trpc",
				connectionParams: { n: 1 as unknown as string },
			}),
		).toThrowError(
			expect.objectContaining({
				detail: { path: "spinetabSseLink.connectionParams.n" },
			}),
		);
	});
});
