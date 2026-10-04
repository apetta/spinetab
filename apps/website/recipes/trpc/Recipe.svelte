<script lang="ts">
import { onMount } from "svelte";
import type { QueueView } from "./queue-types";
import { watchQueue } from "./watch";

let data = $state<QueueView>();
let error = $state("");
onMount(() =>
	watchQueue(
		(value) => {
			data = value;
			error = "";
		},
		(message) => {
			error = message;
		},
	),
);
</script>

{#if error}
	<p role="alert">{error}</p>
{:else if data?.open === undefined}
	<p role="status">Loading queue…</p>
{:else}
	<p><output>{data.open}</output> open</p>
{/if}
