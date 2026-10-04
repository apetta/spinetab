<script setup lang="ts">
import { bindClient } from "spinetab/vue";
import { spinetab } from "./live";
import { queueSource, selectQueue } from "./source";

const { useLive } = bindClient(spinetab);
const { data, error } = useLive(queueSource, {
	map: selectQueue,
	reconcile: "latest",
});
</script>

<template>
	<p v-if="error || data?.problem" role="alert">
		{{ error?.message ?? data?.problem }}
	</p>
	<p v-else-if="data?.open === undefined" role="status">Loading queue…</p>
	<p v-else><output>{{ data.open }}</output> open</p>
</template>
