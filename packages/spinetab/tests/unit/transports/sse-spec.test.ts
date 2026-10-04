import { describe, expect, it } from "vitest";
import { isUniqueKey } from "../../../src/core/identity.ts";
import { sse } from "../../../src/transports/sse/index.ts";
import { sseAdapter } from "../../../src/transports/sse/runtime.ts";

// SSE option model per mode and page builder shape.

function pathOf(action: () => unknown): string | undefined {
	try {
		action();
	} catch (error) {
		return (error as { detail?: { path?: string } }).detail?.path;
	}
	return undefined;
}

describe("sse() page builder", () => {
	it("rejects fetch-only options in eventsource mode with their path", () => {
		for (const [key, value] of [
			["method", "POST"],
			["body", "x"],
			["headers", { "x-a": "1" }],
			["credentials", "include"],
			["authHeaders", true],
		] as const) {
			expect(
				pathOf(() =>
					sse({ url: "/s", mode: "eventsource", [key]: value } as never),
				),
			).toBe(`connection.${key}`);
		}
	});

	it("rejects EventSource-only and contradictory options in fetch mode", () => {
		expect(
			pathOf(() => sse({ url: "/s", mode: "fetch", withCredentials: true })),
		).toBe("connection.withCredentials");
		expect(pathOf(() => sse({ url: "/s", mode: "fetch", body: "x" }))).toBe(
			"connection.body",
		);
		expect(
			pathOf(() =>
				sse({
					url: "/s",
					mode: "fetch",
					resume: false,
					replay: "last-event-id",
				}),
			),
		).toBe("connection.replay");
		expect(
			pathOf(() => sse({ url: "/s", mode: "fetch", resume: { query: "" } })),
		).toBe("connection.resume.query");
		expect(
			pathOf(() =>
				sse({
					url: "/s",
					mode: "fetch",
					resume: { query: "a", url: "b" } as never,
				}),
			),
		).toBe("connection.resume");
		expect(
			pathOf(() => sse({ url: "/s", mode: "fetch", unknown: 1 } as never)),
		).toBe("connection.unknown");
		// An omitted mode defaults to fetch; an unknown one still fails.
		// an omitted decoder is written out as json.
		expect(sse({ url: "/s" }).connection).toEqual({
			url: "/s",
			mode: "fetch",
			decoder: "json",
		});
		expect(pathOf(() => sse({ url: "/s", mode: "websocket" } as never))).toBe(
			"connection.mode",
		);
		expect(pathOf(() => sse({ url: "/s", mode: "fetch", heartbeat: {} }))).toBe(
			"connection.heartbeat",
		);
	});

	it("rejects event names that collide with EventSource's own events", () => {
		expect(
			pathOf(() =>
				sse({ url: "/s", mode: "eventsource", events: ["tick", "error"] }),
			),
		).toBe("connection.events[1]");
		expect(
			pathOf(() =>
				sse({ url: "/s", mode: "eventsource" }).subscription({ event: "open" }),
			),
		).toBe("subscription.event");
		// Fetch mode has no such collision.
		expect(
			sse({ url: "/s", mode: "fetch" }).subscription({ event: "error" })
				.subscription,
		).toEqual({
			event: "error",
		});
	});

	it("enforces the declared events allow-list and never delivers heartbeat events", () => {
		const feed = sse({
			url: "/s",
			mode: "fetch",
			events: ["tick"],
			heartbeat: { event: "ping" },
		});
		expect(pathOf(() => feed.subscription({ event: "alert" }))).toBe(
			"subscription.event",
		);
		expect(
			pathOf(() =>
				sse({
					url: "/s",
					mode: "fetch",
					heartbeat: { event: "ping" },
				}).subscription({ event: "ping" }),
			),
		).toBe("subscription.event");
		expect(
			pathOf(() =>
				sse({
					url: "/s",
					mode: "fetch",
					events: ["ping"],
					heartbeat: { event: "ping" },
				}),
			),
		).toBe("connection.heartbeat.event");
	});

	it("accepts a declared reset event in both modes and never lets it be selected or delivered", () => {
		for (const mode of ["eventsource", "fetch"] as const) {
			const feed = sse({
				url: "/s",
				mode,
				replay: "last-event-id",
				resetEvent: "reset",
			});
			expect(feed.connection.resetEvent).toBe("reset");
			expect(pathOf(() => feed.subscription({ event: "reset" }))).toBe(
				"subscription.event",
			);
		}
		// Fetch mode has no EventSource name collisions.
		expect(
			sse({ url: "/s", mode: "fetch", resetEvent: "message" }).connection
				.resetEvent,
		).toBe("message");
	});

	it("rejects reset event names that EventSource owns, that are also selectable, or that are empty", () => {
		for (const name of ["message", "open", "error"]) {
			expect(
				pathOf(() => sse({ url: "/s", mode: "eventsource", resetEvent: name })),
			).toBe("connection.resetEvent");
		}
		for (const mode of ["eventsource", "fetch"] as const) {
			expect(
				pathOf(() =>
					sse({
						url: "/s",
						mode,
						events: ["tick", "reset"],
						resetEvent: "reset",
					}),
				),
			).toBe("connection.resetEvent");
			expect(pathOf(() => sse({ url: "/s", mode, resetEvent: "" }))).toBe(
				"connection.resetEvent",
			);
		}
	});

	it("rejects a reset event that is also the heartbeat event, since every heartbeat would force a gap", () => {
		for (const mode of ["eventsource", "fetch"] as const) {
			expect(
				pathOf(() =>
					sse({
						url: "/s",
						mode,
						replay: "last-event-id",
						heartbeat: { event: "ping" },
						resetEvent: "ping",
					}),
				),
			).toBe("connection.resetEvent");
		}
	});

	it("produces plain cloneable requests with explicit repeatability", () => {
		const get = sse({ url: "/s", mode: "fetch" }).subscription<number>({
			event: "tick",
		});
		expect(get).toEqual({
			adapter: "sse",
			connection: { url: "/s", mode: "fetch", decoder: "json" },
			subscription: { event: "tick" },
			repeatable: true,
		});
		expect(structuredClone(get)).toEqual(get);
		expect(
			sse({ url: "/s", mode: "fetch", method: "POST" }).subscription()
				.repeatable,
		).toBe(false);
		expect(
			sse({
				url: "/s",
				mode: "fetch",
				method: "POST",
				repeatable: true,
			}).subscription().repeatable,
		).toBe(true);
		expect(
			sse({ url: "/s", mode: "eventsource" }).subscription().repeatable,
		).toBe(true);
		expect(
			pathOf(() => sse({ url: "/s", mode: "eventsource", repeatable: false })),
		).toBe("connection.repeatable");
	});
});

describe("sseAdapter validation", () => {
	const adapter = sseAdapter({
		decoders: { csv: (data) => data.split(",") },
		resumeUrls: {
			path: (url, cursor) => new URL(`${url.pathname}/${cursor}`, url),
		},
	});

	it("rejects unregistered decoders and resume hooks, and relative URLs", () => {
		expect(
			pathOf(() =>
				adapter.validateConnection?.({
					url: "https://a.test/s",
					mode: "fetch",
					decoder: "xml",
				}),
			),
		).toBe("connection.decoder");
		expect(
			pathOf(() =>
				adapter.validateConnection?.({
					url: "https://a.test/s",
					mode: "fetch",
					resume: { url: "nope" },
				}),
			),
		).toBe("connection.resume.url");
		expect(() =>
			adapter.validateConnection?.({ url: "/s", mode: "fetch" }),
		).toThrowError(expect.objectContaining({ code: "invalid-endpoint" }));
		expect(() =>
			adapter.validateConnection?.({
				url: "https://a.test/s",
				mode: "fetch",
				decoder: "csv",
				resume: { url: "path" },
			}),
		).not.toThrow();
		expect(pathOf(() => sseAdapter({ decoders: { json: (d) => d } }))).toBe(
			"sseAdapter.decoders.json",
		);
		expect(pathOf(() => sseAdapter({ extra: 1 } as never))).toBe(
			"sseAdapter.extra",
		);
	});

	it("keys non-repeatable POST streams uniquely and repeatable streams canonically", () => {
		const post = {
			url: "https://a.test/s",
			mode: "fetch",
			method: "POST",
			body: "{}",
		} as const;
		expect(isUniqueKey(adapter.connectionKey?.(post) as string)).toBe(true);
		const get = {
			url: "https://a.test/s",
			mode: "fetch",
			headers: { b: "2", a: "1" },
		} as const;
		expect(adapter.connectionKey?.(get)).toBe(
			adapter.connectionKey?.({
				headers: { a: "1", b: "2" },
				mode: "fetch",
				url: "https://a.test/s",
			}),
		);
		// A declared reset event is part of the stream identity.
		expect(adapter.connectionKey?.({ ...get, resetEvent: "reset" })).not.toBe(
			adapter.connectionKey?.(get),
		);
	});
});
