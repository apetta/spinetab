import { createTRPCClient } from "@trpc/client";
import { describe, expect, it } from "vitest";
import { isSpinetabError } from "../../../src/core/errors.ts";
import type { Continuity } from "../../../src/core/types.ts";
import {
	type SpinetabControls,
	spinetabSseLink,
	spinetabWsLink,
} from "../../../src/integrations/trpc/index.ts";
import type { FixtureTrpcRouter } from "../../fixtures/servers/trpc.ts";
import { createFakeClient } from "./fakes.ts";

// Use the real tRPC client with a fake Spinetab page client to isolate link behaviour.

const continuity = (
	state: Continuity["state"],
	since: number,
	reason?: Continuity["reason"],
): Continuity => ({ state, since, ...(reason ? { reason } : {}) });

function setup(options: Partial<Parameters<typeof spinetabWsLink>[0]> = {}) {
	const { client, calls } = createFakeClient();
	const seen = {
		status: [] as Array<{ state: string; controls: SpinetabControls }>,
		continuity: [] as Array<{
			state: string;
			reason?: string;
			controls: SpinetabControls;
		}>,
	};
	const trpc = createTRPCClient<FixtureTrpcRouter>({
		links: [
			spinetabWsLink<FixtureTrpcRouter>({
				client,
				url: "/trpc-ws",
				onStatus: (status, controls) =>
					seen.status.push({ state: status.connection.state, controls }),
				onContinuity: (value, controls) =>
					seen.continuity.push({
						state: value.state,
						...(value.reason ? { reason: value.reason } : {}),
						controls,
					}),
				...options,
			}),
		],
	});
	return { trpc, calls, seen };
}

describe("tRPC: replay: true declares every procedure", () => {
	it("marks any path as replaying; an array still names paths", () => {
		const all = setup({ replay: true });
		all.trpc.ticks.subscribe({ tag: "a" }, {});
		expect(all.calls[0]?.request.subscription).toMatchObject({
			path: "ticks",
			replay: true,
		});
		const some = setup({ replay: ["other"] });
		some.trpc.ticks.subscribe({ tag: "a" }, {});
		expect(some.calls[0]?.request.subscription).not.toHaveProperty("replay");
	});

	it("refuses anything but true or an array of paths", () => {
		const { client } = createFakeClient();
		for (const replay of [false, "ticks", [1]]) {
			let caught: unknown;
			try {
				spinetabWsLink({ client, url: "/t", replay: replay as never });
			} catch (error) {
				caught = error;
			}
			expect(isSpinetabError(caught) && caught.code, String(replay)).toBe(
				"unsupported-option",
			);
		}
	});
});

describe("tRPC: onStatus and onContinuity with controls", () => {
	it("controls act on this subscription's handle", () => {
		const { trpc, calls, seen } = setup();
		trpc.ticks.subscribe({ tag: "a" }, {});
		const call = calls[0];
		call?.status("reconnecting");
		expect(seen.status.map((item) => item.state)).toEqual(["reconnecting"]);
		const controls = seen.status[0]?.controls as SpinetabControls;
		controls.retry();
		controls.markReconciled({ pending: true });
		expect(call?.retries).toBe(1);
		expect(call?.reconciled).toEqual([{ pending: true }]);
	});

	it("onContinuity reports each notice away from continuous once, including unknown", () => {
		const { trpc, calls, seen } = setup();
		trpc.ticks.subscribe({ tag: "a" }, {});
		const call = calls[0];
		call?.status("connected");
		call?.status("reconnecting", {
			continuity: continuity("unknown", 10, "reconnected"),
		});
		call?.status("connecting", {
			continuity: continuity("unknown", 10, "reconnected"),
		});
		call?.status("connected", {
			continuity: continuity("resumed", 20, "resumed-with-cursor"),
		});
		expect(seen.continuity.map(({ state, reason }) => [state, reason])).toEqual(
			[
				["unknown", "reconnected"],
				["resumed", "resumed-with-cursor"],
			],
		);
		seen.continuity[0]?.controls.markReconciled();
		expect(call?.reconciled).toEqual([undefined]);
	});

	it("controls are inert once the observable ended", () => {
		const { trpc, calls, seen } = setup();
		const subscription = trpc.ticks.subscribe({ tag: "a" }, {});
		const call = calls[0];
		call?.status("reconnecting");
		const controls = seen.status[0]?.controls as SpinetabControls;
		subscription.unsubscribe();
		controls.retry();
		controls.markReconciled();
		expect(call?.retries).toBe(0);
		expect(call?.reconciled).toEqual([]);

		const errored = setup();
		errored.trpc.ticks.subscribe({ tag: "a" }, { onError() {} });
		const handle = errored.calls[0];
		handle?.status("connected", {
			continuity: continuity("gap", 5, "overflow"),
		});
		expect(errored.seen.continuity.map((item) => item.reason)).toEqual([
			"overflow",
		]);
		const ended = errored.seen.continuity[0]?.controls as SpinetabControls;
		ended.retry();
		ended.markReconciled();
		expect(handle?.retries).toBe(0);
		expect(handle?.reconciled).toEqual([]);
	});
});

describe("spinetabSseLink has no allowConnectionParamsCredentials", () => {
	it("refuses the removed option as unknown, whatever its value", () => {
		const { client } = createFakeClient();
		for (const value of [false, true]) {
			let caught: unknown;
			try {
				spinetabSseLink({
					client,
					url: "/trpc",
					allowConnectionParamsCredentials: value,
				} as never);
			} catch (error) {
				caught = error;
			}
			expect(isSpinetabError(caught) && caught.code).toBe("unsupported-option");
			expect((caught as Error).message).toMatch(
				/^options\.allowConnectionParamsCredentials: unsupported option\./,
			);
		}
	});
});
