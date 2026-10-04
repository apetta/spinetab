import { afterEach, describe, expect, it } from "vitest";
import { createFakeClient } from "./helpers/fake-client.ts";
import { disposeDrivers, liveDrivers } from "./helpers/live-drivers.ts";

afterEach(disposeDrivers);

for (const binding of Object.values(liveDrivers)) {
	describe(`${binding.name}: permanent connection failures`, () => {
		it("exposes a failed connection as an error without losing retry controls", async () => {
			const client = createFakeClient();
			const view = await binding.mount({ client, topic: "a" });
			await view.deliver(() =>
				client.setConnection("failed", "permanent-error"),
			);
			expect(view.read().error).toBe("upstream-error");
			expect(view.read().subscription).not.toBeNull();
			view.retry();
			expect(client.consumers[0]?.retries).toBe(1);
			await view.deliver(() => client.setConnection("connecting"));
			expect(view.read().error).toBeNull();
			await view.deliver(() => {
				client.setConnection("connected");
				client.emit({ n: 42 });
			});
			expect(view.read()).toMatchObject({ data: { n: 42 }, error: null });
		});

		it("does not treat resumable blocked states as permanent failures", async () => {
			const client = createFakeClient();
			const view = await binding.mount({ client, topic: "a" });
			for (const state of [
				"reconnecting",
				"auth-blocked",
				"retry-exhausted",
			] as const) {
				await view.deliver(() => client.setConnection(state));
				expect(view.read().error).toBeNull();
			}
		});

		it("drops the old connection failure when the source changes or is disabled", async () => {
			const client = createFakeClient({ leaky: true });
			const view = await binding.mount({
				client,
				topic: "a",
				options: { initial: 7 },
			});
			await view.deliver(() =>
				client.setConnection("failed", "permanent-error"),
			);
			expect(view.read().error).toBe("upstream-error");
			await view.update({ topic: "b" });
			expect(view.read()).toMatchObject({ data: 7, error: null });
			await view.deliver(() =>
				client.consumers[0]?.status.patch({
					connection: { state: "failed", since: 2 },
				}),
			);
			expect(view.read().error).toBeNull();
			await view.update({ topic: false });
			expect(view.read()).toMatchObject({ data: 7, error: null });
		});
	});
}
