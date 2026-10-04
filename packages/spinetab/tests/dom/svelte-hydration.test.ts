import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { flushSync, hydrate, unmount } from "svelte";
import { compile } from "svelte/compiler";
import { get } from "svelte/store";
import { afterAll, expect, it } from "vitest";
import {
	INACTIVE_STATUS,
	liveStore,
	SERVER_STATUS,
	statusStore,
	subscriptionStore,
} from "../../src/bindings/svelte/index.ts";
import { createFakeClient, feed } from "./helpers/fake-client.ts";

const generated = join(
	dirname(fileURLToPath(import.meta.url)),
	".generated-hydration",
);
afterAll(() => rmSync(generated, { recursive: true, force: true }));

it("A3 hydration reads the server snapshots and keeps the server's conditional DOM", async () => {
	const source = `<script>
	let { live, subscription, status } = $props();
	const initial = [$live.status.connection.state, $subscription.connection.state, $status.mode, $status.reason];
</script>
<output>{initial.join('/')}</output>
{#if $live.status.connection.state === 'inactive'}<p>server branch</p>{:else}<p>live branch</p>{/if}`;
	mkdirSync(generated, { recursive: true });
	const serverFile = join(generated, "server.js");
	const clientFile = join(generated, "client.js");
	writeFileSync(
		serverFile,
		compile(source, { generate: "server", filename: "Probe.svelte" }).js.code,
	);
	writeFileSync(
		clientFile,
		compile(source, { generate: "client", filename: "Probe.svelte" }).js.code,
	);
	const binding = pathToFileURL(
		join(generated, "../../../src/bindings/svelte/index.ts"),
	).href;
	const fake = pathToFileURL(join(generated, "../helpers/fake-client.ts")).href;
	const html = execFileSync(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`
import { render } from 'svelte/server';
import Probe from ${JSON.stringify(pathToFileURL(serverFile).href)};
import { liveStore, subscriptionStore, statusStore } from ${JSON.stringify(binding)};
import { createFakeClient, feed } from ${JSON.stringify(fake)};
const client = createFakeClient();
const props = { live: liveStore(client, feed('a')), subscription: subscriptionStore(client, feed('b'), () => {}), status: statusStore(client) };
process.stdout.write(render(Probe, { props }).body);
if (client.counts.subscribes !== 0) throw new Error('SSR started work');
`,
		],
		{ cwd: join(generated, "../../.."), encoding: "utf8" },
	);
	const { default: Probe } = await import(/* @vite-ignore */ clientFile);
	const client = createFakeClient();
	const props = {
		live: liveStore(client, feed("a")),
		subscription: subscriptionStore(client, feed("b"), () => {}),
		status: statusStore(client),
	};
	const target = document.createElement("div");
	target.innerHTML = html;
	const branch = target.querySelector("p");
	const view = hydrate(Probe, { target, props });
	expect(target.querySelector("output")?.textContent).toBe(
		"inactive/inactive/inactive/server",
	);
	expect(target.querySelector("p")).toBe(branch);
	expect(client.counts.subscribes).toBe(0);
	await Promise.resolve();
	flushSync();
	expect(client.counts.subscribes).toBe(2);
	expect(target.querySelector("p")?.textContent).toBe("live branch");
	unmount(view);
	flushSync();
	expect(client.active()).toHaveLength(0);
});

it("A3 a transient read or immediate unsubscribe starts no upstream work", async () => {
	const client = createFakeClient();
	const store = subscriptionStore(client, feed("a"), () => {});
	expect(get(store)).toBe(INACTIVE_STATUS);
	expect(get(statusStore(client))).toBe(SERVER_STATUS);
	store.subscribe(() => {})();
	await Promise.resolve();
	expect(client.counts.subscribes).toBe(0);
	expect(store.subscription).toBeNull();
	const stop = store.subscribe(() => {});
	await Promise.resolve();
	expect(client.active()).toHaveLength(1);
	stop();
	expect(client.counts.unsubscribes).toBe(1);
});

it("A3 cancelling and resubscribing in one turn invalidates the earlier start", async () => {
	const client = createFakeClient();
	const store = liveStore(client, feed("a"));
	store.subscribe(() => {})();
	const stop = store.subscribe(() => {});
	await Promise.resolve();
	expect(client.counts.subscribes).toBe(1);
	stop();
	expect(client.active()).toHaveLength(0);
});
