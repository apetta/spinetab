import { describe, expect, it } from "vitest";
import {
	defaultClassifyConnectError,
	socketIoAdapter,
} from "../../../src/protocols/socket-io/runtime.ts";
import {
	createRecordingSink,
	createTestContext,
} from "../../integration/protocols/helpers.ts";

// Live socket behaviour
// (transports, recovery, acknowledgements) is covered against real servers
// in tests/integration/protocols/socket-io.test.ts.

describe("socket.io adapter validation", () => {
	const adapter = socketIoAdapter({ routes: { byRoom: () => [] } });

	it("needs the page builder's tab id for per-tab sockets and absolute URLs", () => {
		expect(() =>
			adapter.validateConnection?.({
				url: "http://a.test",
				sharing: "per-tab",
			}),
		).toThrowError(
			expect.objectContaining({ detail: { path: "connection.tab" } }),
		);
		expect(() =>
			adapter.validateConnection?.({ url: "/", sharing: "shared" }),
		).toThrowError(expect.objectContaining({ code: "invalid-endpoint" }));
		expect(() =>
			adapter.validateConnection?.({
				url: "http://a.test",
				sharing: "per-tab",
				tab: "t1",
			}),
		).not.toThrow();
	});

	it("accepts only registered routes", () => {
		expect(() =>
			adapter.validateSubscription?.({
				event: "room",
				membership: "r",
				route: "unknown",
			}),
		).toThrowError(
			expect.objectContaining({ detail: { path: "subscription.route" } }),
		);
		expect(() =>
			adapter.validateSubscription?.({
				event: "room",
				membership: "r",
				route: "byRoom",
			}),
		).not.toThrow();
		expect(() =>
			adapter.validateSubscription?.({ event: "room", route: "byRoom" }),
		).toThrowError(expect.objectContaining({ code: "unsupported-option" }));
	});

	it("identity includes defaults, sharing and tab", () => {
		const base = { url: "http://a.test", sharing: "shared" as const };
		expect(adapter.connectionKey?.(base)).toBe(
			adapter.connectionKey?.({ ...base, reconnectionAttempts: 10 }),
		);
		expect(adapter.connectionKey?.(base)).not.toBe(
			adapter.connectionKey?.({ ...base, sharing: "per-tab", tab: "t" }),
		);
	});

	it("a membership key without a route on a shared socket is refused at subscribe", () => {
		const test = createTestContext({ credentials: () => ({ auth: {} }) });
		const connection = adapter.connect(
			{ url: "http://127.0.0.1:1", sharing: "shared" },
			test.ctx,
		);
		const recording = createRecordingSink<unknown[]>();
		connection.subscribe({ event: "room", membership: "r" }, recording.sink, {
			key: "k",
			repeatable: true,
		});
		expect(recording.errors).toEqual([
			expect.objectContaining({ code: "unsupported-option" }),
		]);
		connection.dispose();
	});
});

describe("the URL path is the namespace when none is given", () => {
	const adapter = socketIoAdapter();
	const shared = { sharing: "shared" as const };
	const key = (spec: { url: string; namespace?: string }) =>
		adapter.connectionKey?.({ ...spec, ...shared });

	it("the path form and the explicit form share one identity", () => {
		const path = key({ url: "https://h.test/chat" });
		expect(path).toBe(key({ url: "https://h.test", namespace: "/chat" }));
		expect(path).toBe(key({ url: "https://h.test/", namespace: "/chat" }));
		expect(path).toBe(key({ url: "https://h.test/chat", namespace: "/chat" }));
		expect(path).not.toBe(key({ url: "https://h.test/ops" }));
		expect(path).not.toBe(key({ url: "https://h.test" }));
		// The root path is the default namespace, spelt either way.
		expect(key({ url: "https://h.test/" })).toBe(
			key({ url: "https://h.test", namespace: "/" }),
		);
		expect(key({ url: "https://h.test" })).toBe(
			key({ url: "https://h.test/" }),
		);
	});

	it("a conflicting explicit namespace is unsupported-option naming both", () => {
		for (const namespace of ["/ops", "/"]) {
			expect(
				() =>
					adapter.validateConnection?.({
						url: "https://h.test/chat",
						namespace,
						...shared,
					}),
				namespace,
			).toThrowError(
				expect.objectContaining({
					code: "unsupported-option",
					message: expect.stringMatching(
						/^connection\.namespace: .*connection\.url/,
					),
					detail: { path: "connection.namespace" },
				}),
			);
		}
		for (const url of [
			"https://h.test/chat",
			"https://h.test/",
			"https://h.test",
		]) {
			expect(
				() =>
					adapter.validateConnection?.({ url, namespace: "/chat", ...shared }),
				url,
			).not.toThrow();
		}
	});
});

describe("connect_error classification", () => {
	it("defaults: 401 data or unauthorised messages are auth; 403 or forbidden is forbidden", () => {
		expect(
			defaultClassifyConnectError({ message: "x", data: { status: 401 } }),
		).toBe("auth");
		expect(
			defaultClassifyConnectError({ message: "x", data: { status: 403 } }),
		).toBe("forbidden");
		expect(defaultClassifyConnectError({ message: "Unauthorised" })).toBe(
			"auth",
		);
		expect(defaultClassifyConnectError({ message: "Unauthorized" })).toBe(
			"auth",
		);
		expect(defaultClassifyConnectError({ message: "Forbidden" })).toBe(
			"forbidden",
		);
		expect(defaultClassifyConnectError({ message: "room full" })).toBe(
			"failed",
		);
	});
});

describe("commands before any connection", () => {
	it("a command that cannot connect is not-sent, never buffered", async () => {
		const adapter = socketIoAdapter();
		const test = createTestContext({ credentials: () => ({ auth: {} }) });
		const connection = adapter.connect(
			{
				url: "http://127.0.0.1:1",
				sharing: "shared",
				ackTimeoutMs: 50,
				timeoutMs: 50,
			},
			test.ctx,
		);
		const outcome = await connection.command?.(
			{ event: "send", args: [1] },
			{ id: "c1", signal: new AbortController().signal, timeoutMs: 1_000 },
		);
		expect(outcome).toMatchObject({
			status: "not-sent",
			error: { code: "command-not-sent" },
		});
		connection.dispose();
	});
});
