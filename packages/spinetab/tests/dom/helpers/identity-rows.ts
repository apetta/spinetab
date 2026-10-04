import { expect } from "vitest";
import { SERVER_SUBSCRIPTION_STATUS as INACTIVE_STATUS } from "../../../src/core/status.ts";
import type { SerialisedError } from "../../../src/core/types.ts";
import { byTopic, createFakeClient, type FakeClient } from "./fake-client.ts";
import type {
	LiveBinding,
	LiveDriver,
	LiveState,
	Tick,
} from "./live-drivers.ts";

/** Shared identity cases use fake clients; real-core and React Activity cases run in the binding-specific suites. */
export type BindingName = LiveBinding["name"];
export type Row = (
	mount: LiveBinding["mount"],
	strict: boolean,
) => Promise<void>;

export const upstream: SerialisedError = {
	code: "upstream-error",
	message: "boom",
};

/** `reduce` that appends each event's `n`. */
export const append = {
	reduce: (current: number[] | undefined, tick: Tick) => [
		...(current ?? []),
		tick.n,
	],
};

/** The fake consumer behind the driver's committed handle. */
const consumerOf = (client: FakeClient, driver: LiveDriver) =>
	client.consumers.find((c) => c.status === driver.read().subscription?.status);

export const identityRows: Record<string, Row> = {
	"ID-01 returns to a previous identity without an intervening event and shows initial":
		async (mount, strict) => {
			const client = createFakeClient();
			const live = await mount({
				client,
				topic: "a",
				options: { initial: { n: 0 } },
			});
			await live.deliver(() => client.emit({ n: 7 }, byTopic("a")));
			expect(live.read().data).toEqual({ n: 7 });
			const from = live.renders.length;
			await live.update({ topic: "b" });
			await live.update({ topic: "a" });
			expect(live.read()).toMatchObject({ data: { n: 0 }, error: null });
			expect(live.renders.slice(from).map((r) => r.data)).not.toContainEqual({
				n: 7,
			});
			expect(client.active()).toHaveLength(1);
			if (!strict) expect(client.counts.subscribes).toBe(3);
		},

	"ID-02 disabled interleaving a -> false -> a and a -> null -> a start from initial":
		async (mount) => {
			for (const off of [false, null] as const) {
				const client = createFakeClient();
				const live = await mount({
					client,
					topic: "a",
					options: { initial: { n: 0 } },
				});
				await live.deliver(() => client.emit({ n: 7 }));
				await live.update({ topic: off });
				expect(live.read()).toMatchObject({
					data: { n: 0 },
					subscription: null,
				});
				expect(live.read().status).toBe(INACTIVE_STATUS);
				await live.update({ topic: "a" });
				expect(live.read()).toMatchObject({ data: { n: 0 }, error: null });
				expect(client.active()).toHaveLength(1);
				await live.dispose();
			}
		},

	"ID-03 (guard) an event on b before returning to a": async (mount) => {
		const client = createFakeClient();
		const live = await mount({ client, topic: "a" });
		await live.deliver(() => client.emit({ n: 7 }));
		await live.update({ topic: "b" });
		await live.deliver(() => client.emit({ n: 8 }, byTopic("b")));
		expect(live.read().data).toEqual({ n: 8 });
		await live.update({ topic: "a" });
		expect(live.read().data).toBeNull();
	},

	"ID-04 a terminal error does not cross identities": async (mount) => {
		const client = createFakeClient();
		const live = await mount({ client, topic: "a" });
		await live.deliver(() => client.fail(upstream));
		expect(live.read().error).toBe("upstream-error");
		await live.update({ topic: "b" });
		expect(live.read().error).toBeNull();
		await live.update({ topic: "a" });
		expect(live.read().error).toBeNull();
		await live.update({ topic: "b" });
		await live.deliver(() => client.fail(upstream, byTopic("b")));
		expect(live.read().error).toBe("upstream-error");
		await live.update({ topic: "a" });
		expect(live.read().error).toBeNull();
	},

	"ID-05 reduce after a return folds from initial, not the stale value": async (
		mount,
	) => {
		const client = createFakeClient();
		const live = await mount({ client, topic: "a", options: append as never });
		await live.deliver(() => client.emit({ n: 1 }));
		await live.deliver(() => client.emit({ n: 2 }));
		await live.update({ topic: "b" });
		await live.update({ topic: "a" });
		await live.deliver(() => client.emit({ n: 3 }, byTopic("a")));
		expect(live.read().data).toEqual([3]);
	},

	"ID-06 initial after an identity change reads the current options": async (
		mount,
	) => {
		const client = createFakeClient();
		const live = await mount({ client, topic: "a", options: { initial: 0 } });
		await live.deliver(() => client.emit({ n: 7 }));
		const from = live.renders.length;
		await live.update({ topic: "b", options: { initial: 5 } });
		expect(live.renders[from]?.data).toBe(5);
		expect(live.read().data).toBe(5);
	},

	"ID-07 continuity-lost and needsReconcile belong to the handle": async (
		mount,
	) => {
		const client = createFakeClient();
		const live = await mount({ client, topic: "a" });
		await live.deliver(() => client.setContinuity("unknown", "reconnected"));
		expect(live.read()).toMatchObject({
			error: "continuity-lost",
			needs: true,
		});
		await live.update({ topic: "b" });
		await live.update({ topic: "a" });
		expect(live.read()).toMatchObject({ error: null, needs: false });
	},

	"ID-10 client replacement with the same source": async (mount) => {
		const first = createFakeClient();
		const second = createFakeClient();
		const live = await mount({
			client: first,
			topic: "a",
			options: { initial: { n: 0 } },
		});
		await live.deliver(() => first.emit({ n: 7 }));
		await live.deliver(() => first.fail(upstream));
		const from = live.renders.length;
		await live.update({ client: second });
		expect(live.read()).toMatchObject({
			data: { n: 0 },
			error: null,
			needs: false,
		});
		const old = new Set(first.consumers.map((c) => c.status));
		for (const render of live.renders.slice(from)) {
			expect(old.has(render.subscription?.status as never)).toBe(false);
		}
		expect(first.active()).toHaveLength(0);
		expect(second.active()).toHaveLength(1);
		await live.deliver(() => {
			live.markReconciled();
			live.retry();
		});
		expect(first.consumers.map((c) => [c.reconciled, c.retries])).toEqual(
			first.consumers.map(() => [0, 0]),
		);
		expect(second.active()[0]).toMatchObject({ reconciled: 1, retries: 1 });
		await live.deliver(() => second.emit({ n: 1 }));
		expect(live.read()).toMatchObject({ data: { n: 1 }, error: null });
	},

	"ID-12 (guard) leaky delivery from a released consumer never reaches the current value":
		async (mount) => {
			const client = createFakeClient({ leaky: true });
			const live = await mount({
				client,
				topic: "a",
				options: { initial: { n: 0 } },
			});
			const released = consumerOf(client, live);
			await live.update({ topic: "b" });
			await live.update({ topic: "a" });
			await live.deliver(() => client.emit({ n: 9 }, (c) => c === released));
			expect(released?.closed).toBe(true);
			expect(live.read().data).toEqual({ n: 0 });
		},

	"ID-14 the policy kind is fixed per identity: adding reconcile applies at the next identity":
		async (mount, strict) => {
			const client = createFakeClient();
			const live = await mount({ client, topic: "a" });
			await live.update({ options: { reconcile: "latest" } });
			if (!strict) expect(client.counts.subscribes).toBe(1);
			expect(client.active()).toHaveLength(1);
			await live.deliver(() => client.setContinuity("unknown", "reconnected"));
			await live.deliver(() => client.emit({ n: 1 }));
			expect(live.read()).toMatchObject({
				data: { n: 1 },
				error: "continuity-lost",
				needs: true,
			});
			await live.update({ topic: "b" });
			await live.deliver(() => client.setContinuity("unknown", "reconnected"));
			expect(live.read()).toMatchObject({ error: null, needs: true });
			await live.deliver(() => client.emit({ n: 2 }, byTopic("b")));
			expect(live.read()).toMatchObject({
				data: { n: 2 },
				error: null,
				needs: false,
			});
		},

	"ID-14 removing reconcile on a live identity does not flash continuity-lost while its engine runs":
		async (mount) => {
			const client = createFakeClient();
			const live = await mount({
				client,
				topic: "a",
				options: { reconcile: "latest" },
			});
			await live.update({ options: {} });
			await live.deliver(() => client.setContinuity("unknown", "reconnected"));
			expect(live.read()).toMatchObject({ error: null, needs: true });
			await live.deliver(() => client.emit({ n: 1 }));
			expect(live.read()).toMatchObject({
				data: { n: 1 },
				error: null,
				needs: false,
			});
			expect(client.active()).toHaveLength(1);
		},

	"ID-14 removing or replacing a refresh function on a live identity keeps the attached refresh until the next identity":
		async (mount, strict) => {
			// (VB-POL): the engine never resolves without a refresh, which
			// it would read as success and mark the loss reconciled.
			const replacements: Array<[LiveState["options"], string | null]> = [
				[{}, "continuity-lost"],
				[{ reconcile: "latest" }, null],
			];
			for (const [replacement, nextIdentityError] of replacements) {
				const client = createFakeClient();
				const calls: string[] = [];
				let finish = () => {};
				const attached = () => {
					calls.push("attached");
					return new Promise<void>((resolve) => {
						finish = resolve;
					});
				};
				const live = await mount({
					client,
					topic: "a",
					options: { reconcile: attached },
				});
				await live.update({ options: replacement });
				if (!strict) expect(client.counts.subscribes).toBe(1);
				const [consumer] = client.active();
				await live.deliver(() => client.setConnection("connected"));
				await live.settle(() => client.setContinuity("gap", "overflow"));
				expect(calls).toEqual(["attached"]);
				expect(consumer?.reconciled).toBe(0);
				expect(live.read()).toMatchObject({ error: null, needs: true });
				await live.settle(() => finish());
				expect(consumer?.reconciled).toBe(1);
				expect(live.read()).toMatchObject({ error: null, needs: false });
				expect(live.read().status.continuity.reason).toBe("reconciled");
				// The next identity takes the current options.
				await live.update({ topic: "b" });
				await live.settle(() => client.setContinuity("gap", "overflow"));
				expect(calls).toEqual(["attached"]);
				expect(live.read()).toMatchObject({
					error: nextIdentityError,
					needs: true,
				});
				await live.dispose();
			}
		},

	"ID-14 (guard) a new refresh function on a live identity runs the newest closure":
		async (mount) => {
			const client = createFakeClient();
			const calls: string[] = [];
			const refresh = (name: string) => async () => {
				calls.push(name);
			};
			const live = await mount({
				client,
				topic: "a",
				options: { reconcile: refresh("attached") },
			});
			await live.update({ options: { reconcile: refresh("newest") } });
			await live.deliver(() => client.setConnection("connected"));
			await live.settle(() => client.setContinuity("gap", "overflow"));
			expect(calls).toEqual(["newest"]);
			expect(live.read()).toMatchObject({ error: null, needs: false });
		},

	"ID-15 a value hook reports stopped delivery through error only (no loud report)":
		async (mount) => {
			const client = createFakeClient({ reportUnhandledErrors: true });
			const live = await mount({ client, topic: "a" });
			await live.deliver(() => client.setContinuity("gap", "overflow"));
			expect(live.read()).toMatchObject({
				error: "continuity-lost",
				needs: true,
			});
			expect(client.reports).toEqual([]);
		},

	"ID-16 a principal change restarts the value at initial, once per change":
		async (mount) => {
			const client = createFakeClient();
			const live = await mount({
				client,
				topic: "a",
				options: { initial: { n: 0 } },
			});
			await live.deliver(() => client.emit({ n: 7 }));
			await live.deliver(() => client.fail(upstream));
			await live.deliver(() =>
				client.setContinuity("unknown", "scope-changed"),
			);
			expect(live.read()).toMatchObject({
				data: { n: 0 },
				error: "continuity-lost",
				needs: true,
			});
			await live.deliver(() => client.emit({ n: 8 }));
			// A later status with the same continuity is not a new principal change.
			await live.deliver(() => client.setConnection("connected"));
			expect(live.read().data).toEqual({ n: 8 });
			await live.deliver(() => client.setContinuity("unknown", "reconnected"));
			expect(live.read().data).toEqual({ n: 8 });
		},

	"ID-16 no render pairs the previous principal's value with the scope-changed status":
		async (mount) => {
			const client = createFakeClient();
			const live = await mount({
				client,
				topic: "a",
				options: { initial: { n: 0 } },
			});
			await live.deliver(() => client.emit({ n: 7 }));
			const from = live.renders.length;
			await live.deliver(() =>
				client.setContinuity("unknown", "scope-changed"),
			);
			const after = live.renders.slice(from);
			expect(after.length).toBeGreaterThan(0);
			// Core sets the status store before it calls the status hook, and
			// Solid and Svelte publish synchronously: the reset must come first.
			expect(
				after.filter(
					(render) =>
						render.status.continuity.reason === "scope-changed" &&
						render.data !== null &&
						(render.data as { n: number }).n === 7,
				),
			).toEqual([]);
			expect(live.read()).toMatchObject({ data: { n: 0 }, needs: true });
		},

	"ID-17 resume reaches core only when the application gave one; the newest closure runs":
		async (mount) => {
			const bare = createFakeClient();
			await mount({ client: bare, topic: "a" });
			expect(bare.active()[0]?.options?.resume).toBeUndefined();
			const given = createFakeClient();
			const calls: string[] = [];
			const live = await mount({
				client: given,
				topic: "a",
				options: {
					resume: () => {
						calls.push("first");
						return undefined;
					},
				},
			});
			await live.update({
				options: {
					resume: () => {
						calls.push("newest");
						return undefined;
					},
				},
			});
			given.active()[0]?.options?.resume?.({});
			expect(calls).toEqual(["newest"]);
		},
};

const ALL: readonly BindingName[] = ["react", "vue", "solid", "svelte"];
const OPTIONS: readonly BindingName[] = ["react", "vue", "solid"];
/** A3's binding column per row id. */
const APPLIES: Record<string, readonly BindingName[]> = {
	"ID-01": ALL,
	"ID-02": ALL,
	"ID-03": ALL,
	"ID-04": ALL,
	"ID-05": ALL,
	"ID-06": OPTIONS,
	"ID-07": ALL,
	"ID-10": ["react"],
	"ID-12": ALL,
	"ID-14": OPTIONS,
	"ID-15": ALL,
	"ID-16": ALL,
	"ID-17": ["react"],
};

export function rowsFor(binding: BindingName): Array<[string, Row]> {
	return Object.entries(identityRows).filter(([name]) =>
		APPLIES[name.slice(0, 5)]?.includes(binding),
	);
}
