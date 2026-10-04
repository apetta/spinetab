<script lang="ts">
import { bindClient } from "spinetab/svelte";
import { spinetab } from "./live";
import { queueSource, selectQueue } from "./source";

const { liveStore } = bindClient(spinetab);
const queue = liveStore(queueSource, { map: selectQueue, reconcile: "latest" });
</script>

{#if $queue.error || $queue.data?.problem}
	<p role="alert">{$queue.error?.message ?? $queue.data?.problem}</p>
{:else if $queue.data?.open === undefined}
	<p role="status">Loading queue…</p>
{:else}
	<p><output>{$queue.data.open}</output> open</p>
{/if}
