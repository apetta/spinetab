import { describe, expect, it } from "vitest";
import type { CdpTarget } from "../../performance/lib/cdp.ts";
import { markFailed, Recorded } from "../../performance/lib/record.ts";
import {
	assertPositiveControl,
	emptyCapture,
	noWorkerCapture,
	requireWorkerCapture,
	skipWorkerRows,
	UPSTREAM,
	watchWorker,
	workerEventsObserved,
	workerKeys,
	workerPositiveControl,
} from "../../performance/lib/worker-capture.ts";

// Positive and negative capture controls with scripted CDP targets.

// biome-ignore lint/suspicious/noExplicitAny: CDP payloads are protocol-typed by method
type Params = Record<string, any>;

function fakeTarget(rejects: Record<string, string> = {}) {
	const listeners = new Map<string, Set<(params: Params) => void>>();
	const sent: string[] = [];
	const target: CdpTarget = {
		label: "worker",
		kind: "worker",
		route: "non-flat",
		async send<T>(method: string) {
			sent.push(method);
			const error = rejects[method];
			if (error !== undefined) throw new Error(`CDP ${method}: ${error}`);
			return {} as T;
		},
		on(event, listener) {
			let set = listeners.get(event);
			if (!set) {
				set = new Set();
				listeners.set(event, set);
			}
			set.add(listener);
			return () => set.delete(listener);
		},
		async detach() {},
	};
	const emit = (event: string, params: Params) => {
		for (const listener of listeners.get(event) ?? []) listener(params);
	};
	return { target, emit, sent };
}

const ORIGIN = "http://127.0.0.1:4500";
const KEY = "privacy.ws.off";
const attached = (target: CdpTarget) => ({ target, errors: {} });

describe("worker capture capability", () => {
	it("records a rejected Network.enable as network false and fails the row", async () => {
		const { target, sent } = fakeTarget({
			"Network.enable": "Network domain not supported",
		});
		const captured = emptyCapture();
		const capability = await watchWorker(target, captured);
		expect(capability).toEqual({
			runtime: true,
			network: false,
			errors: {
				"Network.enable": "CDP Network.enable: Network domain not supported",
			},
		});
		expect(sent).toEqual(["Runtime.enable", "Network.enable"]);
		expect(() => requireWorkerCapture(attached(target), capability)).toThrow(
			/worker capture incomplete: runtime true, network false .*Network domain not supported/,
		);

		// As in the scenario: the check precedes every put, so the failed run
		// records each expected row as null with the reason, never as zero.
		const out = new Recorded();
		const detail: Record<string, unknown> = {};
		const expected = [`${KEY}.markers`, `${KEY}.console`, ...workerKeys(KEY)];
		try {
			requireWorkerCapture(attached(target), capability);
			for (const id of expected) out.put(id, 0);
		} catch (error) {
			markFailed(out, detail, expected, error);
		}
		for (const id of expected) {
			expect(out.metrics[id]).toBeNaN();
			expect(out.notMeasured[id]).toMatch(
				/^run failed: worker capture incomplete/,
			);
		}
		expect(detail.failure).toMatch(/network false/);
	});

	it("fails without a SharedWorker attach, with the attach errors", () => {
		const errors = { find: "no shared_worker target matching bench.worker" };
		expect(() => requireWorkerCapture({ target: undefined, errors })).toThrow(
			/no SharedWorker CDP attach .*no shared_worker target matching bench\.worker/,
		);
	});

	it("propagates a rejected Runtime.enable before touching Network", async () => {
		const { target, sent } = fakeTarget({ "Runtime.enable": "detached" });
		await expect(watchWorker(target, emptyCapture())).rejects.toThrow(
			"CDP Runtime.enable: detached",
		);
		expect(sent).toEqual(["Runtime.enable"]);
	});
});

describe("worker capture positive controls", () => {
	it("delivers requests and console through the registered listeners", async () => {
		const { target, emit } = fakeTarget();
		const captured = emptyCapture();
		const capability = await watchWorker(target, captured, "control-1");
		expect(capability).toEqual({ runtime: true, network: true, errors: {} });
		requireWorkerCapture(attached(target), capability);

		emit("Network.requestWillBeSent", {
			request: { url: "https://privacy-control.invalid/leak" },
		});
		emit("Runtime.consoleAPICalled", {
			args: [{ type: "string", value: "privacy-control" }],
		});
		emit("Runtime.exceptionThrown", { exceptionDetails: { text: "boom" } });
		expect(captured.workerRequests).toEqual([
			"https://privacy-control.invalid/leak",
		]);
		expect(captured.workerConsole).toEqual([
			'[{"type":"string","value":"privacy-control"}]',
			'{"text":"boom"}',
		]);

		// Without the upstream socket or the seeded line the control fails.
		const before = workerPositiveControl("ws", captured, ORIGIN, true);
		expect(before.ok).toBe(false);
		expect(before.missing).toEqual([
			"Network.webSocketCreated http://127.0.0.1:4500/bench/ws",
			"seeded worker console event",
		]);
		expect(() => assertPositiveControl(before)).toThrow(
			/positive control missing: Network\.webSocketCreated .*; seeded worker console event/,
		);

		emit("Network.webSocketCreated", { url: "ws://127.0.0.1:4500/bench/ws" });
		emit("Runtime.consoleAPICalled", {
			args: [{ type: "string", value: "control-1" }],
		});
		const after = workerPositiveControl("ws", captured, ORIGIN, true);
		expect(after).toMatchObject({
			ok: true,
			upstream: [
				{
					event: "Network.webSocketCreated",
					url: "ws://127.0.0.1:4500/bench/ws",
				},
			],
			console: 1,
			missing: [],
		});
		assertPositiveControl(after);
		// The seeded line is kept apart from the privacy console count.
		expect(captured.workerControlConsole).toHaveLength(1);
		expect(captured.workerConsole).toHaveLength(2);
		expect(captured.workerRequests).toContain("ws://127.0.0.1:4500/bench/ws");
	});

	it("matches the variant's own upstream event and path only", () => {
		expect(UPSTREAM).toEqual({
			ws: { event: "Network.webSocketCreated", path: "/bench/ws" },
			"graphql-ws": {
				event: "Network.webSocketCreated",
				path: "/bench/graphql-ws",
			},
		});
		const capture = (event: string, url: string) => ({
			workerNetwork: [{ event, url }],
			workerControlConsole: [],
		});
		const socket = "Network.webSocketCreated";
		expect(
			workerPositiveControl(
				"graphql-ws",
				capture(socket, "ws://127.0.0.1:4500/bench/graphql-ws"),
				ORIGIN,
				false,
			),
		).toMatchObject({ ok: true, console: null });
		// Another variant's socket, another event, another origin: no control.
		for (const [variant, event, url] of [
			["graphql-ws", socket, "ws://127.0.0.1:4500/bench/ws"],
			["ws", "Network.requestWillBeSent", "http://127.0.0.1:4500/bench/ws"],
			["ws", socket, "ws://127.0.0.1:4501/bench/ws"],
			["ws", socket, "not a url"],
		] as const) {
			expect(
				workerPositiveControl(variant, capture(event, url), ORIGIN, false).ok,
			).toBe(false);
		}
	});
});

describe("worker coverage per engine", () => {
	it("records Firefox and WebKit worker rows as not measured, never zero", () => {
		for (const engine of ["firefox", "webkit"]) {
			const out = new Recorded();
			skipWorkerRows(out, KEY, engine);
			expect(out.metrics).toEqual({});
			expect(out.notMeasured).toEqual({
				[`${KEY}.worker-markers`]: `no CDP worker capture on ${engine}`,
				[`${KEY}.worker-console`]: `no CDP worker capture on ${engine}`,
				[`${KEY}.worker-network-unexpected`]: `no CDP worker capture on ${engine}`,
			});
			// Not listed as expected there, so a failed run keeps the reason.
			markFailed(out, {}, [`${KEY}.markers`], new Error("page failure"));
			expect(out.notMeasured[`${KEY}.worker-console`]).toBe(
				noWorkerCapture(engine),
			);
			expect(`${KEY}.worker-console` in out.metrics).toBe(false);
		}
	});
});

describe("CDP probe worker observability", () => {
	const received = (count: number, urls: string[] = []) => ({
		ok: true,
		value: { received: count, urls },
	});
	const clock = "http://127.0.0.1:4500/__fixture/bench/clock";

	it("requires both console and network events on one route", () => {
		expect(
			workerEventsObserved({
				consoleEvents: { ok: true, value: { received: 1 } },
				networkEvents: received(1, [clock]),
			}),
		).toBe(true);
		for (const route of [
			{},
			{ consoleEvents: { ok: true, value: { received: 1 } } },
			{
				consoleEvents: { ok: true, value: { received: 0 } },
				networkEvents: received(1, [clock]),
			},
			{
				consoleEvents: { ok: false, error: "CDP Runtime.enable: detached" },
				networkEvents: received(1, [clock]),
			},
			{
				consoleEvents: { ok: true, value: { received: 1 } },
				networkEvents: { ok: false, error: "CDP Network.enable: unsupported" },
			},
			{
				consoleEvents: { ok: true, value: { received: 1 } },
				networkEvents: received(0),
			},
			{
				consoleEvents: { ok: true, value: { received: 1 } },
				networkEvents: received(1, ["http://127.0.0.1:4500/other"]),
			},
		]) {
			expect(workerEventsObserved(route)).toBe(false);
		}
	});
});
