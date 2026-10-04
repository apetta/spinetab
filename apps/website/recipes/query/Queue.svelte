<script lang="ts">
import { createQuery, skipToken, useQueryClient } from "@tanstack/svelte-query";
import { onMount } from "svelte";
import { startQueue } from "./feed";
import type { QueueView } from "./queue-types";

const client = useQueryClient();
const queue = createQuery<QueueView>(() => ({
	queryKey: ["queue"],
	queryFn: skipToken,
}));
let error = $state("");
onMount(() => {
	const binding = startQueue(client, (message) => {
		error = message;
	});
	return () => binding.unsubscribe();
});
</script>

{#if error || queue.data?.problem}
	<p role="alert">{error || queue.data?.problem}</p>
{:else if queue.data?.open === undefined}
	<p role="status">Loading queue…</p>
{:else}
	<p><output>{queue.data.open}</output> open</p>
{/if}
