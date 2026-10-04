import { createElement } from "react";
import { renderToString as renderReact } from "react-dom/server";
import { createRoot as createSolidRoot } from "solid-js";
import { isServer } from "solid-js/web";
import { get } from "svelte/store";
import { describe, expect, it, vi } from "vitest";
import { createSSRApp, h } from "vue";
import { renderToString as renderVue } from "vue/server-renderer";
import * as react from "../../../src/bindings/react/index.ts";
import * as solid from "../../../src/bindings/solid/index.ts";
import * as svelte from "../../../src/bindings/svelte/index.ts";
import * as vue from "../../../src/bindings/vue/index.ts";
import { createFakeClient, request } from "../../dom/helpers/fake-client.ts";

// UNIT-SSR-01…04: server rendering in Node (no window) is inert
// and yields the constant inactive/server status in every binding.

const EXPECTED_SERVER = {
	mode: "inactive",
	reason: "server",
	health: "unknown",
	generation: 0,
};

describe("server rendering", () => {
	it("has no browser globals in this project", () => {
		expect(typeof window).toBe("undefined");
	});

	it("UNIT-SSR-01 React renderToString: server snapshots, no subscription", () => {
		const client = createFakeClient();
		const subscribe = vi.spyOn(client, "subscribe");
		function View() {
			const { status } = react.useSubscription(client, request("a"), {
				next: () => {},
			});
			const clientStatus = react.useSpinetabStatus(client);
			return createElement(
				"p",
				null,
				`${status.connection.state}|${clientStatus.mode}|${clientStatus.reason}`,
			);
		}
		expect(renderReact(createElement(View))).toBe(
			"<p>inactive|inactive|server</p>",
		);
		expect(subscribe).not.toHaveBeenCalled();
		expect(react.SERVER_STATUS).toEqual(EXPECTED_SERVER);
	});

	it("UNIT-SSR-02 Vue renderToString: inactive status, no subscription", async () => {
		const client = createFakeClient();
		const subscribe = vi.spyOn(client, "subscribe");
		const app = createSSRApp({
			setup() {
				// biome-ignore lint/correctness/useHookAtTopLevel: Vue composable in setup(), not a React hook.
				const { status } = vue.useSubscription(client, () => request("a"), {
					next: () => {},
				});
				// biome-ignore lint/correctness/useHookAtTopLevel: Vue composable in setup(), not a React hook.
				const { status: clientStatus } = vue.useSpinetabStatus(client);
				return () =>
					h(
						"p",
						`${status.value.connection.state}|${clientStatus.value.reason}`,
					);
			},
		});
		expect(await renderVue(app)).toBe("<p>inactive|server</p>");
		expect(subscribe).not.toHaveBeenCalled();
		expect(vue.SERVER_STATUS).toEqual(EXPECTED_SERVER);
	});

	it("UNIT-SSR-03 Svelte stores without a window: inactive, server status, no subscription", () => {
		const client = createFakeClient();
		const subscribe = vi.spyOn(client, "subscribe");
		const store = svelte.subscriptionStore(client, request("a"), {
			next: () => {},
		});
		expect(get(store)).toBe(svelte.INACTIVE_STATUS);
		expect(get(svelte.statusStore(client))).toBe(svelte.SERVER_STATUS);
		expect(subscribe).not.toHaveBeenCalled();
	});

	it("UNIT-SSR-04 Solid server build: effects are inert, status stays inactive/server", () => {
		expect(isServer).toBe(true);
		const client = createFakeClient();
		const subscribe = vi.spyOn(client, "subscribe");
		createSolidRoot((dispose) => {
			const resource = solid.createSubscription(client, () => request("a"), {
				next: () => {},
			});
			const status = solid.createSpinetabStatus(client);
			expect(resource.status()).toBe(solid.INACTIVE_STATUS);
			expect(status.status()).toBe(solid.SERVER_STATUS);
			dispose();
		});
		expect(subscribe).not.toHaveBeenCalled();
	});

	it("value hooks and bindClient render initial, inactive and no subscription on the server", async () => {
		const client = createFakeClient();
		const subscribe = vi.spyOn(client, "subscribe");
		const reactBound = react.bindClient(client);
		function View() {
			const live = reactBound.useLive(request("a"), { initial: { n: 0 } });
			return createElement(
				"p",
				null,
				`${live.data?.n}|${live.status.connection.state}|${live.needsReconcile}`,
			);
		}
		expect(renderReact(createElement(View))).toBe("<p>0|inactive|false</p>");
		const vueBound = vue.bindClient(client);
		const app = createSSRApp({
			setup() {
				// biome-ignore lint/correctness/useHookAtTopLevel: Vue composable in setup(), not a React hook.
				const live = vueBound.useLive(() => request("a"), {
					initial: { n: 0 },
				});
				return () =>
					h("p", `${live.data.value?.n}|${live.status.value.connection.state}`);
			},
		});
		expect(await renderVue(app)).toBe("<p>0|inactive</p>");
		const store = svelte.bindClient(client).liveStore(request("a"), {
			initial: { n: 0 },
		});
		expect(get(store).data).toEqual({ n: 0 });
		expect(get(store).status).toBe(svelte.INACTIVE_STATUS);
		createSolidRoot((dispose) => {
			const live = solid.bindClient(client).createLive(request("a"), {
				initial: { n: 0 },
			});
			expect(live.data()).toEqual({ n: 0 });
			expect(live.status()).toBe(solid.INACTIVE_STATUS);
			dispose();
		});
		expect(subscribe).not.toHaveBeenCalled();
	});
});
